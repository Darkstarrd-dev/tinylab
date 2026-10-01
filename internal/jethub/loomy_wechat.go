package jethub

import (
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Loomy 微信扫码登录协议 —— 1:1 移植 ref `src/loomy-wechat.ts`（2026-09-26 真机
// 实测打通：授权页内嵌 uuid、二维码是 JPEG、纯长轮询拿 code）。
//
// ⚠️ **为什么不能沿用「短信弹窗」**（用户实测报障）：插件里 loomy 的「新建账号」
// 走**微信扫码 + 本地弹窗页**（`account.create` → `startWechatLogin()` → 返回本地页
// URL → `window.open`），短信只是**无 UI 的休眠备用路径**（ref jet-hub-rpc.ts 里
// `login.sendSms`/`login.submitSms` 的注释；早期那个「短信表单」分支因**顺序死锁**
// 已被删除）。本文件补齐微信链路。
//
// ⚠️ 三条逆向/实测约束（改这里前先读 ref 的原注释）：
//  1. `redirect_uri` **必须**是官方白名单地址 `https://loomy.xunfei.cn/oauth/wechat/callback`
//     —— 换成 127.0.0.1 或任意域名会被微信回「redirect_uri 参数错误」页；而那个回调页
//     实测 **404**，不参与回调（我们靠长轮询拿 code，不碰回调）。
//  2. 二维码是微信下发的 **JPEG**（不是 PNG），且 uuid 由授权页 HTML **正则提取**
//     （页面无需执行 JS）—— 提取不到必须显式报错，不能返回空串去轮询（会永远 waiting）。
//  3. `wx_errcode` 语义：**405 = 已确认（wx_code 就在这一帧）**、**404 = 已扫码待确认**。
//     ⚠️ 参考实现曾把两者读反，导致「扫码后卡住、凭据永远为空」；照抄，别按直觉改。

const (
	// loomyWechatAppID: 取自客户端 .env.prod（非机密，随客户端分发）。
	loomyWechatAppID = "wx18d60be432287cf8"
	// loomyWechatRedirectURI: 官方白名单回调地址（实测换本地地址会被微信拒绝）。
	loomyWechatRedirectURI = "https://loomy.xunfei.cn/oauth/wechat/callback"
	// loomyWechatUA: Chrome/120 —— 微信授权页对 UA 敏感。
	loomyWechatUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	// loomyWechatPollTimeout: 微信侧约 25 秒无状态变化才返回（ref 给 40s 余量），
	// 而本项目的共享出站 client 是 30s 上限 —— 取 25s 既跟得上微信的节奏，
	// 又不会被 client 提前掐断。
	loomyWechatPollTimeout = 25 * time.Second
	// loomyWechatQrTimeout: 二维码图片拉取预算（实测约 47KB）。
	loomyWechatQrTimeout = 20 * time.Second
	// loomyWechatAuthTimeout: 授权页 HTML 拉取预算。
	loomyWechatAuthTimeout = 20 * time.Second
)

// 轮询状态（与 ref LOOMY_WECHAT_POLL_STATUS 同名同义）。
const (
	loomyWechatStatusWaiting   = "waiting"
	loomyWechatStatusScanned   = "scanned"
	loomyWechatStatusConfirmed = "confirmed"
	loomyWechatStatusCancelled = "cancelled"
	loomyWechatStatusExpired   = "expired"
	loomyWechatStatusError     = "error"
)

// ⚠️ 字符集/长度刻意放宽（6–64）：微信未承诺 uuid 形态，收紧只会让格式微调时**静默失效**。
var loomyWechatUUIDRe = regexp.MustCompile(`^[A-Za-z0-9_\-=+/]{6,64}$`)

// 主路径：授权页内嵌 `<img class="js_qrcode_img" src="/connect/qrcode/<uuid>">`。
var loomyWechatUUIDFromImgRe = regexp.MustCompile(`/connect/qrcode/([A-Za-z0-9_\-=+/]+)`)

// 兜底：页面里的长轮询 URL `…/connect/l/qrconnect?uuid=<uuid>`。
var loomyWechatUUIDFromPollRe = regexp.MustCompile(`l/qrconnect\?uuid=([A-Za-z0-9_\-=+/]+)`)

var (
	loomyWechatErrcodeRe = regexp.MustCompile(`wx_errcode\s*=\s*(\d+)`)
	loomyWechatCodeRe    = regexp.MustCompile(`wx_code\s*=\s*'([^']*)'`)
)

// 微信端点基址 —— var 以便测试指向 mock server（生产值即官方域名）。
var (
	loomyWechatAuthBase = "https://open.weixin.qq.com"
	loomyWechatLongBase = "https://long.open.weixin.qq.com"
)

// BuildLoomyWechatAuthURL 拼微信授权页地址（二维码内容由该页内嵌的 uuid 决定）。
func BuildLoomyWechatAuthURL(state string) string {
	return loomyWechatAuthBase + "/connect/qrconnect" +
		"?appid=" + url.QueryEscape(loomyWechatAppID) +
		"&redirect_uri=" + url.QueryEscape(loomyWechatRedirectURI) +
		"&response_type=code&scope=snsapi_login" +
		"&state=" + url.QueryEscape(state) +
		"#wechat_redirect"
}

// ExtractLoomyWechatUUID 从授权页 HTML 提取二维码 uuid（两条正则互兜底）；
// 提取不到返回空串，由调用方决定是否报错。
func ExtractLoomyWechatUUID(html string) string {
	if html == "" {
		return ""
	}
	if m := loomyWechatUUIDFromImgRe.FindStringSubmatch(html); m != nil && loomyWechatUUIDRe.MatchString(m[1]) {
		return m[1]
	}
	if m := loomyWechatUUIDFromPollRe.FindStringSubmatch(html); m != nil && loomyWechatUUIDRe.MatchString(m[1]) {
		return m[1]
	}
	return ""
}

// BuildLoomyWechatQRImageURL 拼二维码图片地址（微信下发 JPEG）。
func BuildLoomyWechatQRImageURL(uuid string) string {
	return loomyWechatAuthBase + "/connect/qrcode/" + url.QueryEscape(uuid)
}

// loomyWechatState 生成 32 位随机 hex（微信原样回传；本实现不依赖它）。
func loomyWechatState() string {
	var b [16]byte
	for i := range b {
		b[i] = byte(nowMillis() >> (uint(i%8) * 8))
	}
	return hex.EncodeToString(b[:])
}

// loomyWechatGET 发一次带微信 UA/Referer 的 GET（走 per-provider 出站 client，
// 复用 Use Proxy 开关）。
func (m *Manager) loomyWechatGET(ctx context.Context, target string, timeout time.Duration) (body []byte, status int, contentType string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, 0, "", err
	}
	req.Header.Set("User-Agent", loomyWechatUA)
	req.Header.Set("Referer", "https://open.weixin.qq.com/")
	tctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient("loomy").Do(req)
	if err != nil {
		return nil, 0, "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	return raw, resp.StatusCode, resp.Header.Get("Content-Type"), nil
}

// FetchLoomyWechatUUID 拉授权页并提取 uuid。⚠️ 失败/提取不到一律显式报错 ——
// 否则上层会拿空 uuid 去轮询，用户只看到「一直等待」而没有任何原因。
func (m *Manager) FetchLoomyWechatUUID(ctx context.Context, state string) (string, error) {
	raw, status, _, err := m.loomyWechatGET(ctx, BuildLoomyWechatAuthURL(state), loomyWechatAuthTimeout)
	if err != nil {
		return "", fmt.Errorf("微信授权页拉取失败：%w", err)
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("微信授权页返回 HTTP %d", status)
	}
	uuid := ExtractLoomyWechatUUID(string(raw))
	if uuid == "" {
		return "", fmt.Errorf("微信授权页未包含二维码 uuid（页面结构可能已变化）")
	}
	return uuid, nil
}

// FetchLoomyWechatQRImage 下载二维码图片并返回 (bytes, mime)。
// ⚠️ 按**魔数**判类型（实测为 JPEG；只认 PNG 会把真二维码误判成「不是图片」）。
func (m *Manager) FetchLoomyWechatQRImage(ctx context.Context, uuid string) ([]byte, string, error) {
	raw, status, _, err := m.loomyWechatGET(ctx, BuildLoomyWechatQRImageURL(uuid), loomyWechatQrTimeout)
	if err != nil {
		return nil, "", fmt.Errorf("二维码图片拉取失败：%w", err)
	}
	if status < 200 || status >= 300 {
		return nil, "", fmt.Errorf("二维码图片返回 HTTP %d", status)
	}
	mime := loomyImageMime(raw)
	if mime == "" || len(raw) < 200 {
		// 不把 HTML 错误页当二维码渲染给用户。
		return nil, "", fmt.Errorf("二维码图片内容不是已知图片格式（可能是错误页）")
	}
	return raw, mime, nil
}

// loomyImageMime 按魔数识别 PNG / JPEG / GIF。
func loomyImageMime(b []byte) string {
	switch {
	case len(b) >= 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n":
		return "image/png"
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg"
	case len(b) >= 6 && (string(b[:6]) == "GIF87a" || string(b[:6]) == "GIF89a"):
		return "image/gif"
	}
	return ""
}

// PollLoomyWechatOnce 执行一次微信长轮询。⚠️ 网络异常返回 `error` 状态而**不抛错**
// （长轮询偶发失败不该终止整个流程，由调用方决定是否继续）。
func (m *Manager) PollLoomyWechatOnce(ctx context.Context, uuid, lastErrcode string) (status, code, errcode string) {
	if uuid == "" {
		return loomyWechatStatusError, "", "empty uuid"
	}
	target := loomyWechatLongBase + "/connect/l/qrconnect?uuid=" + url.QueryEscape(uuid)
	if lastErrcode != "" {
		target += "&last=" + url.QueryEscape(lastErrcode)
	}
	target += fmt.Sprintf("&_=%d", nowMillis())
	raw, _, _, err := m.loomyWechatGET(ctx, target, loomyWechatPollTimeout)
	if err != nil {
		return loomyWechatStatusError, "", err.Error()
	}
	body := string(raw)
	if m := loomyWechatErrcodeRe.FindStringSubmatch(body); m != nil {
		errcode = m[1]
	}
	if m := loomyWechatCodeRe.FindStringSubmatch(body); m != nil {
		code = m[1]
	}
	switch errcode {
	case "405":
		// ⚠️ 405 = 已确认。但 405 却没带 code 是异常形态 ⇒ 保守判 scanned
		// （**绝不**拿空 code 去换 session）。
		if code != "" {
			return loomyWechatStatusConfirmed, code, errcode
		}
		return loomyWechatStatusScanned, "", errcode
	case "404":
		// 404 = 已扫码待确认，继续轮询。
		return loomyWechatStatusScanned, "", errcode
	case "403":
		return loomyWechatStatusCancelled, "", errcode
	case "402":
		return loomyWechatStatusExpired, "", errcode
	}
	// 408 与未知值一律 waiting（保守：绝不误判成功）。
	return loomyWechatStatusWaiting, "", errcode
}

// --- 微信扫码之后的「绑手机号」四步（ref src/loomy-oauth.ts） ---
//
// ⚠️ 微信 code **只在第一步用一次**；后续三步只用 `rcode`。

// LoomyThirdAuth is the `bind/auth` result.
type LoomyThirdAuth struct {
	Rcode    string
	Bind     int // 1 = 微信侧已绑过手机号（可直接 skip）；缺失时归 0（保守）
	Nickname string
}

// BindLoomyThirdAccount exchanges the WeChat code for an `rcode`.
func (m *Manager) BindLoomyThirdAccount(ctx context.Context, code string) (*LoomyThirdAuth, error) {
	data, err := m.postLoomyAccount(ctx, "/login/thirdAccount/bind/auth", map[string]any{
		"tcode": map[string]any{"code": code}, "type": "wx",
	})
	if err != nil {
		return nil, err
	}
	rcode := jsonStringField(data, "rcode")
	if rcode == "" {
		// 没有 rcode 后续三步全做不了 ⇒ 明确报错，别让流程走到一半才失败。
		return nil, fmt.Errorf("微信授权响应缺少 rcode")
	}
	auth := &LoomyThirdAuth{Rcode: rcode, Nickname: jsonStringField(data, "nickname")}
	// ⚠️ `bind` 缺失归 0（走绑定流程）：**保守方向** —— 若实际已绑，用户最多多填
	// 一次手机号；若实际未绑却跳过，会拿到一个没有手机号的账号。
	if v, ok := data["bind"]; ok {
		if n, ok := jsonNumberAsInt(v); ok && n == 1 {
			auth.Bind = 1
		}
	}
	return auth, nil
}

// BindLoomySendMsg sends the binding SMS code; returns the msgid (required later).
func (m *Manager) BindLoomySendMsg(ctx context.Context, rcode, phone string) (string, error) {
	data, err := m.postLoomyAccount(ctx, "/login/thirdAccount/bind/sendMsg", map[string]any{
		"rcode": rcode, "phone": phone, "ccode": "86", "expire": loomySMSTTL,
	})
	if err != nil {
		return "", err
	}
	msgid := jsonStringField(data, "msgid")
	if msgid == "" {
		return "", fmt.Errorf("绑定手机号响应缺少 msgid")
	}
	return msgid, nil
}

// BindLoomyCheckCode verifies the binding code and returns the session.
func (m *Manager) BindLoomyCheckCode(ctx context.Context, rcode, code, msgid string) (*LoomyLoginResult, error) {
	data, err := m.postLoomyAccount(ctx, "/login/thirdAccount/bind/checkCode", map[string]any{
		"rcode": rcode, "mcode": code, "msgid": msgid, "expire": loomySessionTTL,
	})
	if err != nil {
		return nil, err
	}
	session := jsonStringField(data, "session")
	userid := jsonStringField(data, "userid")
	if session == "" {
		return nil, fmt.Errorf("绑定登录响应缺少 session")
	}
	if userid == "" {
		return nil, fmt.Errorf("绑定登录响应缺少 userid")
	}
	return &LoomyLoginResult{Session: session, UserID: userid, Phone: jsonStringField(data, "phone")}, nil
}

// BindLoomySkip skips the phone binding (already bound on the WeChat side).
func (m *Manager) BindLoomySkip(ctx context.Context, rcode string) (*LoomyLoginResult, error) {
	data, err := m.postLoomyAccount(ctx, "/login/thirdAccount/bind/skip", map[string]any{
		"rcode": rcode, "expire": loomySessionTTL,
	})
	if err != nil {
		return nil, err
	}
	session := jsonStringField(data, "session")
	userid := jsonStringField(data, "userid")
	if session == "" {
		return nil, fmt.Errorf("微信登录响应缺少 session")
	}
	if userid == "" {
		return nil, fmt.Errorf("微信登录响应缺少 userid")
	}
	return &LoomyLoginResult{Session: session, UserID: userid}, nil
}

// jsonNumberAsInt accepts the JSON numbers encoding/json produces.
func jsonNumberAsInt(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	}
	return 0, false
}

// loomyPhoneTail returns the last 4 digits of a phone number (account naming).
func loomyPhoneTail(phone string) string {
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, phone)
	if len(digits) < 4 {
		return digits
	}
	return digits[len(digits)-4:]
}
