package jethub

import (
	"strings"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/config"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// modelDisplayParts：倍率解析的三种来源形态（alias 内嵌 / note 段 / 无倍率）。
// 形态逐条对照 internal/jethub 的产品表（raccoon / loomy / qoder / codearts）。
func TestModelDisplayParts(t *testing.T) {
	cases := []struct {
		name string
		md   config.ModelDef
		want string
		rate string
	}{
		{"alias 内嵌倍率 (raccoon)", config.ModelDef{ID: "sn-glm-5-3", Alias: "GLM-5-3 · x0.75"}, "GLM-5-3", "x0.75"},
		{"alias 内嵌免费 (raccoon)", config.ModelDef{ID: "sn-1", Alias: "SenseNova-6.8-Flash · 免费", Note: "ctx 256000"}, "SenseNova-6.8-Flash", "免费"},
		{"alias 促销价 (raccoon)", config.ModelDef{ID: "sn-2", Alias: "GLM-5-3-Flash · x0.2→x0.1"}, "GLM-5-3-Flash", "x0.2→x0.1"},
		{"note 段倍率 (qoder)", config.ModelDef{ID: "ultimate", Alias: "Ultimate", Note: "ctx 1000000; x2; efforts xhigh"}, "Ultimate", "x2"},
		{"note 免费 (qoder)", config.ModelDef{ID: "qfmodel", Alias: "Qwen3.8-Flash", Note: "ctx 1000000; FREE (x0); efforts"}, "Qwen3.8-Flash", "免费"},
		{"1 倍也要显示 (qoder)", config.ModelDef{ID: "sn-kimi-k3", Alias: "Kimi-K3", Note: "ctx 1000000; x1"}, "Kimi-K3", "x1"},
		{"无倍率不编造 (codearts)", config.ModelDef{ID: "GLM-5.2", Note: "ctx 202752"}, "GLM-5.2", ""},
		{"无 alias 退化成 id", config.ModelDef{ID: "glm-5.2", Note: "ctx 200000"}, "glm-5.2", ""},
		{"note 的非倍率段不误判", config.ModelDef{ID: "m1", Alias: "M1", Note: "ctx 1048576; max 63999; free"}, "M1", ""},
		// ⚠️ 裸 FREE 段**不是**免费：ref 的 isFree 只表示「有免费额度」，展示成
		// 「免费」只取决于 priceFactor === 0。此前无条件判免费，把 Qwen3.8-Max
		// （实为 x0.5→x0.2）显示成「免费」（用户实测报障）。
		{"裸 FREE 不等价于免费", config.ModelDef{ID: "qmodel_38max", Alias: "Qwen3.8-Max", Note: "FREE; efforts xhigh"}, "Qwen3.8-Max", ""},
		{"FREE 但倍率非 0 不是免费", config.ModelDef{ID: "m2", Alias: "M2", Note: "FREE (x0.5); ctx"}, "M2", "x0.5"},
		{"FREE (x0.0) 仍是免费", config.ModelDef{ID: "m3", Alias: "M3", Note: "FREE (x0.0); ctx"}, "M3", "免费"},
	}
	for _, tc := range cases {
		gotName, gotRate := modelDisplayParts(tc.md)
		if gotName != tc.want || gotRate != tc.rate {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", tc.name, gotName, gotRate, tc.want, tc.rate)
		}
	}
}

// TestModelDisplayPartsPromotionWindow: 促销段按 UTC+8 墙上时间决定展示
// 「原价→折后价」还是只展示原价（ref promotionActiveNow 的同款判据，含跨零点）。
func TestModelDisplayPartsPromotionWindow(t *testing.T) {
	md := config.ModelDef{ID: "qmodel_38max", Alias: "Qwen3.8-Max", Note: "ctx 1000000; x0.5; promo 22:00-08:00 x0.2; efforts"}
	cases := []struct {
		name string
		utc8 string // 期望的 UTC+8 墙上时间
		want string
	}{
		{"窗口内 23:00", "2026-10-01T23:00:00+08:00", "x0.5→x0.2"},
		{"窗口内 07:59", "2026-10-01T07:59:00+08:00", "x0.5→x0.2"},
		{"窗口起点 22:00", "2026-10-01T22:00:00+08:00", "x0.5→x0.2"},
		{"窗口终点 08:00（不含）", "2026-10-01T08:00:00+08:00", "x0.5"},
		{"窗口外 12:00", "2026-10-01T12:00:00+08:00", "x0.5"},
		{"窗口外 21:59", "2026-10-01T21:59:00+08:00", "x0.5"},
	}
	for _, tc := range cases {
		at, err := time.Parse(time.RFC3339, tc.utc8)
		if err != nil {
			t.Fatal(err)
		}
		// ⚠️ 判据必须与机器时区无关：同一个瞬时换个时区表达，结果必须相同。
		for _, loc := range []*time.Location{time.UTC, time.FixedZone("UTC-5", -5*3600)} {
			_, rate := modelDisplayPartsAt(md, at.In(loc))
			if rate != tc.want {
				t.Errorf("%s (as %s): rate = %q, want %q", tc.name, loc, rate, tc.want)
			}
		}
	}
}

// TestQoderModelRatesMatchPlugin: qoder/qodercn 的倍率必须与插件逐条一致
// （用户实测「倍率显示和插件中的显示不一致」：qmodel_38max 被显示成「免费」、
// qmodel_latest/qmodel 拿「采集时刻折后价」当唯一价）。
// 期望值来自 ref qoder-product.ts 的 priceFactor / promotion 字段，
// 展示规则来自 ref qoder-adapter.ts 的 qoderDisplayName。
func TestQoderModelRatesMatchPlugin(t *testing.T) {
	m, err := corejethub.NewManager(t.TempDir(), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	b := corejethub.NewBridge(m, nil) // 只需产品表，不需要 registry
	corejethub.RegisterDefaultProducts(b)

	inWindow := time.Date(2026, 10, 1, 23, 30, 0, 0, time.FixedZone("UTC+8", 8*3600))
	outWindow := time.Date(2026, 10, 1, 12, 0, 0, 0, time.FixedZone("UTC+8", 8*3600))

	cases := []struct {
		provider string
		inRate   map[string]string // id → 窗口内期望倍率
		outRate  map[string]string // id → 窗口外期望倍率
	}{
		{
			provider: "qoder",
			inRate: map[string]string{
				"qmodel_38max":  "x0.5→x0.2",
				"qmodel_latest": "x0.5→x0.1",
				"qmodel":        "x0.1→x0.04",
				"qfmodel":       "免费",
				"auto":          "x0.5",
				"smodel":        "x8",
				"dfmodel":       "x0.1",
			},
			outRate: map[string]string{
				"qmodel_38max":  "x0.5",
				"qmodel_latest": "x0.5",
				"qmodel":        "x0.1",
				"qfmodel":       "免费",
			},
		},
		{
			provider: "qodercn",
			inRate: map[string]string{
				"qmodel_38max":  "x0.5→x0.2",
				"qmodel_latest": "x0.5→x0.1",
				"qmodel":        "x0.1→x0.04",
				"q37fmodel":     "x0.1",
				"gm51model":     "x0.6",
			},
			outRate: map[string]string{
				"qmodel_38max":  "x0.5",
				"qmodel_latest": "x0.5",
				"qmodel":        "x0.1",
			},
		},
	}
	for _, tc := range cases {
		prod, ok := b.Product(tc.provider)
		if !ok {
			t.Fatalf("%s: product not registered", tc.provider)
		}
		byID := map[string]config.ModelDef{}
		for _, md := range prod.Models {
			byID[md.ID] = md
		}
		for id, want := range tc.inRate {
			md, ok := byID[id]
			if !ok {
				t.Errorf("%s: model %s missing", tc.provider, id)
				continue
			}
			if _, rate := modelDisplayPartsAt(md, inWindow); rate != want {
				t.Errorf("%s/%s in-window rate = %q, want %q", tc.provider, id, rate, want)
			}
		}
		for id, want := range tc.outRate {
			md, ok := byID[id]
			if !ok {
				t.Errorf("%s: model %s missing", tc.provider, id)
				continue
			}
			if _, rate := modelDisplayPartsAt(md, outWindow); rate != want {
				t.Errorf("%s/%s out-of-window rate = %q, want %q", tc.provider, id, rate, want)
			}
		}
	}
}

// TestTraeModelsCarryDisplayNames: trae 的静态表此前丢弃了 ref 的 display name，
// 面板只显示裸 id（用户实测「trae 模型列表和插件显示不一致」）。
func TestTraeModelsCarryDisplayNames(t *testing.T) {
	m, _ := corejethub.NewManager(t.TempDir(), "", nil)
	b := corejethub.NewBridge(m, nil)
	corejethub.RegisterDefaultProducts(b)
	prod, ok := b.Product("trae")
	if !ok {
		t.Fatal("trae product not registered")
	}
	for _, md := range prod.Models {
		if md.Alias == "" {
			t.Errorf("trae model %s has no display name (would render as a bare id)", md.ID)
		}
		name, _ := modelDisplayParts(md)
		if name == md.ID && strings.ContainsAny(md.ID, "_-") {
			t.Errorf("trae model %s renders as its raw id", md.ID)
		}
	}
}

// TestModelDisplayNamesMatchReference 是「模型列表显示与插件一致」的总回归。
//
// 插件面板渲染的是**一条最终展示名 + 裸 id**（ref plugin-src/client/jet-hub.js
// 的 ModelToggle：`<strong>{model.name}</strong><code>{model.id}</code>`），而
// `model.name` 由各适配器的 `listAllModels()`/`displayNameFor*` 产出、**倍率已拼在
// 名字里**（`模型名称 · 倍率`）。本端对应物 = `listModels` 的 `{name, rate}` 两个
// 字段（面板按 `名称 · 倍率` 再 `id` 渲染）。
//
// 用户实测报障「个别 provider 的模型显示和插件中不一致」暴露的正是这条链路上的
// 三类偏差：① 静态表**没有展示名**（buddy/workbuddy 只把名字塞进 Note）② 该拼的
// **免费后缀没拼**（cline）③ 该被过滤的**隐藏模型没过滤**（trae 多出 4 条）。
//
// 本测试同时锁住四条不变量（它们才是这类偏差的通用判据）：
//  1. 每个 provider 的每条模型都有非空展示名（绝不退化渲染成裸 id，除非 ref 的
//     兜底 name 本身就是 id —— codearts/lobsterai，以及 models.dev 里
//     `name === id` 的 cline-pass/glm-5.3-flash）；
//  2. **同一 provider 内展示名互不相同** —— 这是 ref `variantLabelFor` 存在的
//     唯一理由（同名撞车会让用户无法区分条目）；撞车时变体标记的算法是「取撞车组
//     id 的公共前缀、剩余部分转大写」；
//  3. **兜底路径不编造倍率**：buddy/workbuddy/trae/lobsterai/codearts/minimax 的
//     静态表在 ref 里都没有倍率可抄（倍率只随远端目录下发），故 rate 必须为空；
//  4. raccoon/loomy/qoder/qodercn 的静态表**自带**倍率 ⇒ rate 必须非空
//     （含 `x1`：1 倍也要显示，用户曾报障）。
func TestModelDisplayNamesMatchReference(t *testing.T) {
	m, err := corejethub.NewManager(t.TempDir(), "", nil)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	b := corejethub.NewBridge(m, nil)
	corejethub.RegisterDefaultProducts(b)

	// 代表条目：`模型 id` → `展示名` 或 `名称 · 倍率`（注释给出 ref 出处）。
	want := map[string]map[string]string{
		"buddy": {
			"deepseek-v4.1-flash": "Deepseek-V4.1-Flash", // product.ts:198 name
			"glm-5.3-flash":       "GLM-5.3-Flash",       // product.ts:223
			"hy3":                 "Hy3",                 // product.ts:186
			// 同名撞车 → variantLabelFor；⚠️ 变体前的 ` · ` 不可省
			// （displayNameFor = `${name} · ${[倍率, 变体].join(' ')}`）。
			"hy3-x":      "Hy3 · X",
			"minimax-m3": "MiniMax-M3",
		},
		"workbuddy": {
			"hy4-preview":            "Hy4 preview",              // product.ts:311
			"hy4-preview-f":          "Hy4 preview · F",          // 公共前缀消歧
			"deepseek-v4.1-flash":    "Deepseek-V4.1-Flash",      // product.ts:318
			"deepseek-v4.1-flash-sg": "Deepseek-V4.1-Flash · SG", // product.ts:321
			"gpt-6-astra":            "GPT-6-Astra",
		},
		"cline": {
			// cline-models.ts:107-109 `isFree ? name + ' · 免费' : name`；免费条目。
			"stealth/space-bunny-alpha": "Space Bunny Alpha · 免费",
			// （2026-10-03 起免费清单只剩 4 条：cline-free/gemini-3.8-flash 已被上游
			// 下线，ref 51d6093——见 trae_model.go 的表注释。）
			"cline-free/mimo-v2.6-flash": "MiMo-V2.6-Flash · 免费",
			// （2026-10-05 起只剩 3 条：cline-free/deepseek-v4.1-flash 也被下架，
			// ref b0352fc——同上表注释。付费侧的 cline-pass/deepseek-v4.1-flash
			// 仍在，别把两者混为一谈。）
			"cline-free/muse-spark-1.3-contributor": "Muse Spark 1.3 Contributor · 免费",
			// cline-pass/*（订阅制，**不是**免费 ⇒ 不带后缀）：ref caf675e 用
			// models.dev 的 `cline-pass` 块补的可读名（网关只下发裸 id）。
			// 前四条是网关 `recommended-models.clinePass` **完全没下发**的
			// （用户报障「cline-pass 部分模型列表不全」的根因）。
			"cline-pass/kimi-k2.6":         "Kimi K2.6",         // ← 网关缺
			"cline-pass/glm-5.2":           "GLM-5.2",           // ← 网关缺
			"cline-pass/kimi-k2.7-code":    "Kimi K2.7 Code",    // ← 网关缺
			"cline-pass/deepseek-v4-flash": "DeepSeek V4 Flash", // ← 网关缺
			// 网关把 id 当名字下发的条目 ⇒ 用 models.dev 的可读名替换。
			"cline-pass/deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
			// 免费与订阅是**两个不同条目**：同名不同 id，免费那条带 ` · 免费`。
			"cline-pass/mimo-v2.6-flash": "MiMo-V2.6-Flash",
			// ⚠️ models.dev 给这条的 `name` 就是裸 id（无可读名可抄）⇒ 上游
			// 合并后同样显示裸 id，此处不编造。
			"cline-pass/glm-5.3-flash": "cline-pass/glm-5.3-flash",
		},
		"trae": {
			"DeepSeek-V4-Flash-Official": "DeepSeek V4 Flash Official", // trae-product.ts:170
			"qwen-3.7-plus":              "Qwen 3.7 Plus",
			"custom_model_no-fc":         "Custom No-FC",
		},
		// 兜底路径的 name **就是 id**（ref 逐条如此），不编造人类可读名。
		"lobsterai": {"kimi-k3": "kimi-k3", "doubao-seed-2-1-pro-260628": "doubao-seed-2-1-pro-260628"},
		"codearts":  {"glm-5.3-flash": "glm-5.3-flash", "deepseek-v4.1-flash": "deepseek-v4.1-flash"},
		"minimax":   {"MiniMax-M3.1-Flash-Preview": "M3.1-Flash-Preview", "MiniMax-M2.7": "M2.7"},
		"raccoon": {
			"sn-glm-5-3":             "GLM-5-3 · x0.75",
			"sn-sensenova-6-8-flash": "SenseNova-6.8-Flash · 免费",
			"sn-kimi-k3":             "Kimi-K3 · x1", // 1 倍也必须显示
		},
		"loomy": {
			"spark-x":                "Spark X2.5 · x0.1",
			"deepseek-v4-flash-0731": "DeepSeek V4 Flash 0731 · x3.0",
		},
		// qoder/qodercn 的静态表自带倍率，但其中三条带促销窗口
		// （qmodel_38max / qmodel_latest / qmodel）的形态随**当前时刻**在
		// `x原价` 与 `x原价→x折后` 之间切换 —— 精确值由
		// TestModelDisplayPartsPromotionWindow 用固定时钟锁；这里只核对不随
		// 窗口变化的条目（`hasRate` 那条不变量另行保证促销项也有倍率）。
		"qoder":   {"qfmodel": "Qwen3.8-Flash · 免费", "mmodel": "MiniMax-M3 · x0.2", "ultimate": "Ultimate · x2"},
		"qodercn": {"mmodel": "MiniMax-M2.7 · x0.2", "q37fmodel": "Qwen3.7-Flash · x0.1", "gm51model": "GLM-5.2 · x0.6"},
		// opencode（R1-7）：免费模型带「· 免费」标记（本地表判定；远端不下发
		// 免费标记，表外一律 false），付费模型无倍率信息。
		"opencode": {"big-pickle": "Big Pickle · 免费", "deepseek-v4-flash": "DeepSeek V4 Flash"},
	}
	// 兜底路径没有倍率的 provider（rate 必须为空）。
	noRate := map[string]bool{"buddy": true, "workbuddy": true, "trae": true, "lobsterai": true, "codearts": true, "minimax": true}
	// 静态表自带倍率的 provider（rate 必须非空）。
	hasRate := map[string]bool{"raccoon": true, "loomy": true, "qoder": true, "qodercn": true}

	seen := map[string]bool{}
	metas := corejethub.Providers()
	if len(metas) < 11 {
		t.Fatalf("expected 11 providers, got %d", len(metas))
	}
	for _, meta := range metas {
		prod, ok := b.Product(meta.ID)
		if !ok {
			t.Errorf("%s: no product registered", meta.ID)
			continue
		}
		seen[meta.ID] = true
		byName := map[string]string{} // 展示名 → id（查重）
		for _, md := range prod.Models {
			name, rate := modelDisplayParts(md)
			if name == "" {
				t.Errorf("%s/%s: empty display name", meta.ID, md.ID)
			}
			display := name
			if rate != "" {
				display = name + " · " + rate
			}
			if prev, dup := byName[display]; dup {
				t.Errorf("%s: display name %q used by both %s and %s — 同名撞车必须像 ref 的 variantLabelFor 那样加变体标记",
					meta.ID, display, prev, md.ID)
			}
			byName[display] = md.ID
			if noRate[meta.ID] && rate != "" {
				t.Errorf("%s/%s: rate %q invented on a static table that has none in the reference", meta.ID, md.ID, rate)
			}
			if hasRate[meta.ID] && rate == "" {
				t.Errorf("%s/%s: missing rate (the reference table carries one)", meta.ID, md.ID)
			}
		}
		for id, wantDisplay := range want[meta.ID] {
			found := ""
			for _, md := range prod.Models {
				if md.ID != id {
					continue
				}
				n, r := modelDisplayParts(md)
				found = n
				if r != "" {
					found = n + " · " + r
				}
			}
			if found == "" {
				t.Errorf("%s: model %s missing", meta.ID, id)
				continue
			}
			if found != wantDisplay {
				t.Errorf("%s/%s display = %q, want %q", meta.ID, id, found, wantDisplay)
			}
		}
	}
	for provider := range want {
		if !seen[provider] {
			t.Errorf("provider %s not covered by the product tables", provider)
		}
	}
	// ref 的 trae 兜底表过滤掉 isHidden 的四条 ⇒ 面板不能多出它们。
	if prod, ok := b.Product("trae"); ok {
		hidden := map[string]bool{"browser_use_subagent": true, "explore_sub_agent_v13": true, "explore_sub_agent_v2": true, "summary": true}
		for _, md := range prod.Models {
			if hidden[md.ID] {
				t.Errorf("trae/%s is hidden in the reference (staticFallbackModels filters isHidden) — must not be offered in the panel", md.ID)
			}
		}
		if len(prod.Models) != 28 {
			t.Errorf("trae table has %d models, want 28 (32 minus the 4 hidden)", len(prod.Models))
		}
	}
}
