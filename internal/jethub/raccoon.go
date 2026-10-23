package jethub

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Raccoon (商汤小浣熊) protocol constants — 1:1 from ref raccoon.ts /
// raccoon-product.ts / raccoon-oauth.ts / raccoon-credits.ts.
// Distinctive: WeChat QR scan login (client-generated 32-hex code), AES-128-
// CFB phone transport encryption (public constant, not a security boundary),
// `extra_body.thinking` as the ONLY working reasoning channel.
const (
	raccoonLLMPrefix     = "/api/web/llm/v2"
	raccoonPointsPrefix  = "/api/web/points/v1"
	raccoonDesktopPrefix = "/api/web/desktop/v1"
	raccoonChatPath      = raccoonLLMPrefix + "/chat/completions"
	raccoonModelCatalog  = raccoonLLMPrefix + "/model_catalog"
	raccoonBalancePath   = raccoonPointsPrefix + "/balance"
	raccoonGrantReward   = raccoonDesktopPrefix + "/login/points/grant"
	// raccoonPhoneCipherSecret: 公开常量（客户端逆向所得，非安全边界）。
	raccoonPhoneCipherSecret = "senseraccoon2023"
	raccoonRequestTimeout    = 60 * time.Second
	raccoonQRPollInterval    = 2 * time.Second
	raccoonLoginTimeout      = 5 * time.Minute
	raccoonUserAgent         = "Raccoon Work/1.0.35 (Windows)"
	raccoonClientPlatform    = "desktop-windows"
	raccoonClientVersion     = "v1.0.35"
)

// raccoonAPIBase is a var so tests can repoint it at a mock server.
var raccoonAPIBase = "https://xiaohuanxiong.com"

// SetRaccoonAPIBaseForTest repoints the upstream base and returns the restore
// func. It exists because the API-layer tests (a different package) need the
// same hermetic mock-server treatment: 登录流程会真的发请求，单测里必须能拦。
func SetRaccoonAPIBaseForTest(base string) func() {
	old := raccoonAPIBase
	raccoonAPIBase = base
	return func() { raccoonAPIBase = old }
}

// raccoonInferURL is the FULL chat-completions endpoint. ⚠️ 不能只靠
// Product.BaseURL：它填的是 host 根（目录/积分等端点的公共前缀），而
// urlutil.BuildUpstreamURL 会按进站路径拼出 {host}/v1/chat/completions ——
// 实测被 nginx 回 405 Not Allowed（用户 trace r28I5FsAVgWK-2），真实端点是
// {base}/api/web/llm/v2/chat/completions（ref raccoon-adapter.ts）。故
// Manager.Customize 用本函数覆盖出站 URL。
func raccoonInferURL() string { return raccoonAPIBase + raccoonChatPath }

// raccoonAuthPrefix is a var (same test hook rationale).
var raccoonAuthPrefix = "/api/web/auth/v1"

// QR 状态机状态值。
const (
	raccoonQRStatusPending  = "pending"
	raccoonQRStatusLogging  = "logging"
	raccoonQRStatusCanceled = "canceled"
	raccoonQRStatusSuccess  = "success"
)

// RaccoonCredential mirrors ref raccoon.ts. access_token is the shared
// identity field name (findAccountIdByCredential reads it for non-codearts).
type RaccoonCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	// ExpiresAt: ms string derived from the JWT exp; the JWT fallback is
	// REQUIRED (old/hand-imported credentials omit it — silently skipping
	// refresh is the trap this avoids).
	ExpiresAt      string `json:"expires_at,omitempty"`
	OfficeIdentity string `json:"office_identity,omitempty"`
	UserID         string `json:"user_id,omitempty"`
	// Nickname is the server's AUTO-GENERATED default name (RaccoonAva);
	// WeChat scan does NOT return a WeChat nickname — phone is the
	// disambiguator.
	Nickname string `json:"nickname,omitempty"`
	Phone    string `json:"phone,omitempty"`
	DeviceID string `json:"device_id,omitempty"` // 32-hex X-Client-Device-ID
}

// RaccoonExpiresAtMs: expires_at (ms string) → JWT exp fallback.
func RaccoonExpiresAtMs(cred *RaccoonCredential) int64 {
	if raw := strings.TrimSpace(cred.ExpiresAt); raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return jwtExpiresAtMs(cred.AccessToken)
}

// RaccoonRefreshable: refresh_token non-empty (raccoon HAS a refresh endpoint,
// unlike loomy).
func RaccoonRefreshable(cred *RaccoonCredential) bool {
	return strings.TrimSpace(cred.RefreshToken) != ""
}

// EncryptRaccoonPhone implements the client's phone transport encryption:
// key = UTF8("senseraccoon2023") (16 bytes ⇒ AES-128), iv = random 16 bytes,
// mode = CFB NoPadding, output = Base64(iv ‖ ciphertext). ⚠️ Explicitly
// aes-128 (a 256 label would fail on the 16-byte key, no auto-pad).
func EncryptRaccoonPhone(phone string, iv []byte) (string, error) {
	block, err := aes.NewCipher([]byte(raccoonPhoneCipherSecret))
	if err != nil {
		return "", fmt.Errorf("jethub: raccoon cipher: %w", err)
	}
	nonce := iv
	if nonce == nil {
		nonce = make([]byte, 16)
		if _, err := rand.Read(nonce); err != nil {
			return "", fmt.Errorf("jethub: raccoon iv: %w", err)
		}
	}
	if len(nonce) != block.BlockSize() {
		return "", fmt.Errorf("jethub: raccoon iv size %d != %d", len(nonce), block.BlockSize())
	}
	stream := cipher.NewCFBEncrypter(block, nonce)
	out := make([]byte, len(phone))
	stream.XORKeyStream(out, []byte(phone))
	payload := append(append([]byte{}, nonce...), out...)
	return hexEncodeBase64(payload), nil
}

// hexEncodeBase64 = std base64 encode (named for readability at call sites).
func hexEncodeBase64(data []byte) string {
	const base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var b strings.Builder
	for i := 0; i < len(data); i += 3 {
		var chunk [3]byte
		copy(chunk[:], data[i:])
		n := len(data) - i
		v := uint32(chunk[0])<<16 | uint32(chunk[1])<<8 | uint32(chunk[2])
		b.WriteByte(base64Chars[v>>18&0x3F])
		b.WriteByte(base64Chars[v>>12&0x3F])
		if n > 1 {
			b.WriteByte(base64Chars[v>>6&0x3F])
		} else {
			b.WriteByte('=')
		}
		if n > 2 {
			b.WriteByte(base64Chars[v&0x3F])
		} else {
			b.WriteByte('=')
		}
	}
	return b.String()
}

// GenerateRaccoonQrCode: 16 random bytes → 32 lowercase hex.
//
// ⚠️ 这是**旧**流程的客户端自造码（2026-10-23 起现网扫码页只认服务端下发的
// `qr-<uuid>` 码，自造码会被判「二维码过期或已被使用」）。保留它只为兜底与
// 存量单测，生产路径走 `CreateRaccoonQRTicket`（见 raccoon_identity.go）。
func GenerateRaccoonQrCode() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		now := nowMillis()
		for i := range b {
			b[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	return hex.EncodeToString(b[:])
}

// raccoonQRLegacyScanPath 是扫码页路径。新流程用服务端下发的 `scan_path`
// （当前同值），旧流程只能写死。
const raccoonQRLegacyScanPath = "/login/mp"

// BuildRaccoonQrURL 拼旧流程的二维码内容：`{base}/login/mp?code=...&appname=...`。
// ⚠️ 缺 `source=platform`（现网扫码页按来源分支）⇒ 已不适用于生产，见
// RaccoonQRURL。
func BuildRaccoonQrURL(code string) string {
	return raccoonAPIBase + raccoonQRLegacyScanPath + "?code=" + urlQueryEscape(code) +
		"&appname=" + urlQueryEscape("商汤小浣熊官网")
}

// raccoonEnvelope is the unified business envelope (HTTP 200 + non-zero code
// is also a failure).
type raccoonEnvelope struct {
	Code    int64
	Message string
	Details string
	Data    map[string]any
	// RawCode keeps the original `code` when it is a **string** (IAM 身份接口
	// 用 `"OK"` / `"AUTH_QRCODE_EXPIRED"` 这类枚举，Code 会归一成 0 ⇒ 看上去
	// 恒成功，详见 raccoon_identity.go 的文件头）。
	RawCode string
}

// parseRaccoonEnvelope: code=HTTP status when the body carries no code and
// the status is >=400.
func parseRaccoonEnvelope(payload map[string]any, status int) *raccoonEnvelope {
	env := &raccoonEnvelope{}
	if payload != nil {
		env.Code = bodyCode(payload)
		env.Message = bodyMessage(payload)
		env.Details = jsonStringField(payload, "details")
		env.Data, _ = payload["data"].(map[string]any)
		if raw, ok := payload["code"].(string); ok {
			env.RawCode = raw
		}
	}
	if env.Code == 0 && status >= 400 {
		env.Code = int64(status)
	}
	return env
}

func (e *raccoonEnvelope) err(fallback string) error {
	parts := make([]string, 0, 2)
	if e.Message != "" {
		parts = append(parts, e.Message)
	}
	if e.Details != "" {
		parts = append(parts, e.Details)
	}
	text := firstNonEmpty(strings.Join(parts, ": "), fallback)
	return fmt.Errorf("raccoon: %s", text)
}

// raccoonRequest posts a JSON business request and returns the envelope.
func (m *Manager) raccoonRequest(ctx context.Context, cred *RaccoonCredential, method, url, body string) (*raccoonEnvelope, error) {
	var reader io.Reader
	if body != "" {
		reader = strReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if cred != nil {
		// raccoonHeaders (client createHeaders): Bearer + X-Org-Code (empty for
		// personal accounts, sent anyway) + language + platform headers.
		req.Header.Set("Authorization", "Bearer "+cred.AccessToken)
		req.Header.Set("X-Org-Code", cred.OfficeIdentity)
		if cred.DeviceID != "" {
			req.Header.Set("X-Client-Device-ID", cred.DeviceID)
		}
	}
	req.Header.Set("X-Raccoon-Language", "zh")
	req.Header.Set("X-Client-Platform", raccoonClientPlatform)
	req.Header.Set("X-Client-Version", raccoonClientVersion)
	resp, err := m.httpClient("raccoon").Do(req)
	if err != nil {
		return nil, fmt.Errorf("raccoon: 请求失败：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			return nil, fmt.Errorf("raccoon: 凭据已失效（HTTP %d），请重新登录", resp.StatusCode)
		}
		return nil, fmt.Errorf("raccoon: 响应不是 JSON（HTTP %d）", resp.StatusCode)
	}
	env := parseRaccoonEnvelope(parsed, resp.StatusCode)
	// ⚠️ 200901 自愈：小浣熊业务接口提示 iam_confirm_required 时，
	// 自动调用一次 ConfirmRaccoonIAM 激活业务会话并重试当前请求。
	if (env.Code == 200901 || env.Message == "iam_confirm_required" || strings.Contains(env.Details, "IAM confirmation required")) &&
		cred != nil && cred.AccessToken != "" && !strings.Contains(url, "/iam/confirm") {
		if ctx.Value("raccoon_iam_confirmed") == nil {
			if confirmErr := m.ConfirmRaccoonIAM(ctx, cred.AccessToken); confirmErr == nil {
				retryCtx := context.WithValue(ctx, "raccoon_iam_confirmed", true)
				return m.raccoonRequest(retryCtx, cred, method, url, body)
			}
		}
	}
	return env, nil
}

// credentialFromEnvelope extracts the credential; a missing access_token
// throws (never produce a half credential).
func credentialFromRaccoonEnvelope(env *raccoonEnvelope) (*RaccoonCredential, error) {
	if env.Data == nil {
		return nil, env.err("登录响应缺少 data")
	}
	access := jsonStringField(env.Data, "access_token")
	if access == "" {
		return nil, fmt.Errorf("raccoon: 登录响应缺少 access_token")
	}
	cred := &RaccoonCredential{
		AccessToken:    access,
		RefreshToken:   jsonStringField(env.Data, "refresh_token"),
		OfficeIdentity: jsonStringField(env.Data, "office_identity"),
	}
	if expMs := jwtExpiresAtMs(access); expMs > 0 {
		cred.ExpiresAt = strconv.FormatInt(expMs, 10)
	}
	return cred, nil
}

// PollRaccoonQrLogin polls once. ⚠️ ANY anomaly degrades to `pending` (2s
// loop; transient failures must not kill the flow; unknown→success would
// deadlock with empty tokens, unknown→canceled would refresh the QR the user
// is mid-scanning).
func (m *Manager) PollRaccoonQrLogin(ctx context.Context, code string) (status string, cred *RaccoonCredential, expiredAt string) {
	env, err := m.raccoonRequest(ctx, nil, http.MethodPost,
		raccoonAPIBase+raccoonAuthPrefix+"/login_with_qrcode_code",
		`{"qrcode_code":"`+code+`"}`)
	if err != nil || env.Code != 0 || env.Data == nil {
		return raccoonQRStatusPending, nil, ""
	}
	switch st := jsonStringField(env.Data, "status"); st {
	case raccoonQRStatusCanceled:
		return raccoonQRStatusCanceled, nil, ""
	case raccoonQRStatusLogging:
		return raccoonQRStatusLogging, nil, jsonStringField(env.Data, "expired_at")
	case raccoonQRStatusSuccess:
		access := jsonStringField(env.Data, "access_token")
		if access == "" {
			// ⚠️ token-less success is treated as unfinished (would deadlock).
			return raccoonQRStatusPending, nil, ""
		}
		c, err := credentialFromRaccoonEnvelope(env)
		if err != nil {
			return raccoonQRStatusPending, nil, ""
		}
		return raccoonQRStatusSuccess, c, ""
	}
	return raccoonQRStatusPending, nil, ""
}

// SendRaccoonSmsCode requests an SMS code. ⚠️ phone MUST be AES-128-CFB
// encrypted (else `100003 params_encryted_error`); captcha_param is REQUIRED
// (else `100006 captcha_verify_error`).
func (m *Manager) SendRaccoonSmsCode(ctx context.Context, phone, captchaParam string) error {
	enc, err := EncryptRaccoonPhone(phone, nil)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{
		"captcha_param": captchaParam,
		"nation_code":   "86",
		"phone":         enc,
	})
	env, err := m.raccoonRequest(ctx, nil, http.MethodPost,
		raccoonAPIBase+raccoonAuthPrefix+"/send_sms", string(body))
	if err != nil {
		return err
	}
	if env.Code != 0 {
		if env.Code == 100006 {
			return fmt.Errorf("raccoon: 图形验证码校验失败，请重新完成滑块验证")
		}
		return env.err("下发短信验证码失败")
	}
	return nil
}

// LoginRaccoonWithSmsCode completes SMS login and returns the credential.
func (m *Manager) LoginRaccoonWithSmsCode(ctx context.Context, phone, smsCode string) (*RaccoonCredential, error) {
	enc, err := EncryptRaccoonPhone(phone, nil)
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]string{
		"nation_code": "86", "phone": enc, "sms_code": smsCode,
	})
	env, err := m.raccoonRequest(ctx, nil, http.MethodPost,
		raccoonAPIBase+raccoonAuthPrefix+"/login_with_sms", string(body))
	if err != nil {
		return nil, err
	}
	if env.Code != 0 {
		return nil, env.err("短信登录失败")
	}
	return credentialFromRaccoonEnvelope(env)
}

// RefreshRaccoonCredential renews via /refresh. ⚠️ The server may return ONLY
// a new access_token (no refresh_token) — keep the old one or one renewal
// would turn the account non-refreshable. ⚠️ 401/200003 = terminal
// (re-login required, no retry).
func (m *Manager) RefreshRaccoonCredential(ctx context.Context, previous *RaccoonCredential) (*RaccoonCredential, error) {
	body, _ := json.Marshal(map[string]string{"refresh_token": previous.RefreshToken})
	env, err := m.raccoonRequest(ctx, nil, http.MethodPost,
		raccoonAPIBase+raccoonAuthPrefix+"/refresh", string(body))
	if err != nil {
		return nil, err
	}
	if env.Code == 200003 {
		return nil, fmt.Errorf("raccoon: 登录态已过期，请重新登录")
	}
	if env.Code != 0 {
		return nil, env.err("续期失败")
	}
	if env.Data == nil {
		return nil, fmt.Errorf("raccoon: 续期响应缺少 data")
	}
	access := jsonStringField(env.Data, "access_token")
	if access == "" {
		return nil, fmt.Errorf("raccoon: 续期响应缺少 access_token")
	}
	next := *previous
	next.AccessToken = access
	if rt := jsonStringField(env.Data, "refresh_token"); rt != "" {
		next.RefreshToken = rt
	}
	if expMs := jwtExpiresAtMs(access); expMs > 0 {
		next.ExpiresAt = strconv.FormatInt(expMs, 10)
	}
	return &next, nil
}

// FetchRaccoonUserInfo pulls display info. ⚠️ Failures return an EMPTY object
// (info is display-only; login already succeeded) — never an error.
func (m *Manager) FetchRaccoonUserInfo(ctx context.Context, cred *RaccoonCredential) (userID, nickname, officeIdentity, phone string) {
	env, err := m.raccoonRequest(ctx, cred, http.MethodGet,
		raccoonAPIBase+raccoonAuthPrefix+"/user_info", "")
	if err != nil || env.Code != 0 || env.Data == nil {
		return "", "", "", ""
	}
	return jsonStringField(env.Data, "id"), jsonStringField(env.Data, "name"),
		jsonStringField(env.Data, "office_identity"), jsonStringField(env.Data, "phone")
}

// RaccoonThinkingExtraBody maps the effort to `extra_body.thinking`. ⚠️ THE
// ONLY working channel (verified): extra_body.enable_thinking / nested
// extra_body.extra_body / top-level thinking / budget_tokens are all INERT.
// off → disabled (really stops thinking); on/others → enabled (≈default).
func RaccoonThinkingExtraBody(effort string) map[string]any {
	if strings.TrimSpace(effort) == "" {
		return nil
	}
	typ := "enabled"
	if effort == "off" {
		typ = "disabled"
	}
	return map[string]any{"thinking": map[string]any{"type": typ}}
}

// init registers the raccoon token extractor (access_token IS the bearer).
func init() {
	RegisterTokenExtractor("raccoon", func(cred jsonRaw) (string, error) {
		var c RaccoonCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", fmt.Errorf("jethub: parse raccoon credential: %w", err)
		}
		return c.AccessToken, nil
	})
}
