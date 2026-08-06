package archivetool

import (
	"strconv"
	"strings"

	"github.com/tinyrouter/tinyrouter/internal/archive"
)

// rawEntry is one parsed external-tool listing row before strict validation.
type rawEntry struct {
	Path           string // raw tool-reported name (may have trailing slash for dirs)
	IsDir          bool
	Size           int64
	CompressedSize int64 // -1 when the tool cannot provide reliable metadata
}

// parseSevenZipSLT parses `7z l -slt` key/value output (machine format,
// locale-independent). Each entry block starts with a "Path = ..." line and
// repeats; blocks are separated by blank lines. Values are taken from the
// last occurrence of each key within a block.
func parseSevenZipSLT(out []byte) []rawEntry {
	var entries []rawEntry
	var cur *rawEntry
	flush := func() {
		if cur != nil {
			if cur.CompressedSize == 0 {
				cur.CompressedSize = -1
			}
			entries = append(entries, *cur)
			cur = nil
		}
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" {
			flush()
			continue
		}
		key, val, ok := strings.Cut(line, " = ")
		if !ok {
			continue
		}
		switch key {
		case "Path":
			if cur != nil {
				flush()
			}
			cur = &rawEntry{Path: val, CompressedSize: -1}
		case "Folder":
			if cur != nil {
				cur.IsDir = strings.TrimSpace(val) == "+"
			}
		case "Size":
			if cur != nil {
				if n, err := strconv.ParseInt(strings.TrimSpace(val), 10, 64); err == nil {
					cur.Size = n
				}
			}
		case "Packed Size":
			if cur != nil {
				if n, err := strconv.ParseInt(strings.TrimSpace(val), 10, 64); err == nil {
					cur.CompressedSize = n
				}
			}
		}
	}
	flush()
	return entries
}

// parseRarLB parses `unrar lb` / `rar lb` bare output: one entry name per
// line, directories with a trailing separator. The bare listing carries no
// sizes, so Size stays 0 and CompressedSize is -1 (unknown); read-time budget
// enforcement is the responsibility of the bounded stdout reader.
func parseRarLB(out []byte) []rawEntry {
	var entries []rawEntry
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" {
			continue
		}
		raw := line
		isDir := strings.HasSuffix(raw, "/") || strings.HasSuffix(raw, "\\")
		entries = append(entries, rawEntry{
			Path:           raw,
			IsDir:          isDir,
			CompressedSize: -1,
		})
	}
	return entries
}

// buildManifest strict-validates raw tool entries (rejecting unsafe paths,
// collisions and over-budget listings) and returns the archive.Manifest with
// natural name ordering, mirroring the foundation ZIP adapter's semantics.
// Directory entries are flagged IsDir and their trailing separator is
// normalized away by StrictArchivePath.
func buildManifest(format archive.Format, raw []rawEntry, b archive.Budget) (archive.Manifest, error) {
	names := make([]string, 0, len(raw))
	sizes := make(map[string]int64, len(raw))
	compressed := make(map[string]int64, len(raw))
	dirs := make(map[string]bool, len(raw))
	for _, e := range raw {
		names = append(names, e.Path)
		sizes[e.Path] = e.Size
		compressed[e.Path] = e.CompressedSize
		dirs[e.Path] = e.IsDir
	}
	normalized, err := archive.ValidateEntryPaths(names)
	if err != nil {
		return archive.Manifest{}, err
	}

	if b.MaxEntries > 0 && len(raw) > b.MaxEntries {
		return archive.Manifest{}, &archive.BudgetError{Dimension: "entries", Limit: int64(b.MaxEntries), Actual: int64(len(raw))}
	}
	var total int64
	entries := make([]archive.Entry, 0, len(raw))
	for i, n := range normalized {
		rawName := names[i]
		size := sizes[rawName]
		cs := compressed[rawName]
		isDir := dirs[rawName]
		if !isDir {
			total += size
		}
		entries = append(entries, archive.Entry{
			Path:           n,
			Size:           size,
			CompressedSize: cs,
			IsDir:          isDir,
			Kind:           entryKind(n),
		})
	}
	if b.MaxTotalBytes > 0 && total > b.MaxTotalBytes {
		return archive.Manifest{}, &archive.BudgetError{Dimension: "total-bytes", Limit: b.MaxTotalBytes, Actual: total}
	}
	sortNatural(entries)
	return archive.Manifest{
		Format:            format,
		Entries:           entries,
		TotalEntries:      len(entries),
		TotalUncompressed: total,
	}, nil
}

// entryKind classifies an entry for the API (mirrors the foundation ZIP
// adapter's classification; used for media kind badges).
func entryKind(path string) string {
	lower := strings.ToLower(path)
	switch {
	case strings.HasSuffix(lower, ".png"), strings.HasSuffix(lower, ".jpg"), strings.HasSuffix(lower, ".jpeg"),
		strings.HasSuffix(lower, ".gif"), strings.HasSuffix(lower, ".webp"), strings.HasSuffix(lower, ".bmp"),
		strings.HasSuffix(lower, ".tif"), strings.HasSuffix(lower, ".tiff"):
		return "image"
	case strings.HasSuffix(lower, ".mp4"), strings.HasSuffix(lower, ".webm"), strings.HasSuffix(lower, ".mkv"),
		strings.HasSuffix(lower, ".mov"), strings.HasSuffix(lower, ".avi"):
		return "video"
	default:
		return "file"
	}
}

// sortNatural orders entries by the same natural comparison the Gallery uses:
// numeric runs compare by value, all other text byte-wise.
func sortNatural(entries []archive.Entry) {
	// insertion sort — manifests are bounded (20k max) and mostly pre-sorted
	for i := 1; i < len(entries); i++ {
		for j := i; j > 0 && naturalLess(entries[j].Path, entries[j-1].Path); j-- {
			entries[j], entries[j-1] = entries[j-1], entries[j]
		}
	}
}

func naturalLess(s1, s2 string) bool {
	c1 := splitChunks(s1)
	c2 := splitChunks(s2)
	for i := 0; i < len(c1) && i < len(c2); i++ {
		a, b := c1[i], c2[i]
		na, aIsNum := parseUint(a)
		nb, bIsNum := parseUint(b)
		if aIsNum && bIsNum {
			if na != nb {
				return na < nb
			}
			continue
		}
		if a != b {
			return a < b
		}
	}
	return len(c1) < len(c2)
}

func splitChunks(s string) []string {
	var chunks []string
	var cur strings.Builder
	inDigit := false
	flush := func() {
		if cur.Len() > 0 {
			chunks = append(chunks, cur.String())
			cur.Reset()
		}
	}
	for _, r := range s {
		digit := r >= '0' && r <= '9'
		if digit != inDigit {
			flush()
			inDigit = digit
		}
		cur.WriteRune(r)
	}
	flush()
	return chunks
}

func parseUint(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	var n uint64
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + uint64(c-'0')
	}
	return n, true
}
