package storymaker

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/storymaker"
)

func TestRegister_BooksCRUD(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "storymaker_api_test_*")
	if err != nil {
		t.Fatalf("create temp dir: %v", err)
	}
	defer func() { _ = os.RemoveAll(tempDir) }()

	store, err := storymaker.Open(tempDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = store.Close() }()

	h := NewHandler(&apibase.Deps{}, store)
	r := chi.NewRouter()
	h.Register(r)

	// 1. Initial list books should be empty
	req := httptest.NewRequest("GET", "/books", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}
	var resp struct {
		Books []storymaker.Book `json:"books"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode books response: %v", err)
	}
	if len(resp.Books) != 0 {
		t.Fatalf("expected 0 books, got %d", len(resp.Books))
	}

	// 2. Create a book
	createBody := map[string]string{
		"title":       "测试小说",
		"description": "这是一本测试书",
	}
	raw, _ := json.Marshal(createBody)
	req = httptest.NewRequest("POST", "/books", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200 on create, got %d: %s", w.Code, w.Body.String())
	}
	var created storymaker.Book
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatalf("decode created book: %v", err)
	}
	if created.ID == "" || created.Title != "测试小说" {
		t.Fatalf("unexpected created book: %+v", created)
	}

	// 3. Patch book title
	patchBody := map[string]string{
		"title": "修改后的书名",
	}
	rawPatch, _ := json.Marshal(patchBody)
	req = httptest.NewRequest("PATCH", "/books/"+created.ID, bytes.NewReader(rawPatch))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200 on patch, got %d", w.Code)
	}

	// 4. Verify in list
	req = httptest.NewRequest("GET", "/books", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}
	var resp4 struct {
		Books []storymaker.Book `json:"books"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp4); err != nil {
		t.Fatalf("decode books: %v", err)
	}
	if len(resp4.Books) != 1 || resp4.Books[0].Title != "修改后的书名" {
		t.Fatalf("expected 1 book with updated title, got %+v", resp4.Books)
	}

	// 5. Delete book
	req = httptest.NewRequest("DELETE", "/books/"+created.ID, nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200 on delete, got %d", w.Code)
	}

	// 6. List again, should be empty
	req = httptest.NewRequest("GET", "/books", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var resp6 struct {
		Books []storymaker.Book `json:"books"`
	}
	_ = json.NewDecoder(w.Body).Decode(&resp6)
	if len(resp6.Books) != 0 {
		t.Fatalf("expected 0 books after delete, got %d", len(resp6.Books))
	}
}
