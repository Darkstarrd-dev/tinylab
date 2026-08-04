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
)

func TestBuildArchiveSanitizesAndDeduplicatesNames(t *testing.T) {
	parts := []filePart{
		{name: "../escape.txt", body: io.NopCloser(strings.NewReader("one"))},
		{name: "dir/file.txt", body: io.NopCloser(strings.NewReader("two"))},
		{name: "dir/file.txt", body: io.NopCloser(strings.NewReader("three"))},
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
			t.Errorf("entry %d name = %q, want %q", i, entry.Name, want[i])
		}
	}
}

func TestAppendLocalPathPreservesDirectoryRelativeNames(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "nested", "a.txt"), []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	var parts []filePart
	if err := appendLocalPath(&parts, filepath.Join(dir, "nested")); err != nil {
		t.Fatalf("appendLocalPath: %v", err)
	}
	defer closeParts(parts)
	if len(parts) != 1 || parts[0].name != "nested/a.txt" {
		t.Fatalf("parts = %+v, want nested/a.txt", parts)
	}
}

func TestLocalPathSize(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("1234"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "nested", "b.txt"), []byte("567890"), 0o600); err != nil {
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

func TestPathInfo(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "payload.bin")
	if err := os.WriteFile(file, []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	requestData, err := json.Marshal(map[string][]string{"paths": {file}})
	if err != nil {
		t.Fatal(err)
	}
	requestBody := bytes.NewReader(requestData)
	req := httptest.NewRequest(http.MethodPost, "/path-info", requestBody)
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	NewHandler().PathInfo(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var result struct {
		Paths []localPathInfo `json:"paths"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Paths) != 1 || result.Paths[0].Name != "payload.bin" || result.Paths[0].Size != 7 {
		t.Fatalf("result = %+v", result)
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
	NewHandler().Upload(response, req)
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
