package jethub

import (
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/config"
)

// AutoClaw (智谱清言桌面端) 产品配置、凭据存储、短信登录、签名与模型定义。
// 参考：ref/deepseek-harness-codearts/src/autoclaw-product.ts / autoclaw.ts / autoclaw-credits.ts / autoclaw-oauth.ts

const (
	autoclawAPIBase                     = "https://autoglm-acceleration-api.zhipuai.cn"
	autoclawAppID                       = "100003"
	autoclawAppKey                      = "38d2391985e2369a5fb8227d8e6cd5e5"
	autoclawSourceID                    = "autoclaw"
	autoclawProductName                 = "autoclaw"
	autoclawClientVersion               = "2.1.1"
	autoclawRequiredSystemPromptPrefix  = "You are AutoClaw. Answer the user directly and concisely"
	autoclawChatPath                    = "/autoclaw-proxy/proxy/autoclaw/chat/completions"
	autoclawRefreshPath                 = "/userapi/v1/refresh"
	autoclawRefreshFallbackPath         = "/userapi/v1/agent-refresh"
	autoclawSendCodePath                = "/userapi/v1/agent-send-code"
	autoclawLoginPath                   = "/userapi/v1/agent-login"
	autoclawWalletsPath                 = "/agent-assetmgr/api/v2/wallets"
	autoclawDailyClaimPath              = "/userapi/v1/user-info"
)

var autoclawPhoneRe = regexp.MustCompile(`^1[3-9]\d{9}$`)

// AutoclawCredential 持久化凭据结构。
type AutoclawCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresAt    int64  `json:"expires_at,omitempty"`
	UserID       any    `json:"user_id,omitempty"`
	DeviceID     string `json:"device_id,omitempty"`
	UserName     string `json:"user_name,omitempty"`
	UserPhone    string `json:"user_phone,omitempty"`
	AccountID    string `json:"account_id,omitempty"`
}

func init() {
	RegisterTokenExtractor("autoclaw", func(cred jsonRaw) (string, error) {
		var c AutoclawCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", fmt.Errorf("jethub: parse autoclaw credential: %w", err)
		}
		return c.AccessToken, nil
	})
}

// calculateAutoclawSign 计算动态 MD5 签名：MD5(appId & timestamp & appKey)。
func calculateAutoclawSign(appID string, timestamp int64, appKey string) string {
	payload := fmt.Sprintf("%s&%d&%s", appID, timestamp, appKey)
	h := md5.Sum([]byte(payload))
	return hex.EncodeToString(h[:])
}

// autoclawJwtExpiresAtMs 从 access_token (JWT) 解出 exp 毫秒时间戳。
func autoclawJwtExpiresAtMs(token string) int64 {
	token = strings.TrimPrefix(strings.TrimSpace(token), "Bearer ")
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0
	}
	payloadB64 := parts[1]
	if m := len(payloadB64) % 4; m != 0 {
		payloadB64 += strings.Repeat("=", 4-m)
	}
	raw, err := base64.URLEncoding.DecodeString(payloadB64)
	if err != nil {
		raw, err = base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			return 0
		}
	}
	var data struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(raw, &data); err != nil || data.Exp <= 0 {
		return 0
	}
	if data.Exp > 1e12 {
		return data.Exp
	}
	return data.Exp * 1000
}

func (m *Manager) autoclawCredentialFor(accountID string) (*AutoclawCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "autoclaw" {
		return nil, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential("autoclaw", acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(accountID)
	}
	var cred AutoclawCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse autoclaw credential %s: %w", accountID, err)
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(accountID)
	}
	return &cred, nil
}

// prepareAutoclawMessages 确保 messages[0] 为白名单校验语句，避开 406 拦截。
func prepareAutoclawMessages(rawMessages []any) []any {
	prefix := autoclawRequiredSystemPromptPrefix
	if len(rawMessages) == 0 {
		return []any{map[string]any{"role": "system", "content": prefix}}
	}
	first, ok := rawMessages[0].(map[string]any)
	if !ok {
		return append([]any{map[string]any{"role": "system", "content": prefix}}, rawMessages...)
	}
	role, _ := first["role"].(string)
	content, _ := first["content"].(string)
	if role == "system" && content == prefix {
		return rawMessages
	}
	if role == "system" {
		trimmedContent := strings.TrimSpace(content)
		if strings.HasPrefix(trimmedContent, prefix) {
			trimmedContent = strings.TrimSpace(strings.TrimPrefix(trimmedContent, prefix))
			if strings.HasPrefix(trimmedContent, ".") {
				trimmedContent = strings.TrimSpace(strings.TrimPrefix(trimmedContent, "."))
			}
		}
		result := []any{map[string]any{"role": "system", "content": prefix}}
		if trimmedContent != "" {
			firstCopy := make(map[string]any, len(first))
			for k, v := range first {
				firstCopy[k] = v
			}
			firstCopy["content"] = trimmedContent
			result = append(result, firstCopy)
		}
		result = append(result, rawMessages[1:]...)
		return result
	}
	return append([]any{map[string]any{"role": "system", "content": prefix}}, rawMessages...)
}

// autoclawAugment 注入动态签名头并适配首条 system prompt。
func (m *Manager) autoclawAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	cred, err := m.autoclawCredentialFor(keyID)
	if err != nil {
		return nil, err
	}
	ts := time.Now().Unix()
	sign := calculateAutoclawSign(autoclawAppID, ts, autoclawAppKey)

	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Version", autoclawClientVersion)
	r.Header.Set("X-Auth-Appid", autoclawAppID)
	r.Header.Set("X-Auth-TimeStamp", strconv.FormatInt(ts, 10))
	r.Header.Set("X-Auth-Sign", sign)
	r.Header.Set("X-Authorization", "Bearer "+cred.AccessToken)
	r.Header.Set("Authorization", "Bearer "+cred.AccessToken)
	r.Header.Set("X-Request-Model", upstreamModel)
	r.Header.Set("X-Product", autoclawProductName)
	if r.Header.Get("Accept") == "" {
		r.Header.Set("Accept", "text/event-stream")
	}

	if len(body) > 0 {
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err == nil {
			modified := false
			if rawMsgs, ok := payload["messages"].([]any); ok {
				payload["messages"] = prepareAutoclawMessages(rawMsgs)
				modified = true
			}
			// max_tokens >= 10000 官方门禁约束
			if maxTok, ok := payload["max_tokens"].(float64); ok && maxTok > 0 && maxTok < 10000 {
				payload["max_tokens"] = 10000
				modified = true
			}
			if modified {
				if updated, err := json.Marshal(payload); err == nil {
					body = updated
				}
			}
		}
	}
	return body, nil
}

// SendAutoclawSmsCode 发送手机验证码。
func (m *Manager) SendAutoclawSmsCode(ctx context.Context, phone string) (string, error) {
	phone = strings.TrimSpace(phone)
	if !autoclawPhoneRe.MatchString(phone) {
		return "", errors.New("手机号格式不正确（须为 11 位大陆手机号）")
	}
	ts := time.Now().Unix()
	sign := calculateAutoclawSign(autoclawAppID, ts, autoclawAppKey)
	deviceID := qoderRandomID()

	reqBody, _ := json.Marshal(map[string]any{
		"phone":     phone,
		"source_id": autoclawSourceID,
		"device_id": deviceID,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, autoclawAPIBase+autoclawSendCodePath, strings.NewReader(string(reqBody)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Auth-Appid", autoclawAppID)
	req.Header.Set("X-Auth-TimeStamp", strconv.FormatInt(ts, 10))
	req.Header.Set("X-Auth-Sign", sign)
	req.Header.Set("X-Lang", "zh-CN")
	req.Header.Set("X-Channel", "official")

	tctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req = req.WithContext(tctx)

	resp, err := m.httpClient("autoclaw").Do(req)
	if err != nil {
		return "", fmt.Errorf("发送验证码网络失败：%w", err)
	}
	defer resp.Body.Close()

	var payload struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(raw, &payload)
	if payload.Code != 0 {
		msg := payload.Msg
		if msg == "" {
			msg = fmt.Sprintf("错误码 %d", payload.Code)
		}
		return "", fmt.Errorf("验证码发送失败：%s", msg)
	}
	return "autoclaw-sms", nil
}

// SubmitAutoclawSmsCode 提交手机验证码完成登录。
func (m *Manager) SubmitAutoclawSmsCode(ctx context.Context, phone, code string) (string, error) {
	phone = strings.TrimSpace(phone)
	code = strings.TrimSpace(code)
	if !autoclawPhoneRe.MatchString(phone) {
		return "", errors.New("手机号格式不正确")
	}
	if code == "" {
		return "", errors.New("验证码不能为空")
	}
	numCode, err := strconv.ParseInt(code, 10, 64)
	if err != nil {
		return "", errors.New("验证码必须为纯数字")
	}
	ts := time.Now().Unix()
	sign := calculateAutoclawSign(autoclawAppID, ts, autoclawAppKey)
	deviceID := qoderRandomID()

	reqBody, _ := json.Marshal(map[string]any{
		"phone":     phone,
		"code":      numCode,
		"source_id": autoclawSourceID,
		"device_id": deviceID,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, autoclawAPIBase+autoclawLoginPath, strings.NewReader(string(reqBody)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Auth-Appid", autoclawAppID)
	req.Header.Set("X-Auth-TimeStamp", strconv.FormatInt(ts, 10))
	req.Header.Set("X-Auth-Sign", sign)
	req.Header.Set("X-Lang", "zh-CN")
	req.Header.Set("X-Channel", "official")

	tctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req = req.WithContext(tctx)

	resp, err := m.httpClient("autoclaw").Do(req)
	if err != nil {
		return "", fmt.Errorf("登录网络失败：%w", err)
	}
	defer resp.Body.Close()

	var payload struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			UserID       any    `json:"user_id"`
			UserName     string `json:"user_name"`
			UserPhone    string `json:"user_phone"`
			ExpiresIn    int64  `json:"expires_in"`
			ExpiresAt    int64  `json:"expires_at"`
		} `json:"data"`
	}
	raw, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", fmt.Errorf("登录响应解析失败（HTTP %d）：%s", resp.StatusCode, string(raw))
	}
	if payload.Code != 0 || payload.Data.AccessToken == "" {
		msg := payload.Msg
		if msg == "" {
			msg = fmt.Sprintf("错误码 %d", payload.Code)
		}
		return "", fmt.Errorf("AutoClaw 登录失败：%s", msg)
	}

	cleanAccess := strings.TrimPrefix(strings.TrimSpace(payload.Data.AccessToken), "Bearer ")
	cleanRefresh := strings.TrimPrefix(strings.TrimSpace(payload.Data.RefreshToken), "Bearer ")
	expiresAt := autoclawJwtExpiresAtMs(cleanAccess)
	if expiresAt <= 0 {
		if payload.Data.ExpiresAt > 0 {
			if payload.Data.ExpiresAt > 1e12 {
				expiresAt = payload.Data.ExpiresAt
			} else {
				expiresAt = payload.Data.ExpiresAt * 1000
			}
		} else if payload.Data.ExpiresIn > 0 {
			expiresAt = time.Now().UnixMilli() + payload.Data.ExpiresIn*1000
		}
	}

	nick := phone
	if len(phone) == 11 {
		nick = phone[:3] + "****" + phone[7:]
	}
	id, ref := NewAccountID("autoclaw")
	if err := m.AddAccount(Account{
		ID:            id,
		Provider:      "autoclaw",
		Nickname:      nick,
		Enabled:       true,
		CredentialRef: ref,
		CreatedAt:     time.Now().UnixMilli(),
	}); err != nil {
		return "", err
	}
	cred := AutoclawCredential{
		AccessToken:  cleanAccess,
		RefreshToken: cleanRefresh,
		ExpiresAt:    expiresAt,
		UserID:       payload.Data.UserID,
		DeviceID:     deviceID,
		UserName:     payload.Data.UserName,
		UserPhone:    phone,
		AccountID:    id,
	}
	credRaw, err := json.Marshal(cred)
	if err != nil {
		return "", err
	}
	if err := m.SetCredential("autoclaw", ref, credRaw, expiresAt, len(cleanRefresh) > 0); err != nil {
		return "", err
	}
	return id, nil
}

// RefreshAutoclawAccount 静默续期凭据。
func (m *Manager) RefreshAutoclawAccount(ctx context.Context, accountID string) error {
	cred, err := m.autoclawCredentialFor(accountID)
	if err != nil {
		return err
	}
	if cred.RefreshToken == "" {
		return ErrRefreshTokenExpired
	}
	endpoints := []string{autoclawRefreshPath, autoclawRefreshFallbackPath}
	var lastErr error
	for _, ep := range endpoints {
		ts := time.Now().Unix()
		sign := calculateAutoclawSign(autoclawAppID, ts, autoclawAppKey)
		reqBody, _ := json.Marshal(map[string]any{
			"refresh_token": cred.RefreshToken,
			"source_id":     autoclawSourceID,
			"device_id":     cred.DeviceID,
		})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, autoclawAPIBase+ep, strings.NewReader(string(reqBody)))
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Auth-Appid", autoclawAppID)
		req.Header.Set("X-Auth-TimeStamp", strconv.FormatInt(ts, 10))
		req.Header.Set("X-Auth-Sign", sign)

		tctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		req = req.WithContext(tctx)
		resp, err := m.httpClient("autoclaw").Do(req)
		cancel()
		if err != nil {
			lastErr = err
			continue
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var payload struct {
			Code int `json:"code"`
			Data struct {
				AccessToken  string `json:"access_token"`
				RefreshToken string `json:"refresh_token"`
				ExpiresAt    int64  `json:"expires_at"`
				ExpiresIn    int64  `json:"expires_in"`
			} `json:"data"`
			Msg string `json:"msg"`
		}
		if err := json.Unmarshal(raw, &payload); err == nil && payload.Code == 0 && payload.Data.AccessToken != "" {
			newAccess := strings.TrimPrefix(strings.TrimSpace(payload.Data.AccessToken), "Bearer ")
			newRefresh := cred.RefreshToken
			if payload.Data.RefreshToken != "" {
				newRefresh = strings.TrimPrefix(strings.TrimSpace(payload.Data.RefreshToken), "Bearer ")
			}
			newExp := autoclawJwtExpiresAtMs(newAccess)
			if newExp <= 0 {
				if payload.Data.ExpiresAt > 0 {
					newExp = payload.Data.ExpiresAt * 1000
				} else if payload.Data.ExpiresIn > 0 {
					newExp = time.Now().UnixMilli() + payload.Data.ExpiresIn*1000
				}
			}
			cred.AccessToken = newAccess
			cred.RefreshToken = newRefresh
			cred.ExpiresAt = newExp

			acc, ok := m.FindAccount(accountID)
			if !ok {
				return ErrNotFound
			}
			credJSON, err := json.Marshal(cred)
			if err != nil {
				return err
			}
			return m.SetCredential("autoclaw", acc.CredentialRef, credJSON, newExp, len(newRefresh) > 0)
		}
		lastErr = fmt.Errorf("code %d: %s", payload.Code, payload.Msg)
	}
	if lastErr != nil {
		return fmt.Errorf("autoclaw refresh failed: %w", lastErr)
	}
	return errors.New("autoclaw refresh failed on all endpoints")
}

// AutoclawBalance 查询 AutoClaw 积分钱包余额。
func (m *Manager) AutoclawBalance(ctx context.Context, accountID string) (*CreditBalance, error) {
	cred, err := m.autoclawCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	ts := time.Now().Unix()
	sign := calculateAutoclawSign(autoclawAppID, ts, autoclawAppKey)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, autoclawAPIBase+autoclawWalletsPath+"?biz_app_id=autoclaw", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Auth-Appid", autoclawAppID)
	req.Header.Set("X-Auth-TimeStamp", strconv.FormatInt(ts, 10))
	req.Header.Set("X-Auth-Sign", sign)
	req.Header.Set("Authorization", "Bearer "+cred.AccessToken)
	req.Header.Set("X-Authorization", "Bearer "+cred.AccessToken)

	tctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req = req.WithContext(tctx)

	resp, err := m.httpClient("autoclaw").Do(req)
	if err != nil {
		return nil, fmt.Errorf("autoclaw balance: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return nil, errors.New("凭据失效（HTTP 401），请重新登录")
	}

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			TotalBalance float64 `json:"total_balance"`
			Wallets      []struct {
				PublicWalletType string  `json:"public_wallet_type"`
				DisplayName      string  `json:"display_name"`
				Balance          float64 `json:"balance"`
				Display          *bool   `json:"display"`
			} `json:"wallets"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("解析钱包响应失败（HTTP %d）：%.120s", resp.StatusCode, string(raw))
	}
	if payload.Code != 0 {
		return nil, fmt.Errorf("AutoClaw 余额查询失败：%s（code=%d）", payload.Msg, payload.Code)
	}

	var pkgs []CreditPackage
	for _, w := range payload.Data.Wallets {
		if w.Display != nil && !*w.Display {
			continue
		}
		name := w.DisplayName
		if name == "" {
			name = w.PublicWalletType
		}
		pkgs = append(pkgs, CreditPackage{
			Name:      name,
			Total:     roundCredits(w.Balance),
			Remaining: roundCredits(w.Balance),
			Active:    w.Balance > 0,
			Unit:      "credit",
		})
	}
	return &CreditBalance{
		Total:    roundCredits(payload.Data.TotalBalance),
		Packages: pkgs,
		IsCredit: true,
	}, nil
}

// ClaimAutoclawDaily 领取 AutoClaw 每日积分。
func (m *Manager) ClaimAutoclawDaily(ctx context.Context, accountID string) (*ClaimOutcome, error) {
	cred, err := m.autoclawCredentialFor(accountID)
	if err != nil {
		return &ClaimOutcome{Kind: "failed", Message: err.Error()}, nil
	}
	ts := time.Now().Unix()
	sign := calculateAutoclawSign(autoclawAppID, ts, autoclawAppKey)
	reqBody, _ := json.Marshal(map[string]any{
		"source_id": autoclawSourceID,
		"device_id": cred.DeviceID,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, autoclawAPIBase+autoclawDailyClaimPath, strings.NewReader(string(reqBody)))
	if err != nil {
		return &ClaimOutcome{Kind: "failed", Message: err.Error()}, nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Auth-Appid", autoclawAppID)
	req.Header.Set("X-Auth-TimeStamp", strconv.FormatInt(ts, 10))
	req.Header.Set("X-Auth-Sign", sign)
	req.Header.Set("Authorization", "Bearer "+cred.AccessToken)
	req.Header.Set("X-Authorization", "Bearer "+cred.AccessToken)

	tctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req = req.WithContext(tctx)

	resp, err := m.httpClient("autoclaw").Do(req)
	if err != nil {
		return &ClaimOutcome{Kind: "failed", Message: err.Error()}, nil
	}
	defer resp.Body.Close()

	var payload struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			DailyCheckInCompletedOnRequest bool `json:"daily_check_in_completed_on_request"`
		} `json:"data"`
	}
	raw, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(raw, &payload); err != nil {
		return &ClaimOutcome{Kind: "failed", Message: fmt.Sprintf("HTTP %d: %.100s", resp.StatusCode, string(raw))}, nil
	}
	if payload.Code != 0 {
		return &ClaimOutcome{Kind: "failed", Message: payload.Msg}, nil
	}
	if payload.Data.DailyCheckInCompletedOnRequest {
		return &ClaimOutcome{Kind: "claimed", Message: "签到成功"}, nil
	}
	return &ClaimOutcome{Kind: "already-claimed", Message: "今日已完成签到"}, nil
}

// autoclawFallbackModels 返回 4 个已确证的模型定义（ref autoclaw-product.ts AUTOCLAW_FALLBACK_MODELS）。
func autoclawFallbackModels() ModelTable {
	md := func(id, name, ctx, maxOut string, img bool) config.ModelDef {
		note := "ctx " + ctx + "; max " + maxOut
		if img {
			note += "; image"
		}
		note += "; efforts low/high/max; default high"
		return config.ModelDef{ID: id, QuotaType: "limited", Note: note, Alias: name}
	}
	return ModelTable{
		md("zai_glm-5.3-flash", "GLM-5.3 Flash (AutoClaw)", "1048576", "131072", true),
		md("zaicoding_glm-5.3", "GLM-5.3 (AutoClaw)", "1048576", "307200", true),
		md("zai_auto", "Auto (AutoClaw)", "1048576", "393216", true),
		md("zai_auto-fast", "Auto-Fast (AutoClaw)", "1048576", "131072", true),
	}
}
