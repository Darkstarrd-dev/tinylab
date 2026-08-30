package editor

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/owner"
	"github.com/tinyrouter/tinyrouter/internal/pathgrant"
	"github.com/tinyrouter/tinyrouter/internal/registry"
)

// newTestHandler builds a Handler whose docDir is a fresh temp directory.
func newTestHandler(t *testing.T) (*Handler, string) {
	t.Helper()
	docDir := t.TempDir()
	cfg := config.DefaultConfig()
	cfg.DocDir = docDir
	h := NewHandler(&apibase.Deps{Reg: registry.New(cfg), ConfigPath: filepath.Join(t.TempDir(), "config.yaml")})
	return h, docDir
}

// stampOwner runs req through the owner middleware and returns the stamped
// request (the middleware also writes the owner cookie to rec).
func stampOwner(t *testing.T, req *http.Request) *http.Request {
	t.Helper()
	var stamped *http.Request
	mw := owner.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stamped = r
	}))
	mw.ServeHTTP(httptest.NewRecorder(), req)
	if stamped == nil {
		t.Fatal("owner middleware did not stamp the request")
	}
	return stamped
}

// doJSON runs one request through a fresh owner session.
func doJSON(t *testing.T, h *Handler, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	req := buildRequest(t, method, target, body)
	return doJSONReq(t, h, stampOwner(t, req))
}

// doJSONCtx is doJSON but reusing an already-stamped owner context, so grant
// lookups stay within one browser session.
func doJSONCtx(t *testing.T, h *Handler, method, target string, body any, stamped *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	req := buildRequest(t, method, target, body)
	return doJSONReq(t, h, req.WithContext(stamped.Context()))
}

func buildRequest(t *testing.T, method, target string, body any) *http.Request {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	req.Header.Set("Content-Type", "application/json")
	return req
}

func doJSONReq(t *testing.T, h *Handler, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.serve(rec, req)
	return rec
}

// serve routes one request through the handler's chi-like mux.
func (h *Handler) serve(w http.ResponseWriter, r *http.Request) {
	h.dummyMux().ServeHTTP(w, r)
}

// dummyMux is a minimal router implementing the editor's chiRouter surface.
func (h *Handler) dummyMux() *tinyMux {
	m := &tinyMux{}
	h.Register(m)
	return m
}

type route struct {
	method  string
	pattern string
	handler http.HandlerFunc
}

type tinyMux struct {
	routes []route
}

func (m *tinyMux) Use(_ ...func(http.Handler) http.Handler) {}

func (m *tinyMux) Get(pattern string, h http.HandlerFunc) {
	m.routes = append(m.routes, route{"GET", pattern, h})
}

func (m *tinyMux) Post(pattern string, h http.HandlerFunc) {
	m.routes = append(m.routes, route{"POST", pattern, h})
}

func (m *tinyMux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	for _, rt := range m.routes {
		if rt.method == r.Method && matchPattern(rt.pattern, r.URL.Path) {
			rt.handler(w, r)
			return
		}
	}
	http.NotFound(w, r)
}

func matchPattern(pattern, path string) bool {
	if pattern == path {
		return true
	}
	if strings.HasSuffix(pattern, "*") {
		prefix := strings.TrimSuffix(pattern, "*")
		return strings.HasPrefix(path, prefix)
	}
	return false
}

func TestEditorTree_NoAbsolutePaths(t *testing.T) {
	h, docDir := newTestHandler(t)
	if err := os.MkdirAll(filepath.Join(docDir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(docDir, "sub", "a.md"), []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := doJSON(t, h, http.MethodGet, "/tree", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var result struct {
		Files []DocFileItem `json:"files"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Files) != 2 {
		t.Fatalf("files = %+v, want dir + file", result.Files)
	}
	var fileItem *DocFileItem
	for i := range result.Files {
		if result.Files[i].FileID == "sub/a.md" {
			fileItem = &result.Files[i]
		}
	}
	if fileItem == nil || fileItem.Name != "a.md" || fileItem.Size != 2 {
		t.Fatalf("file node missing or wrong: %+v", result.Files)
	}
	body := rec.Body.String()
	if strings.Contains(body, docDir) || strings.Contains(body, "C:") {
		t.Fatalf("tree response leaks absolute paths: %s", body)
	}
}

func TestEditorOpenSaveDelete_FileID(t *testing.T) {
	h, docDir := newTestHandler(t)

	// Save via fileId (new file inside docDir).
	rec := doJSON(t, h, http.MethodPost, "/save", map[string]any{"fileId": "notes/hello.md", "content": "hello world"})
	if rec.Code != http.StatusOK {
		t.Fatalf("save status = %d, body = %s", rec.Code, rec.Body.String())
	}
	saved := filepath.Join(docDir, "notes", "hello.md")
	if _, err := os.Stat(saved); err != nil {
		t.Fatalf("saved file missing: %v", err)
	}

	// Open via fileId.
	rec = doJSON(t, h, http.MethodPost, "/open", map[string]any{"fileId": "notes/hello.md"})
	if rec.Code != http.StatusOK {
		t.Fatalf("open status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var opened map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &opened); err != nil {
		t.Fatal(err)
	}
	if opened["content"] != "hello world" || opened["fileId"] != "notes/hello.md" {
		t.Fatalf("open result = %+v", opened)
	}

	// Delete via fileId.
	rec = doJSON(t, h, http.MethodPost, "/delete", map[string]any{"fileId": "notes/hello.md"})
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(saved); !os.IsNotExist(err) {
		t.Fatalf("deleted file still exists")
	}
}

func TestEditorRenameFileID_PhysicalAndAtomic(t *testing.T) {
	h, docDir := newTestHandler(t)
	oldPath := filepath.Join(docDir, "notes", "old.md")
	if err := os.MkdirAll(filepath.Dir(oldPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(oldPath, []byte("keep unsaved content"), 0o600); err != nil {
		t.Fatal(err)
	}

	rec := doJSON(t, h, http.MethodPost, "/rename", map[string]any{"fileId": "notes/old.md", "newName": "renamed.md"})
	if rec.Code != http.StatusOK {
		t.Fatalf("rename status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result["fileId"] != "notes/renamed.md" || result["name"] != "renamed.md" {
		t.Fatalf("rename result = %+v", result)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("old file still exists: %v", err)
	}
	newPath := filepath.Join(docDir, "notes", "renamed.md")
	content, err := os.ReadFile(newPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "keep unsaved content" {
		t.Fatalf("renamed content = %q", content)
	}
	rec = doJSON(t, h, http.MethodPost, "/save", map[string]any{"fileId": "notes/renamed.md", "content": "saved after rename"})
	if rec.Code != http.StatusOK {
		t.Fatalf("save after rename status = %d, body = %s", rec.Code, rec.Body.String())
	}
	content, err = os.ReadFile(newPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "saved after rename" {
		t.Fatalf("saved renamed content = %q", content)
	}

	rec = doJSON(t, h, http.MethodPost, "/rename", map[string]any{"fileId": "notes/renamed.md", "newName": "other.md"})
	if rec.Code != http.StatusOK {
		t.Fatalf("second rename status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestEditorRenameFileID_RejectsConflictAndUnsafeName(t *testing.T) {
	h, docDir := newTestHandler(t)
	for _, name := range []string{"a.md", "b.md"} {
		if err := os.WriteFile(filepath.Join(docDir, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	rec := doJSON(t, h, http.MethodPost, "/rename", map[string]any{"fileId": "a.md", "newName": "b.md"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d, want 409", rec.Code)
	}
	for _, name := range []string{"../escape.md", "nested/name.md", "bad?.md", "trailing."} {
		rec = doJSON(t, h, http.MethodPost, "/rename", map[string]any{"fileId": "a.md", "newName": name})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("unsafe name %q: status = %d, want 400", name, rec.Code)
		}
	}
	rec = doJSON(t, h, http.MethodPost, "/rename", map[string]any{"path": "/etc/passwd", "newName": "renamed.md"})
	if rec.Code != http.StatusGone {
		t.Fatalf("rename path: status = %d, want 410", rec.Code)
	}
}

func TestEditorRenameGrant_RebindsPhysicalPath(t *testing.T) {
	h, _ := newTestHandler(t)
	outside := filepath.Join(t.TempDir(), "external.md")
	if err := os.WriteFile(outside, []byte("external"), 0o600); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/rename", bytes.NewReader(nil))
	stamped := stampOwner(t, req)
	ownerID := owner.From(stamped.Context())
	g, err := h.grants.Grant(ownerID, []pathgrant.Operation{pathgrant.OpRead, pathgrant.OpWrite}, outside, false, false)
	if err != nil {
		t.Fatal(err)
	}

	rec := doJSONCtx(t, h, http.MethodPost, "/rename", map[string]any{"pathGrantId": g.ID, "newName": "renamed.md"}, stamped)
	if rec.Code != http.StatusOK {
		t.Fatalf("grant rename status = %d, body = %s", rec.Code, rec.Body.String())
	}
	newPath := filepath.Join(filepath.Dir(outside), "renamed.md")
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("grant old file still exists: %v", err)
	}
	if _, err := os.Stat(newPath); err != nil {
		t.Fatalf("grant renamed file missing: %v", err)
	}
	rec = doJSONCtx(t, h, http.MethodPost, "/save", map[string]any{"pathGrantId": g.ID, "content": "updated"}, stamped)
	if rec.Code != http.StatusOK {
		t.Fatalf("save after grant rename status = %d, body = %s", rec.Code, rec.Body.String())
	}
	content, err := os.ReadFile(newPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "updated" {
		t.Fatalf("grant renamed content = %q", content)
	}
}

func TestEditorRenameGrantTakesPrecedenceOverFileID(t *testing.T) {
	h, docDir := newTestHandler(t)
	selected := filepath.Join(docDir, "selected.md")
	other := filepath.Join(docDir, "other.md")
	if err := os.WriteFile(selected, []byte("selected"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(other, []byte("other"), 0o600); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/rename", bytes.NewReader(nil))
	stamped := stampOwner(t, req)
	ownerID := owner.From(stamped.Context())
	g, err := h.grants.Grant(ownerID, []pathgrant.Operation{pathgrant.OpRead, pathgrant.OpWrite}, selected, false, false)
	if err != nil {
		t.Fatal(err)
	}
	rec := doJSONCtx(t, h, http.MethodPost, "/rename", map[string]any{
		"fileId":      "other.md",
		"pathGrantId": g.ID,
		"newName":     "selected-renamed.md",
	}, stamped)
	if rec.Code != http.StatusOK {
		t.Fatalf("mixed identity rename status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(docDir, "selected-renamed.md")); err != nil {
		t.Fatalf("grant target was not renamed: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("fileId target was unexpectedly changed: %v", err)
	}
}

func TestEditorRejectsTraversalFileIDs(t *testing.T) {
	h, docDir := newTestHandler(t)
	secret := filepath.Join(filepath.Dir(docDir), "secret.txt")
	if err := os.WriteFile(secret, []byte("top-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	attacks := []string{
		"../secret.txt",
		"..\\secret.txt",
		"../../secret.txt",
		"/etc/passwd",
		"\\etc\\passwd",
		"C:/Windows/win.ini",
		"C:\\Windows\\win.ini",
		"\\\\server\\share\\x",
		"sub/../../secret.txt",
		"a/..",
	}
	for _, attack := range attacks {
		rec := doJSON(t, h, http.MethodPost, "/open", map[string]any{"fileId": attack})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("open fileId %q: status = %d, want 400; body = %s", attack, rec.Code, rec.Body.String())
		}
		rec = doJSON(t, h, http.MethodPost, "/save", map[string]any{"fileId": attack, "content": "x"})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("save fileId %q: status = %d, want 400", attack, rec.Code)
		}
		rec = doJSON(t, h, http.MethodPost, "/delete", map[string]any{"fileId": attack})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("delete fileId %q: status = %d, want 400", attack, rec.Code)
		}
	}
}

func TestEditorRejectsLegacyRawPaths(t *testing.T) {
	h, _ := newTestHandler(t)
	rec := doJSON(t, h, http.MethodPost, "/open", map[string]any{"path": "C:\\Users\\evil\\secret.txt"})
	if rec.Code != http.StatusGone {
		t.Fatalf("open path: status = %d, want 410", rec.Code)
	}
	rec = doJSON(t, h, http.MethodPost, "/save", map[string]any{"path": "/etc/passwd", "content": "x"})
	if rec.Code != http.StatusGone {
		t.Fatalf("save path: status = %d, want 410", rec.Code)
	}
	rec = doJSON(t, h, http.MethodPost, "/delete", map[string]any{"path": "/etc/passwd"})
	if rec.Code != http.StatusGone {
		t.Fatalf("delete path: status = %d, want 410", rec.Code)
	}
}

func TestEditorServeImage_Containment(t *testing.T) {
	h, docDir := newTestHandler(t)
	imgs := filepath.Join(docDir, "imgs")
	if err := os.MkdirAll(imgs, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(imgs, "a.webp"), []byte("img"), 0o600); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(filepath.Dir(docDir), "secret.txt")
	if err := os.WriteFile(secret, []byte("top-secret"), 0o600); err != nil {
		t.Fatal(err)
	}

	rec := doJSON(t, h, http.MethodGet, "/image?path=./imgs/a.webp", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("serve image: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	for _, attack := range []string{"../secret.txt", "../../config.yaml", "C:/Windows/win.ini", "\\\\srv\\x"} {
		rec = doJSON(t, h, http.MethodGet, "/image?path="+attack, nil)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("image path %q: status = %d, want 400", attack, rec.Code)
		}
	}
}

func TestEditorOpenSaveViaGrant(t *testing.T) {
	h, _ := newTestHandler(t)
	outside := filepath.Join(t.TempDir(), "external.md")
	if err := os.WriteFile(outside, []byte("external content"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Register a read+write grant under the stamped owner.
	req := httptest.NewRequest(http.MethodPost, "/open", bytes.NewReader(nil))
	stamped := stampOwner(t, req)
	ownerID := owner.From(stamped.Context())
	g, err := h.grants.Grant(ownerID, []pathgrant.Operation{pathgrant.OpRead, pathgrant.OpWrite}, outside, false, false)
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}

	// Open via the grant, reusing the stamped owner session.
	rec := doJSONCtx(t, h, http.MethodPost, "/open", map[string]any{"pathGrantId": g.ID}, stamped)
	if rec.Code != http.StatusOK {
		t.Fatalf("grant open: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var opened map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &opened); err != nil {
		t.Fatal(err)
	}
	if opened["content"] != "external content" {
		t.Fatalf("grant open content = %+v", opened)
	}

	// Save back through the grant.
	rec = doJSONCtx(t, h, http.MethodPost, "/save", map[string]any{"pathGrantId": g.ID, "content": "updated"}, stamped)
	if rec.Code != http.StatusOK {
		t.Fatalf("grant save: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	b, err := os.ReadFile(outside)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "updated" {
		t.Fatalf("grant save wrote %q", b)
	}
}

func TestEditorForeignGrantDenied(t *testing.T) {
	h, _ := newTestHandler(t)
	outside := filepath.Join(t.TempDir(), "foreign.md")
	if err := os.WriteFile(outside, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Grant owned by a DIFFERENT owner than the request.
	g, err := h.grants.Grant("someone-else", []pathgrant.Operation{pathgrant.OpRead}, outside, false, false)
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}
	rec := doJSON(t, h, http.MethodPost, "/open", map[string]any{"pathGrantId": g.ID})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("foreign grant open: status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}

func TestEditorGamesRoot_TreeAndSaveAndOpenAndDelete(t *testing.T) {
	// Use non-standard ConfigPath so gamesDir/docDir are siblings under distinct parents.
	configDir := t.TempDir()
	docDir := filepath.Join(configDir, "docs")
	gamesDir := filepath.Join(configDir, "games")
	_ = os.MkdirAll(docDir, 0o755)
	_ = os.MkdirAll(filepath.Join(gamesDir, "proj1"), 0o755)
	cfg := config.DefaultConfig()
	cfg.DocDir = docDir
	cfg.GamesDir = gamesDir
	h := NewHandler(&apibase.Deps{Reg: registry.New(cfg), ConfigPath: filepath.Join(configDir, "config.yaml")})

	// Tree without root lists docDir (no games leak).
	if err := os.WriteFile(filepath.Join(docDir, "hello.md"), []byte("# doc"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gamesDir, "proj1", "game.json"), []byte(`{"id":"proj1"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := doJSON(t, h, http.MethodGet, "/tree", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("doc tree status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var tree map[string][]DocFileItem
	if err := json.Unmarshal(rec.Body.Bytes(), &tree); err != nil {
		t.Fatal(err)
	}
	for _, f := range tree["files"] {
		if strings.HasPrefix(f.FileID, "proj1") {
			t.Fatalf("default tree leaked games file %q", f.FileID)
		}
	}
	// ?root=games lists games dir.
	rec = doJSON(t, h, http.MethodGet, "/tree?root=games", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("games tree status = %d, body = %s", rec.Code, rec.Body.String())
	}
	tree = nil
	if err := json.Unmarshal(rec.Body.Bytes(), &tree); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range tree["files"] {
		if f.FileID == "proj1/game.json" {
			found = true
		}
		if strings.HasPrefix(f.FileID, "hello.md") {
			t.Fatalf("games tree leaked doc file %q", f.FileID)
		}
	}
	if !found {
		t.Fatalf("games tree missing proj1/game.json, got: %s", rec.Body.String())
	}
	// Save into games via root=games creates the project dir.
	rec = doJSON(t, h, http.MethodPost, "/save?root=games", map[string]any{"fileId": "newgame/game.json", "content": `{"id":"newgame"}`})
	if rec.Code != http.StatusOK {
		t.Fatalf("games save status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if b, err := os.ReadFile(filepath.Join(gamesDir, "newgame", "game.json")); err != nil || string(b) != `{"id":"newgame"}` {
		t.Fatalf("games save wrote %q err %v", string(b), err)
	}
	// Open from games via root=games.
	rec = doJSON(t, h, http.MethodPost, "/open?root=games", map[string]any{"fileId": "proj1/game.json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("games open status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var opened map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &opened); err != nil {
		t.Fatal(err)
	}
	if opened["fileId"] != "proj1/game.json" || !strings.Contains(opened["content"].(string), "proj1") {
		t.Fatalf("games open got %s", rec.Body.String())
	}
	// Directory delete requires games root and only top-level dirs.
	// Create a two-level nested dir newgame/nested and attempt to delete newgame/nested as dir → 400.
	nested := filepath.Join(gamesDir, "newgame", "nested")
	_ = os.MkdirAll(nested, 0o755)
	if err := os.WriteFile(filepath.Join(nested, "a.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec = doJSON(t, h, http.MethodPost, "/delete?root=games", map[string]any{"fileId": "newgame/nested"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("delete nested dir status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	// Delete top-level newgame dir via fileId → recursive remove-all.
	rec = doJSON(t, h, http.MethodPost, "/delete?root=games", map[string]any{"fileId": "newgame"})
	if rec.Code != http.StatusOK {
		t.Fatalf("delete top-level dir status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(gamesDir, "newgame")); !os.IsNotExist(err) {
		t.Fatalf("newgame dir still exists after delete: %v", err)
	}
	// Directory delete without root=games → 400 (docDir regression: directories are not deletable via fileId).
	dtop := filepath.Join(docDir, "dtop")
	_ = os.MkdirAll(dtop, 0o755)
	if err := os.WriteFile(filepath.Join(dtop, "x.txt"), []byte("y"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec = doJSON(t, h, http.MethodPost, "/delete", map[string]any{"fileId": "dtop"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("delete dtop without root status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(dtop); err != nil {
		t.Fatalf("dtop should still exist after rejected delete: %v", err)
	}
	// Escape rejected on games root too.
	rec = doJSON(t, h, http.MethodPost, "/save?root=games", map[string]any{"fileId": "../evil.js", "content": "bad"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("games save traversal status = %d, want 400", rec.Code)
	}
}
