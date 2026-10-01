package jethub

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// RegisterLoomy mounts the loomy routes (P3.3.4): **WeChat QR login**（主路径，
// 本地弹窗页驱动）+ SMS login（备用，与插件的休眠 RPC 对位）+ onboarding + daily
// quota + balance. NO renewal (honestly refreshable:false).
func (h *Handler) RegisterLoomy(r chi.Router) {
	r.Post("/loomy/login", h.loomyLogin)
	r.Post("/loomy/login/sms/send", h.loomySmsSend)
	r.Post("/loomy/login/sms/submit", h.loomySmsSubmit)
	r.Get("/loomy/status", h.loomyStatus)
	r.Post("/loomy/probe", h.loomyProbe)
	r.Post("/loomy/claim", h.loomyClaim)
	r.Get("/loomy/balance", h.loomyBalance)
	r.Get("/loomy/onboarding", h.loomyOnboardingStatus)
	r.Post("/loomy/onboarding/claim", h.loomyOnboardingClaim)
}

// loomyLogin POST — WeChat QR flow, the panel's「新建账号」路径。
//
// ⚠️ 与插件行为的对齐点（用户实测报障：「loomy 添加变成了项目内 modal 输入手机号+验证码」）：
// 插件走 `startWechatLogin()` → 返回**本地弹窗页** URL → `window.open`；短信只是
// 无 UI 的备用 RPC。这里同样：先建占位账号 → 起微信流程（取二维码 uuid，失败即删
// 占位）→ 注册登录会话 → 开浏览器 → 返回 `loginUrl`（本地页）。
//
// ⚠️ 顺序契约：**先注册会话再开浏览器**（同 raccoon：页面可能抢在登记前请求数据
// 端点而拿到 404）。
// ⚠️ 后台流程绝不能挂 r.Context()（handler 返回后请求 context 立即被取消）。
func (h *Handler) loomyLogin(w http.ResponseWriter, r *http.Request) {
	id, credentialRef := corejethub.NewAccountID("loomy")
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: "loomy", Nickname: id,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	flow, err := h.d.Manager.StartLoomyWechatLogin(context.Background(), id)
	if err != nil {
		_ = h.d.Manager.DeleteAccount(id)
		apibase.WriteAPIError(w, http.StatusBadGateway, "无法启动 Loomy 微信登录："+err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	pageURL := loomyLoginPageURL(r, loginID)
	sess := &corejethub.LoginSession{
		Started: &corejethub.StartedLogin{LoginURL: pageURL, Result: flow.Result()},
		Account: id,
		Manager: h.d.Manager,
		Extra:   flow,
	}
	corejethub.RegisterLoginSession(loginID, sess)
	go corejethub.SettleAndCleanup(sess, nil)
	h.d.Manager.OpenURLWithBrowser(pageURL)

	writeJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  pageURL,
		"loginMode": "url",
	})
}

// loomySmsSend POST {phone} → {msgid} (echoed back on submit).
func (h *Handler) loomySmsSend(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone string `json:"phone"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Phone == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "phone required")
		return
	}
	msgid, err := h.d.Manager.SendLoomySmsCode(r.Context(), req.Phone)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"msgid": msgid})
}

// loomySmsSubmit POST {accountId, phone, code, msgid} — completes login,
// persists (expires locally +14d), initializes the daily quota best-effort.
func (h *Handler) loomySmsSubmit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
		Phone     string `json:"phone"`
		Code      string `json:"code"`
		MsgID     string `json:"msgid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" || req.Code == "" || req.Phone == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId, phone and code are required")
		return
	}
	if err := h.d.Manager.SubmitLoomySmsLogin(r.Context(), req.AccountID, req.Phone, req.Code, req.MsgID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "accountId": req.AccountID})
}

// loomyStatus GET — account snapshot (refreshable always false).
func (h *Handler) loomyStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("loomy")})
}

// loomyProbe POST {accountId} — verify without renewing (Loomy cannot renew;
// 100002 → re-login).
func (h *Handler) loomyProbe(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.ProbeLoomyAccount(r.Context(), req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// loomyClaim POST — daily quota RESET trigger (alreadyProcessed →
// already-claimed; semantics wording must stay accurate).
func (h *Handler) loomyClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	outcome, err := h.d.Manager.ClaimLoomyDaily(r.Context(), req.AccountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"outcome": outcome})
}

// loomyBalance GET — two pools (permanent + daily) as separate packages.
func (h *Handler) loomyBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	balance, err := h.d.Manager.LoomyCreditBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"balance": balance})
}

// loomyOnboardingStatus GET {accountId} — 8-task state + earned/total.
func (h *Handler) loomyOnboardingStatus(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	tasks, earned, total, err := h.d.Manager.LoomyOnboardingStatus(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tasks": tasks, "earned": earned, "total": total})
}

// loomyOnboardingClaim POST — complete all pending tasks (idempotent).
func (h *Handler) loomyOnboardingClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	claimed, skipped, earned, total, err := h.d.Manager.ClaimLoomyOnboarding(r.Context(), req.AccountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	if claimed == nil {
		claimed = []string{}
	}
	if skipped == nil {
		skipped = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"claimed": claimed, "skipped": skipped, "earned": earned, "total": total,
	})
}
