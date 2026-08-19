package gallery

// Deterministic budget tests for the in-memory zip session store and its HTTP
// surface (docs/audit_fix.md F-15). The byte/pin budgets are exercised through
// test-controlled limits instead of multi-GiB allocations, and the HTTP tests
// hold upload slots with blocking readers so the 413/429 responses are
// deterministic rather than load-dependent.

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

// newBoundedSessionStore builds a session store with test-controlled budgets.
func newBoundedSessionStore(maxBytes, maxPinnedBytes int64) *gallerySessionStore {
	return &gallerySessionStore{
		sessions:       make(map[string]*zipSession),
		maxSessions:    galleryMaxSessions,
		maxBytes:       maxBytes,
		maxPinnedBytes: maxPinnedBytes,
	}
}

// TestSessionStore_TooLargeRejected pins the 413 contract at the store level:
// a session over the byte budget is refused with errSessionTooLarge (the
// galleryListZip 413 path), is not stored, and the refusal must not evict or
// mutate existing sessions.
func TestSessionStore_TooLargeRejected(t *testing.T) {
	s := newBoundedSessionStore(100, 0)
	if err := s.put("owner", "small", []byte("xxxx")); err != nil {
		t.Fatalf("put small: %v", err)
	}
	if err := s.put("owner", "big", bytes.Repeat([]byte("y"), 101)); !errors.Is(err, errSessionTooLarge) {
		t.Fatalf("put oversized: err = %v, want errSessionTooLarge", err)
	}
	if _, ok := s.get("owner", "big"); ok {
		t.Fatal("oversized session must not be stored")
	}
	if _, ok := s.get("owner", "small"); !ok {
		t.Fatal("existing session was evicted by a refused put")
	}

	// update with an oversized replacement is refused and leaves the original
	// data untouched (the session is not mutated on budget failure).
	if _, err := s.update("owner", "small", bytes.Repeat([]byte("z"), 101)); !errors.Is(err, errSessionTooLarge) {
		t.Fatalf("update oversized: err = %v, want errSessionTooLarge", err)
	}
	data, ok := s.get("owner", "small")
	if !ok || string(data) != "xxxx" {
		t.Fatalf("update must not mutate the session on budget refusal, got %q ok=%v", data, ok)
	}
}

// TestSessionStore_ByteBudgetEviction pins the byte-budget LRU contract: once
// the total resident bytes exceed the budget, the least-recently-used session
// is evicted, byte accounting stays exact, and removing a session frees its
// bytes.
func TestSessionStore_ByteBudgetEviction(t *testing.T) {
	s := newBoundedSessionStore(100, 0)
	if err := s.put("owner", "a", bytes.Repeat([]byte("a"), 40)); err != nil {
		t.Fatal(err)
	}
	if err := s.put("owner", "b", bytes.Repeat([]byte("b"), 40)); err != nil {
		t.Fatal(err)
	}
	// Total would be 120 > 100: the oldest session is evicted.
	if err := s.put("owner", "c", bytes.Repeat([]byte("c"), 40)); err != nil {
		t.Fatal(err)
	}
	if s.totalBytes != 80 {
		t.Fatalf("totalBytes = %d, want 80", s.totalBytes)
	}
	if _, ok := s.get("owner", "a"); ok {
		t.Fatal("oldest session must be evicted when the byte budget is exceeded")
	}
	for _, id := range []string{"b", "c"} {
		if _, ok := s.get("owner", id); !ok {
			t.Fatalf("session %q must survive byte-budget eviction", id)
		}
	}
	s.remove("owner", "b")
	if s.totalBytes != 40 {
		t.Fatalf("totalBytes after remove = %d, want 40", s.totalBytes)
	}
}

// TestSessionStore_PinBudgetRefused pins the pinned-byte contract: pin refuses
// when pinning would exceed the pinned budget (the AI-review load-shedding
// path) and unpin frees the budget for later pins.
func TestSessionStore_PinBudgetRefused(t *testing.T) {
	s := newBoundedSessionStore(100, 10)
	if err := s.put("owner", "a", bytes.Repeat([]byte("a"), 6)); err != nil {
		t.Fatal(err)
	}
	if err := s.put("owner", "b", bytes.Repeat([]byte("b"), 6)); err != nil {
		t.Fatal(err)
	}
	if !s.pin("owner", "a") {
		t.Fatal("pin within budget must succeed")
	}
	if s.pin("owner", "b") {
		t.Fatal("pin over the pinned budget must be refused")
	}
	if !s.unpin("owner", "a") {
		t.Fatal("unpin returned false")
	}
	if !s.pin("owner", "b") {
		t.Fatal("pin after unpin must succeed")
	}
}

// TestSessionStore_TTLExpiry pins the lazy TTL contract: a session untouched
// for longer than gallerySessionTTL is dropped on access and its bytes are
// reclaimed.
func TestSessionStore_TTLExpiry(t *testing.T) {
	s := newBoundedSessionStore(100, 0)
	if err := s.put("owner", "old", []byte("old-data")); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.sessions["old"].lastAccess = time.Now().Add(-gallerySessionTTL - time.Second)
	s.mu.Unlock()
	if _, ok := s.get("owner", "old"); ok {
		t.Fatal("expired session must not be readable")
	}
	if s.totalBytes != 0 {
		t.Fatalf("expired session bytes not reclaimed: totalBytes = %d", s.totalBytes)
	}
}

// blockingZipBody is a request body that signals once the server handler
// starts reading it, then blocks until release — deterministically holding an
// upload semaphore slot.
type blockingZipBody struct {
	started chan struct{}
	release chan struct{}
	data    []byte
	read    bool
}

func (b *blockingZipBody) Read(p []byte) (int, error) {
	if !b.read {
		b.read = true
		close(b.started)
		<-b.release
	}
	if len(b.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, b.data)
	b.data = b.data[n:]
	return n, nil
}

// TestGalleryUpload_Semaphore429 pins the 429 upload-semaphore contract: with
// both upload slots held by blocked readers, a third upload is refused with a
// deterministic 429; releasing the held uploads completes them with 200; and a
// follow-up upload succeeds, proving the 429 consumed no slot and left no
// session residue.
func TestGalleryUpload_Semaphore429(t *testing.T) {
	h := newTestHandler(t)
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	zipBytes := buildTestZipBytes(t)
	rel1, rel2 := make(chan struct{}), make(chan struct{})
	var close1, close2 sync.Once
	releaseAll := func() {
		close1.Do(func() { close(rel1) })
		close2.Do(func() { close(rel2) })
	}
	t.Cleanup(releaseAll)

	type uploadResult struct {
		resp *http.Response
		err  error
	}
	results := make(chan uploadResult, 2)
	start := func(body io.Reader) {
		go func() {
			resp, err := post(srv.URL+"/zip", "application/zip", body)
			results <- uploadResult{resp, err}
		}()
	}

	b1 := &blockingZipBody{started: make(chan struct{}), release: rel1, data: zipBytes}
	b2 := &blockingZipBody{started: make(chan struct{}), release: rel2, data: zipBytes}
	start(b1)
	<-b1.started // slot 1 held
	start(b2)
	<-b2.started // slot 2 held

	// Both slots are taken: the third concurrent upload is a deterministic 429.
	rr, err := post(srv.URL+"/zip", "application/zip", bytes.NewReader(zipBytes))
	if err != nil {
		t.Fatalf("3rd upload: %v", err)
	}
	if rr.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("3rd upload = %d, want 429", rr.StatusCode)
	}
	if body := readBody(t, rr); !strings.Contains(string(body), "too many concurrent zip uploads") {
		t.Fatalf("429 body = %q", body)
	}
	rr.Body.Close()

	// Release the held uploads; both complete with 200.
	releaseAll()
	for range 2 {
		res := <-results
		if res.err != nil {
			t.Fatalf("held upload: %v", res.err)
		}
		if res.resp.StatusCode != http.StatusOK {
			t.Fatalf("held upload = %d, want 200", res.resp.StatusCode)
		}
		res.resp.Body.Close()
	}

	// The refused upload consumed no slot and left no session: a follow-up
	// upload succeeds.
	okResp, err := post(srv.URL+"/zip", "application/zip", bytes.NewReader(zipBytes))
	if err != nil {
		t.Fatalf("follow-up upload: %v", err)
	}
	okResp.Body.Close()
	if okResp.StatusCode != http.StatusOK {
		t.Fatalf("follow-up upload = %d, want 200", okResp.StatusCode)
	}
}

// TestGalleryUpload_TooLarge413 pins the 413 session-byte-budget contract at
// the HTTP layer: an upload whose zip bytes exceed the session budget is
// refused with 413, leaves no session behind, and releases its upload slot so
// a follow-up request is handled normally.
func TestGalleryUpload_TooLarge413(t *testing.T) {
	h := newTestHandler(t)
	h.sessions = newBoundedSessionStore(64, 0) // below the size of a minimal zip
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	rr, err := post(srv.URL+"/zip", "application/zip", bytes.NewReader(buildTestZipBytes(t)))
	if err != nil {
		t.Fatalf("POST /zip: %v", err)
	}
	if rr.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized upload = %d, want 413", rr.StatusCode)
	}
	if body := readBody(t, rr); !strings.Contains(string(body), "zip session exceeds total byte budget") {
		t.Fatalf("413 body = %q", body)
	}
	rr.Body.Close()

	// No session residue after the refused upload.
	if got := len(h.sessions.sessions); got != 0 {
		t.Fatalf("refused upload left %d sessions in the store", got)
	}

	// The upload slot was released on the failure path: a second oversized
	// upload is handled again (413), not stalled or 500.
	rr2, err := post(srv.URL+"/zip", "application/zip", bytes.NewReader(buildTestZipBytes(t)))
	if err != nil {
		t.Fatalf("second POST /zip: %v", err)
	}
	rr2.Body.Close()
	if rr2.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("second oversized upload = %d, want 413", rr2.StatusCode)
	}
}
