// Package filetransfer creates a ZIP archive from user-selected files and
// publishes it to an anonymous temporary file host.
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
)

const (
	maxArchiveSize = 500 << 20
	maxFiles       = 2000
	maxFileSize    = 500 << 20
)

type filePart struct {
	name string
	body io.ReadCloser
}

type Handler struct {
	client *http.Client
}

// NewHandler creates a file-transfer handler with a long-lived client for
// uploading archives to temporary file hosts.
func NewHandler() *Handler {
	return &Handler{client: &http.Client{Timeout: 15 * time.Minute}}
}

// Upload receives selected files and optional native local paths, packages
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
	parts, err := collectParts(r.MultipartForm)
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

type localPathInfo struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// PathInfo reports sizes for local paths copied from the native clipboard.
// Directories are measured recursively so the frontend can show an accurate
// total before the upload request starts.
func (h *Handler) PathInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Paths []string `json:"paths"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid path request: "+err.Error())
		return
	}
	if len(req.Paths) > maxFiles {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("too many paths (max %d)", maxFiles))
		return
	}
	infos := make([]localPathInfo, 0, len(req.Paths))
	for _, rawPath := range req.Paths {
		localPath := filepath.Clean(strings.TrimSpace(rawPath))
		if localPath == "" {
			continue
		}
		size, err := localPathSize(localPath)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		infos = append(infos, localPathInfo{
			Path: localPath,
			Name: filepath.Base(localPath),
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

func collectParts(form *multipart.Form) ([]filePart, error) {
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

	var pathsJSON string
	if values := form.Value["paths"]; len(values) > 0 {
		pathsJSON = values[0]
	}
	if pathsJSON == "" {
		return parts, nil
	}
	var paths []string
	if err := json.Unmarshal([]byte(pathsJSON), &paths); err != nil {
		closeParts(parts)
		return nil, fmt.Errorf("invalid local paths: %w", err)
	}
	if len(paths) > maxFiles {
		closeParts(parts)
		return nil, fmt.Errorf("too many paths (max %d)", maxFiles)
	}
	for _, localPath := range paths {
		if err := appendLocalPath(&parts, localPath); err != nil {
			closeParts(parts)
			return nil, err
		}
	}
	return parts, nil
}

func appendLocalPath(parts *[]filePart, localPath string) error {
	localPath = filepath.Clean(strings.TrimSpace(localPath))
	if localPath == "" {
		return nil
	}
	info, err := os.Lstat(localPath)
	if err != nil {
		return fmt.Errorf("stat %q: %w", localPath, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("symbolic links are not supported: %q", localPath)
	}
	if !info.IsDir() {
		return appendLocalFile(parts, localPath, filepath.Base(localPath))
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
		return appendLocalFile(parts, current, filepath.ToSlash(rel))
	})
}

func appendLocalFile(parts *[]filePart, localPath, archiveName string) error {
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
	file, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("open %q: %w", localPath, err)
	}
	name := cleanArchiveName(archiveName)
	if name == "" {
		_ = file.Close()
		return nil
	}
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
