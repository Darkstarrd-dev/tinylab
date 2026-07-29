// Code in this file: in-memory zip session store (Fix 1 split from register.go). Frontend: gallery-edit.js (zip session lifecycle).
package gallery

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

const (
	// galleryMaxSessions caps the number of in-memory zip sessions retained.
	// Sessions are evicted only by LRU once the store exceeds this capacity.
	// There is intentionally no time-based TTL: a common usage pattern is
	// loading several archives and autoplaying through one while the others
	// sit idle. A short idle TTL would evict the idle archives mid-session,
	// surfacing as 404s when the user switches back to them. Bounding by LRU
	// alone keeps idle archives alive as long as they remain within the most
	// recently used set, which matches the single-user local nature of the app.
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
)

// zipSession holds an uploaded zip archive in memory along with bookkeeping
// for LRU eviction. pinCount prevents the session from being evicted while
// an AI review task is in progress.
type zipSession struct {
	data       []byte
	createdAt  time.Time
	lastAccess time.Time
	pinCount   int32
}

// gallerySessionStore is a thread-safe, bounded LRU store of in-memory zip
// sessions. Retention is bounded solely by galleryMaxSessions via LRU
// eviction; there is no time-based expiry.
type gallerySessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*zipSession
	order    []string // insertion/access order for LRU eviction
}

func newGallerySessionStore() *gallerySessionStore {
	return &gallerySessionStore{
		sessions: make(map[string]*zipSession),
	}
}

// put stores data under sessionID, evicting the least-recently-used session
// when the store is over capacity.
func (s *gallerySessionStore) put(sessionID string, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.sessions[sessionID]; ok {
		s.removeLocked(sessionID)
	}
	s.sessions[sessionID] = &zipSession{
		data:       data,
		createdAt:  time.Now(),
		lastAccess: time.Now(),
	}
	s.order = append(s.order, sessionID)

	for len(s.order) > galleryMaxSessions {
		evicted := false
		for i, id := range s.order {
			if sess, ok := s.sessions[id]; ok && sess.pinCount == 0 {
				s.removeLocked(s.order[i])
				evicted = true
				break
			}
		}
		if !evicted {
			break // all remaining sessions are pinned
		}
	}
}

// touch updates the last-access time of sessionID and moves it to the
// most-recently-used position without returning its data. Returns false if
// the session does not exist. The frontend calls POST /zip/{sessionId}/touch
// when a pack becomes the main view, so the currently-viewed session is not
// the first candidate for LRU eviction while the user is looking at it.
func (s *gallerySessionStore) touch(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return false
	}
	sess.lastAccess = time.Now()
	s.bumpLocked(sessionID)
	return true
}

// get returns the session data for sessionID and updates its last-access time.
func (s *gallerySessionStore) get(sessionID string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return nil, false
	}
	sess.lastAccess = time.Now()
	s.bumpLocked(sessionID)
	return sess.data, true
}

// update replaces the stored zip data for an existing session and refreshes
// its last-access time. Returns false if the session does not exist.
func (s *gallerySessionStore) update(sessionID string, data []byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return false
	}
	sess.data = data
	sess.lastAccess = time.Now()
	s.bumpLocked(sessionID)
	return true
}

// remove deletes a session by id.
func (s *gallerySessionStore) remove(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removeLocked(sessionID)
}

// removeLocked deletes a single session under lock (caller must hold mu).
func (s *gallerySessionStore) removeLocked(sessionID string) {
	delete(s.sessions, sessionID)
	for i, id := range s.order {
		if id == sessionID {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}

// pin increments the pin count for a session, preventing LRU eviction.
func (s *gallerySessionStore) pin(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return false
	}
	sess.pinCount++
	return true
}

// unpin decrements the pin count for a session.
func (s *gallerySessionStore) unpin(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return false
	}
	if sess.pinCount > 0 {
		sess.pinCount--
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
