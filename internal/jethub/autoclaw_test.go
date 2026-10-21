package jethub

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"
)

func TestAutoclawFallbackModels(t *testing.T) {
	models := autoclawFallbackModels()
	if len(models) != 4 {
		t.Fatalf("expected 4 fallback models, got %d", len(models))
	}
	expected := map[string]string{
		"zai_glm-5.3-flash": "GLM-5.3 Flash (AutoClaw)",
		"zaicoding_glm-5.3": "GLM-5.3 (AutoClaw)",
		"zai_auto":          "Auto (AutoClaw)",
		"zai_auto-fast":     "Auto-Fast (AutoClaw)",
	}
	for _, m := range models {
		wantName, ok := expected[m.ID]
		if !ok {
			t.Fatalf("unexpected model ID %s", m.ID)
		}
		if m.Alias != wantName {
			t.Fatalf("model %s alias mismatch: got %q, want %q", m.ID, m.Alias, wantName)
		}
	}
}

func TestCalculateAutoclawSign(t *testing.T) {
	appID := "100003"
	appKey := "38d2391985e2369a5fb8227d8e6cd5e5"
	ts := int64(1700000000)

	expectedPayload := fmt.Sprintf("%s&%d&%s", appID, ts, appKey)
	expectedHash := md5.Sum([]byte(expectedPayload))
	expectedSign := hex.EncodeToString(expectedHash[:])

	sign := calculateAutoclawSign(appID, ts, appKey)
	if sign != expectedSign {
		t.Fatalf("sign mismatch: got %s, want %s", sign, expectedSign)
	}
}

func TestPrepareAutoclawMessages(t *testing.T) {
	prefix := "You are AutoClaw. Answer the user directly and concisely"

	// Empty messages
	emptyRes := prepareAutoclawMessages(nil)
	if len(emptyRes) != 1 || emptyRes[0].(map[string]any)["content"] != prefix {
		t.Fatalf("empty messages failed: %+v", emptyRes)
	}

	// Starts with user message
	userMsgs := []any{
		map[string]any{"role": "user", "content": "hello"},
	}
	resUser := prepareAutoclawMessages(userMsgs)
	if len(resUser) != 2 || resUser[0].(map[string]any)["content"] != prefix || resUser[1].(map[string]any)["content"] != "hello" {
		t.Fatalf("user prepending failed: %+v", resUser)
	}

	// Starts with custom system message
	sysMsgs := []any{
		map[string]any{"role": "system", "content": "You are a helpful coding assistant."},
		map[string]any{"role": "user", "content": "help me"},
	}
	resSys := prepareAutoclawMessages(sysMsgs)
	if len(resSys) != 3 {
		t.Fatalf("expected 3 messages, got %d: %+v", len(resSys), resSys)
	}
	if resSys[0].(map[string]any)["content"] != prefix {
		t.Fatalf("first message must be prefix, got: %v", resSys[0])
	}
	if resSys[1].(map[string]any)["content"] != "You are a helpful coding assistant." {
		t.Fatalf("second message must be original system prompt, got: %v", resSys[1])
	}
}

func TestAutoclawJwtExpiresAtMs(t *testing.T) {
	expSec := time.Now().Add(24 * time.Hour).Unix()
	payload := map[string]any{
		"exp": expSec,
	}
	payloadBytes, _ := json.Marshal(payload)
	payloadB64 := base64.RawURLEncoding.EncodeToString(payloadBytes)
	fakeJWT := fmt.Sprintf("header.%s.signature", payloadB64)

	expMs := autoclawJwtExpiresAtMs(fakeJWT)
	if expMs != expSec*1000 {
		t.Fatalf("jwt exp mismatch: got %d, want %d", expMs, expSec*1000)
	}
}

func TestAutoclawAugment(t *testing.T) {
	mgr, err := NewManager(t.TempDir(), "", nil)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}

	id := "test-autoclaw-1"
	ref := "test-autoclaw-ref"
	_ = mgr.AddAccount(Account{
		ID:            id,
		Provider:      "autoclaw",
		Nickname:      "138****0000",
		Enabled:       true,
		CredentialRef: ref,
	})
	cred := AutoclawCredential{
		AccessToken: "mock-token",
		DeviceID:    "mock-device-id",
	}
	credRaw, _ := json.Marshal(cred)
	_ = mgr.SetCredential("autoclaw", ref, credRaw, time.Now().Add(time.Hour).UnixMilli(), true)

	req, _ := http.NewRequest(http.MethodPost, "http://localhost/v1/chat/completions", nil)
	rawBody := []byte(`{
		"model": "zaicoding_glm-5.3",
		"messages": [{"role": "user", "content": "hi"}],
		"max_tokens": 2048
	}`)

	augmented, err := mgr.autoclawAugment(req, rawBody, "jethub-autoclaw", id, "zaicoding_glm-5.3")
	if err != nil {
		t.Fatalf("augment failed: %v", err)
	}

	if req.Header.Get("X-Version") != "2.1.1" {
		t.Fatalf("X-Version header mismatch: %s", req.Header.Get("X-Version"))
	}
	if req.Header.Get("X-Auth-Appid") != "100003" {
		t.Fatalf("X-Auth-Appid mismatch: %s", req.Header.Get("X-Auth-Appid"))
	}
	if req.Header.Get("X-Product") != "autoclaw" {
		t.Fatalf("X-Product mismatch: %s", req.Header.Get("X-Product"))
	}
	if req.Header.Get("X-Authorization") != "Bearer mock-token" {
		t.Fatalf("X-Authorization mismatch: %s", req.Header.Get("X-Authorization"))
	}

	var parsed map[string]any
	if err := json.Unmarshal(augmented, &parsed); err != nil {
		t.Fatalf("unmarshal augmented: %v", err)
	}
	msgs := parsed["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].(map[string]any)["content"] != "You are AutoClaw. Answer the user directly and concisely" {
		t.Fatalf("expected prefix in first message, got %+v", msgs[0])
	}
	// max_tokens clamped to at least 10000
	if parsed["max_tokens"].(float64) != 10000 {
		t.Fatalf("expected max_tokens clamped to 10000, got %v", parsed["max_tokens"])
	}
}
