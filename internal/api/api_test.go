package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/download"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

func setupTestServer(t *testing.T) (*httptest.Server, *registry.Registry, string, *Router) {
	t.Helper()
	cfg := config.DefaultConfig()
	cfg.Providers = []config.Provider{
		{
			ID: "test-prov", Name: "Test", Prefix: "test", BaseURL: "https://api.test.com",
			APIType: "openai-compatible", IsActive: true,
			Keys: []config.Key{{ID: "k1", Key: "sk-test", Name: "Main", Priority: 1, IsActive: true}},
		},
	}
	cfg.Combos = []config.Combo{
		{ID: "c1", Name: "testcombo", Strategy: "fallback", Models: []string{"test-prov/model-a"}},
	}
	reg := registry.New(cfg)
	logger := console.New(100)
	usageBuf := usage.New(100)
	selector := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	proxyHandler := proxy.New(reg, selector, comboRes, usageBuf, usage.NewQuotaTracker(), logger, 0)
	tmpFile := filepath.Join(t.TempDir(), "config.yaml")
	apiRouter := New(reg, cfg, tmpFile, usageBuf, usage.New(50), usage.NewQuotaTracker(), logger, proxyHandler, context.CancelFunc(func() {}), selector, comboRes, download.NewManager(download.RuntimeSettings{}, logger))
	handler := apiRouter.Routes(proxyHandler)
	return httptest.NewServer(handler), reg, tmpFile, apiRouter
}

func requestJSON(t *testing.T, method, url, body string) *http.Response {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return string(data)
}

func TestSettings_Get(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	resp := requestJSON(t, "GET", srv.URL+"/api/settings", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(readBody(t, resp)), &body); err != nil {
		t.Fatal(err)
	}
	if body["port"] != float64(20128) {
		t.Errorf("expected port 20128, got %v", body["port"])
	}
	rot := body["rotation"].(map[string]any)
	if rot["strategy"] != "fill-first" {
		t.Errorf("expected strategy fill-first, got %v", rot["strategy"])
	}
}

func TestSettings_Update(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	payload := `{"port": 9999}`
	resp := requestJSON(t, "PATCH", srv.URL+"/api/settings", payload)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}

	resp = requestJSON(t, "GET", srv.URL+"/api/settings", "")
	var body map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &body)
	if body["port"] != float64(9999) {
		t.Errorf("expected port 9999, got %v", body["port"])
	}
}

func TestProviders_CRUD(t *testing.T) {
	srv, reg, _, _ := setupTestServer(t)
	defer srv.Close()

	// Create
	payload := `{"id":"p1","name":"MyProvider","prefix":"my","baseUrl":"https://my.api.com"}`
	resp := requestJSON(t, "POST", srv.URL+"/api/providers", payload)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var created config.Provider
	json.Unmarshal([]byte(readBody(t, resp)), &created)
	if created.ID != "p1" || created.APIType != "openai-compatible" {
		t.Errorf("unexpected provider: %+v", created)
	}

	// List
	resp = requestJSON(t, "GET", srv.URL+"/api/providers", "")
	var listResp map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &listResp)
	providers := listResp["providers"].([]any)
	if len(providers) != 2 {
		t.Errorf("expected 2 providers, got %d", len(providers))
	}

	// Update
	payload = `{"name":"Updated","prefix":"up","baseUrl":"https://updated.com","isActive":false}`
	resp = requestJSON(t, "PUT", srv.URL+"/api/providers/p1", payload)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var updated config.Provider
	json.Unmarshal([]byte(readBody(t, resp)), &updated)
	if updated.Name != "Updated" || updated.IsActive {
		t.Errorf("provider not updated: %+v", updated)
	}

	// Reorder p1 to index 1 (moves p1 to first position)
	resp = requestJSON(t, "PUT", srv.URL+"/api/providers/p1/reorder", `{"index":1}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on reorder, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	resp = requestJSON(t, "GET", srv.URL+"/api/providers", "")
	json.Unmarshal([]byte(readBody(t, resp)), &listResp)
	providers = listResp["providers"].([]any)
	p0 := providers[0].(map[string]any)
	if p0["id"] != "p1" {
		t.Errorf("expected p1 at index 0 after reorder, got %v", p0["id"])
	}

	// Delete
	resp = requestJSON(t, "DELETE", srv.URL+"/api/providers/p1", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}

	// Verify gone
	resp = requestJSON(t, "GET", srv.URL+"/api/providers", "")
	json.Unmarshal([]byte(readBody(t, resp)), &listResp)
	providers = listResp["providers"].([]any)
	if len(providers) != 1 {
		t.Errorf("expected 1 provider after delete, got %d", len(providers))
	}

	// Verify provider not found (confirm reg state)
	_, ok := reg.GetProvider("p1")
	if ok {
		t.Error("provider should be deleted from registry")
	}
}

func TestKeys_CRUD(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	// Create provider
	requestJSON(t, "POST", srv.URL+"/api/providers", `{"id":"kp","name":"KP","prefix":"kp","baseUrl":"https://kp.com"}`)

	// Create key
	resp := requestJSON(t, "POST", srv.URL+"/api/providers/kp/keys", `{"key":"sk-test123","name":"SecKey","priority":2}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var createdKey config.Key
	json.Unmarshal([]byte(readBody(t, resp)), &createdKey)
	if createdKey.Name != "SecKey" {
		t.Errorf("unexpected key: %+v", createdKey)
	}
	keyID := createdKey.ID

	// List keys
	resp = requestJSON(t, "GET", srv.URL+"/api/providers/kp/keys", "")
	var keysResp map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &keysResp)
	keys := keysResp["keys"].([]any)
	if len(keys) != 1 {
		t.Fatalf("expected 1 key, got %d", len(keys))
	}

	// Update key
	resp = requestJSON(t, "PUT", fmt.Sprintf("%s/api/providers/kp/keys/%s", srv.URL, keyID), `{"name":"UpdatedKey","isActive":false}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}

	// Delete key
	resp = requestJSON(t, "DELETE", fmt.Sprintf("%s/api/providers/kp/keys/%s", srv.URL, keyID), "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}

	// Verify empty keys
	resp = requestJSON(t, "GET", srv.URL+"/api/providers/kp/keys", "")
	json.Unmarshal([]byte(readBody(t, resp)), &keysResp)
	keys = keysResp["keys"].([]any)
	if len(keys) != 0 {
		t.Errorf("expected 0 keys after delete, got %d", len(keys))
	}
}

func TestCombos_CRUD(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	// Create
	payload := `{"id":"cx","name":"mycombo","strategy":"round-robin","models":["test-prov/model-x"]}`
	resp := requestJSON(t, "POST", srv.URL+"/api/combos", payload)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", resp.StatusCode, readBody(t, resp))
	}

	// List
	resp = requestJSON(t, "GET", srv.URL+"/api/combos", "")
	var listResp map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &listResp)
	combos := listResp["combos"].([]any)
	if len(combos) != 2 {
		t.Fatalf("expected 2 combos, got %d", len(combos))
	}

	// Update
	resp = requestJSON(t, "PUT", srv.URL+"/api/combos/cx", `{"name":"updatedcombo","models":["test-prov/model-y"]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}

	// Delete
	resp = requestJSON(t, "DELETE", srv.URL+"/api/combos/cx", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}

	// Verify gone
	resp = requestJSON(t, "GET", srv.URL+"/api/combos", "")
	json.Unmarshal([]byte(readBody(t, resp)), &listResp)
	combos = listResp["combos"].([]any)
	if len(combos) != 1 {
		t.Errorf("expected 1 combo after delete, got %d", len(combos))
	}
}

func TestUsage_Endpoints(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	// Get (empty)
	resp := requestJSON(t, "GET", srv.URL+"/api/monitor", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var body map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &body)
	if body["total"] != float64(0) {
		t.Errorf("expected total 0, got %v", body["total"])
	}

	// Summary
	resp = requestJSON(t, "GET", srv.URL+"/api/monitor/summary", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}

	// Clear
	resp = requestJSON(t, "DELETE", srv.URL+"/api/monitor", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var clearResp map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &clearResp)
	if clearResp["ok"] != true {
		t.Error("clearUsage did not return ok:true")
	}

	// Quotas — must not panic even with empty tracker (regression test for nil selector)
	resp = requestJSON(t, "GET", srv.URL+"/api/monitor/quotas", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var quotaBody map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &quotaBody)
	if quotaBody["quotas"] == nil {
		t.Error("quotas response missing 'quotas' field")
	}

	// Model keys — with provider/model from setupTestServer fixture
	resp = requestJSON(t, "GET", srv.URL+"/api/monitor/model-keys?provider=Test&model=model-a", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
}

func TestConsoleLogs_Endpoints(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	// Get
	resp := requestJSON(t, "GET", srv.URL+"/api/console-logs", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var body map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &body)
	if body["count"] != float64(0) {
		t.Errorf("expected count 0, got %v", body["count"])
	}

	// Clear
	resp = requestJSON(t, "DELETE", srv.URL+"/api/console-logs", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
}

func TestModels_List(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	resp := requestJSON(t, "GET", srv.URL+"/api/models", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var body map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &body)
	models := body["models"].([]any)
	if len(models) != 2 {
		t.Fatalf("expected 2 models (1 provider + 1 combo), got %d: %v", len(models), models)
	}
}

// TestProxyRoutes_AnthropicMessages verifies the Anthropic /v1/messages POST
// route is registered (non-404) and that GET is intentionally NOT registered
// (Anthropic has no GET semantics for this endpoint).
func TestProxyRoutes_AnthropicMessages(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	// POST must be registered (non-404). It may return 400/500 because no
	// matching provider is selected, but it must not be 404 (unmatched route).
	resp := requestJSON(t, "POST", srv.URL+"/v1/messages", `{}`)
	if resp.StatusCode == http.StatusNotFound {
		t.Fatalf("expected /v1/messages POST to be registered, got 404: %s", readBody(t, resp))
	}
	resp.Body.Close()

	// GET must NOT be registered for this endpoint (405 Method Not Allowed)
	resp = requestJSON(t, "GET", srv.URL+"/v1/messages", "")
	if resp.StatusCode == http.StatusOK {
		t.Errorf("expected /v1/messages GET to be unregistered, got 200")
	}
	resp.Body.Close()
}

// TestProxyRoutes_OPTIONSCORS verifies the CORS preflight handler answers for
// the /v1/messages path via the path-prefix `/v1/*` OPTIONS route.
func TestProxyRoutes_OPTIONSCORS(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	req, err := http.NewRequest("OPTIONS", srv.URL+"/v1/messages", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", "http://127.0.0.1:8080")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 from OPTIONS preflight, got %d", resp.StatusCode)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") == "" {
		t.Error("expected Access-Control-Allow-Origin header on /v1/messages preflight")
	}
}

func TestProvider_NotFound(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	resp := requestJSON(t, "GET", srv.URL+"/api/providers/nonexistent/keys", "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var body map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &body)
	if body["error"] == nil {
		t.Error("expected error message in response")
	}
}

func TestGetQuotas_CurrentKeyID_Name(t *testing.T) {
	srv, reg, _, rt := setupTestServer(t)
	defer srv.Close()

	// Create a provider with 2 keys that share the same name "Key-1" but different IDs
	dupProv := config.Provider{
		ID: "dup-prov", Name: "DupProv", Prefix: "dup", BaseURL: "https://dup.com",
		APIType: "openai-compatible", IsActive: true,
		Keys: []config.Key{
			{ID: "dk1", Key: "sk-d1", Name: "Key-1", Priority: 1, IsActive: true},
			{ID: "dk2", Key: "sk-d2", Name: "Key-1", Priority: 2, IsActive: true},
		},
		Models: []config.ModelDef{{ID: "model-x"}},
	}
	reg.AddProvider(dupProv)

	// Seed quota data so the bar appears in the API response
	rt.quotaTracker.Update("DupProv", "model-x", "dk1", "Key-1", 100, 80, 2)


	// Verify the quota API also populates currentKeyId
	resp := requestJSON(t, "GET", srv.URL+"/api/monitor/quotas", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var quotaBody map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &quotaBody)
	quotas := quotaBody["quotas"].([]any)
	if len(quotas) == 0 {
		t.Fatal("expected at least one quota bar")
	}
	found := false
	for _, q := range quotas {
		bar := q.(map[string]any)
		if bar["provider"] == "DupProv" && bar["model"] == "model-x" {
			found = true
			if bar["currentKeyId"] == nil || bar["currentKeyId"].(string) == "" {
				t.Error("expected non-empty currentKeyId in quota bar")
			}
			if bar["currentKeyName"] == nil || bar["currentKeyName"].(string) == "" {
				t.Error("expected non-empty currentKeyName in quota bar")
			}
		}
	}
	if !found {
		t.Error("quota bar for DupProv/model-x not found")
	}
}

func TestGetQuotas_AggregationFromKeyStates(t *testing.T) {
	srv, reg, _, rt := setupTestServer(t)
	defer srv.Close()

	// Create a provider with 2 active keys
	prov := config.Provider{
		ID: "agg-prov", Name: "AggProv", Prefix: "agg", BaseURL: "https://agg.com",
		APIType: "openai-compatible", IsActive: true,
		Keys: []config.Key{
			{ID: "ak1", Key: "sk-a1", Name: "Key-A", Priority: 1, IsActive: true},
			{ID: "ak2", Key: "sk-a2", Name: "Key-B", Priority: 2, IsActive: true},
		},
		Models: []config.ModelDef{{ID: "model-q"}},
	}
	reg.AddProvider(prov)

	// Seed QuotaTracker so the bar appears in the API response
	rt.quotaTracker.Update("AggProv", "model-q", "ak1", "Key-A", 100, 100, 2)

	// Seed per-key ModelQuotas: ak1 exhausted, ak2 partial
	reg.GetKeyState("agg-prov", "ak1").UpdateQuota("model-q", 100, 0, 0, 0)
	reg.GetKeyState("agg-prov", "ak2").UpdateQuota("model-q", 100, 80, 0, 0)

	// Fetch quotas
	resp := requestJSON(t, "GET", srv.URL+"/api/monitor/quotas", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var quotaBody map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &quotaBody)
	quotas := quotaBody["quotas"].([]any)

	found := false
	for _, q := range quotas {
		bar := q.(map[string]any)
		if bar["provider"] == "AggProv" && bar["model"] == "model-q" {
			found = true
			totalCap := int(bar["totalCapacity"].(float64))
			totalUsed := int(bar["totalUsed"].(float64))
			hasQuota := bar["hasQuota"].(bool)
			if totalCap != 200 {
				t.Errorf("expected TotalCapacity=200, got %d", totalCap)
			}
			if totalUsed != 120 {
				t.Errorf("expected TotalUsed=120 (100 exhausted + 20 used), got %d", totalUsed)
			}
			if !hasQuota {
				t.Error("expected hasQuota=true")
			}
		}
	}
	if !found {
		t.Error("quota bar for AggProv/model-q not found")
	}
}

// TestModelKeys_PerModelStatusIsolation guards against a bug where a key's
// cooldown/error for one model leaked into the displayed status/error of the
// same key under a different model (e.g. ModelScope model-a rate limited
// incorrectly showed model-b's keys as rate limited too).
func TestModelKeys_PerModelStatusIsolation(t *testing.T) {
	srv, reg, _, rt := setupTestServer(t)
	defer srv.Close()
	selector := rt.selector

	// Provider with two models sharing a single key.
	prov := &config.Provider{}
	for _, p := range reg.ListProviders() {
		if p.ID == "test-prov" {
			pp := p
			prov = &pp
		}
	}
	prov.Models = []config.ModelDef{
		{ID: "model-a"},
		{ID: "model-b"},
	}

	// Mark the key rate-limited for model-a only.
	selector.MarkRateLimited("test-prov", "k1", "model-a", 60*time.Second)

	// model-a should report cooldown + error.
	respA := requestJSON(t, "GET", srv.URL+"/api/monitor/model-keys?provider=Test&model=model-a", "")
	if respA.StatusCode != http.StatusOK {
		t.Fatalf("model-a: expected 200, got %d", respA.StatusCode)
	}
	var bodyA map[string]any
	json.Unmarshal([]byte(readBody(t, respA)), &bodyA)
	keysA := bodyA["keys"].([]any)
	if len(keysA) != 1 {
		t.Fatalf("model-a: expected 1 key, got %d", len(keysA))
	}
	keyA := keysA[0].(map[string]any)
	if keyA["status"] != "cooldown" {
		t.Errorf("model-a: expected status 'cooldown', got %v", keyA["status"])
	}
	if keyA["modelLock"] == nil {
		t.Error("model-a: expected modelLock to be set")
	}
	if keyA["lastError"] == "" {
		t.Error("model-a: expected lastError to be set")
	}

	// model-b must remain active with no leaked error.
	respB := requestJSON(t, "GET", srv.URL+"/api/monitor/model-keys?provider=Test&model=model-b", "")
	if respB.StatusCode != http.StatusOK {
		t.Fatalf("model-b: expected 200, got %d", respB.StatusCode)
	}
	var bodyB map[string]any
	json.Unmarshal([]byte(readBody(t, respB)), &bodyB)
	keysB := bodyB["keys"].([]any)
	if len(keysB) != 1 {
		t.Fatalf("model-b: expected 1 key, got %d", len(keysB))
	}
	keyB := keysB[0].(map[string]any)
	if keyB["status"] != "active" {
		t.Errorf("model-b: expected status 'active', got %v (bug: leaked from model-a)", keyB["status"])
	}
	if keyB["modelLock"] != nil {
		t.Error("model-b: expected no modelLock (bug: leaked from model-a)")
	}
	if keyB["lastError"] != "" {
		t.Errorf("model-b: expected empty lastError, got %q (bug: leaked from model-a)", keyB["lastError"])
	}
}
