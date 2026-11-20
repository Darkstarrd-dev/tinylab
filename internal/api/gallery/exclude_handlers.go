// Code in this file: Gallery exclude-hash HTTP handlers.
// Frontend: web/playground/static-pg/gallery/gallery-exclude.js.
package gallery

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/archive"
	"github.com/tinylab/tinylab/internal/config"
	gallerylib "github.com/tinylab/tinylab/internal/gallery"
	"github.com/tinylab/tinylab/internal/owner"
	"github.com/tinylab/tinylab/internal/pathgrant"
)

const excludeBodyCap = 1 << 20 // 1 MiB JSON cap

type excludeItemRef struct {
	SessionID string `json:"sessionId,omitempty"`
	ZipPath   string `json:"zipPath,omitempty"`
	SourceID  string `json:"sourceId,omitempty"`
	EntryPath string `json:"entryPath,omitempty"`
	GrantID   string `json:"grantId,omitempty"`
	Rel       string `json:"rel,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
	Size      int64  `json:"size,omitempty"`
	CRC32     string `json:"crc32,omitempty"`
	Name      string `json:"name,omitempty"`
}

func (h *Handler) effectiveExcludeConfig() config.GalleryExcludeConfig {
	cfg := config.GalleryExcludeConfig{
		Enabled: true,
		Scope:   config.GalleryExcludeScopeTail,
		Count:   config.DefaultGalleryExcludeCount,
	}
	if h.d != nil && h.d.Reg != nil {
		cfg = h.d.Reg.Config().GalleryExclude
		config.FinalizeGalleryExcludeConfig(&cfg)
	}
	return cfg
}

func (h *Handler) resolveItemFingerprint(ctx context.Context, ownerID string, ref excludeItemRef) (gallerylib.ExcludeHashEntry, int, error) {
	switch {
	case ref.SessionID != "" && ref.ZipPath != "":
		data, ok := h.sessions.get(ownerID, ref.SessionID)
		if !ok {
			return gallerylib.ExcludeHashEntry{}, http.StatusNotFound, fmt.Errorf("zip session not found")
		}
		entryBytes, _, err := gallerylib.GetZipEntry(bytes.NewReader(data), int64(len(data)), ref.ZipPath)
		if err != nil {
			if gallerylib.IsNotFound(err) {
				return gallerylib.ExcludeHashEntry{}, http.StatusNotFound, err
			}
			return gallerylib.ExcludeHashEntry{}, http.StatusBadRequest, err
		}
		sha, sz, crc, err := gallerylib.ComputeFingerprint(bytes.NewReader(entryBytes))
		if err != nil {
			return gallerylib.ExcludeHashEntry{}, http.StatusInternalServerError, err
		}
		name := ref.Name
		if name == "" {
			name = filepath.Base(ref.ZipPath)
		}
		return gallerylib.ExcludeHashEntry{
			SHA256:   sha,
			Size:     sz,
			CRC32:    crc,
			HasCRC32: true,
			Name:     name,
		}, http.StatusOK, nil

	case ref.SourceID != "" && ref.EntryPath != "":
		if h.archive == nil {
			return gallerylib.ExcludeHashEntry{}, http.StatusServiceUnavailable, fmt.Errorf("archive source lookup is unavailable")
		}
		src, ok := h.archive.ResolveSource(ownerID, ref.SourceID)
		if !ok {
			return gallerylib.ExcludeHashEntry{}, http.StatusNotFound, fmt.Errorf("archive source not found or expired")
		}
		entryBytes, _, err := h.archive.ReadEntry(ctx, src, ref.EntryPath, archive.DefaultBudget())
		if err != nil {
			if archive.IsNotFound(err) {
				return gallerylib.ExcludeHashEntry{}, http.StatusNotFound, err
			}
			if archive.IsUnsafePath(err) {
				return gallerylib.ExcludeHashEntry{}, http.StatusBadRequest, err
			}
			return gallerylib.ExcludeHashEntry{}, http.StatusBadGateway, err
		}
		sha, sz, crc, err := gallerylib.ComputeFingerprint(bytes.NewReader(entryBytes))
		if err != nil {
			return gallerylib.ExcludeHashEntry{}, http.StatusInternalServerError, err
		}
		name := ref.Name
		if name == "" {
			name = filepath.Base(ref.EntryPath)
		}
		return gallerylib.ExcludeHashEntry{
			SHA256:   sha,
			Size:     sz,
			CRC32:    crc,
			HasCRC32: true,
			Name:     name,
		}, http.StatusOK, nil

	case ref.GrantID != "":
		var target string
		var err error
		if ref.Rel == "" {
			target, err = h.grants.Resolve(ownerID, ref.GrantID, pathgrant.OpRead)
		} else {
			target, err = h.grants.ResolveChild(ownerID, ref.GrantID, ref.Rel, pathgrant.OpRead)
		}
		if err != nil {
			return gallerylib.ExcludeHashEntry{}, http.StatusForbidden, fmt.Errorf("grant denied or expired")
		}
		f, err := os.Open(target)
		if err != nil {
			return gallerylib.ExcludeHashEntry{}, http.StatusNotFound, fmt.Errorf("file not found")
		}
		defer f.Close()
		fi, err := f.Stat()
		if err != nil || fi.IsDir() {
			return gallerylib.ExcludeHashEntry{}, http.StatusNotFound, fmt.Errorf("file not found")
		}
		sha, sz, crc, err := gallerylib.ComputeFingerprint(f)
		if err != nil {
			return gallerylib.ExcludeHashEntry{}, http.StatusInternalServerError, err
		}
		name := ref.Name
		if name == "" {
			name = filepath.Base(target)
		}
		return gallerylib.ExcludeHashEntry{
			SHA256:   sha,
			Size:     sz,
			CRC32:    crc,
			HasCRC32: true,
			Name:     name,
		}, http.StatusOK, nil

	case ref.SHA256 != "":
		sha, ok := gallerylib.NormalizeSHA256(ref.SHA256)
		if !ok {
			return gallerylib.ExcludeHashEntry{}, http.StatusBadRequest, fmt.Errorf("invalid sha256 digest")
		}
		entry := gallerylib.ExcludeHashEntry{
			SHA256: sha,
			Name:   ref.Name,
		}
		if ref.Size > 0 {
			entry.Size = ref.Size
		}
		if rawCRC := strings.TrimSpace(ref.CRC32); rawCRC != "" {
			if crc, err := strconv.ParseUint(rawCRC, 16, 32); err == nil {
				entry.CRC32 = uint32(crc)
				entry.HasCRC32 = true
			}
		}
		return entry, http.StatusOK, nil

	default:
		return gallerylib.ExcludeHashEntry{}, http.StatusBadRequest, fmt.Errorf("item reference or sha256 is required")
	}
}

// galleryGetExcludeHashes returns the persisted exclude config and summary of
// recorded hashes (count, known sizes, and unsized flag) for client pre-filtering.
// GET /api/gallery/exclude-hashes
func (h *Handler) galleryGetExcludeHashes(w http.ResponseWriter, r *http.Request) {
	cfg := h.effectiveExcludeConfig()
	count, sizes, hasUnsized := 0, []int64{}, false
	if h.excludeStore != nil {
		count, sizes, hasUnsized = h.excludeStore.Summary()
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"config":     cfg,
		"count":      count,
		"sizes":      sizes,
		"hasUnsized": hasUnsized,
	})
}

// galleryAddExcludeHash computes or accepts an image's SHA-256 fingerprint and
// appends it idempotently to excludehash.txt.
// POST /api/gallery/exclude-hashes/add
func (h *Handler) galleryAddExcludeHash(w http.ResponseWriter, r *http.Request) {
	if h.excludeStore == nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "exclude hash store unavailable")
		return
	}
	var ref excludeItemRef
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, excludeBodyCap)).Decode(&ref); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	entry, status, err := h.resolveItemFingerprint(r.Context(), owner.From(r.Context()), ref)
	if err != nil {
		apibase.WriteAPIError(w, status, err.Error())
		return
	}
	added, duplicate, count, err := h.excludeStore.Add(entry)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "persist exclude hash failed: "+err.Error())
		return
	}
	crcStr := ""
	if entry.HasCRC32 {
		crcStr = fmt.Sprintf("%08x", entry.CRC32)
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"added":     added,
		"duplicate": duplicate,
		"hash":      entry.SHA256,
		"size":      entry.Size,
		"crc32":     crcStr,
		"count":     count,
	})
}

// galleryRemoveExcludeHash removes an image's hash from excludehash.txt by raw
// sha256 or by item reference.
// POST /api/gallery/exclude-hashes/remove
func (h *Handler) galleryRemoveExcludeHash(w http.ResponseWriter, r *http.Request) {
	if h.excludeStore == nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "exclude hash store unavailable")
		return
	}
	var ref excludeItemRef
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, excludeBodyCap)).Decode(&ref); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	entry, status, err := h.resolveItemFingerprint(r.Context(), owner.From(r.Context()), ref)
	if err != nil {
		apibase.WriteAPIError(w, status, err.Error())
		return
	}
	removed, count, err := h.excludeStore.Remove(entry.SHA256)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "remove exclude hash failed: "+err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"removed": removed,
		"hash":    entry.SHA256,
		"count":   count,
	})
}

type checkExcludeRequest struct {
	SessionID string   `json:"sessionId,omitempty"`
	SourceID  string   `json:"sourceId,omitempty"`
	GrantID   string   `json:"grantId,omitempty"`
	Entries   []string `json:"entries,omitempty"`
	Rels      []string `json:"rels,omitempty"`
	Hashes    []string `json:"hashes,omitempty"`
}

// galleryCheckExcludeHashes checks a pack slice against excludehash.txt using
// Size (+ ZIP CRC32) pre-filtering before reading/decompressing SHA-256 candidates.
// POST /api/gallery/exclude-hashes/check
func (h *Handler) galleryCheckExcludeHashes(w http.ResponseWriter, r *http.Request) {
	var req checkExcludeRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, excludeBodyCap)).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	matched := make([]string, 0)
	matchedHashes := make(map[string]string)

	// Fast exit: empty store matches nothing with zero disk/archive work.
	if h.excludeStore == nil || h.excludeStore.Count() == 0 {
		apibase.WriteJSON(w, http.StatusOK, map[string]any{
			"matched":       matched,
			"matchedHashes": matchedHashes,
		})
		return
	}

	ownerID := owner.From(r.Context())

	switch {
	case req.SessionID != "":
		data, ok := h.sessions.get(ownerID, req.SessionID)
		if !ok {
			apibase.WriteAPIError(w, http.StatusNotFound, "zip session not found")
			return
		}
		m, mh, err := gallerylib.MatchZipEntries(bytes.NewReader(data), int64(len(data)), req.Entries, h.excludeStore)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
			return
		}
		matched = m
		matchedHashes = mh

	case req.SourceID != "":
		if h.archive == nil {
			apibase.WriteAPIError(w, http.StatusServiceUnavailable, "archive source lookup is unavailable")
			return
		}
		src, ok := h.archive.ResolveSource(ownerID, req.SourceID)
		if !ok {
			apibase.WriteAPIError(w, http.StatusNotFound, "archive source not found or expired")
			return
		}
		if src.Format == archive.FormatZIP && src.Path != "" {
			f, err := os.Open(src.Path)
			if err != nil {
				apibase.WriteAPIError(w, http.StatusNotFound, "archive source unavailable")
				return
			}
			defer f.Close()
			st, err := f.Stat()
			if err != nil {
				apibase.WriteAPIError(w, http.StatusNotFound, "archive source unavailable")
				return
			}
			m, mh, err := gallerylib.MatchZipEntries(f, st.Size(), req.Entries, h.excludeStore)
			if err != nil {
				apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
				return
			}
			matched = m
			matchedHashes = mh
		} else {
			manifest, err := h.archive.List(r.Context(), src, archive.DefaultBudget())
			if err != nil {
				apibase.WriteAPIError(w, http.StatusBadRequest, "failed to list archive source: "+err.Error())
				return
			}
			sizeByPath := make(map[string]int64, len(manifest.Entries))
			for _, e := range manifest.Entries {
				if !e.IsDir {
					sizeByPath[gallerylib.CleanZipPath(e.Path)] = e.Size
				}
			}
			seen := make(map[string]bool, len(req.Entries))
			for _, entryPath := range req.Entries {
				if entryPath == "" || seen[entryPath] {
					continue
				}
				seen[entryPath] = true
				sz, hasSz := sizeByPath[gallerylib.CleanZipPath(entryPath)]
				if hasSz && sz > 0 && !h.excludeStore.MightMatch(sz, 0, false) {
					continue
				}
				data, _, err := h.archive.ReadEntry(r.Context(), src, entryPath, archive.DefaultBudget())
				if err != nil {
					continue
				}
				sum := sha256.Sum256(data)
				sha := hex.EncodeToString(sum[:])
				if h.excludeStore.HasSHA256(sha) {
					matched = append(matched, entryPath)
					matchedHashes[entryPath] = sha
				}
			}
		}

	case req.GrantID != "":
		if _, err := h.grants.Resolve(ownerID, req.GrantID, pathgrant.OpRead); err != nil {
			apibase.WriteAPIError(w, http.StatusForbidden, "grant denied or expired")
			return
		}
		seen := make(map[string]bool, len(req.Rels))
		for _, rel := range req.Rels {
			if seen[rel] {
				continue
			}
			seen[rel] = true
			var target string
			var err error
			if rel == "" {
				target, err = h.grants.Resolve(ownerID, req.GrantID, pathgrant.OpRead)
			} else {
				target, err = h.grants.ResolveChild(ownerID, req.GrantID, rel, pathgrant.OpRead)
			}
			if err != nil {
				continue
			}
			info, err := os.Stat(target)
			if err != nil || info.IsDir() {
				continue
			}
			if !h.excludeStore.MightMatch(info.Size(), 0, false) {
				continue
			}
			f, err := os.Open(target)
			if err != nil {
				continue
			}
			h256 := sha256.New()
			_, copyErr := io.Copy(h256, f)
			_ = f.Close()
			if copyErr != nil {
				continue
			}
			sha := hex.EncodeToString(h256.Sum(nil))
			if h.excludeStore.HasSHA256(sha) {
				matched = append(matched, rel)
				matchedHashes[rel] = sha
			}
		}

	case len(req.Hashes) > 0:
		seen := make(map[string]bool, len(req.Hashes))
		for _, rawHash := range req.Hashes {
			if seen[rawHash] {
				continue
			}
			seen[rawHash] = true
			norm, ok := gallerylib.NormalizeSHA256(rawHash)
			if !ok {
				continue
			}
			if h.excludeStore.HasSHA256(norm) {
				matched = append(matched, rawHash)
				matchedHashes[rawHash] = norm
			}
		}

	default:
		apibase.WriteAPIError(w, http.StatusBadRequest, "sessionId, sourceId, grantId, or hashes is required")
		return
	}

	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"matched":       matched,
		"matchedHashes": matchedHashes,
	})
}
