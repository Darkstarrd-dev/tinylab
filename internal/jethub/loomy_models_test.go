package jethub

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- 名称规范化（ref loomy.ts splitLoomyRate / loomyDisplayName） ---

func TestLoomySplitRateForms(t *testing.T) {
	cases := []struct {
		raw  string
		name string
		rate string
	}{
		{"MiniMax M3 （x4.0）", "MiniMax M3", "x4.0"},
		{"Qwen 3.8 Max (x12.0)", "Qwen 3.8 Max", "x12.0"},
		{"GLM 5.3 Flash(x0.8)", "GLM 5.3 Flash", "x0.8"},
		{"qwen3.8-flash", "qwen3.8-flash", ""},
		{"", "", ""},
	}
	for _, c := range cases {
		name, rate := loomySplitRate(c.raw)
		if name != c.name || rate != c.rate {
			t.Errorf("splitLoomyRate(%q) = (%q,%q), want (%q,%q)", c.raw, name, rate, c.name, c.rate)
		}
	}
}

func TestLoomyDisplayNameIdempotent(t *testing.T) {
	// 幂等：远端原值与已规范化形态解析结果一致（ref 单测锁死）。
	for _, raw := range []string{"MiniMax M3 （x4.0）", "Qwen 3.8 Max (x12.0)", "GLM 5.3 Flash(x0.8)"} {
		normalized := loomyDisplayName(raw)
		if !strings.Contains(normalized, "· x") {
			t.Fatalf("display name must embed rate: %q", normalized)
		}
		name2, rate2 := loomySplitRate(normalized)
		name1, rate1 := loomySplitRate(raw)
		if name1 != name2 || rate1 != rate2 {
			t.Errorf("not idempotent: %q → %q vs %q/%q", raw, normalized, name2, rate2)
		}
	}
	// 无倍率时不追加分隔符。
	if got := loomyDisplayName("qwen3.8-flash"); got != "qwen3.8-flash" {
		t.Fatalf("no-rate name must not gain separator: %q", got)
	}
}

// --- 覆盖表（ref loomy-product.ts：大小写/空白不敏感，非通配） ---

func TestLoomyContextWindowOverride(t *testing.T) {
	// spark-x：远端虚报 1M，真实墙 262144（ref IKJW31）。
	if got := loomyContextWindow("spark-x", 1_048_576); got != 262_144 {
		t.Fatalf("spark-x must override to 262144, got %d", got)
	}
	// 查表口径归一（上游改大小写/空白不得静默失效）。
	if got := loomyContextWindow("Spark-X", 1_048_576); got != 262_144 {
		t.Fatalf("case-insensitive lookup failed: %d", got)
	}
	if got := loomyContextWindow(" spark-x ", 1_048_576); got != 262_144 {
		t.Fatalf("whitespace-insensitive lookup failed: %d", got)
	}
	// 未登记条目照传声明值（归一不是通配）。
	if got := loomyContextWindow("SOME-OTHER", 4096); got != 4096 {
		t.Fatalf("unlisted model must pass declared value: %d", got)
	}
	// 键必须已归一（机器守卫：加新条目忘了小写会红）。
	for id := range loomyContextWindowOverrides {
		if id != strings.TrimSpace(strings.ToLower(id)) {
			t.Errorf("context override key %q not normalized", id)
		}
	}
}

func TestLoomyImageCapabilityOverride(t *testing.T) {
	// 远端漏报 text 但实测能读图的 qwen-3.8-max 必须补报。
	if !loomySupportsImage("qwen-3.8-max", false) {
		t.Fatal("qwen-3.8-max override must补报 image")
	}
	if !loomySupportsImage("QWEN-3.8-MAX", false) {
		t.Fatal("image lookup must be case-insensitive")
	}
	// 未登记模型照传声明值：声明 text 仍是 false（不能退化成「该家恒支持图片」）。
	if loomySupportsImage("spark-x", false) {
		t.Fatal("spark-x declared text must stay false")
	}
	if !loomySupportsImage("spark-x", true) {
		t.Fatal("spark-x declared image must stay true")
	}
	for id := range loomyImageCapabilityOverrides {
		if id != strings.TrimSpace(strings.ToLower(id)) {
			t.Errorf("image override key %q not normalized", id)
		}
	}
}

// --- 远端目录解析 ---

func TestLoomyParseRemoteModels(t *testing.T) {
	payload := []byte(`{"object":"list","data":[
		{"id":"MiniMax-M3","name":"MiniMax M3 （x4.0）","type":"chat","context_length":1048576,
		 "capabilities":{"reasoning":true,"input_modalities":["text","image"]}},
		{"id":"Hy-Image-3.5","name":"Hy image 3.5","type":"image"},
		{"id":"spark-x","name":"Spark X2.5（x0.1）","type":"chat","context_length":1048576,
		 "capabilities":{"reasoning":true,"input_modalities":["text"]}},
		{"id":"qwen-3.8-max","name":"Qwen 3.8 Max（x12.0）","type":"chat","context_length":1000000,
		 "capabilities":{"reasoning":true,"vision":false,"input_modalities":["text"]}}
	]}`)
	models := loomyParseRemoteModels(payload)
	if len(models) != 3 {
		t.Fatalf("only chat models expected: %+v", models)
	}
	if models[0].ID != "MiniMax-M3" || models[0].Name != "MiniMax M3 · x4.0" {
		t.Fatalf("name normalization wrong: %+v", models[0])
	}
	// 覆盖表在远端解析路径生效（spark-x 虚报 1M → 真实 262144）。
	if models[1].ID != "spark-x" || models[1].ContextWindow != 262_144 {
		t.Fatalf("spark-x override failed on remote path: %+v", models[1])
	}
	// 图片覆盖表在远端解析路径生效（qwen-3.8-max 漏报 text → true）。
	if models[2].ID != "qwen-3.8-max" || !models[2].SupportsImage {
		t.Fatalf("qwen-3.8-max image override failed on remote path: %+v", models[2])
	}
}

func TestLoomyParseRemoteModelsShapes(t *testing.T) {
	// 裸数组形态。
	bare := []byte(`[{"id":"MiniMax-M3","name":"MiniMax M3","type":"chat","context_length":1048576}]`)
	if got := loomyParseRemoteModels(bare); len(got) != 1 || got[0].ID != "MiniMax-M3" {
		t.Fatalf("bare array not parsed: %+v", got)
	}
	// 畸形输入不抛。
	for _, bad := range [][]byte{nil, []byte(`"x"`), []byte(`{"data":"x"}`), []byte(`{}`)} {
		if got := loomyParseRemoteModels(bad); got != nil {
			t.Errorf("malformed input must yield nil: %+v", got)
		}
	}
}

// --- 静态兜底表：spark-x 按覆盖表的真实值 ---

func TestLoomyFallbackSparkXContext(t *testing.T) {
	for _, md := range loomyFallbackModels() {
		if md.ID != "spark-x" {
			continue
		}
		note := strings.TrimSpace(strings.Split(md.Note, ";")[0])
		if !strings.HasPrefix(note, "ctx ") {
			t.Fatalf("spark-x note missing ctx: %q", md.Note)
		}
		ctx, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(note, "ctx ")))
		if err != nil {
			t.Fatalf("spark-x ctx not an integer: %q", md.Note)
		}
		if ctx != 262_144 {
			t.Fatalf("spark-x fallback ctx must be 262144 (override), got %d", ctx)
		}
		return
	}
	t.Fatal("spark-x missing from fallback table")
}

// --- 远端目录缓存（ref RemoteCatalogGate 闸门语义） ---

func resetLoomyCatalogCache() {
	loomyCatalogCache.mu.Lock()
	defer loomyCatalogCache.mu.Unlock()
	loomyCatalogCache.models = nil
	loomyCatalogCache.fetched = time.Time{}
	loomyCatalogCache.failed = false
	loomyCatalogCache.inflight = false
}

func TestLoomyRemoteCatalogCached(t *testing.T) {
	resetLoomyCatalogCache()
	defer resetLoomyCatalogCache()

	var mu sync.Mutex
	var calls int
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		w.Write([]byte(`{"object":"list","data":[{"id":"MiniMax-M3","name":"MiniMax M3 （x4.0）","type":"chat","context_length":1048576}]}`))
	})
	restoreLoomyAPIBase(t, srv.URL)

	m := newSeedLoomyManager(t)
	got := m.loomyRemoteModels(context.Background())
	if len(got) != 1 || got[0].ID != "MiniMax-M3" {
		t.Fatalf("remote catalog not parsed: %+v", got)
	}
	mu.Lock()
	calls1 := calls
	mu.Unlock()
	if calls1 != 1 {
		t.Fatalf("expected 1 fetch, got %d", calls1)
	}
	// 第二次命中缓存：不发新请求。
	_ = m.loomyRemoteModels(context.Background())
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("success cache must serve the second read, got %d calls", calls)
	}
}

func TestLoomyRemoteCatalogFailureCooldown(t *testing.T) {
	resetLoomyCatalogCache()
	defer resetLoomyCatalogCache()

	var mu sync.Mutex
	var calls int
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		w.WriteHeader(http.StatusNotFound) // 或非 chat 空目录
	})
	restoreLoomyAPIBase(t, srv.URL)

	m := newSeedLoomyManager(t)
	if got := m.loomyRemoteModels(context.Background()); got != nil {
		t.Fatalf("failure must return nil (caller falls back): %+v", got)
	}
	// 冷却窗口内不再打上游。
	if got := m.loomyRemoteModels(context.Background()); got != nil {
		t.Fatalf("cooldown must keep returning nil: %+v", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("failure cooldown must suppress the second fetch, got %d", calls)
	}
	// 兜底表不得写进缓存（否则远端恢复后也永远看不到真实目录）。
	if len(loomyCatalogCache.models) != 0 {
		t.Fatal("fallback table must NOT enter the catalog cache")
	}
	if !loomyCatalogCache.failed {
		t.Fatal("failure must be recorded for cooldown")
	}
}

func TestLoomyModelsForOfflineFallback(t *testing.T) {
	resetLoomyCatalogCache()
	defer resetLoomyCatalogCache()

	m := newTestManager(t).m
	// 指向必然打不到的地址：若实现误发请求，会挂起/报错而非静默通过。
	restoreLoomyAPIBase(t, "http://127.0.0.1:1")

	models := LoomyModelsFor(m)
	if len(models) != 8 {
		t.Fatalf("offline fallback must yield the 8-model table, got %d", len(models))
	}
}

func TestLoomyModelsForRemoteFirst(t *testing.T) {
	resetLoomyCatalogCache()
	defer resetLoomyCatalogCache()

	// 远端返回 9 条（含上游新增的 DeepSeek-V4.1-Flash）。
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"object":"list","data":[
			{"id":"MiniMax-M3","name":"MiniMax M3 （x4.0）","type":"chat","context_length":1048576},
			{"id":"DeepSeek-V4.1-Flash","name":"DeepSeek V4.1 Flash（x0.1）","type":"chat","context_length":1048576},
			{"id":"Hy-Image","name":"Hy Image","type":"image"}
		]}`))
	})
	restoreLoomyAPIBase(t, srv.URL)

	m := newSeedLoomyManager(t)
	models := LoomyModelsFor(m)
	if len(models) != 2 {
		t.Fatalf("remote catalog must win: %+v", models)
	}
	if models[1].ID != "DeepSeek-V4.1-Flash" {
		t.Fatalf("missing upstream-added model: %+v", models)
	}
	if !strings.Contains(models[1].Alias, "· x") {
		t.Fatalf("remote alias must embed rate: %q", models[1].Alias)
	}
}

func TestLoomyProductWiresModelsFor(t *testing.T) {
	m := newTestManager(t).m
	b := NewBridge(m, newFakeRegistry())
	RegisterDefaultProducts(b)
	prod, ok := b.Product("loomy")
	if !ok {
		t.Fatal("loomy product missing")
	}
	if prod.ModelsFor == nil {
		t.Fatal("loomy Product must wire ModelsFor (dynamic remote catalog)")
	}
}
