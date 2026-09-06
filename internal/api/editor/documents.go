package editor

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/fsutil"
	"github.com/tinylab/tinylab/internal/owner"
	"github.com/tinylab/tinylab/internal/pathgrant"
)

const maxMultipartBodySize int64 = 32 * 1024 * 1024 // 32 MiB

type documentAsset struct {
	rel   string
	field string
	data  []byte
}

type validationError struct {
	msg string
}

func (e *validationError) Error() string { return e.msg }

type conflictError struct {
	msg string
}

func (e *conflictError) Error() string { return e.msg }

func writeBundleHTTPError(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	var vErr *validationError
	if errors.As(err, &vErr) {
		apibase.WriteAPIError(w, http.StatusBadRequest, vErr.Error())
		return
	}
	var cErr *conflictError
	if errors.As(err, &cErr) || errors.Is(err, os.ErrExist) || os.IsExist(err) {
		apibase.WriteAPIError(w, http.StatusConflict, err.Error())
		return
	}
	apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
}

// editorCreate handles POST /api/editor/create { "fileId": string, "kind": "file"|"directory" }.
// It creates an empty file with O_CREATE|O_EXCL or a directory inside docDir.
func (h *Handler) editorCreate(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("root") != "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "root parameter is not allowed for /create")
		return
	}

	var req struct {
		FileID string `json:"fileId"`
		Kind   string `json:"kind"` // "file" | "directory"
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	if req.FileID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "fileId is required")
		return
	}
	if req.Kind != "file" && req.Kind != "directory" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "kind must be 'file' or 'directory'")
		return
	}

	full, err := h.resolveDocFile(req.FileID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid fileId: "+err.Error())
		return
	}

	leaf := filepath.Base(full)
	if _, err := validateRenameName(leaf); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid name: "+err.Error())
		return
	}

	parent := filepath.Dir(full)
	pinfo, err := os.Stat(parent)
	if err != nil {
		if os.IsNotExist(err) {
			apibase.WriteAPIError(w, http.StatusBadRequest, "parent directory does not exist")
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, "stat parent failed: "+err.Error())
		return
	}
	if !pinfo.IsDir() {
		apibase.WriteAPIError(w, http.StatusBadRequest, "parent path is not a directory")
		return
	}

	if req.Kind == "directory" {
		if err := os.Mkdir(full, 0o755); err != nil {
			if os.IsExist(err) {
				apibase.WriteAPIError(w, http.StatusConflict, "directory already exists")
				return
			}
			apibase.WriteAPIError(w, http.StatusInternalServerError, "mkdir failed: "+err.Error())
			return
		}
	} else {
		f, err := os.OpenFile(full, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			if os.IsExist(err) {
				apibase.WriteAPIError(w, http.StatusConflict, "file already exists")
				return
			}
			apibase.WriteAPIError(w, http.StatusInternalServerError, "create file failed: "+err.Error())
			return
		}
		_ = f.Close()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":     true,
		"fileId": req.FileID,
		"name":   leaf,
		"isDir":  req.Kind == "directory",
	})
}

// writeDocumentBundle validates assets, writes new images atomically, and writes the document body.
// On failure, any newly created asset files are cleaned up.
func writeDocumentBundle(target string, content []byte, assets []documentAsset, createOnly bool) error {
	parent := filepath.Dir(target)
	pinfo, err := os.Stat(parent)
	if err != nil || !pinfo.IsDir() {
		return &validationError{msg: "target parent directory does not exist or is not a directory"}
	}

	// Canonical parent check
	realParent, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return fmt.Errorf("eval parent symlink failed: %w", err)
	}

	// Validate target not symlink
	if tinfo, err := os.Lstat(target); err == nil {
		if tinfo.Mode()&os.ModeSymlink != 0 {
			return &validationError{msg: "target file is a symlink"}
		}
		if tinfo.IsDir() {
			return &validationError{msg: "target path is a directory"}
		}
		if createOnly {
			return &conflictError{msg: "destination file already exists"}
		}
	}

	// Validate assets
	seenRels := make(map[string]bool)
	seenFields := make(map[string]bool)

	type plannedAsset struct {
		destPath string
		data     []byte
		isNew    bool
	}
	var planned []plannedAsset

	for _, a := range assets {
		if a.rel == "" {
			return &validationError{msg: "asset rel is required"}
		}
		if seenRels[a.rel] {
			return &validationError{msg: fmt.Sprintf("duplicate asset rel: %s", a.rel)}
		}
		seenRels[a.rel] = true

		if a.field != "" {
			if seenFields[a.field] {
				return &validationError{msg: fmt.Sprintf("duplicate asset field: %s", a.field)}
			}
			seenFields[a.field] = true
		}

		strict, err := pathgrant.StrictRel(a.rel)
		if err != nil {
			return &validationError{msg: fmt.Sprintf("invalid asset rel %q: %v", a.rel, err)}
		}

		// At most one companion directory level: <stem>_imgs/filename.ext or filename.ext
		parts := strings.Split(filepath.ToSlash(strict), "/")
		if len(parts) > 2 {
			return &validationError{msg: fmt.Sprintf("asset rel %q exceeds allowed folder depth (max 1 subfolder)", a.rel)}
		}

		leaf := filepath.Base(strict)
		ext := strings.ToLower(filepath.Ext(leaf))
		if !editorImageExts[ext] {
			return &validationError{msg: fmt.Sprintf("asset %q has unsupported image extension %q", a.rel, ext)}
		}
		if len(a.data) == 0 {
			return &validationError{msg: fmt.Sprintf("asset %q has empty data", a.rel)}
		}

		assetDest := filepath.Join(parent, filepath.FromSlash(strict))

		// Check parent directory of asset is within realParent
		assetDir := filepath.Dir(assetDest)
		if !realPathWithin(realParent, assetDir) {
			return &validationError{msg: fmt.Sprintf("asset %q escapes target directory", a.rel)}
		}

		// Check if asset file or dir is a symlink
		if ainfo, err := os.Lstat(assetDest); err == nil {
			if ainfo.Mode()&os.ModeSymlink != 0 {
				return &validationError{msg: fmt.Sprintf("asset %q exists as a symlink", a.rel)}
			}
			if ainfo.IsDir() {
				return &validationError{msg: fmt.Sprintf("asset %q exists as a directory", a.rel)}
			}
			// Existing file: verify exact match
			existing, rerr := os.ReadFile(assetDest)
			if rerr != nil {
				return fmt.Errorf("failed to read existing asset %q: %w", a.rel, rerr)
			}
			if !bytes.Equal(existing, a.data) {
				return &conflictError{msg: fmt.Sprintf("asset %q already exists with different content", a.rel)}
			}
			planned = append(planned, plannedAsset{destPath: assetDest, data: a.data, isNew: false})
		} else {
			planned = append(planned, plannedAsset{destPath: assetDest, data: a.data, isNew: true})
		}
	}

	// Write new asset files
	var createdFiles []string
	rollback := func() {
		for _, f := range createdFiles {
			_ = os.Remove(f)
		}
	}

	for _, p := range planned {
		if !p.isNew {
			continue
		}
		dir := filepath.Dir(p.destPath)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			rollback()
			return fmt.Errorf("failed to create asset directory: %w", err)
		}
		f, err := os.OpenFile(p.destPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			rollback()
			return fmt.Errorf("failed to write asset %q: %w", p.destPath, err)
		}
		if _, err := f.Write(p.data); err != nil {
			_ = f.Close()
			_ = os.Remove(p.destPath)
			rollback()
			return fmt.Errorf("failed to write asset data: %w", err)
		}
		if err := f.Close(); err != nil {
			_ = os.Remove(p.destPath)
			rollback()
			return fmt.Errorf("failed to close asset file: %w", err)
		}
		createdFiles = append(createdFiles, p.destPath)
	}

	// Write document content
	if createOnly {
		f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			rollback()
			return err
		}
		if _, err := f.Write(content); err != nil {
			_ = f.Close()
			_ = os.Remove(target)
			rollback()
			return fmt.Errorf("failed to write document content: %w", err)
		}
		if err := f.Close(); err != nil {
			_ = os.Remove(target)
			rollback()
			return fmt.Errorf("failed to close document file: %w", err)
		}
	} else {
		if err := fsutil.AtomicWrite(target, content, 0o644); err != nil {
			rollback()
			return fmt.Errorf("atomic write document failed: %w", err)
		}
	}

	return nil
}

// editorSaveDocument handles POST /api/editor/save-document (multipart).
func (h *Handler) editorSaveDocument(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxMultipartBodySize)
	if err := r.ParseMultipartForm(maxMultipartBodySize); err != nil {
		apibase.WriteAPIError(w, http.StatusRequestEntityTooLarge, "request too large: "+err.Error())
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}

	content := r.FormValue("content")
	if int64(len(content)) > maxOpenSize {
		apibase.WriteAPIError(w, http.StatusBadRequest, "document content exceeds 16 MiB limit")
		return
	}

	metaStr := r.FormValue("meta")
	if metaStr == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "meta field is required")
		return
	}

	var meta struct {
		Target struct {
			FileID      string `json:"fileId"`
			PathGrantID string `json:"pathGrantId"`
		} `json:"target"`
		CreateOnly bool `json:"createOnly"`
		Assets     []struct {
			Rel   string `json:"rel"`
			Field string `json:"field"`
		} `json:"assets"`
	}
	if err := json.Unmarshal([]byte(metaStr), &meta); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid meta JSON: "+err.Error())
		return
	}

	target, err := h.saveTarget(r, meta.Target.FileID, meta.Target.PathGrantID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Read assets
	var assets []documentAsset
	for _, mAsset := range meta.Assets {
		files := r.MultipartForm.File[mAsset.Field]
		if len(files) == 0 {
			apibase.WriteAPIError(w, http.StatusBadRequest, fmt.Sprintf("asset file part %q missing", mAsset.Field))
			return
		}
		fileHeader := files[0]
		fileObj, err := fileHeader.Open()
		if err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "open asset part failed: "+err.Error())
			return
		}
		data, err := io.ReadAll(fileObj)
		_ = fileObj.Close()
		if err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "read asset part failed: "+err.Error())
			return
		}
		assets = append(assets, documentAsset{
			rel:   mAsset.Rel,
			field: mAsset.Field,
			data:  data,
		})
	}

	if err := writeDocumentBundle(target, []byte(content), assets, meta.CreateOnly); err != nil {
		writeBundleHTTPError(w, err)
		return
	}

	fileID := ""
	if meta.Target.PathGrantID == "" {
		if rel, rerr := filepath.Rel(h.baseDir(r), target); rerr == nil && !strings.HasPrefix(rel, "..") {
			fileID = filepath.ToSlash(rel)
		}
	}

	resp := map[string]any{
		"ok":     true,
		"name":   filepath.Base(target),
		"fileId": fileID,
	}
	if meta.Target.PathGrantID != "" {
		resp["pathGrantId"] = meta.Target.PathGrantID
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// editorSaveAs handles POST /api/editor/save-as (multipart).
func (h *Handler) editorSaveAs(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxMultipartBodySize)
	if err := r.ParseMultipartForm(maxMultipartBodySize); err != nil {
		apibase.WriteAPIError(w, http.StatusRequestEntityTooLarge, "request too large: "+err.Error())
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}

	content := r.FormValue("content")
	if int64(len(content)) > maxOpenSize {
		apibase.WriteAPIError(w, http.StatusBadRequest, "document content exceeds 16 MiB limit")
		return
	}

	metaStr := r.FormValue("meta")
	if metaStr == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "meta field is required")
		return
	}

	var meta struct {
		Source *struct {
			FileID      string `json:"fileId"`
			PathGrantID string `json:"pathGrantId"`
		} `json:"source"`
		Name   string `json:"name"`
		Assets []struct {
			Rel   string `json:"rel"`
			Field string `json:"field"`
		} `json:"assets"`
	}
	if err := json.Unmarshal([]byte(metaStr), &meta); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid meta JSON: "+err.Error())
		return
	}

	ownerID := owner.From(r.Context())
	if ownerID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "request has no owner identity")
		return
	}

	// Determine initial picker directory from source
	initialDir := h.docDir()
	if meta.Source != nil {
		if meta.Source.PathGrantID != "" {
			if srcPath, err := h.grants.Resolve(ownerID, meta.Source.PathGrantID, pathgrant.OpRead); err == nil {
				initialDir = filepath.Dir(srcPath)
			}
		} else if meta.Source.FileID != "" {
			if srcPath, err := h.resolveDocFile(meta.Source.FileID); err == nil {
				initialDir = filepath.Dir(srcPath)
			}
		}
	}

	// Validate & read assets prior to picker dialog
	var assets []documentAsset
	for _, mAsset := range meta.Assets {
		files := r.MultipartForm.File[mAsset.Field]
		if len(files) == 0 {
			apibase.WriteAPIError(w, http.StatusBadRequest, fmt.Sprintf("asset file part %q missing", mAsset.Field))
			return
		}
		fileHeader := files[0]
		fileObj, err := fileHeader.Open()
		if err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "open asset part failed: "+err.Error())
			return
		}
		data, err := io.ReadAll(fileObj)
		_ = fileObj.Close()
		if err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "read asset part failed: "+err.Error())
			return
		}
		assets = append(assets, documentAsset{
			rel:   mAsset.Rel,
			field: mAsset.Field,
			data:  data,
		})
	}

	// Show Save File Picker
	filter := "Markdown & Text (*.md;*.txt;*.json;*.yaml;*.yml;*.html;*.htm;*.js;*.ts;*.go)|*.md;*.txt;*.json;*.yaml;*.yml;*.html;*.htm;*.js;*.ts;*.go|All Files (*.*)|*.*"
	pickerFn := h.savePicker
	if pickerFn == nil {
		pickerFn = fsutil.SaveFilePickerAt
	}

	suggestedName := meta.Name
	if suggestedName == "" {
		suggestedName = "Untitled.md"
	}

	targetPath, err := pickerFn(filter, initialDir, suggestedName)
	if err != nil {
		if errors.Is(err, fsutil.ErrUnsupportedPlatform) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"unsupported": true})
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, "save picker error: "+err.Error())
		return
	}
	if targetPath == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"cancelled": true})
		return
	}

	if r.Context().Err() != nil {
		return
	}

	// Write document bundle to targetPath
	if err := writeDocumentBundle(targetPath, []byte(content), assets, false); err != nil {
		writeBundleHTTPError(w, err)
		return
	}

	// Issue read/write grant for written file
	g, err := h.grants.Grant(ownerID, []pathgrant.Operation{pathgrant.OpRead, pathgrant.OpWrite}, targetPath, false, false)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]any{
			"error":   "file written successfully but grant registration failed: " + err.Error(),
			"written": true,
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":          true,
		"name":        filepath.Base(targetPath),
		"pathGrantId": g.ID,
		"fileId":      "",
	})
}
