package jethub

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- P2.1: PKCE / DPoP ---

func TestGeneratePkcePair(t *testing.T) {
	p, err := GeneratePkcePair()
	if err != nil {
		t.Fatal(err)
	}
	// 48 random bytes → 64 base64url chars.
	if len(p.CodeVerifier) != 64 {
		t.Fatalf("verifier length %d, want 64", len(p.CodeVerifier))
	}
	if strings.ContainsAny(p.CodeVerifier, "+/=") {
		t.Fatalf("verifier not base64url: %q", p.CodeVerifier)
	}
	// Challenge must be SHA-256(verifier) base64url (32 bytes → 43 chars).
	if len(p.CodeChallenge) != 43 {
		t.Fatalf("challenge length %d, want 43", len(p.CodeChallenge))
	}
}

func TestDpopJwkRoundTrip(t *testing.T) {
	jwk, err := GenerateDpopKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	if jwk.Kty != "EC" || jwk.Crv != "P-256" || jwk.D == "" || jwk.X == "" || jwk.Y == "" {
		t.Fatalf("unexpected jwk shape: %+v", jwk)
	}
	// JSON round trip preserves the exact field names for backup compat.
	data, err := json.Marshal(&jwk)
	if err != nil {
		t.Fatal(err)
	}
	var back DpopPrivateJwk
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if back.D != jwk.D || back.X != jwk.X || back.Y != jwk.Y {
		t.Fatalf("jwk round trip mismatch: %s", data)
	}
	// Restore an ECDSA key and sign with it.
	priv, err := KeyPairFromStoredJwk(back)
	if err != nil {
		t.Fatal(err)
	}
	token, err := SignDpopJws(priv, "POST", codeartsSTSURL)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("JWS must have 3 segments: %q", token)
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatal(err)
	}
	var h map[string]any
	if err := json.Unmarshal(header, &h); err != nil {
		t.Fatal(err)
	}
	if h["typ"] != "dpop+jwt" || h["alg"] != "ES256" {
		t.Fatalf("unexpected JWS header: %s", header)
	}
	if _, ok := h["jwk"].(map[string]any); !ok {
		t.Fatalf("header must embed the public jwk: %s", header)
	}
	// Signature decodes to exactly 64 bytes (r||s).
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != 64 {
		t.Fatalf("ES256 signature must be 64 raw bytes: %d %v", len(sig), err)
	}
}

func TestClassifyTokenErrorTerminal(t *testing.T) {
	for _, code := range []string{"", "ExpiredRefreshToken", "InvalidDPoPHeader"} {
		resp := &CodeArtsTokenResponse{Error: "invalid_grant", ErrorCode: code}
		if err := ClassifyTokenError(resp); err != ErrRefreshTokenExpired {
			t.Fatalf("invalid_grant (%s) must be terminal, got %v", code, err)
		}
	}
	transient := &CodeArtsTokenResponse{Error: "server_error", ErrorCode: "SomethingElse"}
	if err := ClassifyTokenError(transient); err == ErrRefreshTokenExpired {
		t.Fatal("non-terminal error misclassified")
	}
}

// --- P2.4: SDK-HMAC-SHA256 ---

func TestSignHuaweiRequestStructure(t *testing.T) {
	signed, err := SignHuaweiRequest("AK", "SK", "ST", "POST",
		"https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions",
		[]byte(`{"a":1}`), map[string]string{"maas_type": "benefit"})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"x-sdk-date", "x-sdk-content-sha256", "x-security-token", "content-type", "Authorization", "maas_type"} {
		if _, ok := signed[key]; !ok {
			t.Fatalf("signed headers missing %q: %v", key, signed)
		}
	}
	auth := signed["Authorization"]
	if !strings.HasPrefix(auth, "SDK-HMAC-SHA256 Access=AK,") {
		t.Fatalf("unexpected Authorization: %q", auth)
	}
	if !strings.Contains(auth, "SignedHeaders=content-type;maas_type;x-sdk-content-sha256;x-sdk-date;x-security-token,") {
		t.Fatalf("SignedHeaders must be sorted and include maas_type: %q", auth)
	}
	// GET requests must not carry content-type in the canonical set.
	signedGet, err := SignHuaweiRequest("AK", "SK", "ST", "GET", "https://x/y", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := signedGet["content-type"]; ok {
		t.Fatal("GET must not sign content-type")
	}
}

// --- P2.4 augment ---

func newAugmentTestManager(t *testing.T) *Manager {
	t.Helper()
	m := newTestManager(t).m
	id, ref := NewAccountID("codearts")
	if err := m.AddAccount(Account{ID: id, Provider: "codearts", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	cred := &CodeArtsCredential{
		AccessKeyID: "AKTEST", SecretAccessKey: "SKTEST", SecurityToken: "STTEST",
		ExpiresAt: "2030-01-01T00:00:00Z",
	}
	credJSON, _ := json.Marshal(cred)
	if err := m.SetCredential("codearts", ref, credJSON, 9999999999999, false); err != nil {
		t.Fatal(err)
	}
	// Wire the codearts augment hook exactly like the app assembly does.
	m.SetAugmenter("codearts", m.CodeArtsAugmentHook())
	return m
}

func TestCodeArtsAugmentSignsAndInjectsBenefit(t *testing.T) {
	m := newAugmentTestManager(t)
	// keyID must be the seeded account id (the augmenter resolves credentials
	// by account id, mirroring rotation's SelectedKey.Key.ID).
	accID := firstCodeArtsAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions", nil)

	// Benefit model → maas_type present.
	out, err := m.Augment(req, []byte(`{"model":"deepseek-v4.1-flash"}`), "jethub-codearts", accID, "deepseek-v4.1-flash")
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"model":"deepseek-v4.1-flash"}` {
		t.Fatal("body must pass through unchanged")
	}
	if req.Header.Get("maas_type") != "benefit" {
		t.Fatalf("maas_type: benefit required for benefit models, got %v", req.Header)
	}
	if !strings.HasPrefix(req.Header.Get("Authorization"), "SDK-HMAC-SHA256 Access=AKTEST") {
		t.Fatalf("Authorization must be the SDK signature: %q", req.Header.Get("Authorization"))
	}
	if req.Header.Get("x-security-token") != "STTEST" {
		t.Fatal("security token header missing")
	}
	if req.Header.Get("Chat-Id") == "" || req.Header.Get("Session-Id") == "" || req.Header.Get("lang") != "en" {
		t.Fatal("attribution headers missing")
	}

	// Non-benefit model → no maas_type.
	req2, _ := http.NewRequest(http.MethodPost, "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions", nil)
	if _, err := m.Augment(req2, []byte(`{}`), "jethub-codearts", accID, "GLM-5.2"); err != nil {
		t.Fatal(err)
	}
	if req2.Header.Get("maas_type") != "" {
		t.Fatal("maas_type must NOT be set for non-benefit models")
	}
}

func TestCodeArtsAugmentMissingCredentialFails(t *testing.T) {
	m := newTestManager(t).m
	id, ref := NewAccountID("codearts")
	_ = m.AddAccount(Account{ID: id, Provider: "codearts", Enabled: true, CredentialRef: ref})
	req, _ := http.NewRequest(http.MethodPost, "https://x", nil)
	if _, err := m.codeartsAugment(req, []byte(`{}`), "jethub-codearts", id, "GLM-5.2"); err == nil {
		t.Fatal("expected failure when the credential is missing")
	}
}

// --- P2.2/P2.3: token exchange against a mock STS endpoint ---

func TestExchangeRefreshTokenMockSTS(t *testing.T) {
	var gotDPoP, gotGrant string
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotDPoP = r.Header.Get("DPoP")
		gotGrant = r.FormValue("grant_type")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"credentials":{"access_key_id":"AK","secret_access_key":"SK","security_token":"ST","expiration":"2030-01-01T00:00:00Z"},"refresh_token":"RT2"}`))
	}))
	defer sts.Close()

	// Redirect the package-level STS URL by pointing the caller at the mock:
	// codeartsTokenRequest reads CodeArtsSTSURL, so swap it via a test hook.
	oldURL := codeartsSTSURL
	setSTSURL(sts.URL)
	defer setSTSURL(oldURL)

	jwk, _ := GenerateDpopKeyPair()
	priv, err := KeyPairFromStoredJwk(jwk)
	if err != nil {
		t.Fatal(err)
	}
	token, err := ExchangeCodeArtsRefreshToken(context.Background(), "RT1", "CV", priv)
	if err != nil {
		t.Fatal(err)
	}
	if gotGrant != "refresh_token" {
		t.Fatalf("grant_type = %q", gotGrant)
	}
	if gotDPoP == "" {
		t.Fatal("DPoP header missing")
	}
	if token.Credentials == nil || token.Credentials.AccessKeyID != "AK" || token.RefreshToken != "RT2" {
		t.Fatalf("token parse failed: %+v", token)
	}
	cred := CredentialFromTokenResponse(token, PkcePair{CodeVerifier: "CV"}, &jwk)
	if cred.AccessKeyID != "AK" || cred.CodeVerifier != "CV" || cred.DpopPrivateJwk == nil || cred.DpopPrivateJwk.D != jwk.D {
		t.Fatalf("credential assembly wrong: %+v", cred)
	}
	if !codeartsRefreshable(cred) {
		t.Fatal("credential should be refreshable")
	}
}

func TestExchangeRefreshTokenTerminalError(t *testing.T) {
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid_grant","error_code":"ExpiredRefreshToken"}`))
	}))
	defer sts.Close()
	oldURL := codeartsSTSURL
	setSTSURL(sts.URL)
	defer setSTSURL(oldURL)

	jwk, _ := GenerateDpopKeyPair()
	priv, _ := KeyPairFromStoredJwk(jwk)
	_, err := ExchangeCodeArtsRefreshToken(context.Background(), "RT", "CV", priv)
	if err != ErrRefreshTokenExpired {
		t.Fatalf("expected ErrRefreshTokenExpired, got %v", err)
	}
}

// --- P2.6: credits against a mock snap-access ---

func TestClaimCodeArtsDailyFlow(t *testing.T) {
	m := newAugmentTestManager(t)
	var confirmCalled bool
	snap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "SDK-HMAC-SHA256 Access=AKTEST") {
			t.Errorf("unsigned or wrong request: %q", auth)
			w.WriteHeader(401)
			return
		}
		switch {
		case strings.Contains(r.URL.Path, "statistics/plugin"):
			// NOTE: the metrics endpoint uses the *snap* base; this mock serves
			// whatever path arrives.
			w.Write([]byte(`{"package":{"is_credit_package":true},"metrics":[{"name":"usageTotalPackageCredit","package_credit_remain":1000}]}`))
		case strings.Contains(r.URL.Path, "/v1/ops/delivery"):
			w.Write([]byte(`{"code":0,"data":{"items":[{"campaignId":1,"type":"USER_LOGIN","claimable":true,"status":"ENTRY","benefitAmount":1000}]}}`))
		case strings.Contains(r.URL.Path, "/v1/ops/claim"):
			w.Write([]byte(`{"code":0,"data":{"id":"b1","benefitAmount":1000}}`))
		case strings.Contains(r.URL.Path, "/v1/ops/confirm"):
			confirmCalled = true
			w.Write([]byte(`{"code":0,"data":{}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer snap.Close()
	setSnapBase(snap.URL)

	acc, _ := m.FindAccount(firstCodeArtsAccount(t, m))
	outcome, err := m.ClaimCodeArtsDaily(context.Background(), acc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "claimed" || outcome.Credit != 1000 {
		t.Fatalf("unexpected outcome: %+v", outcome)
	}
	if !confirmCalled {
		t.Fatal("confirm step must run when claim returns an id")
	}
}

func TestClaimCodeArtsDailyAlreadyClaimed(t *testing.T) {
	m := newAugmentTestManager(t)
	snap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "statistics/plugin"):
			w.Write([]byte(`{"package":{"is_credit_package":true},"metrics":[]}`))
		case strings.Contains(r.URL.Path, "/v1/ops/delivery"):
			w.Write([]byte(`{"code":0,"data":{"items":[{"campaignId":1,"type":"USER_LOGIN","claimable":false,"status":"CLAIMED"}]}}`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(400)
		}
	}))
	defer snap.Close()
	setSnapBase(snap.URL)

	acc, _ := m.FindAccount(firstCodeArtsAccount(t, m))
	outcome, err := m.ClaimCodeArtsDaily(context.Background(), acc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "already-claimed" {
		t.Fatalf("expected already-claimed, got %+v", outcome)
	}
}

func TestClaimCodeArtsDailyTokenAccountInactive(t *testing.T) {
	m := newAugmentTestManager(t)
	snap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"package":{"is_credit_package":false,"is_token_package":true},"metrics":[]}`))
	}))
	defer snap.Close()
	setSnapBase(snap.URL)

	acc, _ := m.FindAccount(firstCodeArtsAccount(t, m))
	outcome, err := m.ClaimCodeArtsDaily(context.Background(), acc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "inactive" {
		t.Fatalf("token account must be inactive: %+v", outcome)
	}
}

// firstCodeArtsAccount digs the seeded account id out of the manager.
func firstCodeArtsAccount(t *testing.T, m *Manager) string {
	t.Helper()
	accounts := m.Accounts("codearts")
	if len(accounts) == 0 {
		t.Fatal("no seeded codearts account")
	}
	return accounts[0].ID
}

// --- P2.2: login URL shape ---

func TestBuildOAuthLoginURLShape(t *testing.T) {
	pkce, _ := GeneratePkcePair()
	urlStr := BuildOAuthLoginURL(12345, pkce, "ticket-1")
	for _, want := range []string{
		"port=12345",
		"code_challenge_method=SHA-256", // NOT S256 — portal requirement
		"client_id=codearts-agent",
		"plugin-name=snap_AIIDE",
		"plugin-version=5.2.0",
		"ticket_id=ticket-1",
	} {
		if !strings.Contains(urlStr, want) {
			t.Fatalf("login url missing %q: %s", want, urlStr)
		}
	}
	if strings.Contains(urlStr, "auth_callback_url") {
		t.Fatal("auth_callback_url must NOT appear (portal rejects it)")
	}
}

// silence unused warnings for ecdsa import used indirectly
var _ = ecdsa.PrivateKey{}
