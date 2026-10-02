package jethub

// ZCode API 层测试：公开 captcha 载体路由 + 登录状态轮询的错误面。

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/config"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

func newZcodeTestHandler(t *testing.T) *Handler {
	t.Helper()
	dir := t.TempDir()
	key, err := config.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	m, err := corejethub.NewManager(dir, key, nil)
	if err != nil {
		t.Fatal(err)
	}
	return NewHandler(&Deps{Manager: m, Bridge: corejethub.NewBridge(m, nil)})
}

func zcodeValidParam(t *testing.T) string {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{
		"certifyId":     "c1",
		"securityToken": strings.Repeat("s", 60),
		"padding":       strings.Repeat("p", 160),
	})
	return base64.StdEncoding.EncodeToString(raw)
}

func TestZcodeCarrierRoutesArePublicAndOneShot(t *testing.T) {
	h := newZcodeTestHandler(t)
	r := chi.NewRouter()
	h.RegisterPublicZcodeCarrier(r)

	token := corejethub.ZcodeNewCarrierSession()
	// 载体页：200 + 页面含阿里云初始化参数，且不含任何凭据。
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/jethub/zcode/carrier?token="+token, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("carrier page status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "11xygtvd") || !strings.Contains(body, "startTracelessVerification") {
		t.Fatalf("carrier page missing the Aliyun init payload")
	}
	if strings.Contains(body, "Bearer") || strings.Contains(body, "zcode_jwt") {
		t.Fatalf("carrier page must not contain credentials")
	}

	// 未知 token：404（页面不接受任何未注册的会话）。
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/jethub/zcode/carrier?token=bogus", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown token status = %d, want 404", rec.Code)
	}

	// 非法 param：400，且会话保持可用（页面可重试）。
	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/jethub/zcode/carrier/contribute?token="+token, strings.NewReader(`{"param":"short"}`))
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid param status = %d, want 400", rec.Code)
	}
	if !corejethub.ZcodeCarrierPending(token) {
		t.Fatal("an invalid param must not consume the one-shot session")
	}

	// 合法 param：200 且会话被消费（一次性）。
	payload, _ := json.Marshal(map[string]string{"param": zcodeValidParam(t)})
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/jethub/zcode/carrier/contribute?token="+token, strings.NewReader(string(payload))))
	if rec.Code != http.StatusOK {
		t.Fatalf("valid param status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if corejethub.ZcodeCarrierPending(token) {
		t.Fatal("a delivered session must be consumed")
	}
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/jethub/zcode/carrier?token="+token, nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("consumed token status = %d, want 404", rec.Code)
	}
}

func TestZcodeStatusUnknownLoginID(t *testing.T) {
	h := newZcodeTestHandler(t)
	r := chi.NewRouter()
	h.RegisterZcode(r)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/zcode/status?loginId=nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown loginId status = %d, want 404 (UI treats it as no-transition)", rec.Code)
	}
	// 无 loginId → 账号快照（空列表也是 200）。
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/zcode/status", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "accounts") {
		t.Fatalf("account snapshot status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestZcodeImportWithoutClientReportsReason(t *testing.T) {
	// 隔离所有凭据候选根：本机真实装了官方客户端，不隔离的话这条测试会
	// 直接导入真机凭据（非决定性 + 泄漏到测试环境）。
	root := t.TempDir()
	t.Setenv("ZCODE_DATA_BASE_DIR", root)
	t.Setenv("USERPROFILE", root)
	t.Setenv("HOME", root)
	t.Setenv("APPDATA", root)
	t.Setenv("LOCALAPPDATA", root)
	h := newZcodeTestHandler(t)
	r := chi.NewRouter()
	h.RegisterZcode(r)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/zcode/import", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("import status = %d, want 200", rec.Code)
	}
	var parsed map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if ok, _ := parsed["ok"].(bool); ok {
		t.Fatalf("import must not succeed without an official client: %s", rec.Body.String())
	}
	if reason, _ := parsed["reason"].(string); !strings.Contains(reason, "credentials.json") {
		t.Fatalf("reason must explain what was missing: %q", reason)
	}
}

func TestZcodeClaimRequiresAccountID(t *testing.T) {
	h := newZcodeTestHandler(t)
	r := chi.NewRouter()
	h.RegisterZcode(r)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/zcode/claim", strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("claim without accountId status = %d, want 400", rec.Code)
	}
}
