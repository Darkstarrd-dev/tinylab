package jethub

import (
	"encoding/json"
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
		body, err := buddyStripReasoningEffort(acc.Provider, body)
		if err != nil {
			return nil, err
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

// buddyStripReasoningEffort drops `reasoning_effort` for the workbuddy channel
// (ref buddy-adapter.ts suppressesProseWhenEffortSent, 2026-10-13/14 实测).
//
// ⚠️ 这是**服务端事实**而不是面板偏好：workbuddy 的 deepseek-v4.1-flash 带 tools
// 时一旦下发 `reasoning_effort`，工具调用前的正文前言会被上游整段吞掉（`text`
// 块恒 0）；buddy 无此缺陷，故只对 workbuddy 生效，且只在键存在时才改写 body
// （无该键时字节级透传，避免无谓重排 JSON）。
func buddyStripReasoningEffort(provider string, body []byte) ([]byte, error) {
	if provider != "workbuddy" || len(body) == 0 {
		return body, nil
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	if _, ok := parsed["reasoning_effort"]; !ok {
		return body, nil
	}
	delete(parsed, "reasoning_effort")
	out, err := json.Marshal(parsed)
	if err != nil {
		return nil, err
	}
	return out, nil
}

type simpleError struct{ msg string }

func (e *simpleError) Error() string { return e.msg }

func errAccountNotFound(id string) error { return &simpleError{"jethub: account " + id + " not found"} }
func errCredentialMissing(id string) error {
	return &simpleError{"jethub: credential missing for " + id}
}
