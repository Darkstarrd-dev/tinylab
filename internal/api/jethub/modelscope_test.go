package jethub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestModelscopeLoginEndpoint(t *testing.T) {
	srv := newRouteTestHandler(t)

	post := func(body string) (*httptest.ResponseRecorder, map[string]any) {
		req := httptest.NewRequest(http.MethodPost, "/api/jethub/modelscope/login", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec, out
	}

	// 1. Valid API Key
	rec, out := post(`{"apiKey":"ms-abcdef1234567890","nickname":"测试魔搭"}`)
	if rec.Code != http.StatusOK || out["ok"] != true {
		t.Fatalf("modelscope login failed: %d %q", rec.Code, rec.Body.String())
	}
	id, _ := out["accountId"].(string)
	if id == "" {
		t.Fatal("expected accountId in response")
	}

	// 2. Duplicate Key reuse
	_, out2 := post(`{"apiKey":"ms-abcdef1234567890"}`)
	if reused, _ := out2["reused"].(bool); !reused {
		t.Fatal("expected reused=true for duplicate key")
	}

	// 3. Empty Key
	rec3, _ := post(`{"apiKey":""}`)
	if rec3.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty apiKey, got %d", rec3.Code)
	}
}
