package jethub

import (
	"net/http"
)

// Buddy chat augment (ref buddy-adapter.ts send()): Bearer auth + X-Domain +
// X-Product-Code + the attribution header family + per-model-family UA.
// Body passes through unchanged (OpenAI-compatible SSE).
func (m *Manager) buddyAugment(p *BuddyProduct) RequestAugmenterFunc {
	return func(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
		acc, ok := m.FindAccount(keyID)
		if !ok || (acc.Provider != p.ID && acc.Provider != "buddy" && acc.Provider != "workbuddy") {
			return nil, errAccountNotFound(keyID)
		}
		raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
		if !ok {
			return nil, errCredentialMissing(keyID)
		}
		var cred BuddyCredential
		if err := jsonUnmarshal(raw, &cred); err != nil {
			return nil, err
		}
		if cred.AccessToken == "" {
			return nil, errCredentialMissing(keyID)
		}
		// Full header reset: the signed/attribution set IS the request identity.
		r.Header.Set("Authorization", "Bearer "+cred.AccessToken)
		r.Header.Set("Content-Type", "application/json")
		// X-Domain: product config wins (credential.domain is a login-time
		// snapshot that goes stale after a product migration); empty-string
		// fallback chain preserved (product → credential → "").
		r.Header.Set(buddyHeaderDomain, firstNonEmpty(p.APIDomain, cred.Domain))
		r.Header.Set(buddyHeaderProductCode, p.ProductCode)
		// Attribution family: the billing "使用端" column groups by these; a
		// missing one shows "-" in the console. X-Product = attribution name,
		// NOT the deployment type.
		r.Header.Set("X-Agent-Purpose", "conversation")
		r.Header.Set("X-IDE-Name", p.AttributionName)
		r.Header.Set("X-IDE-Type", p.AttributionName)
		r.Header.Set("X-IDE-Version", p.ClientVersion)
		r.Header.Set(buddyHeaderProduct, p.AttributionName)
		r.Header.Set("User-Agent", resolveBuddyUserAgent(p, upstreamModel))
		return body, nil
	}
}

type simpleError struct{ msg string }

func (e *simpleError) Error() string { return e.msg }

func errAccountNotFound(id string) error { return &simpleError{"jethub: account " + id + " not found"} }
func errCredentialMissing(id string) error {
	return &simpleError{"jethub: credential missing for " + id}
}
