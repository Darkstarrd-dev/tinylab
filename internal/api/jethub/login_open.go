package jethub

import (
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/browserlaunch"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// 登录浏览器 / 会话模式（+新建账号 弹窗的选择）。
//
// 设计约束（见 internal/jethub/login_open.go 的文件注释与
// docs/jethub-architecture.md §3.9）：
//
//   - 选择随**每一次** login 请求携带（浏览器轴 × 会话轴），空值 = 记住的偏好
//     —— 因此老客户端 POST `{}` 的行为与改造前完全一致（默认浏览器 + 共享登录态）。
//   - **同步校验、异步打开**：开页失败不能拖垮登录流（弹窗保留手动链接兜底），
//     但不可用的选择（浏览器不存在、内核未知却要隐私窗口）必须在建号之前返回
//     4xx —— 否则用户看到的是「弹窗一直等待、浏览器什么都没开」。
//   - 选择成功后写回偏好文件，下次弹窗默认选中上次的选择。

// loginOpenFields are the optional browser/session selectors carried by every
// browser-login POST body (embedded in each provider's request struct).
type loginOpenFields struct {
	Browser     string `json:"browser"`
	BrowserPath string `json:"browserPath"`
	Session     string `json:"session"`
}

// options binds the selection to one login attempt: AccountID keys the
// dedicated profile dir of the "isolated" session mode.
func (f loginOpenFields) options(accountID string) corejethub.OpenOptions {
	return corejethub.OpenOptions{
		Browser:     f.Browser,
		BrowserPath: f.BrowserPath,
		Session:     f.Session,
		AccountID:   accountID,
	}
}

// specified reports whether the client sent an explicit selection (as opposed to
// the zero value an old client / `{}` body produces).
func (f loginOpenFields) specified() bool {
	return f.Browser != "" || f.BrowserPath != "" || f.Session != ""
}

// decodeLoginOpen reads the selection from a body the handler does not otherwise
// consume (a missing body or `{}` is the normal case and is not an error).
func decodeLoginOpen(r *http.Request) loginOpenFields {
	var f loginOpenFields
	if r == nil || r.Body == nil {
		return f
	}
	_ = json.NewDecoder(r.Body).Decode(&f)
	return f
}

// prepareLoginOpen validates the selection and remembers it. Validation is
// synchronous on purpose (see the file comment); remembering is best-effort
// (a preference write failure must not fail a login).
func (h *Handler) prepareLoginOpen(f loginOpenFields, accountID string) (corejethub.OpenOptions, error) {
	opt, err := h.d.Manager.ValidateOpenOptions(f.options(accountID))
	if err != nil {
		return opt, err
	}
	if f.specified() {
		_ = h.d.Manager.SetLoginOpenPrefs(f.options(""))
	}
	return opt, nil
}

// loginBrowserDTO is one row of the browser axis.
type loginBrowserDTO struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Family      string `json:"family"`
	Path        string `json:"path"`
	PrivateOK   bool   `json:"privateOk"`
	PrivateFlag string `json:"privateFlag,omitempty"`
	ProfileOK   bool   `json:"profileOk"`
}

// defaultBrowserDTO describes the OS default browser (empty path = unresolvable
// ⇒ the dialog cannot offer "current browser + private session").
type defaultBrowserDTO struct {
	Path        string `json:"path,omitempty"`
	Label       string `json:"label,omitempty"`
	Family      string `json:"family,omitempty"`
	PrivateOK   bool   `json:"privateOk"`
	PrivateFlag string `json:"privateFlag,omitempty"`
}

// loginBrowsers GET /api/jethub/login-browsers — the browser axis of the
// +新建账号 dialog: what is installed, what the OS default is, which session
// modes exist and what the user picked last time.
func (h *Handler) loginBrowsers(w http.ResponseWriter, r *http.Request) {
	detected := browserlaunch.Detect()
	rows := make([]loginBrowserDTO, 0, len(detected))
	for _, b := range detected {
		rows = append(rows, loginBrowserDTO{
			ID: b.ID, Label: b.Label, Family: b.Family, Path: b.Path,
			PrivateOK: b.PrivateOK, PrivateFlag: b.PrivateFlag, ProfileOK: b.ProfileOK,
		})
	}
	def := browserlaunch.DefaultBrowser()
	prefs := h.d.Manager.LoginOpenPrefs()
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"browsers": rows,
		"defaultBrowser": defaultBrowserDTO{
			Path: def.Path, Label: def.Label, Family: string(def.Family),
			PrivateOK: def.PrivateOK, PrivateFlag: def.PrivateFlag,
		},
		"sessions": []string{
			corejethub.SessionShared, corejethub.SessionPrivate, corejethub.SessionIsolated,
		},
		"prefs": map[string]any{
			"browser":     prefs.Browser,
			"browserPath": prefs.BrowserPath,
			"session":     prefs.Session,
		},
	})
}

// openLoginURL POST /api/jethub/open-login-url {url, browser, browserPath,
// session} — re-open a login page with an explicit selection (the dialog's
// "重新打开登录页" button; the server-side auto-open already ran at login time).
//
// Unlike the login-time auto-open this call is synchronous: the user asked for
// exactly this page in exactly this browser, so a failure must be reported (and
// not swallowed into a log line).
func (h *Handler) openLoginURL(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
		loginOpenFields
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "url required")
		return
	}
	parsed, err := url.Parse(req.URL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid url scheme")
		return
	}
	opt, err := h.prepareLoginOpen(req.loginOpenFields, "")
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.d.Manager.OpenLoginURL(req.URL, opt); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}
