package filetransfer

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/owner"
	"github.com/tinyrouter/tinyrouter/internal/pathgrant"
)

// requestWithOwner runs req through the owner middleware and returns the
// stamped request (the middleware also writes the owner cookie to rec).
func requestWithOwner(t *testing.T, req *http.Request, rec *httptest.ResponseRecorder) *http.Request {
	t.Helper()
	var stamped *http.Request
	mw := owner.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stamped = r
	}))
	mw.ServeHTTP(rec, req)
	if stamped == nil {
		t.Fatal("owner middleware did not stamp the request")
	}
	return stamped
}

func TestBuildArchiveSanitizesAndDeduplicatesNames(t *testing.T) {
	parts := []filePart{
		{name: "../escape.txt", body: io.NopCloser(strings.NewReader("x"))},
		{name: "dir/file.txt", body: io.NopCloser(strings.NewReader("y"))},
		{name: "dir/file.txt", body: io.NopCloser(strings.NewReader("z"))},
	}
	data, err := buildArchive(parts)
	if err != nil {
		t.Fatalf("buildArchive: %v", err)
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("read archive: %v", err)
	}
	if len(reader.File) != len(parts) {
		t.Fatalf("expected %d entries, got %d", len(parts), len(reader.File))
	}
	want := []string{"escape.txt", "dir/file.txt", "dir/file (2).txt"}
	for i, entry := range reader.File {
		if entry.Name != want[i] {
			t.Fatalf("entry %d = %q, want %q", i, entry.Name, want[i])
		}
	}
}

func TestAppendLocalPathPreservesDirectoryRelativeNames(t *testing.T) {
	h := NewHandler()
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "nested", "a.txt"), []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	var parts []filePart
	total := int64(0)
	if err := h.appendLocalPath(&parts, filepath.Join(dir, "nested"), 0, &total); err != nil {
		t.Fatalf("appendLocalPath: %v", err)
	}
	defer closeParts(parts)
	if len(parts) != 1 || parts[0].name != "nested/a.txt" {
		t.Fatalf("parts = %+v, want nested/a.txt", parts)
	}
}

func TestLocalPathSize(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.bin"), []byte("aaaaa"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.bin"), []byte("bbbbb"), 0o600); err != nil {
		t.Fatal(err)
	}
	size, err := localPathSize(dir)
	if err != nil {
		t.Fatalf("localPathSize: %v", err)
	}
	if size != 10 {
		t.Fatalf("size = %d, want 10", size)
	}
}

// TestPathInfoRejectsRawPaths pins the F-01 contract: the legacy raw `paths`
// field is rejected (410) instead of being trusted.
func TestPathInfoRejectsRawPaths(t *testing.T) {
	file := filepath.Join(t.TempDir(), "payload.bin")
	if err := os.WriteFile(file, []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	requestData, err := json.Marshal(map[string][]string{"paths": {file}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/path-info", bytes.NewReader(requestData))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	NewHandler().PathInfo(rec, requestWithOwner(t, req, httptest.NewRecorder()))
	if rec.Code != http.StatusGone {
		t.Fatalf("status = %d, want 410; body = %s", rec.Code, rec.Body.String())
	}
}

// TestPathInfoViaGrant verifies path-info resolves only registered export
// grants of the requesting owner and never leaks the server path.
func TestPathInfoViaGrant(t *testing.T) {
	h := NewHandler()
	dir := t.TempDir()
	file := filepath.Join(dir, "payload.bin")
	if err := os.WriteFile(file, []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Stamp the owner first, then register the grant under that owner, then
	// build the request body with the owner-bound grant ID.
	rec := httptest.NewRecorder()
	stamped := requestWithOwner(t, httptest.NewRequest(http.MethodPost, "/path-info", bytes.NewReader(nil)), rec)
	ownerID := owner.From(stamped.Context())
	g, err := h.grants.Grant(ownerID, []pathgrant.Operation{pathgrant.OpExport}, file, false, false)
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}

	reqBody, _ := json.Marshal(map[string][]string{"pathGrantIds": {g.ID}})
	req := httptest.NewRequest(http.MethodPost, "/path-info", bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(stamped.Context())
	h.PathInfo(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var result struct {
		Paths []localPathInfo `json:"paths"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Paths) != 1 || result.Paths[0].Name != "payload.bin" || result.Paths[0].Size != 7 {
		t.Fatalf("result = %+v", result)
	}
}

// TestPathInfoForeignGrant verifies a grant registered under one owner is
// denied to another owner (F-01 grant owner/session isolation).
func TestPathInfoForeignGrant(t *testing.T) {
	h := NewHandler()
	file := filepath.Join(t.TempDir(), "secret.bin")
	if err := os.WriteFile(file, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	g, err := h.grants.Grant("owner-a", []pathgrant.Operation{pathgrant.OpExport}, file, false, false)
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}
	reqBody, _ := json.Marshal(map[string][]string{"pathGrantIds": {g.ID}})
	req := httptest.NewRequest(http.MethodPost, "/path-info", bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.PathInfo(rec, requestWithOwner(t, req, rec)) // fresh owner != owner-a
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body = %s", rec.Code, rec.Body.String())
	}
}

// TestUploadRejectsRawPaths pins the F-01 contract at the upload boundary:
// a multipart form carrying the legacy `paths` field is rejected.
func TestUploadRejectsRawPaths(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("files", "hello.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("paths", `["C:\\Users\\evil\\secret.txt"]`); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/upload", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	NewHandler().Upload(rec, requestWithOwner(t, req, rec))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}

// TestUploadViaGrant drives the full grant flow: a registered export grant is
// resolved server-side and its content lands in the ZIP archive.
func TestUploadViaGrant(t *testing.T) {
	original := services
	t.Cleanup(func() { services = original })
	var got []byte
	services = []uploader{{
		name: "fake",
		upload: func(_ context.Context, _ *http.Client, _ string, data []byte) (string, error) {
			got = data
			return "https://example.test/archive.zip", nil
		},
	}}

	h := NewHandler()
	file := filepath.Join(t.TempDir(), "from-disk.txt")
	if err := os.WriteFile(file, []byte("disk-content"), 0o600); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/upload", bytes.NewReader(nil))
	rec := httptest.NewRecorder()
	stamped := requestWithOwner(t, req, rec)
	ownerID := owner.From(stamped.Context())
	g, err := h.grants.Grant(ownerID, []pathgrant.Operation{pathgrant.OpExport}, file, false, false)
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}

	var body2 bytes.Buffer
	writer2 := multipart.NewWriter(&body2)
	if err := writer2.WriteField("grantIds", `["`+g.ID+`"]`); err != nil {
		t.Fatal(err)
	}
	if err := writer2.Close(); err != nil {
		t.Fatal(err)
	}
	req2 := httptest.NewRequest(http.MethodPost, "/upload", &body2)
	req2.Header.Set("Content-Type", writer2.FormDataContentType())
	req2 = req2.WithContext(stamped.Context())
	rec2 := httptest.NewRecorder()
	h.Upload(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec2.Code, rec2.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(got), int64(len(got)))
	if err != nil {
		t.Fatalf("archive is not a valid zip: %v", err)
	}
	if len(zr.File) != 1 || zr.File[0].Name != "from-disk.txt" {
		t.Fatalf("entries = %+v", zr.File)
	}
	r, err := zr.File[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	content, _ := io.ReadAll(r)
	r.Close()
	if string(content) != "disk-content" {
		t.Fatalf("archive content = %q", content)
	}
}

// TestUploadForeignGrantRejected verifies an upload carrying a grant owned by
// another session is denied and no archive is produced.
func TestUploadForeignGrantRejected(t *testing.T) {
	h := NewHandler()
	file := filepath.Join(t.TempDir(), "secret.bin")
	if err := os.WriteFile(file, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	g, err := h.grants.Grant("owner-a", []pathgrant.Operation{pathgrant.OpExport}, file, false, false)
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("grantIds", `["`+g.ID+`"]`); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/upload", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	h.Upload(rec, requestWithOwner(t, req, rec)) // fresh owner != owner-a
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}

func TestUploadTriesServicesInOrder(t *testing.T) {
	original := services
	t.Cleanup(func() { services = original })
	var calls []string
	services = []uploader{
		{name: "first", upload: func(context.Context, *http.Client, string, []byte) (string, error) {
			calls = append(calls, "first")
			return "", io.ErrUnexpectedEOF
		}},
		{name: "second", upload: func(context.Context, *http.Client, string, []byte) (string, error) {
			calls = append(calls, "second")
			return "https://example.test/archive.zip", nil
		}},
		{name: "third", upload: func(context.Context, *http.Client, string, []byte) (string, error) {
			calls = append(calls, "third")
			return "", io.ErrUnexpectedEOF
		}},
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("files", "hello.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/upload", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	NewHandler().Upload(response, requestWithOwner(t, req, response))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var result struct {
		URL     string `json:"url"`
		Service string `json:"service"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.URL != "https://example.test/archive.zip" || result.Service != "second" {
		t.Fatalf("result = %+v", result)
	}
	if strings.Join(calls, ",") != "first,second" {
		t.Fatalf("service calls = %v, want [first second]", calls)
	}
}
