package gallery

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/owner"
	"github.com/tinylab/tinylab/internal/pathgrant"
)

// testOwner is one fixed owner identity shared by every request in a test:
// the owner middleware accepts any well-formed owner cookie (the value is an
// opaque capability), so a single test session keeps one owner and its grants
// stay visible across requests (F-29 session model).
const testOwner = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// ownerTransport injects the configured owner cookie on every request; a zero
// value falls back to testOwner so existing helpers keep working unchanged.
type ownerTransport struct{ owner string }

func (t ownerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	ownerVal := t.owner
	if ownerVal == "" {
		ownerVal = testOwner
	}
	req = req.Clone(req.Context())
	req.AddCookie(&http.Cookie{Name: owner.CookieName, Value: ownerVal})
	return http.DefaultTransport.RoundTrip(req)
}

var ownerClient = &http.Client{Transport: ownerTransport{owner: testOwner}}

// foreignOwner is a second, equally-valid owner identity. Requests made with
// foreignClient are foreign to every session created under testOwner (F-29).
const foreignOwner = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"

var foreignClient = &http.Client{Transport: ownerTransport{owner: foreignOwner}}

// post is http.Post with the shared owner cookie attached.
func post(url, contentType string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodPost, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", contentType)
	return ownerClient.Do(req)
}

// get is http.Get with the shared owner cookie attached.
func get(url string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	return ownerClient.Do(req)
}

func readBody(t *testing.T, resp *http.Response) []byte {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return b
}

// TestGalleryRoutes_ZipFromPath verifies the grant-based on-disk zip import:
// a server-registered read grant is resolved and a usable zip session is
// created; the legacy raw `path` contract is gone (410) and a foreign owner's
// grant is denied (403).
func TestGalleryRoutes_ZipFromPath(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	zipPath := filepath.Join(t.TempDir(), "images.zip")
	if err := os.WriteFile(zipPath, buildTestZipBytes(t), 0644); err != nil {
		t.Fatalf("write test zip: %v", err)
	}
	g, err := h.grants.Grant(testOwner, []pathgrant.Operation{pathgrant.OpRead}, zipPath, false, false)
	if err != nil {
		t.Fatalf("grant zip: %v", err)
	}

	body, err := json.Marshal(map[string]string{"grantId": g.ID})
	if err != nil {
		t.Fatalf("marshal grant request: %v", err)
	}
	resp, err := post(srv.URL+"/zip-from-path", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /zip-from-path: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /zip-from-path: want 200, got %d, body=%q", resp.StatusCode, readBody(t, resp))
	}

	var parsed struct {
		SessionID string `json:"sessionId"`
		Manifest  struct {
			Entries []struct {
				Path string `json:"path"`
			} `json:"entries"`
		} `json:"manifest"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		t.Fatalf("decode zip-from-path response: %v", err)
	}
	if parsed.SessionID == "" || len(parsed.Manifest.Entries) != 1 || parsed.Manifest.Entries[0].Path != "a.png" {
		t.Fatalf("unexpected zip-from-path response: %+v", parsed)
	}

	entryResp, err := get(srv.URL + "/zip/" + parsed.SessionID + "/a.png")
	if err != nil {
		t.Fatalf("GET entry: %v", err)
	}
	defer entryResp.Body.Close()
	if entryResp.StatusCode != http.StatusOK || string(readBody(t, entryResp)) != "png-fake-bytes" {
		t.Fatalf("GET recreated zip session entry: want 200 with original bytes, got %d", entryResp.StatusCode)
	}
}

// TestGalleryRoutes_ZipFromPathRejectsMissingPath pins the rejection
// contract: malformed bodies 400, legacy raw paths 410, foreign grants 403.
func TestGalleryRoutes_ZipFromPathRejectsMissingPath(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	for _, body := range []string{"{}", "not-json"} {
		resp, err := post(srv.URL+"/zip-from-path", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("POST body %q: %v", body, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("POST /zip-from-path body %q: want 400, got %d", body, resp.StatusCode)
		}
	}

	// Legacy raw path contract is gone (410).
	legacyJSON := `{"path":"C:\\evil\\x.zip"}`
	resp, err := post(srv.URL+"/zip-from-path", "application/json", strings.NewReader(legacyJSON))
	if err != nil {
		t.Fatalf("POST legacy path: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("POST legacy path: want 410, got %d", resp.StatusCode)
	}

	// A grant owned by another session is denied (403).
	zipPath := filepath.Join(t.TempDir(), "images.zip")
	if err := os.WriteFile(zipPath, buildTestZipBytes(t), 0644); err != nil {
		t.Fatalf("write test zip: %v", err)
	}
	foreign, err := h.grants.Grant("someone-else", []pathgrant.Operation{pathgrant.OpRead}, zipPath, false, false)
	if err != nil {
		t.Fatalf("foreign grant: %v", err)
	}
	fb, _ := json.Marshal(map[string]string{"grantId": foreign.ID})
	fresp, err := post(srv.URL+"/zip-from-path", "application/json", bytes.NewReader(fb))
	if err != nil {
		t.Fatalf("POST foreign grant: %v", err)
	}
	fresp.Body.Close()
	if fresp.StatusCode != http.StatusForbidden {
		t.Fatalf("POST foreign grant: want 403, got %d", fresp.StatusCode)
	}
}

// TestGalleryRoutes_ZipWriteback_EmptyEntriesNoOp exercises the
// edit/zip-writeback endpoint's no-panic contract over a write grant: an
// empty entries list rewrites the archive back to disk unchanged.
func TestGalleryRoutes_ZipWriteback_EmptyEntriesNoOp(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	zipBytes := buildTestZipBytes(t)
	archivePath := filepath.Join(t.TempDir(), "archive.zip")
	if err := os.WriteFile(archivePath, zipBytes, 0644); err != nil {
		t.Fatalf("write archive: %v", err)
	}
	sessionID, err := newGallerySessionID()
	if err != nil {
		t.Fatalf("session id: %v", err)
	}
	if err := h.sessions.put(testOwner, sessionID, zipBytes); err != nil {
		t.Fatalf("put session: %v", err)
	}
	g, err := h.grants.Grant(testOwner, []pathgrant.Operation{pathgrant.OpWrite}, archivePath, false, false)
	if err != nil {
		t.Fatalf("write grant: %v", err)
	}

	body, _ := json.Marshal(map[string]any{
		"sessionId": sessionID,
		"grantId":   g.ID,
		"entries":   []map[string]string{},
	})
	resp, err := post(srv.URL+"/edit/zip-writeback", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /edit/zip-writeback: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /edit/zip-writeback (empty entries): want 200, got %d body=%q", resp.StatusCode, readBody(t, resp))
	}
	// The archive on disk is still a valid, openable zip with the original entry.
	out, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatalf("read archive back: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(out), int64(len(out)))
	if err != nil {
		t.Fatalf("open rewritten zip: %v", err)
	}
	if len(zr.File) != 1 || zr.File[0].Name != "a.png" {
		t.Fatalf("expected single a.png entry, got %+v", zr.File)
	}
}

// TestGalleryRoutes_ZipWriteback_ReplacesEntry confirms a single replacement
// (a registered asset) lands in the granted on-disk archive and the source
// asset is released afterwards.
func TestGalleryRoutes_ZipWriteback_ReplacesEntry(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	// Build a zip with two image entries so we can prove only the named one
	// changes and the other is byte-preserved.
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, spec := range []struct{ name, body string }{
		{"a.png", "alpha-bytes"},
		{"b.png", "beta-bytes"},
	} {
		w, err := zw.Create(spec.name)
		if err != nil {
			t.Fatalf("create %s: %v", spec.name, err)
		}
		if _, err := w.Write([]byte(spec.body)); err != nil {
			t.Fatalf("write %s: %v", spec.name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	archivePath := filepath.Join(t.TempDir(), "pack.zip")
	if err := os.WriteFile(archivePath, buf.Bytes(), 0644); err != nil {
		t.Fatalf("write archive: %v", err)
	}
	sessionID, err := newGallerySessionID()
	if err != nil {
		t.Fatalf("session id: %v", err)
	}
	if err := h.sessions.put(testOwner, sessionID, buf.Bytes()); err != nil {
		t.Fatalf("put session: %v", err)
	}
	g, err := h.grants.Grant(testOwner, []pathgrant.Operation{pathgrant.OpWrite}, archivePath, false, false)
	if err != nil {
		t.Fatalf("write grant: %v", err)
	}

	// Register the transcoded content for a.png as an owner-bound asset.
	st, err := h.assetStore()
	if err != nil {
		t.Fatalf("asset store: %v", err)
	}
	ref, err := st.Create(t.Context(), testOwner, "test", "a-converted.png", "image/png", strings.NewReader("ALPHA-NEW"), 0)
	if err != nil {
		t.Fatalf("create asset: %v", err)
	}

	body, _ := json.Marshal(map[string]any{
		"sessionId": sessionID,
		"grantId":   g.ID,
		"entries": []map[string]string{
			{"zipPath": "a.png", "assetId": ref.ID},
		},
	})
	resp, err := post(srv.URL+"/edit/zip-writeback", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /edit/zip-writeback: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /edit/zip-writeback: want 200, got %d body=%q", resp.StatusCode, readBody(t, resp))
	}

	// The replacement asset was released after the writeback.
	if _, _, err := st.Open(testOwner, ref.ID); !archiveIsNotFound(err) {
		t.Fatalf("replacement asset must be released after writeback, got %v", err)
	}

	out, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatalf("read archive back: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(out), int64(len(out)))
	if err != nil {
		t.Fatalf("open rewritten zip: %v", err)
	}
	if len(zr.File) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(zr.File))
	}
	readEntry := func(name string) string {
		for _, f := range zr.File {
			if f.Name == name {
				rc, err := f.Open()
				if err != nil {
					t.Fatalf("open %s: %v", name, err)
				}
				defer rc.Close()
				b, err := io.ReadAll(rc)
				if err != nil {
					t.Fatalf("read %s: %v", name, err)
				}
				return string(b)
			}
		}
		t.Fatalf("entry %s not found", name)
		return ""
	}
	if got := readEntry("a.png"); got != "ALPHA-NEW" {
		t.Fatalf("a.png: want ALPHA-NEW got %q", got)
	}
	if got := readEntry("b.png"); got != "beta-bytes" {
		t.Fatalf("b.png (untouched): want beta-bytes got %q", got)
	}
}

// archiveIsNotFound mirrors archive.IsNotFound without importing the archive
// package from the test (the handler's error already wraps it).
func archiveIsNotFound(err error) bool {
	return err != nil && strings.Contains(err.Error(), "not found")
}

// TestGalleryServeFileRejectsRawPath pins the F-03 contract: /file?path= is
// gone (410) and grantId+rel serving works for granted files.
func TestGalleryServeFileRejectsRawPath(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	dir := t.TempDir()
	img := filepath.Join(dir, "a.webp")
	if err := os.WriteFile(img, []byte("img-bytes"), 0644); err != nil {
		t.Fatal(err)
	}
	g, err := h.grants.Grant(testOwner, []pathgrant.Operation{pathgrant.OpRead}, dir, true, false)
	if err != nil {
		t.Fatalf("dir grant: %v", err)
	}

	resp, err := get(srv.URL + "/file?path=" + img)
	if err != nil {
		t.Fatalf("GET raw path: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("GET /file?path=: want 410, got %d", resp.StatusCode)
	}

	resp, err = get(srv.URL + "/file?grantId=" + g.ID + "&rel=a.webp")
	if err != nil {
		t.Fatalf("GET granted file: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(readBody(t, resp)) != "img-bytes" {
		t.Fatalf("GET granted file: want 200 img-bytes, got %d", resp.StatusCode)
	}

	// Traversal rel is denied.
	resp, err = get(srv.URL + "/file?grantId=" + g.ID + "&rel=..%2F..%2Fsecret.txt")
	if err != nil {
		t.Fatalf("GET traversal: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("GET traversal rel: want 400/403, got %d", resp.StatusCode)
	}
}
