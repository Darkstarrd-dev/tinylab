package jethub

// Accio 积分与账号身份查询 —— 三个只读端点（ref accio-credits.ts）。
//
// ## ⚠️⚠️ 本文件唯一的陷阱：三个端点**传参方式各不相同**（逐条实测）
//
//	| 端点                                   | 方法 | token 位置 |
//	|----------------------------------------|------|------------|
//	| /api/auth/userinfo                     | POST | body ({accessToken}) |
//	| /api/entitlement/currentSubscription   | GET  | query (?accessToken=…) |
//	| /api/entitlement/quota                 | GET  | query |
//
// 用错 ⇒ 405 Method Not Allowed / 400 Bad Request。⚠️ 请求**只带**
// Accept（POST 另加 Content-Type）—— 推理端点的 utdid/appKey/version 那套头
// 未实测组合，刻意不顺手带过来（ref 同款纪律）。
//
// ## 失败语义
//
//   - 未登录 = HTTP 401/403 **或** body code 401/NOT_LOGIN（实测形态是
//     HTTP 200 + {success:false, code:'401', message:'NOT_LOGIN'}，只看状态码
//     会漏判；code 可能是数字 —— accioScalarString 已归一）。
//   - 三条失败路径一律返回错误（不编 0 —— 0 是「已用光」的语义，把网络失败画
//     成 0 会让用户以为额度被清空）。
//
// ## 积分桶
//
// `data.entitlement` 下的 `daily` / `monthly` / `referral`，单位 **credit**
// （不是 token，与 zcode 不同）：
//   - 桶对象**存在** ⇒ 留下（remaining: 0 也要留下 —— 用户要看到「还有 0」）；
//   - 桶对象**缺席** ⇒ 不产生行（不是产出一行 0 —— 那会把「没有这个桶」说成
//     「桶是空的」）；
//   - 桶存在但 remaining **读不到** ⇒ 跳过该桶（那是「数据不足」，按 0 展示
//     等于把「查不到」说成「已用光」）。
//
// ⚠️ 没有签到端点（HasCredits=false 如实登记）：每 200 积分由**登录**触发服务端
// 按日发放，没有可调用的签到 API。

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// accioUserInfo is the POST /api/auth/userinfo payload (fields match the
// official schema; maskedMobile omitted — 本端不展示手机号).
type accioUserInfo struct {
	UserID      string
	UserName    string
	RouteRegion string
	UserLevel   string
}

// accioEnvelope is the parsed `{success, code, message, data}` shape (the
// credits trio tolerates a missing success field — ok 判据是
// `success !== false && data 存在`, ref parseAccioEnvelope).
type accioEnvelope struct {
	ok         bool
	authFailed bool
	data       map[string]any
	message    string
	raw        []byte
}

// accioParseEnvelope splits the response envelope (split out for tests).
//
// ⚠️ ok 的判据是 `success !== false`（而不是 `success === true`）：实测响应都带
// `success:true`，但把判据写成「必须显式 true」会让上游某天省掉该字段 ⇒ 整个
// 余额消失；而 `success:false` 是明确的失败，必须挡住。
func accioParseEnvelope(status int, raw []byte) accioEnvelope {
	var parsed struct {
		Success *bool          `json:"success"`
		Code    any            `json:"code"`
		Message any            `json:"message"`
		Error   any            `json:"error"`
		Data    map[string]any `json:"data"`
	}
	_ = json.Unmarshal(raw, &parsed)
	// ⚠️ code / message / error 走**标量**读取（字符串或数字）—— 上游可能把
	// code 下发成数字 401，用只认字符串的读取器会把它读成空串 ⇒ 误判成
	// 「查询失败」而不是「未登录」（ref readScalarString 注释）。
	code := accioScalarString(parsed.Code)
	message := accioScalarString(parsed.Message)
	if message == "" {
		message = accioScalarString(parsed.Error)
	}
	codePart := ""
	if code != "" {
		codePart = "code=" + code
	}
	summary := strings.TrimSpace(strings.Join(
		[]string{fmt.Sprintf("HTTP %d", status), codePart, message}, " "))
	authFailed := status == http.StatusUnauthorized || status == http.StatusForbidden ||
		strings.EqualFold(code, "401") || strings.EqualFold(code, "NOT_LOGIN") ||
		strings.EqualFold(message, "NOT_LOGIN")
	ok := status >= 200 && status < 300 && parsed.Data != nil
	if parsed.Success != nil && !*parsed.Success {
		ok = false
	}
	return accioEnvelope{ok: ok, authFailed: authFailed, data: parsed.Data, message: summary, raw: raw}
}

// accioCallEndpoint performs one credits-trio call; the METHOD decides where
// the token goes（见文件头表格 —— 调用点无法只改一处而漏掉另一处的刻意形状）。
// client 由调用方注入（登录流用 callbackClient，余额/身份走 Manager 的
// provider 级代理路由客户端）。
func accioCallEndpoint(ctx context.Context, client *http.Client, cred *AccioCredential, method, path string) accioEnvelope {
	tctx, cancel := context.WithTimeout(ctx, accioRequestTimeout)
	defer cancel()
	var req *http.Request
	var err error
	if method == http.MethodPost {
		// userinfo：token 在 **body**（放 query 会 400，放 Authorization 头也
		// 不是它的形状）。
		payload, _ := json.Marshal(map[string]any{"accessToken": cred.AccessToken})
		req, err = http.NewRequestWithContext(tctx, http.MethodPost, accioGatewayBase+path, strings.NewReader(string(payload)))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
		}
	} else {
		// currentSubscription / quota：token 在 **query**（缺它会 400）。
		req, err = http.NewRequestWithContext(tctx, http.MethodGet,
			accioGatewayBase+path+"?"+url.Values{"accessToken": {cred.AccessToken}}.Encode(), nil)
	}
	if err != nil {
		return accioEnvelope{message: err.Error()}
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return accioEnvelope{message: err.Error()}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return accioParseEnvelope(resp.StatusCode, raw)
}

// accioFetchUserInfo queries the account identity (nil + err on failure;
// 身份是附加信息 —— 一般失败不升级成余额错误).
func accioFetchUserInfo(ctx context.Context, client *http.Client, cred *AccioCredential) (*accioUserInfo, error) {
	env := accioCallEndpoint(ctx, client, cred, http.MethodPost, accioUserinfoPath)
	if !env.ok {
		return nil, fmt.Errorf("accio: userinfo 查询失败（%s）", env.message)
	}
	return &accioUserInfo{
		UserID:      accioMapString(env.data, "userId"),
		UserName:    accioMapString(env.data, "userName"),
		RouteRegion: accioMapString(env.data, "routeRegion"),
		UserLevel:   accioMapString(env.data, "userLevel"),
	}, nil
}

// accioMapString reads a plain string field (非字符串返回空串；身份字段不放宽).
func accioMapString(data map[string]any, key string) string {
	s, _ := data[key].(string)
	return s
}

// accioBucketNames are the three entitlement buckets in FIXED display order
// (键序由服务端决定，同一账号两次读数排列可能不同 —— 固定顺序防「跳行」).
var accioBucketNames = []struct{ key, label string }{
	{"daily", "每日积分"},
	{"monthly", "每月积分"},
	{"referral", "推荐积分"},
}

// parseAccioSubscription is the pure balance parser (split for tests):
// `data.entitlement.{daily,monthly,referral}` → CreditBalance（credit 单位）。
// 桶存在但 remaining 读不到 ⇒ 跳过；缺席 ⇒ 不产生行；0 照实保留。
func parseAccioSubscription(raw []byte) (*CreditBalance, error) {
	env := accioParseEnvelope(http.StatusOK, raw)
	if env.authFailed {
		return nil, errAccioNotLogin
	}
	if !env.ok {
		return nil, fmt.Errorf("accio: 订阅响应不可用（%s）", env.message)
	}
	entitlement, _ := env.data["entitlement"].(map[string]any)
	if entitlement == nil {
		return nil, fmt.Errorf("accio: 订阅响应不含 entitlement 字段（%s）", env.message)
	}
	out := &CreditBalance{IsCredit: false}
	for _, bucket := range accioBucketNames {
		value, _ := entitlement[bucket.key].(map[string]any)
		if value == nil {
			continue // 缺席的桶不产生行
		}
		remaining, ok := accioNumber(value["remaining"])
		if !ok {
			continue // 桶存在但读不到主读数：跳过（宁缺勿编）
		}
		total, _ := accioNumber(value["total"])
		used, _ := accioNumber(value["used"])
		out.Packages = append(out.Packages, CreditPackage{
			Name:      bucket.label,
			Unit:      "credit",
			Remaining: accioMaxFloat(0, remaining),
			Total:     total,
			Used:      used,
			Active:    true,
		})
		out.Total += accioMaxFloat(0, remaining)
	}
	if len(out.Packages) == 0 {
		return nil, fmt.Errorf("accio: 订阅响应不含任何积分桶（%s）", env.message)
	}
	return out, nil
}

// accioNumber accepts JSON numbers AND numeric strings（上游把额度下发成字符
// 串是有先例的 —— zcode 的同款教训；空串/null/非数字串返回 ok=false，
// 不编 0）.
func accioNumber(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0, false
		}
		var f float64
		if _, err := fmt.Sscanf(s, "%g", &f); err == nil {
			return f, true
		}
	}
	return 0, false
}

// accioMaxFloat is the small helper the parser needs (math.Max 的 NaN 语义
// 在这里不想要).
func accioMaxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// AccioBalance reads one account's credit balance (currentSubscription 是
// 必需的那个，先发可以短路掉未登录/网络故障，不再白发注定失败的请求).
func (m *Manager) AccioBalance(ctx context.Context, accountID string) (*CreditBalance, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "accio" {
		return nil, ErrNotFound
	}
	cred, err := m.accioCredential(&acc)
	if err != nil {
		return nil, err
	}
	if cred == nil || cred.AccessToken == "" {
		return nil, fmt.Errorf("accio: 账号 %s 的凭据不可用，请重新登录", accountID)
	}
	env := accioCallEndpoint(ctx, m.httpClient("accio"), cred, http.MethodGet, accioSubscriptionPath)
	if env.authFailed {
		return nil, errAccioNotLogin
	}
	if !env.ok {
		return nil, fmt.Errorf("accio: 订阅查询失败（%s）", env.message)
	}
	raw, err := json.Marshal(env.data)
	if err != nil {
		return nil, err
	}
	if len(env.raw) > 0 {
		raw = env.raw
	}
	balance, err := parseAccioSubscription(raw)
	if err != nil {
		return nil, err
	}
	return balance, nil
}
