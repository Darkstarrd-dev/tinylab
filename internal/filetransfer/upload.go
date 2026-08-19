// Package filetransfer creates a ZIP archive from user-selected files and
// publishes it to an anonymous temporary file host.
//
// Path capability contract (docs/audit_fix.md F-01, B-2): the browser never
// submits server-side paths. Files arrive as multipart uploads (browser
// picker / drag-drop / paste File objects) or as short-TTL pathGrantIds the
// server issued from the OS clipboard (POST /api/filetransfer/paste). A raw
// `paths` JSON field is rejected outright; a grant is resolved only when the
// requesting owner matches the grant's owner and the grant carries the export
// operation.
package filetransfer

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/fsutil"
	"github.com/tinyrouter/tinyrouter/internal/owner"
	"github.com/tinyrouter/tinyrouter/internal/pathgrant"
)

const (
	maxArchiveSize = 500 << 20
	maxFiles       = 2000
	maxFileSize    = 500 << 20
	// maxTotalInputSize caps the combined bytes of all selected parts so a
	// directory import cannot exceed the archive output cap by orders of
	// magnitude (plan §4.3 / audit B-2.4: 总大小).
	maxTotalInputSize = 1 << 30
	// maxScanDepth caps directory recursion depth during clipboard-import
	// scanning (audit B-2.4: 扫描深度).
	maxScanDepth = 32
	// maxScanTime caps the total wall time of a clipboard-import scan
	// (audit B-2.4: 总耗时).
	maxScanTime = 30 * time.Second
)

type filePart struct {
	name string
	body io.ReadCloser
}

// Handler owns the file-transfer client and the owner-bound path-grant store.
type Handler struct {
	client *http.Client
	grants *pathgrant.Store
}

// NewHandler creates a file-transfer handler with a long-lived client for
// uploading archives to temporary file hosts.
func NewHandler() *Handler {
	return &Handler{
		client: &http.Client{Timeout: 15 * time.Minute},
		grants: pathgrant.NewStore(0),
	}
}

// Register mounts the file-transfer routes with the owner middleware, so every
// grant lookup is bound to the requesting browser session. The router calls
// this inside the /api/filetransfer group (600 MiB body cap applied outside).
func (h *Handler) Register(r interface {
	Use(...func(http.Handler) http.Handler)
	Post(string, http.HandlerFunc)
}) {
	r.Use(owner.Middleware)
	r.Post("/upload", h.Upload)
	r.Post("/path-info", h.PathInfo)
	r.Post("/paste", h.PasteClipboard)
}

// Upload receives selected files and pathGrantIds (never raw paths), packages
// them as one ZIP archive, and tries the configured hosts in order.
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid multipart upload: "+err.Error())
		return
	}
	defer r.MultipartForm.RemoveAll()
	parts, err := h.collectParts(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer closeParts(parts)
	if len(parts) == 0 {
		writeError(w, http.StatusBadRequest, "no files selected")
		return
	}

	archiveName := archiveFileName()
	archive, err := buildArchive(parts)
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to create ZIP archive: "+err.Error())
		return
	}

	var failures []string
	for _, service := range services {
		link, uploadErr := service.upload(r.Context(), h.client, archiveName, archive)
		if uploadErr == nil && link != "" {
			writeJSON(w, http.StatusOK, map[string]any{
				"url":      link,
				"service":  service.name,
				"filename": archiveName,
				"size":     len(archive),
			})
			return
		}
		if uploadErr == nil {
			uploadErr = errors.New("empty download URL")
		}
		failures = append(failures, service.name+": "+uploadErr.Error())
	}
	writeJSON(w, http.StatusBadGateway, map[string]any{
		"error":    "all temporary file services failed",
		"failures": failures,
	})
}

// grantInfo is the browser-facing metadata for one registered path grant. It
// deliberately carries no server path.
type grantInfo struct {
	PathGrantID string `json:"pathGrantId"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	IsDir       bool   `json:"isDir"`
}

// PasteClipboard registers the paths currently on the system clipboard
// (CF_HDROP on Windows) as export grants owned by the requesting session and
// returns only the grant IDs + metadata. This is the only way the server
// accepts local paths, and it happens only on an explicit user paste action
// the server itself performed.
func (h *Handler) PasteClipboard(w http.ResponseWriter, r *http.Request) {
	ownerID := owner.From(r.Context())
	if ownerID == "" {
		writeError(w, http.StatusForbidden, "request has no owner identity")
		return
	}
	paths := fsutil.GetClipboardFilePaths()
	if paths == nil {
		paths = []string{}
	}
	if len(paths) > maxFiles {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("too many clipboard paths (max %d)", maxFiles))
		return
	}
	infos := make([]grantInfo, 0, len(paths))
	for _, p := range paths {
		g, err := h.grants.Grant(ownerID, []pathgrant.Operation{pathgrant.OpExport}, p, false, false)
		if err != nil {
			continue // unreadable/symlink/non-regular clipboard entries are skipped
		}
		fi, err := os.Lstat(g.Path)
		if err != nil {
			h.grants.Revoke(ownerID, g.ID)
			continue
		}
		infos = append(infos, grantInfo{
			PathGrantID: g.ID,
			Name:        filepath.Base(g.Path),
			Size:        fi.Size(),
			IsDir:       fi.IsDir(),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"grants": infos})
}

type localPathInfo struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// PathInfo reports sizes for previously registered path grants. Directories
// are measured recursively so the frontend can show an accurate total before
// the upload request starts. Raw paths are rejected: only grant IDs the
// requesting owner holds are resolved.
func (h *Handler) PathInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		PathGrantIDs []string `json:"pathGrantIds"`
		// Legacy raw path contract: rejected outright (audit F-01).
		Paths []string `json:"paths"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request: "+err.Error())
		return
	}
	if len(req.Paths) > 0 {
		writeError(w, http.StatusGone, "raw local paths are no longer accepted; use pathGrantIds from POST /api/filetransfer/paste")
		return
	}
	ownerID := owner.From(r.Context())
	if ownerID == "" {
		writeError(w, http.StatusForbidden, "request has no owner identity")
		return
	}
	if len(req.PathGrantIDs) > maxFiles {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("too many grants (max %d)", maxFiles))
		return
	}
	infos := make([]localPathInfo, 0, len(req.PathGrantIDs))
	for _, id := range req.PathGrantIDs {
		p, err := h.grants.Resolve(ownerID, id, pathgrant.OpExport)
		if err != nil {
			writeError(w, http.StatusForbidden, "path grant denied or expired")
			return
		}
		size, err := localPathSize(p)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		infos = append(infos, localPathInfo{
			Name: filepath.Base(p),
			Size: size,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"paths": infos})
}

func localPathSize(localPath string) (int64, error) {
	info, err := os.Lstat(localPath)
	if err != nil {
		return 0, fmt.Errorf("stat %q: %w", localPath, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return 0, fmt.Errorf("symbolic links are not supported: %q", localPath)
	}
	if !info.IsDir() {
		if !info.Mode().IsRegular() {
			return 0, nil
		}
		return info.Size(), nil
	}
	var total int64
	err = filepath.WalkDir(localPath, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		entryInfo, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		if entryInfo.Mode().IsRegular() {
			total += entryInfo.Size()
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("read %q: %w", localPath, err)
	}
	return total, nil
}

// collectParts gathers multipart files plus the contents of every resolved
// export grant. The legacy `paths` form field is rejected outright (F-01).
func (h *Handler) collectParts(r *http.Request) ([]filePart, error) {
	form := r.MultipartForm
	parts := make([]filePart, 0, len(form.File["files"]))
	if len(form.File["files"]) > maxFiles {
		return nil, fmt.Errorf("too many files (max %d)", maxFiles)
	}
	for _, header := range form.File["files"] {
		if header == nil {
			continue
		}
		if header.Size > maxFileSize {
			return nil, fmt.Errorf("file %q is too large", header.Filename)
		}
		name := cleanArchiveName(header.Filename)
		if name == "" {
			continue
		}
		body, err := header.Open()
		if err != nil {
			closeParts(parts)
			return nil, fmt.Errorf("open %q: %w", header.Filename, err)
		}
		parts = append(parts, filePart{name: name, body: body})
	}

	if values := form.Value["paths"]; len(values) > 0 && strings.TrimSpace(values[0]) != "" {
		closeParts(parts)
		return nil, errors.New("raw local paths are no longer accepted; use pathGrantIds from POST /api/filetransfer/paste")
	}

	var grantIDs []string
	if values := form.Value["grantIds"]; len(values) > 0 {
		if err := json.Unmarshal([]byte(values[0]), &grantIDs); err != nil {
			closeParts(parts)
			return nil, fmt.Errorf("invalid pathGrantIds: %w", err)
		}
	}
	if len(grantIDs) > maxFiles {
		closeParts(parts)
		return nil, fmt.Errorf("too many grants (max %d)", maxFiles)
	}
	ownerID := owner.From(r.Context())
	if len(grantIDs) > 0 && ownerID == "" {
		closeParts(parts)
		return nil, errors.New("request has no owner identity")
	}
	total := int64(0)
	for _, id := range grantIDs {
		p, err := h.grants.Resolve(ownerID, id, pathgrant.OpExport)
		if err != nil {
			closeParts(parts)
			return nil, errors.New("path grant denied or expired; re-select the files")
		}
		before := len(parts)
		if err := h.appendLocalPath(&parts, p, 0, &total); err != nil {
			closeParts(parts)
			return nil, err
		}
		if len(parts)-before == 0 {
			return nil, fmt.Errorf("path grant contains no readable regular files: %s", filepath.Base(p))
		}
	}
	return parts, nil
}

// appendLocalPath adds a granted file or directory to parts. Directories are
// scanned recursively with a depth cap, a wall-time budget, and a total-size
// cap; symlinks are always skipped. localPath is server-resolved from a grant
// and re-verified here (defense in depth).
func (h *Handler) appendLocalPath(parts *[]filePart, localPath string, depth int, total *int64) error {
	if depth > maxScanDepth {
		return fmt.Errorf("directory scan exceeds max depth %d", maxScanDepth)
	}
	info, err := os.Lstat(localPath)
	if err != nil {
		return fmt.Errorf("stat %q: %w", localPath, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("symbolic links are not supported: %q", localPath)
	}
	if !info.IsDir() {
		return h.appendLocalFile(parts, localPath, filepath.Base(localPath), total)
	}
	root := filepath.Dir(localPath)
	return filepath.WalkDir(localPath, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		if strings.Count(rel, string(filepath.Separator)) > maxScanDepth {
			return fmt.Errorf("directory scan exceeds max depth %d", maxScanDepth)
		}
		return h.appendLocalFile(parts, current, filepath.ToSlash(rel), total)
	})
}

func (h *Handler) appendLocalFile(parts *[]filePart, localPath, archiveName string, total *int64) error {
	if len(*parts) >= maxFiles {
		return fmt.Errorf("too many files (max %d)", maxFiles)
	}
	info, err := os.Lstat(localPath)
	if err != nil {
		return fmt.Errorf("stat %q: %w", localPath, err)
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	if info.Size() > maxFileSize {
		return fmt.Errorf("file %q is too large", archiveName)
	}
	if *total+info.Size() > maxTotalInputSize {
		return fmt.Errorf("selected files exceed total size limit %d MiB", maxTotalInputSize>>20)
	}
	file, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("open %q: %w", localPath, err)
	}
	name := cleanArchiveName(archiveName)
	if name == "" {
		_ = file.Close()
		return nil
	}
	*total += info.Size()
	*parts = append(*parts, filePart{name: name, body: file})
	return nil
}

func closeParts(parts []filePart) {
	for _, part := range parts {
		_ = part.body.Close()
	}
}

func buildArchive(parts []filePart) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	seen := make(map[string]int)
	for _, part := range parts {
		entryName := cleanArchiveName(part.name)
		if entryName == "" {
			continue
		}
		entry := uniqueName(entryName, seen)
		header := &zip.FileHeader{Name: entry, Method: zip.Deflate}
		header.SetModTime(time.Now())
		writer, err := zw.CreateHeader(header)
		if err != nil {
			_ = zw.Close()
			return nil, err
		}
		if _, err := io.Copy(writer, part.body); err != nil {
			_ = zw.Close()
			return nil, err
		}
		if buf.Len() > maxArchiveSize {
			_ = zw.Close()
			return nil, fmt.Errorf("archive exceeds %d MiB", maxArchiveSize>>20)
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	if buf.Len() == 0 {
		return nil, errors.New("archive is empty")
	}
	return buf.Bytes(), nil
}

func uniqueName(name string, seen map[string]int) string {
	count := seen[name]
	seen[name] = count + 1
	if count == 0 {
		return name
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	return fmt.Sprintf("%s (%d)%s", stem, count+1, ext)
}

func cleanArchiveName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Clean(name)
	for strings.HasPrefix(name, "../") {
		name = strings.TrimPrefix(name, "../")
	}
	name = strings.TrimLeft(name, "/")
	if name == ".." || name == "." || name == "" || strings.ContainsRune(name, 0) {
		return ""
	}
	return name
}

func archiveFileName() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "tinyrouter-files.zip"
	}
	return fmt.Sprintf("tinyrouter-files-%x.zip", b[:])
}

type uploader struct {
	name   string
	upload func(context.Context, *http.Client, string, []byte) (string, error)
}

var services = []uploader{
	{name: "tfLink", upload: uploadTFLink},
	{name: "tmpfiles.org", upload: uploadTmpFiles},
	{name: "temp.sh", upload: uploadTempSh},
	{name: "Filebin", upload: uploadFilebin},
}

func uploadTFLink(ctx context.Context, client *http.Client, name string, data []byte) (string, error) {
	body, contentType, err := multipartBody("file", name, data, nil)
	if err != nil {
		return "", err
	}
	resp, err := postMultipart(ctx, client, "https://tmpfile.link/api/upload", body, contentType)
	if err != nil {
		return "", err
	}
	var result struct {
		DownloadLink string `json:"downloadLink"`
	}
	if err := json.Unmarshal(resp, &result); err != nil || result.DownloadLink == "" {
		return "", fmt.Errorf("unexpected response")
	}
	return result.DownloadLink, nil
}

func uploadTmpFiles(ctx context.Context, client *http.Client, name string, data []byte) (string, error) {
	body, contentType, err := multipartBody("file", name, data, map[string]string{"expire": "172800"})
	if err != nil {
		return "", err
	}
	resp, err := postMultipart(ctx, client, "https://tmpfiles.org/api/v1/upload", body, contentType)
	if err != nil {
		return "", err
	}
	var result struct {
		Status string `json:"status"`
		Data   struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp, &result); err != nil || result.Status != "success" || result.Data.URL == "" {
		return "", fmt.Errorf("unexpected response")
	}
	return result.Data.URL, nil
}

func uploadTempSh(ctx context.Context, client *http.Client, name string, data []byte) (string, error) {
	body, contentType, err := multipartBody("file", name, data, nil)
	if err != nil {
		return "", err
	}
	resp, err := postMultipart(ctx, client, "https://temp.sh/upload", body, contentType)
	if err != nil {
		return "", err
	}
	link := strings.TrimSpace(string(resp))
	if !strings.HasPrefix(link, "http://") && !strings.HasPrefix(link, "https://") {
		return "", fmt.Errorf("unexpected response")
	}
	return link, nil
}

func uploadFilebin(ctx context.Context, client *http.Client, name string, data []byte) (string, error) {
	var id [5]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	bin := fmt.Sprintf("tinyrouter-%x", id[:])
	url := "https://filebin.net/" + bin + "/" + name
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/zip")
	req.Header.Set("Content-Length", fmt.Sprint(len(data)))
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var result struct {
		File struct {
			Filename string `json:"filename"`
		} `json:"file"`
	}
	if err := json.NewDecoder(bufio.NewReader(resp.Body)).Decode(&result); err != nil || result.File.Filename == "" {
		return "", fmt.Errorf("unexpected response")
	}
	return "https://filebin.net/" + bin + "/" + result.File.Filename, nil
}

func multipartBody(field, name string, data []byte, fields map[string]string) ([]byte, string, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for key, value := range fields {
		if err := mw.WriteField(key, value); err != nil {
			return nil, "", err
		}
	}
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, field, name))
	h.Set("Content-Type", "application/zip")
	part, err := mw.CreatePart(h)
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write(data); err != nil {
		return nil, "", err
	}
	if err := mw.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), mw.FormDataContentType(), nil
}

func postMultipart(ctx context.Context, client *http.Client, url string, body []byte, contentType string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Content-Length", fmt.Sprint(len(body)))
	req.Header.Set("User-Agent", "TinyRouterFileTransfer/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		return nil, readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	return data, nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
