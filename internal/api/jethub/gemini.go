package jethub

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// RegisterGemini mounts the gemini routes (R3-3): Google OAuth browser-callback
// login + refresh + quota windows. Inference goes through the bridged provider
// (envelope conversion in the augmenter; SSE → OpenAI in the interceptor).
func (h *Handler) RegisterGemini(r chi.Router) {
	r.Post("/gemini/login", h.geminiLogin)
	r.Get("/gemini/status", h.geminiStatus)
	r.Post("/gemini/refresh", h.geminiRefresh)
	r.Post("/gemini/cancel", h.geminiCancel)
	r.Get("/gemini/balance", h.geminiBalance)
}

// geminiLogin POST — Google OAuth（本地回调服务器 + 打开浏览器）；loginId
// 跟踪轮询。后台 goroutine 等回调并换令牌（⚠️ 必须 background context：
// r.Context() 在响应写回即取消——minimax 登录同款教训）。
func (h *Handler) geminiLogin(w http.ResponseWriter, r *http.Request) {
	sel := decodeLoginOpen(r)
	id, credentialRef := corejethub.NewAccountID("gemini")
	opt, err := h.prepareLoginOpen(sel, id)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: "gemini", Nickname: id,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	flow, err := h.d.Manager.StartGeminiLogin(opt)
	if err != nil {
		_ = h.d.Manager.DeleteAccount(id)
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	resultCh := make(chan corejethub.LoginOutcome, 1)
	started := corejethub.NewStartedLoginWithChannel(flow.LoginURL, resultCh)
	sess := &corejethub.LoginSession{Started: started, Account: id, Manager: h.d.Manager}
	corejethub.RegisterLoginSession(loginID, sess)
	// 取消注册表：cancel 路由按 loginId 关掉本地回调服务器。
	geminiFlows.Store(loginID, flow)
	// 后台等回调 → 换令牌 → 落凭据。
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		cred, err := flow.Wait(ctx, h.d.Manager)
		if err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		// 身份展示名：email 优先，退 sub（ref geminiAccountLabel）。
		nickname := id
		if cred.Email != "" {
			nickname = cred.Email
		} else if cred.Sub != "" {
			nickname = cred.Sub
		}
		cred.Nickname = nickname
		if err := h.d.Manager.CompleteGeminiLogin(id, cred); err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		_ = h.d.Manager.UpdateAccount(id, func(a *corejethub.Account) { a.Nickname = nickname })
		credJSON, _ := json.Marshal(cred)
		corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{
			CredentialJSON: credJSON,
			ExpiresAt:      corejethub.GeminiExpiresAtMs(cred),
			Refreshable:    corejethub.GeminiRefreshable(cred),
		})
	}()
	// Single-winner pump（与 minimax 登录同款：CompleteGeminiLogin 已落凭据，
	// 失败删占位账号，status 轮询拿结果）。
	go corejethub.SettleAndCleanup(sess, nil)
	apibase.WriteJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  flow.LoginURL,
		"loginMode": "url",
	})
}

// geminiStatus GET — flow poll via loginId, or account snapshot.
func (h *Handler) geminiStatus(w http.ResponseWriter, r *http.Request) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("gemini")})
}

// geminiRefresh POST — silent renewal via refresh_token.
func (h *Handler) geminiRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.RefreshGeminiAccount(r.Context(), req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// geminiCancel POST — abort a pending flow (closes the local callback server).
func (h *Handler) geminiCancel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		LoginID string `json:"loginId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.LoginID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "loginId required")
		return
	}
	if flow, ok := geminiFlows.LoadAndDelete(req.LoginID); ok {
		flow.(*corejethub.GeminiLoginFlow).Close()
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// geminiBalance GET — quota windows（5 小时 / 周，百分比；非积分）。
func (h *Handler) geminiBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	balance, err := h.d.Manager.GeminiBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"balance": balance})
}

// geminiFlows tracks started OAuth flows by loginId（cancel 路由用）。
var geminiFlows sync.Map
