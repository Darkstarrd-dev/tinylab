package jethub

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newTestBridge builds a Manager + Bridge wired to a throwaway registry, with
// a single qoder-style account (generic access_token credential).
func newTestBridge(t *testing.T) (*Bridge, *Manager, string, string) {
	t.Helper()
	m := newTestManager(t).m
	id, ref := NewAccountID("codearts")
	if err := m.AddAccount(Account{ID: id, Provider: "codearts", Nickname: "a",
		Enabled: true, CredentialRef: ref, CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetCredential("codearts", ref, []byte(`{"access_token":"test-token"}`), 0, false); err != nil {
		t.Fatal(err)
	}
	b := NewBridge(m, newFakeRegistry())
	return b, m, id, ref
}

// TestProbeAccountModelAugmentedUpstream: the probe reuses the proxy's
// augmenter path (URL + body rewrite + account headers) and treats HTTP 200
// as "marker stale" (nil error).
func TestProbeAccountModelAugmentedUpstream(t *testing.T) {
	var gotPath, gotAuth, gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[]}`))
	}))
	defer upstream.Close()

	b, m, accID, _ := newTestBridge(t)
	b.RegisterProduct(Product{Provider: "codearts", DisplayName: "t", BaseURL: upstream.URL})
	// A fake augmenter that signs like the real ones (full header reset).
	m.SetAugmenter("codearts", func(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
		for k := range r.Header {
			r.Header.Del(k)
		}
		r.Header.Set("Authorization", "Bearer signed")
		r.Header.Set("X-Test", keyID)
		return []byte(`{"signed":true}`), nil
	})

	if err := b.ProbeAccountModel(context.Background(), "codearts", accID, "GLM-5"); err != nil {
		t.Fatalf("probe must succeed on HTTP 200: %v", err)
	}
	// Default URL = BuildUpstreamURL(base, /v1/chat/completions); host-root
	// base injects /v1.
	if gotPath != "/v1/chat/completions" {
		t.Fatalf("upstream path: %q", gotPath)
	}
	if gotAuth != "Bearer signed" {
		t.Fatalf("augmenter headers must win: %q", gotAuth)
	}
	if gotBody != `{"signed":true}` {
		t.Fatalf("augmented body must be sent: %q", gotBody)
	}
}

// TestProbeAccountModelBearerFallback: without an augmenter the probe falls
// back to the account's bearer token (mirroring the proxy default), and a
// non-200 response becomes an error carrying the status + snippet.
func TestProbeAccountModelBearerFallback(t *testing.T) {
	status := http.StatusOK
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("bearer fallback: %q", got)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "GLM-5" {
			t.Errorf("minimal body model: %v", body["model"])
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"error":"limited"}`))
	}))
	defer upstream.Close()

	b, _, accID, _ := newTestBridge(t)
	b.RegisterProduct(Product{Provider: "codearts", DisplayName: "t", BaseURL: upstream.URL})

	if err := b.ProbeAccountModel(context.Background(), "codearts", accID, "GLM-5"); err != nil {
		t.Fatalf("probe must succeed on 200: %v", err)
	}
	status = http.StatusTooManyRequests
	err := b.ProbeAccountModel(context.Background(), "codearts", accID, "GLM-5")
	if err == nil || !strings.Contains(err.Error(), "429") || !strings.Contains(err.Error(), "limited") {
		t.Fatalf("non-200 must carry status + snippet: %v", err)
	}
}

// TestProbeAccountModelMinimaxPath: minimax is Anthropic-native — the probe
// must hit /v1/messages with a messages-shaped body.
func TestProbeAccountModelMinimaxPath(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	b, m, _, _ := newTestBridge(t)
	mmID, mmRef := NewAccountID("minimax")
	if err := m.AddAccount(Account{ID: mmID, Provider: "minimax", Nickname: "mm",
		Enabled: true, CredentialRef: mmRef, CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetCredential("minimax", mmRef, []byte(`{"access_token":"mm-tok"}`), 0, false); err != nil {
		t.Fatal(err)
	}
	b.RegisterProduct(Product{Provider: "minimax", DisplayName: "t", BaseURL: upstream.URL})

	if err := b.ProbeAccountModel(context.Background(), "minimax", mmID, "MiniMax-M3"); err != nil {
		t.Fatalf("minimax probe: %v", err)
	}
	if gotPath != "/v1/messages" {
		t.Fatalf("minimax entry path: %q", gotPath)
	}
	if gotBody["max_tokens"] == nil || gotBody["messages"] == nil {
		t.Fatalf("anthropic body shape: %v", gotBody)
	}
}

// 限流标记的清理：重置跳过内部记账键（__ 前缀），可按账号过滤。
func TestClearModelRateLimits(t *testing.T) {
	b, m, accID, _ := newTestBridge(t)
	id2, ref2 := NewAccountID("codearts")
	if err := m.AddAccount(Account{ID: id2, Provider: "codearts", Nickname: "b",
		Enabled: true, CredentialRef: ref2, CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateModelRateLimit(accID, "GLM-5", 123); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateModelRateLimit(accID, "__trae_checkin_gen__", 2); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateModelRateLimit(id2, "GLM-5", 456); err != nil {
		t.Fatal(err)
	}
	// 单账号重置：__ 键不计入清除数，且被一并移除。
	cleared, err := b.ResetRateLimits("codearts", accID)
	if err != nil || cleared.ClearedCount != 1 {
		t.Fatalf("single-account reset: %d %v", cleared.ClearedCount, err)
	}
	acc, _ := m.FindAccount(accID)
	if len(acc.ModelRateLimits) != 0 {
		t.Fatalf("bookkeeping key must be cleared too: %v", acc.ModelRateLimits)
	}
	acc2, _ := m.FindAccount(id2)
	if len(acc2.ModelRateLimits) != 1 {
		t.Fatalf("other account must keep markers: %v", acc2.ModelRateLimits)
	}
	// 全量重置。
	cleared, err = b.ResetRateLimits("codearts", "")
	if err != nil || cleared.ClearedCount != 1 {
		t.Fatalf("all-accounts reset: %d %v", cleared.ClearedCount, err)
	}
}

// RetestRateLimits: probe 成功清标记、失败保留并带原因。
func TestRetestRateLimitsProbesAndClears(t *testing.T) {
	fail := true
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`limited`))
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	b, m, accID, _ := newTestBridge(t)
	b.RegisterProduct(Product{Provider: "codearts", DisplayName: "t", BaseURL: upstream.URL})
	if err := m.UpdateModelRateLimit(accID, "GLM-5", 123); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateModelRateLimit(accID, "GLM-4", 456); err != nil {
		t.Fatal(err)
	}
	// 两个模型都 429 → 标记保留 + 原因上报。
	res, err := b.RetestRateLimits(context.Background(), "codearts", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.ClearedCount != 0 || len(res.Accounts) != 1 || len(res.Accounts[0].StillLimited) != 2 {
		t.Fatalf("still-limited retest: %+v", res)
	}
	// 上游恢复 → 两个标记都被清除。
	fail = false
	res, err = b.RetestRateLimits(context.Background(), "codearts", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.ClearedCount != 2 || len(res.Accounts) != 0 {
		t.Fatalf("cleared retest: %+v", res)
	}
	acc, _ := m.FindAccount(accID)
	if len(acc.ModelRateLimits) != 0 {
		t.Fatalf("markers must be gone: %v", acc.ModelRateLimits)
	}
}

// 模型黑名单批量 + 恢复默认。
func TestModelsBatchAndRestoreDefaults(t *testing.T) {
	b, m, _, _ := newTestBridge(t)
	if err := m.SetModelsDisabled("codearts", []string{"a", "b", ""}, true); err != nil {
		t.Fatal(err)
	}
	disabled := m.DisabledModels("codearts")
	if !disabled["a"] || !disabled["b"] || len(disabled) != 2 {
		t.Fatalf("batch disable: %v", disabled)
	}
	// 恢复部分。
	if err := m.SetModelsDisabled("codearts", []string{"a"}, false); err != nil {
		t.Fatal(err)
	}
	disabled = m.DisabledModels("codearts")
	if disabled["a"] || !disabled["b"] {
		t.Fatalf("partial restore: %v", disabled)
	}
	// 恢复默认 = 整表清空（桥接同步不受影响地走 SyncKeys）。
	if err := m.ClearDisabledModels("codearts"); err != nil {
		t.Fatal(err)
	}
	if got := m.DisabledModels("codearts"); len(got) != 0 {
		t.Fatalf("restore defaults: %v", got)
	}
	_ = b // bridge wired for symmetry
}

// 永久锁开关 + 持久化。
func TestPermanentLockTogglePersists(t *testing.T) {
	env := newTestManager(t)
	if env.m.PermanentLocked("buddy") {
		t.Fatal("default must be unlocked")
	}
	if err := env.m.SetPermanentLocked("buddy", true); err != nil {
		t.Fatal(err)
	}
	if !env.m.PermanentLocked("buddy") {
		t.Fatal("lock must persist")
	}
	// 新 manager 重载同一目录 → 状态还原。
	m2, err := NewManager(env.dir, env.key, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !m2.PermanentLocked("buddy") {
		t.Fatal("lock must survive reload")
	}
	if err := m2.SetPermanentLocked("buddy", false); err != nil {
		t.Fatal(err)
	}
	if m2.PermanentLocked("buddy") {
		t.Fatal("unlock must persist")
	}
}

// 防退化哨兵：minimax 的探针体形态锁死（Anthropic 原生透传，不做格式转换）。
func TestProbeEntryPathFamilies(t *testing.T) {
	path, body := probeEntryPath("minimax", "M3")
	if path != "/v1/messages" || !strings.Contains(string(body), `"messages"`) {
		t.Fatalf("minimax probe shape: %s %s", path, body)
	}
	path, body = probeEntryPath("qoder", "qfmodel")
	if path != "/v1/chat/completions" || !strings.Contains(string(body), `"model":"qfmodel"`) {
		t.Fatalf("openai probe shape: %s %s", path, body)
	}
}
