// Package pathgrant implements the server-side path-grant registry: a
// short-TTL, owner-bound capability that authorizes a specific local path for
// a specific operation (read/write/delete/export) without ever handing the
// browser the physical path. Paths are only registered by explicit user
// actions the server itself performed (native pickers, clipboard reads), and
// every later resolution re-verifies ownership, operation, TTL, and — for
// directory grants — canonical root containment including symlink escape
// checks.
//
// The grant ID is the only value that crosses to the browser. Knowing a grant
// ID is useless without the matching owner cookie, and grants expire within
// minutes, so a stale or leaked ID degrades to a denied lookup.
package pathgrant

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Operation is the capability a grant confers.
type Operation string

const (
	// OpRead authorizes opening/reading the granted path.
	OpRead Operation = "read"
	// OpWrite authorizes creating/overwriting the granted path (or files
	// within a granted directory).
	OpWrite Operation = "write"
	// OpDelete authorizes removing the granted path.
	OpDelete Operation = "delete"
	// OpExport authorizes reading the path for outbound packaging (e.g.
	// FileTransfer ZIP upload to an external service).
	OpExport Operation = "export"
)

// DefaultTTL is how long an unused grant lives before Scavenge reclaims it.
const DefaultTTL = 30 * time.Minute

// maxGrantsPerOwner bounds how many concurrent grants one owner may hold, so
// a single session cannot grow the registry without bound.
const maxGrantsPerOwner = 256

// ErrDenied reports a failed authorization: unknown grant, expired grant,
// owner mismatch, or operation not granted. It deliberately does not say
// which, so callers cannot probe the registry.
var ErrDenied = errors.New("path grant denied")

// ErrUnsafePath reports a relative path that could escape its grant root.
var ErrUnsafePath = errors.New("unsafe path")

// IsDenied reports whether err is (or wraps) ErrDenied.
func IsDenied(err error) bool { return errors.Is(err, ErrDenied) }

// Grant is one registered path capability. Path is server-side only and never
// serialized to the browser.
type Grant struct {
	ID        string
	Owner     string
	Path      string // canonical (realpath) server-side path
	Ops       map[Operation]bool
	Dir       bool // directory grant: children resolved via ResolveChild
	OneShot   bool // revoked after the first successful resolution
	ExpiresAt time.Time
}

// Store is a thread-safe, bounded registry of owner-bound path grants.
type Store struct {
	mu     sync.Mutex
	ttl    time.Duration
	grants map[string]*Grant
}

// NewStore creates an empty grant store. ttl <= 0 selects DefaultTTL.
func NewStore(ttl time.Duration) *Store {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &Store{ttl: ttl, grants: make(map[string]*Grant)}
}

// Grant registers path under owner with the given operations. The path is
// canonicalized (Abs + EvalSymlinks) and must be a non-symlink existing file
// or directory at registration time; directory grants require a directory.
// Returns the grant the caller may hand to the browser.
func (s *Store) Grant(owner string, ops []Operation, path string, dir, oneShot bool) (*Grant, error) {
	if owner == "" {
		return nil, errors.New("path grant requires an owner")
	}
	if len(ops) == 0 {
		return nil, errors.New("path grant requires at least one operation")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("path grant abs: %w", err)
	}
	fi, err := os.Lstat(abs)
	if err != nil {
		return nil, fmt.Errorf("path grant stat %q: %w", abs, err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("path grant rejects symbolic links: %q", abs)
	}
	if dir && !fi.IsDir() {
		return nil, fmt.Errorf("path grant expects a directory: %q", abs)
	}
	if !dir && !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("path grant expects a regular file: %q", abs)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, fmt.Errorf("path grant realpath %q: %w", abs, err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	// Prune this owner's expired grants before enforcing the cap.
	for id, g := range s.grants {
		if g.Owner == owner && now.After(g.ExpiresAt) {
			delete(s.grants, id)
		}
	}
	count := 0
	for _, g := range s.grants {
		if g.Owner == owner {
			count++
		}
	}
	if count >= maxGrantsPerOwner {
		return nil, fmt.Errorf("path grant per-owner limit (%d) reached", maxGrantsPerOwner)
	}

	id, err := newGrantID()
	if err != nil {
		return nil, err
	}
	opSet := make(map[Operation]bool, len(ops))
	for _, op := range ops {
		opSet[op] = true
	}
	g := &Grant{
		ID:        id,
		Owner:     owner,
		Path:      real,
		Ops:       opSet,
		Dir:       dir,
		OneShot:   oneShot,
		ExpiresAt: now.Add(s.ttl),
	}
	s.grants[id] = g
	return g, nil
}

// Resolve returns the granted canonical path when owner holds id with the
// given operation and the grant has not expired. One-shot grants are revoked
// on first successful use.
func (s *Store) Resolve(owner, id string, op Operation) (string, error) {
	s.mu.Lock()
	g, ok := s.validLocked(owner, id, op)
	if ok && g.OneShot {
		delete(s.grants, id)
	}
	s.mu.Unlock()
	if !ok {
		return "", ErrDenied
	}
	return g.Path, nil
}

// Rebind updates a non-directory grant's canonical path after the owning
// handler has atomically renamed the granted file. The owner and write
// capability are rechecked so stale or foreign grants cannot be rebound.
func (s *Store) Rebind(owner, id, path string) error {
	if owner == "" || id == "" || path == "" {
		return ErrDenied
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return ErrDenied
	}
	fi, err := os.Lstat(abs)
	if err != nil || fi.Mode()&os.ModeSymlink != 0 || !fi.Mode().IsRegular() {
		return ErrDenied
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return ErrDenied
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.validLocked(owner, id, OpWrite)
	if !ok || g.Dir {
		return ErrDenied
	}
	g.Path = real
	return nil
}

// ResolveChild resolves rel (a strict relative slash path) under a directory
// grant to its canonical on-disk path. The resolved path must stay inside the
// granted root after symlink resolution; a non-existent leaf is allowed only
// when its real parent stays inside the root (write/delete targets). One-shot
// grants are revoked on first successful use.
func (s *Store) ResolveChild(owner, id, rel string, op Operation) (string, error) {
	s.mu.Lock()
	g, ok := s.validLocked(owner, id, op)
	if ok && g.OneShot {
		delete(s.grants, id)
	}
	s.mu.Unlock()
	if !ok {
		return "", ErrDenied
	}
	if !g.Dir {
		return "", ErrDenied
	}
	clean, err := strictRel(rel)
	if err != nil {
		return "", err
	}
	full := filepath.Join(g.Path, filepath.FromSlash(clean))
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		// The leaf may not exist yet (new write target). Containment must
		// still hold for its real parent directory.
		realParent, perr := filepath.EvalSymlinks(filepath.Dir(full))
		if perr != nil {
			return "", ErrDenied
		}
		if !within(realParent, g.Path) {
			return "", ErrDenied
		}
		return full, nil
	}
	if !within(real, g.Path) {
		return "", ErrDenied
	}
	return full, nil
}

// Revoke removes a grant owned by owner. Returns false when the grant was
// unknown or owned by someone else (revocation is owner-scoped).
func (s *Store) Revoke(owner, id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.grants[id]
	if !ok || g.Owner != owner {
		return false
	}
	delete(s.grants, id)
	return true
}

// Scavenge removes every grant expired before now and returns the count
// reclaimed. Safe to call concurrently with other operations.
func (s *Store) Scavenge(now time.Time) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for id, g := range s.grants {
		if now.After(g.ExpiresAt) {
			delete(s.grants, id)
			n++
		}
	}
	return n
}

// validLocked resolves a grant under the lock and checks owner, operation,
// and expiry. Caller must hold s.mu.
func (s *Store) validLocked(owner, id string, op Operation) (*Grant, bool) {
	g, ok := s.grants[id]
	if !ok || g.Owner != owner {
		return nil, false
	}
	if time.Now().After(g.ExpiresAt) {
		delete(s.grants, id)
		return nil, false
	}
	if !g.Ops[op] {
		return nil, false
	}
	return g, true
}

// StrictRel validates a browser-supplied relative path: slash-separated, no
// leading separator, no drive/UNC/ADS, no "." or ".." segments, no control
// bytes or NUL, no trailing dots/spaces, never empty. It returns the cleaned
// slash-normalized relative path. Callers resolving a path under a server
// root must additionally verify canonical containment (see ResolveChild).
func StrictRel(rel string) (string, error) {
	return strictRel(rel)
}

// strictRel validates a browser-supplied relative path: slash-separated, no
// leading separator, no drive/UNC/ADS, no "." or ".." segments, no control
// bytes or NUL, no trailing dots/spaces, never empty. It returns the cleaned
// slash-normalized relative path.
func strictRel(rel string) (string, error) {
	if rel == "" {
		return "", ErrUnsafePath
	}
	if strings.IndexByte(rel, 0) >= 0 {
		return "", ErrUnsafePath
	}
	// Normalize separators for validation only: backslashes are treated as
	// separators so a Windows-style traversal attempt cannot hide from the
	// segment checks below.
	norm := strings.ReplaceAll(rel, `\`, "/")
	if strings.HasPrefix(norm, "/") {
		return "", ErrUnsafePath
	}
	if strings.Contains(norm, ":") {
		return "", ErrUnsafePath // drive letter or ADS
	}
	segments := strings.Split(norm, "/")
	for _, seg := range segments {
		if seg == "" || seg == "." || seg == ".." {
			return "", ErrUnsafePath
		}
		if strings.HasSuffix(seg, ".") || strings.HasSuffix(seg, " ") {
			return "", ErrUnsafePath // Windows-equivalent names
		}
	}
	return norm, nil
}

// within reports whether child equals root or lives under it.
func within(child, root string) bool {
	if child == root {
		return true
	}
	return strings.HasPrefix(child, root+string(os.PathSeparator))
}

// newGrantID returns a random 128-bit hex grant identifier.
func newGrantID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
