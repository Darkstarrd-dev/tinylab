package gallery

// Code in this file: gallery temp-file registry (audit_fix.md F-27). Gallery
// handlers materialize temp files on the SUCCESS path (subtitle uploads,
// upload-temp, extracted zip entries) whose lifecycle the frontend never
// explicitly closes. The registry tracks them with a TTL and reclaims them
// lazily, and a dedicated root directory lets a startup sweep reclaim crash
// leftovers from previous runs without touching other applications' temp
// files.

import (
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	// galleryTempTTL is how long a gallery temp file may live after creation.
	// 24h covers a browser session plus a next-day revisit; consumed files
	// (writeback/zip-outputs cleanup) are gone earlier.
	galleryTempTTL = 24 * time.Hour
	// galleryTempRootName is the dedicated workspace root inside the OS temp
	// directory, so sweeping it can never delete foreign files.
	galleryTempRootName = "tinyrouter-gallery"
	// galleryTempSweepInt is the lazy sweep cadence (at most once per create).
	galleryTempSweepInt = time.Hour
)

// tempRegistry tracks gallery-created temp files by path → creation time.
type tempRegistry struct {
	mu        sync.Mutex
	root      string
	files     map[string]time.Time
	lastSweep time.Time
}

// newTempRegistry creates the workspace root and performs an immediate
// startup sweep of crash leftovers (files older than 2×TTL were never
// registered by this process).
func newTempRegistry() *tempRegistry {
	root := filepath.Join(os.TempDir(), galleryTempRootName)
	r := &tempRegistry{root: root, files: make(map[string]time.Time)}
	_ = os.MkdirAll(root, 0o700)
	r.sweep(time.Now())
	return r
}

// Root returns the temp workspace root directory.
func (r *tempRegistry) Root() string { return r.root }

// createTemp creates a file inside the dedicated workspace root. The pattern
// follows os.CreateTemp semantics ("*" is replaced with a random string).
func (r *tempRegistry) createTemp(pattern string) (string, *os.File, error) {
	r.sweepIfDue(time.Now())
	f, err := os.CreateTemp(r.root, pattern)
	if err != nil {
		return "", nil, err
	}
	return f.Name(), f, nil
}

// register tracks a successfully created temp file so the next sweep reclaims
// it once its TTL elapses.
func (r *tempRegistry) register(path string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.files[path] = time.Now()
}

// sweepIfDue runs the sweep at most once per galleryTempSweepInt.
func (r *tempRegistry) sweepIfDue(now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if now.Sub(r.lastSweep) < galleryTempSweepInt {
		return
	}
	r.sweepLocked(now)
}

// sweep reclaims registered files past TTL and unregistered orphans older
// than 2×TTL (crash leftovers). Removal is best-effort and idempotent.
func (r *tempRegistry) sweep(now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sweepLocked(now)
}

func (r *tempRegistry) sweepLocked(now time.Time) {
	r.lastSweep = now
	for path, createdAt := range r.files {
		if now.Sub(createdAt) > galleryTempTTL {
			os.Remove(path)
			delete(r.files, path)
		}
	}
	entries, err := os.ReadDir(r.root)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) > 2*galleryTempTTL {
			os.Remove(filepath.Join(r.root, e.Name()))
		}
	}
}
