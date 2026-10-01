package jethub

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
)

// CodeArts benefit-model fallback set (ref src/models.ts
// CODEARTS_BENEFIT_FALLBACK). Requests for these models must carry
// maas_type: benefit inside the SDK-HMAC signature.
var codeartsBenefitFallback = map[string]bool{
	"glm-5.3-flash":       true,
	"deepseek-v4.1-flash": true,
}

// isCodeArtsBenefitModel is the static decision used by the augmenter. The
// dynamic gateway/config cache lands with P2 hardening if needed; the
// fallback covers the models registered in codeartsModels.
func isCodeArtsBenefitModel(model string) bool {
	return codeartsBenefitFallback[model]
}

// CodeArtsAugmentHook returns the provider-specific augment function wired at
// app startup (Manager.SetAugmenter("codearts", ...)).
func (m *Manager) CodeArtsAugmentHook() RequestAugmenterFunc {
	return m.codeartsAugment
}

// CodeArtsAugment implements the provider augment hook: it signs the outbound
// request with SDK-HMAC-SHA256 using the account credential resolved by
// keyID, injecting maas_type: benefit for benefit models.
//
// Contract notes (from ref llm-adapter.ts):
//   - extra signed headers (maas_type) must also be sent verbatim;
//   - Chat-Id/Session-Id/lang headers are appended after signing;
//   - the body is forwarded unchanged (OpenAI-compatible passthrough).
func (m *Manager) codeartsAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	cred, err := m.credentialForAccount("codearts", keyID)
	if err != nil {
		return nil, err
	}
	extra := map[string]string{}
	if isCodeArtsBenefitModel(upstreamModel) {
		extra["maas_type"] = "benefit"
	}
	signed, err := SignHuaweiRequest(cred.AccessKeyID, cred.SecretAccessKey, cred.SecurityToken, "POST", r.URL.String(), body, extra)
	if err != nil {
		return nil, err
	}
	// Replace the outbound header set with the signed headers (they ARE the
	// request identity for Huawei APIG) + attribution headers.
	for k := range r.Header {
		r.Header.Del(k)
	}
	ApplySignedHeaders(r.Header.Set, signed)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Chat-Id", chatSessionID(keyID))
	r.Header.Set("Session-Id", chatSessionID(keyID))
	r.Header.Set("lang", "en")
	r.Header.Set("Authorization", signed["Authorization"])
	return body, nil
}

// chatSessionID derives a stable per-key session id (the plugin uses random
// UUIDs per adapter; a stable hex id per account keeps prompt_cache_key
// working across calls without extra state).
func chatSessionID(keyID string) string {
	sum := sha256.Sum256([]byte("jethub-codearts:" + keyID))
	return hex.EncodeToString(sum[:16])
}

// credentialForAccount resolves + parses the stored credential JSON.
func (m *Manager) credentialForAccount(provider, keyID string) (*CodeArtsCredential, error) {
	acc, ok := m.FindAccount(keyID)
	if !ok || acc.Provider != provider {
		return nil, fmt.Errorf("jethub: account %s not found for %s", keyID, provider)
	}
	raw, ok := m.Credential(provider, acc.CredentialRef)
	if !ok {
		return nil, fmt.Errorf("jethub: credential missing for account %s", keyID)
	}
	var cred CodeArtsCredential
	if err := json.Unmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse credential for %s: %w", keyID, err)
	}
	if cred.AccessKeyID == "" || cred.SecretAccessKey == "" || cred.SecurityToken == "" {
		return nil, fmt.Errorf("jethub: credential incomplete for %s (re-login required)", keyID)
	}
	return &cred, nil
}
