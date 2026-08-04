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
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/console"
)

// buildTestZipBytes creates an in-memory zip with one gallery-supported image
// entry (a.png) so galleryListZip returns a non-empty manifest.
func buildTestZipBytes(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("a.png")
	if err != nil {
		t.Fatalf("create a.png: %v", err)
	}
	if _, err := w.Write([]byte("png-fake-bytes")); err != nil {
		t.Fatalf("write a.png: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

// newTestHandler builds a Handler wired to a throwaway Deps with a real Logger.
func newTestHandler(t *testing.T) *Handler {
	t.Helper()
	return NewHandler(&apibase.Deps{Logger: console.New(100)})
}

// TestSessionStore_LRUEviction pins the eviction contract: once the store
// exceeds galleryMaxSessions, the least-recently-used sessions are evicted,
// leaving exactly galleryMaxSessions alive. This is the contract the frontend
// rehydrate-on-404 path relies on (evicted sessions return 404 on fetch).
func TestSessionStore_LRUEviction(t *testing.T) {
	s := newGallerySessionStore()
	const n = galleryMaxSessions + 2

	ids := make([]string, n)
	for i := 0; i < n; i++ {
		ids[i] = "sess-" + itoa(i)
		s.put(ids[i], []byte{byte(i)})
	}

	// The first (n - galleryMaxSessions) inserted sessions must be evicted.
	evictedCount := n - galleryMaxSessions
	for i := 0; i < evictedCount; i++ {
		if _, ok := s.get(ids[i]); ok {
			t.Fatalf("expected session %q to be evicted, but get returned ok", ids[i])
		}
	}
	// The most-recently-used galleryMaxSessions sessions must survive.
	for i := evictedCount; i < n; i++ {
		if _, ok := s.get(ids[i]); !ok {
			t.Fatalf("expected session %q to survive, but get returned !ok", ids[i])
		}
	}
}

// TestSessionStore_Touch confirms touch bumps the LRU position without
// returning data, so the currently-viewed session resists eviction.
func TestSessionStore_Touch(t *testing.T) {
	s := newGallerySessionStore()
	if ok := s.touch("missing"); ok {
		t.Fatalf("touch on missing session should return false")
	}
	s.put("a", []byte("data-a"))
	s.put("b", []byte("data-b"))

	// Touching "a" makes it the most-recently-used; "b" becomes the LRU victim
	// when capacity is exceeded.
	if ok := s.touch("a"); !ok {
		t.Fatalf("touch on existing session should return true")
	}

	// Fill the store up to capacity (128) without exceeding it. After touch("a")
	// the LRU order is [b, a, fill-0..fill-125]; inserting one more forces a
	// single eviction. The victim must be "b" (the new LRU), not the touched "a".
	for i := 0; i < galleryMaxSessions-2; i++ {
		s.put("fill-"+itoa(i), []byte{byte(i)})
	}
	s.put("trigger", []byte("t"))

	if _, ok := s.get("b"); ok {
		t.Fatalf("expected LRU victim 'b' to be evicted, but it survived")
	}
	if _, ok := s.get("a"); !ok {
		t.Fatalf("expected touched session 'a' to survive, but it was evicted")
	}
}

// TestSessionStore_Remove confirms remove drops a session and is idempotent.
func TestSessionStore_Remove(t *testing.T) {
	s := newGallerySessionStore()
	s.put("a", []byte("data-a"))
	s.remove("a")
	if _, ok := s.get("a"); ok {
		t.Fatalf("expected session 'a' to be removed")
	}
	// Removing again must not panic.
	s.remove("a")
}

// TestGalleryRoutes_DeleteSessionAndTouch exercises the HTTP layer: the new
// whole-session DELETE route, the touch route, and confirms chi distinguishes
// DELETE /zip/{sessionId} (session delete) from DELETE /zip/{sessionId}/*
// (entry delete).
func TestGalleryRoutes_DeleteSessionAndTouch(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)

	zipBytes := buildTestZipBytes(t)

	// Upload a zip and capture the session id.
	upReq := httptest.NewRequest(http.MethodPost, "/zip", bytes.NewReader(zipBytes))
	upReq.Header.Set("Content-Type", "application/zip")
	upRec := httptest.NewRecorder()
	r.ServeHTTP(upRec, upReq)
	if upRec.Code != http.StatusOK {
		t.Fatalf("POST /zip: want 200, got %d", upRec.Code)
	}
	var resp struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(upRec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode upload response: %v (body=%q)", err, upRec.Body.String())
	}
	if resp.SessionID == "" {
		t.Fatalf("expected non-empty sessionId, body=%q", upRec.Body.String())
	}
	sid := resp.SessionID

	// Entry fetch works while the session is alive.
	entryReq := httptest.NewRequest(http.MethodGet, "/zip/"+sid+"/a.png", nil)
	entryRec := httptest.NewRecorder()
	r.ServeHTTP(entryRec, entryReq)
	if entryRec.Code != http.StatusOK {
		t.Fatalf("GET /zip/{sid}/a.png: want 200, got %d", entryRec.Code)
	}
	if string(entryRec.Body.Bytes()) != "png-fake-bytes" {
		t.Fatalf("GET /zip/{sid}/a.png: unexpected body %q", entryRec.Body.String())
	}

	// Touch refreshes the session (204 No Content).
	touchReq := httptest.NewRequest(http.MethodPost, "/zip/"+sid+"/touch", nil)
	touchRec := httptest.NewRecorder()
	r.ServeHTTP(touchRec, touchReq)
	if touchRec.Code != http.StatusNoContent {
		t.Fatalf("POST /zip/{sid}/touch: want 204, got %d", touchRec.Code)
	}

	// DELETE /zip/{sessionId} drops the whole session (204 No Content).
	delReq := httptest.NewRequest(http.MethodDelete, "/zip/"+sid, nil)
	delRec := httptest.NewRecorder()
	r.ServeHTTP(delRec, delReq)
	if delRec.Code != http.StatusNoContent {
		t.Fatalf("DELETE /zip/{sid}: want 204, got %d", delRec.Code)
	}

	// After deletion, the entry is gone (404).
	entryReq2 := httptest.NewRequest(http.MethodGet, "/zip/"+sid+"/a.png", nil)
	entryRec2 := httptest.NewRecorder()
	r.ServeHTTP(entryRec2, entryReq2)
	if entryRec2.Code != http.StatusNotFound {
		t.Fatalf("GET /zip/{sid}/a.png after delete: want 404, got %d", entryRec2.Code)
	}

	// Touch on the deleted session returns 404.
	touchReq2 := httptest.NewRequest(http.MethodPost, "/zip/"+sid+"/touch", nil)
	touchRec2 := httptest.NewRecorder()
	r.ServeHTTP(touchRec2, touchReq2)
	if touchRec2.Code != http.StatusNotFound {
		t.Fatalf("POST /zip/{sid}/touch after delete: want 404, got %d", touchRec2.Code)
	}

	// DELETE /zip/{sessionId}/a.png (with an entry path) routes to the ENTRY
	// delete handler, which returns 404 "zip session not found" for a missing
	// session — proving chi distinguishes the two DELETE patterns.
	entDelReq := httptest.NewRequest(http.MethodDelete, "/zip/"+sid+"/a.png", nil)
	entDelRec := httptest.NewRecorder()
	r.ServeHTTP(entDelRec, entDelReq)
	if entDelRec.Code != http.StatusNotFound {
		t.Fatalf("DELETE /zip/{sid}/a.png on missing session: want 404, got %d", entDelRec.Code)
	}
	if !strings.Contains(entDelRec.Body.String(), "zip session not found") {
		t.Fatalf("DELETE /zip/{sid}/a.png on missing session: want 'zip session not found', body=%q", entDelRec.Body.String())
	}
}

// TestGalleryRoutes_ZipFromPath verifies that the disk-path endpoint decodes
// its JSON request and creates a usable zip session.
func TestGalleryRoutes_ZipFromPath(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)

	zipPath := filepath.Join(t.TempDir(), "images.zip")
	if err := os.WriteFile(zipPath, buildTestZipBytes(t), 0644); err != nil {
		t.Fatalf("write test zip: %v", err)
	}

	body, err := json.Marshal(map[string]string{"path": zipPath})
	if err != nil {
		t.Fatalf("marshal zip path request: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/zip-from-path", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /zip-from-path: want 200, got %d, body=%q", rec.Code, rec.Body.String())
	}

	var resp struct {
		SessionID string `json:"sessionId"`
		Manifest  struct {
			Entries []struct {
				Path string `json:"path"`
			} `json:"entries"`
		} `json:"manifest"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode zip-from-path response: %v", err)
	}
	if resp.SessionID == "" || len(resp.Manifest.Entries) != 1 || resp.Manifest.Entries[0].Path != "a.png" {
		t.Fatalf("unexpected zip-from-path response: %+v", resp)
	}

	entryReq := httptest.NewRequest(http.MethodGet, "/zip/"+resp.SessionID+"/a.png", nil)
	entryRec := httptest.NewRecorder()
	r.ServeHTTP(entryRec, entryReq)
	if entryRec.Code != http.StatusOK || string(entryRec.Body.Bytes()) != "png-fake-bytes" {
		t.Fatalf("GET recreated zip session entry: want 200 with original bytes, got %d body=%q", entryRec.Code, entryRec.Body.String())
	}
}

// TestGalleryRoutes_ZipFromPathRejectsMissingPath verifies malformed or empty
// requests fail before attempting to read an empty filesystem path.
func TestGalleryRoutes_ZipFromPathRejectsMissingPath(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)

	for _, body := range []string{"{}", "not-json"} {
		req := httptest.NewRequest(http.MethodPost, "/zip-from-path", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("POST /zip-from-path body %q: want 400, got %d", body, rec.Code)
		}
	}
}

// itoa is a tiny int->string helper used to build unique session ids in the
// LRU fill loops without importing strconv.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var out []byte
	for i > 0 {
		out = append([]byte{byte('0' + i%10)}, out...)
		i /= 10
	}
	return string(out)
}

// TestGalleryRoutes_ZipWriteback_EmptyEntriesNoOp exercises the edit/zip-writeback
// endpoint's no-panic contract: an empty entries list must succeed and rewrite
// the archive back to disk unchanged.
func TestGalleryRoutes_ZipWriteback_EmptyEntriesNoOp(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)

	zipBytes := buildTestZipBytes(t)
	archivePath := filepath.Join(t.TempDir(), "archive.zip")
	if err := os.WriteFile(archivePath, zipBytes, 0644); err != nil {
		t.Fatalf("write archive: %v", err)
	}

	body, _ := json.Marshal(map[string]any{
		"archivePath": archivePath,
		"entries":     []map[string]string{},
	})
	req := httptest.NewRequest(http.MethodPost, "/edit/zip-writeback", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /edit/zip-writeback (empty entries): want 200, got %d body=%q", rec.Code, rec.Body.String())
	}
	var resp struct {
		OK   bool   `json:"ok"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !resp.OK || resp.Path != archivePath {
		t.Fatalf("unexpected response: %+v", resp)
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
// lands in the on-disk archive and the supplied temp file is removed.
func TestGalleryRoutes_ZipWriteback_ReplacesEntry(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)

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

	// Temp file holding the transcoded content for a.png.
	repPath := filepath.Join(t.TempDir(), "a-converted.png")
	if err := os.WriteFile(repPath, []byte("ALPHA-NEW"), 0644); err != nil {
		t.Fatalf("write replacement: %v", err)
	}

	body, _ := json.Marshal(map[string]any{
		"archivePath": archivePath,
		"entries": []map[string]string{
			{"zipPath": "a.png", "filePath": repPath},
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/edit/zip-writeback", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /edit/zip-writeback: want 200, got %d body=%q", rec.Code, rec.Body.String())
	}

	// The temp converted file should be cleaned up.
	if _, err := os.Stat(repPath); !os.IsNotExist(err) {
		t.Fatalf("expected temp file removed, stat err=%v", err)
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
