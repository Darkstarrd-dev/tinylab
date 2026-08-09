package gallery

import (
	"testing"
	"time"
)

// Deterministic store-level tests for the owner boundary (F-29): a foreign
// get/touch/update/pin/remove/unpin must fail closed and must NEVER delete or
// mutate the owner's session. Regression: the foreign path of get/touch/
// update/pin called removeLocked on owner mismatch, purging the owner's
// session on any cross-session access.

const (
	ownerA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	ownerB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// TestSessionStore_ForeignAccessNeverPurgesOwnerSession exercises every
// store operation from a foreign owner and proves the owner's session and its
// data survive untouched.
func TestSessionStore_ForeignAccessNeverPurgesOwnerSession(t *testing.T) {
	s := newGallerySessionStore()
	if err := s.put(ownerA, "s1", []byte("owner-data")); err != nil {
		t.Fatalf("put: %v", err)
	}

	// Foreign get must fail closed without removing the session.
	if data, ok := s.get(ownerB, "s1"); ok {
		t.Fatalf("foreign get succeeded: %q", data)
	}
	// Foreign touch must fail closed.
	if s.touch(ownerB, "s1") {
		t.Fatal("foreign touch succeeded")
	}
	// Foreign update must fail closed and must not replace the data.
	if ok, err := s.update(ownerB, "s1", []byte("tampered")); ok || err != nil {
		t.Fatalf("foreign update = (%v, %v), want (false, nil)", ok, err)
	}
	// Foreign pin must fail closed (and therefore must not pin, either).
	if s.pin(ownerB, "s1") {
		t.Fatal("foreign pin succeeded")
	}
	// Foreign remove must be a no-op.
	s.remove(ownerB, "s1")
	// Foreign unpin must fail closed.
	if s.unpin(ownerB, "s1") {
		t.Fatal("foreign unpin succeeded")
	}

	// The owner's session must still exist with its original data and be
	// fully usable (including pin/unpin for the review flow).
	data, ok := s.get(ownerA, "s1")
	if !ok {
		t.Fatal("owner session was purged by foreign access")
	}
	if string(data) != "owner-data" {
		t.Fatalf("owner session data changed by foreign access: %q", data)
	}
	if !s.pin(ownerA, "s1") {
		t.Fatal("owner pin failed after foreign attempts")
	}
	if !s.unpin(ownerA, "s1") {
		t.Fatal("owner unpin failed after foreign attempts")
	}
}

// TestSessionStore_ForeignAccessMissingSession is the degenerate case: a
// session that does not exist at all must also fail closed (no panic, no
// mutation) for every operation.
func TestSessionStore_ForeignAccessMissingSession(t *testing.T) {
	s := newGallerySessionStore()
	if _, ok := s.get(ownerB, "missing"); ok {
		t.Fatal("get on missing session must return !ok")
	}
	if s.touch(ownerB, "missing") {
		t.Fatal("touch on missing session must return false")
	}
	if ok, err := s.update(ownerB, "missing", []byte("x")); ok || err != nil {
		t.Fatalf("update on missing session = (%v, %v), want (false, nil)", ok, err)
	}
	if s.pin(ownerB, "missing") {
		t.Fatal("pin on missing session must return false")
	}
	s.remove(ownerB, "missing")
	if s.unpin(ownerB, "missing") {
		t.Fatal("unpin on missing session must return false")
	}
}

// TestSessionStore_OwnerAccessStillEvictsExpired pins that the lazy TTL
// eviction contract is preserved for the OWNER: an expired session is still
// removed (and its bytes reclaimed) when the owner accesses it, so the fix
// only narrowed the destructive path to non-owners.
func TestSessionStore_OwnerAccessStillEvictsExpired(t *testing.T) {
	s := newGallerySessionStore()
	if err := s.put(ownerA, "old", []byte("old-data")); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.sessions["old"].lastAccess = s.sessions["old"].lastAccess.Add(-gallerySessionTTL - time.Second)
	s.mu.Unlock()
	if _, ok := s.get(ownerA, "old"); ok {
		t.Fatal("expired session must not be readable by its owner")
	}
	if s.totalBytes != 0 {
		t.Fatalf("expired session bytes not reclaimed: totalBytes = %d", s.totalBytes)
	}
}
