package archive

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
)

// zipWriter adapts the ZIP adapter core to the Writer contract, resolving
// replacement inputs and registering outputs through a TempStore.
type zipWriter struct {
	z     ZIP
	store *TempStore
}

// NewZIPWriter returns a Writer whose replacement inputs and outputs live in
// store. Only FormatZIP is supported in the foundation; 7z/RAR pack and
// writeback return ErrUnsupportedWriteback (external tools arrive in P2).
func NewZIPWriter(store *TempStore) Writer {
	return &zipWriter{z: ZIP{}, store: store}
}

// ReplaceZIP implements Writer.ReplaceZIP. The output archive is registered
// as a new asset owned by the source ID, so a concurrent conflict cannot
// corrupt the original source (the caller decides when to atomically swap
// the source path).
func (w *zipWriter) ReplaceZIP(ctx context.Context, src Source, replacements map[string]AssetRef, b Budget) (AssetRef, error) {
	return w.replaceZIP(ctx, src, replacements, nil, b)
}

// ReplaceZIPDeleting implements Writer.ReplaceZIPDeleting: an atomic
// replace-plus-delete rewrite in one pass. The output archive is registered
// as a new asset exactly like ReplaceZIP.
func (w *zipWriter) ReplaceZIPDeleting(ctx context.Context, src Source, replacements map[string]AssetRef, deletes []string, b Budget) (AssetRef, error) {
	return w.replaceZIP(ctx, src, replacements, deletes, b)
}

// replaceZIP is the shared core of ReplaceZIP and ReplaceZIPDeleting.
func (w *zipWriter) replaceZIP(ctx context.Context, src Source, replacements map[string]AssetRef, deletes []string, b Budget) (AssetRef, error) {
	if src.Format != FormatZIP {
		return AssetRef{}, fmt.Errorf("%w: %s (only zip sources can be rewritten)", ErrUnsupportedWriteback, src.Format)
	}
	if w.store == nil {
		return AssetRef{}, errors.New("archive writer has no temp store")
	}
	if err := checkCtx(ctx); err != nil {
		return AssetRef{}, err
	}
	ctx, cancel := withBudgetTimeout(ctx, b)
	defer cancel()

	data, err := readSourceBytes(ctx, src, b)
	if err != nil {
		return AssetRef{}, err
	}

	repl := make(map[string][]byte, len(replacements))
	for key, asset := range replacements {
		if err := checkCtx(ctx); err != nil {
			return AssetRef{}, err
		}
		rc, ref, err := w.store.Open(src.Owner, asset.ID)
		if err != nil {
			return AssetRef{}, fmt.Errorf("resolve replacement %q: %w", key, err)
		}
		content, readErr := ReadCapped(rc, entryLimit(b))
		closeErr := rc.Close()
		if readErr != nil {
			return AssetRef{}, fmt.Errorf("read replacement %q: %w", key, readErr)
		}
		if closeErr != nil {
			return AssetRef{}, fmt.Errorf("close replacement %q: %w", key, closeErr)
		}
		repl[key] = content
		_ = ref
	}

	out, _, err := w.z.rewrite(ctx, data, repl, deletes, b)
	if err != nil {
		return AssetRef{}, err
	}
	// The output is registered under the source owner in a dedicated
	// "replace" job: the source asset itself lives under job src.ID, so a
	// worst-case output estimate must not collide with the source's own
	// per-job quota. The exact output size is known in memory, so it is the
	// Create cap (and therefore the quota reservation).
	ref, err := w.store.Create(ctx, src.Owner, "replace", src.Name, "application/zip", bytes.NewReader(out), int64(len(out)))
	if err != nil {
		return AssetRef{}, fmt.Errorf("register replaced zip: %w", err)
	}
	return *ref, nil
}

// Pack implements Writer.Pack for FormatZIP. Asset names must pass
// StrictArchivePath; unsafe or missing names reject the whole pack instead of
// being silently mangled.
func (w *zipWriter) Pack(ctx context.Context, format Format, assets []AssetRef, name string, b Budget) (AssetRef, error) {
	if format != FormatZIP {
		return AssetRef{}, fmt.Errorf("%w: %s (pack requires an external tool for 7z/rar)", ErrUnsupportedWriteback, format)
	}
	if w.store == nil {
		return AssetRef{}, errors.New("archive writer has no temp store")
	}
	if err := checkCtx(ctx); err != nil {
		return AssetRef{}, err
	}
	ctx, cancel := withBudgetTimeout(ctx, b)
	defer cancel()

	maxFiles := b.MaxEntries
	if maxFiles <= 0 || maxFiles > MaxPackFilesDefault {
		maxFiles = MaxPackFilesDefault
	}
	if len(assets) > maxFiles {
		return AssetRef{}, &BudgetError{Dimension: "entries", Limit: int64(maxFiles), Actual: int64(len(assets))}
	}
	// Pack inputs must belong to one owner; the output inherits that owner so
	// a cross-session pack is impossible even with known asset IDs.
	owner, err := commonAssetOwner(assets)
	if err != nil {
		return AssetRef{}, err
	}

	entryLimit := entryLimit(b)
	tracker := NewTracker(b)
	var out bytes.Buffer
	outCapped := NewCountingWriter(&out, b.MaxOutputBytes)
	zw := zip.NewWriter(outCapped)

	for i := range assets {
		if err := checkCtx(ctx); err != nil {
			zw.Close()
			return AssetRef{}, err
		}
		entryName, err := StrictArchivePath(assets[i].Name)
		if err != nil {
			zw.Close()
			return AssetRef{}, fmt.Errorf("pack asset %d name %q: %w", i, assets[i].Name, err)
		}
		rc, ref, err := w.store.Open(owner, assets[i].ID)
		if err != nil {
			zw.Close()
			return AssetRef{}, fmt.Errorf("resolve pack asset %d: %w", i, err)
		}
		content, readErr := ReadCapped(rc, entryLimit)
		closeErr := rc.Close()
		if readErr != nil {
			zw.Close()
			return AssetRef{}, fmt.Errorf("read pack asset %d: %w", i, readErr)
		}
		if closeErr != nil {
			zw.Close()
			return AssetRef{}, fmt.Errorf("close pack asset %d: %w", i, closeErr)
		}
		if err := tracker.CheckEntrySize(-1, int64(len(content))); err != nil {
			zw.Close()
			return AssetRef{}, err
		}
		_ = ref

		w2, err := zw.Create(entryName)
		if err != nil {
			zw.Close()
			return AssetRef{}, fmt.Errorf("create zip entry %q: %w", entryName, err)
		}
		if _, err := w2.Write(content); err != nil {
			zw.Close()
			return AssetRef{}, fmt.Errorf("write zip entry %q: %w", entryName, err)
		}
	}

	if err := zw.Close(); err != nil {
		return AssetRef{}, fmt.Errorf("close pack writer: %w", err)
	}

	ref, err := w.store.Create(ctx, owner, "pack", name, "application/zip", bytes.NewReader(out.Bytes()), int64(out.Len()))
	if err != nil {
		return AssetRef{}, fmt.Errorf("register pack output: %w", err)
	}
	return *ref, nil
}

// commonAssetOwner returns the single owner shared by every asset, rejecting
// empty and mixed-owner input sets.
func commonAssetOwner(assets []AssetRef) (string, error) {
	if len(assets) == 0 {
		return "", errors.New("pack requires at least one asset")
	}
	owner := assets[0].Owner
	if owner == "" {
		return "", errors.New("pack asset has no owner")
	}
	for _, a := range assets {
		if a.Owner != owner {
			return "", fmt.Errorf("pack assets belong to different owners (asset %s)", a.ID)
		}
	}
	return owner, nil
}

// entryLimit resolves the per-entry cap, defaulting to the plan value.
func entryLimit(b Budget) int64 {
	if b.MaxEntryBytes > 0 {
		return b.MaxEntryBytes
	}
	return MaxEntryBytesDefault
}

// readSourceBytes loads an on-disk archive source with the input-size cap.
func readSourceBytes(ctx context.Context, src Source, b Budget) ([]byte, error) {
	if src.Path == "" {
		return nil, errors.New("archive source has no server-side path")
	}
	f, err := os.Open(src.Path)
	if err != nil {
		return nil, fmt.Errorf("open archive source: %w", err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat archive source: %w", err)
	}
	if b.MaxInputBytes > 0 && st.Size() > b.MaxInputBytes {
		return nil, &BudgetError{Dimension: "input-bytes", Limit: b.MaxInputBytes, Actual: st.Size()}
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, fmt.Errorf("read archive source: %w", err)
	}
	return data, nil
}
