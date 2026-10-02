package jethub

// ZCode 登录：官方 CLI 设备授权流（**纯 HTTP，不需要官方客户端**）。
//
// 流程（ref src/zcode-login.ts，全部实测）：
//
//	① POST /api/v1/oauth/cli/init      Authorization: Bearer <自生成的 32 字节 hex 会话密钥>
//	   body {"provider":"bigmodel"} → data{flow_id, authorize_url, expires_at, poll_interval_sec}
//	② 用户在浏览器打开 authorize_url 完成授权（bigmodel 的 OAuth 页）
//	③ GET /api/v1/oauth/cli/poll/<flow_id>（同一个会话密钥）
//	   → data.status: pending | ready | failed；ready 时给 token(zcode JWT) +
//	     bigmodel.access_token + user.user_id
//
// ⚠️ 4xx（除 408/429）才是终态失败；5xx 与网络错误继续轮询（官方同款判据）。
// ⚠️ device_mid 由本端自己生成（实测值不被服务端绑定校验，只有"存在"是硬需求）。

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// zcodeLoginFlow is one in-flight device-authorization flow.
type zcodeLoginFlow struct {
	FlowID          string
	PollToken       string
	AuthorizeURL    string
	ExpiresAt       int64 // unix seconds (0 = unknown)
	PollIntervalSec int
	FlowSecret      string
}

// zcodeLoginResult is the `status: ready` payload.
type zcodeLoginResult struct {
	ZcodeJWT             string
	BigmodelAccessToken  string
	BigmodelRefreshToken string
	UserID               string
	DisplayName          string
}

// zcodeFlowSecret generates the CLI session key (32 random bytes, hex).
func zcodeFlowSecret() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		now := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	return hex.EncodeToString(b[:])
}

// zcodeLoginHeaders builds the device-flow header family (the bearer is our
// own session secret, exactly like the official client).
func zcodeLoginHeaders(flowSecret string, withJSON bool) map[string]string {
	headers := map[string]string{
		"Authorization":       "Bearer " + flowSecret,
		"User-Agent":          "ZCode/" + zcodeAppVersionFallback,
		"HTTP-Referer":        zcodeOrigin,
		"X-ZCode-App-Version": zcodeAppVersionFallback,
		"X-Platform":          "win32",
	}
	if withJSON {
		headers["Content-Type"] = "application/json"
	}
	return headers
}

// StartZcodeLogin performs step ①: returns the flow (with the authorize URL).
func (m *Manager) StartZcodeLogin(ctx context.Context) (*zcodeLoginFlow, error) {
	secret := zcodeFlowSecret()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, zcodeOAuthInitURL, bytes.NewReader([]byte(`{"provider":"`+zcodeLoginProvider+`"}`)))
	if err != nil {
		return nil, fmt.Errorf("zcode: 构造授权初始化请求失败：%w", err)
	}
	for k, v := range zcodeLoginHeaders(secret, true) {
		req.Header.Set(k, v)
	}
	resp, err := m.zcodeClientFor().Do(req)
	if err != nil {
		return nil, fmt.Errorf("zcode: 无法连接授权服务：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("zcode: 授权初始化失败（HTTP %d）：%.200s", resp.StatusCode, string(raw))
	}
	var parsed struct {
		Msg  string `json:"msg"`
		Data struct {
			FlowID          string  `json:"flow_id"`
			PollToken       string  `json:"poll_token"`
			AuthorizeURL    string  `json:"authorize_url"`
			ExpiresAt       float64 `json:"expires_at"`
			PollIntervalSec float64 `json:"poll_interval_sec"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("zcode: 授权初始化响应不是 JSON：%.200s", string(raw))
	}
	if parsed.Data.FlowID == "" {
		return nil, fmt.Errorf("zcode: 授权初始化响应缺 flow_id：%s", parsed.Msg)
	}
	if !strings.HasPrefix(parsed.Data.AuthorizeURL, "https://") {
		return nil, fmt.Errorf("zcode: 授权初始化响应缺合法的 authorize_url")
	}
	interval := 2
	if parsed.Data.PollIntervalSec >= 1 {
		interval = int(parsed.Data.PollIntervalSec)
	}
	return &zcodeLoginFlow{
		FlowID:          parsed.Data.FlowID,
		PollToken:       parsed.Data.PollToken,
		AuthorizeURL:    parsed.Data.AuthorizeURL,
		ExpiresAt:       int64(parsed.Data.ExpiresAt),
		PollIntervalSec: interval,
		FlowSecret:      secret,
	}, nil
}

// zcodePollOutcome is one poll result.
type zcodePollOutcome struct {
	Pending bool
	Result  *zcodeLoginResult
	Err     error
}

// PollZcodeLogin performs one step-③ poll. Network/5xx problems are "pending"
// (the caller keeps polling); 4xx (except 408/429) is terminal.
func (m *Manager) PollZcodeLogin(ctx context.Context, flow *zcodeLoginFlow) zcodePollOutcome {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, zcodeOAuthPollPrefix+flow.FlowID, nil)
	if err != nil {
		return zcodePollOutcome{Pending: true}
	}
	for k, v := range zcodeLoginHeaders(flow.FlowSecret, false) {
		req.Header.Set(k, v)
	}
	resp, err := m.zcodeClientFor().Do(req)
	if err != nil {
		return zcodePollOutcome{Pending: true}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != 408 && resp.StatusCode != 429 {
		return zcodePollOutcome{Err: fmt.Errorf("zcode: 轮询被拒（HTTP %d）：%.200s", resp.StatusCode, string(raw))}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return zcodePollOutcome{Pending: true}
	}
	return zcodeParsePollResponse(raw)
}

// zcodeParsePollResponse is the pure parse step of one poll (split for tests).
func zcodeParsePollResponse(raw []byte) zcodePollOutcome {
	var parsed struct {
		Code float64 `json:"code"`
		Msg  string  `json:"msg"`
		Data *struct {
			Status string `json:"status"`
			Token  string `json:"token"`
			User   struct {
				UserID string `json:"user_id"`
				ID     string `json:"id"`
				Name   string `json:"name"`
				Email  string `json:"email"`
			} `json:"user"`
			Bigmodel struct {
				AccessToken       string `json:"access_token"`
				AccessTokenCamel  string `json:"accessToken"`
				RefreshToken      string `json:"refresh_token"`
				RefreshTokenCamel string `json:"refreshToken"`
			} `json:"bigmodel"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.Data == nil {
		return zcodePollOutcome{Pending: true}
	}
	if parsed.Code != 0 {
		return zcodePollOutcome{Pending: true}
	}
	switch parsed.Data.Status {
	case "pending":
		return zcodePollOutcome{Pending: true}
	case "failed":
		return zcodePollOutcome{Err: fmt.Errorf("zcode: 用户拒绝了授权或授权失败")}
	case "ready":
	default:
		return zcodePollOutcome{Err: fmt.Errorf("zcode: 轮询响应状态无法识别：%s", parsed.Data.Status)}
	}
	accessToken := parsed.Data.Bigmodel.AccessToken
	if accessToken == "" {
		accessToken = parsed.Data.Bigmodel.AccessTokenCamel
	}
	userID := parsed.Data.User.UserID
	if userID == "" {
		userID = parsed.Data.User.ID
	}
	// 三个字段都必需（ref 同款断言）。
	if parsed.Data.Token == "" || accessToken == "" || userID == "" {
		return zcodePollOutcome{Err: fmt.Errorf("zcode: 轮询响应缺关键字段（token / access_token / user_id）")}
	}
	display := parsed.Data.User.Name
	if display == "" {
		display = parsed.Data.User.Email
	}
	if display == "" {
		display = userID
	}
	refresh := parsed.Data.Bigmodel.RefreshToken
	if refresh == "" {
		refresh = parsed.Data.Bigmodel.RefreshTokenCamel
	}
	return zcodePollOutcome{Result: &zcodeLoginResult{
		ZcodeJWT:             parsed.Data.Token,
		BigmodelAccessToken:  accessToken,
		BigmodelRefreshToken: refresh,
		UserID:               userID,
		DisplayName:          display,
	}}
}

// RunZcodeLogin polls until ready/failed/deadline. The deadline is
// min(caller timeout, server expiry − 1s) — 服务端有效期更近时本地不能更晚
// 放弃（ref 的显式教训：否则用户早已无法授权，我们还在空转）。
func (m *Manager) RunZcodeLogin(ctx context.Context, flow *zcodeLoginFlow, timeout time.Duration) (*zcodeLoginResult, error) {
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	deadline := time.Now().Add(timeout)
	if flow.ExpiresAt > 0 {
		if serverDeadline := time.Unix(flow.ExpiresAt, 0).Add(-time.Second); serverDeadline.Before(deadline) {
			deadline = serverDeadline
		}
	}
	interval := time.Duration(flow.PollIntervalSec) * time.Second
	if interval < time.Second {
		interval = time.Second
	}
	for time.Now().Before(deadline) {
		outcome := m.PollZcodeLogin(ctx, flow)
		if outcome.Result != nil {
			return outcome.Result, nil
		}
		if outcome.Err != nil {
			return nil, outcome.Err
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("zcode: 登录已取消")
		case <-time.After(interval):
		}
	}
	return nil, fmt.Errorf("zcode: 登录超时（未在有效期内完成授权），请重新发起")
}

// CompleteZcodeLogin persists a finished device flow as a new credential and
// back-fills the account nickname.
func (m *Manager) CompleteZcodeLogin(accountID string, result *zcodeLoginResult) (*ZcodeCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return nil, ErrNotFound
	}
	cred := &ZcodeCredential{
		ZcodeJWT:            result.ZcodeJWT,
		DeviceMid:           zcodeNewDeviceMid(),
		UserID:              result.UserID,
		BigmodelAccessToken: result.BigmodelAccessToken,
		AccountLabel:        result.DisplayName,
		AccountName:         result.DisplayName,
		AppVersion:          zcodeDetectAppVersion(),
		Source:              "plugin",
	}
	cred.Phone = zcodePhoneFromUserID(cred.UserID)
	raw, err := json.Marshal(cred)
	if err != nil {
		return nil, err
	}
	// 凭据静态（无 exp、不可续期）⇒ expiresAt=0、refreshable=false。
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, raw, 0, false); err != nil {
		return nil, err
	}
	if label := zcodeCredentialLabel(cred); label != "" {
		_ = m.UpdateAccount(accountID, func(a *Account) { a.Nickname = label })
	}
	return cred, nil
}

// zcodeCredentialLabel is the human label for an account (ref account_label).
func zcodeCredentialLabel(cred *ZcodeCredential) string {
	if cred == nil {
		return ""
	}
	if cred.AccountName != "" {
		return "ZCode " + cred.AccountName
	}
	if cred.AccountLabel != "" {
		return "ZCode " + cred.AccountLabel
	}
	if cred.Phone != "" {
		return "ZCode " + cred.Phone
	}
	return ""
}

// ZcodeRefreshAccount re-reads the account's **own** credential and writes the
// normalized form back.
//
// ⚠️ ZCode 没有续期端点（JWT 无 exp、凭据静态）。这里做的是 ref refreshAll /
// refreshAccountCredential 的**对账**语义：只读自己的 ref、只写自己的 ref。
// 绝不能用「池里第一个可用账号」的凭据去覆盖 —— 参考实现踩过这个真实缺陷
// （A 的凭据被写进 B 的 ref，30 分钟一轮就把整池串掉，症状是面板显示 0 额度
// 而官方客户端正常）。取不到自己的凭据时**显式报错**，不做任何回退写入。
func (m *Manager) ZcodeRefreshAccount(accountID string) error {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "zcode" {
		return ErrNotFound
	}
	raw, ok := m.Credential("zcode", acc.CredentialRef)
	if !ok {
		return fmt.Errorf("zcode: 账号 %s 的凭据不可用或已损坏，请重新登录该账号（本端不会用其它账号的凭据覆盖它）", accountID)
	}
	var cred ZcodeCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return fmt.Errorf("zcode: 账号 %s 的凭据无法解析：%w", accountID, err)
	}
	if !cred.usable() {
		return fmt.Errorf("zcode: 账号 %s 的凭据不完整（缺 zcode_jwt / device_mid），请重新登录", accountID)
	}
	encoded, err := json.Marshal(&cred)
	if err != nil {
		return err
	}
	return m.SetCredential("zcode", acc.CredentialRef, encoded, 0, false)
}

// ZcodeImportLocalAccount imports the official client's credential as a new
// account (the "零操作可用" path: 装了官方客户端并登录过的机器直接可用).
// Returns the created account id, or "" when no importable credential exists.
func (m *Manager) ZcodeImportLocalAccount() (string, *ZcodeCredential, error) {
	cred := zcodeImportLocalCredential()
	if cred == nil {
		return "", nil, nil
	}
	id, ref := NewAccountID("zcode")
	raw, err := json.Marshal(cred)
	if err != nil {
		return "", nil, err
	}
	if err := m.AddAccount(Account{
		ID:            id,
		Provider:      "zcode",
		Nickname:      zcodeCredentialLabel(cred),
		Enabled:       true,
		CredentialRef: ref,
		CreatedAt:     nowMillis(),
	}); err != nil {
		return "", nil, err
	}
	if err := m.SetCredential("zcode", ref, raw, 0, false); err != nil {
		_ = m.DeleteAccount(id)
		return "", nil, err
	}
	return id, cred, nil
}
