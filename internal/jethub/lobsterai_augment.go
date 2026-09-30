package jethub

import (
	"net/http"
)

// LobsterAI augment (ref lobsterai-adapter.ts send()): Bearer + the two
// X-LobsterAI-Client-* headers (capabilities REQUIRED: kimi-k3 access +
// thinking-off protocol) + dynamic client version. Body passthrough — the
// reasoning_effort passthrough stays in the client body (no max档 rewrite;
// the adapter sends what the caller supplies).
func (m *Manager) lobsteraiAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	acc, ok := m.FindAccount(keyID)
	if !ok || acc.Provider != "lobsterai" {
		return nil, errAccountNotFound(keyID)
	}
	raw, ok := m.Credential("lobsterai", acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(keyID)
	}
	var cred LobsteraiCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, err
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(keyID)
	}
	// Full header reset: the four-header + capability set IS the identity
	// (X-Domain/X-Product family would mis-attribute).
	for k := range r.Header {
		r.Header.Del(k)
	}
	for k, v := range lobsteraiChatHeaders(&cred, lobsteraiProduct.ClientVersion) {
		r.Header.Set(k, v)
	}
	return body, nil
}
