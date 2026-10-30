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
// ⚠️ **不读本机 ZCode 客户端的数据**（2026-10-05，用户决定，对齐上游 `2e8bb86`）：
// 凭据只有**一条来源** —— 本插件自己的 OAuth 设备授权流（纯 HTTP，zcode_login.go）。
// 原先还有一条「装了官方客户端并登录过 ⇒ 解密其凭据文件零操作可用」的旁路，已整体
// 删除，理由见 docs/jethub-upstream-sync.md §6 R4：
//
//  1. **安全**：那条路等价于「任何本地进程都能解密 ZCode 的登录凭据」（官方用
//     sha256(平台 + 家目录 + 用户名) 派生 AES-256-GCM 密钥，算法公开可复现），
//     把它复制进本端意味着本端具备读取用户**另一个应用**登录态的能力；
//  2. **正确性**：它在 zai 渠道下双重失效（两个渠道的 `user_info` **结构**不同：
//     bigmodel 是 `{id, username, displayName, rawProfile}`、zai 是
//     `{user_id, email, avatar, name}`）—— 于是 `user_id` 恒缺、账号标签退化成
//     「设备xxxxxxxx」；
//  3. **一致性**：本端本来就有完整可用的 OAuth 流程，旧路径是条功能更差的旁路。
//
// ⚠️ **修改本文件时不得重新引入**对官方客户端安装目录（凭据文件、遥测状态、安装
// 清单）的任何读取：`zcode_local_read_test.go` 以**扫源码字面量**的方式守着
// （断言某个函数不存在，对新写的读取函数无效）。

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"runtime"
	"strconv"
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
// installed official client cannot be probed (ref ZCODE_APP_VERSION_FALLBACK;
// ⚠️ 不随官方升级整体抬高 —— 推理路径的既有实测结论都是在 3.14.3 上取的).
const zcodeAppVersionFallback = "3.14.3"

// zcodeVersionGatedMinAppVersion is the minimum version the official client
// requires for the version-gated paths (ref ZCODE_VERSION_GATED_MIN_APP_VERSION).
// 营销投放查询与领取低于它会被静默降级（投放为空 / 1004 no permission）。
const zcodeVersionGatedMinAppVersion = "3.16.3"

// zcodeStableSessionID is the process-level pseudo session id (ref
// ZCODE_STABLE_SESSION_ID): official client has one per conversation; we have no
// conversation layer, so one per process is closer to reality than per request.
var zcodeStableSessionID = zcodeNewDeviceMid()

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

// zcodeAppVersion resolves the **clean** credential version (query/body sites).
//
// ⚠️ 凭据里的 app_version 会原样进 User-Agent / 头 / URL query。脏值
// （`3.16.3\r\nX-Injected: 1`、空串、`3.016.3`）既可能让头写入抛错，也会被
// 版本门控当成「更大/等值」绕过门控（ref 2026-10-25 审计实测）。故非干净
// semver 一律回落兜底常量（ref zcodeCredentialAppVersion）。
func (c *ZcodeCredential) zcodeAppVersion() string {
	if c != nil && zcodeValidAppVersion(c.AppVersion) {
		return strings.TrimSpace(c.AppVersion)
	}
	return zcodeAppVersionFallback
}

// zcodeGatedAppVersion is the version used in **headers** (ref
// zcodeVersionGatedAppVersion): max(clean credential version, 3.16.3).
//
// 只抬不降 —— 用户若在更新的官方客户端上登录（凭据写着 3.17.x），用他自己的
// 版本号。⚠️ 不改凭据本身（那会让推理路径的既有实测结论一起作废）。
func (c *ZcodeCredential) zcodeGatedAppVersion() string {
	version := c.zcodeAppVersion()
	if version == zcodeAppVersionFallback {
		return zcodeVersionGatedMinAppVersion
	}
	if zcodeCompareAppVersion(version, zcodeVersionGatedMinAppVersion) < 0 {
		return zcodeVersionGatedMinAppVersion
	}
	return version
}

// zcodeValidAppVersion mirrors ref ZCODE_APP_VERSION_PATTERN:
// `major.minor.patch`, digits only, no leading zeros.
func zcodeValidAppVersion(version string) bool {
	version = strings.TrimSpace(version)
	if version == "" {
		return false
	}
	parts := strings.Split(version, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return false
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

// zcodeCompareAppVersion compares two valid `major.minor.patch` versions.
func zcodeCompareAppVersion(a, b string) int {
	as := strings.Split(a, ".")
	bs := strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		ai, _ := strconv.Atoi(as[i])
		bi, _ := strconv.Atoi(bs[i])
		if ai < bi {
			return -1
		}
		if ai > bi {
			return 1
		}
	}
	return 0
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

// ── 请求头 ───────────────────────────────────────────────────────────────────

// zcodeHeaders builds the official-client header family (ref buildZcodeHeaders @
// 9ffd65e, 2026-10-25 真机抓包逐字对齐).
//
// ## 为什么从 10 个头扩到 18 个（R10）
//
// 官方 GUI 的一次 `/v1/messages` 带 18 个头；本端此前只有 10 个，且
// `X-Release-Channel`（stable ✗ → production）与 `X-Platform`
// （win32 ✗ → win32-x64）两个值与官方不符。叠加旧版本号后，推理请求在
// 官方 3.16.3 上线后稳定 `405 + unusual activity`（跨账号、跨会话）。
//
// ⚠️ `X-Device-Mid` 仍是 billing 全家桶的硬需求（缺它 400 code 3001）。
// ⚠️ `X-Os-Version` 必须与 `X-Platform`/`X-Os-Category` 同源：非 Windows
// 宿主上三者一起伪装（ref zcodeClientPlatform；只换其中一个反而自相矛盾）。
func zcodeHeaders(cred *ZcodeCredential, withJSON bool, captcha *zcodeCaptchaParam) map[string]string {
	version := cred.zcodeGatedAppVersion()
	platform, osCategory, osVersion := zcodeClientPlatform()
	headers := map[string]string{
		"User-Agent":           "ZCode/" + version,
		"HTTP-Referer":         zcodeOrigin,
		"X-Title":              "Z Code@electron",
		"X-ZCode-App-Version":  version,
		"X-Release-Channel":    "production",
		"X-Client-Language":    "zh-CN",
		"X-Client-Timezone":    "Asia/Shanghai",
		"X-Device-Mid":         cred.DeviceMid,
		"X-Platform":           platform,
		"X-Os-Category":        osCategory,
		"X-Os-Version":         osVersion,
		"X-ZCode-Agent":        "glm",
		"X-Session-Id":         zcodeStableSessionID,
		"X-ZCode-Session-Type": "other",
		"X-Request-Id":         zcodeNewDeviceMid(),
		"X-ZCode-Trace-Id":     zcodeNewDeviceMid(),
		"anthropic-version":    "2023-06-01",
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

// zcodeSpoofOSVersion is the OS release advertised on non-Windows hosts (ref
// ZCODE_SPOOF_PLATFORM; the platform triple must stay self-consistent).
const zcodeSpoofOSVersion = "10.0.26100"

// zcodeClientPlatform returns the platform triple that must stay self-consistent.
// Windows hosts report their real OS release; other hosts spoof the official
// Windows shape (ref zcodeClientPlatform + ZCODE_SPOOF_PLATFORM).
func zcodeClientPlatform() (platform, osCategory, osVersion string) {
	if runtime.GOOS == "windows" {
		return "win32-x64", "windows", zcodeOSVersion()
	}
	return "win32-x64", "windows", zcodeSpoofOSVersion
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
// login/claim paths share one call site). ⚠️ It pins **default browser +
// shared session** explicitly instead of passing the zero value: the zero
// value inherits the remembered +新建账号 preference (login_open.go
// normalizeOpenOptions), which is the wrong default here — the claim carrier
// page is a background action that runs the Aliyun SDK's traceless
// verification and needs NO login state (the claim JWT lives server-side).
// Inheriting a login-oriented preference made the carrier page follow the
// user's Edge login choice (2026-10-07 报障) even though the system default
// browser was Chrome. The login flow (zcodeLogin in internal/api/jethub) keeps
// passing the per-request user choice; only this background path pins the
// pre-feature behavior (shell → OS default browser, shared profile).
func (m *Manager) zcodeOpenURL(url string) {
	m.OpenURLWithBrowser(url, OpenOptions{Browser: BrowserDefault, Session: SessionShared})
}

// zcodeClientFor returns the outbound client honoring the provider's Use
// Proxy toggle (same policy as every other provider's management calls).
func (m *Manager) zcodeClientFor() *http.Client { return m.httpClient("zcode") }
