package jethub

// ZCode（智谱 z.ai 免费额度通道）管理端点。
//
//	POST /api/jethub/zcode/login      CLI 设备授权流（返回 loginId + 授权 URL，后台轮询）
//	GET  /api/jethub/zcode/status     ?loginId= 轮询登录；否则账号快照
//	POST /api/jethub/zcode/import     导入官方客户端本机凭据（零操作可用路径）
//	POST /api/jethub/zcode/refresh    重读该账号自己的凭据（对账；ZCode 无续期）
//	GET  /api/jethub/zcode/balance    ?accountId= 逐模型 token 额度桶
//	POST /api/jethub/zcode/claim      领取每日活动（captcha 走本地载体页）
//
// 公开路由（鉴权组之外，浏览器直接打开）：
//
//	GET  /api/jethub/zcode/carrier            ?token= 一次性载体页（跑阿里云无感验证）
//	POST /api/jethub/zcode/carrier/contribute ?token= 回传 param

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// RegisterZcode mounts the zcode routes (protected group).
func (h *Handler) RegisterZcode(r chi.Router) {
	r.Post("/zcode/login", h.zcodeLogin)
	r.Get("/zcode/status", h.zcodeStatus)
	r.Post("/zcode/import", h.zcodeImport)
	r.Post("/zcode/refresh", h.zcodeRefresh)
	r.Get("/zcode/balance", h.zcodeBalance)
	r.Post("/zcode/claim", h.zcodeClaim)
}

// RegisterPublicZcodeCarrier mounts the captcha carrier routes (public: the
// page is opened in the system browser, which may carry no management cookie).
// 访问控制是 token（128 位随机、一次性）；响应不含任何凭据。
func (h *Handler) RegisterPublicZcodeCarrier(r chi.Router) {
	r.Get("/jethub/zcode/carrier", h.zcodeCarrierPage)
	r.Post("/jethub/zcode/carrier/contribute", h.zcodeCarrierContribute)
}

// zcodeLogin POST — CLI 设备授权流：立刻拿到 authorize_url（后台轮询到 ready）。
func (h *Handler) zcodeLogin(w http.ResponseWriter, r *http.Request) {
	sel := decodeLoginOpen(r)
	id, credentialRef := corejethub.NewAccountID("zcode")
	opt, err := h.prepareLoginOpen(sel, id)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	flow, err := h.d.Manager.StartZcodeLogin(r.Context())
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: "zcode", Nickname: id,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	resultCh := make(chan corejethub.LoginOutcome, 1)
	started := corejethub.NewStartedLoginWithChannel(flow.AuthorizeURL, resultCh)
	sess := &corejethub.LoginSession{Started: started, Account: id, Manager: h.d.Manager}
	corejethub.RegisterLoginSession(loginID, sess)
	// 自动打开授权页（对话框里的链接是兜底）。
	h.d.Manager.OpenURLWithBrowser(flow.AuthorizeURL, opt)
	// ⚠️ 后台 context：轮询必须活过这个 handler（请求 context 在响应写完即取消，
	// 绑上去会让每次登录在用户还没打开授权页时就中止 —— minimax 的同款注释）。
	go func() {
		result, err := h.d.Manager.RunZcodeLogin(context.Background(), flow, 5*time.Minute)
		if err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		cred, err := h.d.Manager.CompleteZcodeLogin(id, result)
		if err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		credJSON, _ := json.Marshal(cred)
		// 凭据静态：expiresAt=0、refreshable=false。
		corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{CredentialJSON: credJSON})
	}()
	go corejethub.SettleAndCleanup(sess, nil)
	apibase.WriteJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  started.LoginURL,
		"loginMode": "url",
	})
}

// zcodeStatus GET — flow poll via loginId, or account snapshot.
func (h *Handler) zcodeStatus(w http.ResponseWriter, r *http.Request) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("zcode")})
}

// zcodeImport POST — 导入官方客户端本机凭据（装了官方客户端并登录过的机器零操作可用）。
func (h *Handler) zcodeImport(w http.ResponseWriter, r *http.Request) {
	id, cred, err := h.d.Manager.ZcodeImportLocalAccount()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if id == "" {
		apibase.WriteJSON(w, http.StatusOK, map[string]any{
			"ok": false,
			"reason": "未找到官方 ZCode 客户端的凭据（~/.zcode/v2/credentials.json + telemetry-state.json）；" +
				"请用「登录」按钮走设备授权流。",
		})
		return
	}
	label := ""
	if cred != nil {
		label = cred.AccountLabel
	}
	apibase.WriteJSON(w, http.StatusCreated, map[string]any{"ok": true, "accountId": id, "label": label})
}

// zcodeRefresh POST — 重读该账号自己的凭据（无续期；见 Manager 的注释）。
func (h *Handler) zcodeRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.ZcodeRefreshAccount(req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// zcodeBalance GET — per-model token buckets.
func (h *Handler) zcodeBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	if accountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	balance, err := h.d.Manager.ZcodeBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	// 映射到 provider 无关的 CreditBalance（前端的通用额度单元格）。
	// ⚠️ 单位是 **token**（上游 unit_type），界面按 M 量级显示 —— 显示成裸数字
	// 会被当成积分（ref 的用户报障原话）。
	out := corejethub.CreditBalance{Total: balance.Remaining, IsCredit: false}
	for _, bucket := range balance.Buckets {
		remaining := bucket.RemainingUnits
		if bucket.HasAvailable {
			remaining = bucket.AvailableUnits
		}
		out.Packages = append(out.Packages, corejethub.CreditPackage{
			Name:      bucket.ShowName,
			Unit:      bucket.UnitType,
			Remaining: remaining,
			Total:     bucket.TotalUnits,
			Used:      bucket.UsedUnits,
			Active:    remaining > 0,
		})
	}
	if balance.Enterprise {
		out.Detail = map[string]any{"enterprise": true}
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"balance": out, "expiresAt": balance.ExpiresAt})
}

// zcodeClaim POST — 领取每日活动（captcha 载体页在系统浏览器里打开）。
func (h *Handler) zcodeClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	carrier := func(token string) string {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		return fmt.Sprintf("%s://%s/api/jethub/zcode/carrier?token=%s", scheme, r.Host, url.QueryEscape(token))
	}
	report, err := h.d.Manager.ZcodeClaimDaily(r.Context(), req.AccountID, carrier)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	// 映射到通用 ClaimOutcome（前端的领取结果渲染）。
	outcome := corejethub.ClaimOutcome{Kind: "inactive", Message: report.Message}
	var claimed, failed int
	var messages []string
	for _, plan := range report.Plans {
		switch {
		case plan.OK:
			claimed++
			if plan.Message != "" {
				messages = append(messages, plan.Message)
			}
		default:
			failed++
			messages = append(messages, plan.Message)
		}
	}
	switch {
	case claimed > 0 && failed == 0:
		outcome.Kind = "claimed"
	case claimed > 0:
		outcome.Kind = "claimed"
	case failed > 0:
		outcome.Kind = "failed"
	}
	if len(messages) > 0 {
		outcome.Message = strings.Join(messages, "；")
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"outcome": outcome, "report": report})
}

// zcodeCarrierPage GET ?token= — the one-shot captcha carrier page.
func (h *Handler) zcodeCarrierPage(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "carrier session not found or expired", http.StatusNotFound)
		return
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	contributeURL := fmt.Sprintf("%s://%s/api/jethub/zcode/carrier/contribute", scheme, r.Host)
	page, ok := h.d.Manager.ZcodeCarrierPage(token, contributeURL)
	if !ok {
		http.Error(w, "carrier session not found or expired", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(page))
}

// zcodeCarrierContribute POST ?token= — the page hands the param back.
func (h *Handler) zcodeCarrierContribute(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	var req struct {
		Param string `json:"param"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Param == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "param required")
		return
	}
	if err := corejethub.DeliverZcodeCaptchaParam(token, req.Param); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}
