package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// TRAE login flow (ref trae-oauth.ts): the callback does NOT carry a `code` —
// the authorization page posts back the token DIRECTLY as
// `?refreshToken=...&userInfo={json}&userJwt={json}`. A `code` carrying
// callback is the PARALLEL PKCE flow (recognized but unsupported, reported
// with an exact reason instead of being ruled invalid).

// traeCallbackInfo is the parsed callback (Go callback.go:66-73).
type traeCallbackInfo struct {
	RefreshToken string
	AccessToken  string // fallback when no refreshToken (userJwt.Token)
	UID          string
	Nickname     string
	EnterpriseID string // ⚠️ field name in the callback is TenantID
	AuthCode     string // PKCE flow marker (unsupported, exact-error marker)
}

// parseTraeCallbackDetailed parses the callback and reports WHY it failed.
// userInfo/userJwt are URL-encoded JSON with DOUBLE-encoded CJK (mojibake:
// Óû§8847309959) — one extra decodeURIComponent pass is tolerated.
func parseTraeCallback(rawURL string) (*traeCallbackInfo, string /*reason*/, bool /*authCodeFlow*/) {
	u, err := parseCallbackQuery(rawURL)
	if err != nil {
		return nil, "回调 URL 无法解析", false
	}
	q := u
	userInfo := traeParseJSONParam(q["userInfo"])
	userJwt := traeParseJSONParam(q["userJwt"])

	refreshToken := q["refreshToken"]
	uid := traeJSONString(userInfo, "UserID")
	nicknameRaw := traeJSONString(userInfo, "ScreenName")
	enterpriseID := traeJSONString(userInfo, "TenantID") // ⚠️ TenantID here

	jwtToken := traeJSONString(userJwt, "Token")
	jwtRefresh := traeJSONString(userJwt, "RefreshToken")
	if refreshToken == "" {
		refreshToken = jwtRefresh // login.sh:165-166 fallback
	}

	// PKCE shape: code / authCode / authCodeInfo.code|authCode|raw.
	authCodeInfo := traeParseJSONParam(q["authCodeInfo"])
	authCode := firstNonEmpty(
		q["code"], q["authCode"],
		traeJSONString(authCodeInfo, "code"),
		traeJSONString(authCodeInfo, "authCode"),
		q["authCodeInfo"],
	)
	accessToken := ""
	if refreshToken == "" {
		accessToken = jwtToken // only used without refreshToken
	}

	info := &traeCallbackInfo{
		RefreshToken: refreshToken, AccessToken: accessToken,
		UID: uid, Nickname: fixNicknameMojibake(nicknameRaw, uid),
		EnterpriseID: enterpriseID,
	}
	if authCode != "" {
		info.AuthCode = authCode
	}
	if info.RefreshToken == "" && info.AccessToken == "" {
		if authCode != "" {
			// A LEGAL callback via the unsupported PKCE branch — name it, do not
			// rule it invalid (the wrong error points debugging completely off).
			return nil, "上游返回了 PKCE 授权码（code/authCodeInfo），本实现暂不支持该流程", true
		}
		return nil, "回调未携带 refreshToken / userJwt.Token / code", false
	}
	return info, "", false
}

// parseCallbackQuery parses a full or relative callback URL into its query.
func parseCallbackQuery(rawURL string) (map[string]string, error) {
	if !strings.Contains(rawURL, "://") {
		rawURL = "http://127.0.0.1" + rawURL
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for k, vs := range u.Query() {
		if len(vs) > 0 {
			out[k] = vs[0]
		}
	}
	return out, nil
}

func firstNonEmptyFloat(vals ...float64) float64 {
	for _, v := range vals {
		if v != 0 {
			return v
		}
	}
	return 0
}

// traeParseJSONParam parses a URL-encoded JSON param with a tolerated extra
// decodeURIComponent pass (double-coded CJK nicknames).
func traeParseJSONParam(raw string) map[string]any {
	if raw == "" {
		return nil
	}
	candidates := []string{raw}
	if dec, err := url.QueryUnescape(raw); err == nil && dec != raw {
		candidates = append(candidates, dec)
	}
	for _, cand := range candidates {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(cand), &parsed); err == nil {
			return parsed
		}
	}
	return nil
}

func traeJSONString(src map[string]any, key string) string {
	if src == nil {
		return ""
	}
	if s, ok := src[key].(string); ok {
		return s
	}
	if f, ok := src[key].(float64); ok {
		return fmt.Sprintf("%v", f)
	}
	return ""
}

// fixNicknameMojibake repairs the latin-1/cp1252 double-encoding of the
// callback ScreenName; when unfixable and CJK-free, fall back to 用户+uid末4.
func fixNicknameMojibake(raw, uid string) string {
	if raw == "" {
		return raw
	}
	// latin1→utf8 re-decode: bytes interpreted as latin1 are re-encoded.
	fixed := latin1ToUTF8(raw)
	if fixed != raw && !strings.ContainsRune(fixed, '\uFFFD') && isPrintable(fixed) {
		return fixed
	}
	if !containsCJK(raw) {
		return "用户" + tailString(uid, 4)
	}
	return raw
}

// latin1ToUTF8 treats each byte of raw as a latin-1 rune and re-encodes.
func latin1ToUTF8(raw string) string {
	bytes := []byte(raw)
	needsFix := false
	for _, b := range bytes {
		if b >= 0x80 {
			needsFix = true // multibyte utf8 sequence misread as latin1
		}
	}
	if !needsFix {
		return raw
	}
	// The reference re-decodes with Buffer.from(latin1).toString('utf8'):
	// i.e. treat the string bytes as a UTF-8 sequence if valid.
	if isValidUTF8(bytes) {
		return string(bytes)
	}
	return raw
}

func isValidUTF8(b []byte) bool {
	for i := 0; i < len(b); {
		c := b[i]
		switch {
		case c < 0x80:
			i++
		case c&0xE0 == 0xC0:
			if i+1 >= len(b) || b[i+1]&0xC0 != 0x80 {
				return false
			}
			i += 2
		case c&0xF0 == 0xE0:
			if i+2 >= len(b) || b[i+1]&0xC0 != 0x80 || b[i+2]&0xC0 != 0x80 {
				return false
			}
			i += 3
		case c&0xF8 == 0xF0:
			if i+3 >= len(b) || b[i+1]&0xC0 != 0x80 || b[i+2]&0xC0 != 0x80 || b[i+3]&0xC0 != 0x80 {
				return false
			}
			i += 4
		default:
			return false
		}
	}
	return true
}

func isPrintable(s string) bool {
	for _, r := range s {
		if r < 32 {
			return false
		}
	}
	return true
}

func containsCJK(s string) bool {
	for _, r := range s {
		if r >= 0x4E00 && r <= 0x9FFF {
			return true
		}
	}
	return false
}

func tailString(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[len(r)-n:])
}

// traeExchangeResult is the ExchangeToken Result section.
type traeExchangeResult struct {
	AccessToken     string
	RefreshToken    string
	TokenExpireAt   float64
	TokenExpireDur  float64
	RefreshExpireAt float64
}

// parseTraeExchangeResponse reads `{Result:{Token,TokenExpireAt,...}}`.
func parseTraeExchangeResponse(data map[string]any) *traeExchangeResult {
	if data == nil {
		return nil
	}
	result, _ := data["Result"].(map[string]any)
	if result == nil {
		result, _ = data["result"].(map[string]any)
	}
	if result == nil {
		return nil
	}
	access := firstNonEmpty(
		traeJSONString(result, "Token"),
		traeJSONString(result, "token"),
		traeJSONString(result, "accessToken"),
	)
	if access == "" {
		return nil
	}
	return &traeExchangeResult{
		AccessToken:     access,
		RefreshToken:    firstNonEmpty(traeJSONString(result, "RefreshToken"), traeJSONString(result, "refreshToken")),
		TokenExpireAt:   firstNonEmptyFloat(jsonNumberField(result, "TokenExpireAt"), jsonNumberField(result, "tokenExpireAt")),
		TokenExpireDur:  firstNonEmptyFloat(jsonNumberField(result, "TokenExpireDuration"), jsonNumberField(result, "tokenExpireDuration")),
		RefreshExpireAt: firstNonEmptyFloat(jsonNumberField(result, "RefreshExpireAt"), jsonNumberField(result, "refreshExpireAt")),
	}
}

// traeUserInfoResult is the GetUserInfo Result section.
type traeUserInfoResult struct {
	UID          string
	ScreenName   string
	EnterpriseID string
	Phone        string // NonPlainTextMobile (disambiguator!)
	Email        string // NonPlainTextEmail
}

func parseTraeUserInfoResponse(data map[string]any) *traeUserInfoResult {
	if data == nil {
		return nil
	}
	result, _ := data["Result"].(map[string]any)
	if result == nil {
		result, _ = data["result"].(map[string]any)
	}
	if result == nil {
		return nil
	}
	uid := firstNonEmpty(
		traeJSONString(result, "UserID"), traeJSONString(result, "userId"), traeJSONString(result, "uid"),
	)
	if uid == "" {
		return nil
	}
	return &traeUserInfoResult{
		UID:          uid,
		ScreenName:   firstNonEmpty(traeJSONString(result, "ScreenName"), traeJSONString(result, "screenName"), uid),
		EnterpriseID: firstNonEmpty(traeJSONString(result, "EnterpriseID"), traeJSONString(result, "enterpriseId")),
		// ⚠️ Field names are NonPlainTextMobile/NonPlainTextEmail — verified
		// on four real accounts (2026-09-27).
		Phone: firstNonEmpty(traeJSONString(result, "NonPlainTextMobile"), traeJSONString(result, "nonPlainTextMobile")),
		Email: firstNonEmpty(traeJSONString(result, "NonPlainTextEmail"), traeJSONString(result, "nonPlainTextEmail")),
	}
}

// traeExpiryNormalizes applies the Go normalizeExpiresAt ordering:
// absolute(ms|s) → relative duration → JWT exp.
func traeExpiryString(exchange *traeExchangeResult, nowMs int64) string {
	if exchange.TokenExpireAt > 1e12 {
		return fmt.Sprintf("%d", int64(exchange.TokenExpireAt))
	}
	if exchange.TokenExpireAt > 0 {
		return fmt.Sprintf("%d", int64(exchange.TokenExpireAt)*1000)
	}
	if exchange.TokenExpireDur > 0 {
		return fmt.Sprintf("%d", nowMs+int64(exchange.TokenExpireDur)*1000)
	}
	if exp := jwtExpiresAtMs(exchange.AccessToken); exp > 0 {
		return fmt.Sprintf("%d", exp)
	}
	return ""
}

// buildTraeCredential assembles the credential (machine/device ids come from
// the login session, never from a response).
func buildTraeCredential(exchange *traeExchangeResult, userInfo *traeUserInfoResult, machineID, deviceID string, nowMs int64) *TraeCredential {
	cred := &TraeCredential{
		AccessToken:  exchange.AccessToken,
		RefreshToken: exchange.RefreshToken,
		ExpiresAt:    traeExpiryString(exchange, nowMs),
		UID:          userInfo.UID,
		Nickname:     userInfo.ScreenName,
		MachineID:    machineID,
		DeviceID:     deviceID,
		Enterprise:   userInfo.EnterpriseID,
	}
	cred.Phone = userInfo.Phone
	cred.Email = userInfo.Email
	return cred
}

// TraeDisplayNickname: phone → email → ScreenName → uid → fallbackId.
// ScreenName is auto-generated (用户+uid) and indistinguishable across
// accounts; the masked mobile is the only usable disambiguator.
func TraeDisplayNickname(phone, email, nickname, uid, fallbackID string) string {
	return firstNonEmpty(trimSpaces(phone), trimSpaces(email), trimSpaces(nickname), trimSpaces(uid), fallbackID)
}

// exchangeTraeCallback turns the callback info into a credential:
// (1) refreshToken → ExchangeToken (rotating tokens);
// (2) no refreshToken → userJwt.Token fallback, no exchange;
// then GetUserInfo fills uid/nickname/enterprise/phone — FAILURES DO NOT
// BLOCK (fallback to the callback userInfo, login.sh:197-209).
func (m *Manager) exchangeTraeCallback(ctx context.Context, callback *traeCallbackInfo, machineID, deviceID string, nowMs int64) (*TraeCredential, error) {
	var exchange *traeExchangeResult
	if callback.RefreshToken != "" {
		body, err := json.Marshal(map[string]any{
			"ClientID": traeProduct.ClientID, "RefreshToken": callback.RefreshToken,
			"ClientSecret": "-", "UserID": "",
		})
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost,
			traeOAuthHost+traeExchangePath, strReader(string(body)))
		if err != nil {
			return nil, err
		}
		for k, v := range traeOAuthHeaders() {
			req.Header.Set(k, v)
		}
		tctx, cancel := context.WithTimeout(ctx, traeRequestTimeout)
		defer cancel()
		req = req.WithContext(tctx)
		resp, err := m.httpClient("trae").Do(req)
		if err != nil {
			return nil, fmt.Errorf("TRAE ExchangeToken 失败：%w", err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			snippet := string(raw)
			if len(snippet) > 200 {
				snippet = snippet[:200]
			}
			return nil, fmt.Errorf("TRAE ExchangeToken 失败（HTTP %d）：%s", resp.StatusCode, snippet)
		}
		var parsed map[string]any
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return nil, fmt.Errorf("TRAE ExchangeToken 响应不是 JSON")
		}
		exchange = parseTraeExchangeResponse(parsed)
		if exchange == nil {
			return nil, fmt.Errorf("TRAE ExchangeToken 响应缺少 Token")
		}
	} else {
		// Branch 2: no refreshToken — use userJwt.Token verbatim.
		exchange = &traeExchangeResult{AccessToken: callback.AccessToken}
	}

	// GetUserInfo; failures fall back to the callback userInfo.
	userInfo := &traeUserInfoResult{
		UID: callback.UID, ScreenName: callback.Nickname,
		EnterpriseID: callback.EnterpriseID,
		// The callback userInfo does NOT carry masked phone/email (only in
		// GetUserInfo) — empty here, filled by the GetUserInfo branch.
	}
	uHeaders := traeOAuthHeaders()
	uHeaders["X-Cloudide-Token"] = exchange.AccessToken
	reqBody, _ := json.Marshal(map[string]any{"ReqSource": "IDE", "IDEVersion": traeProduct.AppVersion})
	req2, err := http.NewRequestWithContext(ctx, http.MethodPost,
		traeOAuthHost+traeUserInfoPath, strReader(string(reqBody)))
	if err != nil {
		return nil, err
	}
	for k, v := range uHeaders {
		req2.Header.Set(k, v)
	}
	resp2, err := m.httpClient("trae").Do(req2)
	if err == nil {
		raw, _ := io.ReadAll(io.LimitReader(resp2.Body, 1<<20))
		resp2.Body.Close()
		var parsed map[string]any
		if json.Unmarshal(raw, &parsed) == nil {
			if fetched := parseTraeUserInfoResponse(parsed); fetched != nil {
				// GetUserInfo 成功 → 整体采信（uid 也是权威；ref 逐字段替换）。
				userInfo.UID = fetched.UID
				if fetched.ScreenName != "" {
					userInfo.ScreenName = fetched.ScreenName
				}
				if fetched.EnterpriseID != "" {
					userInfo.EnterpriseID = fetched.EnterpriseID
				}
				userInfo.Phone = fetched.Phone
				userInfo.Email = fetched.Email
			}
		}
	}

	if userInfo.UID == "" {
		return nil, fmt.Errorf("TRAE 未能确定 uid（回调 userInfo 与 GetUserInfo 均为空）")
	}
	if exchange.AccessToken == "" {
		return nil, fmt.Errorf("TRAE 换 token 后没有 accessToken")
	}
	return buildTraeCredential(exchange, userInfo, machineID, deviceID, nowMs), nil
}
