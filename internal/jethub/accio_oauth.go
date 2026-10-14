package jethub

// Accio OAuth 2.0 + PKCE 兑换与续期（ref accio-oauth.ts）。
//
// ## 为什么能脱离 IDE（与参考实现 dsh-connect-accio 的关键差异）
//
// Accio 走的是**标准 PKCE**（`client_id = 'accio-work'`，公开客户端、无
// secret），回调落在本地 loopback（代码里对 `return_url` 无白名单校验）——
// 可以用我们自己的 loopback 完成授权，不需要本机 credentials.enc（DPAPI）、
// 不需要 SecurityGuard 签名（ref providers-accio.md §0 的实测结论）。
//
// ## 信封
//
// 两个端点都回 `{success, code, message, data}`：`success !== true` 即失败
// （ref unwrapTokenEnvelope：报错**带服务端原文**的 code + message）。
// `data = {accessToken, expiresAt(秒!), refreshToken, sgcookie?}` ——
// expiresAt 的秒→毫秒归一化只在这里做一次（ref toTokenResult）。
//
// ## ⚠️ 续期会轮换 refresh_token（ref §10 U-A：本端未实测，按最坏假设设防）
//
// 参考实现明确记录「刷新会轮换 refresh_token」。三条入口（调度器 / 手动按钮 /
// 推理路径按需续期）必须 per-credentialRef 串行 + 锁内重读 + 判终态前重读
// （accio_refresh.go）—— 并发消费同一份必然「1 成功 N invalid_grant」，
// 失败方会把好账号标死。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// accioTokenResult is the normalized exchange/refresh result (`expires_at`
// already ×1000 — ref AccioTokenResult).
type accioTokenResult struct {
	AccessToken  string
	RefreshToken string
	ExpiresAtMs  int64
	Sgcookie     string
}

// accioUnwrapEnvelope parses the `{success, code, message, data}` envelope.
// ⚠️ `success` 用「!== true 即失败」的判据照 ref（实测响应都带 true，但宽松读
// 让上游某天省字段时不至于整体崩坏 —— 与 accio-credits 的 ok 判据**相反**：
// 那边是「success !== false 即成功」，因为余额是尽力而为；兑换/续期是硬操作，
// 必须拿到 data 才算成功）。
func accioUnwrapEnvelope(path string, status int, raw []byte) (map[string]any, error) {
	var parsed struct {
		Success *bool          `json:"success"`
		Code    any            `json:"code"`
		Message any            `json:"message"`
		Data    map[string]any `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("accio: %s 返回非 JSON（HTTP %d）：%.200s", path, status, string(raw))
	}
	if parsed.Success == nil || !*parsed.Success {
		code := accioScalarString(parsed.Code)
		if code == "" {
			code = fmt.Sprintf("%d", status)
		}
		msg := accioScalarString(parsed.Message)
		return nil, fmt.Errorf("accio: %s 失败（%s %s）", path, code, msg)
	}
	if parsed.Data == nil {
		return nil, fmt.Errorf("accio: %s 响应缺 data 对象", path)
	}
	return parsed.Data, nil
}

// accioScalarString reads a scalar envelope field (string OR number — 上游可能
// 把 code 下发成数字 401，只认字符串会在那天误判，ref readScalarString 的注释).
func accioScalarString(v any) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case float64:
		return fmt.Sprintf("%g", t)
	}
	return ""
}

// accioToTokenResult normalizes `data` into accioTokenResult（含秒→毫秒）。
// ⚠️ 三者缺一不可（官方客户端同款校验：`!accessToken || !refreshToken ||
// typeof expiresAt !== 'number'` ⇒ 失败）。
func accioToTokenResult(path string, data map[string]any) (*accioTokenResult, error) {
	access, _ := data["accessToken"].(string)
	refresh, _ := data["refreshToken"].(string)
	if access == "" {
		return nil, fmt.Errorf("accio: %s 响应缺 accessToken", path)
	}
	if refresh == "" {
		return nil, fmt.Errorf("accio: %s 响应缺 refreshToken", path)
	}
	expiresAt, ok := accioExpiresAtMs(data["expiresAt"])
	if !ok {
		return nil, fmt.Errorf("accio: %s 响应缺 expiresAt（或非正数）", path)
	}
	out := &accioTokenResult{AccessToken: access, RefreshToken: refresh, ExpiresAtMs: expiresAt}
	if sg, _ := data["sgcookie"].(string); sg != "" {
		out.Sgcookie = sg
	}
	return out, nil
}

// accioTokenRequest performs one POST (exchange or refresh) and unwraps the
// envelope. ⚠️ region **刻意不参与** URL 构造：gateway 两个区域同一个
// （ref exchangeAccioCode 的同款注释 —— 别据此给 URL 加区域）。
func accioTokenRequest(ctx context.Context, path string, payload map[string]any) (*accioTokenResult, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	tctx, cancel := context.WithTimeout(ctx, accioRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(tctx, http.MethodPost, accioGatewayBase+path, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := callbackClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("accio: %s 请求网络错误：%w", path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	data, uerr := accioUnwrapEnvelope(path, resp.StatusCode, raw)
	if uerr != nil {
		// 终态判定只认「refresh_token 本身不认了」的报文标记；网络抖动、5xx、
		// 泛化 401/403 一律是可重试的普通错误（ref isAccioTerminalRefreshError
		// 的注释 —— 把它们判成终态就是「一次瞬时失败固化成单向门」）。
		if isAccioTerminalRefreshMessage(uerr.Error()) {
			return nil, ErrRefreshTokenExpired
		}
		return nil, uerr
	}
	return accioToTokenResult(path, data)
}

// exchangeAccioCode performs the authorization-code exchange
// (POST /api/oauth/token；clientId 必须**公开客户端** accio-work，没有 secret).
func exchangeAccioCode(ctx context.Context, code, codeVerifier, redirectURI string) (*accioTokenResult, error) {
	return accioTokenRequest(ctx, accioTokenExchangePath, map[string]any{
		"code":         code,
		"codeVerifier": codeVerifier,
		"clientId":     accioClientID,
		"redirectUri":  redirectURI,
	})
}

// refreshAccioCredential performs the silent renewal
// (POST /api/auth/refresh_token {accessToken, refreshToken}).
func refreshAccioCredential(ctx context.Context, cred *AccioCredential) (*accioTokenResult, error) {
	return accioTokenRequest(ctx, accioRefreshPath, map[string]any{
		"accessToken":  cred.AccessToken,
		"refreshToken": cred.RefreshToken,
	})
}

// accioTerminalRefreshMarkers are the server-side markers that DEFINITIVELY
// mean "this refresh_token is no longer accepted" (ref
// ACCIO_TERMINAL_REFRESH_MARKERS)。⚠️ 逐条都指向 refresh_token 本身：
// `unauthorized` / `403` 这类泛化状态词不在列 —— 网关抖动、区域策略、风控都
// 可能回它们，判成终态会把材料完好的账号标死。
var accioTerminalRefreshMarkers = []string{
	"invalid_grant",
	"invalid refresh token",
	"invalid refresh_token",
	"refresh token has been used",
	"refresh_token has been used",
	"refresh token expired",
	"refresh_token expired",
	"expired refresh token",
	"NOT_LOGIN",
}

// isAccioTerminalRefreshMessage reports whether a refresh failure message is
// terminal (case-insensitive contains, ref isAccioTerminalRefreshError).
func isAccioTerminalRefreshMessage(message string) bool {
	lowered := strings.ToLower(message)
	for _, marker := range accioTerminalRefreshMarkers {
		if strings.Contains(lowered, strings.ToLower(marker)) {
			return true
		}
	}
	return false
}

// ErrAccioNotLogin marks the credits-trio "not logged in" signal: HTTP 401/403
// OR body code 401/NOT_LOGIN（code 可能是数字 —— accioScalarString 已归一）。
// 用户动作是「重新登录」，与「一般查询失败」（查网络）方向不同。
var errAccioNotLogin = errors.New("accio: 未登录或登录已过期（NOT_LOGIN），请重新登录 Accio 账号")
