package jethub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAutoclawEndpoints(t *testing.T) {
	srv := newRouteTestHandler(t)

	// 1. Send SMS code: empty phone
	req := httptest.NewRequest(http.MethodPost, "/api/jethub/autoclaw/login/sms/send", strings.NewReader(`{"phone":""}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty phone, got %d", rec.Code)
	}

	// 2. Submit SMS code: invalid input
	req = httptest.NewRequest(http.MethodPost, "/api/jethub/autoclaw/login/sms/submit", strings.NewReader(`{"phone":"","code":""}`))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty phone/code, got %d", rec.Code)
	}

	// 3. Status endpoint
	req = httptest.NewRequest(http.MethodGet, "/api/jethub/autoclaw/status", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for status, got %d", rec.Code)
	}
	var st struct {
		Accounts []any `json:"accounts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("status unmarshal: %v", err)
	}
}
