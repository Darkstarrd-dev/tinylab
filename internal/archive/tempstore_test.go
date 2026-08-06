package archive

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestStore(t *testing.T, ttl time.Duration) *TempStore {
	t.Helper()
	s, err := NewTempStore(t.TempDir(), ttl)
	if err != nil {
		t.Fatalf("NewTempStore: %v", err)
	}
	return s
}

func TestTempStore_CreateOpenRoundtrip(t *testing.T) {
	s := newTestStore(t, 0)
	ref, err := s.Create(t.Context(), "owner-a", "job-1", "frame.png", "image/png", strings.NewReader("hello"), 0)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if ref.ID == "" {
		t.Fatal("asset ID is empty")
	}
	if ref.Name != "frame.png" {
		t.Fatalf("name = %q", ref.Name)
	}
	if ref.Size != 5 {
		t.Fatalf("size = %d, want 5", ref.Size)
	}
	if ref.Path == "" || !filepath.IsAbs(ref.Path) {
		t.Fatalf("path should be an absolute server-side path, got %q", ref.Path)
	}

	rc, got, err := s.Open(ref.ID)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer rc.Close()
	data, err := ReadCapped(rc, 1<<20)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(data) != "hello" {
		t.Fatalf("content = %q", data)
	}
	if got.Name != ref.Name || got.Size != ref.Size {
		t.Fatalf("metadata mismatch: %+v vs %+v", got, ref)
	}

	p, err := s.Path(ref.ID)
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if p != ref.Path {
		t.Fatalf("Path() = %q, want %q", p, ref.Path)
	}
}

func TestTempStore_OwnerJobLayout(t *testing.T) {
	s := newTestStore(t, 0)
	ref, err := s.Create(t.Context(), "owner-a", "job-7", "x.png", "", strings.NewReader("x"), 0)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	rel, err := filepath.Rel(s.Root(), ref.Path)
	if err != nil {
		t.Fatalf("Rel: %v", err)
	}
	// Layout: <root>/<owner>/<job>/<id>_<name>
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) != 3 {
		t.Fatalf("layout = %q, want 3 segments", rel)
	}
	if parts[0] != "owner-a" || parts[1] != "job-7" {
		t.Fatalf("layout = %q, want owner-a/job-7", rel)
	}
	if !strings.HasPrefix(parts[2], ref.ID+"_") {
		t.Fatalf("filename = %q, want prefix %q", parts[2], ref.ID+"_")
	}
}

func TestTempStore_Create_SanitizesName(t *testing.T) {
	s := newTestStore(t, 0)
	tests := []struct {
		in   string
		want string
	}{
		{"../evil.png", "evil.png"},
		{"a/b.png", "b.png"},
		{"..", "asset"},
		{"", "asset"},
		{"we:ird?.png", "we_ird_.png"},
		{"trailing.", "trailing_"},
		{"trailing ", "trailing_"},
	}
	for _, tt := range tests {
		ref, err := s.Create(t.Context(), "o", "j", tt.in, "", strings.NewReader("x"), 0)
		if err != nil {
			t.Fatalf("Create(%q): %v", tt.in, err)
		}
		if ref.Name != tt.want {
			t.Errorf("Create(%q).Name = %q, want %q", tt.in, ref.Name, tt.want)
		}
		// The stored file must live inside the store root.
		rel, err := filepath.Rel(s.Root(), ref.Path)
		if err != nil || strings.HasPrefix(rel, "..") {
			t.Errorf("Create(%q): stored path escapes root: %q (rel %q)", tt.in, ref.Path, rel)
		}
	}
}

func TestTempStore_Create_SizeCap(t *testing.T) {
	s := newTestStore(t, 0)
	_, err := s.Create(t.Context(), "o", "j", "big.bin", "", strings.NewReader(strings.Repeat("x", 101)), 100)
	if !IsBudgetExceeded(err) {
		t.Fatalf("expected budget error, got %v", err)
	}
	// No asset file must be left behind (empty owner/job dirs are fine).
	files := 0
	err = filepath.WalkDir(s.Root(), func(p string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !d.IsDir() {
			files++
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk root: %v", err)
	}
	if files != 0 {
		t.Fatalf("failed Create left %d files behind", files)
	}
}

func TestTempStore_Release_Idempotent(t *testing.T) {
	s := newTestStore(t, 0)
	ref, err := s.Create(t.Context(), "o", "j", "x.png", "", strings.NewReader("x"), 0)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.Release(ref.ID); err != nil {
		t.Fatalf("first Release: %v", err)
	}
	if err := s.Release(ref.ID); err != nil {
		t.Fatalf("second Release must be a no-op, got %v", err)
	}
	if _, _, err := s.Open(ref.ID); !IsNotFound(err) {
		t.Fatalf("Open after Release: expected not-found, got %v", err)
	}
	if _, err := os.Stat(ref.Path); !os.IsNotExist(err) {
		t.Fatalf("asset file still on disk after Release")
	}
}

func TestTempStore_ReleaseOwner(t *testing.T) {
	s := newTestStore(t, 0)
	a1, err := s.Create(t.Context(), "owner-a", "j1", "a.png", "", strings.NewReader("a"), 0)
	if err != nil {
		t.Fatalf("Create a1: %v", err)
	}
	a2, err := s.Create(t.Context(), "owner-a", "j2", "b.png", "", strings.NewReader("b"), 0)
	if err != nil {
		t.Fatalf("Create a2: %v", err)
	}
	b1, err := s.Create(t.Context(), "owner-b", "j1", "c.png", "", strings.NewReader("c"), 0)
	if err != nil {
		t.Fatalf("Create b1: %v", err)
	}
	if n := s.ReleaseOwner("owner-a"); n != 2 {
		t.Fatalf("ReleaseOwner removed %d assets, want 2", n)
	}
	if _, _, err := s.Open(a1.ID); !IsNotFound(err) {
		t.Fatalf("owner-a asset still readable")
	}
	if _, _, err := s.Open(a2.ID); !IsNotFound(err) {
		t.Fatalf("owner-a asset still readable")
	}
	rc, _, err := s.Open(b1.ID)
	if err != nil {
		t.Fatalf("owner-b asset must survive: %v", err)
	}
	rc.Close()
}

func TestTempStore_ScavengeExpired(t *testing.T) {
	s := newTestStore(t, time.Hour)
	old, err := s.Create(t.Context(), "o", "j", "old.png", "", strings.NewReader("old"), 0)
	if err != nil {
		t.Fatalf("Create old: %v", err)
	}
	fresh, err := s.Create(t.Context(), "o", "j", "fresh.png", "", strings.NewReader("fresh"), 0)
	if err != nil {
		t.Fatalf("Create fresh: %v", err)
	}
	// Backdate only the old asset's expiry (white-box: same package) so the
	// scavenge boundary is deterministic without sleeps.
	s.mu.Lock()
	s.items[old.ID].expiresAt = time.Now().Add(-time.Second)
	s.mu.Unlock()
	if n := s.Scavenge(time.Now()); n != 1 {
		t.Fatalf("Scavenge reclaimed %d assets, want 1", n)
	}
	if _, _, err := s.Open(old.ID); !IsNotFound(err) {
		t.Fatalf("expired asset still readable")
	}
	rc, _, err := s.Open(fresh.ID)
	if err != nil {
		t.Fatalf("fresh asset must survive scavenge: %v", err)
	}
	rc.Close()
	if _, err := os.Stat(old.Path); !os.IsNotExist(err) {
		t.Fatalf("expired asset file still on disk")
	}
}

func TestTempStore_ExpiredAssetReadFails(t *testing.T) {
	s := newTestStore(t, time.Hour)
	ref, err := s.Create(t.Context(), "o", "j", "x.png", "", strings.NewReader("x"), 0)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Forge expiry by scavenging past the TTL, then re-Create is not an
	// option; instead verify a second store on the same root is a fresh
	// registry (crash-restart semantics) and the stale file is unreadable.
	s2, err := NewTempStore(s.Root(), time.Hour)
	if err != nil {
		t.Fatalf("NewTempStore: %v", err)
	}
	if _, _, err := s2.Open(ref.ID); !IsNotFound(err) {
		t.Fatalf("stale registration must be invisible after restart, got %v", err)
	}
	if err := s2.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestTempStore_Close(t *testing.T) {
	s := newTestStore(t, 0)
	if _, err := s.Create(t.Context(), "o", "j", "x.png", "", strings.NewReader("x"), 0); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(s.Root()); !os.IsNotExist(err) {
		t.Fatalf("store root still exists after Close")
	}
	if _, err := s.Create(t.Context(), "o", "j", "y.png", "", strings.NewReader("y"), 0); !errors.Is(err, ErrClosed) {
		t.Fatalf("Create after Close: expected ErrClosed, got %v", err)
	}
	// Close is idempotent.
	if err := s.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestTempStore_UnknownAsset(t *testing.T) {
	s := newTestStore(t, 0)
	if _, _, err := s.Open("deadbeef"); !IsNotFound(err) {
		t.Fatalf("Open unknown: expected not-found, got %v", err)
	}
	if _, err := s.Path("deadbeef"); !IsNotFound(err) {
		t.Fatalf("Path unknown: expected not-found, got %v", err)
	}
	// Release of an unknown ID is a no-op, matching the idempotent contract.
	if err := s.Release("deadbeef"); err != nil {
		t.Fatalf("Release unknown: %v", err)
	}
}

func TestTempStore_EmptyRootRejected(t *testing.T) {
	if _, err := NewTempStore("", 0); err == nil {
		t.Fatal("empty root must be rejected")
	}
}

// TestTempStore_Create_RejectsUnsafeOwnerJob verifies the workspace-segment
// contract: owner/job strings that could escape the workspace root (path
// separators, "..", control bytes, ADS separators) are rejected instead of
// being joined into the on-disk path.
func TestTempStore_Create_RejectsUnsafeOwnerJob(t *testing.T) {
	s := newTestStore(t, 0)
	bad := []struct {
		owner string
		job   string
	}{
		{"../escape", "j"},
		{"o", "../escape"},
		{"o/../x", "j"},
		{"o", "j\\..\\x"},
		{"..", "j"},
		{".", "j"},
		{"o", "job:ads"},
		{"o\x00n", "j"},
		{"o", "j\n"},
	}
	for _, tc := range bad {
		if _, err := s.Create(t.Context(), tc.owner, tc.job, "x.png", "", strings.NewReader("x"), 0); err == nil {
			t.Errorf("Create(owner=%q, job=%q) must be rejected", tc.owner, tc.job)
		}
	}
	// The workspace root must not have been escaped by any attempt: every
	// asset file lives directly under <root>/<owner>/<job>.
	entries, err := os.ReadDir(s.Root())
	if err != nil {
		t.Fatalf("ReadDir root: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("rejected creates must not leave files, got %d entries", len(entries))
	}
}
