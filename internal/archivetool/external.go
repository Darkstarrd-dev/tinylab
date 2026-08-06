package archivetool

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/archive"
)

// Operation timeouts (archive_compatibility_plan.md §4.3). They apply when the
// caller's Budget.MaxDuration is zero; the budget value, when set, wins.
const (
	listTimeout = 15 * time.Second
	readTimeout = 60 * time.Second
	packTimeout = 5 * time.Minute
)

// externalConcurrency is the max simultaneous external-tool jobs (plan §4.3).
const externalConcurrency = 2

// externalAdapter implements archive.Reader for 7z/RAR via the resolved
// external tools. The semaphore caps concurrent external processes.
type externalAdapter struct {
	res *Resolver
	sem chan struct{}
}

// NewExternalReader returns the external 7z/RAR reader bound to res.
func NewExternalReader(res *Resolver) archive.Reader {
	return &externalAdapter{res: res, sem: make(chan struct{}, externalConcurrency)}
}

// pick returns the argv builder and tool info for src.Format.
func (e *externalAdapter) pick(ctx context.Context, format archive.Format) (argvBuilder, toolInfo, error) {
	switch format {
	case archive.Format7Z:
		info := e.res.SevenZip(ctx)
		if info.Err != nil {
			return nil, info, toolUnusable(format, info)
		}
		return sevenZipBuilder{}, info, nil
	case archive.FormatRAR:
		info := e.res.RAR(ctx)
		if info.Err != nil {
			return nil, info, toolUnusable(format, info)
		}
		// RAR read via 7z fallback reports an empty path; route through the
		// 7z syntax in that case.
		if info.Path == "" {
			return sevenZipBuilder{}, info, nil
		}
		return rarBuilder{}, info, nil
	}
	return nil, toolInfo{}, fmt.Errorf("%w: %s", archive.ErrUnsupportedFormat, format)
}

// List implements archive.Reader.List.
func (e *externalAdapter) List(ctx context.Context, src archive.Source, b archive.Budget) (archive.Manifest, error) {
	builder, info, err := e.pick(ctx, src.Format)
	if err != nil {
		return archive.Manifest{}, err
	}
	e.sem <- struct{}{}
	defer func() { <-e.sem }()

	args := builder.listArgs(src.Path)
	timeout := opTimeout(b.MaxDuration, listTimeout)
	out, errTail, err := runTool(ctx, info.Path, timeout, listOutputCap, args...)
	if err != nil {
		return archive.Manifest{}, err
	}
	var raw []rawEntry
	if _, isRar := builder.(rarBuilder); isRar {
		raw = parseRarLB(out)
	} else {
		raw = parseSevenZipSLT(out)
	}
	if len(raw) == 0 && len(errTail) > 0 {
		// A tool that produced nothing but diagnostics is reporting failure
		// in a way the exit code did not surface.
		return archive.Manifest{}, &ToolError{Kind: ErrToolFailed, Tool: info.Path, Detail: errTail}
	}
	return buildManifest(src.Format, raw, b)
}

// ReadEntry implements archive.Reader.ReadEntry. The identifier is a decimal
// index into the archive or a strict relative path; wildcard characters are
// rejected because the external tools treat them as match patterns rather
// than literal names.
func (e *externalAdapter) ReadEntry(ctx context.Context, src archive.Source, identifier string, b archive.Budget) ([]byte, string, error) {
	builder, info, err := e.pick(ctx, src.Format)
	if err != nil {
		return nil, "", err
	}
	sel, isIndex, err := entrySelector(identifier)
	if err != nil {
		return nil, "", err
	}
	// rar/unrar cannot address entries by index; resolve the index to a name
	// through a bare listing before the read.
	if isIndex {
		if _, isRar := builder.(rarBuilder); isRar {
			name, err := e.resolveRarIndex(ctx, src, sel)
			if err != nil {
				return nil, "", err
			}
			sel, isIndex = name, false
		}
	}
	e.sem <- struct{}{}
	defer func() { <-e.sem }()

	args := builder.readArgs(src.Path, sel, isIndex)
	cap := b.MaxEntryBytes
	if cap <= 0 {
		cap = archive.DefaultBudget().MaxEntryBytes
	}
	timeout := opTimeout(b.MaxDuration, readTimeout)
	out, _, err := runTool(ctx, info.Path, timeout, cap, args...)
	if err != nil {
		return nil, "", err
	}
	return out, contentTypeForExt(sel), nil
}

// resolveRarIndex maps a decimal index to a strict entry name using the rar
// bare listing.
func (e *externalAdapter) resolveRarIndex(ctx context.Context, src archive.Source, index string) (string, error) {
	info := e.res.RAR(ctx)
	if info.Err != nil {
		return "", info.Err
	}
	e.sem <- struct{}{}
	defer func() { <-e.sem }()
	out, _, err := runTool(ctx, info.Path, listTimeout, listOutputCap, rarBuilder{}.listArgs(src.Path)...)
	if err != nil {
		return "", err
	}
	names := parseRarLB(out)
	idx, err := strconv.ParseUint(index, 10, 64)
	if err != nil {
		return "", fmt.Errorf("%w: bad index %q", archive.ErrUnsafePath, index)
	}
	if idx >= uint64(len(names)) {
		return "", fmt.Errorf("%w: index %d out of range", archive.ErrEntryNotFound, idx)
	}
	clean, err := archive.StrictArchivePath(names[idx].Path)
	if err != nil {
		return "", err
	}
	return clean, nil
}

// entrySelector normalizes an entry identifier. Decimal identifiers pass
// through as indices; everything else must strict-validate as a relative
// archive path and must not contain the external tools' wildcard
// metacharacters (which they treat as match patterns, not literal names).
func entrySelector(identifier string) (string, bool, error) {
	if identifier == "" {
		return "", false, fmt.Errorf("%w: empty identifier", archive.ErrUnsafePath)
	}
	if _, err := strconv.ParseUint(identifier, 10, 64); err == nil {
		return identifier, true, nil
	}
	clean, err := archive.StrictArchivePath(identifier)
	if err != nil {
		return "", false, err
	}
	if strings.ContainsAny(clean, "*?") {
		return "", false, fmt.Errorf("%w: wildcard characters are not allowed in entry identifiers", archive.ErrUnsafePath)
	}
	return clean, false, nil
}

// externalWriter implements archive.Writer.Pack for 7z/RAR via the external
// tools (ZIP packs go through the foundation's stdlib writer). Inputs are
// staged into a private job directory with deduplicated basenames, then the
// tool runs with its working directory set to the staging dir so archive
// entry names are plain basenames (no absolute path leakage).
type externalWriter struct {
	res   *Resolver
	store *archive.TempStore
	sem   chan struct{}
}

// NewExternalWriter returns a Writer whose Pack covers 7z/RAR.
func NewExternalWriter(res *Resolver, store *archive.TempStore) archive.Writer {
	return &externalWriter{res: res, store: store, sem: make(chan struct{}, externalConcurrency)}
}

// ReplaceZIP is unsupported here (foundation ZIP writer owns it).
func (w *externalWriter) ReplaceZIP(ctx context.Context, src archive.Source, replacements map[string]archive.AssetRef, b archive.Budget) (archive.AssetRef, error) {
	return archive.AssetRef{}, fmt.Errorf("%w: %s (only zip sources can be rewritten)", archive.ErrUnsupportedWriteback, src.Format)
}

// ReplaceZIPDeleting is unsupported here (foundation ZIP writer owns it).
func (w *externalWriter) ReplaceZIPDeleting(ctx context.Context, src archive.Source, replacements map[string]archive.AssetRef, deletes []string, b archive.Budget) (archive.AssetRef, error) {
	return archive.AssetRef{}, fmt.Errorf("%w: %s (only zip sources can be rewritten)", archive.ErrUnsupportedWriteback, src.Format)
}

// Pack implements archive.Writer.Pack for Format7Z and FormatRAR.
func (w *externalWriter) Pack(ctx context.Context, format archive.Format, assets []archive.AssetRef, name string, b archive.Budget) (archive.AssetRef, error) {
	if format != archive.Format7Z && format != archive.FormatRAR {
		return archive.AssetRef{}, fmt.Errorf("%w: %s", archive.ErrUnsupportedFormat, format)
	}
	var info toolInfo
	var bld packBuilder
	switch format {
	case archive.Format7Z:
		info = w.res.SevenZip(ctx)
		if info.Err != nil {
			return archive.AssetRef{}, toolUnusable(format, info)
		}
		bld = sevenZipPackBuilder{}
	case archive.FormatRAR:
		info = w.res.RAR(ctx)
		if info.Err != nil {
			return archive.AssetRef{}, toolUnusable(format, info)
		}
		if !info.Write || info.Path == "" {
			return archive.AssetRef{}, &ToolError{Kind: ErrReadOnly, Tool: string(format), Detail: "rar write capability requires a rar binary (unrar only reads)"}
		}
		bld = rarPackBuilder{}
	}

	if len(assets) == 0 {
		return archive.AssetRef{}, errors.New("pack requires at least one asset")
	}
	if b.MaxEntries > 0 && len(assets) > b.MaxEntries {
		return archive.AssetRef{}, &archive.BudgetError{Dimension: "entries", Limit: int64(b.MaxEntries), Actual: int64(len(assets))}
	}

	// Stage inputs with deduplicated basenames in a private job directory.
	staging, err := os.MkdirTemp(filepath.Join(w.store.Root(), "packs"), "job-*")
	if err != nil {
		return archive.AssetRef{}, err
	}
	defer os.RemoveAll(staging)

	used := make(map[string]bool, len(assets))
	staged := make([]string, 0, len(assets))
	var totalIn int64
	for _, a := range assets {
		if a.Path == "" {
			return archive.AssetRef{}, fmt.Errorf("asset %s has no server path", a.ID)
		}
		fi, err := os.Stat(a.Path)
		if err != nil {
			return archive.AssetRef{}, fmt.Errorf("asset %s: %w", a.ID, err)
		}
		totalIn += fi.Size()
		base := dedupName(sanitizeBase(a.Name), used)
		dst := filepath.Join(staging, base)
		if err := copyFile(a.Path, dst); err != nil {
			return archive.AssetRef{}, fmt.Errorf("stage asset %s: %w", a.ID, err)
		}
		staged = append(staged, base)
	}
	if b.MaxOutputBytes > 0 && totalIn > b.MaxOutputBytes {
		return archive.AssetRef{}, &archive.BudgetError{Dimension: "output-bytes", Limit: b.MaxOutputBytes, Actual: totalIn}
	}

	outName := sanitizeBase(name)
	if outName == "" {
		outName = "archive." + string(format)
	}
	if !strings.HasSuffix(outName, "."+string(format)) {
		outName += "." + string(format)
	}

	w.sem <- struct{}{}
	defer func() { <-w.sem }()

	args := bld.packArgs(outName, staged)
	timeout := opTimeout(b.MaxDuration, packTimeout)
	_, errTail, err := runToolDir(ctx, info.Path, staging, timeout, packOutputCap, args...)
	if err != nil {
		return archive.AssetRef{}, err
	}
	outPath := filepath.Join(staging, outName)
	fi, err := os.Stat(outPath)
	if err != nil || !fi.Mode().IsRegular() {
		if errTail != "" {
			return archive.AssetRef{}, &ToolError{Kind: ErrToolFailed, Tool: info.Path, Detail: errTail}
		}
		return archive.AssetRef{}, &ToolError{Kind: ErrToolFailed, Tool: info.Path, Detail: "pack produced no output archive"}
	}
	if b.MaxOutputBytes > 0 && fi.Size() > b.MaxOutputBytes {
		return archive.AssetRef{}, &archive.BudgetError{Dimension: "output-bytes", Limit: b.MaxOutputBytes, Actual: fi.Size()}
	}

	f, err := os.Open(outPath)
	if err != nil {
		return archive.AssetRef{}, err
	}
	defer f.Close()
	ref, err := w.store.Create(ctx, ownerPack, jobPack, outName, packMIME(format), f, fi.Size())
	if err != nil {
		return archive.AssetRef{}, err
	}
	return *ref, nil
}

// opTimeout picks the operation timeout, letting a budget value override the
// default.
func opTimeout(budget, def time.Duration) time.Duration {
	if budget > 0 {
		return budget
	}
	return def
}

// toolUnusable converts a failed resolution/probe into a ToolError.
func toolUnusable(format archive.Format, info toolInfo) error {
	if info.Err != nil {
		return info.Err
	}
	return &ToolError{Kind: ErrToolMissing, Tool: string(format), Detail: "tool unusable"}
}

func sanitizeBase(name string) string {
	name = filepath.Base(name)
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' || r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|' {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimRight(name, ". ")
	if name == "" || name == "." || name == ".." {
		return "file"
	}
	return name
}

// dedupName makes base unique against used by appending _2, _3, ...
func dedupName(base string, used map[string]bool) string {
	if !used[base] {
		used[base] = true
		return base
	}
	stem, ext := splitExt(base)
	for i := 2; ; i++ {
		cand := fmt.Sprintf("%s_%d%s", stem, i, ext)
		if !used[cand] {
			used[cand] = true
			return cand
		}
	}
}

func splitExt(name string) (string, string) {
	i := strings.LastIndexByte(name, '.')
	if i <= 0 {
		return name, ""
	}
	return name[:i], name[i:]
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, cerr := out.ReadFrom(in)
	if cerr != nil {
		out.Close()
		return cerr
	}
	return out.Close()
}

// contentTypeForExt mirrors the foundation ZIP adapter's mapping for the
// read-entry responses.
func contentTypeForExt(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".tif", ".tiff":
		return "image/tiff"
	case ".mp4":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".txt", ".md", ".json", ".srt", ".vtt", ".csv":
		return "text/plain; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}
