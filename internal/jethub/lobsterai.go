package jethub

import (
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"strings"
	"time"
)

// LobsterAI (有道龙虾) protocol constants — 1:1 from ref lobsterai.ts /
// lobsterai-product.ts. Independent protocol family: local callback login +
// authCode exchange, no PKCE/DPoP; identity fields (uuid/firstKeyfrom)
// generated client-side and replayed on every refresh.
const (
	lobsteraiExchangePath     = "/api/auth/exchange"
	lobsteraiRefreshPath      = "/api/auth/refresh"
	lobsteraiModelsPath       = "/api/models/available"
	lobsteraiChatPath         = "/api/proxy/v1/chat/completions"
	lobsteraiCallbackPath     = "/auth/callback"
	lobsteraiRequestTimeout   = 30 * timeSecond
	lobsteraiLoginTimeout     = 10 * timeMinute
	lobsteraiSlotPath         = "/api/client-activities/slot"
	lobsteraiActivitiesPath   = "/api/client-activities"
	lobsteraiProfilePath      = "/api/user/profile-summary"
	lobsteraiSlotPlacement    = "desktop_sidebar"
	lobsteraiSlotAPIVersion   = "2"
	lobsteraiSlotPlatform     = "win32"
	lobsteraiClientVersionAPI = "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update"
	lobsteraiFallbackVersion  = "2026.9.4"
)

// LobsteraiProduct is the single-product config (parallel to BuddyProduct on
// purpose — the field sets are disjoint).
var lobsteraiProduct = &BuddyProduct{
	ID: "lobsterai", Platform: "", Endpoint: "https://lobsterai-server.youdao.com",
	APIDomain: "", DisplayName: "LobsterAI", ProductCode: "",
	UserAgent: "LobsterAI/0.1.0", AttributionName: "", ClientVersion: "2026.9.4",
	CredPrefix: "LOBSTERAI",
}

// LobsteraiCredential mirrors ref lobsterai.ts (JSON names are the §1.5
// backup contract). uuid/first_keyfrom/latest_keyfrom are client-generated
// identity fields that exchange/refresh must replay verbatim — losing them
// breaks renewal permanently.
type LobsteraiCredential struct {
	AccessToken   string `json:"access_token"`
	RefreshToken  string `json:"refresh_token"`
	ExpiresAt     string `json:"expires_at,omitempty"`
	UID           string `json:"uid,omitempty"`
	UserID        string `json:"user_id,omitempty"`
	Nickname      string `json:"nickname,omitempty"`
	UUID          string `json:"uuid,omitempty"`
	FirstKeyfrom  string `json:"first_keyfrom,omitempty"`
	LatestKeyfrom string `json:"latest_keyfrom,omitempty"`
}

// lobsteraiCredentialExpiresAtMs: ms-string / ISO / JWT exp fallback; 0 when
// unknown (never judged expired on unknown — same as the plugin).
func lobsteraiCredentialExpiresAtMs(cred *LobsteraiCredential) int64 {
	if raw := cred.ExpiresAt; raw != "" {
		if isAllDigits(raw) {
			n := parsePositiveInt(raw)
			if n > 1_000_000_000_000 {
				return n
			}
			return n * 1000
		}
		if ms := parseISOTime(raw); ms > 0 {
			return ms
		}
	}
	return jwtExpiresAtMs(cred.AccessToken)
}

// MaskPhoneTail normalizes a phone-number nickname to tail-2 visible form
// (user requirement 2026-09-27). Idempotent; non-phone strings untouched.
func MaskLobsteraiPhoneTail(value string, visibleTail int) string {
	trimmed := trimSpaces(value)
	if trimmed == "" {
		return trimmed
	}
	if visibleTail <= 0 {
		visibleTail = 2
	}
	rebuild := func(prefix string, totalLength int, tail string) string {
		stars := totalLength - len(prefix) - len(tail)
		if stars < 0 {
			return trimmed
		}
		return prefix + strings.Repeat("*", stars) + tail
	}
	// Form 1: full phone (11 digits starting with 1).
	if len(trimmed) == 11 && isAllDigits(trimmed) && trimmed[0] == '1' {
		return rebuild(trimmed[:3], len(trimmed), trimmed[len(trimmed)-visibleTail:])
	}
	// Form 2: server-masked (3 digits + stars + digits). Tail keeps only the
	// last `visibleTail` digits (like the reference: suffix.slice(-tail)).
	if len(trimmed) > 4 && isAllDigits(trimmed[:3]) {
		i := 3
		for i < len(trimmed) && trimmed[i] == '*' {
			i++
		}
		if i > 3 && i < len(trimmed) && isAllDigits(trimmed[i:]) {
			suffix := trimmed[i:]
			if len(suffix) > visibleTail {
				suffix = suffix[len(suffix)-visibleTail:]
			}
			return rebuild(trimmed[:3], len(trimmed), suffix)
		}
	}
	return trimmed
}

// LobsteraiDisplayNickname picks the masked nickname (fallback: account id).
func LobsteraiDisplayNickname(nickname, fallbackID string) string {
	n := trimSpaces(nickname)
	if n == "" {
		return fallbackID
	}
	return MaskLobsteraiPhoneTail(n, 2)
}

func trimSpaces(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

// lobsteraiEnvelope parses the unified `{code,msg,data}` response.
func lobsteraiEnvelope(body map[string]any) (data map[string]any, code int64, message string, ok bool) {
	if body == nil {
		return nil, -1, "响应缺少信封", false
	}
	code = bodyCode(body)
	message = bodyMessage(body)
	if code != 0 {
		return nil, code, firstNonEmpty(message, fmt.Sprintf("业务码 %d", code)), false
	}
	data = bodyData(body)
	if data == nil {
		return nil, code, "响应缺少 data 字段", false
	}
	return data, 0, "", true
}

// lobsteraiTokenPayload is the exchange/refresh token section.
type lobsteraiTokenPayload struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    float64
	UserID       string
	YID          string
	AccountUser  string
	Nickname     string
}

func parseLobsteraiTokenPayload(data map[string]any) *lobsteraiTokenPayload {
	if data == nil {
		data = map[string]any{}
	}
	user, _ := data["user"].(map[string]any)
	if user == nil {
		user = map[string]any{}
	}
	return &lobsteraiTokenPayload{
		AccessToken:  jsonStringField(data, "accessToken"),
		RefreshToken: jsonStringField(data, "refreshToken"),
		ExpiresIn:    jsonNumberField(data, "expiresIn"),
		UserID:       jsonStringField(user, "id"),
		YID:          jsonStringField(user, "yid"),
		AccountUser:  jsonStringField(user, "userId"),
		Nickname:     jsonStringField(user, "nickname"),
	}
}

// AccountUser alias mismatch fix — keep field name simple.
type lobsteraiTokenPayloadAlias = struct{}

// resolveLobsteraiUID falls back through user.id → user.userId → user.yid →
// sha256(accessToken)[:16] hex (byte-identical to Go's reference bridge).
func resolveLobsteraiUid(payload *lobsteraiTokenPayload) string {
	if payload == nil {
		return ""
	}
	for _, c := range []string{payload.UserID, payload.AccountUser, payload.YID} {
		if c != "" {
			return c
		}
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(payload.AccessToken)))[:16]
}

// buildLobsteraiCredential assembles the persisted credential. expires_at
// base is NOW (not JWT iat — kept identical to the reference Go bridge).
func buildLobsteraiCredential(payload *lobsteraiTokenPayload, sessionUUID, firstKeyfrom, latestKeyfrom string) *LobsteraiCredential {
	if payload == nil {
		return nil
	}
	expiresAt := ""
	if payload.ExpiresIn > 0 {
		expiresAt = fmt.Sprintf("%d", nowMillis()+int64(payload.ExpiresIn)*1000)
	} else if exp := jwtExpiresAtMs(payload.AccessToken); exp > 0 {
		expiresAt = fmt.Sprintf("%d", exp)
	}
	userID := firstNonEmpty(payload.AccountUser, payload.YID)
	return &LobsteraiCredential{
		AccessToken:   payload.AccessToken,
		RefreshToken:  payload.RefreshToken,
		ExpiresAt:     expiresAt,
		UID:           resolveLobsteraiUid(payload),
		UserID:        userID,
		Nickname:      LobsteraiDisplayNickname(payload.Nickname, ""),
		UUID:          sessionUUID,
		FirstKeyfrom:  firstKeyfrom,
		LatestKeyfrom: latestKeyfrom,
	}
}

// applyLobsteraiRefresh merges a refresh payload into the previous
// credential. ALL identity fields are kept as-is (uuid/first/latest/uid/user/
// nickname) — the refresh response carries only tokens, and latest_keyfrom is
// DELIBERATELY not updated to "now" (Go's RefreshToken never updates it;
// updating it is an unverified behavior change that could fail renewal).
func applyLobsteraiRefresh(previous *LobsteraiCredential, payload *lobsteraiTokenPayload, nowMs int64) *LobsteraiCredential {
	if previous == nil || payload == nil {
		return previous
	}
	expiresAt := previous.ExpiresAt
	if payload.ExpiresIn > 0 {
		expiresAt = fmt.Sprintf("%d", nowMs+int64(payload.ExpiresIn)*1000)
	} else if exp := jwtExpiresAtMs(payload.AccessToken); exp > 0 {
		expiresAt = fmt.Sprintf("%d", exp)
	}
	next := *previous
	next.AccessToken = payload.AccessToken
	// refresh response may omit a new refreshToken — keep the old one.
	if payload.RefreshToken != "" {
		next.RefreshToken = payload.RefreshToken
	}
	next.ExpiresAt = expiresAt
	return &next
}

// lobsteraiAnonymousHeaders: exchange/refresh carry no Authorization.
func lobsteraiAnonymousHeaders() map[string]string {
	return map[string]string{
		"Accept":       "application/json",
		"Content-Type": "application/json",
		"User-Agent":   lobsteraiProduct.UserAgent,
	}
}

// lobsteraiAuthHeaders is the four-header universal set (no X-Domain
// family — those would mis-attribute the client).
func lobsteraiAuthHeaders(cred *LobsteraiCredential, accept string) map[string]string {
	return map[string]string{
		"Authorization": "Bearer " + cred.AccessToken,
		"Accept":        accept,
		"Content-Type":  "application/json",
		"User-Agent":    lobsteraiProduct.UserAgent,
	}
}

// lobsteraiChatHeaders adds the two capability headers + SSE accept.
// Capabilities is REQUIRED for reasoning-off (thinking-level-control-v1)
// and kimi-k3 access (kimi-k3-agentic-v1) — verified 2026-09-17.
func lobsteraiChatHeaders(cred *LobsteraiCredential, clientVersion string) map[string]string {
	h := lobsteraiAuthHeaders(cred, "text/event-stream, application/json")
	h["X-LobsterAI-Client-Capabilities"] = "kimi-k3-agentic-v1,thinking-level-control-v1"
	h["X-LobsterAI-Client-Version"] = clientVersion
	return h
}

// lobsteraiModelsHeaders: same capability headers, JSON accept. These two
// headers filter the model list server-side (without them kimi-k3 vanishes).
func lobsteraiModelsHeaders(cred *LobsteraiCredential, clientVersion string) map[string]string {
	h := lobsteraiAuthHeaders(cred, "application/json")
	h["X-LobsterAI-Client-Capabilities"] = "kimi-k3-agentic-v1,thinking-level-control-v1"
	h["X-LobsterAI-Client-Version"] = clientVersion
	return h
}

// init registers the generic access_token extractor for lobsterai (its
// credential field IS access_token, matching the shape).
func init() {
	RegisterTokenExtractor("lobsterai", func(cred jsonRaw) (string, error) {
		var c LobsteraiCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", fmt.Errorf("jethub: parse lobsterai credential: %w", err)
		}
		return c.AccessToken, nil
	})
}

// randHex32 generates a UUID-form random string (callback state + idempotency key).
func lobsteraiRandomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		now := time.Now().UnixMilli()
		for i := range b {
			b[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// nowMillis is the only "current time" source (keeps call sites honest).
func nowMillis() int64 { return time.Now().UnixMilli() }

// kvPair is one query parameter.
type kvPair struct{ k, v string }

// urlValues is a tiny query builder (deterministic key order for tests).
type urlValues map[string]string

func (v urlValues) encode() string {
	pairs := make([]kvPair, 0, len(v))
	for k, val := range v {
		pairs = append(pairs, kvPair{k, val})
	}
	// insertion-stable sort by key
	for i := 1; i < len(pairs); i++ {
		for j := i; j > 0 && pairs[j].k < pairs[j-1].k; j-- {
			pairs[j], pairs[j-1] = pairs[j-1], pairs[j]
		}
	}
	var b strings.Builder
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(urlQueryEscape(p.k))
		b.WriteByte('=')
		b.WriteString(urlQueryEscape(p.v))
	}
	return b.String()
}
