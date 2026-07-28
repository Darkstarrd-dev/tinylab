package gallery

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
)

// ReplaceZipEntries returns a new zip archive derived from data where every
// entry whose cleaned name appears in replacements is overwritten with the
// supplied bytes. All other entries are copied byte-for-byte from the
// original, preserving their compression Method, Modified time, Extra field,
// per-file comment, and external attributes. The archive-level comment is
// preserved as well. Missing keys in replacements are a no-op for that entry.
//
// The map key must be a cleaned path (see cleanZipPath): backslashes collapsed
// to forward slashes, no leading slash, and path.Clean applied. Callers should
// normalize with the same rules used elsewhere in the package.
//
// The returned Manifest is produced by ListZipEntries so callers learn the new
// image-entry manifest (non-image entries are filtered out by it regardless).
func ReplaceZipEntries(data []byte, replacements map[string][]byte) ([]byte, Manifest, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, Manifest{}, fmt.Errorf("open zip: %w", err)
	}

	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	if c := zr.Comment; c != "" {
		if err := zw.SetComment(c); err != nil {
			return nil, Manifest{}, fmt.Errorf("set zip comment: %w", err)
		}
	}

	for _, f := range zr.File {
		name := cleanZipPath(f.Name)

		if repl, ok := replacements[name]; ok {
			// Keep the original Method (Store or Deflate) and timestamps by
			// reusing the file's own header; the Writer re-encodes the body
			// under fh.Method, so a Store entry stays uncompressed and a
			// Deflate entry stays deflated.
			w, err := zw.CreateHeader(&f.FileHeader)
			if err != nil {
				return nil, Manifest{}, fmt.Errorf("create header %q: %w", name, err)
			}
			if _, err := w.Write(repl); err != nil {
				return nil, Manifest{}, fmt.Errorf("write replacement %q: %w", name, err)
			}
			continue
		}

		// Preserve every byte of an untouched entry. Reuse the original
		// header wholesale and stream the raw decompressed content back through
		// the writer, which re-records the stored/deflated representation under
		// the same method, timestamps, extra, comment, and attributes.
		w, err := zw.CreateHeader(&f.FileHeader)
		if err != nil {
			return nil, Manifest{}, fmt.Errorf("create header %q: %w", name, err)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, Manifest{}, fmt.Errorf("open entry %q: %w", name, err)
		}
		if _, err := io.Copy(w, rc); err != nil {
			rc.Close()
			return nil, Manifest{}, fmt.Errorf("copy entry %q: %w", name, err)
		}
		if err := rc.Close(); err != nil {
			return nil, Manifest{}, fmt.Errorf("close entry %q: %w", name, err)
		}
	}

	if err := zw.Close(); err != nil {
		return nil, Manifest{}, fmt.Errorf("close zip writer: %w", err)
	}

	result := out.Bytes()
	manifest, err := ListZipEntries(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		return nil, Manifest{}, fmt.Errorf("list replaced zip: %w", err)
	}
	return result, manifest, nil
}
