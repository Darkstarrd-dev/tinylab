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
// login/claim paths share one call site). The captcha carrier page is a
// background action with no per-request choice, so the zero value — i.e. the
// remembered browser/session preference — applies.
func (m *Manager) zcodeOpenURL(url string) { m.OpenURLWithBrowser(url, OpenOptions{}) }

// zcodeClientFor returns the outbound client honoring the provider's Use
// Proxy toggle (same policy as every other provider's management calls).
func (m *Manager) zcodeClientFor() *http.Client { return m.httpClient("zcode") }
