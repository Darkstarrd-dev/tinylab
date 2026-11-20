package gallery

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/fsutil"
)

// ExcludeHashEntry represents one excluded image fingerprint stored in
// excludehash.txt. Size and CRC32 enable zero-decompression / zero-read
// pre-filtering before computing SHA-256 on candidate matches.
type ExcludeHashEntry struct {
	SHA256   string
	Size     int64
	CRC32    uint32
	HasCRC32 bool
	Name     string
	AddedAt  string
}

// ExcludeStore persists and indexes excluded image hashes with O(1) lookup by
// SHA-256 and a secondary size index for fast pack-level candidate filtering.
type ExcludeStore struct {
	mu         sync.RWMutex
	path       string
	entries    map[string]ExcludeHashEntry // lowercase 64-hex sha256 -> entry
	order      []string                    // insertion order for deterministic file serialization
	bySize     map[int64][]string          // size -> []sha256 (only entries with Size > 0)
	hasUnsized bool                        // true when any entry lacks a positive Size (e.g. manual bare hash)
}

// NewExcludeStore creates an ExcludeStore backed by filePath (or memory-only
// when filePath is empty). Missing files are treated as an empty store.
func NewExcludeStore(filePath string) (*ExcludeStore, error) {
	s := &ExcludeStore{
		path:    filePath,
		entries: make(map[string]ExcludeHashEntry),
		bySize:  make(map[int64][]string),
	}
	if filePath == "" {
		return s, nil
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, fmt.Errorf("read exclude hash file %s: %w", filePath, err)
	}
	s.loadBytes(data)
	return s, nil
}

func (s *ExcludeStore) loadBytes(data []byte) {
	lines := strings.Split(string(data), "\n")
	for _, rawLine := range lines {
		entry, ok := parseExcludeHashLine(rawLine)
		if !ok {
			continue
		}
		if _, dup := s.entries[entry.SHA256]; dup {
			continue
		}
		s.entries[entry.SHA256] = entry
		s.order = append(s.order, entry.SHA256)
	}
	s.rebuildSizeIndexLocked()
}

func parseExcludeHashLine(rawLine string) (ExcludeHashEntry, bool) {
	line := strings.TrimSpace(rawLine)
	if line == "" || strings.HasPrefix(line, "#") {
		return ExcludeHashEntry{}, false
	}
	var comment string
	if idx := strings.IndexByte(line, '#'); idx >= 0 {
		comment = strings.TrimSpace(line[idx+1:])
		line = strings.TrimSpace(line[:idx])
	}
	if line == "" {
		return ExcludeHashEntry{}, false
	}
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return ExcludeHashEntry{}, false
	}
	sha, ok := NormalizeSHA256(fields[0])
	if !ok {
		return ExcludeHashEntry{}, false
	}
	entry := ExcludeHashEntry{SHA256: sha}
	if len(fields) >= 2 {
		if sz, err := strconv.ParseInt(fields[1], 10, 64); err == nil && sz > 0 {
			entry.Size = sz
		}
	}
	if len(fields) >= 3 && fields[2] != "-" {
		if crc, err := strconv.ParseUint(fields[2], 16, 32); err == nil {
			entry.CRC32 = uint32(crc)
			entry.HasCRC32 = true
		}
	}
	if comment != "" {
		if sp := strings.LastIndexByte(comment, ' '); sp > 0 {
			tail := comment[sp+1:]
			if _, err := time.Parse(time.RFC3339, tail); err == nil {
				entry.Name = strings.TrimSpace(comment[:sp])
				entry.AddedAt = tail
			} else {
				entry.Name = comment
			}
		} else if _, err := time.Parse(time.RFC3339, comment); err == nil {
			entry.AddedAt = comment
		} else {
			entry.Name = comment
		}
	}
	return entry, true
}

func (s *ExcludeStore) rebuildSizeIndexLocked() {
	s.bySize = make(map[int64][]string)
	s.hasUnsized = false
	for _, sha := range s.order {
		e, ok := s.entries[sha]
		if !ok {
			continue
		}
		if e.Size > 0 {
			s.bySize[e.Size] = append(s.bySize[e.Size], sha)
		} else {
			s.hasUnsized = true
		}
	}
}

// NormalizeSHA256 validates and normalizes a 64-character hex SHA-256 digest.
func NormalizeSHA256(s string) (string, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) != 64 {
		return "", false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return "", false
		}
	}
	return s, true
}

// ComputeFingerprint computes SHA-256, byte size, and IEEE CRC32 in a single
// streaming pass over r.
func ComputeFingerprint(r io.Reader) (sha256Hex string, size int64, crc32Val uint32, err error) {
	h := sha256.New()
	c := crc32.NewIEEE()
	mw := io.MultiWriter(h, c)
	n, err := io.Copy(mw, r)
	if err != nil {
		return "", 0, 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, c.Sum32(), nil
}

func sanitizeMetaToken(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\t", " ")
	return strings.TrimSpace(s)
}

func (s *ExcludeStore) serializeLocked() []byte {
	var sb strings.Builder
	sb.WriteString("# TinyLab Gallery Exclude Hash Records\n")
	sb.WriteString("# Format: <sha256>\t<size>\t<crc32_hex>\t# <filename> <timestamp>\n")
	for _, sha := range s.order {
		e, ok := s.entries[sha]
		if !ok {
			continue
		}
		crcCol := "-"
		if e.HasCRC32 {
			crcCol = fmt.Sprintf("%08x", e.CRC32)
		}
		sb.WriteString(fmt.Sprintf("%s\t%d\t%s", e.SHA256, e.Size, crcCol))
		metaParts := make([]string, 0, 2)
		if name := sanitizeMetaToken(e.Name); name != "" {
			metaParts = append(metaParts, name)
		}
		if ts := sanitizeMetaToken(e.AddedAt); ts != "" {
			metaParts = append(metaParts, ts)
		}
		if len(metaParts) > 0 {
			sb.WriteString("\t# ")
			sb.WriteString(strings.Join(metaParts, " "))
		}
		sb.WriteByte('\n')
	}
	return []byte(sb.String())
}

func (s *ExcludeStore) persistLocked() error {
	if s.path == "" {
		return nil
	}
	if dir := filepath.Dir(s.path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
	}
	return fsutil.AtomicWrite(s.path, s.serializeLocked(), 0644)
}

// Add inserts an excluded image entry if its SHA-256 is not already present.
// Duplicate adds return (added=false, duplicate=true) without rewriting disk.
func (s *ExcludeStore) Add(entry ExcludeHashEntry) (added bool, duplicate bool, count int, err error) {
	sha, ok := NormalizeSHA256(entry.SHA256)
	if !ok {
		return false, false, s.Count(), errors.New("invalid sha256 digest")
	}
	entry.SHA256 = sha
	entry.Name = sanitizeMetaToken(entry.Name)
	if entry.AddedAt == "" {
		entry.AddedAt = time.Now().UTC().Format(time.RFC3339)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.entries[sha]; exists {
		return false, true, len(s.entries), nil
	}

	s.entries[sha] = entry
	s.order = append(s.order, sha)
	s.rebuildSizeIndexLocked()

	if err := s.persistLocked(); err != nil {
		// Roll back in-memory mutation if disk persistence failed.
		delete(s.entries, sha)
		s.order = s.order[:len(s.order)-1]
		s.rebuildSizeIndexLocked()
		return false, false, len(s.entries), err
	}
	return true, false, len(s.entries), nil
}

// Remove deletes an entry by SHA-256 hex digest. When absent, returns
// (removed=false) without touching disk.
func (s *ExcludeStore) Remove(sha256Hex string) (removed bool, count int, err error) {
	sha, ok := NormalizeSHA256(sha256Hex)
	if !ok {
		return false, s.Count(), errors.New("invalid sha256 digest")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	oldEntry, exists := s.entries[sha]
	if !exists {
		return false, len(s.entries), nil
	}
	oldOrder := append([]string(nil), s.order...)

	delete(s.entries, sha)
	filtered := make([]string, 0, len(s.order)-1)
	for _, id := range s.order {
		if id != sha {
			filtered = append(filtered, id)
		}
	}
	s.order = filtered
	s.rebuildSizeIndexLocked()

	if err := s.persistLocked(); err != nil {
		s.entries[sha] = oldEntry
		s.order = oldOrder
		s.rebuildSizeIndexLocked()
		return false, len(s.entries), err
	}
	return true, len(s.entries), nil
}

// Count returns the number of excluded hashes in the store.
func (s *ExcludeStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.entries)
}

// HasSHA256 reports whether sha256Hex exists in the exclude store.
func (s *ExcludeStore) HasSHA256(sha256Hex string) bool {
	sha, ok := NormalizeSHA256(sha256Hex)
	if !ok {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, exists := s.entries[sha]
	return exists
}

// Summary returns the total count, sorted unique recorded positive byte sizes,
// and whether any entry has no recorded positive size.
func (s *ExcludeStore) Summary() (count int, sizes []int64, hasUnsized bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	count = len(s.entries)
	hasUnsized = s.hasUnsized
	if len(s.bySize) > 0 {
		sizes = make([]int64, 0, len(s.bySize))
		for sz := range s.bySize {
			sizes = append(sizes, sz)
		}
		sort.Slice(sizes, func(i, j int) bool { return sizes[i] < sizes[j] })
	} else {
		sizes = []int64{}
	}
	return count, sizes, hasUnsized
}

// MightMatch performs fast pre-filtering using file byte size and optional
// IEEE CRC32 before paying full decompression / SHA-256 costs.
func (s *ExcludeStore) MightMatch(size int64, crc32Val uint32, hasCRC32 bool) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(s.entries) == 0 {
		return false
	}
	if s.hasUnsized || size <= 0 {
		return true
	}
	candidates := s.bySize[size]
	if len(candidates) == 0 {
		return false
	}
	if !hasCRC32 {
		return true
	}
	for _, sha := range candidates {
		e := s.entries[sha]
		if !e.HasCRC32 || e.CRC32 == crc32Val {
			return true
		}
	}
	return false
}
