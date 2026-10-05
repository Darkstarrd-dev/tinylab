package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Qoder /sash/ credits + machine identity (ref qoder-credits.ts /
// qoder-machine.ts). ⚠️ FOUR headers are required together for the daily
// campaigns (ablation-verified): Bearer + Cosy-ClientType:'10' + the PAIR
// Cosy-MachineToken/MachineType (either alone degrades to 1 VIEW_DETAILS
// row, claimable:false — misreported as "今天已领").
const (
	qoderUsagePath      = "/sash/api/v2/me/usage"
	qoderCampaignsPath  = "/sash/api/v1/me/campaigns"
	qoderCreditsTimeout = 15 * time.Second
	// NotActivatedHint is the actionable message for accounts that have
	// never opened daily-claim on the Qoder side (real user report: a fresh
	// GitHub-auth account shows "没有可领取的活动"; the truth is the account
	// has no campaign because it never logged in via the official client).
	NotActivatedHint = "该账号尚未在 Qoder 侧开通每日领取（每日 100 Credits）。请先用 Qoder 官方客户端登录一次该账号，开通后再回来领取。"
	// QoderCampaignRefreshHourUTC8 is the daily campaign refresh hour (UTC+8).
	// Server-side description verbatim: "每日 10:00（UTC+8）刷新，领取后 30 天有效"
	// (ref 1b65a5c). Before this hour the campaign list still belongs to
	// YESTERDAY's round — a CLAIMED row only means yesterday was claimed.
	QoderCampaignRefreshHourUTC8 = 10
	// NotRefreshedYetHint is the actionable message for "today's round has not
	// been published yet". ⚠️ 必须与 NotActivatedHint 区分：前者等一会儿就好
	// （可重试），后者要用户去官方客户端操作；判错的方向是「误报已领」——
	// 那会让用户真的错过今天的额度。
	NotRefreshedYetHint = "今天的每日活动尚未刷新（每日 10:00（UTC+8）刷新），当前看到的是昨天那一轮，请稍后再来领取。"
)

// qoderNowMs is the clock used by the campaign-window check (var so tests can
// pin the moment).
var qoderNowMs = nowMillis

// boolPtr returns a pointer to v (ClaimOutcome.CoversToday is tri-state).
// ⚠️ 保留辅助函数而非 `new(v)`：模块 go 指令是 1.25（`new(expr)` 需要 1.26
// 语言版本；工具链虽是 1.26.5，-lang 仍按 go.mod 取 1.25）。go.mod 升到 1.26
// 后应改为 `new(false)` 并删除本函数。
func boolPtr(v bool) *bool { return &v }

// hasQoderCampaignRefreshedToday reports whether today's campaign round has
// been published (UTC+8 10:00 boundary).
//
// **必须用算术平移而不是本机时区**：活动按 UTC+8 结算，取本机时区会让用户
// 出差 / 改系统时区时得到错的答案（偏东会提前把当天记为已处理、真漏领；偏西
// 会一天判两次）。口径与 qoder_queue.go 的 QoderBillingUTCOffsetMS 一致。
func hasQoderCampaignRefreshedToday(nowMs int64) bool {
	utc8 := time.UnixMilli(nowMs + QoderBillingUTCOffsetMS).UTC()
	return utc8.Hour() >= QoderCampaignRefreshHourUTC8
}

// qoderMachineIdentity is the parsed machine_token.json record.
type qoderMachineIdentity struct {
	Token string
	Type  string
}

// qoderMachineTokenPaths lists the machine_token.json candidates
// (%APPDATA% multi-platform mirror of the reference implementation).
func qoderMachineTokenPaths() []string {
	var paths []string
	if appData := os.Getenv("APPDATA"); appData != "" {
		for _, dir := range []string{"Qoder", "Qoder CN"} {
			paths = append(paths, filepath.Join(appData, dir, "SharedClientCache", "cache", "machine_token.json"))
		}
	}
	home, err := os.UserHomeDir()
	if err == nil {
		paths = append(paths,
			filepath.Join(home, "Library", "Application Support", "Qoder", "SharedClientCache", "cache", "machine_token.json"),
			filepath.Join(home, ".config", "Qoder", "SharedClientCache", "cache", "machine_token.json"),
		)
	}
	return paths
}

// resolveQoderMachineIdentity reads the disk cache fallback (the live
// runtime-info.exe spawn is the reference's main path; we ship the read-only
// file fallback — the plugin's conservative degradation is "no headers").
// BOTH token AND type must be non-empty strings (the pair is required).
func resolveQoderMachineIdentity() *qoderMachineIdentity {
	for _, path := range qoderMachineTokenPaths() {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var parsed map[string]any
		if json.Unmarshal(raw, &parsed) != nil {
			continue
		}
		token := jsonStringField(parsed, "token")
		typ := jsonStringField(parsed, "type")
		if token == "" || typ == "" {
			continue // half identity is worse than none
		}
		return &qoderMachineIdentity{Token: token, Type: typ}
	}
	return nil
}

// qoderCreditsHeaders assembles the /sash/ header set.
func qoderCreditsHeaders(cred *QoderCredential, p *qoderProductConfig) map[string]string {
	h := map[string]string{
		"Accept":          "application/json",
		"Authorization":   "Bearer " + QoderBearerToken(cred),
		"Cosy-ClientType": p.SashClientType,
		"User-Agent":      "Qoder",
	}
	if identity := resolveQoderMachineIdentity(); identity != nil {
		h["Cosy-MachineToken"] = identity.Token
		h["Cosy-MachineType"] = identity.Type
	}
	return h
}

// qoderEnvelopeRequest performs a /sash/ GET/POST; non-2xx/401/403 mapped.
// The product config carries the provider id (qoder | qodercn) for the
// per-provider proxy pick.
func (m *Manager) qoderEnvelopeRequest(ctx context.Context, cred *QoderCredential, p *qoderProductConfig, method, path, body string) (map[string]any, error) {
	var reader io.Reader
	if body != "" || method == http.MethodPost {
		reader = strReader(body) // claim body IS the empty string (content-length 0)
	}
	req, err := http.NewRequestWithContext(ctx, method, p.OpenAPIBase+path, reader)
	if err != nil {
		return nil, err
	}
	for k, v := range qoderCreditsHeaders(cred, p) {
		req.Header.Set(k, v)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	tctx, cancel := context.WithTimeout(ctx, qoderCreditsTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient(p.ID).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			return nil, fmt.Errorf("凭据已失效（HTTP %d），请重新登录该账号", resp.StatusCode)
		}
		return nil, fmt.Errorf("服务端返回了非 JSON 响应（HTTP %d）", resp.StatusCode)
	}
	var parsed map[string]any
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, fmt.Errorf("响应无法解析")
	}
	return parsed, nil
}

// QoderBalance reads /sash/api/v2/me/usage. ⚠️ Balance is NOT only in
// userQuota — a real account measured userQuota.remaining=0 with
// addOnQuota.remaining=100 (the "资源包 100 积分" report); dedicated packages
// are summed too. Enterprise displayMode carries NO numbers (null, not 0).
func (m *Manager) QoderBalance(ctx context.Context, provider, accountID string) (*CreditBalance, error) {
	cred, err := m.qoderCredentialFor(provider, accountID)
	if err != nil {
		return nil, err
	}
	body, err := m.qoderEnvelopeRequest(ctx, cred, qoderProduct(provider), http.MethodGet, qoderUsagePath, "")
	if err != nil {
		return nil, err
	}
	if body["displayMode"] == "enterprise" {
		return nil, fmt.Errorf("jethub: 企业版账号无额度数字")
	}
	usage, _ := body["qoderUsage"].(map[string]any)
	if usage == nil {
		return nil, fmt.Errorf("jethub: 余额响应形状不对")
	}
	out := &CreditBalance{Packages: []CreditPackage{}}
	if pkg := qoderToPackage("套餐额度", usage["userQuota"]); pkg != nil {
		out.Packages = append(out.Packages, *pkg)
	}
	if pkg := qoderToPackage("资源包", usage["addOnQuota"]); pkg != nil {
		out.Packages = append(out.Packages, *pkg)
	}
	if dedicated, ok := usage["dedicatedResourcePackages"].([]any); ok {
		for _, item := range dedicated {
			entry, ok2 := item.(map[string]any)
			if !ok2 {
				continue
			}
			name := firstNonEmpty(jsonStringField(entry, "name"), jsonStringField(entry, "id"), "专用资源包")
			if pkg := qoderToPackage(name, entry); pkg != nil {
				out.Packages = append(out.Packages, *pkg)
			}
		}
	}
	if len(out.Packages) == 0 {
		return nil, fmt.Errorf("jethub: 余额响应无任何包（形状与预期不符）")
	}
	total := 0.0
	for _, pkg := range out.Packages {
		total += pkg.Remaining
	}
	out.Total = roundCredits(total)
	out.IsCredit = true
	return out, nil
}

// qoderToPackage converts one quota object (remaining clamp ≥0; missing
// remaining = total-used).
func qoderToPackage(name string, quota any) *CreditPackage {
	entry, ok := quota.(map[string]any)
	if !ok {
		return nil
	}
	total := jsonNumberField(entry, "total")
	used := jsonNumberField(entry, "used")
	remainingRaw, hasRemaining := entry["remaining"].(float64)
	if !hasRemaining {
		remainingRaw = total - used
	}
	if total < 0 {
		total = 0
	}
	if used < 0 {
		used = 0
	}
	if remainingRaw < 0 {
		remainingRaw = 0
	}
	pkg := &CreditPackage{
		Name: name, Unit: firstNonEmpty(jsonStringField(entry, "unit"), "credits"),
		Remaining: remainingRaw, Total: total, Used: used, Active: true,
	}
	// 到期时间：**专用资源包**带 `expiresAt` / `expires_at`（ISO 字符串，实测），
	// 套餐额度与普通资源包没有独立到期（统一「领取后 30 天」是活动规则而非包字段）。
	// 字段缺失 ⇒ **不设**到期（面板显示「长期」），而不是编一个日期。
	expires := firstNonEmpty(jsonStringField(entry, "expiresAt"), jsonStringField(entry, "expires_at"))
	if expires != "" {
		pkg.ExpiresAt = expires
		if ms := parseISOTime(strings.Replace(expires, " ", "T", 1)); ms > 0 {
			pkg.DeductionEndTime = ms
		}
	}
	return pkg
}

// qoderCampaign is one campaigns[] entry.
type qoderCampaign struct {
	CampaignID  string
	ActionType  string
	ClaimStatus string
	Amount      float64
}

// qoderCampaigns is the parsed campaigns response. ⚠️ claimable:false does
// NOT mean no campaigns — "今天已领" returns showCampaign:false +
// campaigns:[]; do not conclude from it.
type qoderCampaigns struct {
	ShowCampaign bool
	Claimable    bool
	Campaigns    []qoderCampaign
}

// parseQoderCampaigns reads the list (amount = benefit.amount, nested).
func parseQoderCampaigns(body map[string]any) *qoderCampaigns {
	if body == nil {
		return nil
	}
	out := &qoderCampaigns{
		ShowCampaign: body["showCampaign"] == true,
		Claimable:    body["claimable"] == true,
	}
	if raw, ok := body["campaigns"].([]any); ok {
		for _, item := range raw {
			entry, ok2 := item.(map[string]any)
			if !ok2 {
				continue
			}
			id := jsonStringField(entry, "campaignId")
			if id == "" {
				continue
			}
			c := qoderCampaign{CampaignID: id,
				ActionType:  jsonStringField(entry, "actionType"),
				ClaimStatus: jsonStringField(entry, "claimStatus"),
			}
			if benefit, ok3 := entry["benefit"].(map[string]any); ok3 {
				c.Amount = jsonNumberField(benefit, "amount")
			}
			out.Campaigns = append(out.Campaigns, c)
		}
	}
	return out
}

// qoderClaimableCampaigns: CLAIM_BENEFIT + CLAIMABLE.
func qoderClaimableCampaigns(parsed *qoderCampaigns) []qoderCampaign {
	var out []qoderCampaign
	for _, c := range parsed.Campaigns {
		if c.ActionType == "CLAIM_BENEFIT" && c.ClaimStatus == "CLAIMABLE" {
			out = append(out, c)
		}
	}
	return out
}

// isQoderNotActivated: BOTH conditions (no CLAIM_BENEFIT row at all AND the
// usage response LACKS addOnQuota — a missing field, not a zero: used-up
// accounts still have {total:100,remaining:0}).
func isQoderNotActivated(campaigns *qoderCampaigns, usageBody map[string]any) bool {
	if campaigns == nil {
		return false
	}
	for _, c := range campaigns.Campaigns {
		if c.ActionType == "CLAIM_BENEFIT" {
			return false
		}
	}
	if usageBody == nil {
		return false
	}
	usage, _ := usageBody["qoderUsage"].(map[string]any)
	if usage == nil {
		return false
	}
	_, present := usage["addOnQuota"]
	return !present
}

// ClaimQoderDailyCheckin claims every claimable campaign (one account may
// carry several). ⚠️ "无可领活动" is inactive, NOT already-claimed (the real
// user report "没领过就显示已经领取" came from reporting already on an empty
// list — which also happens when the headers are incomplete). The
// already-claimed judgement is a CLAIMED claim-benefit row (packet-capture
// verified: after claiming, the row flips to CLAIMED, the list stays non-empty).
// Idempotence = replayed:true in the claim response (NOT the status code).
func (m *Manager) ClaimQoderDailyCheckin(ctx context.Context, provider, accountID string) (*ClaimOutcome, error) {
	cred, err := m.qoderCredentialFor(provider, accountID)
	if err != nil {
		return &ClaimOutcome{Kind: "failed", Message: err.Error()}, nil
	}
	body, err := m.qoderEnvelopeRequest(ctx, cred, qoderProduct(provider), http.MethodGet, qoderCampaignsPath, "")
	if err != nil {
		return &ClaimOutcome{Kind: "failed", Message: "活动列表查询失败：" + err.Error()}, nil
	}
	parsed := parseQoderCampaigns(body)
	if parsed == nil {
		return &ClaimOutcome{Kind: "failed", Message: "活动列表响应形状不对"}, nil
	}
	// 活动每日 10:00（UTC+8）刷新（服务端原文，ref 1b65a5c）：**刷新前**看到的
	// CLAIMED 属于昨天那一轮，不能判「今天已领」（误报会让当天额度整天漏领）。
	refreshedToday := hasQoderCampaignRefreshedToday(qoderNowMs())
	targets := qoderClaimableCampaigns(parsed)
	if len(targets) == 0 {
		claimedBefore := false
		for _, c := range parsed.Campaigns {
			if c.ActionType == "CLAIM_BENEFIT" && c.ClaimStatus == "CLAIMED" {
				claimedBefore = true
				break
			}
		}
		if claimedBefore {
			if !refreshedToday {
				return &ClaimOutcome{Kind: "inactive", Message: NotRefreshedYetHint, CoversToday: boolPtr(false)}, nil
			}
			return &ClaimOutcome{Kind: "already-claimed", Message: "今天已领取"}, nil
		}
		usage, usageErr := m.qoderEnvelopeRequest(ctx, cred, qoderProduct(provider), http.MethodGet, qoderUsagePath, "")
		if usageErr == nil && isQoderNotActivated(parsed, usage) {
			return &ClaimOutcome{Kind: "inactive", Message: NotActivatedHint}, nil
		}
		return &ClaimOutcome{Kind: "inactive", Message: "当前没有可领取的活动"}, nil
	}
	total := 0.0
	firstError := ""
	for _, target := range targets {
		outcome := m.claimQoderCampaign(ctx, cred, provider, target.CampaignID)
		switch outcome.Kind {
		case "claimed":
			total += outcome.Credit
		case "failed":
			if firstError == "" {
				firstError = outcome.Message
			}
		}
	}
	if total > 0 {
		out := &ClaimOutcome{Kind: "claimed", Credit: total}
		if !refreshedToday {
			// 刷新前领到的是昨天那条补领：如实报「领取成功」，但标记不属于今天
			// 这一轮（ref coversToday:false）。
			out.CoversToday = boolPtr(false)
			out.Message = "领取成功（昨日额度；今日 10:00（UTC+8）后刷新）"
		}
		return out, nil
	}
	if firstError != "" {
		return &ClaimOutcome{Kind: "failed", Message: firstError}, nil
	}
	if !refreshedToday {
		return &ClaimOutcome{Kind: "inactive", Message: NotRefreshedYetHint, CoversToday: boolPtr(false)}, nil
	}
	return &ClaimOutcome{Kind: "already-claimed", Message: "今天已领取"}, nil
}

// claimQoderCampaign claims ONE campaign: body = empty string, idempotence =
// replayed:true.
func (m *Manager) claimQoderCampaign(ctx context.Context, cred *QoderCredential, provider, campaignID string) *ClaimOutcome {
	body, err := m.qoderEnvelopeRequest(ctx, cred, qoderProduct(provider), http.MethodPost,
		qoderCampaignsPath+"/"+url.PathEscape(campaignID)+"/claim", "")
	if err != nil {
		return &ClaimOutcome{Kind: "failed", Message: err.Error()}
	}
	if body["replayed"] == true {
		return &ClaimOutcome{Kind: "already-claimed", Message: "今天已领取"}
	}
	status := jsonStringField(body, "status")
	if status != "" && status != "CLAIMED" {
		return &ClaimOutcome{Kind: "failed", Message: fmt.Sprintf("领取未成功（status=%s）", status)}
	}
	amount := 0.0
	if benefit, ok := body["benefit"].(map[string]any); ok {
		amount = jsonNumberField(benefit, "amount")
	}
	return &ClaimOutcome{Kind: "claimed", Credit: amount}
}

// qoderCredentialFor resolves + parses a qoder-family credential.
func (m *Manager) qoderCredentialFor(provider, accountID string) (*QoderCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != provider {
		return nil, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential(provider, acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(accountID)
	}
	var cred QoderCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse %s credential %s: %w", provider, accountID, err)
	}
	if QoderBearerToken(&cred) == "" {
		return nil, errCredentialMissing(accountID)
	}
	return &cred, nil
}

// qoderProduct looks up the product config by id.
func qoderProduct(provider string) *qoderProductConfig {
	return qoderProducts[provider]
}

// QoderLoginFlow is one in-flight device login (session + product + URL).
type QoderLoginFlow struct {
	Session  *qoderDeviceSession
	Product  *qoderProductConfig
	LoginURL string
}

// StartQoderLogin creates the device session + authorization URL (the API
// layer then polls PollQoderDeviceToken in the background).
func (m *Manager) StartQoderLogin(provider, machineID string) (*QoderLoginFlow, error) {
	p := qoderProduct(provider)
	if p == nil {
		return nil, fmt.Errorf("jethub: unknown qoder product %q", provider)
	}
	session := createQoderDeviceSession(machineID)
	return &QoderLoginFlow{Session: session, Product: p, LoginURL: BuildQoderAuthURL(session, p)}, nil
}

// SubmitQoderDeviceLogin completes a device-code login for one account:
// poll → userinfo nickname → persist. (The WASM-encrypted inference lands
// with the bridge wiring in the same batch.)
func (m *Manager) SubmitQoderDeviceLogin(ctx context.Context, provider, accountID, machineID string) error {
	p := qoderProduct(provider)
	if p == nil {
		return fmt.Errorf("jethub: unknown qoder product %q", provider)
	}
	session := createQoderDeviceSession(machineID)
	payload, err := m.PollQoderDeviceToken(ctx, provider, session, p)
	if err != nil {
		return err
	}
	cred := BuildQoderCredential(payload, machineID, "")
	// 登录成功后补一次 userinfo 拿真实名字（设备码响应从不带 user_name）。
	if nickname := m.FetchQoderUserNickname(ctx, cred); nickname != "" {
		cred.Nickname = nickname
	}
	return m.CompleteQoderLogin(provider, accountID, cred)
}

// CompleteQoderLogin persists the credential + display name.
func (m *Manager) CompleteQoderLogin(provider, accountID string, cred *QoderCredential) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	credJSON, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, QoderExpiresAtMs(cred), QoderRefreshable(cred)); err != nil {
		return err
	}
	_ = m.UpdateAccount(accountID, func(a *Account) {
		if cred.Nickname != "" {
			a.Nickname = cred.Nickname
		}
	})
	return nil
}

// RefreshQoderAccount renews (machine_id required in the body; the machine/
// uid/nickname fields survive).
func (m *Manager) RefreshQoderAccount(ctx context.Context, provider, accountID string) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		return fmt.Errorf("jethub: credential missing for %s", accountID)
	}
	var cred QoderCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return fmt.Errorf("jethub: parse %s credential %s: %w", provider, accountID, err)
	}
	if !QoderRefreshable(&cred) {
		return ErrRefreshTokenExpired
	}
	p := qoderProduct(provider)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		p.OpenAPIBase+qoderRefreshPath, strReader(QoderRefreshBody(&cred)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	tctx, cancel := context.WithTimeout(ctx, qoderCreditsTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient(p.ID).Do(req)
	if err != nil {
		return fmt.Errorf("jethub: qoder refresh 网络失败：%w", err)
	}
	defer resp.Body.Close()
	rawBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload map[string]any
	_ = json.Unmarshal(rawBody, &payload)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_ = m.UpdateAccount(accountID, func(a *Account) { a.Refreshable = false })
		return ErrRefreshTokenExpired
	}
	parsed := parseQoderTokenPayload(payload)
	if parsed.AccessToken == "" {
		return fmt.Errorf("jethub: qoder 续期响应缺少 token")
	}
	refreshed := applyQoderRefresh(&cred, parsed)
	credJSON, err := json.Marshal(refreshed)
	if err != nil {
		return err
	}
	return m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, QoderExpiresAtMs(refreshed), QoderRefreshable(refreshed))
}

// interface guard.
var _ = strings.TrimSpace
