package gallery

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strconv"
	"strings"
)

// ErrEntryNotFound is returned by GetZipEntry when no entry with the requested
// name exists in the archive.
var ErrEntryNotFound = errors.New("entry not found")

// maxZipEntrySize caps a single extracted zip entry (100 MiB) so a crafted
// archive cannot balloon memory via one giant entry.
const maxZipEntrySize = 100 << 20

// IsNotFound reports whether err is (or wraps) ErrEntryNotFound.
func IsNotFound(err error) bool {
	return errors.Is(err, ErrEntryNotFound)
}

// CleanZipPath normalizes a zip entry path: forward-slashes, strips a leading
// "/", collapses "."/".." and duplicate slashes via path.Clean, then strips
// any leading "/" Clean may have introduced (turning "foo/../.." into ".").
func CleanZipPath(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(p, "/")
	// Normalize ../ and ./ sequences. path.Clean also collapses double slashes.
	p = path.Clean(p)
	// path.Clean can turn "foo/../.." into ".", strip a leading "/" again
	// in case Clean produces an absolute-looking path.
	p = strings.TrimPrefix(p, "/")
	return p
}

// ListZipEntries opens the zip archive described by reader/size and returns a
// manifest of the supported image entries it contains. Directory entries and
// files whose extension is not in SupportedExts are skipped. Returned entries
// are sorted by name in ascending order; Total equals the image entry count.
func ListZipEntries(reader io.ReaderAt, size int64) (manifest Manifest, err error) {
	z, err := zip.NewReader(reader, size)
	if err != nil {
		return Manifest{}, fmt.Errorf("open zip: %w", err)
	}

	var entries []Entry
	for idx, f := range z.File {
		if f.FileInfo().IsDir() {
			continue
		}
		cleanName := CleanZipPath(decodeZipName(f.Name))
		if !IsSupportedExt(cleanName) {
			continue
		}
		entries = append(entries, Entry{
			Index: idx,
			Path:  cleanName,
			Size:  int64(f.UncompressedSize64),
			Kind:  "file",
		})
	}

	sort.Slice(entries, func(i, j int) bool {
		return naturalLess(entries[i].Path, entries[j].Path)
	})

	return Manifest{
		Entries: entries,
		Total:   len(entries),
	}, nil
}

func naturalLess(s1, s2 string) bool {
	segs1 := strings.Split(CleanZipPath(s1), "/")
	segs2 := strings.Split(CleanZipPath(s2), "/")
	minLen := len(segs1)
	if len(segs2) < minLen {
		minLen = len(segs2)
	}

	for i := 0; i < minLen; i++ {
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

	for i := 0; i < minLen; i++ {
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
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
		n = n*10 + uint64(s[i]-'0')
	}
	return n, true
}

// GetZipEntry finds the named or indexed entry inside the zip archive and returns
// its raw bytes plus a content-type derived from the extension.
func GetZipEntry(reader io.ReaderAt, size int64, identifier string) (data []byte, contentType string, err error) {
	z, err := zip.NewReader(reader, size)
	if err != nil {
		return nil, "", fmt.Errorf("open zip: %w", err)
	}

	var target *zip.File
	if idx, pErr := strconv.Atoi(identifier); pErr == nil && idx >= 0 && idx < len(z.File) {
		target = z.File[idx]
	} else {
		targetName := CleanZipPath(identifier)
		for _, f := range z.File {
			if CleanZipPath(decodeZipName(f.Name)) == targetName {
				target = f
				break
			}
		}
	}

	if target == nil {
		return nil, "", fmt.Errorf("%w: %s", ErrEntryNotFound, identifier)
	}

	rc, err := target.Open()
	if err != nil {
		return nil, "", fmt.Errorf("open entry: %w", err)
	}
	defer rc.Close()

	// Read up to limit+1 bytes so a truncated entry is detected: if the entry
	// exceeds the cap we return an explicit error instead of a silent partial.
	limited := io.LimitReader(rc, maxZipEntrySize+1)
	data, err = io.ReadAll(limited)
	if err != nil {
		return nil, "", fmt.Errorf("read entry: %w", err)
	}
	if int64(len(data)) > maxZipEntrySize {
		return nil, "", fmt.Errorf("entry %s exceeds size limit (%d bytes)", target.Name, maxZipEntrySize)
	}

	return data, contentTypeForExt(target.Name), nil
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
