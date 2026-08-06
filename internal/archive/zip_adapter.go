package archive

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
)

// ZIP is the stdlib archive/zip adapter. It preserves the Gallery ZIP
// semantics — natural name ordering, index-or-path entry identifiers, the
// 100 MiB per-entry cap, and header/comment/attribute-preserving replacement
// — while adding the strict path validation and budget enforcement the
// security contract requires.
//
// Divergence from internal/gallery (documented for the P3 migration):
// List returns ALL entries (directories flagged with IsDir), because the
// collision map must run over every entry; the Gallery image-extension
// filter stays a Gallery-layer concern.
type ZIP struct{}

// openZIP opens the archive at src.Path, enforcing the input-size cap. The
// returned cleanup must be called after the zip reader is done: entries are
// read lazily from the underlying file, so it must stay open for the lifetime
// of the returned *zip.Reader.
func openZIP(src Source, b Budget) (*zip.Reader, func(), error) {
	if src.Path == "" {
		return nil, nil, errors.New("archive source has no server-side path")
	}
	f, err := os.Open(src.Path)
	if err != nil {
		return nil, nil, fmt.Errorf("open archive source: %w", err)
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, fmt.Errorf("stat archive source: %w", err)
	}
	if b.MaxInputBytes > 0 && st.Size() > b.MaxInputBytes {
		f.Close()
		return nil, nil, &BudgetError{Dimension: "input-bytes", Limit: b.MaxInputBytes, Actual: st.Size()}
	}
	zr, err := zip.NewReader(f, st.Size())
	if err != nil {
		f.Close()
		return nil, nil, fmt.Errorf("open zip: %w", err)
	}
	return zr, func() { f.Close() }, nil
}

// withBudgetTimeout wraps ctx with b.MaxDuration when set.
func withBudgetTimeout(ctx context.Context, b Budget) (context.Context, context.CancelFunc) {
	if b.MaxDuration > 0 {
		return context.WithTimeout(ctx, b.MaxDuration)
	}
	return context.WithCancel(ctx)
}

// checkCtx surfaces context cancellation without needing the ctx inside the
// zip iteration loops.
func checkCtx(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

// List implements Reader.List. Every entry name is strict-validated and
// collision-checked before the manifest is returned; an unsafe name rejects
// the whole archive.
func (z ZIP) List(ctx context.Context, src Source, b Budget) (Manifest, error) {
	if src.Format != FormatZIP {
		return Manifest{}, fmt.Errorf("%w: %s", ErrUnsupportedFormat, src.Format)
	}
	if err := checkCtx(ctx); err != nil {
		return Manifest{}, err
	}
	ctx, cancel := withBudgetTimeout(ctx, b)
	defer cancel()

	zr, cleanup, err := openZIP(src, b)
	if err != nil {
		return Manifest{}, err
	}
	defer cleanup()
	return listZIP(ctx, zr, src.Format, b)
}

// listZIP builds the strict-validated manifest from an open zip reader.
func listZIP(ctx context.Context, zr *zip.Reader, format Format, b Budget) (Manifest, error) {
	decoded := make([]string, len(zr.File))
	for i := range zr.File {
		decoded[i] = decodeZipName(zr.File[i].Name)
	}
	normalized, err := ValidateEntryPaths(decoded)
	if err != nil {
		return Manifest{}, err
	}

	tracker := NewTracker(b)
	entries := make([]Entry, 0, len(zr.File))
	var total int64
	for i := range zr.File {
		if err := checkCtx(ctx); err != nil {
			return Manifest{}, err
		}
		f := zr.File[i]
		isDir := f.FileInfo().IsDir()
		sz := int64(f.UncompressedSize64)
		cs := int64(f.CompressedSize64)
		if err := tracker.CheckEntrySize(cs, sz); err != nil {
			return Manifest{}, err
		}
		kind := "file"
		if isDir {
			kind = "dir"
		}
		entries = append(entries, Entry{
			Path:           normalized[i],
			Size:           sz,
			CompressedSize: cs,
			IsDir:          isDir,
			Kind:           kind,
		})
		total += sz
	}

	sort.Slice(entries, func(i, j int) bool {
		return naturalLess(entries[i].Path, entries[j].Path)
	})
	return Manifest{
		Format:            format,
		Entries:           entries,
		TotalEntries:      len(entries),
		TotalUncompressed: total,
	}, nil
}

// ReadEntry implements Reader.ReadEntry. The identifier is either a decimal
// index into the archive or a strict relative archive path; an unsafe path is
// rejected with ErrUnsafePath before any matching.
func (z ZIP) ReadEntry(ctx context.Context, src Source, identifier string, b Budget) ([]byte, string, error) {
	if src.Format != FormatZIP {
		return nil, "", fmt.Errorf("%w: %s", ErrUnsupportedFormat, src.Format)
	}
	if err := checkCtx(ctx); err != nil {
		return nil, "", err
	}
	ctx, cancel := withBudgetTimeout(ctx, b)
	defer cancel()

	zr, cleanup, err := openZIP(src, b)
	if err != nil {
		return nil, "", err
	}
	defer cleanup()

	var target *zip.File
	if idx, pErr := strconv.Atoi(identifier); pErr == nil && idx >= 0 && idx < len(zr.File) {
		target = zr.File[idx]
	} else {
		want, vErr := StrictArchivePath(identifier)
		if vErr != nil {
			return nil, "", vErr
		}
		for _, f := range zr.File {
			entryPath, pErr := StrictArchivePath(decodeZipName(f.Name))
			if pErr != nil {
				continue // an unsafe entry is invisible to path reads; List rejects the archive
			}
			if entryPath == want {
				target = f
				break
			}
		}
	}
	if target == nil {
		return nil, "", fmt.Errorf("%w: %s", ErrEntryNotFound, identifier)
	}
	if err := checkCtx(ctx); err != nil {
		return nil, "", err
	}

	rc, err := target.Open()
	if err != nil {
		return nil, "", fmt.Errorf("open entry: %w", err)
	}
	defer rc.Close()

	limit := b.MaxEntryBytes
	if limit <= 0 {
		limit = MaxEntryBytesDefault
	}
	data, err := ReadCapped(rc, limit)
	if err != nil {
		return nil, "", fmt.Errorf("read entry %q: %w", target.Name, err)
	}
	return data, contentTypeForExt(decodeZipName(target.Name)), nil
}

// Replace rewrites a zip held in memory, replacing every entry whose strict
// path is a key of replacements with the supplied bytes. All other entries
// are copied byte-for-byte, preserving their compression Method, Modified
// time, Extra field, per-file comment, and external attributes; the
// archive-level comment is preserved as well. Missing keys in replacements
// are a no-op for that entry.
//
// Replacement keys and every source entry name are strict-validated; unsafe
// keys or entries reject the whole operation instead of being silently
// cleaned. The returned Manifest is produced by the same strict validation
// and budget rules as List.
func (z ZIP) Replace(ctx context.Context, data []byte, replacements map[string][]byte, b Budget) ([]byte, Manifest, error) {
	return z.rewrite(ctx, data, replacements, nil, b)
}

// DeleteEntries rewrites a zip held in memory, dropping every entry whose
// strict path is listed in deletes. Untouched entries are preserved
// byte-for-byte (compression Method, Modified time, Extra field, per-file
// comment, external attributes, archive comment) exactly like Replace.
// Delete paths are strict-validated with the same collision rules as
// replacement keys; unsafe paths reject the whole operation. Deleting an
// entry that is not present is a no-op for that path.
func (z ZIP) DeleteEntries(ctx context.Context, data []byte, deletes []string, b Budget) ([]byte, Manifest, error) {
	return z.rewrite(ctx, data, nil, deletes, b)
}

// rewrite is the shared core of Replace and DeleteEntries. replacements maps
// a strict entry path to its new content; deletes lists strict entry paths to
// drop. At most one of them is usually non-nil, but both are supported so an
// atomic write-back can combine edits and removals in a single pass.
func (z ZIP) rewrite(ctx context.Context, data []byte, replacements map[string][]byte, deletes []string, b Budget) ([]byte, Manifest, error) {
	if err := checkCtx(ctx); err != nil {
		return nil, Manifest{}, err
	}
	ctx, cancel := withBudgetTimeout(ctx, b)
	defer cancel()

	strictRepl, err := strictReplacementKeys(replacements, b)
	if err != nil {
		return nil, Manifest{}, err
	}
	strictDeletes, err := strictDeletePaths(deletes)
	if err != nil {
		return nil, Manifest{}, err
	}

	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, Manifest{}, fmt.Errorf("open zip: %w", err)
	}
	// Reject unsafe entry names in the source archive before touching it.
	decoded := make([]string, len(zr.File))
	for i := range zr.File {
		decoded[i] = decodeZipName(zr.File[i].Name)
	}
	if _, err := ValidateEntryPaths(decoded); err != nil {
		return nil, Manifest{}, err
	}

	var out bytes.Buffer
	outCapped := NewCountingWriter(&out, b.MaxOutputBytes)
	zw := zip.NewWriter(outCapped)
	if c := zr.Comment; c != "" {
		if err := zw.SetComment(c); err != nil {
			return nil, Manifest{}, fmt.Errorf("set zip comment: %w", err)
		}
	}

	for _, f := range zr.File {
		if err := checkCtx(ctx); err != nil {
			zw.Close()
			return nil, Manifest{}, err
		}
		name := decodeZipName(f.Name)
		key, err := StrictArchivePath(name)
		if err != nil {
			zw.Close()
			return nil, Manifest{}, fmt.Errorf("unsafe entry name %q: %w", name, err)
		}

		if strictDeletes[key] {
			// Dropped entry: do not copy it into the output archive.
			continue
		}

		if repl, ok := strictRepl[key]; ok {
			// Keep the original Method (Store or Deflate) and timestamps by
			// reusing the file's own header; the Writer re-encodes the body
			// under fh.Method, so a Store entry stays uncompressed and a
			// Deflate entry stays deflated.
			w, err := zw.CreateHeader(&f.FileHeader)
			if err != nil {
				zw.Close()
				return nil, Manifest{}, fmt.Errorf("create header %q: %w", key, err)
			}
			if _, err := w.Write(repl); err != nil {
				zw.Close()
				return nil, Manifest{}, fmt.Errorf("write replacement %q: %w", key, err)
			}
			continue
		}

		// Preserve every byte of an untouched entry. Reuse the original
		// header wholesale and stream the raw decompressed content back
		// through the writer.
		w, err := zw.CreateHeader(&f.FileHeader)
		if err != nil {
			zw.Close()
			return nil, Manifest{}, fmt.Errorf("create header %q: %w", key, err)
		}
		rc, err := f.Open()
		if err != nil {
			zw.Close()
			return nil, Manifest{}, fmt.Errorf("open entry %q: %w", key, err)
		}
		_, copyErr := io.Copy(w, rc)
		closeErr := rc.Close()
		if copyErr != nil {
			zw.Close()
			return nil, Manifest{}, fmt.Errorf("copy entry %q: %w", key, copyErr)
		}
		if closeErr != nil {
			zw.Close()
			return nil, Manifest{}, fmt.Errorf("close entry %q: %w", key, closeErr)
		}
	}

	if err := zw.Close(); err != nil {
		return nil, Manifest{}, fmt.Errorf("close zip writer: %w", err)
	}

	result := out.Bytes()
	zr2, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		return nil, Manifest{}, fmt.Errorf("open replaced zip: %w", err)
	}
	manifest, err := listZIP(ctx, zr2, FormatZIP, b)
	if err != nil {
		return nil, Manifest{}, fmt.Errorf("list replaced zip: %w", err)
	}
	return result, manifest, nil
}

// strictDeletePaths validates every delete path with StrictArchivePath and
// detects collisions (exact, Windows-equivalent, or directory-prefix) between
// them, mirroring strictReplacementKeys. Returns the normalized delete set.
func strictDeletePaths(deletes []string) (map[string]bool, error) {
	if len(deletes) == 0 {
		return nil, nil
	}
	normalized, err := ValidateEntryPaths(deletes)
	if err != nil {
		return nil, err
	}
	set := make(map[string]bool, len(normalized))
	for _, p := range normalized {
		set[p] = true
	}
	return set, nil
}

// strictReplacementKeys validates every replacement key with
// StrictArchivePath, detects key collisions, and enforces the per-entry size
// cap on the replacement content.
func strictReplacementKeys(replacements map[string][]byte, b Budget) (map[string][]byte, error) {
	if len(replacements) == 0 {
		return nil, nil
	}
	names := make([]string, 0, len(replacements))
	for key := range replacements {
		names = append(names, key)
	}
	normalized, err := ValidateEntryPaths(names)
	if err != nil {
		return nil, err
	}
	limit := b.MaxEntryBytes
	if limit <= 0 {
		limit = MaxEntryBytesDefault
	}
	strict := make(map[string][]byte, len(replacements))
	for i, key := range names {
		content := replacements[key]
		if int64(len(content)) > limit {
			return nil, &BudgetError{Dimension: "entry-bytes", Limit: limit, Actual: int64(len(content))}
		}
		strict[normalized[i]] = content
	}
	return strict, nil
}

// contentTypeForExt returns the HTTP content-type for a file based on its
// extension. Unsupported extensions fall back to "application/octet-stream".
func contentTypeForExt(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".webp":
		return "image/webp"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".bmp":
		return "image/bmp"
	case ".gif":
		return "image/gif"
	case ".tiff", ".tif":
		return "image/tiff"
	default:
		return "application/octet-stream"
	}
}

// naturalLess compares two archive paths with the same natural ordering the
// Gallery uses: numeric runs compare by value, all other text byte-wise.
func naturalLess(s1, s2 string) bool {
	segs1 := strings.Split(s1, "/")
	segs2 := strings.Split(s2, "/")
	minLen := len(segs1)
	if len(segs2) < minLen {
		minLen = len(segs2)
	}

	for i := range minLen {
		if segs1[i] != segs2[i] {
			return compareSegmentNatural(segs1[i], segs2[i])
		}
	}
	return len(segs1) < len(segs2)
}

func compareSegmentNatural(a, b string) bool {
	chunksA := splitChunks(a)
	chunksB := splitChunks(b)
	minLen := len(chunksA)
	if len(chunksB) < minLen {
		minLen = len(chunksB)
	}

	for i := range minLen {
		ca := chunksA[i]
		cb := chunksB[i]
		if ca != cb {
			numA, isNumA := parseUint(ca)
			numB, isNumB := parseUint(cb)
			if isNumA && isNumB {
				if numA != numB {
					return numA < numB
				}
			} else {
				return ca < cb
			}
		}
	}
	return len(chunksA) < len(chunksB)
}

func splitChunks(s string) []string {
	var chunks []string
	var buf strings.Builder
	inDigit := false

	for _, r := range s {
		digit := r >= '0' && r <= '9'
		if digit != inDigit && buf.Len() > 0 {
			chunks = append(chunks, buf.String())
			buf.Reset()
		}
		inDigit = digit
		buf.WriteRune(r)
	}
	if buf.Len() > 0 {
		chunks = append(chunks, buf.String())
	}
	return chunks
}

func parseUint(s string) (uint64, bool) {
	var n uint64
	if len(s) == 0 {
		return 0, false
	}
	for i := range s {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
		n = n*10 + uint64(s[i]-'0')
	}
	return n, true
}
