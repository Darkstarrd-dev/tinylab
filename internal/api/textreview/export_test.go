package textreview

import (
	"archive/zip"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestExportSplit_Success(t *testing.T) {
	h, _ := newTestHandler(t, nil, nil)
	mux := newTestRouter(h)
	tmpDir := t.TempDir()

	reqBody := ExportSplitRequest{
		TargetDir: tmpDir,
		ZipName:   "test_novel.zip",
		Chapters: []ExportChapterItem{
			{Title: "第1章 开始", Content: "这是第一章的正文内容。"},
			{Title: "第2章 发展", Content: "第2章 发展\n\n这是第二章的内容。"},
			{Title: "特别篇", Content: "这是特别篇。"},
		},
	}

	rec := doJSON(t, mux, http.MethodPost, "/api/text-review/export-split", reqBody)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var res map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res["ok"] != true {
		t.Fatalf("expected ok true, got %v", res["ok"])
	}
	outPath, _ := res["path"].(string)
	if outPath == "" {
		t.Fatalf("expected non-empty path")
	}

	// Verify the zip content
	zr, err := zip.OpenReader(outPath)
	if err != nil {
		t.Fatalf("failed to open generated zip: %v", err)
	}
	defer zr.Close()

	if len(zr.File) != 3 {
		t.Fatalf("expected 3 files in zip, got %d", len(zr.File))
	}

	expectedNames := []string{
		"01_第1章 开始.txt",
		"02_第2章 发展.txt",
		"03_特别篇.txt",
	}

	for i, f := range zr.File {
		if f.Name != expectedNames[i] {
			t.Errorf("file %d: expected name %q, got %q", i, expectedNames[i], f.Name)
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("failed to open file %s: %v", f.Name, err)
		}
		contentBytes, _ := io.ReadAll(rc)
		rc.Close()
		content := string(contentBytes)

		if i == 0 {
			if !strings.HasPrefix(content, "第1章 开始") || !strings.Contains(content, "这是第一章的正文内容。") {
				t.Errorf("unexpected content for chapter 1: %s", content)
			}
		} else if i == 1 {
			if !strings.Contains(content, "这是第二章的内容。") {
				t.Errorf("unexpected content for chapter 2: %s", content)
			}
		}
	}
}

func TestExportSplit_Validation(t *testing.T) {
	h, _ := newTestHandler(t, nil, nil)
	mux := newTestRouter(h)

	// Missing TargetDir
	rec1 := doJSON(t, mux, http.MethodPost, "/api/text-review/export-split", ExportSplitRequest{
		TargetDir: "",
		Chapters:  []ExportChapterItem{{Title: "Ch1", Content: "text"}},
	})
	if rec1.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for empty targetDir, got %d", rec1.Code)
	}

	// Empty chapters
	rec2 := doJSON(t, mux, http.MethodPost, "/api/text-review/export-split", ExportSplitRequest{
		TargetDir: t.TempDir(),
		Chapters:  []ExportChapterItem{},
	})
	if rec2.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for empty chapters, got %d", rec2.Code)
	}
}
