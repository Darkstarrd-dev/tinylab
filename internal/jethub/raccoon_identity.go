package jethub

// Raccoon 登录的**身份（IAM）接口**——2026-10-23 起的正确扫码/短信通路。
//
// ## 为什么必须换（用户报障 2026-10-23：手机扫完显示「二维码过期或已被使用」）
//
// 本端（以及它照抄的上游参考实现）走的是**旧**流程：客户端本地随机生成
// 32 位 hex 的 `qrcode_code`，二维码内容 = `/login/mp?code=<自造码>`，再用
// `POST /api/web/auth/v1/login_with_qrcode_code` 轮询。
//
// 抓官网现网（`xiaohuanxiong.com/login` 的 Next.js 产物）可见流程已经整体迁到
// `/api/iam/v1`，而且 **码是服务端下发的**：
//
//	POST /api/iam/v1/auth/mp/qrcode            {}                    → {qrcode_code, scan_path, expires_in, poll_interval}
//	POST /api/iam/v1/auth/mp/qrcode/login      {qrcode_code}         → {status, access_token?, token_type?}
//	PUT  /api/iam/v1/auth/mp/qrcode            {qrcode_code, status:"canceled"}
//	POST /api/iam/v1/sms/send                  {nation_code, phone, captcha_token, scene:"login"} → {verification_id, ...}
//	POST /api/iam/v1/auth/login/sms            {nation_code, phone, verification_id, verification_code} → {access_token, token_type}
//
// 关键判据（实测）：
//   - 自造码在**旧**接口上仍回 `{"code":0,"data":{"status":"pending"}}`（所以
//     轮询看起来一切正常，缺陷只在手机端），但新版扫码页只认服务端下发的
//     `qr-<uuid>` 码 ⇒ 自造码一律被判「过期或已被使用」。
//   - 服务端下发码形如 `qr-01a167e3-edbf-77f6-8116-8daa8d732239`（不是 32 hex），
//     且带 `scan_path`（当前是 `/login/mp`）、`expires_in`（300s）、
//     `poll_interval`（2s）——有效期与轮询节奏都必须**照抄服务端**，不能写死。
//   - 二维码 URL 由官网前端按 `new URL(scan_path, qrOrigin)` 拼接，再补三个参数
//     `code`、`appname=<brand>`、**`source=platform`**（缺 source 时手机端同样
//     判无效，因为扫码页按来源分支）。`qrOrigin` = `https://xiaohuanxiong.com/`，
//     brand = `商汤小浣熊`（取自 `xiaohuanxiong.com/login` 的站点配置）。
//
// ## 保留旧流程作为**兜底**
//
// `StartRaccoonQRLogin` 先试新接口；只有在新接口不可用（网络/404/信封异常）时
// 才回落到旧的「本地自造码 + `/api/web/auth/v1/login_with_qrcode_code`」——
// 那样至少不会比现状更差，且旧流程在客户端里仍有实测依据。

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	// 身份（IAM）接口前缀；与业务接口 `/api/web/...` 是两套系统（token 由同一
	// 平台签发，业务接口用 Bearer 复用同一份 access_token）。
	raccoonIAMPrefix = "/api/iam/v1"

	raccoonQRIAMCreatePath   = "/auth/mp/qrcode"
	raccoonQRIAMPollPath     = "/auth/mp/qrcode/login"
	raccoonIAMSMSendPath     = "/sms/send"
	raccoonIAMSMSLoginPath   = "/auth/login/sms"
	raccoonIAMAccountPath    = "/account"
	raccoonIAMConfirmPath    = "/iam/confirm"
	raccoonIAMSMSNationCode  = "86"
	raccoonIAMSMSScene       = "login"
	raccoonQRSourcePlatform  = "platform"
	raccoonQRDefaultAppName  = "商汤小浣熊" // 官网 brand；旧流程用的 `商汤小浣熊官网` 已不是现网值
	raccoonQRDefaultExpires  = 5 * time.Minute
	raccoonQRDefaultInterval = 2 * time.Second
)

// Aliyun captcha 配置（`xiaohuanxiong.com/login` 站点配置里的
// `captcha:{scene,prefix,region}`）。短信接口要求 `captcha_token` 是该滑块的
// 产物，故本地登录页必须用同一份 SceneId/prefix 初始化官方 SDK。
const (
	RaccoonCaptchaScene  = "1pkmy0x3"
	RaccoonCaptchaPrefix = "hk1r5l"
)

// RaccoonQRTicket 是服务端下发的一次扫码票据。
type RaccoonQRTicket struct {
	// Code 是服务端生成的二维码码（形如 `qr-<uuid>`）——不是客户端随机串。
	Code string
	// ScanPath 是扫码页路径（当前 `/login/mp`）；拼接时必须用它，不要写死。
	ScanPath string
	// ExpiresIn / PollInterval 由服务端给出，必须照抄（见文件头）。
	ExpiresIn    time.Duration
	PollInterval time.Duration
}

// RaccoonQRURL 把票据拼成二维码内容：
//
//	{apiBase}{scan_path}?code=<code>&appname=<brand>&source=platform
//
// ⚠️ 三个参数缺一不可：`source=platform` 缺失时扫码页按来源分支直接判无效。
func RaccoonQRURL(t *RaccoonQRTicket) string {
	if t == nil {
		return ""
	}
	path := t.ScanPath
	if path == "" {
		path = raccoonQRLegacyScanPath
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return raccoonAPIBase + path +
		"?code=" + urlQueryEscape(t.Code) +
		"&appname=" + urlQueryEscape(raccoonQRDefaultAppName) +
		"&source=" + raccoonQRSourcePlatform
}

// raccoonIAMRequest 发一次 IAM 请求并返回 `data` 对象。
//
// ⚠️ IAM 的信封与业务接口**不同**：`code` 是字符串（成功为 `"OK"`，失败是
// `"AUTH_QRCODE_EXPIRED"` 这类枚举），所以不能直接用 `bodyCode`（它只认数字，
// 会把字符串码一律读成 0 = 成功，把失败当成功）。
func (m *Manager) raccoonIAMRequest(ctx context.Context, method, path, body string) (map[string]any, error) {
	return m.raccoonIAMRequestAs(ctx, method, path, body, "")
}

// raccoonIAMRequestAs 是带 Bearer 的变体（`/account` 这类需要登录态的读端点）。
//
// ⚠️ 独立出站管线：**不能带 Desktop 客户端专用的平台 Header**（如
// `X-Client-Platform: desktop-windows` 或 `X-Client-Version`），否则小浣熊
// IAM 认证中心会把生成的票据归属到桌面端，导致手机微信扫码时报平台冲突（用户
// 实测报障「当前 raccoon 扫二维码仍然 iam 出错」）。IAM 接口仅需标准的 Web Headers。
func (m *Manager) raccoonIAMRequestAs(ctx context.Context, method, path, body, token string) (map[string]any, error) {
	var reader io.Reader
	if body != "" {
		reader = strReader(body)
	}
	url := raccoonAPIBase + raccoonIAMPrefix + path
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := m.httpClient("raccoon").Do(req)
	if err != nil {
		return nil, fmt.Errorf("raccoon: 身份接口请求失败：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			return nil, fmt.Errorf("raccoon: 凭据已失效（HTTP %d），请重新登录", resp.StatusCode)
		}
		return nil, fmt.Errorf("raccoon: 身份接口响应不是 JSON（HTTP %d）", resp.StatusCode)
	}
	env := parseRaccoonEnvelope(parsed, resp.StatusCode)
	if env.Data == nil {
		return nil, env.err("身份接口返回空数据")
	}
	if code, ok := envRawCode(env); ok && !raccoonIAMCodeOK(code) {
		return nil, fmt.Errorf("raccoon: %s", firstNonEmpty(env.Message, code))
	}
	return env.Data, nil
}

// envRawCode re-reads the envelope's `code` as its original string form. The
// shared envelope struct normalises codes to int64, so the IAM client keeps a
// side channel (§file comment) — see raccoonRequest's parse step.
func envRawCode(env *raccoonEnvelope) (string, bool) {
	if env == nil || env.RawCode == "" {
		return "", false
	}
	return env.RawCode, true
}

// raccoonIAMCodeOK: IAM success codes are the string "OK" (new) or numeric 0
// (some deployments still answer numeric).
func raccoonIAMCodeOK(code string) bool {
	switch strings.ToUpper(strings.TrimSpace(code)) {
	case "", "OK", "0", "SUCCESS":
		return true
	}
	return false
}

// CreateRaccoonQRTicket 申请一张服务端票据（`POST /auth/mp/qrcode`）。
func (m *Manager) CreateRaccoonQRTicket(ctx context.Context) (*RaccoonQRTicket, error) {
	data, err := m.raccoonIAMRequest(ctx, http.MethodPost, raccoonQRIAMCreatePath, `{}`)
	if err != nil {
		return nil, err
	}
	code := jsonStringField(data, "qrcode_code")
	if code == "" {
		return nil, fmt.Errorf("raccoon: 二维码票据缺少 qrcode_code")
	}
	t := &RaccoonQRTicket{
		Code:         code,
		ScanPath:     jsonStringField(data, "scan_path"),
		ExpiresIn:    time.Duration(int(jsonNumberField(data, "expires_in"))) * time.Second,
		PollInterval: time.Duration(int(jsonNumberField(data, "poll_interval"))) * time.Second,
	}
	if t.ExpiresIn <= 0 {
		t.ExpiresIn = raccoonQRDefaultExpires
	}
	if t.PollInterval <= 0 {
		t.PollInterval = raccoonQRDefaultInterval
	}
	return t, nil
}

// PollRaccoonQRTicket 轮询一次扫码状态（`POST /auth/mp/qrcode/login`）。
// 与旧流程同一条纪律：**任何异常都降级成 pending**（2s 循环，偶发失败不该
// 中断；把未知判成 success 会拿到空 token 卡死，判成 canceled 会刷新用户
// 正在扫的码）。
func (m *Manager) PollRaccoonQRTicket(ctx context.Context, code string) (string, *RaccoonCredential) {
	body, _ := json.Marshal(map[string]string{"qrcode_code": code})
	data, err := m.raccoonIAMRequest(ctx, http.MethodPost, raccoonQRIAMPollPath, string(body))
	if err != nil {
		return raccoonQRStatusPending, nil
	}
	switch status := jsonStringField(data, "status"); status {
	case raccoonQRStatusCanceled:
		return raccoonQRStatusCanceled, nil
	case raccoonQRStatusLogging:
		return raccoonQRStatusLogging, nil
	case raccoonQRStatusSuccess:
		token := jsonStringField(data, "access_token")
		if token == "" {
			// 没有 token 的 success 视为未完成（否则会产出空凭据并卡死）。
			return raccoonQRStatusPending, nil
		}
		return raccoonQRStatusSuccess, raccoonCredentialFromIdentityToken(token, data)
	}
	return raccoonQRStatusPending, nil
}

// CancelRaccoonQRTicket 主动取消票据（`PUT /auth/mp/qrcode`）。失败不打扰用户
// （票据会按 expires_in 自然过期）。
func (m *Manager) CancelRaccoonQRTicket(ctx context.Context, code string) {
	if code == "" {
		return
	}
	body, _ := json.Marshal(map[string]string{"qrcode_code": code, "status": raccoonQRStatusCanceled})
	_, _ = m.raccoonIAMRequest(ctx, http.MethodPut, raccoonQRIAMCreatePath, string(body))
}

// SendRaccoonSMS 下发短信验证码（`POST /sms/send`）。
//
// ⚠️ 手机号必须走 AES-128-CFB 加密（小浣熊统一身份认证中心要求）；
// `captcha_token` 是阿里云滑块产物的**必需项**（空/伪造一律 400）。
func (m *Manager) SendRaccoonSMS(ctx context.Context, phone, captchaToken string) (string, error) {
	encryptedPhone, err := EncryptRaccoonPhone(phone, nil)
	if err != nil {
		return "", fmt.Errorf("raccoon: 加密手机号失败：%w", err)
	}
	body, _ := json.Marshal(map[string]string{
		"nation_code":   raccoonIAMSMSNationCode,
		"phone":         encryptedPhone,
		"captcha_token": captchaToken,
		"scene":         raccoonIAMSMSScene,
	})
	data, err := m.raccoonIAMRequest(ctx, http.MethodPost, raccoonIAMSMSendPath, string(body))
	if err != nil {
		return "", err
	}
	verificationID := jsonStringField(data, "verification_id")
	if verificationID == "" {
		return "", fmt.Errorf("raccoon: 短信接口未返回 verification_id")
	}
	return verificationID, nil
}

// LoginRaccoonWithSMSVerification 用手机号 + 验证码完成登录
// （`POST /auth/login/sms`）。
func (m *Manager) LoginRaccoonWithSMSVerification(ctx context.Context, phone, verificationID, smsCode string) (*RaccoonCredential, error) {
	encryptedPhone, err := EncryptRaccoonPhone(phone, nil)
	if err != nil {
		return nil, fmt.Errorf("raccoon: 加密手机号失败：%w", err)
	}
	body, _ := json.Marshal(map[string]string{
		"nation_code":       raccoonIAMSMSNationCode,
		"phone":             encryptedPhone,
		"verification_id":   verificationID,
		"verification_code": smsCode,
	})
	data, err := m.raccoonIAMRequest(ctx, http.MethodPost, raccoonIAMSMSLoginPath, string(body))
	if err != nil {
		return nil, err
	}
	token := jsonStringField(data, "access_token")
	if token == "" {
		return nil, fmt.Errorf("raccoon: 短信登录未返回 access_token")
	}
	return raccoonCredentialFromIdentityToken(token, data), nil
}

// raccoonCredentialFromIdentityToken 由 IAM 的 access_token 组装凭据。
//
// ⚠️ IAM 不给 refresh_token（站点用的是长效 cookie）：凭据因此**不可续期**，
// 过期后只能重新登录 —— 这与旧流程（有 refresh_token）刻意不同，登记在
// `RaccoonRefreshable` 的判据里（无 refresh_token ⇒ false）。
func raccoonCredentialFromIdentityToken(token string, data map[string]any) *RaccoonCredential {
	cred := &RaccoonCredential{
		AccessToken:  token,
		RefreshToken: jsonStringField(data, "refresh_token"),
	}
	if exp := jwtExpiresAtMs(token); exp > 0 {
		cred.ExpiresAt = fmt.Sprintf("%d", exp)
	}
	return cred
}

// FetchRaccoonAccountInfo 用 IAM 的 `/account` 补展示信息（新 token 不一定被
// 旧 `/api/web/auth/v1/user_info` 接受，故两条都试）。
func (m *Manager) FetchRaccoonAccountInfo(ctx context.Context, cred *RaccoonCredential) (userID, nickname, phone string) {
	if cred == nil || cred.AccessToken == "" {
		return "", "", ""
	}
	data, err := m.raccoonIAMRequestAs(ctx, http.MethodGet, raccoonIAMAccountPath, "", cred.AccessToken)
	if err != nil {
		return "", "", ""
	}
	user, _ := data["user"].(map[string]any)
	if user == nil {
		return "", "", ""
	}
	return jsonStringField(user, "platform_user_id"),
		jsonStringField(user, "name"),
		jsonStringField(user, "phone")
}

// ConfirmRaccoonIAM 向小浣熊业务网关确认 IAM 会话（`POST /api/web/auth/v1/iam/confirm`）。
//
// ⚠️ 小浣熊架构硬约束：通过 IAM 登录（微信扫码或短信）签发的 access_token，在访问业务接口
// （`/api/web/...`，包括余额 / 模型目录 / 聊天推理）之前，必须先调此端点进行业务会话确认；
// 否则服务端业务网关统一报错 200901（`iam_confirm_required: IAM confirmation required`）。
func (m *Manager) ConfirmRaccoonIAM(ctx context.Context, token string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return fmt.Errorf("jethub: raccoon confirm token empty")
	}
	url := raccoonAPIBase + raccoonAuthPrefix + raccoonIAMConfirmPath
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader("{}"))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Raccoon-Language", "zh")

	resp, err := m.httpClient("raccoon").Do(req)
	if err != nil {
		return fmt.Errorf("jethub: raccoon iam confirm: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("jethub: raccoon iam confirm read body: %w", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("jethub: raccoon iam confirm json decode: %w", err)
	}
	env := parseRaccoonEnvelope(payload, resp.StatusCode)
	if env.Code != 0 {
		return env.err("IAM 会话确认失败")
	}
	return nil
}
