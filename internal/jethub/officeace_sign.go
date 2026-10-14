package jethub

// OfficeAce 华为 APIG 签名族（1:1 移植自 ref officeace-auth.ts，逐字对齐）。
//
// 两个签名器服务两个面：
//
//   - **V11-HMAC-SHA256**（officeaceSignV11）—— 管理面（/v1/subscription、
//     /v1/model-token-rates、/v1/subscription/bonus/claim）。逐字复刻果办客户端
//     `chunk-XOTX5NN5.js` 的 `B()`/`F()`（ref signAndRequest）。
//   - **SDK-HMAC-SHA256**（officeaceSignSDKHMAC）—— 登录步 ⑤ 的
//     client-permission-validate。逐字复刻 `@openjiuwen/relay-shared` 的
//     `Signer`（ref signHuaweiRequest）。
//
// ## ⚠️ V11 的三条铁律（各自都曾导致 APIG.0301，别凭直觉改 — ref §1）
//
//  1. **GET 请求不发 `Content-Type`** —— 多这一个头，签名串多一行，服务端重算
//     必不匹配（POST 必须带，且值与签名一致：`application/json;charset=utf8`）。
//  2. **密钥派生用 hex 字符串作 key，不是 raw bytes**：
//     `u = HMAC(sha256, access).update(secret)`；
//     `derived = HMAC(sha256, u).update(scope || 0x01)` 取前 32 字节 →
//     **`.toString('hex')`** → 再以该 hex 字符串的 **UTF-8 字节**当 HMAC key。
//  3. **分隔符是 LF**（canonical 头行与 stringToSign），canonical 头行以 `\n`
//     结尾、join 时又插一个 `\n` ⇒ 头块与 signedHeaders 之间是**双 LF**（ref
//     数组 join 的真实形状，实测 200 靠的就是它）；canonical 路径**强制尾斜杠**。
//
// ⚠️ canonical query/路径的 percent 编码集是 RFC 3986 unreserved（JS
// encodeURIComponent 再补转 `!'()*`），Go 的 url.QueryEscape（空格 → '+'）
// 不等价 —— 自带 officeaceURIEncode。
//
// ⚠️ region/service 硬编码 `cn-southwest-2` / `apic`（ref 同款已知缺口：账号若
// 被分配到别的 region，scope 与 Host 会一起错；ref §6 未守卫，本端同样如实保留）。

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// officeaceV11ScopeRegion / officeaceV11ScopeService are the hardcoded scope
// pieces (ref signAndRequest 局部常量).
const (
	officeaceV11ScopeRegion  = "cn-southwest-2"
	officeaceV11ScopeService = "apic"
	// officeaceV11ContentType must equal the header value sent on POSTs and
	// the value that entered the signature.
	officeaceV11ContentType = "application/json;charset=utf8"
)

// officeaceURIEncode is JS encodeURIComponent + the `!'()*` escape pass —
// i.e. exactly the RFC 3986 unreserved set survives.
func officeaceURIEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		default:
			b.WriteString(fmt.Sprintf("%%%02X", c))
		}
	}
	return b.String()
}

// officeaceCanonicalURI per-segment-encodes the path and forces the trailing
// slash (ref N()/k(): 缺尾斜杠就是 verify signature failed).
func officeaceCanonicalURI(path string, decodeFirst bool) string {
	segs := strings.Split(path, "/")
	for i, seg := range segs {
		if decodeFirst {
			if dec, err := url.PathUnescape(seg); err == nil {
				seg = dec
			}
		}
		segs[i] = officeaceURIEncode(seg)
	}
	uri := strings.Join(segs, "/")
	if !strings.HasSuffix(uri, "/") {
		uri += "/"
	}
	return uri
}

// officeaceNow is the clock hook the signers read (tests pin it to replay the
// exact signature offline; production default is time.Now).
var officeaceNow = time.Now

// officeaceXSdkDate is the compact UTC timestamp both signers use.
func officeaceXSdkDate() string { return officeaceNow().UTC().Format("20060102T150405Z") }

// officeaceSignV11 builds the signed header set for one V11 request.
// body == "" means a bodyless GET (its payload hash is sha256("")). The caller
// must send the returned headers verbatim (host handled by the transport).
func officeaceSignV11(access, secret, securityToken, projectID, method, rawURL, body string) (map[string]string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("officeace: parse v11 url: %w", err)
	}
	xdate := officeaceXSdkDate()

	// 头集合（规则 1：GET 不带 Content-Type）。
	headers := map[string]string{
		"x-subscription-type": "v2",
		"x-sdk-date":          xdate,
		"x-security-token":    strings.TrimSpace(securityToken),
		"host":                u.Host,
	}
	if strings.EqualFold(method, http.MethodPost) {
		headers["content-type"] = officeaceV11ContentType
	}
	if projectID != "" {
		headers["x-project-id"] = projectID
	}

	// R()：签名用小写名，值 trim + 折叠空白。
	lower := make(map[string]string, len(headers))
	for k, v := range headers {
		lower[strings.ToLower(k)] = strings.Join(strings.Fields(v), " ")
	}
	signed := make([]string, 0, len(lower))
	for k := range lower {
		signed = append(signed, k)
	}
	sort.Strings(signed)
	var canonicalHeaders strings.Builder
	for _, h := range signed {
		canonicalHeaders.WriteString(h + ":" + lower[h] + "\n")
	}

	// P()：query 排序拼接（当前端点无 query，实现保留）。
	values := u.Query()
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, k := range keys {
		for _, v := range values[k] {
			pairs = append(pairs, officeaceURIEncode(k)+"="+officeaceURIEncode(v))
		}
	}

	payloadHash := sha256Hex([]byte(body))
	canonicalRequest := strings.Join([]string{
		strings.ToUpper(method),
		officeaceCanonicalURI(u.EscapedPath(), true),
		strings.Join(pairs, "&"),
		canonicalHeaders.String(),
		strings.Join(signed, ";"),
		payloadHash,
	}, "\n")
	scope := xdate[:8] + "/" + officeaceV11ScopeRegion + "/" + officeaceV11ScopeService
	stringToSign := strings.Join([]string{
		"V11-HMAC-SHA256", xdate, scope, sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	// 规则 2：派生 key 的 hex 字符串（非 raw bytes）才是最终 HMAC key。
	u1 := hmacSHA256([]byte(access), []byte(secret))
	scopeInput := append([]byte(scope), 0x01)
	derived := hmacSHA256(u1, scopeInput)
	if len(derived) > 32 {
		derived = derived[:32]
	}
	derivedHex := hex.EncodeToString(derived)
	signature := hex.EncodeToString(hmacSHA256([]byte(derivedHex), []byte(stringToSign)))

	out := map[string]string{
		"X-Subscription-Type": "v2",
		"X-Sdk-Date":          xdate,
		"X-Security-Token":    strings.TrimSpace(securityToken),
		"Authorization": fmt.Sprintf("V11-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
			access, scope, strings.Join(signed, ";"), signature),
	}
	if strings.EqualFold(method, http.MethodPost) {
		out["Content-Type"] = officeaceV11ContentType
	}
	if projectID != "" {
		out["X-Project-ID"] = projectID
	}
	return out, nil
}

// officeaceSignSDKHMAC is the login-step-⑤ signer (ref signHuaweiRequest):
// bare secret as the HMAC key (NO scope derivation — 按_scope_派生曾实测 401),
// values trimmed (no whitespace collapse), GET body hashed as empty.
func officeaceSignSDKHMAC(access, secret, method, rawURL string, headers map[string]string, bodyText string) (map[string]string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("officeace: parse sdk-hmac url: %w", err)
	}
	xdate := officeaceXSdkDate()

	lower := make(map[string]string, len(headers)+2)
	for k, v := range headers {
		lower[strings.ToLower(k)] = strings.TrimSpace(v)
	}
	lower["host"] = u.Host
	lower["x-sdk-date"] = xdate
	signed := make([]string, 0, len(lower))
	for k := range lower {
		signed = append(signed, k)
	}
	sort.Strings(signed)
	var canonicalHeaders strings.Builder
	for _, h := range signed {
		canonicalHeaders.WriteString(h + ":" + lower[h] + "\n")
	}

	bodyHash := sha256Hex([]byte(bodyText))
	if strings.EqualFold(method, http.MethodGet) {
		bodyHash = sha256Hex(nil)
	}
	canonicalRequest := strings.Join([]string{
		strings.ToUpper(method),
		officeaceCanonicalURI(u.EscapedPath(), false),
		canonicalQuerySorted(u),
		canonicalHeaders.String(),
		strings.Join(signed, ";"),
		bodyHash,
	}, "\n")
	stringToSign := strings.Join([]string{
		"SDK-HMAC-SHA256", xdate, sha256Hex([]byte(canonicalRequest)),
	}, "\n")
	signature := hex.EncodeToString(hmacSHA256([]byte(secret), []byte(stringToSign)))

	out := make(map[string]string, len(headers)+2)
	for k, v := range headers {
		out[k] = v
	}
	out["X-Sdk-Date"] = xdate
	out["Authorization"] = fmt.Sprintf("SDK-HMAC-SHA256 Access=%s, SignedHeaders=%s, Signature=%s",
		access, strings.Join(signed, ";"), signature)
	return out, nil
}

// canonicalQuerySorted is the C()/P() shared query canonicalization.
func canonicalQuerySorted(u *url.URL) string {
	values := u.Query()
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, k := range keys {
		for _, v := range values[k] {
			pairs = append(pairs, officeaceURIEncode(k)+"="+officeaceURIEncode(v))
		}
	}
	return strings.Join(pairs, "&")
}

// hmacSHA256 is the shared HMAC helper.
func hmacSHA256(key, msg []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(msg)
	return mac.Sum(nil)
}
