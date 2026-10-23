package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// timeNowPlus / timeAfter are tiny time indirections for readability.
func timeNowPlus(d time.Duration) int64 { return time.Now().Add(d).UnixMilli() }
func timeAfter(d time.Duration) <-chan time.Time {
	return time.After(d)
}

// Raccoon Manager services (ref raccoon-auth.ts / raccoon-credits.ts /
// raccoon-adapter.ts).

// StartRaccoonQRLogin starts the two-step scan flow.
//
// ⚠️ `pageURL` 是**本地登录页**的地址（/free-hub-login.html?loginId=…），不是
// 二维码内容。参考实现同样是自建页面：二维码内容
// （`{base}/login/mp?code=…&appname=…`）必须被**微信扫码**打开，直接用浏览器
// 打开那串 URL 是普通网页、无法鉴权（用户实测报障 2026-10-01）。故这里把两者
// 分开：LoginURL = 浏览器要打开的页面，QRContent = 页面要画的二维码内容。
//
// 浏览器由调用方在会话注册**之后**打开（见 API 层）：先注册再开页面，避免
// 页面抢在会话登记前请求数据端点拿到 404。
//
// 2026-10-23（用户报障「手机扫码后显示二维码过期或已被使用」）：**码必须由
// 服务端下发**（`POST /api/iam/v1/auth/mp/qrcode`）。旧流程的自造 32 位 hex 码
// 在旧接口上仍回 pending（所以轮询看起来正常），但现网扫码页只认服务端下发的
// `qr-<uuid>` 码 ⇒ 一律判无效。详见 raccoon_identity.go 的文件头。新接口不可用
// 时才回落旧流程。
func (m *Manager) StartRaccoonQRLogin(ctx context.Context, accountID, pageURL string) (*StartedLogin, error) {
	flow := newRaccoonQRFlow()
	if ticket, err := m.CreateRaccoonQRTicket(ctx); err == nil {
		flow.update(RaccoonQRURL(ticket), ticket, false)
	} else {
		// 兜底：旧流程（本地自造码）。只在新接口整体不可用时走到这里 ——
		// 它至少不比修复前更差（旧接口仍接受任意 code）。
		code := GenerateRaccoonQrCode()
		flow.update(BuildRaccoonQrURL(code), &RaccoonQRTicket{
			Code:         code,
			ScanPath:     raccoonQRLegacyScanPath,
			ExpiresIn:    raccoonLoginTimeout,
			PollInterval: raccoonQRPollInterval,
		}, true)
		if m.logger != nil {
			m.logger.Warn("[jethub] raccoon 二维码票据申请失败，回落旧扫码流程: %v", err)
		}
	}
	result := make(chan LoginOutcome, 1)
	go m.raccoonQRPump(flow, accountID, result)
	return &StartedLogin{
		LoginURL:  pageURL,
		QRContent: flow.QRContent(),
		Result:    result,
		Extra:     flow,
	}, nil
}

// RaccoonQRFlow 是一次 raccoon 登录页的宿主侧活状态：当前二维码内容（票据
// 过期或用户取消时**自动换新码**，页面下一轮 status 轮询即可换图），以及短信
// 登录的 verification_id。
//
// ⚠️ 页面（公开 HTTP 端点）与泵 goroutine 都会读写它 ⇒ 全部走锁；`done` 用来
// 在流程落定后让泵停下（短信登录成功时也用它 —— 否则泵会继续轮询二维码）。
type RaccoonQRFlow struct {
	mu        sync.Mutex
	qr        string
	ticket    *RaccoonQRTicket
	legacy    bool
	expiresAt int64

	verificationID string
	phone          string

	done chan struct{}
	once sync.Once
}

func newRaccoonQRFlow() *RaccoonQRFlow { return &RaccoonQRFlow{done: make(chan struct{})} }

// QRContent 返回当前二维码内容（页面首次渲染与换码后重新渲染都读它）。
func (f *RaccoonQRFlow) QRContent() string {
	if f == nil {
		return ""
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.qr
}

// SMSState 返回短信登录已登记的 (phone, verificationID)。
func (f *RaccoonQRFlow) SMSState() (phone, verificationID string) {
	if f == nil {
		return "", ""
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.phone, f.verificationID
}

func (f *RaccoonQRFlow) rememberSMS(phone, verificationID string) {
	if f == nil {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.phone, f.verificationID = phone, verificationID
}

func (f *RaccoonQRFlow) update(qr string, ticket *RaccoonQRTicket, legacy bool) {
	if f == nil {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.qr, f.ticket, f.legacy = qr, ticket, legacy
	f.expiresAt = 0
	if ticket != nil && ticket.ExpiresIn > 0 {
		f.expiresAt = timeNowPlus(ticket.ExpiresIn)
	}
}

// snapshot 返回当前票据（码、轮询间隔、到期时刻、是否旧流程）。
func (f *RaccoonQRFlow) snapshot() (code string, interval time.Duration, expiresAt int64, legacy bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	interval = raccoonQRPollInterval
	legacy = f.legacy
	expiresAt = f.expiresAt
	if f.ticket == nil {
		return "", interval, expiresAt, legacy
	}
	if f.ticket.PollInterval > 0 {
		interval = f.ticket.PollInterval
	}
	return f.ticket.Code, interval, expiresAt, legacy
}

// stop 让泵停止（幂等；只允许在结果已送达之后调用）。
func (f *RaccoonQRFlow) stop() {
	if f == nil {
		return
	}
	f.once.Do(func() { close(f.done) })
}

// Close stops the QR pump. Exported for callers/tests that own the flow's
// lifetime (the page itself has no way to cancel).
func (f *RaccoonQRFlow) Close() { f.stop() }

// raccoonQRPump 轮询扫码状态：票据到期/用户取消 ⇒ 换新码；成功 ⇒ 落库并送达。
func (m *Manager) raccoonQRPump(flow *RaccoonQRFlow, accountID string, result chan LoginOutcome) {
	ctx := context.Background()
	deadline := timeNowPlus(raccoonLoginTimeout)
	for {
		code, interval, expiresAt, legacy := flow.snapshot()
		select {
		case <-flow.done:
			return
		case <-timeAfter(interval):
		}
		if nowMillis() > deadline {
			deliver(result, LoginOutcome{Err: fmt.Errorf("raccoon: 扫码登录超时（5 分钟）")})
			flow.stop()
			return
		}
		if expiresAt > 0 && nowMillis() >= expiresAt {
			m.raccoonRenewQR(flow, ctx)
			continue
		}
		var status string
		var cred *RaccoonCredential
		if legacy {
			status, cred, _ = m.PollRaccoonQrLogin(ctx, code)
		} else {
			status, cred = m.PollRaccoonQRTicket(ctx, code)
		}
		switch status {
		case raccoonQRStatusCanceled:
			if legacy {
				deliver(result, LoginOutcome{Err: fmt.Errorf("raccoon: 扫码已取消")})
				flow.stop()
				return
			}
			// 新流程：这次授权被取消（或码失效）⇒ 换新码继续等，不打断页面。
			m.raccoonRenewQR(flow, ctx)
		case raccoonQRStatusSuccess:
			if err := m.CompleteRaccoonLogin(accountID, cred); err != nil {
				deliver(result, LoginOutcome{Err: err})
				flow.stop()
				return
			}
			credJSON, _ := json.Marshal(cred)
			deliver(result, LoginOutcome{
				CredentialJSON: credJSON,
				ExpiresAt:      RaccoonExpiresAtMs(cred),
				Refreshable:    RaccoonRefreshable(cred),
			})
			flow.stop()
			return
		}
	}
}

// raccoonRenewQR 换一张新票据（过期 / 取消）。失败时保留旧码，下一轮再试。
func (m *Manager) raccoonRenewQR(flow *RaccoonQRFlow, ctx context.Context) {
	ticket, err := m.CreateRaccoonQRTicket(ctx)
	if err != nil {
		if m.logger != nil {
			m.logger.Warn("[jethub] raccoon 二维码换码失败（沿用旧码）: %v", err)
		}
		return
	}
	flow.update(RaccoonQRURL(ticket), ticket, false)
}

// SendRaccoonSmsForFlow 下发短信验证码并把 verification_id 记在流程上（页面
// 的「获取验证码」）。
func (m *Manager) SendRaccoonSmsForFlow(ctx context.Context, flow *RaccoonQRFlow, phone, captchaToken string) error {
	verificationID, err := m.SendRaccoonSMS(ctx, phone, captchaToken)
	if err != nil {
		return err
	}
	flow.rememberSMS(phone, verificationID)
	return nil
}

// SubmitRaccoonSmsForFlow 完成短信登录：校验 → 落库 → 送达页面流程（并让二维码
// 泵停下）。
func (m *Manager) SubmitRaccoonSmsForFlow(ctx context.Context, started *StartedLogin, flow *RaccoonQRFlow, accountID, smsCode string) error {
	phone, verificationID := flow.SMSState()
	if verificationID == "" {
		return fmt.Errorf("raccoon: 请先获取短信验证码")
	}
	cred, err := m.LoginRaccoonWithSMSVerification(ctx, phone, verificationID, smsCode)
	if err != nil {
		return err
	}
	if err := m.CompleteRaccoonLogin(accountID, cred); err != nil {
		return err
	}
	credJSON, _ := json.Marshal(cred)
	started.Deliver(LoginOutcome{
		CredentialJSON: credJSON,
		ExpiresAt:      RaccoonExpiresAtMs(cred),
		Refreshable:    RaccoonRefreshable(cred),
	})
	flow.stop()
	return nil
}

// CompleteRaccoonLogin persists the credential + display info. ⚠️ The
// nickname is the server's auto-generated default name (RaccoonAva) — phone
// is the reliable disambiguator.
func (m *Manager) CompleteRaccoonLogin(accountID string, cred *RaccoonCredential) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	credJSON, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, RaccoonExpiresAtMs(cred), RaccoonRefreshable(cred)); err != nil {
		return err
	}
	// ⚠️ IAM 会话确认：必须在访问业务接口前激活会话，防止后续查询余额和拉取目录报 200901 iam_confirm_required
	if cred.AccessToken != "" {
		if err := m.ConfirmRaccoonIAM(context.Background(), cred.AccessToken); err != nil && m.logger != nil {
			m.logger.Warn("[jethub] raccoon 登录后 IAM 会话确认失败: %v", err)
		}
	}
	// 清空目录缓存，确保后续能立即拉到最新远端模型目录（如 -1017）
	InvalidateRaccoonCatalogCache()
	// user_info 补齐展示信息（失败不阻塞——只影响昵称显示）。
	userID, nickname, officeIdentity, phone := m.FetchRaccoonUserInfo(context.Background(), cred)
	if officeIdentity != "" && cred.OfficeIdentity == "" {
		cred.OfficeIdentity = officeIdentity
		if data, err := json.Marshal(cred); err == nil {
			_ = m.SetCredential(acc.Provider, acc.CredentialRef, data, RaccoonExpiresAtMs(cred), RaccoonRefreshable(cred))
		}
	}
	if userID != "" {
		cred.UserID = userID
	}
	_ = m.UpdateAccount(accountID, func(a *Account) {
		// 手机号尾号是唯一可靠的区分依据；通用默认名（RaccoonAva）不判重复。
		a.Nickname = raccoonDisplayAccountName(nickname, phone, a.ID)
	})
	return nil
}

// raccoonDisplayAccountName: phone 优先消歧，否则用服务端 name。
func raccoonDisplayAccountName(nickname, phone, fallbackID string) string {
	if phone != "" {
		return phone
	}
	return firstNonEmpty(nickname, fallbackID)
}

// SubmitRaccoonSmsLogin handles the SMS login path (phone + code from the
// UI form) and persists like the QR flow.
func (m *Manager) SubmitRaccoonSmsLogin(ctx context.Context, accountID, phone, smsCode string) error {
	cred, err := m.LoginRaccoonWithSmsCode(ctx, phone, smsCode)
	if err != nil {
		return err
	}
	return m.CompleteRaccoonLogin(accountID, cred)
}

// RefreshRaccoonAccount renews one stored credential (terminal on
// 登录态已过期).
func (m *Manager) RefreshRaccoonAccount(ctx context.Context, accountID string) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		return fmt.Errorf("jethub: credential missing for %s", accountID)
	}
	var cred RaccoonCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return fmt.Errorf("jethub: parse raccoon credential %s: %w", accountID, err)
	}
	if !RaccoonRefreshable(&cred) {
		return ErrRefreshTokenExpired
	}
	refreshed, err := m.RefreshRaccoonCredential(ctx, &cred)
	if err != nil {
		if strings.Contains(err.Error(), "请重新登录") {
			_ = m.UpdateAccount(accountID, func(a *Account) { a.Refreshable = false })
			return ErrRefreshTokenExpired
		}
		return err
	}
	credJSON, err := json.Marshal(refreshed)
	if err != nil {
		return err
	}
	return m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, RaccoonExpiresAtMs(refreshed), RaccoonRefreshable(refreshed))
}

// RaccoonBalance GET /points/v1/balance (read-only; safe to call when
// opening the panel).
//
// ⚠️ 字段名是 `available_points`（ref raccoon-credits.ts）。本端原先读的是
// `balance` —— 那个字段**并不存在**；因为该渠道的能力位一直误登记为
// `HasBalance: false`，面板从不调用它，所以缺陷从未显现（用户报障原文：
// 「Minimax, DSH 里会显示 credits 数字，Tinylab 里不会显示」）。
//
// ⚠️ 各池**分开作 package**：让用户看出「奖励 / 每日 / 会员 / 充值」是独立来源
// —— 它们的有效期与回补规则都不同（每日积分每日刷新、充值积分长期有效）。
// 只显示合计会丢掉最关键的信息：**今天有多少会作废**。面板据此显示
// 「长期 X · 每日 Y」（池名分桶，ref formatPoolSplitLine 的 DAILY_POOL_NAMES）。
func (m *Manager) RaccoonBalance(ctx context.Context, accountID string) (*CreditBalance, error) {
	cred, err := m.raccoonCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	env, err := m.raccoonRequest(ctx, cred, http.MethodGet,
		raccoonAPIBase+raccoonBalancePath, "")
	if err != nil {
		return nil, err
	}
	if env.Code != 0 || env.Data == nil {
		return nil, env.err("余额查询失败")
	}
	// `available_points` 是**核心字段**：没有它就说明响应形状不对 —— 不编造数字
	// （字段缺失时 readNumber 会伪装成 0，把「查不到」说成「已用光」）。
	return raccoonBalanceFromPools(env.Data)
}

// raccoonBalanceFromPools maps the points pools to the provider-agnostic
// CreditBalance (纯函数，便于单测；不碰网络).
func raccoonBalanceFromPools(data map[string]any) (*CreditBalance, error) {
	available, ok := raccoonPointsField(data, "available_points")
	if !ok {
		return nil, fmt.Errorf("jethub: raccoon 余额响应缺少 available_points 字段")
	}
	packages := []CreditPackage{}
	addPool := func(label, key string, requirePositive bool) {
		value, ok := raccoonPointsField(data, key)
		if !ok || (requirePositive && value <= 0) {
			return
		}
		packages = append(packages, CreditPackage{
			Name: label, Unit: "积分",
			Remaining: roundCredits(value), Total: roundCredits(value), Active: true,
		})
	}
	addPool("奖励积分", "reward_points", false)
	addPool("每日积分", "daily_points", false)
	addPool("会员积分", "monthly_points", true)
	addPool("充值积分", "topup_points", false)
	if len(packages) == 0 {
		// 极端情形（服务端只给总额不给分项）也要有至少一个包，否则面板空列表。
		packages = append(packages, CreditPackage{
			Name: "可用积分", Unit: "积分",
			Remaining: roundCredits(available), Total: roundCredits(available), Active: true,
		})
	}
	// 无「已失效」概念（服务端不分失效池）。
	return &CreditBalance{Total: roundCredits(available), Packages: packages, IsCredit: true}, nil
}

// raccoonPointsField reads a numeric points field, distinguishing
// 「字段缺失」(false) from「值为 0」(true, 0) —— 两者语义完全不同。
func raccoonPointsField(data map[string]any, key string) (float64, bool) {
	raw, ok := data[key]
	if !ok || raw == nil {
		return 0, false
	}
	value, ok := raw.(float64)
	if !ok {
		return 0, false
	}
	return value, true
}

// ClaimRaccoonLoginReward claims the desktop login reward. ⚠️ NOT a daily
// check-in: measured idempotent-once (`granted:false` on repeat, still
// HTTP 200) — the judgement is `granted === true`.
func (m *Manager) ClaimRaccoonLoginReward(ctx context.Context, accountID string) (*ClaimOutcome, error) {
	cred, err := m.raccoonCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	env, err := m.raccoonRequest(ctx, cred, http.MethodPost,
		raccoonAPIBase+raccoonGrantReward, "{}")
	if err != nil {
		return nil, err
	}
	if env.Code != 0 || env.Data == nil {
		return nil, env.err("登录奖励领取失败")
	}
	if env.Data["granted"] != true {
		return &ClaimOutcome{Kind: "already-claimed", Message: "登录奖励已领取（幂等一次性，非每日签到）"}, nil
	}
	return &ClaimOutcome{Kind: "claimed", Credit: jsonNumberField(env.Data, "points")}, nil
}

// RaccoonOnboardingClaimed checks the bills for the login reward record.
// ⚠️ Judgement requires biz_type === 'reward_grant' AND event_name ===
// '桌面端登录奖励' — the newcomer pack is ALSO reward_grant; counting it
// would show "already claimed" for brand-new users.
func (m *Manager) RaccoonOnboardingClaimed(ctx context.Context, accountID string) (bool, error) {
	cred, err := m.raccoonCredentialFor(accountID)
	if err != nil {
		return false, err
	}
	env, err := m.raccoonRequest(ctx, cred, http.MethodGet,
		raccoonAPIBase+raccoonPointsPrefix+"/bills", "")
	if err != nil {
		return false, err
	}
	if env.Code != 0 || env.Data == nil {
		return false, env.err("账单查询失败")
	}
	items, _ := env.Data["items"].([]any)
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if jsonStringField(entry, "biz_type") == "reward_grant" &&
			strings.Contains(jsonStringField(entry, "event_name"), "桌面端登录奖励") {
			return true, nil
		}
	}
	return false, nil
}

// raccoonAugment: standard OpenAI-compatible + standard SSE; the ONLY body
// change is `extra_body.thinking` when an effort is supplied (Anthropic-style
// object). Model display names carry the multiplier.
func (m *Manager) raccoonAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	acc, ok := m.FindAccount(keyID)
	if !ok || acc.Provider != "raccoon" {
		return nil, errAccountNotFound(keyID)
	}
	raw, ok := m.Credential("raccoon", acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(keyID)
	}
	var cred RaccoonCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, err
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(keyID)
	}
	// effort 由 proxy 透传的 body reasoning_effort 映射到 extra_body.thinking
	//（raccoon 不认 reasoning_effort 顶层字段）。
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err == nil {
		if effort, ok := parsed["reasoning_effort"].(string); ok {
			if extra := RaccoonThinkingExtraBody(effort); extra != nil {
				extraBody, _ := parsed["extra_body"].(map[string]any)
				if extraBody == nil {
					extraBody = map[string]any{}
				}
				for k, v := range extra {
					extraBody[k] = v
				}
				parsed["extra_body"] = extraBody
				delete(parsed, "reasoning_effort")
				if nb, err := json.Marshal(parsed); err == nil {
					body = nb
				}
			}
		}
	}
	_ = cred
	// raccoonHeaders: Bearer + X-Org-Code + language/platform.
	req2 := *r
	_ = req2
	r.Header.Set("Authorization", "Bearer "+cred.AccessToken)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "text/event-stream, application/json")
	r.Header.Set("X-Org-Code", cred.OfficeIdentity)
	r.Header.Set("X-Raccoon-Language", "zh")
	r.Header.Set("X-Client-Platform", raccoonClientPlatform)
	r.Header.Set("X-Client-Version", raccoonClientVersion)
	if cred.DeviceID != "" {
		r.Header.Set("X-Client-Device-ID", cred.DeviceID)
	}
	return body, nil
}

// raccoonCredentialFor resolves + parses a raccoon credential.
func (m *Manager) raccoonCredentialFor(accountID string) (*RaccoonCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "raccoon" {
		return nil, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential("raccoon", acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(accountID)
	}
	var cred RaccoonCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse raccoon credential %s: %w", accountID, err)
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(accountID)
	}
	return &cred, nil
}

// RaccoonDisplayName builds the model display name with the multiplier. ⚠️ 1×
// is ALSO displayed (users read "no multiplier" as "we failed to fetch it");
// effective=0 shows 免费; effective<base shows x原→x折.
func RaccoonDisplayName(name string, effective, base float64) string {
	display := firstNonEmpty(name, "model")
	if effective < 0 {
		return display // no reliable rate — no suffix (no orphan ·)
	}
	if effective == 0 {
		return display + " · 免费"
	}
	if base > effective && base > 0 {
		return display + " · x" + formatMultiplier(base) + "→x" + formatMultiplier(effective)
	}
	return display + " · x" + formatMultiplier(effective)
}

// formatMultiplier strips float noise (max 4 decimals, trailing zeros).
func formatMultiplier(v float64) string {
	s := fmt.Sprintf("%.4f", v)
	s = strings.TrimRight(s, "0")
	s = strings.TrimSuffix(s, ".")
	return s
}
