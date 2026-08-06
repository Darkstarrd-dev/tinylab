package archivetool

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/archive"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// Runner wires the external-tool layer and the foundation TempStore into the
// runtime surface the API consumes: status, format-dispatched list/read/pack,
// settings updates and lifecycle (scavenge/close). It is safe for concurrent
// use.
type Runner struct {
	store *archive.TempStore
	zipW  archive.Writer
	extR  *externalAdapter
	extW  archive.Writer
	res   *Resolver

	cfgMu sync.RWMutex
	cfg   config.ArchiveConfig

	closeMu sync.Mutex
	closed  bool
}

// NewRunner creates the archive temp store under root (0700) and wires the
// foundation ZIP writer plus the external 7z/RAR adapter. A root that cannot
// be created disables the archive capability (the caller keeps core features
// running); the returned error is diagnostic only.
func NewRunner(root string, cfg config.ArchiveConfig) (*Runner, error) {
	store, err := archive.NewTempStore(root, 0)
	if err != nil {
		return nil, fmt.Errorf("archive temp store: %w", err)
	}
	res := NewResolver(cfg)
	return &Runner{
		store: store,
		zipW:  archive.NewZIPWriter(store),
		extR:  &externalAdapter{res: res, sem: make(chan struct{}, externalConcurrency)},
		extW:  NewExternalWriter(res, store),
		res:   res,
		cfg:   cfg,
	}, nil
}

// Store exposes the underlying temp store to the API layer for asset
// registration/release.
func (r *Runner) Store() *archive.TempStore { return r.store }

// Status assembles the capability snapshot (zip always read+write; 7z/RAR
// from the resolver with its probe cache).
func (r *Runner) Status(ctx context.Context) Status {
	sz := r.res.SevenZip(ctx)
	rar := r.res.RAR(ctx)
	return Status{
		ZIP:      ToolStatus{Available: true, Read: true, Write: true},
		SevenZip: toolToStatus(sz),
		RAR:      toolToStatus(rar),
	}
}

func toolToStatus(info toolInfo) ToolStatus {
	if info.Err != nil {
		return ToolStatus{Error: info.Err.Error()}
	}
	return ToolStatus{Available: true, Read: info.Read, Write: info.Write, Path: info.Path, Version: info.Version}
}

// UpdateSettings swaps the active archive config and invalidates every cached
// tool probe so the next Status/List/Read/Pack re-resolves paths.
func (r *Runner) UpdateSettings(cfg config.ArchiveConfig) {
	r.cfgMu.Lock()
	r.cfg = cfg
	r.cfgMu.Unlock()
	r.res.UpdateSettings(cfg)
}

// List dispatches by source format: ZIP goes to the foundation stdlib
// adapter; 7z/RAR to the external tool adapter.
func (r *Runner) List(ctx context.Context, src archive.Source, b archive.Budget) (archive.Manifest, error) {
	switch src.Format {
	case archive.FormatZIP:
		return (archive.ZIP{}).List(ctx, src, b)
	case archive.Format7Z, archive.FormatRAR:
		return r.extR.List(ctx, src, b)
	default:
		return archive.Manifest{}, fmt.Errorf("%w: %s", archive.ErrUnsupportedFormat, src.Format)
	}
}

// ReadEntry dispatches by source format like List.
func (r *Runner) ReadEntry(ctx context.Context, src archive.Source, identifier string, b archive.Budget) ([]byte, string, error) {
	switch src.Format {
	case archive.FormatZIP:
		return (archive.ZIP{}).ReadEntry(ctx, src, identifier, b)
	case archive.Format7Z, archive.FormatRAR:
		return r.extR.ReadEntry(ctx, src, identifier, b)
	default:
		return nil, "", fmt.Errorf("%w: %s", archive.ErrUnsupportedFormat, src.Format)
	}
}

// Pack dispatches by output format: ZIP uses the foundation stdlib writer
// (never requires an external tool); 7z/RAR go through the external adapter
// and fail with ErrToolMissing / ErrReadOnly when the tool lacks capability.
func (r *Runner) Pack(ctx context.Context, format archive.Format, assets []archive.AssetRef, name string, b archive.Budget) (archive.AssetRef, error) {
	switch format {
	case archive.FormatZIP:
		return r.zipW.Pack(ctx, format, assets, name, b)
	case archive.Format7Z, archive.FormatRAR:
		return r.extW.Pack(ctx, format, assets, name, b)
	default:
		return archive.AssetRef{}, fmt.Errorf("%w: %s", archive.ErrUnsupportedFormat, format)
	}
}

// Scavenge reclaims expired registered assets and orphaned workspace
// directories (crash leftovers are never in the store's registry). Call at
// startup and periodically.
// ReplaceZIP rewrites a registered ZIP source with the given entry
// replacements (assets resolved by the caller) and registers the output
// archive as a new asset; the caller decides when to atomically swap the
// source to the new asset. Non-ZIP sources return ErrUnsupportedWriteback.
func (r *Runner) ReplaceZIP(ctx context.Context, src archive.Source, replacements map[string]archive.AssetRef, b archive.Budget) (archive.AssetRef, error) {
	if src.Format != archive.FormatZIP {
		return archive.AssetRef{}, fmt.Errorf("%w: %s (only zip sources can be rewritten)", archive.ErrUnsupportedWriteback, src.Format)
	}
	return r.zipW.ReplaceZIP(ctx, src, replacements, b)
}

// ReplaceZIPDeleting is ReplaceZIP plus a delete set, performed in one atomic
// rewrite. Non-ZIP sources return ErrUnsupportedWriteback.
func (r *Runner) ReplaceZIPDeleting(ctx context.Context, src archive.Source, replacements map[string]archive.AssetRef, deletes []string, b archive.Budget) (archive.AssetRef, error) {
	if src.Format != archive.FormatZIP {
		return archive.AssetRef{}, fmt.Errorf("%w: %s (only zip sources can be rewritten)", archive.ErrUnsupportedWriteback, src.Format)
	}
	return r.zipW.ReplaceZIPDeleting(ctx, src, replacements, deletes, b)
}

// Scavenge reclaims expired registered assets and orphaned workspace
// directories (crash leftovers are never in the store's registry). Call at
// startup and periodically.
func (r *Runner) Scavenge(now time.Time) int {
	n := r.store.Scavenge(now)
	n += r.sweepOrphans(now)
	return n
}

// sweepOrphans removes direct children of the workspace root whose mtime
// predates two store TTLs. Live assets are recent by definition, so a 2×TTL
// margin never races an in-flight job while still reclaiming crash leftovers.
func (r *Runner) sweepOrphans(now time.Time) int {
	cutoff := now.Add(-2 * r.store.TTL())
	entries, err := os.ReadDir(r.store.Root())
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if e.Name() == "packs" {
			continue // staging dirs are deleted by their pack job
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		if fi.ModTime().Before(cutoff) {
			if os.RemoveAll(filepath.Join(r.store.Root(), e.Name())) == nil {
				n++
			}
		}
	}
	return n
}

// Close releases the temp store (whole workspace root removed). It is safe to
// call once.
func (r *Runner) Close() error {
	r.closeMu.Lock()
	defer r.closeMu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	return r.store.Close()
}

// IsClosed reports whether the runner has been closed.
func (r *Runner) IsClosed() bool {
	r.closeMu.Lock()
	defer r.closeMu.Unlock()
	return r.closed
}

// ErrNoRunner is returned by API handlers when the archive runner was not
// wired (temp dir unavailable at startup).
var ErrNoRunner = errors.New("archive runner unavailable")
