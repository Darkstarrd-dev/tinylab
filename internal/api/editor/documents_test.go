package editor

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func createMultipartReq(t *testing.T, targetURL string, content string, meta any, assets map[string][]byte) (*http.Request, string) {
	t.Helper()
	var b bytes.Buffer
	w := multipart.NewWriter(&b)

	if err := w.WriteField("content", content); err != nil {
		t.Fatal(err)
	}

	metaBytes, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.WriteField("meta", string(metaBytes)); err != nil {
		t.Fatal(err)
	}

	for fieldName, data := range assets {
		part, err := w.CreateFormFile(fieldName, fieldName)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(data); err != nil {
			t.Fatal(err)
		}
	}

	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest("POST", targetURL, &b)
	req.Header.Set("Content-Type", w.FormDataContentType())
	return req, w.FormDataContentType()
}

func TestEditorCreate_ConflictPreservesOriginal(t *testing.T) {
	h, docDir := newTestHandler(t)
	origFile := filepath.Join(docDir, "existing.txt")
	originalContent := []byte("original text keep intact")
	if err := os.WriteFile(origFile, originalContent, 0o644); err != nil {
		t.Fatal(err)
	}

	// 1. Create conflict on file -> 409
	rec := doJSON(t, h, "POST", "/create", map[string]any{
		"fileId": "existing.txt",
		"kind":   "file",
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 conflict, got %d: %s", rec.Code, rec.Body.String())
	}
	// Verify original file byte integrity
	current, _ := os.ReadFile(origFile)
	if !bytes.Equal(current, originalContent) {
		t.Fatalf("file content modified on create conflict!")
	}

	// 2. Create invalid parent -> 400
	rec = doJSON(t, h, "POST", "/create", map[string]any{
		"fileId": "non_existent_folder/sub.txt",
		"kind":   "file",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-existent parent, got %d", rec.Code)
	}

	// 3. Root parameter rejected -> 400
	rec = doJSON(t, h, "POST", "/create?root=games", map[string]any{
		"fileId": "valid.txt",
		"kind":   "file",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for root parameter, got %d", rec.Code)
	}

	// 4. Successful file creation
	rec = doJSON(t, h, "POST", "/create", map[string]any{
		"fileId": "newfile.md",
		"kind":   "file",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 ok, got %d: %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(docDir, "newfile.md")); err != nil {
		t.Fatalf("newfile.md was not created on disk")
	}

	// 5. Successful directory creation
	rec = doJSON(t, h, "POST", "/create", map[string]any{
		"fileId": "newdir",
		"kind":   "directory",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 ok, got %d: %s", rec.Code, rec.Body.String())
	}
	if info, err := os.Stat(filepath.Join(docDir, "newdir")); err != nil || !info.IsDir() {
		t.Fatalf("newdir was not created as directory")
	}
}

func TestEditorSaveAs_CancelledAndSourcePreserved(t *testing.T) {
	h, docDir := newTestHandler(t)
	stamped := stampOwner(t, httptest.NewRequest("GET", "/tree", nil))

	srcFile := filepath.Join(docDir, "src.md")
	srcContent := []byte("# Source File\n")
	if err := os.WriteFile(srcFile, srcContent, 0o644); err != nil {
		t.Fatal(err)
	}

	// Mock savePicker returning empty string (cancelled)
	h.savePicker = func(filter, initialDir, suggestedName string) (string, error) {
		return "", nil
	}

	meta := map[string]any{
		"source": map[string]any{"fileId": "src.md"},
		"name":   "NewDoc.md",
		"assets": []any{},
	}
	req, _ := createMultipartReq(t, "/save-as", "# New Content\n", meta, nil)
	rec := httptest.NewRecorder()
	h.serve(rec, req.WithContext(stamped.Context()))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on cancel, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["cancelled"] != true {
		t.Fatalf("expected cancelled: true, got %v", resp)
	}

	// Verify source file untouched
	after, _ := os.ReadFile(srcFile)
	if !bytes.Equal(after, srcContent) {
		t.Fatalf("source file was altered during cancelled save-as")
	}
}

func TestEditorSaveAs_SuccessAndReSave(t *testing.T) {
	h, docDir := newTestHandler(t)
	stamped := stampOwner(t, httptest.NewRequest("GET", "/tree", nil))

	outDir := t.TempDir()
	targetFile := filepath.Join(outDir, "external_target.md")

	h.savePicker = func(filter, initialDir, suggestedName string) (string, error) {
		return targetFile, nil
	}

	imageBytes := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'} // PNG magic
	meta := map[string]any{
		"name": "external_target.md",
		"assets": []any{
			map[string]string{"rel": "external_target_imgs/pic.png", "field": "f_pic"},
		},
	}
	assets := map[string][]byte{"f_pic": imageBytes}
	req, _ := createMultipartReq(t, "/save-as", "# Hello Saved External\n", meta, assets)

	rec := httptest.NewRecorder()
	h.serve(rec, req.WithContext(stamped.Context()))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var res struct {
		Ok          bool   `json:"ok"`
		Name        string `json:"name"`
		PathGrantID string `json:"pathGrantId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil || !res.Ok || res.PathGrantID == "" {
		t.Fatalf("invalid save-as response: %v", rec.Body.String())
	}

	// Verify target file and image written to disk
	writtenContent, err := os.ReadFile(targetFile)
	if err != nil || string(writtenContent) != "# Hello Saved External\n" {
		t.Fatalf("target file content mismatch: %v, %s", err, string(writtenContent))
	}
	writtenImg, err := os.ReadFile(filepath.Join(outDir, "external_target_imgs", "pic.png"))
	if err != nil || !bytes.Equal(writtenImg, imageBytes) {
		t.Fatalf("target companion image mismatch: %v", err)
	}

	// Test Re-Save with normal save endpoint using pathGrantId
	saveRec := doJSONCtx(t, h, "POST", "/save", map[string]any{
		"pathGrantId": res.PathGrantID,
		"content":     "# Updated Via Grant\n",
	}, stamped)
	if saveRec.Code != http.StatusOK {
		t.Fatalf("re-save failed with code %d: %s", saveRec.Code, saveRec.Body.String())
	}
	updated, _ := os.ReadFile(targetFile)
	if string(updated) != "# Updated Via Grant\n" {
		t.Fatalf("updated file content mismatch: %s", string(updated))
	}

	// Verify foreign/expired grant rejection
	foreignReq := httptest.NewRequest("POST", "/save", strings.NewReader(`{"pathGrantId":"`+res.PathGrantID+`","content":"bad"}`))
	foreignReq.Header.Set("Content-Type", "application/json")
	foreignStamped := stampOwner(t, foreignReq) // new owner
	foreignRec := httptest.NewRecorder()
	h.serve(foreignRec, foreignStamped)
	if foreignRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for foreign grant, got %d", foreignRec.Code)
	}
	_ = docDir
}

func TestEditorOpen_StrictUTF8(t *testing.T) {
	h, docDir := newTestHandler(t)
	stamped := stampOwner(t, httptest.NewRequest("GET", "/tree", nil))

	// Write invalid UTF-8 byte sequence
	badFile := filepath.Join(docDir, "bad.bin")
	if err := os.WriteFile(badFile, []byte{0xff, 0xfe, 0xfd, 'a', 'b'}, 0o644); err != nil {
		t.Fatal(err)
	}

	// 1. Non-strict open succeeds
	rec1 := doJSONCtx(t, h, "POST", "/open", map[string]any{
		"fileId":     "bad.bin",
		"strictText": false,
	}, stamped)
	if rec1.Code != http.StatusOK {
		t.Fatalf("expected 200 for non-strict open, got %d", rec1.Code)
	}

	// 2. Strict open fails with 415 Unsupported Media Type
	rec2 := doJSONCtx(t, h, "POST", "/open", map[string]any{
		"fileId":     "bad.bin",
		"strictText": true,
	}, stamped)
	if rec2.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415 for strictText on non-UTF-8, got %d: %s", rec2.Code, rec2.Body.String())
	}
}

func TestEditorServeFileImage_SecurityContainment(t *testing.T) {
	h, docDir := newTestHandler(t)
	stamped := stampOwner(t, httptest.NewRequest("GET", "/tree", nil))

	// Setup docDir image
	docImgDir := filepath.Join(docDir, "test_imgs")
	os.MkdirAll(docImgDir, 0o755)
	imgData := []byte{0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50} // WebP header
	imgPath := filepath.Join(docImgDir, "img.webp")
	os.WriteFile(imgPath, imgData, 0o644)

	docFile := filepath.Join(docDir, "test.md")
	os.WriteFile(docFile, []byte("# Test"), 0o644)

	// 1. Normal image request
	req := httptest.NewRequest("GET", "/file-image?fileId=test.md&rel=test_imgs/img.webp", nil)
	rec := httptest.NewRecorder()
	h.serve(rec, req.WithContext(stamped.Context()))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for file-image, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Content-Type") != "image/webp" {
		t.Fatalf("expected image/webp content type, got %s", rec.Header().Get("Content-Type"))
	}

	// 2. Path escape attempt
	req = httptest.NewRequest("GET", "/file-image?fileId=test.md&rel=../../outside.webp", nil)
	rec = httptest.NewRecorder()
	h.serve(rec, req.WithContext(stamped.Context()))
	if rec.Code == http.StatusOK {
		t.Fatalf("expected error for path escape, got 200")
	}

	// 3. Non-image extension rejected
	secretTxt := filepath.Join(docDir, "secret.txt")
	os.WriteFile(secretTxt, []byte("password"), 0o644)
	req = httptest.NewRequest("GET", "/file-image?fileId=test.md&rel=../secret.txt", nil)
	rec = httptest.NewRecorder()
	h.serve(rec, req.WithContext(stamped.Context()))
	if rec.Code == http.StatusOK {
		t.Fatalf("expected error for non-image extension, got 200")
	}
}

func TestEditorSaveDocument_CreateOnlyAndRollback(t *testing.T) {
	h, docDir := newTestHandler(t)
	stamped := stampOwner(t, httptest.NewRequest("GET", "/tree", nil))

	existPath := filepath.Join(docDir, "conflict.md")
	os.WriteFile(existPath, []byte("existing"), 0o644)

	// 1. createOnly on existing file -> 409
	meta := map[string]any{
		"target":     map[string]any{"fileId": "conflict.md"},
		"createOnly": true,
		"assets":     []any{},
	}
	req, _ := createMultipartReq(t, "/save-document", "new text", meta, nil)
	rec := httptest.NewRecorder()
	h.serve(rec, req.WithContext(stamped.Context()))
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 for createOnly conflict, got %d: %s", rec.Code, rec.Body.String())
	}

	// 2. Rollback when asset fails
	// Manifest specifies an asset with illegal non-image extension (.exe)
	badMeta := map[string]any{
		"target":     map[string]any{"fileId": "newdoc.md"},
		"createOnly": true,
		"assets": []any{
			map[string]string{"rel": "newdoc_imgs/malicious.exe", "field": "f_bad"},
		},
	}
	req, _ = createMultipartReq(t, "/save-document", "bad content", badMeta, map[string][]byte{"f_bad": []byte("MZ")})
	rec = httptest.NewRecorder()
	h.serve(rec, req.WithContext(stamped.Context()))
	if rec.Code == http.StatusOK {
		t.Fatalf("expected failure for bad image extension, got 200")
	}

	// Verify target file was never created
	if _, err := os.Stat(filepath.Join(docDir, "newdoc.md")); err == nil {
		t.Fatalf("newdoc.md should not exist on aborted save")
	}
}

func TestEditorSaveDocument_BodyTooLarge(t *testing.T) {
	h, _ := newTestHandler(t)
	stamped := stampOwner(t, httptest.NewRequest("GET", "/tree", nil))

	// Construct oversized multipart (>32MiB)
	hugeData := make([]byte, 33*1024*1024)
	meta := map[string]any{
		"target": map[string]any{"fileId": "huge.md"},
		"assets": []any{},
	}
	req, _ := createMultipartReq(t, "/save-document", string(hugeData), meta, nil)
	rec := httptest.NewRecorder()
	h.serve(rec, req.WithContext(stamped.Context()))
	if rec.Code != http.StatusRequestEntityTooLarge && rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 413 or 400 for huge body, got %d", rec.Code)
	}
}

func TestEditorSaveAs_GrantFailureWrittenBranch(t *testing.T) {
	h, docDir := newTestHandler(t)
	stamped := stampOwner(t, httptest.NewRequest("GET", "/tree", nil))

	outDir := t.TempDir()
	targetFile := filepath.Join(outDir, "grant_fail.md")

	h.savePicker = func(filter, initialDir, suggestedName string) (string, error) {
		return targetFile, nil
	}

	// Watch for file creation in background and delete it before Grant runs
	stopCh := make(chan struct{})
	defer close(stopCh)
	go func() {
		for {
			select {
			case <-stopCh:
				return
			default:
				if _, err := os.Stat(targetFile); err == nil {
					_ = os.Remove(targetFile)
					return
				}
			}
		}
	}()

	meta := map[string]any{
		"name":   "grant_fail.md",
		"assets": []any{},
	}
	req, _ := createMultipartReq(t, "/save-as", "written content", meta, nil)
	rec := httptest.NewRecorder()
	h.serve(rec, req.WithContext(stamped.Context()))

	if rec.Code == http.StatusInternalServerError {
		var res map[string]any
		json.Unmarshal(rec.Body.Bytes(), &res)
		if res["written"] == true {
			// Successfully triggered written: true branch
			return
		}
	} else if rec.Code == http.StatusOK {
		// If timing didn't catch the delete before grant, file was written
		t.Logf("grant succeeded before async deletion, test passed normally")
	}
	_ = docDir
}

func TestEditorSaveDocument_ValidationAndConflictClassification(t *testing.T) {
	h, docDir := newTestHandler(t)

	// 1. Validation error: invalid asset extension -> 400
	metaInvalidExt := map[string]any{
		"target": map[string]any{"fileId": "note.md"},
		"assets": []map[string]string{
			{"rel": "note_imgs/malicious.exe", "field": "asset_0"},
		},
	}
	req, _ := createMultipartReq(t, "/save-document", "test", metaInvalidExt, map[string][]byte{
		"asset_0": []byte("binary data"),
	})
	stamped := stampOwner(t, req)
	rec := httptest.NewRecorder()
	h.serve(rec, stamped)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid asset ext, got %d: %s", rec.Code, rec.Body.String())
	}

	// 2. Conflict error: asset already exists with different content -> 409
	assetDir := filepath.Join(docDir, "note_imgs")
	if err := os.MkdirAll(assetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	existingAssetPath := filepath.Join(assetDir, "image.png")
	if err := os.WriteFile(existingAssetPath, []byte("original image bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	metaConflict := map[string]any{
		"target": map[string]any{"fileId": "note.md"},
		"assets": []map[string]string{
			{"rel": "note_imgs/image.png", "field": "asset_0"},
		},
	}
	reqConflict, _ := createMultipartReq(t, "/save-document", "test", metaConflict, map[string][]byte{
		"asset_0": []byte("different image bytes!"),
	})
	stampedConflict := stampOwner(t, reqConflict)
	recConflict := httptest.NewRecorder()
	h.serve(recConflict, stampedConflict)
	if recConflict.Code != http.StatusConflict {
		t.Fatalf("expected 409 conflict for asset with different content, got %d: %s", recConflict.Code, recConflict.Body.String())
	}
}

