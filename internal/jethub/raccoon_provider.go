package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// timeNowPlus / timeAfter are tiny time indirections for readability.
func timeNowPlus(d time.Duration) int64 { return time.Now().Add(d).UnixMilli() }
func timeAfter(d time.Duration) <-chan time.Time {
	return time.After(d)
}

// Raccoon Manager services (ref raccoon-auth.ts / raccoon-credits.ts /
// raccoon-adapter.ts).

// StartRaccoonQRLogin generates a QR code, returns the WeChat login page URL,
// and pumps the background poll into the login session.
func (m *Manager) StartRaccoonQRLogin(ctx context.Context, accountID string, openURL func(string)) (*StartedLogin, error) {
	code := GenerateRaccoonQrCode()
	loginURL := BuildRaccoonQrURL(code)
	// Auto-open like the original plugin (explicit openURL wins if given).
	m.openURLWithBrowser(loginURL)
	if openURL != nil {
		go openURL(loginURL)
	}
	result := make(chan LoginOutcome, 1)
	go func() {
		deadline := timeNowPlus(raccoonLoginTimeout)
		for {
			if nowMillis() > deadline {
				deliver(result, LoginOutcome{Err: fmt.Errorf("raccoon: 扫码登录超时（5 分钟）")})
				return
			}
			select {
			case <-ctx.Done():
				deliver(result, LoginOutcome{Err: ctx.Err()})
				return
			case <-timeAfter(raccoonQRPollInterval):
			}
			status, cred, _ := m.PollRaccoonQrLogin(ctx, code)
			switch status {
			case raccoonQRStatusCanceled:
				deliver(result, LoginOutcome{Err: fmt.Errorf("raccoon: 扫码已取消")})
				return
			case raccoonQRStatusSuccess:
				if err := m.CompleteRaccoonLogin(accountID, cred); err != nil {
					deliver(result, LoginOutcome{Err: err})
					return
				}
				credJSON, _ := json.Marshal(cred)
				deliver(result, LoginOutcome{
					CredentialJSON: credJSON,
					ExpiresAt:      RaccoonExpiresAtMs(cred),
					Refreshable:    RaccoonRefreshable(cred),
				})
				return
			}
			// pending/logging → keep polling.
		}
	}()
	return &StartedLogin{LoginURL: loginURL, Result: result}, nil
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
	out := &CreditBalance{Packages: []CreditPackage{}}
	out.Total = roundCredits(jsonNumberField(env.Data, "balance"))
	out.IsCredit = true
	return out, nil
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
	for k := range r.Header {
		r.Header.Del(k)
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
