package archive

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// DefaultTempTTL is how long an unreleased asset lives before Scavenge
// reclaims it. 24 hours covers a browser session plus the next-day restart
// scavenger without pinning disk forever.
const DefaultTempTTL = 24 * time.Hour

// Workspace quotas (docs/audit_fix.md F-15/F-29, docs/archive_compatibility_plan.md
// §4.3). A single owner cannot grow the workspace without bound, a single job
// cannot exceed its own budget, and the whole store stays under a global cap
// even when many owners are active.
const (
	// DefaultMaxAssetsPerOwner caps the number of live assets one owner may
	// hold.
	DefaultMaxAssetsPerOwner = 512
	// DefaultMaxBytesPerOwner caps total asset bytes per owner (4 GiB).
	DefaultMaxBytesPerOwner = 4 << 30
	// DefaultMaxBytesPerJob caps total asset bytes per owner+job pair
	// (2 GiB, matching the plan §4.3 per-pack/session workspace budget).
	DefaultMaxBytesPerJob = 2 << 30
	// DefaultMaxBytesGlobal caps total asset bytes across all owners (8 GiB).
	DefaultMaxBytesGlobal = 8 << 30
)

// TempStore is a file-backed, owner/job-bound temporary asset store. Assets
// live under <root>/<owner>/<job>/<id>_<name>; every operation is bound to
// the owner and job that registered it, and the client only ever sees the
// random asset ID. The server-side path is resolved internally.
//
// A TempStore must be closed (or its root scavenged after a crash) so
// expired or abandoned workspaces do not leak disk. NewTempStore starts a
// background scavenger that reclaims expired assets periodically; Close stops
// it and removes the whole root.
type TempStore struct {
	root   string
	ttl    time.Duration
	mu     sync.Mutex
	items  map[string]*item
	closed bool

	// Quota accounting, guarded by mu.
	ownerCount  map[string]int
	ownerBytes  map[string]int64
	jobBytes    map[string]int64 // key "<owner>|<job>"
	globalBytes int64

	// Quota limits; initialized to the Default* constants by NewTempStore and
	// overridable in tests.
	maxAssetsPerOwner int
	maxBytesPerOwner  int64
	maxBytesPerJob    int64
	maxBytesGlobal    int64

	stopScavenge chan struct{}
	scavengeOnce sync.Once
}

type item struct {
	id        string
	owner     string
	jobID     string
	name      string
	mime      string
	path      string
	size      int64
	createdAt time.Time
	expiresAt time.Time
}

// NewTempStore creates the private workspace root (0700). ttl <= 0 selects
// DefaultTempTTL. A background goroutine scavenges expired assets on a
// ttl/4 cadence (capped to [1 minute, 6 hours]) until Close.
func NewTempStore(root string, ttl time.Duration) (*TempStore, error) {
	if root == "" {
		return nil, errors.New("temp store root is empty")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create temp store root: %w", err)
	}
	if ttl <= 0 {
		ttl = DefaultTempTTL
	}
	s := &TempStore{
		root:              root,
		ttl:               ttl,
		items:             make(map[string]*item),
		ownerCount:        make(map[string]int),
		ownerBytes:        make(map[string]int64),
		jobBytes:          make(map[string]int64),
		maxAssetsPerOwner: DefaultMaxAssetsPerOwner,
		maxBytesPerOwner:  DefaultMaxBytesPerOwner,
		maxBytesPerJob:    DefaultMaxBytesPerJob,
		maxBytesGlobal:    DefaultMaxBytesGlobal,
		stopScavenge:      make(chan struct{}),
	}
	go s.scavengeLoop()
	return s, nil
}

// Root returns the private workspace root directory.
func (s *TempStore) Root() string { return s.root }

// TTL returns the store's asset lifetime.
func (s *TempStore) TTL() time.Duration { return s.ttl }

// scavengeLoop periodically reclaims expired assets until Close.
func (s *TempStore) scavengeLoop() {
	interval := s.ttl / 4
	if interval < time.Minute {
		interval = time.Minute
	}
	if interval > 6*time.Hour {
		interval = 6 * time.Hour
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			s.Scavenge(time.Now())
		case <-s.stopScavenge:
			return
		}
	}
}

// Create stores r as a new asset owned by owner/jobID. name is sanitized to a
// safe basename before it is used on disk; the returned AssetRef carries the
// sanitized name. maxBytes caps the asset; a non-positive value selects
// DefaultAssetBytes. Quotas (per-owner count/bytes, per-job bytes, global
// bytes) are enforced before any bytes are written; exceeding one returns a
// *BudgetError.
func (s *TempStore) Create(ctx context.Context, owner, jobID, name, mime string, r io.Reader, maxBytes int64) (*AssetRef, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if owner == "" {
		owner = "anonymous"
	}
	if jobID == "" {
		jobID = "default"
	}
	// Owner and job are server-issued workspace segments; they are joined
	// into the on-disk path below, so a caller that ever passes untrusted
	// input must not be able to escape the workspace root. Reject any value
	// that is not a single safe segment (no separators, no "." / "..", no
	// control bytes, no Windows ADS separator).
	if !validWorkspaceSegment(owner) {
		return nil, fmt.Errorf("invalid asset owner segment %q", owner)
	}
	if !validWorkspaceSegment(jobID) {
		return nil, fmt.Errorf("invalid asset job segment %q", jobID)
	}
	if maxBytes <= 0 {
		maxBytes = DefaultAssetBytes
	}
	if err := s.checkQuota(owner, jobID, maxBytes); err != nil {
		return nil, err
	}
	id, err := newAssetID()
	if err != nil {
		return nil, err
	}
	base := sanitizeAssetName(name)
	dir := filepath.Join(s.root, owner, jobID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create asset workspace: %w", err)
	}
	path := filepath.Join(dir, id+"_"+base)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create asset file: %w", err)
	}
	n, copyErr := io.Copy(f, NewCapReader(r, maxBytes))
	closeErr := f.Close()
	if copyErr != nil {
		os.Remove(path)
		return nil, fmt.Errorf("write asset: %w", copyErr)
	}
	if closeErr != nil {
		os.Remove(path)
		return nil, fmt.Errorf("close asset: %w", closeErr)
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		os.Remove(path)
		return nil, ErrClosed
	}
	// The quota could have been consumed by a concurrent Create while we
	// were writing; re-check under the lock and roll back on conflict.
	if err := s.checkQuotaLocked(owner, jobID, n); err != nil {
		s.mu.Unlock()
		os.Remove(path)
		return nil, err
	}
	now := time.Now()
	it := &item{
		id:        id,
		owner:     owner,
		jobID:     jobID,
		name:      base,
		mime:      mime,
		path:      path,
		size:      n,
		createdAt: now,
		expiresAt: now.Add(s.ttl),
	}
	s.items[id] = it
	s.accountLocked(it, 1)
	s.mu.Unlock()
	return &AssetRef{ID: id, Owner: owner, JobID: jobID, Name: base, MIME: mime, Path: path, Size: n, ExpiresAt: it.expiresAt}, nil
}

// Open returns a reader for the asset plus its metadata, verifying that the
// caller's owner registered the asset. Expired assets are treated as missing
// (the scavenger reclaims the file).
func (s *TempStore) Open(owner, id string) (io.ReadCloser, *AssetRef, error) {
	it, ok := s.lookup(owner, id)
	if !ok {
		return nil, nil, fmt.Errorf("asset %s: %w", id, ErrEntryNotFound)
	}
	f, err := os.Open(it.path)
	if err != nil {
		return nil, nil, fmt.Errorf("open asset %s: %w", id, err)
	}
	return f, s.refFor(it), nil
}

// Path returns the server-side filesystem path of the asset, for internal
// consumers such as FFmpeg. The path must never be returned to the browser.
// The caller's owner must match the asset's owner.
func (s *TempStore) Path(owner, id string) (string, error) {
	it, ok := s.lookup(owner, id)
	if !ok {
		return "", fmt.Errorf("asset %s: %w", id, ErrEntryNotFound)
	}
	return it.path, nil
}

// Stat returns the registered metadata of the asset, verifying ownership.
func (s *TempStore) Stat(owner, id string) (*AssetRef, error) {
	it, ok := s.lookup(owner, id)
	if !ok {
		return nil, fmt.Errorf("asset %s: %w", id, ErrEntryNotFound)
	}
	return s.refFor(it), nil
}

func (s *TempStore) refFor(it *item) *AssetRef {
	return &AssetRef{
		ID:        it.id,
		Owner:     it.owner,
		JobID:     it.jobID,
		Name:      it.name,
		MIME:      it.mime,
		Path:      it.path,
		Size:      it.size,
		ExpiresAt: it.expiresAt,
	}
}

func (s *TempStore) lookup(owner, id string) (*item, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	it, ok := s.items[id]
	if !ok {
		return nil, false
	}
	if it.owner != owner {
		// Deliberately indistinguishable from "not found": the caller must
		// not be able to probe foreign resources.
		return nil, false
	}
	if !it.expiresAt.IsZero() && time.Now().After(it.expiresAt) {
		return nil, false
	}
	return it, true
}

// Release removes the asset file and its registration, verifying that the
// caller's owner registered the asset. It is idempotent for the owning
// session: releasing a missing or already-released asset is not an error. A
// foreign owner receives ErrOwnership.
func (s *TempStore) Release(owner, id string) error {
	s.mu.Lock()
	it, ok := s.items[id]
	if ok && it.owner != owner {
		s.mu.Unlock()
		return fmt.Errorf("release asset %s: %w", id, ErrOwnership)
	}
	if ok {
		delete(s.items, id)
		s.accountLocked(it, -1)
	}
	s.mu.Unlock()
	if !ok {
		return nil
	}
	if err := os.Remove(it.path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove asset %s: %w", id, err)
	}
	return nil
}

// ReleaseOwner releases every asset registered under owner, returning the
// number removed.
func (s *TempStore) ReleaseOwner(owner string) int {
	s.mu.Lock()
	var victim []*item
	for id, it := range s.items {
		if it.owner == owner {
			victim = append(victim, it)
			delete(s.items, id)
			s.accountLocked(it, -1)
		}
	}
	s.mu.Unlock()
	for _, it := range victim {
		os.Remove(it.path)
	}
	return len(victim)
}

// Scavenge removes every asset expired before now and returns the count
// reclaimed. It is safe to call concurrently with other operations.
func (s *TempStore) Scavenge(now time.Time) int {
	s.mu.Lock()
	var victim []*item
	for id, it := range s.items {
		if !it.expiresAt.IsZero() && now.After(it.expiresAt) {
			victim = append(victim, it)
			delete(s.items, id)
			s.accountLocked(it, -1)
		}
	}
	s.mu.Unlock()
	for _, it := range victim {
		os.Remove(it.path)
	}
	return len(victim)
}

// Close marks the store closed and removes the whole workspace root. Later
// Create calls return ErrClosed; later Open/Release calls behave as if the
// asset were never registered.
func (s *TempStore) Close() error {
	s.scavengeOnce.Do(func() { close(s.stopScavenge) })
	s.mu.Lock()
	closed := s.closed
	s.closed = true
	s.items = make(map[string]*item)
	s.ownerCount = make(map[string]int)
	s.ownerBytes = make(map[string]int64)
	s.jobBytes = make(map[string]int64)
	s.globalBytes = 0
	s.mu.Unlock()
	if closed {
		return nil
	}
	return os.RemoveAll(s.root)
}

// checkQuota validates the per-owner/job/global budgets before a write of
// size bytes starts.
func (s *TempStore) checkQuota(owner, jobID string, size int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.checkQuotaLocked(owner, jobID, size)
}

// checkQuotaLocked validates budgets under the lock; the caller holds s.mu.
func (s *TempStore) checkQuotaLocked(owner, jobID string, size int64) error {
	if s.ownerCount[owner] >= s.maxAssetsPerOwner {
		return &BudgetError{Dimension: "owner-assets", Limit: int64(s.maxAssetsPerOwner), Actual: int64(s.ownerCount[owner]) + 1}
	}
	if s.ownerBytes[owner]+size > s.maxBytesPerOwner {
		return &BudgetError{Dimension: "owner-bytes", Limit: s.maxBytesPerOwner, Actual: s.ownerBytes[owner] + size}
	}
	jobKey := owner + "|" + jobID
	if s.jobBytes[jobKey]+size > s.maxBytesPerJob {
		return &BudgetError{Dimension: "job-bytes", Limit: s.maxBytesPerJob, Actual: s.jobBytes[jobKey] + size}
	}
	if s.globalBytes+size > s.maxBytesGlobal {
		return &BudgetError{Dimension: "global-bytes", Limit: s.maxBytesGlobal, Actual: s.globalBytes + size}
	}
	return nil
}

// accountLocked applies a +1/-1 registration delta to the quota counters.
// Caller holds s.mu.
func (s *TempStore) accountLocked(it *item, delta int) {
	s.ownerCount[it.owner] += delta
	s.ownerBytes[it.owner] += int64(delta) * it.size
	s.jobBytes[it.owner+"|"+it.jobID] += int64(delta) * it.size
	s.globalBytes += int64(delta) * it.size
	if s.ownerCount[it.owner] <= 0 {
		delete(s.ownerCount, it.owner)
		delete(s.ownerBytes, it.owner)
	}
	jobKey := it.owner + "|" + it.jobID
	if s.jobBytes[jobKey] <= 0 {
		delete(s.jobBytes, jobKey)
	}
}

// basename for the private workspace: no path separators, no control bytes,
// no Windows-reserved characters or trailing dots/spaces, never "." or "..".
func sanitizeAssetName(name string) string {
	base := filepath.Base(filepath.ToSlash(name))
	if base == "." || base == "/" || base == "\\" || base == "" {
		return "asset"
	}
	var b strings.Builder
	for i := 0; i < len(base); i++ {
		c := base[i]
		switch {
		case c < 0x20 || c == 0x7f:
			b.WriteByte('_')
		case c == '\\' || c == '/' || c == ':' || c == '*' || c == '?' ||
			c == '"' || c == '<' || c == '>' || c == '|':
			b.WriteByte('_')
		default:
			b.WriteByte(c)
		}
	}
	cleaned := b.String()
	if strings.Trim(cleaned, ". ") == "" {
		return "asset"
	}
	// Windows trims trailing dots and spaces, which would break the
	// registered path vs. on-disk name match; replace them instead.
	for strings.HasSuffix(cleaned, ".") || strings.HasSuffix(cleaned, " ") {
		cleaned = cleaned[:len(cleaned)-1] + "_"
	}
	return cleaned
}

// validWorkspaceSegment reports whether s is a single safe path segment for
// the owner/job workspace hierarchy: non-empty, not "." or "..", and free of
// separators, control bytes, and the Windows ADS separator (":").
func validWorkspaceSegment(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	for i := range s {
		c := s[i]
		if c < 0x20 || c == 0x7f || c == '/' || c == '\\' || c == ':' {
			return false
		}
	}
	return true
}

// newAssetID returns a random 128-bit hex asset identifier.
func newAssetID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate asset id: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}
