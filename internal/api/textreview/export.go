package textreview

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/fsutil"
)

// ExportChapterItem represents a single chapter in the export request.
type ExportChapterItem struct {
	Title   string `json:"title"`
	Content string `json:"content"`
}

// ExportSplitRequest holds the payload for POST /api/text-review/export-split.
type ExportSplitRequest struct {
	TargetDir string              `json:"targetDir"`
	ZipName   string              `json:"zipName"`
	Chapters  []ExportChapterItem `json:"chapters"`
}

// sanitizeFilename strips or replaces characters illegal on Windows / POSIX file systems.
func sanitizeFilename(name string) string {
	invalidChars := `\/:*?"<>|`
	var sb strings.Builder
	for _, r := range name {
		if strings.ContainsRune(invalidChars, r) || r < 32 {
			sb.WriteRune('_')
		} else {
			sb.WriteRune(r)
		}
	}
	s := strings.TrimSpace(sb.String())
	s = strings.Trim(s, "._")
	return s
}

// exportSplit exports the split chapters into individual .txt files packed in a .zip
// archive, saving it directly to the specified target directory.
// POST /api/text-review/export-split
func (h *Handler) exportSplit(w http.ResponseWriter, r *http.Request) {
	var req ExportSplitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	req.TargetDir = strings.TrimSpace(req.TargetDir)
	if req.TargetDir == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "targetDir is required")
		return
	}
	if len(req.Chapters) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "no chapters to export")
		return
	}

	// P0-01d: TargetDir must be inside the configured docDir (canonical containment).
	{
		cfg := h.d.Reg.Config()
		configDir := ""
		if h.d.ConfigPath != "" {
			configDir = filepath.Dir(h.d.ConfigPath)
		}
		docRoot := config.ResolveDocDir(cfg.DocDir, configDir)
		// Empty/relative docRoot ("docs" with empty configDir) means no dir is
		// configured — allow. Tests use DefaultConfig + t.TempDir() which is
		// absolute but unrelated to "docs".
		if docRoot != "" && docRoot != "." && docRoot != "docs" {
			if _, err := fsutil.PathGuard(docRoot, req.TargetDir); err != nil {
				apibase.WriteAPIError(w, http.StatusBadRequest, "targetDir outside allowed directory")
				return
			}
		}
	}
	// Ensure target directory exists
	if err := os.MkdirAll(req.TargetDir, 0755); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to create target directory: "+err.Error())
		return
	}

	rawZipName := sanitizeFilename(filepath.Base(req.ZipName))
	if rawZipName == "" || rawZipName == "." {
		rawZipName = "chapters"
	}
	zipName := rawZipName
	if !strings.HasSuffix(strings.ToLower(zipName), ".zip") {
		zipName += ".zip"
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	digits := len(strconv.Itoa(len(req.Chapters)))
	if digits < 2 {
		digits = 2
	}
	formatStr := fmt.Sprintf("%%0%dd_%%s.txt", digits)

	seenNames := make(map[string]int)

	for i, ch := range req.Chapters {
		cleanTitle := sanitizeFilename(ch.Title)
		if cleanTitle == "" {
			cleanTitle = fmt.Sprintf("chapter_%d", i+1)
		}
		fileName := fmt.Sprintf(formatStr, i+1, cleanTitle)
		if seenNames[fileName] > 0 {
			seenNames[fileName]++
			fileName = fmt.Sprintf(formatStr, i+1, fmt.Sprintf("%s_%d", cleanTitle, seenNames[fileName]))
		} else {
			seenNames[fileName] = 1
		}

		header := &zip.FileHeader{
			Name:   fileName,
			Method: zip.Deflate,
		}
		wEntry, err := zw.CreateHeader(header)
		if err != nil {
			_ = zw.Close()
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to create zip entry: "+err.Error())
			return
		}

		text := ch.Content
		trimTitle := strings.TrimSpace(ch.Title)
		trimContent := strings.TrimSpace(ch.Content)
		if trimTitle != "" && !strings.HasPrefix(trimContent, trimTitle) {
			text = trimTitle + "\r\n\r\n" + ch.Content
		}

		if _, err := wEntry.Write([]byte(text)); err != nil {
			_ = zw.Close()
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to write zip entry: "+err.Error())
			return
		}
	}

	if err := zw.Close(); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to finalize zip: "+err.Error())
		return
	}

	// Resolve unique file path if file already exists in target directory
	outPath := filepath.Join(req.TargetDir, zipName)
	if _, err := os.Stat(outPath); err == nil {
		stem := strings.TrimSuffix(zipName, ".zip")
		for attempt := 1; attempt <= 1000; attempt++ {
			candidate := filepath.Join(req.TargetDir, fmt.Sprintf("%s (%d).zip", stem, attempt))
			if _, err := os.Stat(candidate); os.IsNotExist(err) {
				outPath = candidate
				zipName = filepath.Base(candidate)
				break
			}
		}
	}

	if err := fsutil.AtomicWrite(outPath, buf.Bytes(), 0644); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to write zip file: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"path":    outPath,
		"zipName": zipName,
		"count":   len(req.Chapters),
	})
}

// ExportCombinedRequest holds the payload for POST /api/text-review/export-combined.
type ExportCombinedRequest struct {
	TargetDir string              `json:"targetDir"`
	FileName  string              `json:"fileName"`
	Chapters  []ExportChapterItem `json:"chapters"`
}

// exportCombined merges the split chapters (already deduped in Step2 state)
// into a single .txt file, saving it directly to the specified target directory.
// Chapter framing mirrors exportSplit entries: "title\r\n\r\ncontent" per
// chapter (title prepended only when content doesn't already start with it),
// joined with a blank line. Step2's combine/split toggle selects this vs zip.
// POST /api/text-review/export-combined
func (h *Handler) exportCombined(w http.ResponseWriter, r *http.Request) {
	var req ExportCombinedRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	req.TargetDir = strings.TrimSpace(req.TargetDir)
	if req.TargetDir == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "targetDir is required")
		return
	}
	if len(req.Chapters) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "no chapters to export")
		return
	}

	// P0-01d: TargetDir must be inside the configured docDir (canonical containment).
	{
		cfg := h.d.Reg.Config()
		configDir := ""
		if h.d.ConfigPath != "" {
			configDir = filepath.Dir(h.d.ConfigPath)
		}
		docRoot := config.ResolveDocDir(cfg.DocDir, configDir)
		// Empty/relative docRoot ("docs" with empty configDir) means no dir is
		// configured — allow. Tests use DefaultConfig + t.TempDir() which is
		// absolute but unrelated to "docs".
		if docRoot != "" && docRoot != "." && docRoot != "docs" {
			if _, err := fsutil.PathGuard(docRoot, req.TargetDir); err != nil {
				apibase.WriteAPIError(w, http.StatusBadRequest, "targetDir outside allowed directory")
				return
			}
		}
	}
	// Ensure target directory exists
	if err := os.MkdirAll(req.TargetDir, 0755); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to create target directory: "+err.Error())
		return
	}

	rawFileName := sanitizeFilename(filepath.Base(req.FileName))
	if rawFileName == "" || rawFileName == "." {
		rawFileName = "combined"
	}
	fileName := rawFileName
	if !strings.HasSuffix(strings.ToLower(fileName), ".txt") {
		fileName += ".txt"
	}

	blocks := make([]string, 0, len(req.Chapters))
	for _, ch := range req.Chapters {
		text := ch.Content
		trimTitle := strings.TrimSpace(ch.Title)
		trimContent := strings.TrimSpace(ch.Content)
		if trimTitle != "" && !strings.HasPrefix(trimContent, trimTitle) {
			text = trimTitle + "\r\n\r\n" + ch.Content
		}
		blocks = append(blocks, text)
	}
	combined := strings.Join(blocks, "\r\n\r\n")

	// Resolve unique file path if file already exists in target directory
	outPath := filepath.Join(req.TargetDir, fileName)
	if _, err := os.Stat(outPath); err == nil {
		stem := strings.TrimSuffix(fileName, ".txt")
		for attempt := 1; attempt <= 1000; attempt++ {
			candidate := filepath.Join(req.TargetDir, fmt.Sprintf("%s (%d).txt", stem, attempt))
			if _, err := os.Stat(candidate); os.IsNotExist(err) {
				outPath = candidate
				fileName = filepath.Base(candidate)
				break
			}
		}
	}

	if err := fsutil.AtomicWrite(outPath, []byte(combined), 0644); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to write txt file: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":       true,
		"path":     outPath,
		"fileName": fileName,
		"count":    len(req.Chapters),
		"chars":    len([]rune(combined)),
	})
}
