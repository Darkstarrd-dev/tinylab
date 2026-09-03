package gallery

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/owner"
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
		s.put("owner", ids[i], []byte{byte(i)})
	}

	// The first (n - galleryMaxSessions) inserted sessions must be evicted.
	evictedCount := n - galleryMaxSessions
	for i := 0; i < evictedCount; i++ {
		if _, ok := s.get("owner", ids[i]); ok {
			t.Fatalf("expected session %q to be evicted, but get returned ok", ids[i])
		}
	}
	// The most-recently-used galleryMaxSessions sessions must survive.
	for i := evictedCount; i < n; i++ {
		if _, ok := s.get("owner", ids[i]); !ok {
			t.Fatalf("expected session %q to survive, but get returned !ok", ids[i])
		}
	}
}

// TestSessionStore_Touch confirms touch bumps the LRU position without
// returning data, so the currently-viewed session resists eviction.
func TestSessionStore_Touch(t *testing.T) {
	s := newGallerySessionStore()
	if ok := s.touch("owner", "missing"); ok {
		t.Fatalf("touch on missing session should return false")
	}
	s.put("owner", "a", []byte("data-a"))
	s.put("owner", "b", []byte("data-b"))

	// Touching "a" makes it the most-recently-used; "b" becomes the LRU victim
	// when capacity is exceeded.
	if ok := s.touch("owner", "a"); !ok {
		t.Fatalf("touch on existing session should return true")
	}

	// Fill the store up to capacity (128) without exceeding it. After touch("a")
	// the LRU order is [b, a, fill-0..fill-125]; inserting one more forces a
	// single eviction. The victim must be "b" (the new LRU), not the touched "a".
	for i := 0; i < galleryMaxSessions-2; i++ {
		s.put("owner", "fill-"+itoa(i), []byte{byte(i)})
	}
	s.put("owner", "trigger", []byte("t"))

	if _, ok := s.get("owner", "b"); ok {
		t.Fatalf("expected LRU victim 'b' to be evicted, but it survived")
	}
	if _, ok := s.get("owner", "a"); !ok {
		t.Fatalf("expected touched session 'a' to survive, but it was evicted")
	}
}

// TestSessionStore_Remove confirms remove drops a session and is idempotent.
func TestSessionStore_Remove(t *testing.T) {
	s := newGallerySessionStore()
	s.put("owner", "a", []byte("data-a"))
	s.remove("owner", "a")
	if _, ok := s.get("owner", "a"); ok {
		t.Fatalf("expected session 'a' to be removed")
	}
	// Removing again must not panic.
	s.remove("owner", "a")
}

// TestGalleryRoutes_DeleteSessionAndTouch exercises the HTTP layer: the new
// whole-session DELETE route, the touch route, and confirms chi distinguishes
// DELETE /zip/{sessionId} (session delete) from DELETE /zip/{sessionId}/*
// (entry delete).
func TestGalleryRoutes_DeleteSessionAndTouch(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	zipBytes := buildTestZipBytes(t)

	// Upload a zip and capture the session id.
	upResp, err := post(srv.URL+"/zip", "application/zip", bytes.NewReader(zipBytes))
	if err != nil {
		t.Fatalf("POST /zip: %v", err)
	}
	if upResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /zip: want 200, got %d", upResp.StatusCode)
	}
	var resp struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(upResp.Body).Decode(&resp); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	upResp.Body.Close()
	if resp.SessionID == "" {
		t.Fatalf("expected non-empty sessionId")
	}
	sid := resp.SessionID

	// Entry fetch works while the session is alive.
	entryResp, err := get(srv.URL + "/zip/" + sid + "/a.png")
	if err != nil {
		t.Fatalf("GET entry: %v", err)
	}
	if entryResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /zip/{sid}/a.png: want 200, got %d", entryResp.StatusCode)
	}
	if string(readBody(t, entryResp)) != "png-fake-bytes" {
		t.Fatalf("GET /zip/{sid}/a.png: unexpected body")
	}

	// Touch refreshes the session (204 No Content).
	touchResp, err := post(srv.URL+"/zip/"+sid+"/touch", "application/json", nil)
	if err != nil {
		t.Fatalf("POST touch: %v", err)
	}
	touchResp.Body.Close()
	if touchResp.StatusCode != http.StatusNoContent {
		t.Fatalf("POST /zip/{sid}/touch: want 204, got %d", touchResp.StatusCode)
	}

	// DELETE /zip/{sessionId} drops the whole session (204 No Content).
	delReq, _ := http.NewRequest(http.MethodDelete, srv.URL+"/zip/"+sid, nil)
	delResp, err := ownerClient.Do(delReq)
	if err != nil {
		t.Fatalf("DELETE session: %v", err)
	}
	delResp.Body.Close()
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /zip/{sid}: want 204, got %d", delResp.StatusCode)
	}

	// After deletion, the entry is gone (404).
	entryResp2, err := get(srv.URL + "/zip/" + sid + "/a.png")
	if err != nil {
		t.Fatalf("GET entry after delete: %v", err)
	}
	entryResp2.Body.Close()
	if entryResp2.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /zip/{sid}/a.png after delete: want 404, got %d", entryResp2.StatusCode)
	}

	// Touch on the deleted session returns 404.
	touchResp2, err := post(srv.URL+"/zip/"+sid+"/touch", "application/json", nil)
	if err != nil {
		t.Fatalf("POST touch after delete: %v", err)
	}
	touchResp2.Body.Close()
	if touchResp2.StatusCode != http.StatusNotFound {
		t.Fatalf("POST /zip/{sid}/touch after delete: want 404, got %d", touchResp2.StatusCode)
	}

	// DELETE /zip/{sessionId}/a.png (with an entry path) routes to the ENTRY
	// delete handler, which returns 404 "zip session not found" for a missing
	// session — proving chi distinguishes the two DELETE patterns.
	entDelReq, _ := http.NewRequest(http.MethodDelete, srv.URL+"/zip/"+sid+"/a.png", nil)
	entDelResp, err := ownerClient.Do(entDelReq)
	if err != nil {
		t.Fatalf("DELETE entry: %v", err)
	}
	entDelBody := readBody(t, entDelResp)
	if entDelResp.StatusCode != http.StatusNotFound {
		t.Fatalf("DELETE /zip/{sid}/a.png on missing session: want 404, got %d", entDelResp.StatusCode)
	}
	if !strings.Contains(string(entDelBody), "zip session not found") {
		t.Fatalf("DELETE /zip/{sid}/a.png on missing session: want 'zip session not found', body=%q", entDelBody)
	}
}

// TestGallery_OwnerBoundSessionIsolation pins the F-29 owner boundary end to
// end over HTTP: the owner middleware is mounted exactly once (a request with
// no owner cookie receives exactly one tinylab_owner cookie), a session
// created under one owner is readable only by that owner, and foreign
// read/touch/delete/pin attempts return not-found/denied WITHOUT purging the
// owner's session (regression: foreign get/touch/update/pin deleted the
// owner's session on mismatch).
func TestGallery_OwnerBoundSessionIsolation(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	// 1. A request with no owner cookie receives exactly ONE owner cookie.
	// The middleware must be mounted exactly once on the gallery boundary
	// (inside Register, like archive/editor/filetransfer); a duplicate mount
	// emitted two Set-Cookie headers with different owner values, drifting
	// the browser's owner away from the request-context owner.
	noOwnerReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/zip/not-a-session/a.png", nil)
	noOwnerResp, err := http.DefaultClient.Do(noOwnerReq)
	if err != nil {
		t.Fatalf("cookie-less request: %v", err)
	}
	noOwnerResp.Body.Close()
	var ownerCookies int
	for _, c := range noOwnerResp.Cookies() {
		if c.Name == owner.CookieName {
			ownerCookies++
			if !owner.Valid(c.Value) {
				t.Fatalf("issued owner cookie %q is not a valid owner value", c.Value)
			}
		}
	}
	if ownerCookies != 1 {
		t.Fatalf("want exactly 1 %s cookie, got %d", owner.CookieName, ownerCookies)
	}

	// 2. Owner uploads a zip; the session is bound to testOwner.
	upResp, err := post(srv.URL+"/zip", "application/zip", bytes.NewReader(buildTestZipBytes(t)))
	if err != nil {
		t.Fatalf("POST /zip: %v", err)
	}
	if upResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /zip: want 200, got %d", upResp.StatusCode)
	}
	var resp struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(upResp.Body).Decode(&resp); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	upResp.Body.Close()
	sid := resp.SessionID
	if sid == "" {
		t.Fatal("expected non-empty sessionId")
	}

	// 3. Same-session readback works.
	entryResp, err := get(srv.URL + "/zip/" + sid + "/a.png")
	if err != nil {
		t.Fatalf("owner GET entry: %v", err)
	}
	if entryResp.StatusCode != http.StatusOK {
		t.Fatalf("owner GET /zip/{sid}/a.png: want 200, got %d", entryResp.StatusCode)
	}
	if string(readBody(t, entryResp)) != "png-fake-bytes" {
		t.Fatalf("owner GET /zip/{sid}/a.png: unexpected body")
	}

	// 4. Foreign read → 404, foreign touch → 404, foreign entry-delete → 404
	// (the get gate), foreign whole-session delete → idempotent 204 no-op,
	// foreign review pin → 404 before pin. None may purge the session.
	foreignGetReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/zip/"+sid+"/a.png", nil)
	foreignGetResp, err := foreignClient.Do(foreignGetReq)
	if err != nil {
		t.Fatalf("foreign GET entry: %v", err)
	}
	foreignGetResp.Body.Close()
	if foreignGetResp.StatusCode != http.StatusNotFound {
		t.Fatalf("foreign GET /zip/{sid}/a.png: want 404, got %d", foreignGetResp.StatusCode)
	}

	foreignTouchReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/zip/"+sid+"/touch", nil)
	foreignTouchResp, err := foreignClient.Do(foreignTouchReq)
	if err != nil {
		t.Fatalf("foreign POST touch: %v", err)
	}
	foreignTouchResp.Body.Close()
	if foreignTouchResp.StatusCode != http.StatusNotFound {
		t.Fatalf("foreign POST /zip/{sid}/touch: want 404, got %d", foreignTouchResp.StatusCode)
	}

	foreignEntryDelReq, _ := http.NewRequest(http.MethodDelete, srv.URL+"/zip/"+sid+"/a.png", nil)
	foreignEntryDelResp, err := foreignClient.Do(foreignEntryDelReq)
	if err != nil {
		t.Fatalf("foreign DELETE entry: %v", err)
	}
	foreignEntryDelResp.Body.Close()
	if foreignEntryDelResp.StatusCode != http.StatusNotFound {
		t.Fatalf("foreign DELETE /zip/{sid}/a.png: want 404, got %d", foreignEntryDelResp.StatusCode)
	}

	foreignDelReq, _ := http.NewRequest(http.MethodDelete, srv.URL+"/zip/"+sid, nil)
	foreignDelResp, err := foreignClient.Do(foreignDelReq)
	if err != nil {
		t.Fatalf("foreign DELETE session: %v", err)
	}
	foreignDelResp.Body.Close()
	if foreignDelResp.StatusCode != http.StatusNoContent {
		t.Fatalf("foreign DELETE /zip/{sid}: want 204, got %d", foreignDelResp.StatusCode)
	}

	foreignReviewBody := strings.NewReader(`{"sessionId":"` + sid + `","provider":"p","model":"m"}`)
	foreignReviewReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/review/start", foreignReviewBody)
	foreignReviewReq.Header.Set("Content-Type", "application/json")
	foreignReviewResp, err := foreignClient.Do(foreignReviewReq)
	if err != nil {
		t.Fatalf("foreign POST review/start: %v", err)
	}
	foreignReviewResp.Body.Close()
	if foreignReviewResp.StatusCode != http.StatusNotFound {
		t.Fatalf("foreign POST /review/start: want 404, got %d", foreignReviewResp.StatusCode)
	}

	// 5. The owner's session survived every foreign attempt.
	entryResp2, err := get(srv.URL + "/zip/" + sid + "/a.png")
	if err != nil {
		t.Fatalf("owner GET entry after foreign access: %v", err)
	}
	if entryResp2.StatusCode != http.StatusOK {
		t.Fatalf("owner GET after foreign access: want 200, got %d", entryResp2.StatusCode)
	}
	if string(readBody(t, entryResp2)) != "png-fake-bytes" {
		t.Fatalf("owner GET after foreign access: unexpected body")
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
