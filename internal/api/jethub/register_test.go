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
