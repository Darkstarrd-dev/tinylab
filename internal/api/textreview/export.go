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

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
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
