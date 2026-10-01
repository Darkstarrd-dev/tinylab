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
		r.Put("/providers/{provider}/prefix", h.setPrefix)
		r.Delete("/providers/{provider}/prefix", h.clearPrefix)
		// Per-provider Use Proxy toggle (login/credits/inference outbound).
		r.Put("/providers/{provider}/proxy", h.setProxyEnabled)
		r.Get("/providers/{provider}/accounts", h.listAccounts)
		r.Post("/providers/{provider}/accounts", h.createAccount)
		r.Patch("/accounts/{accountID}", h.patchAccount)
		r.Delete("/accounts/{accountID}", h.deleteAccount)
		r.Get("/providers/{provider}/models", h.listModels)
		r.Put("/providers/{provider}/models", h.setModelDisabled)
		r.Post("/providers/{provider}/models/batch-delete", h.batchDeleteModels)
		r.Delete("/providers/{provider}/models", h.restoreDefaultModels)
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
	writeJSON(w, http.StatusOK, map[string]any{"payload": payload, "warnings": warnings})
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
	writeJSON(w, http.StatusOK, map[string]any{
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
}

// permanentLockProviders mirrors the original PERMANENT_LOCK_PROVIDERS set
// (ref src/jet-hub-rpc.ts): only these have two separable credit pools.
var permanentLockProviders = map[string]bool{
	"loomy": true, "buddy": true, "workbuddy": true,
}

// rateLimitExemptProviders mirrors the original RATE_LIMIT_CAPABILITIES — the
// only provider known NOT to return rate-limit errors.
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
		out = append(out, dto)
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": out})
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "prefix": h.d.Manager.Prefix(provider)})
}

// clearPrefix DELETE /api/jethub/{provider}/prefix — unbridge.
func (h *Handler) clearPrefix(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if err := h.d.Bridge.ClearPrefix(provider); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "proxyEnabled": *req.Enabled})
}

func (h *Handler) listAccounts(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if !corejethub.ProviderExists(provider) {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown provider")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts(provider)})
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
	writeJSON(w, http.StatusCreated, map[string]any{"accountId": id, "credentialRef": credentialRef})
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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
	type modelEntry struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Rate     string `json:"rate,omitempty"`
		Disabled bool   `json:"disabled"`
	}
	out := make([]modelEntry, 0, len(prod.Models))
	for _, md := range prod.Models {
		name, rate := modelDisplayParts(md)
		out = append(out, modelEntry{ID: md.ID, Name: name, Rate: rate, Disabled: disabled[md.ID]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": out})
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
			if base == "" || base == "免费" {
				base = seg
			}
			continue
		}
		if m := freeRateRe.FindStringSubmatch(seg); m != nil {
			// `FREE (x0)` ⇒ 免费；`FREE (x1.5)` ⇒ 有免费额度但按 x1.5 计费
			// （倍率非 0 就不能显示成免费 —— 这正是 qmodel_38max 的误标来源）。
			if v, err := strconv.ParseFloat(m[1], 64); err == nil && v == 0 {
				base = "免费"
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
	if base == "免费" {
		return src, "免费"
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
var rateTextRe = regexp.MustCompile(`^x\d+(\.\d+)?(→x\d+(\.\d+)?)?$|^免费$`)

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
	writeJSON(w, http.StatusOK, map[string]any{
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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
	writeJSON(w, http.StatusOK, res)
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
	writeJSON(w, http.StatusOK, res)
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "locked": *req.Locked})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
