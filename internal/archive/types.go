// Package archive implements the ArchiveCore foundation: strict archive path
// validation, collision detection, budget accounting, a file-backed temporary
// asset store, and a ZIP adapter that preserves the Gallery ZIP
// list/read/replace semantics.
//
// ArchiveCore is a leaf package: it does not depend on Gallery, GIF,
// Download, Playground, or any API layer. Higher layers depend only on the
// interfaces and types defined here, so 7z/RAR adapters (external tools) and
// the Gallery/GIF consumers can be added without changing the contract.
//
// Contracts are frozen per archive_compatibility_plan.md §4 (P0). The ZIP
// adapter mirrors internal/gallery's behavior — natural name ordering, the
// 100 MiB per-entry cap, index-or-path entry identifiers, and replacement
// that preserves entry headers, comments, and attributes — while adding the
// strict path validation and budget enforcement the plan requires.
package archive

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Format identifies an archive container format.
type Format string

const (
	// FormatZIP is the only format ArchiveCore can read and write without
	// external tools.
	FormatZIP Format = "zip"
	// Format7Z and FormatRAR are reserved for the external-tool adapter
	// (P2). The foundation rejects them with ErrUnsupportedFormat /
	// ErrUnsupportedWriteback.
	Format7Z  Format = "7z"
	FormatRAR Format = "rar"
)

// Valid reports whether f is a known archive format.
func (f Format) Valid() bool {
	switch f {
	case FormatZIP, Format7Z, FormatRAR:
		return true
	}
	return false
}

// Source is a server-side registered archive source. Path is server-internal
// only and must never be returned to the browser; clients address the source
// by ID.
type Source struct {
	ID       string
	Format   Format
	Name     string
	Path     string // server-side only; never a client contract
	Size     int64
	Writable bool
}

// AssetRef references a server-side temporary asset (extracted entry, job
// output, or pack result). Path is server-side only.
type AssetRef struct {
	ID   string
	Name string
	MIME string
	Path string // server-side only
	Size int64
}

// SourceRef is the client-facing reference to one entry inside a registered
// source. EntryPath is a strict relative archive path; empty for a plain
// asset.
type SourceRef struct {
	SourceID  string
	Format    Format
	EntryPath string
}

// MediaAsset is the browser-facing metadata subset. It never contains a
// server filesystem path or raw secret; the ID is resolved by the server.
type MediaAsset struct {
	ID     string `json:"assetId"`
	Name   string `json:"name"`
	MIME   string `json:"mime"`
	Kind   string `json:"kind"`
	Format Format `json:"format,omitempty"`
}

// Entry describes one member of an archive manifest.
type Entry struct {
	Path           string
	Size           int64
	CompressedSize int64 // -1 when the tool cannot provide reliable metadata
	IsDir          bool
	Kind           string
}

// Manifest is the validated entry listing of one archive source. Every
// Path has passed StrictArchivePath and collision detection.
type Manifest struct {
	Format            Format
	Entries           []Entry
	TotalEntries      int
	TotalUncompressed int64
}

// Budget caps every dimension of archive work. A zero value means "no cap"
// for the scalar fields; callers should normally use DefaultBudget so an
// omitted dimension is never silently unlimited.
type Budget struct {
	MaxEntries         int
	MaxEntryBytes      int64
	MaxTotalBytes      int64
	MaxCompressedRatio int64
	MaxInputBytes      int64
	MaxOutputBytes     int64
	MaxDuration        time.Duration
	MaxNestedDepth     int
}

// Reader lists and reads entries of an archive source.
type Reader interface {
	// List returns the strict-validated manifest of src, enforcing b.
	List(ctx context.Context, src Source, b Budget) (Manifest, error)
	// ReadEntry returns the raw bytes and a content-type for one entry.
	// identifier is a decimal index into the archive or a strict relative
	// archive path. Unsafe identifiers are rejected with ErrUnsafePath
	// before any matching.
	ReadEntry(ctx context.Context, src Source, identifier string, b Budget) ([]byte, string, error)
}

// Writer rewrites and packs archive sources. ReplaceZIP and ReplaceZIPDeleting
// only accept ZIP sources; other formats return ErrUnsupportedWriteback.
type Writer interface {
	// ReplaceZIP rewrites src in place, replacing the entries whose strict
	// paths are keys of replacements with the content of the referenced
	// assets, and registers the output archive as a new asset.
	ReplaceZIP(ctx context.Context, src Source, replacements map[string]AssetRef, b Budget) (AssetRef, error)
	// ReplaceZIPDeleting is ReplaceZIP plus a delete set: the listed strict
	// entry paths are dropped and the remaining entries replaced, in one
	// atomic rewrite. The output archive is registered as a new asset.
	ReplaceZIPDeleting(ctx context.Context, src Source, replacements map[string]AssetRef, deletes []string, b Budget) (AssetRef, error)
	// Pack assembles assets into a new archive of the given format. The
	// foundation only supports FormatZIP without external tools.
	Pack(ctx context.Context, format Format, assets []AssetRef, name string, b Budget) (AssetRef, error)
}

// Sentinel errors for archive operations.
var (
	// ErrEntryNotFound is returned when an entry identifier matches nothing.
	ErrEntryNotFound = errors.New("archive entry not found")
	// ErrUnsafePath is returned when an entry path fails strict validation.
	ErrUnsafePath = errors.New("unsafe archive path")
	// ErrPathCollision is returned when two archive entries normalize to the
	// same path (exact, Windows-equivalent, or file-vs-directory-prefix).
	ErrPathCollision = errors.New("archive entry path collision")
	// ErrUnsupportedFormat is returned for formats ArchiveCore cannot open.
	ErrUnsupportedFormat = errors.New("unsupported archive format")
	// ErrUnsupportedWriteback is returned for in-place rewrites ArchiveCore
	// refuses (7z/RAR in the foundation).
	ErrUnsupportedWriteback = errors.New("archive writeback not supported for format")
	// ErrClosed is returned by TempStore operations after Close.
	ErrClosed = errors.New("temp store is closed")
)

// IsNotFound reports whether err is (or wraps) ErrEntryNotFound.
func IsNotFound(err error) bool {
	return errors.Is(err, ErrEntryNotFound)
}

// IsUnsafePath reports whether err is (or wraps) ErrUnsafePath.
func IsUnsafePath(err error) bool {
	return errors.Is(err, ErrUnsafePath)
}

// IsPathCollision reports whether err is (or wraps) ErrPathCollision.
func IsPathCollision(err error) bool {
	return errors.Is(err, ErrPathCollision)
}

// BudgetError reports that an archive operation exceeded one budget
// dimension. Dimension is one of: "entries", "entry-bytes", "total-bytes",
// "ratio", "input-bytes", "output-bytes", "depth".
type BudgetError struct {
	Dimension string
	Limit     int64
	Actual    int64
}

func (e *BudgetError) Error() string {
	return fmt.Sprintf("archive budget exceeded: %s limit %d, actual %d", e.Dimension, e.Limit, e.Actual)
}

// IsBudgetExceeded reports whether err is (or wraps) a *BudgetError.
func IsBudgetExceeded(err error) bool {
	var be *BudgetError
	return errors.As(err, &be)
}
