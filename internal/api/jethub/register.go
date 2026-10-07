// Package jethub provides the Free Hub management API endpoints under
// /api/jethub. It exposes the provider metadata list, prefix bridging and the
// account CRUD minimal set (P1.9); provider-specific login/credits endpoints
// are added by later phases (P2/P3).
package jethub

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/config"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// Deps bundles the manager + bridge the handlers operate on. The router wires
// these after constructing the app-level Manager/Bridge.
type Deps struct {
	Manager *corejethub.Manager
	Bridge  *corejethub.Bridge
}

// Handler serves the /api/jethub routes.
type Handler struct {
	d *Deps
}

// NewHandler creates the jethub API handler.
func NewHandler(d *Deps) *Handler { return &Handler{d: d} }

// Register mounts the jethub routes onto the protected /api group.
func (h *Handler) Register(r chi.Router) {
	r.Route("/jethub", func(r chi.Router) {
		r.Get("/providers", h.listProviders)
		// 渠道级余额合计（Monitor 页 QuotaMonitor 的「Provider · 余额」读数）。
		// ⚠️ 路径是 `/balances` 而不是照搬逐账号的 `/balance` —— 后者被
		// `balanceRoutes()`（balance_capability_test.go）当作「逐账号额度端点」枚举，
		// 混进去会让能力位守卫把合计端点误读成一个渠道。
		r.Get("/balances", h.providerBalances)
		r.Put("/providers/{provider}/prefix", h.setPrefix)
		r.Delete("/providers/{provider}/prefix", h.clearPrefix)
		// Per-provider Use Proxy toggle (login/credits/inference outbound).
		r.Put("/providers/{provider}/proxy", h.setProxyEnabled)
		r.Get("/providers/{provider}/accounts", h.listAccounts)
		r.Post("/providers/{provider}/accounts", h.createAccount)
		// 拖拽排序：顺序即选号优先级（桥接按位置分配 Priority）。
		r.Put("/providers/{provider}/accounts/order", h.reorderAccounts)
		r.Patch("/accounts/{accountID}", h.patchAccount)
		r.Delete("/accounts/{accountID}", h.deleteAccount)
		r.Get("/providers/{provider}/models", h.listModels)
		r.Put("/providers/{provider}/models", h.setModelDisabled)
		r.Post("/providers/{provider}/models/batch-delete", h.batchDeleteModels)
		r.Delete("/providers/{provider}/models", h.restoreDefaultModels)
		// 登录浏览器/会话模式（+新建账号 弹窗）：可用浏览器列表 + 记住的偏好，
		// 以及「重新打开登录页」的显式开页端点。
		r.Get("/login-browsers", h.loginBrowsers)
		r.Post("/open-login-url", h.openLoginURL)
		// Rate-limit markers (原版 account.retest/reset 家族) + the
		// permanent-credit lock toggle (原版 credits.permanentLock).
		r.Post("/providers/{provider}/ratelimits/retest", h.retestRateLimits)
		r.Post("/providers/{provider}/ratelimits/reset", h.resetRateLimits)
		r.Put("/providers/{provider}/permanent-lock", h.setPermanentLock)
		// P2: codearts provider-specific flows (login/refresh/claim/balance).
		h.RegisterCodeArts(r)
		// P3.1: buddy + workbuddy flows.
		h.RegisterBuddy(r)
		// P3.2: lobsterai flows.
		h.RegisterLobsterai(r)
		// P3.3: trae flows.
		h.RegisterTrae(r)
		// P3.3.2: cline flows (WorkOS device-code login).
		h.RegisterCline(r)
		// P3.3.3: raccoon flows (WeChat QR + SMS login).
		h.RegisterRaccoon(r)
		// P3.3.4: loomy flows (WeChat QR login; SMS 备用面；no renewal).
		h.RegisterLoomy(r)
		// P3.3.5: minimax flows (Anthropic-family device login).
		h.RegisterMinimax(r)
		// P3.4: qoder + qodercn flows (PKCE device-code login, shared impl).
		h.RegisterQoder(r)
		// R1-7: opencode flows (pasted API key / anonymous channel).
		h.RegisterOpencode(r)
		// R2: zcode flows (CLI device login / local-credential import /
		// balance / daily claim with the local captcha carrier page).
		h.RegisterZcode(r)
		// P4.9: backup export/import (original-format payload; the browser
		// adds/removes the PBKDF2+AES-GCM encrypted shell).
		r.Get("/backup/export", h.backupExport)
		r.Post("/backup/import", h.backupImport)
	})
}

// backupExport GET — assembles the original-compatible plaintext payload
// (format/version/credentials/accounts/disabledModels); the browser encrypts
// it with the user passphrase before download.
func (h *Handler) backupExport(w http.ResponseWriter, r *http.Request) {
	payload, warnings := h.d.Manager.ExportBackup()
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"payload": payload, "warnings": warnings})
}

// backupImport POST — upsert accounts by original id, store credential JSON
// verbatim, replace the blacklist; re-syncs every bridged provider.
func (h *Handler) backupImport(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Payload *corejethub.BackupPayload `json:"payload"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Payload == nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "payload required")
		return
	}
	imported, skipped, warnings, err := h.d.Manager.ImportBackup(req.Payload)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	for _, p := range corejethub.Providers() {
		if h.d.Manager.Prefix(p.ID) != "" {
			_ = h.d.Bridge.SyncKeys(p.ID)
		}
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"ok": true, "imported": imported, "skipped": skipped, "warnings": warnings,
	})
}

// providerDTO is the metadata + live state of one jethub provider.
type providerDTO struct {
	ID              string   `json:"id"`
	DisplayName     string   `json:"displayName"`
	Description     string   `json:"description,omitempty"`
	HasCredits      bool     `json:"hasCredits"`
	HasBalance      bool     `json:"hasBalance"`
	LoginModes      []string `json:"loginModes,omitempty"`
	AccountCount    int      `json:"accountCount"`
	EnabledAccounts int      `json:"enabledAccounts"`
	Prefix          string   `json:"prefix"`
	Bridged         bool     `json:"bridged"`
	// ProxyEnabled — 该 provider 的 Use Proxy 开关：登录/积分/推理出站是否走
	// 全局上游代理（config.Proxy）。true 时新建账号的鉴权流、续期/签到/余额
	// 请求与桥接后的 /v1/* 推理全部走代理；false 直连。
	ProxyEnabled bool `json:"proxyEnabled"`
	// 能力位（决定详情页按钮行的渲染，与原版能力矩阵同语义）：
	// SupportsRateLimit — 该渠道会返回限流错误（loomy 不会：积分耗尽静默降级
	// 扣永久积分，重测/重置对它无意义且白烧额度，ref RATE_LIMIT_CAPABILITIES）；
	// CanLockPermanent — 有「临时/永久」两个可分的积分池
	// （原版 PERMANENT_LOCK_PROVIDERS = {loomy, buddy, workbuddy}）。
	SupportsRateLimit bool `json:"supportsRateLimit"`
	CanLockPermanent  bool `json:"canLockPermanent"`
	PermanentLocked   bool `json:"permanentLocked"`
	// ClaimKind 是「领取」按钮的**语义**（原版能力矩阵里 `dailyCheckin` 与
	// `onboardingTasks` 是两个彼此独立的位，不能互相推断）：
	//   - "daily"      = 每日签到：每天都有收益，按钮文案是「领取」；
	//   - "onboarding" = **一次性**奖励：每号只能领一次（raccoon 的桌面端登录
	//     奖励只有这一个端点，本端把它落在领取按钮上）。
	// 混用会让用户以为每天都能再领一次，于是每天点一次必然 already-claimed 的请求。
	ClaimKind string `json:"claimKind"`
	// SupportsOnboardingTasks 表示该渠道**另有**独立的一次性任务端点
	// （原版 `onboardingTasks`；目前只有 loomy：8 个任务合计 10000 分）。为真时
	// 卡片上额外渲染一个独立按钮 —— 与每日签到是**两件事**，混进「一键签到」会
	// 每天对已领完的账号发 8 个必然 alreadyCompleted 的请求。
	SupportsOnboardingTasks bool `json:"supportsOnboardingTasks"`
}

// onboardingTaskProviders mirrors the original CREDITS_CAPABILITIES.onboardingTasks
// set (ref credits-capabilities.js)：**一次性**奖励渠道。
var onboardingTaskProviders = map[string]bool{
	"loomy": true, "raccoon": true,
}

// claimKindOf mirrors the original split between dailyCheckin and
// onboardingTasks: a provider whose ONLY claim endpoint is a one-time reward
// must not be labelled as a daily check-in.
func claimKindOf(provider string) string {
	// raccoon 的「每日 300 积分」由**服务端按日自动发放**（账单里
	// `biz_type: daily_grant`），**没有可选调用的签到端点** —— 它登记在
	// onboardingTasks 上，故这里如实标成一次性。
	if provider == "raccoon" {
		return "onboarding"
	}
	return "daily"
}

// permanentLockProviders mirrors the original PERMANENT_LOCK_PROVIDERS set
// (ref src/jet-hub-rpc.ts): only these have two separable credit pools.
var permanentLockProviders = map[string]bool{
	"loomy": true, "buddy": true, "workbuddy": true,
}

// rateLimitExemptProviders mirrors the original RATE_LIMIT_CAPABILITIES — the
// providers whose rate limiting is NOT governed by the per-card retest/reset
// buttons. 登记判据见 ref credits-capabilities.js：答「这个按钮点下去，能不能
// 让用户**少**受限一次？」，答否即登记：
//
//   - loomy：**根本不返回限流错误**（今日赠送额度用完后静默降级去扣永久积分）
//     ⇒ 重测永远测不出东西、重置没有标记可清，重测还会白烧额度。
//
// （R3-3 的 gemini 曾同在此表：它的限流是服务端配额窗口制，重测/重置只会白烧
// 配额。R5 删除该渠道后条目一并移除。）
//
// ⚠️ 漏登记的后果与额度能力位相反：多渲染两个按钮不会报错，但会让用户对
// loomy 反复白烧额度（用户报障原文：「重测按钮你确认过会发请求吗，为什么响应
// 这么快？可以移除吗」）。
var rateLimitExemptProviders = map[string]bool{
	"loomy": true,
}

func (h *Handler) listProviders(w http.ResponseWriter, r *http.Request) {
	metas := corejethub.Providers()
	out := make([]providerDTO, 0, len(metas))
	for _, meta := range metas {
		dto := providerDTO{
			ID:              meta.ID,
			DisplayName:     meta.DisplayName,
			Description:     meta.Description,
			HasCredits:      meta.HasCredits,
			HasBalance:      meta.HasBalance,
			LoginModes:      meta.LoginModes,
			AccountCount:    h.d.Manager.AccountCount(meta.ID),
			EnabledAccounts: h.d.Manager.EnabledAccountCount(meta.ID),
			Prefix:          h.d.Manager.Prefix(meta.ID),
		}
		dto.Bridged = dto.Prefix != "" && h.d.Bridge != nil && h.d.Bridge.HasBridgedProvider(meta.ID)
		dto.ProxyEnabled = h.d.Manager.ProxyEnabled(meta.ID)
		dto.SupportsRateLimit = !rateLimitExemptProviders[meta.ID]
		dto.CanLockPermanent = permanentLockProviders[meta.ID]
		dto.PermanentLocked = h.d.Manager.PermanentLocked(meta.ID)
		dto.ClaimKind = claimKindOf(meta.ID)
		// 「另有一次性任务端点」只在确实**同时**有每日签到时才是独立按钮：
		// raccoon 的领取本身就是那个一次性端点，再渲染第二个按钮会让同一个动作
		// 出现两次（且其中一个必然 already-claimed）。
		dto.SupportsOnboardingTasks = onboardingTaskProviders[meta.ID] && dto.ClaimKind == "daily"
		out = append(out, dto)
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"providers": out})
}

type prefixRequest struct {
	Prefix string `json:"prefix"`
}

// setPrefix PUT /api/jethub/{provider}/prefix — validate + persist + bridge.
func (h *Handler) setPrefix(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	var req prefixRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if err := h.d.Bridge.SetPrefix(provider, req.Prefix); err != nil {
		if _, ok := err.(*corejethub.ConflictError); ok {
			apibase.WriteAPIError(w, http.StatusConflict, err.Error())
			return
		}
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "prefix": h.d.Manager.Prefix(provider)})
}

// clearPrefix DELETE /api/jethub/{provider}/prefix — unbridge.
func (h *Handler) clearPrefix(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if err := h.d.Bridge.ClearPrefix(provider); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type proxyToggleRequest struct {
	Enabled *bool `json:"enabled"`
}

// setProxyEnabled PUT /api/jethub/{provider}/proxy {enabled} — the per-provider
// Use Proxy toggle: persists the flag (Manager.SetProxyEnabled), re-syncs the
// bridged provider (SyncKeys writes UseProxy so /v1/* inference follows).
func (h *Handler) setProxyEnabled(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if !corejethub.ProviderExists(provider) {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown provider")
		return
	}
	var req proxyToggleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Enabled == nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "enabled (bool) required")
		return
	}
	if err := h.d.Manager.SetProxyEnabled(provider, *req.Enabled); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Inference follows the toggle: SyncKeys writes UseProxy on the bridged
	// provider (the proxy pipeline checks p.UseProxy per request).
	if h.d.Manager.Prefix(provider) != "" && h.d.Bridge != nil {
		_ = h.d.Bridge.SyncKeys(provider)
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "proxyEnabled": *req.Enabled})
}

func (h *Handler) listAccounts(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if !corejethub.ProviderExists(provider) {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown provider")
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts(provider)})
}

// reorderAccounts PUT /api/jethub/providers/{provider}/accounts/order
//
//	{"accountIds": ["a","b","c"]}   ← 必须恰好是该 provider 的全部账号
//
// 顺序即**选号优先级**：桥接时按池内位置分配 key 的 Priority（fill-first 取
// priority ASC 的第一个），故这次改动**直接决定下一条请求用哪个账号**。
// 改完必须 SyncKeys，否则注册表里还是旧顺序（面板看着换了、实际没换）。
func (h *Handler) reorderAccounts(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if !corejethub.ProviderExists(provider) {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown provider")
		return
	}
	var req struct {
		AccountIDs []string `json:"accountIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.AccountIDs) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountIds required")
		return
	}
	if err := h.d.Manager.ReorderAccounts(provider, req.AccountIDs); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	if h.d.Manager.Prefix(provider) != "" && h.d.Bridge != nil {
		if err := h.d.Bridge.SyncKeys(provider); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"ok": true, "accounts": h.d.Manager.Accounts(provider),
	})
}

type createAccountRequest struct {
	Nickname string `json:"nickname"`
}

// createAccount POST /api/jethub/{provider}/accounts — P1 registers a
// placeholder account; the provider-specific login flow (P2/P3) attaches the
// credential afterwards.
func (h *Handler) createAccount(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if !corejethub.ProviderExists(provider) {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown provider")
		return
	}
	var req createAccountRequest
	_ = json.NewDecoder(r.Body).Decode(&req) // body optional
	id, credentialRef := corejethub.NewAccountID(provider)
	nickname := req.Nickname
	if nickname == "" {
		nickname = id
	}
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: provider, Nickname: nickname,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusCreated, map[string]any{"accountId": id, "credentialRef": credentialRef})
}

type patchAccountRequest struct {
	Nickname *string `json:"nickname"`
	Enabled  *bool   `json:"enabled"`
}

// patchAccount PATCH /api/jethub/accounts/{accountID} — enable/disable +
// rename. Toggling enabled re-syncs the bridged provider keys.
func (h *Handler) patchAccount(w http.ResponseWriter, r *http.Request) {
	accountID := chi.URLParam(r, "accountID")
	var req patchAccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	err := h.d.Manager.UpdateAccount(accountID, func(a *corejethub.Account) {
		if req.Nickname != nil {
			a.Nickname = *req.Nickname
		}
		if req.Enabled != nil {
			a.Enabled = *req.Enabled
		}
	})
	if err == corejethub.ErrNotFound {
		apibase.WriteAPIError(w, http.StatusNotFound, "account not found")
		return
	}
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Keys follow the enabled set: re-sync if the account's provider is bridged.
	if acc, ok := h.d.Manager.FindAccount(accountID); ok && h.d.Manager.Prefix(acc.Provider) != "" {
		_ = h.d.Bridge.SyncKeys(acc.Provider)
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// deleteAccount DELETE /api/jethub/accounts/{accountID} — removes the entry,
// its credential and re-syncs the bridge.
func (h *Handler) deleteAccount(w http.ResponseWriter, r *http.Request) {
	accountID := chi.URLParam(r, "accountID")
	acc, ok := h.d.Manager.FindAccount(accountID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "account not found")
		return
	}
	if err := h.d.Manager.DeleteAccount(accountID); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if h.d.Manager.Prefix(acc.Provider) != "" {
		_ = h.d.Bridge.SyncKeys(acc.Provider)
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// listModels GET /api/jethub/{provider}/models — the static product table
// with the per-model disabled flag for the UI blacklist toggles. `rate`
// carries the billing-rate suffix parsed from the product tables (原版倍率
// 显示：x0.75 / 免费 / x0.2→x0.1；无倍率信息时为空串，不编造).
func (h *Handler) listModels(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	prod, ok := h.d.Bridge.Product(provider)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "no product registered for provider")
		return
	}
	disabled := h.d.Manager.DisabledModels(provider)
	// Runtime-verified dead models (R5, ref f8748fa): 静态兜底表是编译期快照，
	// 上游下架模型时它不会自己变 —— 实证记录过的模型不再播报。
	gone := h.d.Manager.DeadModels(provider)
	type modelEntry struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Rate     string `json:"rate,omitempty"`
		Disabled bool   `json:"disabled"`
	}
	out := make([]modelEntry, 0, len(prod.Models))
	for _, md := range prod.Models {
		if gone[md.ID] {
			continue
		}
		name, rate := modelDisplayParts(md)
		out = append(out, modelEntry{ID: md.ID, Name: name, Rate: rate, Disabled: disabled[md.ID]})
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"models": out})
}

// modelDisplayParts splits a model definition into (display name, rate):
//   - raccoon/loomy tables already embed the rate in the Alias
//     ("GLM-5-3 · x0.75" / "SenseNova-6.8-Flash · 免费") — split it off;
//   - qoder/træ style tables carry the rate as a Note segment ("x2", "FREE (x0)")
//     — parse it there;
//   - no rate info anywhere → rate "" and the name falls back to the id
//     (never invent a rate: 编造倍率比不显示更糟, ref buddy.ts).
//
// ⚠️ Note 里的三种受支持段（其余散文段忽略）：
//
//	x0.5                 基础倍率（"免费" 亦属此列）
//	FREE (x0)            免费（**仅当括号里的倍率是 0**）
//	promo 22:00-08:00 x0.2
//	                     促销段：窗口内展示 `基础→折后`，窗口外只展示基础倍率
//
// ⚠️ 裸 `FREE` 段**不再**当成「免费」：ref 的 `isFree` 只表示「有免费额度」，
// 展示上是否显示「免费」完全取决于 `priceFactor === 0`（ref qoder-adapter.ts
// 的 qoderDisplayName：`if (model.priceFactor === 0) return … · 免费`）。此前把它
// 无条件当免费，导致 `Qwen3.8-Max`（实为 x0.5→x0.2）被显示成「免费」——用户实测
// 报障「倍率显示和插件中不一致」。
func modelDisplayParts(md config.ModelDef) (name, rate string) {
	return modelDisplayPartsAt(md, time.Now())
}

// modelDisplayPartsAt is modelDisplayParts with an injectable clock (the
// promotion window must be testable on both sides).
// rateFree 是倍率显示哨兵（展示域字符串，非业务判据）：仅在本解析器、
// rateTextRe 与 register_test.go 断言中出现。i18n 化只允许在前端展示边缘
// 进行，禁止改动此值。
const rateFree = "免费"

func modelDisplayPartsAt(md config.ModelDef, now time.Time) (name, rate string) {
	src := md.Alias
	if src == "" {
		return md.ID, ""
	}
	// Alias-embedded form: "Name · rate"
	if idx := strings.Index(src, "·"); idx >= 0 {
		tail := strings.TrimSpace(src[idx+len("·"):])
		if isRateText(tail) {
			return strings.TrimSpace(src[:idx]), tail
		}
	}
	base := ""
	promoRate := ""
	var winStart, winEnd int
	havePromoWindow := false
	for _, seg := range strings.Split(md.Note, ";") {
		seg = strings.TrimSpace(seg)
		if seg == "" {
			continue
		}
		if isRateText(seg) {
			if base == "" || base == rateFree {
				base = seg
			}
			continue
		}
		if m := freeRateRe.FindStringSubmatch(seg); m != nil {
			// `FREE (x0)` ⇒ 免费；`FREE (x1.5)` ⇒ 有免费额度但按 x1.5 计费
			// （倍率非 0 就不能显示成免费 —— 这正是 qmodel_38max 的误标来源）。
			if v, err := strconv.ParseFloat(m[1], 64); err == nil && v == 0 {
				base = rateFree
			} else {
				base = "x" + m[1]
			}
			continue
		}
		if m := promoRe.FindStringSubmatch(seg); m != nil {
			start, end, ok := parsePromoWindow(m[1])
			if ok {
				promoRate, winStart, winEnd, havePromoWindow = m[2], start, end, true
			}
		}
	}
	// 免费优先于促销（ref 同序：priceFactor === 0 ⇒ 免费，不看窗口）。
	if base == rateFree {
		return src, rateFree
	}
	if base == "" {
		return src, ""
	}
	if promoRate != "" && havePromoWindow && promotionActiveAt(winStart, winEnd, now) {
		return src, base + "→" + promoRate
	}
	return src, base
}

// rateTextRe matches the normalized rate suffixes used across the product
// tables: x0.75, x1, x0.2→x0.1 (promotion price), 免费 (free).
var rateTextRe = regexp.MustCompile(`^x\d+(\.\d+)?(→x\d+(\.\d+)?)?$|^` + rateFree + `$`)

// freeRateRe matches the `FREE (xN)` note segment: the parenthesised value is
// the multiplier (`FREE (x0)` = free, `FREE (x1.5)` = free-quota flag but
// billed at x1.5 — only a literal zero may render as 免费).
var freeRateRe = regexp.MustCompile(`^FREE \(x(\d+(?:\.\d+)?)\)$`)

// promoRe matches a promotion segment: `promo 22:00-08:00 x0.2`.
var promoRe = regexp.MustCompile(`^promo\s+(\d{1,2}:\d{2}-\d{1,2}:\d{2})\s+(x\d+(?:\.\d+)?)$`)

func isRateText(s string) bool { return rateTextRe.MatchString(s) }

// parsePromoWindow parses "HH:MM-HH:MM" into minutes-of-day.
func parsePromoWindow(spec string) (start, end int, ok bool) {
	parts := strings.SplitN(spec, "-", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	toMinutes := func(hhmm string) (int, bool) {
		m := regexp.MustCompile(`^(\d{1,2}):(\d{2})$`).FindStringSubmatch(strings.TrimSpace(hhmm))
		if m == nil {
			return 0, false
		}
		h, _ := strconv.Atoi(m[1])
		min, _ := strconv.Atoi(m[2])
		if h >= 24 || min >= 60 {
			return 0, false
		}
		return h*60 + min, true
	}
	start, okStart := toMinutes(parts[0])
	end, okEnd := toMinutes(parts[1])
	if !okStart || !okEnd {
		return 0, 0, false
	}
	return start, end, true
}

// promotionActiveAt reports whether the promotion window covers `now`, in
// **UTC+8 wall time** (the catalog's timezone; identical rule to the
// reference implementation's promotionActiveNow, incl. cross-midnight
// windows such as 22:00-08:00).
func promotionActiveAt(start, end int, now time.Time) bool {
	utc8 := now.UTC().Add(8 * time.Hour)
	minutes := utc8.Hour()*60 + utc8.Minute()
	if start <= end {
		return minutes >= start && minutes < end
	}
	return minutes >= start || minutes < end
}

type setModelDisabledRequest struct {
	ModelID  string `json:"modelId"`
	Disabled *bool  `json:"disabled"`
}

// setModelDisabled PUT /api/jethub/{provider}/models — toggle the blacklist
// and re-sync the bridged provider's registry model list.
func (h *Handler) setModelDisabled(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	var req setModelDisabledRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.ModelID == "" || req.Disabled == nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "modelId and disabled are required")
		return
	}
	if _, ok := h.d.Bridge.Product(provider); !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "no product registered for provider")
		return
	}
	if err := h.d.Manager.SetModelDisabled(provider, req.ModelID, *req.Disabled); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if h.d.Manager.Prefix(provider) != "" {
		_ = h.d.Bridge.SyncKeys(provider)
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"disabledModels": h.d.Manager.DisabledModels(provider),
	})
}

// batchDeleteModels POST /api/jethub/{provider}/models/batch-delete
// {modelIds: [...]} — blacklist many models in one write (batch manage
// 「删除所选」), then re-sync the bridged provider once.
func (h *Handler) batchDeleteModels(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	var req struct {
		ModelIDs []string `json:"modelIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.ModelIDs) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "modelIds required")
		return
	}
	if _, ok := h.d.Bridge.Product(provider); !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "no product registered for provider")
		return
	}
	if err := h.d.Manager.SetModelsDisabled(provider, req.ModelIDs, true); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if h.d.Manager.Prefix(provider) != "" {
		_ = h.d.Bridge.SyncKeys(provider)
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// restoreDefaultModels DELETE /api/jethub/{provider}/models — clear the whole
// blacklist (原版「恢复默认」：所有模型回到显示列表).
func (h *Handler) restoreDefaultModels(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if _, ok := h.d.Bridge.Product(provider); !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "no product registered for provider")
		return
	}
	if err := h.d.Manager.ClearDisabledModels(provider); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if h.d.Manager.Prefix(provider) != "" {
		_ = h.d.Bridge.SyncKeys(provider)
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type rateLimitsRequest struct {
	AccountID string `json:"accountId"`
}

// retestRateLimits POST /api/jethub/{provider}/ratelimits/retest — one minimal
// real message per marked (account, model); success clears the marker.
// Consumes a little model quota (the UI confirms before calling).
func (h *Handler) retestRateLimits(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if !corejethub.ProviderExists(provider) {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown provider")
		return
	}
	var req rateLimitsRequest
	_ = json.NewDecoder(r.Body).Decode(&req) // body optional (all accounts)
	res, err := h.d.Bridge.RetestRateLimits(r.Context(), provider, req.AccountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, res)
}

// resetRateLimits POST /api/jethub/{provider}/ratelimits/reset — clear the
// markers without any request (原版 RESET 语义).
func (h *Handler) resetRateLimits(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if !corejethub.ProviderExists(provider) {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown provider")
		return
	}
	var req rateLimitsRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	res, err := h.d.Bridge.ResetRateLimits(provider, req.AccountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, res)
}

// setPermanentLock PUT /api/jethub/{provider}/permanent-lock {locked} —
// provider-level「锁定永久积分」switch (persisted; travels in backups).
func (h *Handler) setPermanentLock(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if !permanentLockProviders[provider] {
		apibase.WriteAPIError(w, http.StatusBadRequest, "provider does not support the permanent-credit lock")
		return
	}
	var req struct {
		Locked *bool `json:"locked"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Locked == nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "locked (bool) required")
		return
	}
	if err := h.d.Manager.SetPermanentLocked(provider, *req.Locked); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "locked": *req.Locked})
}
