package jethub

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// --- 远端目录解析（ref raccoon-auth.ts parseRaccoonModelCatalog） ---

// raccoonCatalogJSON 是一份**贴近实测**的 model_catalog 响应：10 条 = 3 个
// visible:false 的 raccoon-* 内部模型 + 7 个可见模型（含 2026-10-21 上架的同族
// 新版本 `sn-deepseek-v4-1-flash-1017`）。字段名按实测：id 在 `name`、展示名在
// `description`、窗口在 `params.context_window`。
func raccoonCatalogJSON(code int) string {
	if code != 0 {
		return `{"code":` + fmt.Sprint(code) + `,"message":"unauthorized"}`
	}
	return `{"code":0,"message":"ok","data":{"categories":[
		{"type":"image","models":[{"name":"sn-should-not-appear"}]},
		{"type":"chat","models":[
			{"name":"raccoon-internal-a","visible":false,"description":"内部 A"},
			{"name":"raccoon-internal-b","visible":false,"description":"内部 B"},
			{"name":"raccoon-internal-c","visible":false,"description":"内部 C"},
			{"name":"sn-sensenova-6-8-flash","description":"SenseNova-6.8-Flash",
			 "billing_multiplier":0.5,"billing_effective_multiplier":0,
			 "params":{"context_window":256000,"max_tokens":63999},"tags":["vision","auto"]},
			{"name":"sn-sensenova-6-8-flash-lite","description":"SenseNova-6.8-Flash-Lite",
			 "billing_effective_multiplier":0,"params":{"context_window":256000,"max_tokens":63999}},
			{"name":"sn-glm-5-3","description":"GLM-5-3","billing_multiplier":0.75,
			 "billing_effective_multiplier":0.75,"params":{"context_window":1000000,"max_tokens":100000}},
			{"name":"sn-kimi-k3","description":"Kimi-K3","billing_multiplier":1,
			 "billing_effective_multiplier":1,"params":{"context_window":1000000,"max_tokens":100000}},
			{"name":"sn-glm-5-3-flash","description":"GLM-5-3-Flash","billing_multiplier":0.2,
			 "billing_effective_multiplier":0.1,"params":{"context_window":1000000,"max_tokens":100000},
			 "tags":["general","code"]},
			{"name":"sn-deepseek-v4-1-flash","description":"DeepSeek-V4.1-Flash","billing_multiplier":0.25,
			 "billing_effective_multiplier":0.25,"params":{"context_window":1000000,"max_tokens":100000},
			 "tags":["general","code","html","analysis","reasoning","auto"]},
			{"name":"sn-deepseek-v4-1-flash-1017","description":"DeepSeek-V4.1-Flash-1017",
			 "billing_multiplier":0.25,"billing_effective_multiplier":0,
			 "params":{"context_window":1000000,"max_tokens":100000},
			 "tags":["general","code","html","analysis","reasoning","auto"]},
			{"name":"sn-deepseek-v4-1-flash","description":"重复条目应被去重"}
		]}
	]}}`
}

func raccoonParseFixture(t *testing.T, code int) []raccoonRemoteModel {
	t.Helper()
	data := mustParseEnvelopeData(t, raccoonCatalogJSON(code))
	return raccoonModelsFromData(data)
}

func mustParseEnvelopeData(t *testing.T, body string) map[string]any {
	t.Helper()
	var parsed map[string]any
	if err := jsonUnmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("fixture must be valid JSON: %v", err)
	}
	data, _ := parsed["data"].(map[string]any)
	return data
}

// raccoonDataFixture parses a bare `data`-object literal (no envelope) so the
// edge-case fixtures below stay readable.
func raccoonDataFixture(t *testing.T, dataJSON string) map[string]any {
	t.Helper()
	var data map[string]any
	if err := jsonUnmarshal([]byte(dataJSON), &data); err != nil {
		t.Fatalf("fixture must be valid JSON: %v", err)
	}
	return data
}

// ⚠️ 核心回归：远端新增的同族版本（-1017）必须出现在目录里，且内部模型被过滤、
// 顺序照抄远端、重复 id 去重。修复前本端**根本没有远端目录** ⇒ 面板恒 6 条。
func TestRaccoonParseCatalogIncludesVersionedModel(t *testing.T) {
	models := raccoonParseFixture(t, 0)
	wantIDs := []string{
		"sn-sensenova-6-8-flash",
		"sn-sensenova-6-8-flash-lite",
		"sn-glm-5-3",
		"sn-kimi-k3",
		"sn-glm-5-3-flash",
		"sn-deepseek-v4-1-flash",
		"sn-deepseek-v4-1-flash-1017",
	}
	if len(models) != len(wantIDs) {
		t.Fatalf("visible chat models = %d, want %d: %+v", len(models), len(wantIDs), modelIDsOf(models))
	}
	for i, id := range wantIDs {
		if models[i].ID != id {
			t.Fatalf("order must mirror remote (position %d): got %q want %q (%v)",
				i, models[i].ID, id, modelIDsOf(models))
		}
	}
	byID := map[string]raccoonRemoteModel{}
	for _, m := range models {
		byID[m.ID] = m
	}
	// 展示名 = description + 倍率（1 倍也要显示、0 显示免费、折扣显示箭头）。
	for id, want := range map[string]string{
		"sn-sensenova-6-8-flash":      "SenseNova-6.8-Flash · 免费",
		"sn-glm-5-3":                  "GLM-5-3 · x0.75",
		"sn-kimi-k3":                  "Kimi-K3 · x1",
		"sn-glm-5-3-flash":            "GLM-5-3-Flash · x0.2→x0.1",
		"sn-deepseek-v4-1-flash":      "DeepSeek-V4.1-Flash · x0.25",
		"sn-deepseek-v4-1-flash-1017": "DeepSeek-V4.1-Flash-1017 · 免费",
	} {
		if got := byID[id].Name; got != want {
			t.Errorf("display name %s = %q, want %q", id, got, want)
		}
	}
	if byID["sn-deepseek-v4-1-flash-1017"].ContextWindow != 1_000_000 ||
		byID["sn-deepseek-v4-1-flash-1017"].MaxTokens != 100_000 {
		t.Errorf("params not read for versioned model: %+v", byID["sn-deepseek-v4-1-flash-1017"])
	}
	// 非 chat 分组不得混入。
	for _, m := range models {
		if m.ID == "sn-should-not-appear" || strings.HasPrefix(m.ID, "raccoon-") {
			t.Fatalf("hidden/non-chat entry leaked into catalog: %+v", m)
		}
	}
}

func modelIDsOf(models []raccoonRemoteModel) []string {
	out := make([]string, 0, len(models))
	for _, m := range models {
		out = append(out, m.ID)
	}
	return out
}

// ⚠️ 倍率**缺失**不得渲染成「免费」：缺失传 -1（不挂后缀），0 才是免费。
// 用 `jsonNumberField` 走捷径会把两者混为一谈（用户会把「没取到倍率」当价格读）。
func TestRaccoonMissingMultiplierIsNotFree(t *testing.T) {
	models := raccoonModelsFromData(raccoonDataFixture(t, `{"categories":[{"type":"chat","models":[
		{"name":"sn-no-rate","description":"No-Rate"},
		{"name":"sn-zero-rate","description":"Zero-Rate","billing_effective_multiplier":0}
	]}]}`))
	if len(models) != 2 {
		t.Fatalf("two models expected: %+v", modelIDsOf(models))
	}
	if models[0].Name != "No-Rate" {
		t.Fatalf("missing multiplier must not gain a suffix (nor 免费): %q", models[0].Name)
	}
	if models[1].Name != "Zero-Rate · 免费" {
		t.Fatalf("multiplier 0 must show 免费: %q", models[1].Name)
	}
}

// `description` 缺失时展示名回退到 id；空 id 与畸形条目剔除。
func TestRaccoonNormalizeEdgeCases(t *testing.T) {
	models := raccoonModelsFromData(raccoonDataFixture(t, `{"categories":[{"type":"chat","models":[
		{"name":"  sn-bare  "},
		{"name":"   "},
		{"name":12345,"billing_effective_multiplier":2},
		{"name":"sn-ctx-top","context_window":4096,"params":{"max_tokens":-5}},
		"not-an-object"
	]}]}`))
	if len(models) != 3 {
		t.Fatalf("edge entries wrong: %+v", models)
	}
	if models[0].ID != "sn-bare" || models[0].Name != "sn-bare" {
		t.Fatalf("id must be trimmed and description falls back to id (no rate ⇒ no suffix): %+v", models[0])
	}
	if models[1].ID != "12345" || models[1].Name != "12345 · x2" {
		t.Fatalf("numeric name coerced: %+v", models[1])
	}
	if models[2].ContextWindow != 4096 || models[2].MaxTokens != 0 {
		t.Fatalf("top-level context fallback / negative max_tokens: %+v", models[2])
	}
	// 无 chat 分组 / 无 data ⇒ nil（调用方回落兜底表）。
	if got := raccoonModelsFromData(raccoonDataFixture(t, `{"categories":[{"type":"image"}]}`)); got != nil {
		t.Fatalf("no chat category must yield nil, got %+v", got)
	}
	if got := raccoonModelsFromData(nil); got != nil {
		t.Fatalf("nil data must yield nil, got %+v", got)
	}
}

// --- 图片能力（ref raccoon-product.ts：默认支持，只禁实测纯文本模型） ---

// ⚠️ 不看 `tags`：`vision` 是客户端选模偏好，不是服务端能力契约。
// 2026-10-21 的实测教训：同族新版本 `sn-deepseek-v4-1-flash-1017` 的 tags 同样
// **不含 `vision`**，按 tags 判就会把它禁成 text，而实测它带图 200、四象限色全对。
func TestRaccoonSupportsImageDefaultsToTrue(t *testing.T) {
	models := raccoonParseFixture(t, 0)
	for _, m := range models {
		if !m.SupportsImage {
			t.Fatalf("all current raccoon models read images in practice, %q declared text", m.ID)
		}
	}
	// 未来上架的未知模型同样默认支持（白名单式判据必然腐坏）。
	if !raccoonSupportsImage("sn-not-a-real-model") {
		t.Fatal("unknown model must default to image")
	}
}

// 纯文本集合是**唯一刹车**，且必须按基础 id 命中（同族滚版本会漏禁）。
// ⚠️ 注入集合：生产集合是空集，不注入这条分支永远测不到（恒真断言抓不到）。
func TestRaccoonTextOnlySetBlocksFamilyVersions(t *testing.T) {
	textOnly := map[string]bool{"sn-text-only": true, "sn-explicit-1017": true}
	for _, id := range []string{"sn-text-only", "sn-text-only-1017", "sn-text-only-9999"} {
		if raccoonSupportsImageWith(textOnly, id) {
			t.Fatalf("family version %q escaped the text-only block", id)
		}
	}
	if !raccoonSupportsImageWith(textOnly, "sn-text-only-101") {
		t.Fatal("4-digit suffix regex over-matched: -101 is not a version suffix")
	}
	if !raccoonSupportsImageWith(textOnly, "sn-other") {
		t.Fatal("unlisted model must stay image")
	}
	// 登记了带后缀的完整 id：该条目禁图，无后缀的同族兄弟不受影响。
	if raccoonSupportsImageWith(textOnly, "sn-explicit-1017") {
		t.Fatal("explicit versioned id must be honoured")
	}
	if !raccoonSupportsImageWith(textOnly, "sn-explicit") {
		t.Fatal("stripping must not禁 the un-versioned sibling of an explicit entry")
	}
	// 当前目录（10 条）里没有实测确认的纯文本模型 ⇒ 生产集合为空。
	if len(raccoonTextOnlyModels) != 0 {
		t.Logf("raccoonTextOnlyModels is non-empty: %v — 新增条目必须先有带图实测证据", raccoonTextOnlyModels)
	}
}

// --- 远端目录缓存（ref RemoteCatalogGate 闸门语义） ---

func resetRaccoonCatalogCache() {
	raccoonCatalogCache.mu.Lock()
	defer raccoonCatalogCache.mu.Unlock()
	raccoonCatalogCache.models = nil
	raccoonCatalogCache.fetched = time.Time{}
	raccoonCatalogCache.failed = false
	raccoonCatalogCache.inflight = false
}

func TestRaccoonRemoteCatalogCached(t *testing.T) {
	resetRaccoonCatalogCache()
	defer resetRaccoonCatalogCache()

	var calls int
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != raccoonModelCatalog {
			t.Errorf("unexpected catalog path %q", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("catalog must be GET, got %s", r.Method)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer rtok" {
			t.Errorf("catalog must carry the bearer token, got %q", auth)
		}
		calls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(raccoonCatalogJSON(0)))
	})
	restoreRaccoonAPIBase(t, srv.URL)

	m := newSeedRaccoonManager(t)
	for i := 0; i < 3; i++ {
		if got := m.raccoonRemoteModels(ctxBackground()); len(got) != 7 {
			t.Fatalf("call %d: %+v", i, modelIDsOf(got))
		}
	}
	if calls != 1 {
		t.Fatalf("successful catalog must be cached (10min TTL), upstream calls = %d", calls)
	}
}

// 失败（HTTP 200 + 非 0 业务码，raccoon 的统一信封）⇒ 冷却窗内只打一次上游，
// 且**兜底表不写进缓存**（否则一次瞬时失败让渠道永久只剩 6 条兜底模型）。
func TestRaccoonRemoteCatalogFailureCooldownAndNoFallbackCaching(t *testing.T) {
	resetRaccoonCatalogCache()
	defer resetRaccoonCatalogCache()

	var calls int
	srv := newMockServer(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(raccoonCatalogJSON(401001)))
	})
	restoreRaccoonAPIBase(t, srv.URL)

	m := newSeedRaccoonManager(t)
	for i := 0; i < 4; i++ {
		if got := m.raccoonRemoteModels(ctxBackground()); got != nil {
			t.Fatalf("failed catalog must yield nil (fallback lives in ModelsFor), got %+v", got)
		}
	}
	if calls != 1 {
		t.Fatalf("failed catalog must be throttled (30s cooldown), upstream calls = %d", calls)
	}
	raccoonCatalogCache.mu.Lock()
	cached := len(raccoonCatalogCache.models)
	failed := raccoonCatalogCache.failed
	raccoonCatalogCache.mu.Unlock()
	if cached != 0 {
		t.Fatalf("fallback table must never enter the remote cache, got %d entries", cached)
	}
	if !failed {
		t.Fatal("failure must be recorded for the cooldown window")
	}
}

// 没有可用凭据时不发请求（未登录打上游只会制造噪声）。
func TestRaccoonCatalogSkippedWithoutCredential(t *testing.T) {
	resetRaccoonCatalogCache()
	defer resetRaccoonCatalogCache()

	var calls int
	srv := newMockServer(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
	})
	restoreRaccoonAPIBase(t, srv.URL)

	m := newTestManager(t).m // 无账号
	if got := m.raccoonRemoteModels(ctxBackground()); got != nil {
		t.Fatalf("no accounts must yield nil, got %+v", got)
	}
	if calls != 0 {
		t.Fatalf("must not hit upstream without a credential, calls = %d", calls)
	}
}

// 并发去重（ref RemoteCatalogGate 的 inflight 语义）：一次目录请求在途时，后来的
// 调用者**不得**再打上游、也**不得**排队等待 —— 直接回落兜底表（同时开两个面板
// tab 不会把上游压力放大成 N 倍，也不会让 UI 卡在目录请求上）。
func TestRaccoonCatalogConcurrentDedup(t *testing.T) {
	resetRaccoonCatalogCache()
	defer resetRaccoonCatalogCache()

	var calls int32
	var once sync.Once
	entered := make(chan struct{})
	srv := newMockServer(t, func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		once.Do(func() { close(entered) })
		time.Sleep(200 * time.Millisecond) // 把第二个调用者留在在途窗口里
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(raccoonCatalogJSON(0)))
	})
	restoreRaccoonAPIBase(t, srv.URL)

	m := newSeedRaccoonManager(t)
	first := make(chan []raccoonRemoteModel, 1)
	go func() { first <- m.raccoonRemoteModels(ctxBackground()) }()

	<-entered // 第一个请求确实已进入在途窗口
	if got := m.raccoonRemoteModels(ctxBackground()); got != nil {
		t.Fatalf("waiting caller must fall back instead of queueing, got %d entries", len(got))
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("concurrent callers must dedup to one upstream call, got %d", n)
	}
	if got := <-first; len(got) != 7 {
		t.Fatalf("in-flight caller must still receive the remote catalog: %+v", modelIDsOf(got))
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("upstream calls = %d, want 1", n)
	}
}

// --- ModelsFor：远端优先、兜底表兜底 ---

// ⚠️ 用户报障的正向断言：远端有 `sn-deepseek-v4-1-flash-1017` 时，
// 面板与 `/v1/models` 拿到的表里必须有它（展示名带 `-1017` 版本号，让用户能区分）。
func TestRaccoonModelsForPrefersRemote(t *testing.T) {
	resetRaccoonCatalogCache()
	defer resetRaccoonCatalogCache()

	srv := newMockServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(raccoonCatalogJSON(0)))
	})
	restoreRaccoonAPIBase(t, srv.URL)

	m := newSeedRaccoonManager(t)
	table := RaccoonModelsFor(m)
	if len(table) != 7 {
		t.Fatalf("remote catalog must win over the 6-entry fallback: %+v", table)
	}
	idx := -1
	for i := range table {
		if table[i].ID == "sn-deepseek-v4-1-flash-1017" {
			idx = i
		}
	}
	if idx < 0 {
		t.Fatalf("upstream-added model missing: %v", modelTableIDs(table))
	}
	entry := table[idx]
	if !strings.Contains(entry.Alias, "DeepSeek-V4.1-Flash-1017") {
		t.Fatalf("alias must keep the version suffix for disambiguation: %q", entry.Alias)
	}
	if !strings.Contains(entry.Note, "ctx 1000000") || !strings.Contains(entry.Note, "max 100000") {
		t.Fatalf("note must carry ctx/max: %q", entry.Note)
	}
}

// offline（目录失败）⇒ 回落静态兜底表 6 条，而不是空表。
func TestRaccoonModelsForOfflineFallback(t *testing.T) {
	resetRaccoonCatalogCache()
	defer resetRaccoonCatalogCache()

	srv := newMockServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	restoreRaccoonAPIBase(t, srv.URL)

	m := newSeedRaccoonManager(t)
	table := RaccoonModelsFor(m)
	if len(table) != 6 {
		t.Fatalf("offline must fall back to the 6-entry snapshot table: %+v", table)
	}
	if table[5].ID != "sn-deepseek-v4-1-flash" {
		t.Fatalf("fallback table order changed: %v", modelTableIDs(table))
	}
}

// 机器守卫：raccoon 的 Product 必须接线 ModelsFor（此前只有静态快照 ⇒ 报障根因）。
func TestRaccoonProductWiresModelsFor(t *testing.T) {
	m := newTestManager(t).m
	b := NewBridge(m, newFakeRegistry())
	RegisterDefaultProducts(b)
	prod, ok := b.Product("raccoon")
	if !ok {
		t.Fatal("raccoon product missing")
	}
	if prod.ModelsFor == nil {
		t.Fatal("raccoon Product must wire ModelsFor (dynamic remote catalog)")
	}
}

func modelTableIDs(table ModelTable) []string {
	out := make([]string, 0, len(table))
	for _, md := range table {
		out = append(out, md.ID)
	}
	return out
}
