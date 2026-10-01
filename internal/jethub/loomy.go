package jethub

import (
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Loomy (讯飞) protocol constants — 1:1 from ref loomy.ts / loomy-product.ts /
// loomy-oauth.ts / loomy-sign.ts / loomy-credits.ts / loomy-onboarding.ts.
// Distinctive: SMS-code login (NO renewal — refreshable is honestly false;
// expire:1209600 only DECLARES a 14-day TTL), CAccount HMAC-SHA1 signing,
// business envelope code is a STRING ('000000' ok), and business failures
// always arrive as HTTP 200.
const (
	loomyAPIBase     = "https://loomyad.xunfei.cn/api/v1"
	loomyAccountBase = "https://account.xfinfr.com"
	loomyOKCode      = "000000"
	loomyAuthCode    = "100002"
	loomyBadReqCode  = "100001"
	loomyTimeout     = 60 * time.Second
	loomySMSTTL      = 300
	// loomySessionTTL: 14 days — the login request's `expire` parameter; the
	// server response carries NO expiry, so expires_at is locally computed.
	loomySessionTTL = 1_209_600
)

// loomyProduct is the product config (AccessKey only signs CAccount SMS
// endpoints; leaks touch no user data).
var loomyProduct = &loomyConfig{
	APIBase: loomyAPIBase, AccountBase: loomyAccountBase,
	AccessKeyID: "2thryby66wxi53sk", AccessKeySecret: "zsak6eadrbawz683wf5r3m2snrwj868r",
	AppID: "GM3LOOMY",
}

type loomyConfig struct {
	APIBase        string
	AccountBase    string
	AccessKeyID    string
	AccessKeySecret string
	AppID          string
}

// LoomyCredential mirrors ref loomy.ts. access_token = the 32-hex session.
type LoomyCredential struct {
	AccessToken string `json:"access_token"`
	UserID      string `json:"userid"`
	Phone       string `json:"phone"`
	Nickname    string `json:"nickname,omitempty"`
	// ExpiresAt: ms string — locally computed (login + 14 days), NOT from the
	// server.
	ExpiresAt string `json:"expires_at,omitempty"`
}

// LoomyRefreshable is HONESTLY FALSE — no refresh endpoint exists; pretending
// otherwise would show "renewing" while every attempt fails.
func LoomyRefreshable() bool { return false }

// parseLoomyEnvelope: business failures are ALWAYS HTTP 200 — only the body
// `code` (string '000000') decides; a status-only reading would misjudge
// expired credentials as success.
func parseLoomyEnvelope(payload map[string]any) (data map[string]any, code, message string, ok bool) {
	if payload == nil {
		return nil, "", "响应不是 JSON 对象", false
	}
	code = jsonStringField(payload, "code")
	message = firstNonEmpty(jsonStringField(payload, "desc"), jsonStringField(payload, "message"))
	if code != loomyOKCode {
		return nil, code, firstNonEmpty(message, "业务错误 "+firstNonEmpty(code, "(缺少 code)")), false
	}
	data, _ = payload["data"].(map[string]any)
	return data, code, message, true
}

// loomyBusinessHeaders: ⚠️ business endpoints read ONLY the lowercase `token`
// header; Authorization: Bearer gets judged "缺少 token" — deliberately absent.
func loomyBusinessHeaders(token string) map[string]string {
	return map[string]string{"Accept": "application/json", "token": token}
}

// loomyChatHeaders: BOTH headers are sent (the official client sends both in
// session mode; keeping parity avoids upstream judgement changes). ⚠️ The
// `Bearer ` prefix is required (bare token also 100002s).
func loomyChatHeaders(token string) map[string]string {
	return map[string]string{
		"Accept": "text/event-stream", "Content-Type": "application/json",
		"Authorization": "Bearer " + token, "token": token,
	}
}

// --- CAccount HMAC-SHA1 signing (ref loomy-sign.ts, byte-exact) ---

// loomyContentMd5: ⚠️ an EMPTY body returns "" (NOT the md5 of "").
func loomyContentMd5(body string) string {
	if body == "" {
		return ""
	}
	sum := md5.Sum([]byte(body))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// escapeRFC3986: encodeURIComponent + the !'()* supplement.
func escapeRFC3986(value string) string {
	v := urlQueryEscape(value)
	v = strings.ReplaceAll(v, "!", "%21")
	v = strings.ReplaceAll(v, "'", "%27")
	v = strings.ReplaceAll(v, "(", "%28")
	v = strings.ReplaceAll(v, ")", "%29")
	v = strings.ReplaceAll(v, "*", "%2A")
	return v
}

// buildEscapedPath: leading /, trailing / stripped (len>1), per-segment escape.
func buildEscapedPath(rawPath string) string {
	clean := rawPath
	if !strings.HasPrefix(clean, "/") {
		clean = "/" + clean
	}
	if len(clean) > 1 && strings.HasSuffix(clean, "/") {
		clean = clean[:len(clean)-1]
	}
	segs := strings.Split(clean, "/")
	for i, seg := range segs {
		if seg != "" {
			segs[i] = escapeRFC3986(seg)
		}
	}
	return strings.Join(segs, "/")
}

// buildEscapedQueryString: key=value&… NOT sorted (insertion order), both
// escaped; empty values become "".
func buildEscapedQueryString(query map[string]string) string {
	if len(query) == 0 {
		return ""
	}
	pairs := make([]string, 0, len(query))
	for k, v := range query {
		pairs = append(pairs, escapeRFC3986(k)+"="+escapeRFC3986(v))
	}
	return strings.Join(pairs, "&")
}

// BuildLoomySigningString — 9 segments joined by \n; the last two (signed
// headers, canonicalized headers) are ALWAYS empty (we send no x-* headers),
// so the string ENDS WITH TWO NEWLINES. Dropping them breaks the signature.
func BuildLoomySigningString(accessKeyID, method, path string, query map[string]string, body, contentType, date, nonce string) string {
	return strings.Join([]string{
		strings.ToUpper(method),
		buildEscapedPath(path),
		buildEscapedQueryString(query),
		loomyContentMd5(body),
		contentType,
		date,
		nonce,
		"", // signedHeaders (empty by design)
		"", // canonicalizedHeaders (empty by design)
	}, "\n")
}

// loomyAuthHeaders computes the complete CAccount request headers. ⚠️ The
// body sent MUST be the same string that was signed — marshal once, share.
func loomyAuthHeaders(cfg *loomyConfig, method, path string, query map[string]string, body, contentType string) map[string]string {
	if contentType == "" {
		contentType = "application/json"
	}
	date := time.Now().UTC().Format(time.RFC1123)
	nonce := loomyUUID32()
	stringToSign := BuildLoomySigningString(cfg.AccessKeyID, method, path, query, body, contentType, date, nonce)
	mac := hmac.New(sha1.New, []byte(cfg.AccessKeySecret))
	mac.Write([]byte(stringToSign))
	sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	headers := map[string]string{
		"Authorization": "account " + cfg.AccessKeyID + ":" + sig,
		"Date":          date,
		"Nonce":         nonce,
		"Content-Type":  contentType,
	}
	if md5v := loomyContentMd5(body); md5v != "" {
		headers["Content-MD5"] = md5v
	}
	return headers
}

// loomyUUID32 is a dash-less UUID (32 hex).
func loomyUUID32() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		now := nowMillis()
		for i := range b {
			b[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	return hex.EncodeToString(b[:])
}

// BuildLoomyAccountBody: the `{base,param}` envelope. `traceid` regenerates
// per call; `ua` is hardcoded macOS (the client sends it on Windows too).
func BuildLoomyAccountBody(param map[string]any) map[string]any {
	return map[string]any{
		"base": map[string]any{
			"appid": loomyProduct.AppID, "modelid": "Web", "version": "1.0.0",
			"devid": "web", "ua": "Loomy|Desktop|Electron|macOS", "traceid": loomyUUID32(),
		},
		"param": param,
	}
}

// postLoomyAccount posts one CAccount request (marshal ONCE, sign and send
// the same string). Business errors surface the server desc.
func (m *Manager) postLoomyAccount(ctx context.Context, path string, param map[string]any) (map[string]any, error) {
	body, err := json.Marshal(BuildLoomyAccountBody(param))
	if err != nil {
		return nil, err
	}
	serialized := string(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, loomyProduct.AccountBase+path, strReader(serialized))
	if err != nil {
		return nil, err
	}
	for k, v := range loomyAuthHeaders(loomyProduct, "POST", path, nil, serialized, "application/json") {
		req.Header.Set(k, v)
	}
	tctx, cancel := context.WithTimeout(ctx, loomyTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("讯飞账号请求失败（%s）：%w", path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("讯飞账号响应不是 JSON（%s，HTTP %d）", path, resp.StatusCode)
	}
	data, _, message, ok := parseLoomyEnvelope(parsed)
	if !ok {
		return nil, fmt.Errorf("%s", firstNonEmpty(message, "讯飞账号请求失败（"+path+"）"))
	}
	return data, nil
}

// SendLoomySmsCode requests the SMS code; returns the msgid that the submit
// step MUST echo back. ⚠️ An empty msgid is an error (a blind submit would
// fail with an unrelated "msgid 无效").
func (m *Manager) SendLoomySmsCode(ctx context.Context, phone string) (string, error) {
	data, err := m.postLoomyAccount(ctx, "/login/phone/sendMsgCode", map[string]any{
		"ccode": "86", "phone": phone, "expire": loomySMSTTL,
	})
	if err != nil {
		return "", err
	}
	msgid := jsonStringField(data, "msgid")
	if msgid == "" {
		return "", fmt.Errorf("短信验证码响应缺少 msgid")
	}
	return msgid, nil
}

// LoomyLoginResult is the SMS login outcome.
type LoomyLoginResult struct {
	Session string
	UserID  string
}

// LoginLoomyBySmsCode completes the SMS login ({session,userid}).
func (m *Manager) LoginLoomyBySmsCode(ctx context.Context, phone, code, msgid string) (*LoomyLoginResult, error) {
	data, err := m.postLoomyAccount(ctx, "/login/phone/checkCode", map[string]any{
		"ccode": "86", "phone": phone, "mcode": code, "msgid": msgid, "expire": loomySessionTTL,
	})
	if err != nil {
		return nil, err
	}
	session := jsonStringField(data, "session")
	userid := jsonStringField(data, "userid")
	if session == "" {
		return nil, fmt.Errorf("登录响应缺少 session")
	}
	if userid == "" {
		return nil, fmt.Errorf("登录响应缺少 userid")
	}
	return &LoomyLoginResult{Session: session, UserID: userid}, nil
}

// BuildLoomyCredential assembles the persisted credential (expires_at locally
// computed).
func BuildLoomyCredential(session, userid, phone, nickname string) *LoomyCredential {
	return &LoomyCredential{
		AccessToken: session, UserID: userid, Phone: phone, Nickname: nickname,
		ExpiresAt: fmt.Sprintf("%d", nowMillis()+loomySessionTTL*1000),
	}
}

// LoomyExpiresAtMs parses expires_at (ms string); unknown → 0 (NOT judged
// expired — a maybe-stale credential is tried; 100002 is recognizable).
func LoomyExpiresAtMs(cred *LoomyCredential) int64 {
	if raw := strings.TrimSpace(cred.ExpiresAt); raw != "" && isAllDigits(raw) {
		return parsePositiveInt(raw)
	}
	return 0
}

// probeLoomyCredential verifies a credential WITHOUT renewing (GET
// points/records pageSize=1 — cheapest read-only endpoint; 100002 = terminal
// re-login; transport errors are NOT terminal).
func (m *Manager) probeLoomyCredential(ctx context.Context, cred *LoomyCredential) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		loomyProduct.APIBase+"/points/records?pageNo=1&pageSize=1&recordType=all", nil)
	if err != nil {
		return err
	}
	for k, v := range loomyBusinessHeaders(cred.AccessToken) {
		req.Header.Set(k, v)
	}
	resp, err := m.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("Loomy 凭据探测网络失败：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return fmt.Errorf("Loomy 凭据探测响应不是 JSON（HTTP %d）", resp.StatusCode)
	}
	_, _, message, ok := parseLoomyEnvelope(parsed)
	if ok {
		return nil
	}
	if message != "" && strings.Contains(jsonStringField(parsed, "code"), loomyAuthCode) {
		return ErrRefreshTokenExpired
	}
	return fmt.Errorf("Loomy 凭据探测失败：%s", message)
}

// init registers the loomy token extractor (access_token IS the session).
func init() {
	RegisterTokenExtractor("loomy", func(cred jsonRaw) (string, error) {
		var c LoomyCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", fmt.Errorf("jethub: parse loomy credential: %w", err)
		}
		return c.AccessToken, nil
	})
}
