package jethub

// ZCode（智谱 z.ai 免费额度通道）provider。
//
// 参考实现：ref/deepseek-harness-codearts @ e06283c 的 src/zcode.ts（凭据层）、
// src/zcode-login.ts（CLI 设备授权流）、src/zcode-upstream.ts（HTTP 客户端）、
// src/zcode-product.ts（产品表）、src/zcode-identity.ts（3012 准入身份块）。
//
// 形态：读凭据 → 直发远端 Anthropic Messages 端点（`/api/v1/zcode-plan/anthropic/v1/messages`）。
// 与其余 provider 的差异（全部来自上游实测）：
//  1. 协议是 **Anthropic Messages**（见 zcode_convert.go 的请求构造与
//     minimax_stream.go 的响应桥——两者共用同一套 Anthropic↔OpenAI 转换）。
//  2. 请求体必须带官方身份块 + 首轮日期块，否则上游回 `3012 unusual activity`
//     （且 3012 有账号冷却惩罚：30 分钟 → 24h → 停用）。
//  3. captcha **按需**：3.14.4 起推理不再校验（实测 6/6、8/8 不带验证头 200），
//     只有**领取**（billing/claim）始终强制索要（见 zcode_captcha.go）。
//  4. 凭据**不可续期**（JWT 无 exp）；失效时上游回 401/1002 → 归 AUTH，提示重新登录。
//
// ⚠️ 可脱离官方客户端：登录走官方 CLI 设备授权流（纯 HTTP，zcode_login.go）；
// 机器上装过并登录过官方客户端时也可直接解密其凭据文件导入（zcodeImportLocalCredential）。

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ── 端点常量（ref src/zcode-upstream.ts:40-58、src/zcode-login.ts:52-56）──────

const (
	// zcodeOrigin is the platform origin (both the API host and the
	// HTTP-Referer the official client sends).
	zcodeOrigin = "https://zcode.z.ai"
	// zcodePlanMessagesURL is the FULL inference endpoint (Anthropic Messages).
	// ⚠️ 必须显式声明为 Product.InferURL：该路径不是 "BaseURL + 进站路径"，
	// 且带路径的 BaseURL 会被 urlutil 剥后缀（minimax 踩过同款 404）。
	zcodePlanMessagesURL = zcodeOrigin + "/api/v1/zcode-plan/anthropic/v1/messages"
	// zcodeBillingBalanceURL needs Authorization (missing → 401) + X-Device-Mid.
	zcodeBillingBalanceURL = zcodeOrigin + "/api/v1/zcode-plan/billing/balance"
	// zcodeBillingPreviewURL needs X-Device-Mid only (no Authorization).
	zcodeBillingPreviewURL = zcodeOrigin + "/api/v1/zcode-plan/billing/preview"
	// zcodeBillingClaimURL always demands captcha (verification precedes plan
	// validation: absent/invalid param both → 400/3007).
	zcodeBillingClaimURL = zcodeOrigin + "/api/v1/zcode-plan/billing/claim"
	// zcodeEventReportURL is the client-activity report; without it `preview`
	// always returns an empty plan list (measured).
	zcodeEventReportURL = zcodeOrigin + "/api/v1/event/report"
	// zcodeClientConfigsURL serves both the captcha config and the model
	// catalog. ⚠️ platform MUST be literally `unknown` (measured: win32 /
	// win64 / windows / electron / desktop / linux all → 400 code 3001).
	zcodeClientConfigsURL = zcodeOrigin + "/api/v1/client/configs"
	// zcodeOAuthInitURL starts the CLI device-authorization flow.
	zcodeOAuthInitURL = zcodeOrigin + "/api/v1/oauth/cli/init"
	// zcodeOAuthPollPrefix + flow_id polls it.
	zcodeOAuthPollPrefix = zcodeOrigin + "/api/v1/oauth/cli/poll/"
	// zcodeLoginProvider is the only provider id this port uses (官方 Ne).
	zcodeLoginProvider = "bigmodel"
)

// zcodeAppVersionFallback is the client version sent in headers when the
// installed official client cannot be probed (ref ZCODE_APP_VERSION_FALLBACK).
const zcodeAppVersionFallback = "3.14.3"

// zcodeCaptchaFallback is the built-in captcha config, used when the remote
// config cannot be fetched (ref ZCODE_CAPTCHA_FALLBACK; config-fetch failure
// must not block anything).
var zcodeCaptchaFallback = zcodeCaptchaConfig{Region: "cn", Prefix: "no8xfe", SceneID: "11xygtvd"}

// zcodeCaptchaConfig is `data.configs.captcha` (Aliyun captcha init params).
type zcodeCaptchaConfig struct {
	Region  string `json:"region"`
	Prefix  string `json:"prefix"`
	SceneID string `json:"sceneId"`
}

// ── 凭据 ─────────────────────────────────────────────────────────────────────

// ZcodeCredential mirrors the reference credential JSON **1:1**（字段名是对外
// 契约：备份双向兼容依赖它 —— 原版备份里的 zcode 凭据可导入本端，反之亦然）。
//
// ⚠️ 只有 zcode_jwt + device_mid 是必需字段（ref isUsableZcodeCredential）；
// 其余为展示/诊断。refresh_token 恒不存在（凭据静态、无 exp）。
type ZcodeCredential struct {
	// ZcodeJWT is the free-channel bearer (Authorization: Bearer <jwt>).
	ZcodeJWT string `json:"zcode_jwt"`
	// DeviceMid is the device id. Required by the whole billing family
	// (missing → 400 code 3001) but its VALUE is not server-validated
	// (measured: random UUIDs accepted) ⇒ we generate + persist one per login.
	DeviceMid string `json:"device_mid"`
	// UserID is the only stable account identity (dedup key).
	UserID string `json:"user_id,omitempty"`
	// BigmodelAccessToken comes from the login poll (bigmodel side).
	BigmodelAccessToken string `json:"bigmodel_access_token,omitempty"`
	// AccountLabel / AccountName / Phone are display fields.
	AccountLabel string `json:"account_label,omitempty"`
	AccountName  string `json:"account_name,omitempty"`
	Phone        string `json:"phone,omitempty"`
	// AppVersion feeds X-ZCode-App-Version / User-Agent.
	AppVersion string `json:"app_version,omitempty"`
	// Source is "plugin" (we logged in) or "ide" (imported from the official
	// client's credentials file); display/diagnostic only, never authz.
	Source string `json:"source,omitempty"`
}

// zcodeUsable mirrors ref isUsableZcodeCredential: only the JWT and the
// device id are required.
func (c *ZcodeCredential) usable() bool {
	return c != nil && c.ZcodeJWT != "" && c.DeviceMid != ""
}

// zcodeAppVersion resolves the version header value.
func (c *ZcodeCredential) zcodeAppVersion() string {
	if c != nil && c.AppVersion != "" {
		return c.AppVersion
	}
	return zcodeAppVersionFallback
}

// zcodePhoneFromUserID derives the masked phone from the 17-digit user id.
// 实测：上游从不下发手机号，号段信息编码在 user_id 前 11 位里
// （ref phoneFromUserId；PHONE_RE = ^1[3-9]\d{9}$）。
func zcodePhoneFromUserID(userID string) string {
	if len(userID) < 11 {
		return ""
	}
	head := userID[:11]
	if head[0] != '1' || head[1] < '3' || head[1] > '9' {
		return ""
	}
	for _, r := range head {
		if r < '0' || r > '9' {
			return ""
		}
	}
	return head[:3] + "****" + head[7:11]
}

// zcodeIdentityFromUserInfo extracts the display name + user id from the
// official client's `oauth:bigmodel:user_info` payload (ref identityFromUserInfo
// + readUserIdFromUserInfo). Top-level `name` is deliberately NOT used — the
// official key is `displayName`.
func zcodeIdentityFromUserInfo(raw string) (name, userID string) {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil || parsed == nil {
		return "", ""
	}
	if s, _ := parsed["displayName"].(string); strings.TrimSpace(s) != "" {
		name = strings.TrimSpace(s)
	} else if s, _ := parsed["username"].(string); strings.TrimSpace(s) != "" {
		name = strings.TrimSpace(s)
	} else if profile, ok := parsed["rawProfile"].(map[string]any); ok {
		if s, _ := profile["name"].(string); strings.TrimSpace(s) != "" {
			name = strings.TrimSpace(s)
		}
	}
	if len(name) > 24 {
		name = name[:24]
	}
	if s, _ := parsed["id"].(string); s != "" {
		userID = s
	} else if profile, ok := parsed["rawProfile"].(map[string]any); ok {
		if s, _ := profile["user_id"].(string); s != "" {
			userID = s
		}
	}
	return name, userID
}

// zcodeLabelFromUserInfo mirrors ref labelFromUserInfo: phone/mobile/name/
// nickname/email, 纯数字 ≥7 位 → 尾号<last4>, 其余截断 24 字符；都没有则
// 用 id 的末 6 位。
func zcodeLabelFromUserInfo(raw string) string {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil || parsed == nil {
		return ""
	}
	for _, key := range []string{"phone", "mobile", "name", "nickname", "email"} {
		value, _ := parsed[key].(string)
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if isAllDigits(value) && len(value) >= 7 {
			return "尾号" + value[len(value)-4:]
		}
		if len(value) > 24 {
			value = value[:24]
		}
		return value
	}
	id, _ := parsed["id"].(string)
	if id == "" {
		if profile, ok := parsed["rawProfile"].(map[string]any); ok {
			id, _ = profile["user_id"].(string)
		}
	}
	if len(id) >= 6 {
		return "id:" + id[len(id)-6:]
	}
	return ""
}

// ── 请求头 ───────────────────────────────────────────────────────────────────

// zcodeHeaders builds the official-client header family (ref buildZcodeHeaders,
// verbatim). ⚠️ 这些头不是 3012 的判据（判据是请求体 system），但 X-Device-Mid
// 是 billing 全家桶的**硬需求**（缺它 400 code 3001）。
func zcodeHeaders(cred *ZcodeCredential, withJSON bool, captcha *zcodeCaptchaParam) map[string]string {
	version := cred.zcodeAppVersion()
	headers := map[string]string{
		"User-Agent":          "ZCode/" + version,
		"HTTP-Referer":        zcodeOrigin,
		"X-ZCode-App-Version": version,
		"X-Release-Channel":   "stable",
		"X-Client-Language":   "zh-CN",
		"X-Client-Timezone":   "Asia/Shanghai",
		"X-Device-Mid":        cred.DeviceMid,
		"X-Platform":          "win32",
		"X-Os-Category":       "windows",
		"anthropic-version":   "2023-06-01",
	}
	if withJSON {
		headers["Content-Type"] = "application/json"
	}
	if cred.ZcodeJWT != "" {
		headers["Authorization"] = "Bearer " + cred.ZcodeJWT
	}
	if captcha != nil && captcha.Param != "" {
		headers["x-aliyun-captcha-verify-param"] = captcha.Param
		headers["x-aliyun-captcha-verify-region"] = captcha.Region
	}
	return headers
}

// zcodeCredentialFor resolves + parses a zcode credential by account id.
func (m *Manager) zcodeCredentialFor(accountID string) (*ZcodeCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "zcode" {
		return nil, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential("zcode", acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(accountID)
	}
	var cred ZcodeCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse zcode credential %s: %w", accountID, err)
	}
	if !cred.usable() {
		return nil, errCredentialMissing(accountID)
	}
	return &cred, nil
}

// ── 官方客户端凭据文件（导入路径）─────────────────────────────────────────────

// Credential-file constants (ref src/zcode.ts:36-48).
const (
	zcodeCredentialPrefix    = "enc:v1:"
	zcodeCredentialIVLen     = 12
	zcodeCredentialTagLen    = 16
	zcodeCredentialSecretEnv = "ZCODE_CREDENTIAL_SECRET"
)

// Key fragments for substring matching (official keys are long and contain a
// uuid; ref KEY_FRAGMENTS).
const (
	zcodeKeyFragmentJWT         = "zcodejwttoken"
	zcodeKeyFragmentBigmodel    = "oauth:bigmodel:access_token"
	zcodeKeyFragmentUserInfo    = "oauth:bigmodel:user_info"
	zcodeKeyFragmentPlanZai     = "zai-individual-coding-plan"
	zcodeKeyFragmentPlanBigmodl = "bigmodel-individual-coding-plan"
)

// zcodeDataRoots mirrors the candidate root list: ZCODE_DATA_BASE_DIR
// (`;`-separated) → homedir → APPDATA → LOCALAPPDATA.
func zcodeDataRoots(includeLocalAppData bool) []string {
	var roots []string
	if env := strings.TrimSpace(os.Getenv("ZCODE_DATA_BASE_DIR")); env != "" {
		for _, part := range strings.Split(env, ";") {
			if part = strings.TrimSpace(part); part != "" {
				roots = append(roots, part)
			}
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		roots = append(roots, home)
	}
	if appData := strings.TrimSpace(os.Getenv("APPDATA")); appData != "" {
		roots = append(roots, appData)
	}
	if includeLocalAppData {
		if local := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); local != "" {
			roots = append(roots, local)
		}
	}
	return roots
}

// zcodeCredentialFilePath returns the first existing credentials.json among
// the candidates (ref resolveCredentialFilePath); "" when none exists.
func zcodeCredentialFilePath() string {
	for _, root := range zcodeDataRoots(true) {
		candidate := filepath.Join(root, ".zcode", "v2", "credentials.json")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

// zcodeReadDeviceMid reads the official client's device id from
// telemetry-state.json (ref readDeviceMid; same root list minus LOCALAPPDATA).
func zcodeReadDeviceMid() string {
	for _, root := range zcodeDataRoots(false) {
		raw, err := os.ReadFile(filepath.Join(root, ".zcode", "v2", "telemetry-state.json"))
		if err != nil {
			continue
		}
		var parsed struct {
			DeviceMid string `json:"deviceMid"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			continue
		}
		if strings.TrimSpace(parsed.DeviceMid) != "" {
			return strings.TrimSpace(parsed.DeviceMid)
		}
	}
	return ""
}

// zcodeCredentialKey derives the AES-256 key exactly like the official client
// (ref deriveCredentialKey): env override → sha256(secret); otherwise
// sha256("zcode-credential-fallback:" + platform + ":" + homedir + ":" + username).
//
// ⚠️ platform 必须是 **Node 的取值**（win32/darwin/linux）——Go 的 runtime.GOOS
// 是 windows/darwin/linux，直接拼会在 Windows 上算出不同的密钥（解密失败）。
func zcodeCredentialKey() [32]byte {
	if secret := os.Getenv(zcodeCredentialSecretEnv); secret != "" {
		return sha256.Sum256([]byte(secret))
	}
	username := "unknown"
	if u, err := user.Current(); err == nil && u.Username != "" {
		// ⚠️ Node 的 os.userInfo().username 在 Windows 上只有 SAM 名（Houpy），
		// 而 Go 的 user.Current().Username 带域前缀（Server-202306\Houpy）——
		// 直接拼会算出不同的密钥（实测：带域前缀 ⇒ GCM 认证失败；去掉后解密成功）。
		username = u.Username
		if idx := strings.LastIndexAny(username, `\/`); idx >= 0 {
			username = username[idx+1:]
		}
	}
	home, _ := os.UserHomeDir()
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	secret := "zcode-credential-fallback:" + platform + ":" + home + ":" + username
	return sha256.Sum256([]byte(secret))
}

// zcodeDecryptCredentialValue decrypts one credential value with the derived
// key: plaintext passes through; `enc:v1:<iv>.<tag>.<data>` (all base64url, no
// AAD) is AES-256-GCM.
func zcodeDecryptCredentialValue(value string) (string, error) {
	return zcodeDecryptValueWithKey(value, zcodeCredentialKey())
}

// zcodeDecryptValueWithKey is the key-injectable core (tests use it to check
// both the env-override and the fallback derivation).
func zcodeDecryptValueWithKey(value string, key [32]byte) (string, error) {
	if !strings.HasPrefix(value, zcodeCredentialPrefix) {
		return value, nil
	}
	parts := strings.Split(strings.TrimPrefix(value, zcodeCredentialPrefix), ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", fmt.Errorf("凭据密文格式非法")
	}
	decode := func(part string) ([]byte, error) {
		// Node 的 base64url 接受有/无填充两种形态；Go 的 RawURLEncoding 只认无填充。
		if raw, err := base64.RawURLEncoding.DecodeString(part); err == nil {
			return raw, nil
		}
		return base64.URLEncoding.DecodeString(part)
	}
	iv, err := decode(parts[0])
	if err != nil {
		return "", fmt.Errorf("凭据 IV 解码失败：%w", err)
	}
	if len(iv) != zcodeCredentialIVLen {
		return "", fmt.Errorf("凭据 IV 长度非法（%d ≠ %d）", len(iv), zcodeCredentialIVLen)
	}
	tag, err := decode(parts[1])
	if err != nil {
		return "", fmt.Errorf("凭据 AuthTag 解码失败：%w", err)
	}
	if len(tag) != zcodeCredentialTagLen {
		return "", fmt.Errorf("凭据 AuthTag 长度非法（%d ≠ %d）", len(tag), zcodeCredentialTagLen)
	}
	data, err := decode(parts[2])
	if err != nil {
		return "", fmt.Errorf("凭据正文解码失败：%w", err)
	}
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", fmt.Errorf("凭据解密失败（密钥不匹配或密文损坏）：%w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("凭据解密失败（密钥不匹配或密文损坏）：%w", err)
	}
	plain, err := gcm.Open(nil, iv, append(data, tag...), nil)
	if err != nil {
		return "", fmt.Errorf("凭据解密失败（密钥不匹配或密文损坏）：%w", err)
	}
	return string(plain), nil
}

// zcodePickCredential finds the first entry whose key contains the fragment
// and returns its decrypted value (ref pickCredential: undecryptable entries
// are skipped without failing the others).
func zcodePickCredential(table map[string]string, fragment string) string {
	for key, value := range table {
		if !strings.Contains(key, fragment) {
			continue
		}
		plain, err := zcodeDecryptCredentialValue(value)
		if err != nil {
			continue
		}
		if strings.TrimSpace(plain) != "" {
			return plain
		}
	}
	return ""
}

// zcodeImportLocalCredential decrypts the official client's credentials file
// into a ZcodeCredential. Returns nil when the client is not installed/logged
// in (the provider simply stays hidden — ref readZcodeCredential contract).
func zcodeImportLocalCredential() *ZcodeCredential {
	path := zcodeCredentialFilePath()
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var table map[string]string
	if err := json.Unmarshal(raw, &table); err != nil || table == nil {
		return nil
	}
	// 非字符串值一律丢弃（ref readRawCredentials）。
	clean := make(map[string]string, len(table))
	for key, value := range table {
		clean[key] = value
	}
	jwt := zcodePickCredential(clean, zcodeKeyFragmentJWT)
	if jwt == "" {
		return nil
	}
	deviceMid := zcodeReadDeviceMid()
	if deviceMid == "" {
		// 官方凭据的 device_mid 只在 telemetry-state.json 里；缺它凭据不可用
		// （ref 同款判据）。此时仍可用插件登录路径。
		return nil
	}
	cred := &ZcodeCredential{
		ZcodeJWT:            jwt,
		DeviceMid:           deviceMid,
		BigmodelAccessToken: zcodePickCredential(clean, zcodeKeyFragmentBigmodel),
		AppVersion:          zcodeDetectAppVersion(),
		Source:              "ide",
	}
	userInfo := zcodePickCredential(clean, zcodeKeyFragmentUserInfo)
	cred.AccountName, cred.UserID = zcodeIdentityFromUserInfo(userInfo)
	cred.AccountLabel = zcodeLabelFromUserInfo(userInfo)
	if cred.AccountLabel == "" {
		cred.AccountLabel = "设备" + firstN(cred.DeviceMid, 8)
	}
	cred.Phone = zcodePhoneFromUserID(cred.UserID)
	return cred
}

// zcodeDetectAppVersion probes the installed official client version
// (ref detectZcodeAppVersion); falls back to the constant.
func zcodeDetectAppVersion() string {
	roots := []string{
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "ZCode"),
		filepath.Join(os.Getenv("PROGRAMFILES"), "ZCode"),
		filepath.Join(os.Getenv("PROGRAMFILES(X86)"), "ZCode"),
	}
	for _, root := range roots {
		if root == "" {
			continue
		}
		if _, err := os.Stat(filepath.Join(root, "ZCode.exe")); err != nil {
			continue
		}
		manifest, err := os.ReadFile(filepath.Join(root, ".zcode-install-manifest"))
		if err != nil {
			continue
		}
		if version := zcodeVersionFromManifest(string(manifest)); version != "" {
			return version
		}
	}
	return zcodeAppVersionFallback
}

// zcodeVersionFromManifest extracts `"version": "x.y.z"` from the install
// manifest (ref regex /"version"\s*:\s*"(\d+\.\d+\.\d+)"/).
func zcodeVersionFromManifest(text string) string {
	idx := strings.Index(text, "\"version\"")
	if idx < 0 {
		return ""
	}
	rest := text[idx:]
	colon := strings.IndexByte(rest, ':')
	if colon < 0 {
		return ""
	}
	rest = rest[colon+1:]
	start := strings.IndexByte(rest, '"')
	if start < 0 {
		return ""
	}
	rest = rest[start+1:]
	end := strings.IndexByte(rest, '"')
	if end < 0 {
		return ""
	}
	value := rest[:end]
	if zcodeIsSemver(value) {
		return value
	}
	return ""
}

// zcodeIsSemver reports whether s looks like \d+\.\d+\.\d+.
func zcodeIsSemver(s string) bool {
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" || !isAllDigits(part) {
			return false
		}
	}
	return true
}

// zcodeNewDeviceMid generates a self-owned device id (UUID v4). 实测同一 JWT
// 换任意随机 UUID 都返回 200（值不被服务端绑定校验，只有"存在"是硬需求），
// 故登录一次生成一个并持久化进凭据（ref generateDeviceMid 同款）。
func zcodeNewDeviceMid() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 失败是灾难级，但不能 panic（AGENTS.md）；退化为时间戳
		// 派生的形状合法值，登录本身仍可继续。
		now := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]), hex.EncodeToString(b[4:6]), hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]), hex.EncodeToString(b[10:16]))
}

// firstN truncates s to at most n bytes (ASCII ids only).
func firstN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ── 模型表 ───────────────────────────────────────────────────────────────────

// zcodeModelLevels is the reasoning levels the upstream catalog declares for
// both models (low/high/max, default max). The effort gate only writes
// `output_config.effort` when the requested level is declared here.
var zcodeModelLevels = []string{"low", "high", "max"}

// zcodeModelSupportsImage mirrors the catalog: only GLM-5.3-Flash has
// `capabilities.vision === true` (GLM-5.3's capabilities object is empty).
var zcodeModelSupportsImage = map[string]bool{"GLM-5.3-Flash": true}

// zcodeFallbackModels is the static catalog. ⚠️ 上游清单里还有 GLM-5-Turbo /
// GLM-5.2，但两者在 Start Plan 下实测返回空响应（0/3 vs GLM-5.3 的 3/3），
// 故**不列出** —— 列一个用不了的模型比不列更糟（ref 同款结论）。
func zcodeFallbackModels() ModelTable {
	return ModelTable{
		{ID: "GLM-5.3-Flash", QuotaType: "limited", Note: "ctx 1000000; 1M tokens; vision"},
		{ID: "GLM-5.3", QuotaType: "limited", Note: "ctx 1000000; 1M tokens"},
	}
}

// zcodeModelDeclaresEffort reports whether the model declares the given
// reasoning level (unknown models declare nothing → the effort is dropped).
func zcodeModelDeclaresEffort(model, effort string) bool {
	if effort == "" {
		return false
	}
	known := false
	for _, md := range zcodeFallbackModels() {
		if md.ID == model {
			known = true
			break
		}
	}
	if !known {
		return false
	}
	for _, level := range zcodeModelLevels {
		if level == effort {
			return true
		}
	}
	return false
}

// init registers the bridge key extractor: the key is the zcode JWT (it is
// what goes into `Authorization: Bearer`).
func init() {
	RegisterTokenExtractor("zcode", func(cred jsonRaw) (string, error) {
		var c ZcodeCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", fmt.Errorf("jethub: parse zcode credential: %w", err)
		}
		return c.ZcodeJWT, nil
	})
}

// zcodeOpenURL opens a URL with the platform browser (thin wrapper so the
// login/claim paths share one call site).
func (m *Manager) zcodeOpenURL(url string) { m.OpenURLWithBrowser(url) }

// zcodeClientFor returns the outbound client honoring the provider's Use
// Proxy toggle (same policy as every other provider's management calls).
func (m *Manager) zcodeClientFor() *http.Client { return m.httpClient("zcode") }
