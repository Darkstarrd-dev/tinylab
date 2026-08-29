package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/download"
	"github.com/tinyrouter/tinyrouter/internal/owner"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

func setupTestServer(t *testing.T) (*httptest.Server, *registry.Registry, string, *Router) {
	t.Helper()
	cfg := config.DefaultConfig()
	// Every management route is auth-gated (F-04). The test harness enables
	// password protection so the full login → session → CSRF flow applies,
	// exactly like a real protected deployment.
	key, err := config.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	enc, err := config.Encrypt(key, testAPIPassword)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Security = config.SecurityConfig{
		PasswordEnabled:   true,
		EncryptionKey:     key,
		PasswordEncrypted: enc,
	}
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
	srv := httptest.NewServer(handler)
	// The CSRF Origin check validates against the configured management port,
	// which must equal the port the test server actually listens on.
	alignServerPort(t, reg, srv)
	return srv, reg, tmpFile, apiRouter
}

// alignServerPort sets the registry config port to the test server's real
// port so the AuthMiddleware Origin check accepts the test origin.
func alignServerPort(t *testing.T, reg *registry.Registry, srv *httptest.Server) {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	cfg := reg.Config()
	cfg.Port = port
	reg.Reload(&cfg)
}

// testAPIPassword is the password the setupTestServer harness configures.
const testAPIPassword = "test-password"

// testSession carries an authenticated HTTP client (session cookie jar) and
// the session-bound CSRF token for one test server.
type testSession struct {
	client *http.Client
	csrf   string
}

var (
	testSessionMu sync.Mutex
	testSessions  = make(map[string]*testSession)
)

// sessionFor lazily authenticates once per test server URL: POST
// /api/auth/login with the harness password, capture the session cookie jar
// and the session-bound CSRF token, and reuse them for every subsequent
// requestJSON call in this process. Tests never see auth plumbing.
func sessionFor(t *testing.T, serverURL string) *testSession {
	t.Helper()
	testSessionMu.Lock()
	defer testSessionMu.Unlock()
	if s, ok := testSessions[serverURL]; ok {
		return s
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	req, err := http.NewRequest("POST", serverURL+"/api/auth/login", strings.NewReader(`{"password":"`+testAPIPassword+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", serverURL)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(resp.Body)
		t.Fatalf("test login failed: %d %s", resp.StatusCode, data)
	}
	var login struct {
		Success   bool   `json:"success"`
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&login); err != nil {
		t.Fatal(err)
	}
	if !login.Success || login.CSRFToken == "" {
		t.Fatalf("test login response missing success/csrfToken: %+v", login)
	}
	s := &testSession{client: client, csrf: login.CSRFToken}
	testSessions[serverURL] = s
	return s
}

// serverURLOf reduces a full request URL to its scheme://host origin.
func serverURLOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	return u.Scheme + "://" + u.Host
}

func requestJSON(t *testing.T, method, url, body string) *http.Response {
	t.Helper()
	s := sessionFor(t, serverURLOf(url))
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
	switch method {
	case "POST", "PUT", "PATCH", "DELETE":
		req.Header.Set("X-CSRF-Token", s.csrf)
		req.Header.Set("Origin", serverURLOf(url))
	}
	resp, err := s.client.Do(req)
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
	// The harness aligns the registry port with the actual test server port
	// (the CSRF Origin check validates against it), so assert dynamically.
	u, _ := url.Parse(srv.URL)
	wantPort, _ := strconv.Atoi(u.Port())
	if body["port"] != float64(wantPort) {
		t.Errorf("expected port %d, got %v", wantPort, body["port"])
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

func TestUsage_QuotasIncludeInflightModel(t *testing.T) {
	srv, _, _, rt := setupTestServer(t)
	defer srv.Close()

	rt.deps.proxyHandler.EntryTracker.Register(usage.Entry{
		ID:       "inflight-1",
		Provider: "Test",
		Model:    "model-a",
		Status:   "processing",
	})

	resp := requestJSON(t, "GET", srv.URL+"/api/monitor/quotas", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var body struct {
		Quotas []struct {
			Provider string `json:"provider"`
			Model    string `json:"model"`
		} `json:"quotas"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		resp.Body.Close()
		t.Fatal(err)
	}
	if len(body.Quotas) != 1 || body.Quotas[0].Provider != "Test" || body.Quotas[0].Model != "model-a" {
		t.Fatalf("expected provisional quota bar for Test/model-a, got %+v", body.Quotas)
	}
}

func TestGetUsageEntry(t *testing.T) {
	srv, _, _, rt := setupTestServer(t)
	defer srv.Close()

	headers := make(http.Header)
	headers.Set("X-Custom", "val")

	// 1. Entry in main usage ring
	rt.deps.usage.Add(usage.Entry{
		ID:          "usage-entry-1",
		Provider:    "Test",
		Model:       "model-a",
		Status:      "success",
		LatencyMs:   120,
		ReqPayload:  json.RawMessage(`{"prompt":"main ring"}`),
		RespPayload: json.RawMessage(`{"reply":"ok"}`),
		ReqHeaders:  headers,
		RespHeaders: headers,
	})

	// 2. Entry in playground ring
	rt.deps.pgUsage.Add(usage.Entry{
		ID:          "pg-entry-1",
		Provider:    "Test",
		Model:       "model-a",
		Status:      "success",
		Source:      "playground",
		ReqPayload:  json.RawMessage(`{"prompt":"pg ring"}`),
		RespPayload: json.RawMessage(`{"reply":"pg ok"}`),
	})

	// 3. Entry in in-flight tracker
	rt.deps.proxyHandler.EntryTracker.Register(usage.Entry{
		ID:         "inflight-entry-1",
		Provider:   "Test",
		Model:      "model-a",
		Status:     "processing",
		ReqPayload: json.RawMessage(`{"prompt":"in flight"}`),
	})

	// Test GET /api/monitor/entry/usage-entry-1
	resp := requestJSON(t, "GET", srv.URL+"/api/monitor/entry/usage-entry-1", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var entry1 usage.Entry
	if err := json.NewDecoder(resp.Body).Decode(&entry1); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if entry1.ID != "usage-entry-1" || string(entry1.ReqPayload) != `{"prompt":"main ring"}` || string(entry1.RespPayload) != `{"reply":"ok"}` {
		t.Fatalf("unexpected entry1 content: %+v", entry1)
	}

	// Test GET /api/monitor/entry/pg-entry-1
	resp = requestJSON(t, "GET", srv.URL+"/api/monitor/entry/pg-entry-1", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var entryPg usage.Entry
	if err := json.NewDecoder(resp.Body).Decode(&entryPg); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if entryPg.ID != "pg-entry-1" || string(entryPg.ReqPayload) != `{"prompt":"pg ring"}` {
		t.Fatalf("unexpected entryPg content: %+v", entryPg)
	}

	// Test GET /api/monitor/entry/inflight-entry-1
	resp = requestJSON(t, "GET", srv.URL+"/api/monitor/entry/inflight-entry-1", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var entryInf usage.Entry
	if err := json.NewDecoder(resp.Body).Decode(&entryInf); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if entryInf.ID != "inflight-entry-1" || string(entryInf.ReqPayload) != `{"prompt":"in flight"}` {
		t.Fatalf("unexpected entryInf content: %+v", entryInf)
	}

	// Test GET /api/monitor/entry/non-existent (404)
	resp = requestJSON(t, "GET", srv.URL+"/api/monitor/entry/non-existent", "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for non-existent entry, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Test GET /api/monitor list strips heavy payload fields
	resp = requestJSON(t, "GET", srv.URL+"/api/monitor?limit=10", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var listBody struct {
		Total   int              `json:"total"`
		Entries []map[string]any `json:"entries"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&listBody); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(listBody.Entries) == 0 {
		t.Fatal("expected entries in monitor list")
	}
	for _, e := range listBody.Entries {
		if _, ok := e["reqPayload"]; ok {
			t.Errorf("expected reqPayload to be stripped from list response for entry %v", e["id"])
		}
		if _, ok := e["respPayload"]; ok {
			t.Errorf("expected respPayload to be stripped from list response for entry %v", e["id"])
		}
		if _, ok := e["reqHeaders"]; ok {
			t.Errorf("expected reqHeaders to be stripped from list response for entry %v", e["id"])
		}
		if _, ok := e["respHeaders"]; ok {
			t.Errorf("expected respHeaders to be stripped from list response for entry %v", e["id"])
		}
	}

	// Test GET /api/monitor/playground list strips heavy payload fields
	resp = requestJSON(t, "GET", srv.URL+"/api/monitor/playground?limit=10", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var pgListBody struct {
		Total   int              `json:"total"`
		Entries []map[string]any `json:"entries"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&pgListBody); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(pgListBody.Entries) == 0 {
		t.Fatal("expected entries in playground monitor list")
	}
	for _, e := range pgListBody.Entries {
		if _, ok := e["reqPayload"]; ok {
			t.Errorf("expected reqPayload to be stripped from pg list response for entry %v", e["id"])
		}
		if _, ok := e["respPayload"]; ok {
			t.Errorf("expected respPayload to be stripped from pg list response for entry %v", e["id"])
		}
	}
}

func TestConsoleLogs_Endpoints(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()
	// Router setup may log (e.g. games seed), so count may be >=0.
	// The test asserts the endpoint is reachable, not that setup logged nothing.

	// Get
	resp := requestJSON(t, "GET", srv.URL+"/api/console-logs", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var body map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &body)
	// count is the current logger line count; any non-negative value is valid.
	if _, ok := body["count"]; !ok {
		t.Errorf("expected count field, got %v", body)
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

// TestFileTransferRoutes_Upload verifies POST /api/filetransfer/upload is
// registered. An invalid multipart body exercises the handler without creating
// an archive or contacting any temporary file service; an unregistered route
// would return 404 before reaching validation.
func TestFileTransferRoutes_Upload(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	resp := requestJSON(t, "POST", srv.URL+"/api/filetransfer/upload", "{}")
	if resp.StatusCode == http.StatusNotFound {
		t.Fatalf("expected /api/filetransfer/upload to be registered, got 404: %s", readBody(t, resp))
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected invalid upload body to return 400, got %d: %s", resp.StatusCode, readBody(t, resp))
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

// TestModelKeys_ManualPinAndPerKeyTokens covers the monitor multi-key
// interactions: per-key input/output token fields, the manual active-key pin
// endpoint, and pin-aware inUseKeyID/currentKeyId reporting.
func TestModelKeys_ManualPinAndPerKeyTokens(t *testing.T) {
	srv, reg, _, rt := setupTestServer(t)
	defer srv.Close()

	prov := config.Provider{
		ID: "pin-prov", Name: "PinProv", Prefix: "pin", BaseURL: "https://pin.com",
		APIType: "openai-compatible", IsActive: true,
		Keys: []config.Key{
			{ID: "pk1", Key: "sk-p1", Name: "Key-1", Priority: 1, IsActive: true},
			{ID: "pk2", Key: "sk-p2", Name: "Key-2", Priority: 2, IsActive: true},
		},
		Models: []config.ModelDef{{ID: "model-p"}},
	}
	reg.AddProvider(prov)

	// Seed per-key usage so the token/count fields are populated.
	rt.usage.Add(usage.Entry{
		Provider: "PinProv", Model: "model-p", KeyID: "pk2", KeyName: "Key-2",
		Status: "success", LatencyMs: 1000, TTFTMs: 120, InputTokens: 42, OutputTokens: 128,
	})

	getKeys := func() map[string]any {
		resp := requestJSON(t, "GET", srv.URL+"/api/monitor/model-keys?provider=PinProv&model=model-p", "")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
		}
		var body map[string]any
		json.Unmarshal([]byte(readBody(t, resp)), &body)
		return body
	}

	// Baseline: fill-first picks the priority-1 key; pk2 carries the seeded stats.
	body := getKeys()
	if body["providerId"] != "pin-prov" {
		t.Errorf("expected providerId pin-prov, got %v", body["providerId"])
	}
	if body["inUseKeyID"] != "pk1" {
		t.Errorf("expected baseline inUseKeyID pk1, got %v", body["inUseKeyID"])
	}
	for _, k := range body["keys"].([]any) {
		kd := k.(map[string]any)
		if kd["keyId"] == "pk2" {
			if int(kd["inputTokens"].(float64)) != 42 {
				t.Errorf("expected pk2 inputTokens 42, got %v", kd["inputTokens"])
			}
			if int(kd["outputTokens"].(float64)) != 128 {
				t.Errorf("expected pk2 outputTokens 128, got %v", kd["outputTokens"])
			}
			if int(kd["successCount"].(float64)) != 1 {
				t.Errorf("expected pk2 successCount 1, got %v", kd["successCount"])
			}
		}
	}

	// Unknown provider/key are rejected.
	if resp := requestJSON(t, "POST", srv.URL+"/api/providers/nope/keys/pk1/activate", ""); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown provider, got %d", resp.StatusCode)
	}
	if resp := requestJSON(t, "POST", srv.URL+"/api/providers/pin-prov/keys/nope/activate", ""); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown key, got %d", resp.StatusCode)
	}

	// Pin pk2; both the monitor view and SelectKey must honor it.
	resp := requestJSON(t, "POST", srv.URL+"/api/providers/pin-prov/keys/pk2/activate", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	if body = getKeys(); body["inUseKeyID"] != "pk2" {
		t.Errorf("expected pinned inUseKeyID pk2, got %v", body["inUseKeyID"])
	}
	sel, err := rt.selector.SelectKey("pin-prov", "model-p", nil)
	if err != nil {
		t.Fatalf("SelectKey failed: %v", err)
	}
	if sel.Key.ID != "pk2" {
		t.Errorf("expected SelectKey to honor pin pk2, got %s", sel.Key.ID)
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

// TestNoPassword_AllowsManagementRoutes verifies that PasswordEnabled=false
// keeps the optional password protection disabled: management routes remain
// usable, status does not advertise setup-required, and secret-minimized DTOs
// still do not expose plaintext provider keys.
func TestNoPassword_AllowsManagementRoutes(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Providers = []config.Provider{
		{
			ID: "seed-prov", Name: "Seed", Prefix: "seed", BaseURL: "https://seed.example.com",
			APIType: "openai-compatible", IsActive: true,
			Keys: []config.Key{{ID: "sk1", Key: "sk-secret-value", Name: "Main", Priority: 1, IsActive: true}},
		},
	}
	reg := registry.New(cfg)
	logger := console.New(100)
	usageBuf := usage.New(100)
	selector := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	proxyHandler := proxy.New(reg, selector, comboRes, usageBuf, usage.NewQuotaTracker(), logger, 0)
	tmpFile := filepath.Join(t.TempDir(), "config.yaml")
	apiRouter := New(reg, cfg, tmpFile, usageBuf, usage.New(50), usage.NewQuotaTracker(), logger, proxyHandler, context.CancelFunc(func() {}), selector, comboRes, download.NewManager(download.RuntimeSettings{}, logger))
	srv := httptest.NewServer(apiRouter.Routes(proxyHandler))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/auth/status")
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, resp)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"setupRequired":false`) || !strings.Contains(body, `"authenticated":true`) {
		t.Fatalf("expected optional no-password status, got %d %s", resp.StatusCode, body)
	}

	resp, err = http.Get(srv.URL + "/api/providers")
	if err != nil {
		t.Fatal(err)
	}
	body = readBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("management route should be accessible without password, got %d %s", resp.StatusCode, body)
	}
	if strings.Contains(body, "sk-secret-value") {
		t.Fatal("provider response leaked plaintext key")
	}

	resp, err = http.Get(srv.URL + "/api/settings")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("settings route should be accessible without password, got %d", resp.StatusCode)
	}
	readBody(t, resp)
}

// TestDisablePassword_RemainsOpenForNavigation verifies the user-visible
// regression: after disabling protection, a subsequent status/settings page
// request remains accessible and never returns setup-required.
func TestDisablePassword_RemainsOpenForNavigation(t *testing.T) {
	srv, reg, _, _ := setupTestServer(t)
	defer srv.Close()

	resp := requestJSON(t, http.MethodPatch, srv.URL+"/api/settings", `{"security":{"passwordEnabled":false}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("disable password: expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	readBody(t, resp)

	if cfg := reg.Config(); cfg.Security.PasswordEnabled || cfg.Security.PasswordEncrypted != "" || cfg.Security.EncryptionKey != "" {
		t.Fatalf("password protection was not fully disabled: %+v", cfg.Security)
	}

	s := sessionFor(t, srv.URL)
	resp, err := s.client.Get(srv.URL + "/api/auth/status")
	if err != nil {
		t.Fatal(err)
	}
	statusBody := readBody(t, resp)
	if resp.StatusCode != http.StatusOK || !strings.Contains(statusBody, `"setupRequired":false`) || !strings.Contains(statusBody, `"authenticated":true`) {
		t.Fatalf("post-disable auth status = %d %s", resp.StatusCode, statusBody)
	}

	resp, err = s.client.Get(srv.URL + "/api/providers")
	if err != nil {
		t.Fatal(err)
	}
	if body := readBody(t, resp); resp.StatusCode != http.StatusOK {
		t.Fatalf("post-disable page navigation was blocked: %d %s", resp.StatusCode, body)
	}
}

// TestSecretMinimizedDTOs verifies F-04/A-2: provider and key API responses
// never contain the plaintext key value; key material is replaced by an
// irreversible maskedKey and keyCount/hasKey.
func TestSecretMinimizedDTOs(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	// Provider list: no plaintext, no embedded keys, but keyCount/hasKey set.
	resp := requestJSON(t, "GET", srv.URL+"/api/providers", "")
	listBody := readBody(t, resp)
	if strings.Contains(listBody, "sk-test") {
		t.Fatal("provider list leaked plaintext key")
	}
	var list struct {
		Providers []struct {
			ID       string `json:"id"`
			KeyCount int    `json:"keyCount"`
			HasKey   bool   `json:"hasKey"`
			Keys     []any  `json:"keys"`
		} `json:"providers"`
	}
	if err := json.Unmarshal([]byte(listBody), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Providers) != 1 || !list.Providers[0].HasKey || list.Providers[0].KeyCount != 1 {
		t.Fatalf("expected keyCount/hasKey on provider DTO, got %+v", list.Providers)
	}
	if list.Providers[0].Keys != nil {
		t.Fatal("provider DTO must not embed the keys array")
	}

	// Key list: returns Key and MaskedKey
	resp = requestJSON(t, "GET", srv.URL+"/api/providers/test-prov/keys", "")
	keysBody := readBody(t, resp)
	var keys struct {
		Keys []struct {
			ID        string `json:"id"`
			MaskedKey string `json:"maskedKey"`
			Key       string `json:"key"`
		} `json:"keys"`
	}
	if err := json.Unmarshal([]byte(keysBody), &keys); err != nil {
		t.Fatal(err)
	}
	if len(keys.Keys) != 1 || keys.Keys[0].MaskedKey == "" || keys.Keys[0].Key != "sk-test" {
		t.Fatalf("expected key DTO with key and maskedKey, got %+v", keys.Keys)
	}

	// Create-key response returns KeyDTO with key and maskedKey
	resp = requestJSON(t, "POST", srv.URL+"/api/providers/test-prov/keys", `{"key":"sk-secret-new-1234","name":"New"}`)
	createBody := readBody(t, resp)
	if !strings.Contains(createBody, "sk-secret-new-1234") {
		t.Fatal("create-key response missing plaintext key")
	}
	if !strings.Contains(createBody, `"maskedKey":"sk-s****1234"`) {
		t.Fatalf("expected maskedKey sk-s****1234 in create-key response, got %s", createBody)
	}

	// Create-provider response must not embed keys either.
	resp = requestJSON(t, "POST", srv.URL+"/api/providers", `{"id":"p2","name":"P2","prefix":"p2","baseUrl":"https://p2.com","keys":[{"key":"sk-embedded"}]}`)
	provBody := readBody(t, resp)
	if strings.Contains(provBody, "sk-embedded") {
		t.Fatal("create-provider response leaked key material")
	}
}

// TestSettings_AnySearchHasApiKeyOnly verifies the AnySearch API key is never
// returned by GET /api/settings — only a hasApiKey boolean.
func TestSettings_AnySearchHasApiKeyOnly(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	resp := requestJSON(t, "PATCH", srv.URL+"/api/settings", `{"anySearch":{"apiKey":"as-secret-key","maxResults":7}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("settings PATCH failed: %d %s", resp.StatusCode, readBody(t, resp))
	}
	resp = requestJSON(t, "GET", srv.URL+"/api/settings", "")
	body := readBody(t, resp)
	if strings.Contains(body, "as-secret-key") {
		t.Fatal("GET /api/settings leaked the AnySearch API key")
	}
	var settings struct {
		AnySearch struct {
			HasApiKey  bool   `json:"hasApiKey"`
			APIKey     string `json:"apiKey"`
			MaxResults int    `json:"maxResults"`
		} `json:"anySearch"`
	}
	if err := json.Unmarshal([]byte(body), &settings); err != nil {
		t.Fatal(err)
	}
	if !settings.AnySearch.HasApiKey || settings.AnySearch.APIKey != "" || settings.AnySearch.MaxResults != 7 {
		t.Fatalf("expected hasApiKey-only anySearch DTO, got %+v", settings.AnySearch)
	}
}

// TestCSRF_BlocksSimplePOST verifies F-05 end-to-end: a same-origin request
// carrying the session cookie but no CSRF token cannot mutate settings.
func TestCSRF_BlocksSimplePOST(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	// Login with a plain client to obtain only the cookie (no CSRF token).
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	loginResp, err := client.Post(srv.URL+"/api/auth/login", "application/json", strings.NewReader(`{"password":"`+testAPIPassword+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	loginResp.Body.Close()

	// Cookie-bearing PATCH without X-CSRF-Token must be rejected with 403.
	req, err := http.NewRequest("PATCH", srv.URL+"/api/settings", strings.NewReader(`{"port":12345}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", srv.URL)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, resp)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for cookie-only POST, got %d (%s)", resp.StatusCode, body)
	}

	// External-origin PATCH with the (stolen) cookie is also rejected.
	req, err = http.NewRequest("PATCH", srv.URL+"/api/settings", strings.NewReader(`{"port":12345}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://evil.example.com")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body = readBody(t, resp)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for external Origin, got %d (%s)", resp.StatusCode, body)
	}
}

// TestGallery_OwnerCookieIssuedOnce pins the F-29 wiring contract: the owner
// middleware has exactly one mount point on the gallery boundary (inside the
// gallery handler's Register, like archive/editor/filetransfer — NOT also on
// the /api/gallery route group). A gallery request with no owner cookie must
// receive exactly one tinyrouter_owner Set-Cookie. Regression: the middleware
// was mounted twice (route group + Register), emitting two Set-Cookie headers
// with different owner values so the browser's stored owner drifted from the
// owner stamped on the request context (session owner mismatch).
func TestGallery_OwnerCookieIssuedOnce(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()
	s := sessionFor(t, srv.URL)

	// Valid session, no owner cookie yet. The handler 404s (no such zip
	// session), but the owner middleware must have stamped exactly one
	// owner cookie before the handler ran.
	resp, err := s.client.Get(srv.URL + "/api/gallery/zip/not-a-session/a.png")
	if err != nil {
		t.Fatalf("gallery request: %v", err)
	}
	defer resp.Body.Close()

	setCookies := resp.Header.Values("Set-Cookie")
	var ownerCookies int
	for _, sc := range setCookies {
		if strings.HasPrefix(sc, owner.CookieName+"=") {
			ownerCookies++
		}
	}
	if len(setCookies) != 1 || ownerCookies != 1 {
		t.Fatalf("want exactly 1 %s Set-Cookie, got %d header(s), %d owner cookie(s): %q",
			owner.CookieName, len(setCookies), ownerCookies, setCookies)
	}
	for _, c := range resp.Cookies() {
		if c.Name == owner.CookieName && !owner.Valid(c.Value) {
			t.Fatalf("issued owner cookie %q is not a valid owner value", c.Value)
		}
	}
}

func TestProviderHardLimit_APIRoundTrip(t *testing.T) {
	srv, _, _, _ := setupTestServer(t)
	defer srv.Close()

	// 1. PUT with hardLimit enabled
	payload := `{"name":"Test","prefix":"test","baseUrl":"https://api.test.com","isActive":true,"hardLimit":{"rpmEnabled":true,"rpm":5,"tpmEnabled":true,"tpm":10000}}`
	resp := requestJSON(t, "PUT", srv.URL+"/api/providers/test-prov", payload)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var updated map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &updated)
	hl, ok := updated["hardLimit"].(map[string]any)
	if !ok || hl == nil {
		t.Fatalf("expected hardLimit object in response, got %+v", updated)
	}
	if hl["rpmEnabled"] != true || int(hl["rpm"].(float64)) != 5 {
		t.Errorf("unexpected rpm settings: %+v", hl)
	}
	if hl["tpmEnabled"] != true || int(hl["tpm"].(float64)) != 10000 {
		t.Errorf("unexpected tpm settings: %+v", hl)
	}

	// 2. GET list check
	resp = requestJSON(t, "GET", srv.URL+"/api/providers", "")
	var listResp map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &listResp)
	providers := listResp["providers"].([]any)
	found := false
	for _, p := range providers {
		pm := p.(map[string]any)
		if pm["id"] == "test-prov" {
			found = true
			if pm["hardLimit"] == nil {
				t.Fatalf("expected hardLimit in listed provider, got nil")
			}
		}
	}
	if !found {
		t.Fatal("test-prov not found in list")
	}

	// 3. PUT with hardLimit cleared (null)
	payloadNoHL := `{"name":"Test","prefix":"test","baseUrl":"https://api.test.com","isActive":true,"hardLimit":null}`
	resp = requestJSON(t, "PUT", srv.URL+"/api/providers/test-prov", payloadNoHL)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on clearing hardLimit, got %d", resp.StatusCode)
	}
	var cleared map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &cleared)
	if cleared["hardLimit"] != nil {
		t.Errorf("expected nil hardLimit after clearing, got %+v", cleared["hardLimit"])
	}
}

