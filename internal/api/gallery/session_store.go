// Code in this file: in-memory zip session store. Frontend: gallery-edit.js (zip session lifecycle).
//
// Every session is bound to the requesting owner (the browser session cookie
// stamped by the owner middleware): get/touch/update/remove/pin/unpin verify
// ownership, so a session id from another session resolves to 404/denied
// instead of leaking or mutating the other session's data (F-03/F-29).
package gallery

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

const (
	// galleryMaxSessions caps the number of in-memory zip sessions retained.
	// Sessions are evicted only by LRU once the store exceeds this capacity.
	// There is intentionally no short time-based TTL: a common usage pattern
	// is loading several archives and autoplaying through one while the
	// others sit idle. A short idle TTL would evict the idle archives
	// mid-session, surfacing as 404s when the user switches back to them.
	// Bounding by LRU alone keeps idle archives alive as long as they remain
	// within the most recently used set, which matches the single-user local
	// nature of the app.
	//
	// The capacity is set above the prior 32 to cover a typical bulk import
	// in one shot (the original 32 surfaced as "first N packs fail" because a
	// concurrent bulk upload evicted the earliest sessions before their
	// thumbnails were fetched). Eviction is no longer fatal regardless: the
	// frontend rehydrates an evicted session on 404 by re-uploading from the
	// pack's source (gallery-io.js rehydrateZipSession), and clears whole
	// sessions via DELETE /api/gallery/zip/{sessionId} when packs are removed.
	// 128 trades a higher worst-case resident memory ceiling for far less
	// re-upload churn; the per-session 500 MiB upload cap still bounds a
	// single session, and the single-user localhost deployment model keeps
	// the realistic working set well below this.
	galleryMaxSessions = 128

	// gallerySessionTTL bounds how long an untouched session may live. 24h
	// covers a browser session plus a next-day revisit; expiry is lazy
	// (checked on access/insert) so no timer is required and a short-lived
	// eviction can never interrupt an active session.
	gallerySessionTTL = 24 * time.Hour

	// galleryMaxSessionBytes caps the TOTAL resident zip bytes across all
	// sessions (docs/archive_compatibility_plan.md §4.3: 2 GiB). put evicts the
	// least-recently-used unpinned sessions while over budget; a single
	// upload larger than the whole budget is rejected with 413 (see
	// galleryListZip).
	galleryMaxSessionBytes = 2 << 30

	// galleryMaxPinnedBytes caps the total bytes of sessions pinned by AI
	// review tasks. Pins must never make the resident set unbounded: when the
	// pinned budget is exhausted, pin() refuses so the review pipeline sheds
	// load instead of ballooning memory.
	galleryMaxPinnedBytes = 4 << 30

	// galleryMaxConcurrentUploads caps simultaneous zip upload bodies being
	// read into memory (galleryListZip); excess uploads get 429.
	galleryMaxConcurrentUploads = 2
)

// zipSession holds an uploaded zip archive in memory along with bookkeeping
// for LRU eviction. pinCount prevents the session from being evicted while
// an AI review task is in progress. owner binds the session to the browser
// session that created it.
type zipSession struct {
	owner      string
	data       []byte
	createdAt  time.Time
	lastAccess time.Time
	pinCount   int32
}

// gallerySessionStore is a thread-safe, bounded LRU store of in-memory zip
// sessions. Retention is bounded by maxSessions (count), a lazy TTL
// (gallerySessionTTL) and maxBytes (total resident bytes); pins additionally
// honor maxPinnedBytes so pinned sessions cannot balloon the resident set.
// The limits are initialized to the galleryMax* constants by
// newGallerySessionStore and overridable in tests (the 2 GiB/4 GiB defaults
// cannot be exercised with real allocations).
type gallerySessionStore struct {
	mu          sync.RWMutex
	sessions    map[string]*zipSession
	order       []string // insertion/access order for LRU eviction
	totalBytes  int64
	pinnedBytes int64

	maxSessions    int
	maxBytes       int64
	maxPinnedBytes int64
}

func newGallerySessionStore() *gallerySessionStore {
	return &gallerySessionStore{
		sessions:       make(map[string]*zipSession),
		maxSessions:    galleryMaxSessions,
		maxBytes:       galleryMaxSessionBytes,
		maxPinnedBytes: galleryMaxPinnedBytes,
	}
}

// errSessionTooLarge is returned by put/update when a single session would
// exceed galleryMaxSessionBytes; the caller surfaces it as 413.
var errSessionTooLarge = errors.New("zip session exceeds total byte budget")

// expireLocked drops sessions whose TTL elapsed (caller holds mu) and adjusts
// the byte accounting.
func (s *gallerySessionStore) expireLocked(now time.Time) {
	for _, id := range s.order {
		sess, ok := s.sessions[id]
		if !ok {
			continue
		}
		if now.Sub(sess.lastAccess) > gallerySessionTTL {
			s.removeLocked(id)
		}
	}
}

// put stores data under sessionID for owner, evicting the
// least-recently-used unpinned session when the store is over the count or
// total-byte capacity. A session larger than the whole byte budget is refused
// with errSessionTooLarge so a huge upload cannot force out every other
// session.
func (s *gallerySessionStore) put(owner, sessionID string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.expireLocked(time.Now())
	if _, ok := s.sessions[sessionID]; ok {
		s.removeLocked(sessionID)
	}
	if int64(len(data)) > s.maxBytes {
		return errSessionTooLarge
	}
	now := time.Now()
	s.sessions[sessionID] = &zipSession{
		owner:      owner,
		data:       data,
		createdAt:  now,
		lastAccess: now,
	}
	s.order = append(s.order, sessionID)
	s.totalBytes += int64(len(data))

	for (len(s.order) > s.maxSessions || s.totalBytes > s.maxBytes) && s.evictOneLocked() {
	}
	return nil
}

// evictOneLocked removes the oldest unpinned session (caller holds mu) and
// reports whether anything was evicted.
func (s *gallerySessionStore) evictOneLocked() bool {
	for i, id := range s.order {
		if sess, ok := s.sessions[id]; ok && sess.pinCount == 0 {
			s.removeLocked(s.order[i])
			return true
		}
	}
	return false // all remaining sessions are pinned
}

// touch updates the last-access time of an owner's session and moves it to
// the most-recently-used position without returning its data. Returns false
// if the session does not exist, expired, or belongs to another owner. The
// frontend calls POST /zip/{sessionId}/touch when a pack becomes the main
// view, so the currently-viewed session is not the first candidate for LRU
// eviction while the user is looking at it.
func (s *gallerySessionStore) touch(owner, sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return false
	}
	if sess.owner != owner {
		// Foreign session: fail closed WITHOUT deleting or mutating the
		// owner's session (F-29). Only the owner's own access may trigger
		// lazy TTL eviction below.
		return false
	}
	if time.Since(sess.lastAccess) > gallerySessionTTL {
		s.removeLocked(sessionID)
		return false
	}
	sess.lastAccess = time.Now()
	s.bumpLocked(sessionID)
	return true
}

func (s *gallerySessionStore) get(owner, sessionID string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return nil, false
	}
	if sess.owner != owner {
		// Foreign session: fail closed WITHOUT deleting or mutating the
		// owner's session (F-29).
		return nil, false
	}
	if time.Since(sess.lastAccess) > gallerySessionTTL {
		s.removeLocked(sessionID)
		return nil, false
	}
	sess.lastAccess = time.Now()
	s.bumpLocked(sessionID)
	return sess.data, true
}

// update replaces the stored zip data for an owner's session and refreshes
// its last-access time. Returns (false, nil) when the session does not exist,
// expired, or belongs to another owner, and (false, errSessionTooLarge) when
// the replacement exceeds the single-session byte budget (the session is left
// untouched).
func (s *gallerySessionStore) update(owner, sessionID string, data []byte) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return false, nil
	}
	if sess.owner != owner {
		// Foreign session: fail closed WITHOUT deleting or mutating the
		// owner's session (F-29).
		return false, nil
	}
	if time.Since(sess.lastAccess) > gallerySessionTTL {
		s.removeLocked(sessionID)
		return false, nil
	}
	if int64(len(data)) > s.maxBytes {
		return false, errSessionTooLarge
	}
	s.totalBytes += int64(len(data)) - int64(len(sess.data))
	sess.data = data
	sess.lastAccess = time.Now()
	s.bumpLocked(sessionID)
	return true, nil
}

// remove deletes an owner's session by id. A foreign owner's session is left
// untouched.
func (s *gallerySessionStore) remove(owner, sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess, ok := s.sessions[sessionID]; ok && sess.owner == owner {
		s.removeLocked(sessionID)
	}
}

// clearOwner removes all sessions created by owner (or all if owner is empty).
func (s *gallerySessionStore) clearOwner(owner string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range append([]string(nil), s.order...) {
		if sess, ok := s.sessions[id]; ok && (owner == "" || sess.owner == owner) {
			s.removeLocked(id)
		}
	}
}

// removeLocked deletes a single session under lock (caller must hold mu).
func (s *gallerySessionStore) removeLocked(sessionID string) {
	sess, ok := s.sessions[sessionID]
	if !ok {
		return
	}
	delete(s.sessions, sessionID)
	s.totalBytes -= int64(len(sess.data))
	if sess.pinCount > 0 {
		s.pinnedBytes -= int64(len(sess.data))
	}
	for i, id := range s.order {
		if id == sessionID {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}

// pin increments the pin count for an owner's session, preventing LRU
// eviction. Returns false when the session is missing/expired/foreign or when
// pinning it would exceed the pinned-byte budget (galleryMaxPinnedBytes).
func (s *gallerySessionStore) pin(owner, sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return false
	}
	if sess.owner != owner {
		// Foreign session: fail closed WITHOUT deleting or mutating the
		// owner's session (F-29).
		return false
	}
	if time.Since(sess.lastAccess) > gallerySessionTTL {
		s.removeLocked(sessionID)
		return false
	}
	if sess.pinCount == 0 && s.pinnedBytes+int64(len(sess.data)) > s.maxPinnedBytes {
		return false
	}
	if sess.pinCount == 0 {
		s.pinnedBytes += int64(len(sess.data))
	}
	sess.pinCount++
	return true
}

// unpin decrements the pin count for an owner's session.
func (s *gallerySessionStore) unpin(owner, sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok || sess.owner != owner {
		return false
	}
	if sess.pinCount > 0 {
		sess.pinCount--
		if sess.pinCount == 0 {
			s.pinnedBytes -= int64(len(sess.data))
		}
	}
	return true
}

// bumpLocked moves sessionID to the most-recently-used position (caller holds mu).
func (s *gallerySessionStore) bumpLocked(sessionID string) {
	for i, id := range s.order {
		if id == sessionID {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
	s.order = append(s.order, sessionID)
}

// newGallerySessionID returns a short random hex identifier for a zip session.
// Returns an error if the system's crypto/rand fails, so the caller can
// respond with 500 instead of silently using a colliding constant.
func newGallerySessionID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate session id: %w", err)
	}
	return hex.EncodeToString(b), nil
}
