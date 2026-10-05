package jethub

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
)

// RegisterOpencode mounts the OpenCode Zen login + channel-availability endpoints.
//
// OpenCode is the first provider whose login is NOT a browser flow: the user
// pastes a Zen API key (`sk-…`), or adds the anonymous channel (no key at all —
// free models only). There is no login session to poll, hence no /status
// endpoint on this provider.
func (h *Handler) RegisterOpencode(r chi.Router) {
	r.Post("/opencode/login", h.opencodeLogin)
	// 「余额」= 通道可用性（本地状态，零网络请求）。详见
	// Manager.OpencodeChannelBalance 的注释：Zen 没有公开的余额 API，
	// 早期据此把能力登记成 false 会把整个额度行挡死。
	r.Get("/opencode/balance", h.opencodeBalance)
	// 指纹轮换：怀疑多个账号被服务端关联时换一份新的 project id。
	r.Post("/opencode/fingerprint/rotate", h.opencodeRotateFingerprint)
	// 账号自己的出口代理：opencode 的匿名额度按**出口 IP** 计，只有各账号各走
	// 一条出口才会各自拿到独立额度（provider 级 Use Proxy 做不到这件事）。
	r.Put("/opencode/proxy", h.opencodeSetProxy)
}

// opencodeLogin POST /api/jethub/opencode/login
//
//	{apiKey, nickname?}            → store a keyed account
//	{anonymous: true}              → add the anonymous channel (idempotent)
//
// A key already present is reused (reused:true), matching the reference's
// account.create semantics.
func (h *Handler) opencodeLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		APIKey    string `json:"apiKey"`
		Nickname  string `json:"nickname"`
		Anonymous bool   `json:"anonymous"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !req.Anonymous && strings.TrimSpace(req.APIKey) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "apiKey required")
		return
	}
	accountID, reused, err := h.d.Manager.AddOpencodeAccount(req.APIKey, req.Nickname, req.Anonymous)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "accountId": accountID, "reused": reused})
}

// opencodeBalance GET /api/jethub/opencode/balance?accountId=
//
// ⚠️ 与其余渠道的 `{balance}` 形状**多一个 `error` 字段**，且它是 200 响应里的
// 正常内容而不是失败：opencode 的读数是**状态**（「已停用」/「限额中，<时刻>
// 恢复」），必须能与 balance 同时出现。前端优先显示它（与 ref 的
// `credits.balances` 返回 `{balance, error}` 并列同款）。
func (h *Handler) opencodeBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	if accountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	balance, notice, err := h.d.Manager.OpencodeChannelBalance(accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	out := map[string]any{"balance": balance}
	if notice != "" {
		out["error"] = notice
	}
	apibase.WriteJSON(w, http.StatusOK, out)
}

// opencodeRotateFingerprint POST /api/jethub/opencode/fingerprint/rotate
//
//	{accountId}  → 代次 +1，返回新代次
//
// ⚠️ 与「换出口代理」是两种独立的分离手段，文案不得混为一谈：**指纹分离不增加
// 配额**（匿名通道按出口 IP 限额），只有换出口才会拿到独立的匿名额度。
func (h *Handler) opencodeRotateFingerprint(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	generation, err := h.d.Manager.RotateOpencodeFingerprint(req.AccountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"ok": true, "generation": generation,
		"accounts": h.d.Manager.Accounts("opencode"),
	})
}

// opencodeSetProxy PUT /api/jethub/opencode/proxy
//
//	{accountId, proxy}   → 设置该账号自己的出口代理（proxy:"" = 清除，回落直连）
//
// ⚠️ 与「轮换指纹」是**两种独立的分离手段**，文案不得混为一谈：**指纹分离不增加
// 配额**（匿名通道按出口 IP 限额），只有换出口才会拿到独立的匿名额度。
// ⚠️ 空串是**合法值**（用户显式清除代理），不可当成「没传」拒绝 —— 那会让面板上
// 的「清除代理」点了没反应（ref ProviderAccountEntry.opencodeProxy 的同款注释）。
func (h *Handler) opencodeSetProxy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
		Proxy     string `json:"proxy"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.SetAccountProxy(req.AccountID, req.Proxy); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	// 桥接的 key 带着 per-key 代理由此更新（代理主干按 sel.Key.Proxy 选 transport），
	// 故必须 SyncKeys —— 否则面板改了、流量还走旧出口。
	if h.d.Manager.Prefix("opencode") != "" && h.d.Bridge != nil {
		if err := h.d.Bridge.SyncKeys("opencode"); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"ok": true, "accounts": h.d.Manager.Accounts("opencode"),
	})
}
