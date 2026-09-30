package jethub

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// JWT claim readers (base64url decode only — no signature verification; the
// values feed display and refresh scheduling exactly like the plugin).
func jwtClaimMs(token, key string) int64 {
	v := jwtClaimNumber(token, key)
	if v <= 0 {
		return 0
	}
	return int64(v) * 1000
}

func jwtClaimNumber(token, key string) float64 {
	payload := jwtPayload(token)
	if payload == nil {
		return 0
	}
	switch v := payload[key].(type) {
	case float64:
		return v
	default:
		return 0
	}
}

func jwtClaimString(token, key string) string {
	payload := jwtPayload(token)
	if payload == nil {
		return ""
	}
	s, _ := payload[key].(string)
	return stripControlChars(s)
}

func jwtPayload(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil
	}
	return payload
}

// stripControlChars removes control characters and collapses whitespace
// (CodeBuddy's scope field carries newlines that break JSON-in-YAML).
func stripControlChars(value string) string {
	var b strings.Builder
	space := false
	for _, r := range value {
		if r <= 0x1F || r == 0x7F {
			b.WriteRune(' ')
			space = true
			continue
		}
		b.WriteRune(r)
		space = false
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	_ = space
	return out
}

// parseISOTime accepts ISO-ish timestamps; 0 on failure.
func parseISOTime(raw string) int64 {
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.UnixMilli()
		}
	}
	return 0
}

// --- Buddy control-plane requests (ref buddy-oauth.ts) ---

// buddyStateResult is POST auth/state's outcome.
type buddyStateResult struct {
	State   string
	AuthURL string
}

func buddyPostJSON(ctx context.Context, client *http.Client, url string, headers map[string]string, body string) (int, map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strReader(body))
	if err != nil {
		return 0, nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return 0, nil, err
	}
	var out map[string]any
	_ = json.Unmarshal(data, &out) // non-JSON bodies (HTML error pages) → nil map
	return resp.StatusCode, out, nil
}

func buddyGetJSON(ctx context.Context, client *http.Client, url string, headers map[string]string) (int, map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return 0, nil, err
	}
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return resp.StatusCode, out, nil
}

func bodyCode(body map[string]any) int64 {
	if body == nil {
		return 0
	}
	f, _ := body["code"].(float64)
	return int64(f)
}

func bodyMessage(body map[string]any) string {
	if body == nil {
		return ""
	}
	s, _ := body["message"].(string)
	return s
}

func bodyData(body map[string]any) map[string]any {
	if body == nil {
		return nil
	}
	if d, ok := body["data"].(map[string]any); ok {
		return d
	}
	return nil
}

// BuddyFetchAuthState obtains state + authUrl (no auth required).
func BuddyFetchAuthState(ctx context.Context, client *http.Client, p *BuddyProduct) (*buddyStateResult, error) {
	url := p.Endpoint + buddyAuthStatePath + "?platform=" + p.Platform
	headers := map[string]string{
		buddyHeaderDomain:          p.APIDomain,
		buddyHeaderNoAuthorization: "true",
		buddyHeaderNoUserID:        "true",
		buddyHeaderNoEnterpriseID:  "true",
		buddyHeaderNoDeptInfo:      "true",
		"User-Agent":               p.UserAgent,
	}
	tctx, cancel := context.WithTimeout(ctx, buddyStateReqTimeout)
	defer cancel()
	status, body, err := buddyPostJSON(tctx, client, url, headers, "")
	if err != nil {
		return nil, fmt.Errorf("jethub: buddy auth/state network error: %w", err)
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("jethub: buddy auth/state HTTP %d: %s", status, bodyMessage(body))
	}
	data := bodyData(body)
	if data == nil {
		return nil, fmt.Errorf("jethub: buddy auth/state response missing data")
	}
	state, _ := data["state"].(string)
	authURL, _ := data["authUrl"].(string)
	if state == "" {
		return nil, fmt.Errorf("jethub: buddy auth/state missing state")
	}
	if authURL == "" {
		return nil, fmt.Errorf("jethub: buddy auth/state missing authUrl")
	}
	return &buddyStateResult{State: state, AuthURL: authURL}, nil
}

// DecorateBuddyLoginURL appends version/loginSessionId for WorkBuddy.
func DecorateBuddyLoginURL(authURL string, p *BuddyProduct) string {
	if !p.AppendSession {
		return authURL
	}
	sep := "?"
	if strings.Contains(authURL, "?") {
		sep = "&"
	}
	sum := sha256.Sum256([]byte(authURL + time.Now().Format(time.RFC3339Nano)))
	return fmt.Sprintf("%s%sversion=%s&loginSessionId=%s", authURL, sep, p.PluginVersion, hex.EncodeToString(sum[:8]))
}

// BuddyTokenData is the token payload from auth/token & auth/token/refresh.
type BuddyTokenData struct {
	AccessToken     string
	RefreshToken    string
	ExpiresAt       string
	RefreshExpireAt string
	TokenType       string
	Scope           string
	Domain          string
}

// absoluteBuddyExpiry normalizes absolute or relative expiry to a ms
// timestamp string (JWT iat/exp preferred as the base).
func absoluteBuddyExpiry(data map[string]any, absoluteKey, relativeKey, accessToken string) string {
	raw := jsonStringField(data, absoluteKey)
	if raw != "" {
		if isAllDigits(raw) {
			n := parsePositiveInt(raw)
			if n > 1_000_000_000_000 {
				return fmt.Sprintf("%d", n)
			}
			return fmt.Sprintf("%d", n*1000)
		}
		if ms := parseISOTime(raw); ms > 0 {
			return fmt.Sprintf("%d", ms)
		}
		return raw
	}
	rel := jsonNumberField(data, relativeKey)
	if rel == 0 {
		return ""
	}
	base := jwtIssuedAtMs(accessToken)
	if base == 0 {
		base = time.Now().UnixMilli()
	}
	return fmt.Sprintf("%d", base+int64(rel*1000))
}

func jsonStringField(data map[string]any, key string) string {
	if data == nil {
		return ""
	}
	if s, ok := data[key].(string); ok {
		return stripControlChars(s)
	}
	if f, ok := data[key].(float64); ok {
		return fmt.Sprintf("%v", f)
	}
	return ""
}

func jsonNumberField(data map[string]any, key string) float64 {
	if data == nil {
		return 0
	}
	if f, ok := data[key].(float64); ok {
		return f
	}
	if s, ok := data[key].(string); ok && isAllDigits(s) {
		return float64(parsePositiveInt(s))
	}
	return 0
}

// ParseBuddyTokenData parses the token payload (relative expiresIn handled).
func ParseBuddyTokenData(data map[string]any) *BuddyTokenData {
	if data == nil {
		data = map[string]any{}
	}
	tokenType := jsonStringField(data, "tokenType")
	access := jsonStringField(data, "accessToken")
	return &BuddyTokenData{
		AccessToken:     access,
		RefreshToken:    jsonStringField(data, "refreshToken"),
		ExpiresAt:       absoluteBuddyExpiry(data, "expiresAt", "expiresIn", access),
		RefreshExpireAt: absoluteBuddyExpiry(data, "refreshExpiresAt", "refreshExpiresIn", access),
		TokenType:       firstNonEmpty(tokenType, "Bearer"),
		Scope:           jsonStringField(data, "scope"),
		Domain:          jsonStringField(data, "domain"),
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// BuddyAccountData is the login/account payload.
type BuddyAccountData struct {
	UID          string
	Nickname     string
	EnterpriseID string
	AccountType  string
}

// ParseBuddyAccountData parses the account payload.
func ParseBuddyAccountData(data map[string]any) *BuddyAccountData {
	if data == nil {
		data = map[string]any{}
	}
	at := jsonStringField(data, "type")
	return &BuddyAccountData{
		UID:          jsonStringField(data, "uid"),
		Nickname:     jsonStringField(data, "nickname"),
		EnterpriseID: jsonStringField(data, "enterpriseId"),
		AccountType:  firstNonEmpty(at, "personal"),
	}
}

// BuildBuddyCredential assembles the persisted credential. Nickname fallback:
// account.nickname → JWT nickname → preferred_username (login/account's
// nickname is usually empty — verified e2e in the plugin).
func BuildBuddyCredential(token *BuddyTokenData, account *BuddyAccountData) *BuddyCredential {
	nickname := firstNonEmpty(account.Nickname, jwtNickname(token.AccessToken))
	uid := firstNonEmpty(account.UID, jwtSubject(token.AccessToken))
	return &BuddyCredential{
		AccessToken:     token.AccessToken,
		RefreshToken:    token.RefreshToken,
		ExpiresAt:       token.ExpiresAt,
		RefreshExpireAt: token.RefreshExpireAt,
		TokenType:       token.TokenType,
		Scope:           token.Scope,
		Domain:          token.Domain,
		UserID:          uid,
		Nickname:        nickname,
		EnterpriseID:    account.EnterpriseID,
		AccountType:     account.AccountType,
	}
}
