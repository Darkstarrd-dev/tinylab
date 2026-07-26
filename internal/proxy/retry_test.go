package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
)

func newSelectedKey() *rotation.SelectedKey {
	return &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL: "http://localhost:9999", IsActive: true,
			Keys: []config.Key{
				{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
			},
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}
}

func TestHandle429_DailyQuota(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	// Body contains the model name (case-insensitive), triggering IsDailyQuota429
	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Body:       io.NopCloser(strings.NewReader(`{"error":"daily quota exceeded for gpt-4"}`)),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 5}
	h.handle429(resp, sel, "test", "gpt-4", time.Now(), state, &http.Request{}, "test-id", nil, "", "", "")

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}

	keyState.Lock()
	status := keyState.ModelStatus["gpt-4"]
	keyState.Unlock()
	if status != "locked" {
		t.Fatalf("expected status 'locked' for daily quota, got %s", status)
	}

	if len(state.excludeKeyIDs) == 0 {
		t.Fatal("expected key to be excluded after daily quota lock")
	}
	if state.excludeKeyIDs[0] != "key1" {
		t.Fatalf("expected excluded key 'key1', got %s", state.excludeKeyIDs[0])
	}
}

func TestHandle429_RateLimited(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	// Body matches ActionCooldown rule: "request not allowed" -> CooldownSec 5
	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Body:       io.NopCloser(strings.NewReader(`{"error":"request not allowed"}`)),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 5}
	h.handle429(resp, sel, "test", "gpt-4", time.Now(), state, &http.Request{}, "test-id", nil, "", "", "")

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}

	keyState.Lock()
	status := keyState.ModelStatus["gpt-4"]
	hasLock := false
	if lock, ok := keyState.ModelLocks["gpt-4"]; ok && !lock.IsZero() {
		hasLock = true
	}
	backoffLevel := keyState.BackoffLevel
	keyState.Unlock()

	// The error should be classified as ActionCooldown, so MarkRateLimited is called
	// which sets status to "cooldown"
	if status != "cooldown" {
		t.Fatalf("expected status 'cooldown', got %s", status)
	}
	if !hasLock {
		t.Fatal("expected ModelLock on gpt-4 after rate limit cooldown")
	}
	// BackoffLevel should NOT be incremented by MarkRateLimited (only
	// MarkUnavailable increments it)
	if backoffLevel != 0 {
		t.Fatalf("expected BackoffLevel 0 for MarkRateLimited, got %d", backoffLevel)
	}

	if len(state.excludeKeyIDs) == 0 {
		t.Fatal("expected key to be excluded after rate limit")
	}
}

func TestHandle429_Transient(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	// Body that doesn't match any text rule and status 500 -> ActionTransient
	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Body:       io.NopCloser(strings.NewReader(`{"error":"unknown error"}`)),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 0}
	h.handle429(resp, sel, "test", "gpt-4", time.Now(), state, &http.Request{}, "test-id", nil, "", "", "")

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}

	keyState.Lock()
	status := keyState.ModelStatus["gpt-4"]
	hasLock := false
	if lock, ok := keyState.ModelLocks["gpt-4"]; ok && !lock.IsZero() {
		hasLock = true
	}
	keyState.Unlock()

	if status != "cooldown" {
		t.Fatalf("expected status 'cooldown' for transient, got %s", status)
	}
	if !hasLock {
		t.Fatal("expected ModelLock after transient rate limit")
	}
}

func TestHandleUpstreamError_401(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	resp := &http.Response{
		StatusCode: http.StatusUnauthorized,
		Body:       io.NopCloser(strings.NewReader(`{"error":"unauthorized"}`)),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 5}
	h.handleUpstreamError(httptest.NewRecorder(), resp, sel, "test", "gpt-4", state, nil, "test-id", nil, "", time.Now(), "", "")

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}

	keyState.Lock()
	status := keyState.ModelStatus["gpt-4"]
	hasLock := false
	if lock, ok := keyState.ModelLocks["gpt-4"]; ok && !lock.IsZero() {
		hasLock = true
	}
	backoffLevel := keyState.BackoffLevel
	keyState.Unlock()

	if status != "cooldown" {
		t.Fatalf("expected status 'cooldown' for 401, got %s", status)
	}
	if !hasLock {
		t.Fatal("expected ModelLock after 401 cooldown")
	}
	if backoffLevel != 0 {
		t.Fatalf("expected BackoffLevel 0 for ActionCooldown, got %d", backoffLevel)
	}
	if len(state.excludeKeyIDs) == 0 || state.excludeKeyIDs[0] != "key1" {
		t.Fatal("expected key1 in excludeKeyIDs after upstream error")
	}
}

func TestHandleUpstreamError_500(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	resp := &http.Response{
		StatusCode: http.StatusInternalServerError,
		Body:       io.NopCloser(strings.NewReader(`{"error":"internal error"}`)),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 5}
	h.handleUpstreamError(httptest.NewRecorder(), resp, sel, "test", "gpt-4", state, nil, "test-id", nil, "", time.Now(), "", "")

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}

	keyState.Lock()
	status := keyState.ModelStatus["gpt-4"]
	hasLock := false
	if lock, ok := keyState.ModelLocks["gpt-4"]; ok && !lock.IsZero() {
		hasLock = true
	}
	keyState.Unlock()

	// 500 without matching body -> ActionTransient -> MarkRateLimited with DefaultTransientCooldownSec
	if status != "cooldown" {
		t.Fatalf("expected status 'cooldown' for 500, got %s", status)
	}
	if !hasLock {
		t.Fatal("expected ModelLock after 500 transient cooldown")
	}

	if len(state.excludeKeyIDs) == 0 || state.excludeKeyIDs[0] != "key1" {
		t.Fatal("expected key1 in excludeKeyIDs")
	}
}

func TestHandleUpstreamError_403(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	resp := &http.Response{
		StatusCode: http.StatusForbidden,
		Body:       io.NopCloser(strings.NewReader(`{"error":"forbidden"}`)),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 5}

	// The handleUpstreamError should not panic
	h.handleUpstreamError(httptest.NewRecorder(), resp, sel, "test", "gpt-4", state, nil, "test-id", nil, "", time.Now(), "", "")

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}

	keyState.Lock()
	status := keyState.ModelStatus["gpt-4"]
	hasLock := false
	if lock, ok := keyState.ModelLocks["gpt-4"]; ok && !lock.IsZero() {
		hasLock = true
	}
	keyState.Unlock()

	if status != "cooldown" {
		t.Fatalf("expected status 'cooldown' for 403, got %s", status)
	}
	if !hasLock {
		t.Fatal("expected ModelLock after 403 cooldown")
	}
}

func TestHandleNetworkError(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	state := &retryState{maxRetries: 5}
	h.handleNetworkError(sel, "test", "gpt-4", io.ErrUnexpectedEOF, state, "test-id", nil, nil, "", "", "")

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}

	keyState.Lock()
	backoffLevel := keyState.BackoffLevel
	status := keyState.ModelStatus["gpt-4"]
	lastError := keyState.ModelErrors["gpt-4"]
	keyState.Unlock()

	if backoffLevel != 1 {
		t.Fatalf("expected BackoffLevel 1 after network error, got %d", backoffLevel)
	}
	if status != "cooldown" {
		t.Fatalf("expected status 'cooldown', got %s", status)
	}
	if !strings.Contains(lastError, "unexpected EOF") {
		t.Fatalf("expected LastError to contain error message, got %s", lastError)
	}
	if len(state.excludeKeyIDs) == 0 || state.excludeKeyIDs[0] != "key1" {
		t.Fatal("expected key1 in excludeKeyIDs after network error")
	}
}

func TestLogRequest_FirstCall(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()
	state := &retryState{maxRetries: 5}

	h.logRequest(sel, "", "", "gpt-4", "", 3, state, "test-id", "", "")

	if !state.requestLogged {
		t.Fatal("expected requestLogged to be true after logRequest")
	}
}

func TestBackoffSequence(t *testing.T) {
	tests := []struct {
		n    int
		want int
	}{
		{0, 0},
		{1, 1},
		{2, 2},
		{3, 4},
		{4, 8},
		{5, 10},
		{6, 15},
		{10, 15},
	}
	for _, tt := range tests {
		got := rotation.BackoffSequence(tt.n)
		if got != tt.want {
			t.Errorf("BackoffSequence(%d) = %d, want %d", tt.n, got, tt.want)
		}
	}
}

func TestClassifySenseNova429_Unknown(t *testing.T) {
	if got := classifySenseNova429("some random error"); got != sn429Unknown {
		t.Fatalf("expected sn429Unknown, got %d", got)
	}
}

func TestClassifySenseNova429_RPM(t *testing.T) {
	if got := classifySenseNova429(`{"message":"rpm exhausted"}`); got != sn429RPM {
		t.Fatalf("expected sn429RPM, got %d", got)
	}
}

func TestClassifySenseNova429_TPM(t *testing.T) {
	if got := classifySenseNova429(`{"message":"rate limit exceeded on dimension: tpm"}`); got != sn429TPM {
		t.Fatalf("expected sn429TPM, got %d", got)
	}
}

func TestClassifySenseNova429_TPM_ShortBody(t *testing.T) {
	if got := classifySenseNova429("tpm"); got != sn429TPM {
		t.Fatalf("expected sn429TPM for 'tpm', got %d", got)
	}
}

func TestExcludeSameAccountKeys_EmptyAccount(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()
	sel.Key.Account = ""
	state := &retryState{maxRetries: 5}

	h.excludeSameAccountKeys(sel, state)

	if len(state.excludeKeyIDs) != 1 {
		t.Fatalf("expected exactly 1 excluded key (no account), got %d", len(state.excludeKeyIDs))
	}
}

func TestExcludeSameAccountKeys_WithAccount(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()
	sel.Key.Account = "acct-1"
	sel.Provider = config.Provider{
		ID: "test", Name: "Test", Prefix: "test",
		BaseURL: "http://localhost:9999", IsActive: true,
		Keys: []config.Key{
			{ID: "key1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1, Account: "acct-1"},
			{ID: "key2", Key: "sk-2", Name: "K2", IsActive: true, Priority: 2, Account: "acct-1"},
			{ID: "key3", Key: "sk-3", Name: "K3", IsActive: true, Priority: 3, Account: "acct-2"},
		},
	}
	sel.Key = config.Key{ID: "key1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1, Account: "acct-1"}

	state := &retryState{maxRetries: 5}
	h.excludeSameAccountKeys(sel, state)

	if len(state.excludeKeyIDs) != 2 {
		t.Fatalf("expected 2 excluded keys (key1 + key2 same account), got %d: %v", len(state.excludeKeyIDs), state.excludeKeyIDs)
	}
	foundKey1, foundKey2 := false, false
	for _, id := range state.excludeKeyIDs {
		if id == "key1" {
			foundKey1 = true
		}
		if id == "key2" {
			foundKey2 = true
		}
	}
	if !foundKey1 || !foundKey2 {
		t.Fatal("expected key1 and key2 (same account) to be excluded")
	}
}

func TestHandle429_NIMCooldown(t *testing.T) {
	provider := config.Provider{
		ID: "test", Name: "Test", Prefix: "test",
		BaseURL: "https://api.nvidia.com/v1", IsActive: true,
		APIType: "nim",
		Keys: []config.Key{
			{ID: "key1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1},
		},
	}
	cfg := config.RotationConfig{Strategy: "fill-first", MaxRetries: 2, BackoffMaxSec: 300}
	h := newTestHandlerWithCustomProvider(t, provider, cfg)
	sel := &rotation.SelectedKey{
		Provider: provider,
		Key:      provider.Keys[0],
		KeyName:  "K1",
	}

	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Body:       io.NopCloser(strings.NewReader(`{"error":"rate limited"}`)),
		Header:     http.Header{},
	}

	before := time.Now()
	state := &retryState{maxRetries: 2}
	h.handle429(resp, sel, "test", "gpt-4", before, state, &http.Request{}, "test-id", nil, "", "", "")

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}

	keyState.Lock()
	hasLock := false
	if lock, ok := keyState.ModelLocks["gpt-4"]; ok && !lock.IsZero() {
		hasLock = true
	}
	nimLevel := keyState.NIMCooldownLevel
	keyState.Unlock()

	if !hasLock {
		t.Fatal("expected ModelLock after NIM 429 cooldown")
	}
	if nimLevel != 1 {
		t.Fatalf("expected NIMCooldownLevel 1, got %d", nimLevel)
	}
	if len(state.excludeKeyIDs) == 0 || state.excludeKeyIDs[0] != "key1" {
		t.Fatal("expected key1 in excludeKeyIDs after NIM 429")
	}
}

func TestHandle429_DailyQuotaViaBodyText(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	// Body contains the model name "gpt-4" �?IsDailyQuota429 returns true
	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Body:       io.NopCloser(strings.NewReader(`{"error":"gpt-4 quota exceeded"}`)),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 5}
	h.handle429(resp, sel, "test", "gpt-4", time.Now(), state, &http.Request{}, "test-id", nil, "", "", "")

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}

	keyState.Lock()
	status := keyState.ModelStatus["gpt-4"]
	keyState.Unlock()

	if status != "locked" {
		t.Fatalf("expected status 'locked' for daily quota via body text, got %s", status)
	}
}

func TestHandle429_WithExistingKeyExclusion(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	// Start with one key already excluded
	state := &retryState{maxRetries: 0}
	state.excludeKeyIDs = []string{"some-other-key"}

	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Body:       io.NopCloser(strings.NewReader(`{"error":"unknown"}`)),
		Header:     http.Header{},
	}

	h.handle429(resp, sel, "test", "gpt-4", time.Now(), state, &http.Request{}, "test-id", nil, "", "", "")

	// With maxRetries=0, the key should be excluded after retry exhaustion
	if len(state.excludeKeyIDs) < 2 {
		t.Fatalf("expected at least 2 excluded keys, got %d: %v", len(state.excludeKeyIDs), state.excludeKeyIDs)
	}
	if state.excludeKeyIDs[1] != "key1" {
		t.Fatalf("expected second excluded key to be 'key1', got %s", state.excludeKeyIDs[1])
	}
}

func TestHandleUpstreamError_402(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	resp := &http.Response{
		StatusCode: http.StatusPaymentRequired,
		Body:       io.NopCloser(strings.NewReader(`{}`)),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 5}
	h.handleUpstreamError(httptest.NewRecorder(), resp, sel, "test", "gpt-4", state, nil, "test-id", nil, "", time.Now(), "", "")

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}

	keyState.Lock()
	status := keyState.ModelStatus["gpt-4"]
	keyState.Unlock()

	// 402 �?ActionCooldown, CooldownSec 120
	if status != "cooldown" {
		t.Fatalf("expected status 'cooldown' for 402, got %s", status)
	}
}

func TestHandleUpstreamError_404(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	resp := &http.Response{
		StatusCode: http.StatusNotFound,
		Body:       io.NopCloser(strings.NewReader(`{"error":"not found"}`)),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 5}
	h.handleUpstreamError(httptest.NewRecorder(), resp, sel, "test", "gpt-4", state, nil, "test-id", nil, "", time.Now(), "", "")

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}

	keyState.Lock()
	status := keyState.ModelStatus["gpt-4"]
	keyState.Unlock()

	if status != "cooldown" {
		t.Fatalf("expected status 'cooldown' for 404, got %s", status)
	}
}

func TestHandleUpstreamError_NoBody(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	resp := &http.Response{
		StatusCode: http.StatusInternalServerError,
		Body:       io.NopCloser(strings.NewReader("")),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 5}
	h.handleUpstreamError(httptest.NewRecorder(), resp, sel, "test", "gpt-4", state, nil, "test-id", nil, "", time.Now(), "", "")

	// Should not panic with empty body
	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}
}

func TestHandle429_TPM_FirstRetry(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	// SenseNova TPM pattern
	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Body:       io.NopCloser(strings.NewReader(`{"message":"rate limit exceeded on dimension: tpm","code":"429001"}`)),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 5}
	// This should set tpmWaitRetries=1 and return (no exclusion)
	h.handle429(resp, sel, "test", "gpt-4", time.Now(), state, &http.Request{}, "test-id", nil, "", "", "")

	if state.tpmWaitRetries != 1 {
		t.Fatalf("expected tpmWaitRetries=1, got %d", state.tpmWaitRetries)
	}
	// Key should NOT be excluded (reused on retry)
	if len(state.excludeKeyIDs) != 0 {
		t.Fatalf("expected no excluded keys after TPM first retry, got %v", state.excludeKeyIDs)
	}
}

func TestHandle429_RPM_ExcludesAccount(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	// SenseNova RPM pattern
	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Body:       io.NopCloser(strings.NewReader(`{"message":"rpm exhausted","type":"quota_exceeded_error"}`)),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 5}
	h.handle429(resp, sel, "test", "gpt-4", time.Now(), state, &http.Request{}, "test-id", nil, "", "", "")

	// RPM �?MarkRateLimited + excludeSameAccountKeys
	if len(state.excludeKeyIDs) == 0 {
		t.Fatal("expected excluded keys after RPM 429")
	}
	if state.excludeKeyIDs[0] != "key1" {
		t.Fatalf("expected key1 excluded, got %s", state.excludeKeyIDs[0])
	}
}

func TestHandle429_MaxRetriesExhausted(t *testing.T) {
	h := newTestHandler(t)
	sel := newSelectedKey()

	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Body:       io.NopCloser(strings.NewReader(`{"error":"rate limited"}`)),
		Header:     http.Header{},
	}

	state := &retryState{maxRetries: 0}
	h.handle429(resp, sel, "test", "gpt-4", time.Now(), state, &http.Request{}, "test-id", nil, "", "", "")

	// With maxRetries=0, temp429Retries should not be < maxRetries
	// So it falls through to: exclude + OnKeyFailure
	if len(state.excludeKeyIDs) == 0 || state.excludeKeyIDs[0] != "key1" {
		t.Fatal("expected key1 excluded after retries exhausted")
	}
}

func TestHandle429_ModelScopeExhausted(t *testing.T) {
	provider := config.Provider{
		ID: "test", Name: "Test", Prefix: "test",
		BaseURL: "https://modelscope.cn/v1", IsActive: true,
		Keys: []config.Key{
			{ID: "key1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1},
		},
	}
	cfg := config.RotationConfig{Strategy: "fill-first", MaxRetries: 5, BackoffMaxSec: 300}
	h := newTestHandlerWithCustomProvider(t, provider, cfg)
	sel := &rotation.SelectedKey{
		Provider: provider,
		Key:      provider.Keys[0],
		KeyName:  "K1",
	}

	headers := http.Header{}
	headers.Set("Modelscope-Ratelimit-Model-Requests-Limit", "100")
	headers.Set("Modelscope-Ratelimit-Model-Requests-Remaining", "0")

	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Body:       io.NopCloser(strings.NewReader(`{"error":"rate limited"}`)),
		Header:     headers,
	}

	state := &retryState{maxRetries: 5}
	h.handle429(resp, sel, "test", "gpt-4", time.Now(), state, &http.Request{}, "test-id", nil, "", "", "")

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}

	keyState.Lock()
	status := keyState.ModelStatus["gpt-4"]
	keyState.Unlock()

	if status != "locked" {
		t.Fatalf("expected status 'locked' for ModelScope exhausted, got %s", status)
	}
}
