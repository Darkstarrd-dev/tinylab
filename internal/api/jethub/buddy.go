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

// RegisterBuddy mounts the buddy/workbuddy routes (P3.1). Both products share
// one implementation; the provider path param selects the product config.
func (h *Handler) RegisterBuddy(r chi.Router) {
	for _, provider := range []string{"buddy", "workbuddy"} {
		p := provider
		r.Post("/"+p+"/login", func(w http.ResponseWriter, r *http.Request) { h.startBuddyFlow(p, w, r) })
		r.Get("/"+p+"/status", h.buddyStatus(p))
		r.Post("/"+p+"/refresh", h.buddyRefresh(p))
		r.Post("/"+p+"/claim", h.buddyClaim(p))
		r.Get("/"+p+"/balance", h.buddyBalance(p))
	}
}

// startBuddyFlow begins the two-step login for one account (shared by both
// products).
func (h *Handler) startBuddyFlow(provider string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nickname string `json:"nickname"`
		loginOpenFields
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	id, credentialRef := corejethub.NewAccountID(provider)
	opt, err := h.prepareLoginOpen(req.loginOpenFields, id)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	nickname := firstNonEmptyStr(req.Nickname, id)
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: provider, Nickname: nickname,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	started, err := h.d.Manager.StartBuddyLogin(context.Background(), provider, id, func(u string) {
		h.d.Manager.OpenURLWithBrowser(u, opt)
	})
	if err != nil {
		_ = h.d.Manager.DeleteAccount(id)
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	sess := &corejethub.LoginSession{Started: started, Account: id, Manager: h.d.Manager}
	corejethub.RegisterLoginSession(loginID, sess)
	// Single-winner pump: settles the outcome, persists on success, deletes
	// the placeholder on failure. The status poll reads via SessionStatus.
	go corejethub.SettleAndCleanup(sess, nil) // flow persists via CompleteBuddyLogin
	apibase.WriteJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  started.LoginURL,
		"loginMode": "url",
	})
}

// buddyStatus GET — per-account login state snapshot (nickname/expiry/
// refreshable from the account entry; the flow poll uses /status?loginId=).
func (h *Handler) buddyStatus(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if loginID := r.URL.Query().Get("loginId"); loginID != "" {
			h.pollLogin(loginID, w, r)
			return
		}
		apibase.WriteJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts(provider)})
	}
}

// pollLogin is the shared login-flow poll (codearts + buddy products).
// pollLogin GET ?loginId= — UI status poll for an in-flight login flow.
// ⚠️ Passive reader: the login handler's pump goroutine (SettleAndCleanup)
// is the only consumer of the flow's Result channel; this handler reads the
// recorded outcome through SessionStatus. Polling the channel directly would
// race the pump for the single buffered outcome (one side would hang).
func (h *Handler) pollLogin(loginID string, w http.ResponseWriter, r *http.Request) {
	sess, ok := corejethub.PeekLoginSession(loginID)
	if !ok {
		// Not in the registry: settled and past the grace period (the pump
		// reaps late), or a bogus id. The UI treats 404 as "no transition" —
		// the settled outcome stays readable for loginSessionGracePeriod
		// after the flow ends, so a live poll always sees done:true first.
		apibase.WriteJSON(w, http.StatusNotFound, map[string]any{"error": "unknown or settled loginId"})
		return
	}
	done, success, errMsg := corejethub.SessionStatus(sess)
	if !done {
		acc, _ := h.d.Manager.FindAccount(sess.Account)
		apibase.WriteJSON(w, http.StatusOK, map[string]any{"done": false, "accountId": sess.Account, "nickname": acc.Nickname})
		return
	}
	if !success {
		apibase.WriteJSON(w, http.StatusOK, map[string]any{"done": true, "success": false, "error": errMsg})
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"done": true, "success": true, "accountId": sess.Account})
}

// buddyRefresh POST — silent renewal of one account credential.
func (h *Handler) buddyRefresh(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			AccountID string `json:"accountId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
			apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
			return
		}
		if err := h.d.Manager.RefreshBuddyAccount(r.Context(), provider, req.AccountID); err != nil {
			apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
			return
		}
		apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// buddyClaim POST — daily check-in claim for one account.
func (h *Handler) buddyClaim(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			AccountID string `json:"accountId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
			apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
			return
		}
		outcome, err := h.d.Manager.ClaimBuddyDaily(r.Context(), provider, req.AccountID)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
			return
		}
		apibase.WriteJSON(w, http.StatusOK, map[string]any{"outcome": outcome})
	}
}

// buddyBalance GET — credit balance for one account.
//
// ⚠️ `windowDays` 与 `balance` **并列**回传（ref RpcCreditsBalancesResponse 同
// 形状）：面板据此把资源包分成「长期 / 临时」两桶 —— 距扣费截止不足该天数的算
// 临时（再不用就作废，优先消耗）。窗口必须由后端给出，前端不得写死。
func (h *Handler) buddyBalance(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID := r.URL.Query().Get("accountId")
		balance, err := h.d.Manager.BuddyBalance(r.Context(), provider, accountID)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
			return
		}
		apibase.WriteJSON(w, http.StatusOK, map[string]any{
			"balance":    balance,
			"windowDays": corejethub.ExpiringWindowDays(),
		})
	}
}

func firstNonEmptyStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
