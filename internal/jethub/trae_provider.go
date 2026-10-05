package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// TRAE Manager services (ref trae-auth.ts / trae-oauth.ts startTraeLoginFlow).

// StartTraeLogin starts the two-step login: local callback server (preferred
// port 18080, EAADDRINUSE → random fallback), login URL built with the ACTUAL
// port — then immediately surfaces the URL.
func (m *Manager) StartTraeLogin(ctx context.Context, accountID string, openURL func(string)) (*StartedLogin, error) {
	machineID := GenerateTraeMachineID()
	deviceID := GenerateTraeDeviceID()

	ln, port, err := listenCallbackPortPreferred(traeCallbackPort)
	if err != nil {
		return nil, err
	}
	callbackURL := fmt.Sprintf("http://127.0.0.1:%d%s", port, traeCallbackPath)
	loginURL := BuildTraeLoginURL(machineID, deviceID, callbackURL)

	result := make(chan LoginOutcome, 1)
	mux := http.NewServeMux()
	mux.HandleFunc(traeCallbackPath, func(w http.ResponseWriter, r *http.Request) {
		query, err := parseCallbackQuery(r.URL.String())
		if err != nil {
			http.Error(w, "TRAE 登录回调无效：回调 URL 无法解析", http.StatusBadRequest)
			deliver(result, LoginOutcome{Err: fmt.Errorf("TRAE 登录回调无效：回调 URL 无法解析")})
			return
		}
		info, reason, authCodeFlow := parseTraeCallbackQuery(query)
		_ = authCodeFlow // reported inside the reason text
		if info == nil {
			// ⚠️ MUST settle the result promise before returning — the early
			// implementation returned without delivering, and the UI stayed on
			// "认证中" forever exactly like a parsing failure.
			http.Error(w, "TRAE 登录回调无效："+reason, http.StatusBadRequest)
			deliver(result, LoginOutcome{Err: fmt.Errorf("TRAE 登录回调无效：%s", reason)})
			return
		}
		cred, err := m.exchangeTraeCallback(r.Context(), info, machineID, deviceID, nowMillis())
		if err != nil {
			http.Error(w, "TRAE 登录失败："+err.Error(), http.StatusInternalServerError)
			deliver(result, LoginOutcome{Err: err})
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(fmt.Sprintf("TRAE 登录成功：%s。可以关闭此页面返回面板。", TraeDisplayNickname(cred.Phone, cred.Email, cred.Nickname, cred.UID, cred.UID))))
		if err := m.CompleteTraeLogin(accountID, cred); err != nil {
			deliver(result, LoginOutcome{Err: err})
			return
		}
		credJSON, _ := json.Marshal(cred)
		deliver(result, LoginOutcome{
			CredentialJSON: credJSON,
			ExpiresAt:      traeCredentialExpiresAtMs(cred),
			Refreshable:    cred.RefreshToken != "",
		})
	})
	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(ln) }()
	go func() {
		<-ctx.Done()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
		defer shutdownCancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	go func() {
		select {
		case <-time.After(traeLoginTimeout):
			deliver(result, LoginOutcome{Err: fmt.Errorf("TRAE 登录超时")})
		case <-ctx.Done():
		}
	}()

	// Auto-open in the browser/session the user picked (single open: the
	// manager no longer opens on its own, so the callback is the only entry).
	if openURL != nil {
		go openURL(loginURL)
	}
	return &StartedLogin{LoginURL: loginURL, Result: result}, nil
}

// BuildTraeLoginURL: `{console}/authorization?...`. Parameter names are the
// verified ones — `auth_callback_url` (NOT callback_url), plus the
// auth_from/login_channel/auth_type/redirect quartet that routes the flow to
// the local-callback branch, and the x_* client-shape spoofing set. Missing
// names leave the page stuck at 授权中 forever (real defect recorded).
func BuildTraeLoginURL(machineID, deviceID, callbackURL string) string {
	q := urlValues{
		"login_version": "1", "auth_from": "solo", "login_channel": "native_ide",
		"plugin_version": traeProduct.PluginVersion, "auth_type": "local",
		"client_id": traeProduct.ClientID, "redirect": "0",
		"login_trace_id": TraeMachineTraceID(machineID, deviceID),
		// ⚠️ The parameter name is auth_callback_url.
		"auth_callback_url": callbackURL,
		"machine_id":        machineID, "device_id": deviceID,
		"x_device_id": deviceID, "x_machine_id": machineID,
		"x_device_brand": "PC", "x_device_type": "PC", "x_os_version": "1.0",
		"x_app_version": traeProduct.AppVersion, "x_app_type": "stable",
	}
	// urlValues.encode escapes with QueryEscape; TRAE expects standard form
	// encoding which matches.
	enc := q.encode()
	return traeConsoleHost + "/authorization?" + enc
}

// parseTraeCallbackQuery is the map-based variant used by the callback server
// handler (query already percent-decoded by net/url).
func parseTraeCallbackQuery(query map[string]string) (*traeCallbackInfo, string, bool) {
	// Reuse the shared parser by rebuilding a canonical URL.
	vs := url.Values{}
	for k, v := range query {
		vs.Set(k, v)
	}
	return parseTraeCallback("/authorize?" + vs.Encode())
}

// listenCallbackPortPreferred binds the preferred port, falling back to a
// random port when it is occupied (18080 is commonly taken; TRAE accepts any
// port because the callback URL rides inside the login URL).
func listenCallbackPortPreferred(preferred int) (net.Listener, int, error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", preferred))
	if err == nil {
		return ln, preferred, nil
	}
	ln2, err2 := net.Listen("tcp", "127.0.0.1:0")
	if err2 != nil {
		return nil, 0, err2
	}
	return ln2, ln2.Addr().(*net.TCPAddr).Port, nil
}

// CompleteTraeLogin persists the credential and the display nickname.
func (m *Manager) CompleteTraeLogin(accountID string, cred *TraeCredential) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	credJSON, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, traeCredentialExpiresAtMs(cred), cred.RefreshToken != ""); err != nil {
		return err
	}
	_ = m.UpdateAccount(accountID, func(a *Account) {
		a.Nickname = TraeDisplayNickname(cred.Phone, cred.Email, cred.Nickname, cred.UID, a.ID)
	})
	return nil
}

// RefreshTraeAccount renews via ExchangeToken (rotating the refresh token).
func (m *Manager) RefreshTraeAccount(ctx context.Context, accountID string) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		return fmt.Errorf("jethub: credential missing for %s", accountID)
	}
	var cred TraeCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return fmt.Errorf("jethub: parse trae credential %s: %w", accountID, err)
	}
	if cred.RefreshToken == "" {
		return ErrRefreshTokenExpired
	}
	body, err := json.Marshal(map[string]any{
		"ClientID": traeProduct.ClientID, "RefreshToken": cred.RefreshToken,
		"ClientSecret": "-", "UserID": "",
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		traeOAuthHost+traeExchangePath, strReader(string(body)))
	if err != nil {
		return err
	}
	for k, v := range traeOAuthHeaders() {
		req.Header.Set(k, v)
	}
	tctx, cancel := context.WithTimeout(ctx, traeRequestTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient("trae").Do(req)
	if err != nil {
		return fmt.Errorf("TRAE ExchangeToken 失败：%w", err)
	}
	raw2, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("TRAE ExchangeToken 失败（HTTP %d）", resp.StatusCode)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw2, &parsed); err != nil {
		return fmt.Errorf("TRAE ExchangeToken 响应不是 JSON")
	}
	exchange := parseTraeExchangeResponse(parsed)
	if exchange == nil {
		return fmt.Errorf("TRAE ExchangeToken 响应缺少 Token")
	}
	refreshed := *(&cred)
	refreshed.AccessToken = exchange.AccessToken
	if exchange.RefreshToken != "" {
		refreshed.RefreshToken = exchange.RefreshToken
	}
	refreshed.ExpiresAt = traeExpiryString(exchange, nowMillis())
	credJSON, err := json.Marshal(&refreshed)
	if err != nil {
		return err
	}
	return m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, traeCredentialExpiresAtMs(&refreshed), refreshed.RefreshToken != "")
}

// traeCheckinHeaders builds the complete checkin header set (ref
// traeCheckinHeaders / trae-mate build_headers): user_id-derived deterministic
// device identity per account.
func traeCheckinHeaders(cred *TraeCredential, userID string) map[string]string {
	seed := firstNonEmpty(userID, cred.UID)
	return map[string]string{
		"Content-Type": "application/json", "Accept": "*/*",
		"User-Agent":         "VSCode 1.107.1 (TRAE SOLO CN)",
		"Authorization":      "Cloud-IDE-JWT " + cred.AccessToken,
		"X-Market-Client-Id": "VSCode 1.107.1",
		"X-Market-User-Id":   traeSeededUUID(seed, "market"),
		"X-User-Region":      "CN",
		"X-Device-Id":        traeSeededDigits(15, seed, "devid"),
		"X-Lgw-Req-Sdk-Type": "3",
		"Package-Type":       "stable_cn",
		"X-Lscbd-Aid":        "787976",
		"X-Lscbd-Platform":   "windows",
		"App-Version":        traeProduct.AppVersion,
		"X-Tt-Trace-Id":      fmt.Sprintf("00-%s-01", traeRandomHex32()[:16]),
		"Vscode-Sessionid":   traeSeededHex64(seed, "sess"),
		"X-Request-Id":       lobsteraiRandomID(),
	}
}

// ClaimTraeDaily executes the daily check-in claim with the complete header
// set; a 9074 (device-level rate limit) bumps the checkin device generation
// once and retries (device_id is the rate-limit scope, not the account).
func (m *Manager) ClaimTraeDaily(ctx context.Context, accountID string) (*ClaimOutcome, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return nil, ErrNotFound
	}
	cred, err := m.traeCredentialFor(acc.ID)
	if err != nil {
		return nil, err
	}
	for generation := 0; generation < 5; generation++ {
		headers := traeUgHeaders(cred, generation)
		claimURL := traeUGHost + traeCheckinClaim
		resp, err := m.traeUGPost(ctx, claimURL, headers, "{}")
		if err != nil {
			return nil, err
		}
		code := int(bodyCode(resp))
		message := bodyMessage(resp)
		if code == 9074 {
			// Bump the rotation generation and retry (persisted per account).
			_ = m.UpdateModelRateLimit(acc.ID, "__trae_checkin_gen__", int64(generation+1))
			continue
		}
		if code != 0 {
			// 其他非致命码收敛为已领取/无资格；未知统一 failed（ref 判定序）。
			kind := "failed"
			if strings.Contains(message, "已领取") || strings.Contains(message, "已签到") {
				kind = "already-claimed"
			} else if code == 9004 { // 空 device_id 等参数类错误
				kind = "failed"
			}
			return &ClaimOutcome{Kind: kind, Message: firstNonEmpty(message, "领取失败")}, nil
		}
		data := bodyData(resp)
		credit := 0.0
		if data != nil {
			credit = jsonNumberField(data, "credit")
		}
		return &ClaimOutcome{Kind: "claimed", Credit: credit}, nil
	}
	return &ClaimOutcome{Kind: "failed", Message: "签到设备限流（9074），请稍后再试"}, nil
}

// TraeBalance queries the credit balance (ent usage).
//
// ⚠️ 三处必须照上游来（ref trae-credits.ts fetchTraeCreditBalance；本端旧版三处
// 都不对，只因能力位误登记为 `HasBalance: false` 才从未暴露）：
//
//  1. **必须用完整客户端头**（`traeCheckinHeaders`，含基于 user_id 的确定性设备
//     身份），不是 UG 那套最小头 —— 上游注释明写「关键差异与签到相同：使用完整
//     客户端头 + 基于 user_id 的设备身份」。
//  2. 请求体是 `{"require_usage":true,"req_source":2}`（**不是** `{}`）。
//  3. 余额在**顶层** `user_entitlement_pack_list` —— 每项
//     `entitlement_base_info.quota.credits_limit` 是本周期总额、
//     `usage.credits_amount` 是已用、`expire_time`（**秒级**）是到期时刻。
//     旧版猜的 `data.totalCredits/creditRemain/remain` 三个键都不存在。
//
// ⚠️ 到期时刻决定面板的「临时 / 长期」分桶，故必须透传 DeductionEndTime。
func (m *Manager) TraeBalance(ctx context.Context, accountID string) (*CreditBalance, error) {
	cred, err := m.traeCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	headers := traeCheckinHeaders(cred, cred.UID)
	body, err := m.traeUGPost(ctx, traeEntUsagePath, headers, traeEntUsageBody)
	if err != nil {
		return nil, err
	}
	packs := traeEntitlementPacks(body)
	if len(packs) == 0 {
		// 只有确实拿不到包时，业务码才是「有信息量的失败原因」；反过来先判码会把
		// 「码非零但包正常」误判成失败。
		if code := int(bodyCode(body)); code != 0 {
			return nil, fmt.Errorf("jethub: trae usage code=%d: %s", code, bodyMessage(body))
		}
		return nil, fmt.Errorf("jethub: trae 余额响应没有资源包（形状与预期不符）")
	}
	return traePackagesFromEntries(packs)
}

// traePackagesFromEntries converts `user_entitlement_pack_list` entries into
// the provider-agnostic CreditBalance (纯函数，便于单测；不碰网络).
func traePackagesFromEntries(packs []any) (*CreditBalance, error) {
	out := &CreditBalance{Packages: []CreditPackage{}}
	var total float64
	for _, raw := range packs {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		base, _ := entry["entitlement_base_info"].(map[string]any)
		if base == nil {
			continue
		}
		quota, _ := base["quota"].(map[string]any)
		if quota == nil {
			continue
		}
		limit := jsonNumberField(quota, "credits_limit")
		if limit <= 0 {
			continue
		}
		var used float64
		if usage, ok := entry["usage"].(map[string]any); ok {
			used = jsonNumberField(usage, "credits_amount")
		}
		if used < 0 {
			used = 0
		}
		if used > limit {
			used = limit
		}
		// ⚠️ 包名用 `display_desc`（实测「每月登录赠送」/「签到奖励」/「免费」），
		// 不是 `base.name` —— 后者实测为 undefined，旧代码会全部回退成「资源包」。
		pkg := CreditPackage{
			Name:      firstNonEmpty(jsonStringField(base, "display_desc"), jsonStringField(entry, "display_desc"), "资源包"),
			Unit:      "credits",
			Remaining: limit - used,
			Total:     limit,
			Used:      used,
			Active:    true,
		}
		// ⚠️ expire_time 是**秒级** Unix 时间戳：秒 → 毫秒必须 ×1000，不乘会让
		// 到期日落在 1970 年（实测 1790783999 = 2026-09-30 23:59:59）。
		if expireSec := jsonNumberField(entry, "expire_time"); expireSec > 0 {
			pkg.DeductionEndTime = int64(expireSec) * 1000
		}
		out.Packages = append(out.Packages, pkg)
		total += pkg.Remaining
	}
	if len(out.Packages) == 0 {
		return nil, fmt.Errorf("jethub: trae 余额响应里的资源包全部无额度")
	}
	out.Total = roundCredits(total)
	out.IsCredit = true
	return out, nil
}

// traeEntUsageBody is the verbatim ent-usage request body (ref：`require_usage`
// 才让服务端下发 usage 与资源包明细；`req_source: 2` 标识来源）。
const traeEntUsageBody = `{"require_usage":true,"req_source":2}`

// traeEntitlementPacks reads the entitlement pack list from the response top
// level, tolerating an envelope (`data.…`) in case the gateway wraps it.
func traeEntitlementPacks(body map[string]any) []any {
	if list, ok := body["user_entitlement_pack_list"].([]any); ok && len(list) > 0 {
		return list
	}
	if data, ok := body["data"].(map[string]any); ok {
		if list, ok := data["user_entitlement_pack_list"].([]any); ok {
			return list
		}
	}
	return nil
}

// traeUGPost performs an Ug-family POST with the given headers.
func (m *Manager) traeUGPost(ctx context.Context, url string, headers map[string]string, body string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strReader(body))
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := m.httpClient("trae").Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			return nil, fmt.Errorf("凭据已失效（HTTP %d），请重新登录该账号", resp.StatusCode)
		}
		return nil, fmt.Errorf("服务端返回了非 JSON 响应（HTTP %d）", resp.StatusCode)
	}
	return parsed, nil
}

// traeCredentialFor resolves + parses a trae credential.
func (m *Manager) traeCredentialFor(accountID string) (*TraeCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "trae" {
		return nil, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential("trae", acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(accountID)
	}
	var cred TraeCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse trae credential %s: %w", accountID, err)
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(accountID)
	}
	return &cred, nil
}

// TrAE augment: converts the OpenAI body to SOLO and swaps the header family.
// The proxy → augmenter handoff passes the client body; we convert it here
// (OpenAI→SOLO) because the upstream only accepts the SOLO dialect.
func (m *Manager) traeAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	cred, err := m.traeCredentialForInternal(keyID)
	if err != nil {
		return nil, err
	}
	var openaiBody map[string]any
	if err := json.Unmarshal(body, &openaiBody); err != nil {
		return nil, fmt.Errorf("jethub: trae body not JSON: %w", err)
	}
	soloBody, err := transformToSOLOBody(openaiBody, "solo_work_lite")
	if err != nil {
		return nil, err
	}
	newBody, err := json.Marshal(soloBody)
	if err != nil {
		return nil, err
	}
	// Header family swap: Cloud-IDE-JWT + trio token headers.
	for k := range r.Header {
		r.Header.Del(k)
	}
	for k, v := range traeSOLOHeaders(cred, true, 0) {
		r.Header.Set(k, v)
	}
	return newBody, nil
}

func (m *Manager) traeCredentialForInternal(keyID string) (*TraeCredential, error) {
	return m.traeCredentialFor(keyID)
}
