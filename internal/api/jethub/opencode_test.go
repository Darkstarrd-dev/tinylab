package jethub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestOpencodeLoginEndpoint: POST /api/jethub/opencode/login 是**非浏览器**
// 登录入口（粘贴 API Key / 添加匿名通道），必须真注册（200 + JSON）且落库。
func TestOpencodeLoginEndpoint(t *testing.T) {
	srv := newRouteTestHandler(t)

	post := func(body string) (*httptest.ResponseRecorder, map[string]any) {
		req := httptest.NewRequest(http.MethodPost, "/api/jethub/opencode/login", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec, out
	}

	// ① 粘贴 API key。
	rec, out := post(`{"apiKey":"sk-test-1","nickname":"我的 Key"}`)
	if rec.Code != http.StatusOK || out["ok"] != true {
		t.Fatalf("apiKey login = %d %q", rec.Code, rec.Body.String())
	}
	if id, _ := out["accountId"].(string); id == "" {
		t.Fatal("accountId missing")
	}
	if reused, _ := out["reused"].(bool); reused {
		t.Fatal("first add must not report reused")
	}

	// ② 同一 key 再加 = 复用（不新建）。
	_, out = post(`{"apiKey":"sk-test-1"}`)
	if reused, _ := out["reused"].(bool); !reused {
		t.Fatal("duplicate key must be reused")
	}

	// ③ 匿名通道（幂等）。
	rec, out = post(`{"anonymous":true}`)
	if rec.Code != http.StatusOK || out["ok"] != true {
		t.Fatalf("anonymous add = %d %q", rec.Code, rec.Body.String())
	}
	_, out = post(`{"anonymous":true}`)
	if reused, _ := out["reused"].(bool); !reused {
		t.Fatal("anonymous add must be idempotent")
	}

	// ④ 空 key（非匿名）= 400。
	rec, _ = post(`{"apiKey":"  "}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty apiKey = %d, want 400", rec.Code)
	}

	// ⑤ 账号列表能看到 2 条（key + 匿名）。
	req := httptest.NewRequest(http.MethodGet, "/api/jethub/providers/opencode/accounts", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("accounts list = %d", rec.Code)
	}
	var list struct {
		Accounts []struct {
			ID            string `json:"id"`
			Provider      string `json:"provider"`
			HasCredential bool   `json:"hasCredential"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Accounts) != 2 {
		t.Fatalf("expected 2 opencode accounts, got %d", len(list.Accounts))
	}
	for _, a := range list.Accounts {
		if a.Provider != "opencode" || !a.HasCredential {
			t.Fatalf("account wrong: %+v", a)
		}
	}
}
