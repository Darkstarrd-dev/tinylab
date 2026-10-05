package jethub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// newLoginOpenHandler mounts the real route table and hands back the handler so
// the internal helpers can be exercised directly.
func newLoginOpenHandler(t *testing.T) (*Handler, http.Handler) {
	t.Helper()
	m, err := corejethub.NewManager(t.TempDir(), "", nil)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	h := NewHandler(&Deps{Manager: m, Bridge: nil})
	r := chi.NewRouter()
	r.Route("/api", func(r chi.Router) { h.Register(r) })
	return h, r
}

func doJSON(t *testing.T, srv http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *strings.Reader
	if body == "" {
		rdr = strings.NewReader("")
	} else {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

// TestLoginBrowsersEndpointShape: the dialog's browser axis comes from one
// endpoint (installed browsers + OS default + session modes + last choice).
func TestLoginBrowsersEndpointShape(t *testing.T) {
	_, srv := newLoginOpenHandler(t)
	rec := doJSON(t, srv, http.MethodGet, "/api/jethub/login-browsers", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /jethub/login-browsers = %d (%s)", rec.Code, rec.Body.String())
	}
	var out struct {
		Browsers []struct {
			ID   string `json:"id"`
			Path string `json:"path"`
		} `json:"browsers"`
		DefaultBrowser struct {
			Path string `json:"path"`
		} `json:"defaultBrowser"`
		Sessions []string `json:"sessions"`
		Prefs    struct {
			Browser string `json:"browser"`
			Session string `json:"session"`
		} `json:"prefs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if len(out.Sessions) != 3 {
		t.Fatalf("the three session modes must be advertised, got %v", out.Sessions)
	}
	for _, id := range out.Sessions {
		if !corejethub.ValidSession(id) {
			t.Fatalf("unexpected session mode %q", id)
		}
	}
	for _, b := range out.Browsers {
		if b.ID == "" || b.Path == "" {
			t.Fatalf("a detected browser must carry id + path, got %+v", b)
		}
	}
}

// TestPrepareLoginOpenLegacyDefault: an old client posting `{}` (or a body with
// no selector) resolves to default browser + shared session — the behavior that
// existed before the feature — and does not write a preference.
func TestPrepareLoginOpenLegacyDefault(t *testing.T) {
	h, _ := newLoginOpenHandler(t)
	opt, err := h.prepareLoginOpen(loginOpenFields{}, "raccoon-1")
	if err != nil {
		t.Fatalf("the legacy default must validate: %v", err)
	}
	if opt.Browser != corejethub.BrowserDefault || opt.Session != corejethub.SessionShared {
		t.Fatalf("empty selection must normalize to default+shared, got %+v", opt)
	}
	if opt.AccountID != "raccoon-1" {
		t.Fatalf("the account id must be carried for the isolated profile, got %+v", opt)
	}
	if got := h.d.Manager.LoginOpenPrefs(); got != (corejethub.OpenOptions{}) {
		t.Fatalf("an unspecified selection must not be remembered, got %+v", got)
	}
}

// TestPrepareLoginOpenRemembersSelection: an explicit selection is validated and
// remembered (the next dialog pre-selects it).
func TestPrepareLoginOpenRemembersSelection(t *testing.T) {
	h, _ := newLoginOpenHandler(t)
	fake := filepath.Join(t.TempDir(), "chrome.exe")
	if err := os.WriteFile(fake, []byte("fake"), 0o600); err != nil {
		t.Fatal(err)
	}
	opt, err := h.prepareLoginOpen(loginOpenFields{
		Browser: corejethub.BrowserCustom, BrowserPath: fake, Session: corejethub.SessionIsolated,
	}, "qoder-7")
	if err != nil {
		t.Fatalf("a usable selection must validate: %v", err)
	}
	if opt.Session != corejethub.SessionIsolated || opt.BrowserPath != fake {
		t.Fatalf("unexpected resolved options: %+v", opt)
	}
	prefs := h.d.Manager.LoginOpenPrefs()
	if prefs.Browser != corejethub.BrowserCustom || prefs.BrowserPath != fake || prefs.Session != corejethub.SessionIsolated {
		t.Fatalf("the selection must be remembered, got %+v", prefs)
	}
	if prefs.AccountID != "" {
		t.Fatalf("the per-attempt account id must never be remembered, got %q", prefs.AccountID)
	}
}

// TestPrepareLoginOpenRejectsUnusable: an unusable selection is an error (the
// caller turns it into a 400 before creating anything).
func TestPrepareLoginOpenRejectsUnusable(t *testing.T) {
	h, _ := newLoginOpenHandler(t)
	if _, err := h.prepareLoginOpen(loginOpenFields{Browser: "nope-browser"}, "id"); err == nil {
		t.Fatal("an undetected browser must be rejected")
	}
	if _, err := h.prepareLoginOpen(loginOpenFields{Session: "bogus"}, "id"); err == nil {
		t.Fatal("an unknown session must be rejected")
	}
	if _, err := h.prepareLoginOpen(loginOpenFields{
		Browser: corejethub.BrowserCustom, BrowserPath: t.TempDir(), Session: corejethub.SessionShared,
	}, "id"); err == nil {
		t.Fatal("a directory as the browser must be rejected")
	}
}

// TestOpenLoginURLEndpointRejectsBadInput: every rejection happens before any
// process is spawned (so the test never opens a real window).
func TestOpenLoginURLEndpointRejectsBadInput(t *testing.T) {
	_, srv := newLoginOpenHandler(t)
	cases := []struct {
		name string
		body string
	}{
		{"no body", ``},
		{"missing url", `{"browser":"default"}`},
		{"bad scheme", `{"url":"file:///etc/passwd"}`},
		{"unknown browser", `{"url":"https://example.com","browser":"nope-browser"}`},
		{"unknown session", `{"url":"https://example.com","session":"bogus"}`},
		{"custom without path", `{"url":"https://example.com","browser":"custom"}`},
		{"custom missing file", `{"url":"https://example.com","browser":"custom","browserPath":"` + filepath.Join(t.TempDir(), "nope.exe") + `"}`},
		{"custom is a directory", `{"url":"https://example.com","browser":"custom","browserPath":"` + strings.ReplaceAll(t.TempDir(), `\`, `\\`) + `"}`},
	}
	for _, tc := range cases {
		rec := doJSON(t, srv, http.MethodPost, "/api/jethub/open-login-url", tc.body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: want 400, got %d (%s)", tc.name, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Header().Get("Content-Type"), "application/json") {
			t.Fatalf("%s: the UI needs a JSON error body, got %q", tc.name, rec.Header().Get("Content-Type"))
		}
	}
}

// TestLoginRejectsUnusableSelectionBeforeCreatingAccount: the placeholder must
// not exist when the selected browser cannot be launched — otherwise the user
// is left with a credential-less account and a dialog that never opens a page.
func TestLoginRejectsUnusableSelectionBeforeCreatingAccount(t *testing.T) {
	_, srv := newLoginOpenHandler(t)
	rec := doJSON(t, srv, http.MethodPost, "/api/jethub/raccoon/login", `{"browser":"nope-browser"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST /jethub/raccoon/login with an unusable browser = %d (%s)", rec.Code, rec.Body.String())
	}
	list := doJSON(t, srv, http.MethodGet, "/api/jethub/providers/raccoon/accounts", "")
	if list.Code != http.StatusOK {
		t.Fatalf("accounts list = %d", list.Code)
	}
	var out struct {
		Accounts []any `json:"accounts"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Accounts) != 0 {
		t.Fatalf("a rejected login must not leave a placeholder account, got %d", len(out.Accounts))
	}
}
