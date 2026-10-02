// Package webhub provides the Web Hub management API endpoints under
// /api/webhub: site list, live status, opening a site for login, call-prefix
// bridging, and the readiness probe.
//
// There are NO public endpoints (unlike jethub): webhub has no login page of
// its own — the user signs in themselves, in their own browser.
package webhub

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corewebhub "github.com/tinylab/tinylab/internal/webhub"
)

// Deps bundles the manager + bridge the handlers operate on.
type Deps struct {
	Manager *corewebhub.Manager
	Bridge  *corewebhub.Bridge
}

// Handler serves the /api/webhub routes.
type Handler struct {
	d *Deps
}

// NewHandler creates the webhub API handler.
func NewHandler(d *Deps) *Handler { return &Handler{d: d} }

// Register mounts the webhub routes onto the protected /api group.
//
// ⚠️ 路由形状必须与前端同形（jethub 缺陷 6/14 是同一坑复发两次）：
// 站点段一律在 `sites/{site}` 之下，不带 `sites/` 的旧形状一律 404。
func (h *Handler) Register(r chi.Router) {
	r.Route("/webhub", func(r chi.Router) {
		r.Get("/sites", h.listSites)
		r.Get("/sites/{site}/status", h.siteStatus)
		r.Post("/sites/{site}/open", h.openSite)
		r.Put("/sites/{site}/prefix", h.setPrefix)
		r.Delete("/sites/{site}/prefix", h.clearPrefix)
		r.Post("/sites/{site}/probe", h.probeSite)
	})
}

// ready reports whether the wiring is present; a nil pair degrades to a 503
// with a JSON error (never a panic, never a chi plain-text 404).
func (h *Handler) ready(w http.ResponseWriter) bool {
	if h.d == nil || h.d.Manager == nil || h.d.Bridge == nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "webhub not available")
		return false
	}
	return true
}

// listSites GET /api/webhub/sites — every supported site with its live state.
func (h *Handler) listSites(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	sites := h.d.Manager.Sites(h.d.Bridge.Bridged)
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"sites": sites})
}

// siteStatus GET /api/webhub/sites/{site}/status — browser connectivity, tab
// attachment and the last successful probe (no site turn is consumed).
func (h *Handler) siteStatus(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	site := chi.URLParam(r, "site")
	if !corewebhub.SiteExists(site) {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown site "+site)
		return
	}
	connected, attached, tabURL := h.d.Manager.ResolveSite(site)
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"id":           corewebhub.NormalizeSite(site),
		"connected":    connected,
		"attached":     attached,
		"tabUrl":       tabURL,
		"lastOkMs":     h.d.Manager.LastOK(site),
		"prefix":       h.d.Manager.Prefix(site),
		"bridged":      h.d.Bridge.HasBridgedProvider(site),
		"browserError": h.d.Manager.BrowserError(),
	})
}

// openSite POST /api/webhub/sites/{site}/open — opens the site as a tab in
// the webhub browser (launching/attaching it if needed) so the user can sign
// in there. The system browser is useless for webhub: its profile is not the
// persistent webhub profile and it has no CDP endpoint to drive.
//
// ⚠️ 这是 webhub 唯一的「登录」入口，且它只是开个页面：本项目无法也不需要
// 编程式登录。登录态落在 webhub 持久 profile（{configDir}/webhub/profile）
// 里——一次登录，跨进程存活。
func (h *Handler) openSite(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	site := chi.URLParam(r, "site")
	if !corewebhub.SiteExists(site) {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown site "+site)
		return
	}
	url := corewebhub.SiteURL(site)
	if err := h.d.Manager.EnsureBrowser(); err != nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	if err := h.d.Manager.Sessions().OpenTab(r.Context(), url); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"url": url, "opened": true})
}

type prefixRequest struct {
	Prefix string `json:"prefix"`
}

// setPrefix PUT /api/webhub/sites/{site}/prefix — validate + persist + bridge.
// Conflict → 409 (the UI shows it inline).
func (h *Handler) setPrefix(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	site := chi.URLParam(r, "site")
	var req prefixRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if err := h.d.Bridge.SetPrefix(site, req.Prefix); err != nil {
		if _, ok := err.(*corewebhub.ConflictError); ok {
			apibase.WriteAPIError(w, http.StatusConflict, err.Error())
			return
		}
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"ok": true, "prefix": h.d.Manager.Prefix(site), "modelIds": h.d.Manager.ModelIDs(site),
	})
}

// clearPrefix DELETE /api/webhub/sites/{site}/prefix.
func (h *Handler) clearPrefix(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	site := chi.URLParam(r, "site")
	if err := h.d.Bridge.ClearPrefix(site); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// probeSite POST /api/webhub/sites/{site}/probe — sends a minimal message to
// verify the site is usable (costs one real site turn).
func (h *Handler) probeSite(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	site := chi.URLParam(r, "site")
	if !corewebhub.SiteExists(site) {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown site "+site)
		return
	}
	// ⚠️ 缺陷 24（2026-10-03）：不启动浏览器。检测是「消耗一次真实回复」的
	// 动作，浏览器必须已经由用户点「打开站点」拉起；否则直接报不可用，
	// 让 UI 提示先打开站点（而不是偷偷弹出 Chrome）。
	if h.d.Manager.Sessions().Endpoint() == "" {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, corewebhub.ErrNotConnected.Error())
		return
	}
	started := time.Now()
	res, err := h.d.Manager.ProbeDetail(site)
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":           err == nil && res.OK,
		"reply":        res.Reply,
		"error":        res.Error,
		"firstContent": res.FirstContentAfter.Milliseconds(),
		"elapsedMs":    time.Since(started).Milliseconds(),
	})
}
