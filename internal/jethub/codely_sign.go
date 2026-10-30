package jethub

// Codely 推理签名（ref src/codely-sign.ts @ 301f6bc）。
//
//	签名密钥 = HMAC_SHA256( HMAC_SHA256(SECRET, "codely-signing-v1"), cli_api_key )
//	签名串   = "v1" + "\n" + pathname + "\n" + ts(秒)
//	头值     = "v1.<ts>.<base64url(sig)>"
//
// ⚠️⚠️ 分隔符必须是 **LF**。官方 CLI 二进制里的旧代码用 `|`、npm 包源码的转义
// 展示像 `\r\n` —— 两者都 401；只有 LF 实测 200。这是**一字节级**的协议事实，
// 《codely-sign.spec.ts》的固定向量把它钉死（见 codely_sign_test.go）。
//
// 签名只覆盖 pathname：body 与 query 都不参与（实测改 body 仍 200）。

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/url"
	"time"
)

// codelySigningSecretHex is the official client's shared root key (32 bytes,
// identical for every user; account isolation comes from cli_api_key).
const codelySigningSecretHex = "406f00f74768ba0cb0cd30f097ec6c2bdacb89c61a38b7dd140838bbd0e98018"

// codelySigningSalt is the first derivation stage (changing it = new protocol).
const codelySigningSalt = "codely-signing-v1"

// codelyCLIUserAgent is the inference User-Agent (distinct from the dashboard's
// `codely-vscode/4.3.0`; two UAs must not be mixed).
const codelyCLIUserAgent = "codely-cli/1.0.0-release.57 (win32; x64)"

// codelySigningKey derives HMAC(HMAC(SECRET, salt), cli_api_key).
func codelySigningKey(cliAPIKey string) []byte {
	secret, err := hex.DecodeString(codelySigningSecretHex)
	if err != nil {
		return nil
	}
	stage1 := hmac.New(sha256.New, secret)
	_, _ = stage1.Write([]byte(codelySigningSalt))
	stage2 := hmac.New(sha256.New, stage1.Sum(nil))
	_, _ = stage2.Write([]byte(cliAPIKey))
	return stage2.Sum(nil)
}

// codelyPathnameOf extracts the request pathname (query excluded).
func codelyPathnameOf(target string) string {
	parsed, err := url.Parse(target)
	if err != nil || parsed.Path == "" {
		return target
	}
	return parsed.Path
}

// codelySignatureHeader computes `v1.<ts>.<base64url>` at the given time.
func codelySignatureHeader(cliAPIKey, target string, ts time.Time) string {
	seconds := ts.Unix()
	msg := "v1" + "\n" + codelyPathnameOf(target) + "\n" + itoa64(seconds)
	mac := hmac.New(sha256.New, codelySigningKey(cliAPIKey))
	_, _ = mac.Write([]byte(msg))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return "v1." + itoa64(seconds) + "." + sig
}

// itoa64 renders a non-negative seconds timestamp without importing strconv.
func itoa64(value int64) string {
	if value == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for value > 0 {
		i--
		buf[i] = byte('0' + value%10)
		value /= 10
	}
	return string(buf[i:])
}

// codelySignedHeaders builds a signed inference request header set.
// ⚠️ `x-litellm-session-id` is REQUIRED (missing → 400 非法session) but not
// part of the signature; the same id can be reused.
func codelySignedHeaders(cliAPIKey, target, sessionID string, ts time.Time) map[string]string {
	return map[string]string{
		"Content-Type":         "application/json",
		"Accept":               "application/json",
		"Authorization":        "Bearer " + cliAPIKey,
		"User-Agent":           codelyCLIUserAgent,
		"X-Codely-Signature":   codelySignatureHeader(cliAPIKey, target, ts),
		"x-litellm-session-id": sessionID,
	}
}

// codelyCLIKeyResult is the classified outcome of GET /api/api-token/cli-api-key.
//
// kind:
//   - ok          — got a non-empty sk- key
//   - credential  — 401/403: this account's access_token is genuinely unusable
//   - transient   — network error / 5xx / 429 / other: upstream is having a bad
//     moment; do NOT lock the account (ref: 一次 DNS 抖动锁了整池到次日 0 点)
//   - malformed   — 2xx but no cli_api_key (protocol change)
type codelyCLIKeyResult struct {
	Kind   string
	Key    string
	Status int
	Reason string
}

// FetchCodelyCLIKey exchanges the access token for a per-request signing key.
func (m *Manager) FetchCodelyCLIKey(ctx context.Context, accessToken string) codelyCLIKeyResult {
	payload, status, err := m.codelyAuthorizedJSON(ctx, "GET", codelyAPIBase+codelyCLIKeyPath, nil, accessToken)
	if err != nil {
		return codelyCLIKeyResult{Kind: "transient", Reason: err.Error()}
	}
	if status == 401 || status == 403 {
		return codelyCLIKeyResult{Kind: "credential", Status: status}
	}
	if status < 200 || status >= 300 {
		return codelyCLIKeyResult{Kind: "transient", Status: status, Reason: "HTTP " + itoa64(int64(status))}
	}
	key, _ := payload["cli_api_key"].(string)
	if key == "" {
		return codelyCLIKeyResult{Kind: "malformed", Reason: "响应缺少 cli_api_key"}
	}
	return codelyCLIKeyResult{Kind: "ok", Key: key}
}
