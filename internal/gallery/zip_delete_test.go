package gallery

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"math/rand"
	"testing"
)

// buildStoreZip creates a zip archive where all entries use the Store
// (uncompressed) method. The files parameter is an ordered slice of
// (name, content) pairs to ensure a deterministic layout.
func buildStoreZip(t *testing.T, files []struct {
	Name    string
	Content []byte
}) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	for _, f := range files {
		fh := &zip.FileHeader{
			Name:   f.Name,
			Method: zip.Store,
		}
		w, err := zw.CreateHeader(fh)
		if err != nil {
			t.Fatalf("create header %q: %v", f.Name, err)
		}
		if _, err := w.Write(f.Content); err != nil {
			t.Fatalf("write %q: %v", f.Name, err)
		}
	}

	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

// TestDeleteZipEntry_Store_Middle constructs a store zip with 5 entries
// (mixed extensions), deletes the middle one (index 2), and verifies that
// the result is a valid zip with 4 entries whose names, sizes, and content
// match the original (except the deleted one).
func TestDeleteZipEntry_Store_Middle(t *testing.T) {
	files := []struct {
		Name    string
		Content []byte
	}{
		{"alpha.png", []byte("alpha-data")},
		{"beta.webp", []byte("beta-data")},
		{"gamma.jpg", []byte("gamma-data")},
		{"delta.bmp", []byte("delta-data")},
		{"epsilon.tiff", []byte("epsilon-data")},
	}
	data := buildStoreZip(t, files)

	// Delete "gamma.jpg" (index 2)
	result, manifest, err := DeleteZipEntry(data, "gamma.jpg")
	if err != nil {
		t.Fatalf("DeleteZipEntry: %v", err)
	}

	// Verify zip structure
	z, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("result zip parse error: %v", err)
	}
	if len(z.File) != 4 {
		t.Fatalf("expected 4 entries, got %d", len(z.File))
	}

	// Verify each remaining entry matches original content
	checkEntry := func(name, wantContent string) {
		rc, err := openZipEntry(z, name)
		if err != nil {
			t.Fatalf("open %q: %v", name, err)
		}
		got, err := readAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("read %q: %v", name, err)
		}
		if string(got) != wantContent {
			t.Fatalf("entry %q: want %q, got %q", name, wantContent, string(got))
		}
	}
	checkEntry("alpha.png", "alpha-data")
	checkEntry("beta.webp", "beta-data")
	checkEntry("delta.bmp", "delta-data")
	checkEntry("epsilon.tiff", "epsilon-data")

	// Verify manifest
	if manifest.Total != 4 {
		t.Fatalf("manifest.Total: want 4, got %d", manifest.Total)
	}
	if len(manifest.Entries) != 4 {
		t.Fatalf("manifest.Entries: want 4, got %d", len(manifest.Entries))
	}

	// Manifest entries should be sorted by name (naturalLess) and re-indexed from 0
	wantPaths := []string{"alpha.png", "beta.webp", "delta.bmp", "epsilon.tiff"}
	for i, e := range manifest.Entries {
		if e.Index != i {
			t.Fatalf("entry %d: want Index %d, got %d", i, i, e.Index)
		}
		if e.Path != wantPaths[i] {
			t.Fatalf("entry %d: want Path %q, got %q", i, wantPaths[i], e.Path)
		}
	}
}

// TestDeleteZipEntry_Store_First deletes the first entry (index 0).
func TestDeleteZipEntry_Store_First(t *testing.T) {
	files := []struct {
		Name    string
		Content []byte
	}{
		{"first.png", []byte("first-data")},
		{"second.png", []byte("second-data")},
		{"third.png", []byte("third-data")},
	}
	data := buildStoreZip(t, files)

	result, manifest, err := DeleteZipEntry(data, "first.png")
	if err != nil {
		t.Fatalf("DeleteZipEntry: %v", err)
	}

	z, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("result zip parse error: %v", err)
	}
	if len(z.File) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(z.File))
	}

	// Verify content
	checkEntry := func(name, wantContent string) {
		rc, err := openZipEntry(z, name)
		if err != nil {
			t.Fatalf("open %q: %v", name, err)
		}
		got, err := readAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("read %q: %v", name, err)
		}
		if string(got) != wantContent {
			t.Fatalf("entry %q: want %q, got %q", name, wantContent, string(got))
		}
	}
	checkEntry("second.png", "second-data")
	checkEntry("third.png", "third-data")

	if manifest.Total != 2 {
		t.Fatalf("manifest.Total: want 2, got %d", manifest.Total)
	}
}

// TestDeleteZipEntry_Store_Last deletes the last entry (covers the delEnd=cdOffset branch).
func TestDeleteZipEntry_Store_Last(t *testing.T) {
	files := []struct {
		Name    string
		Content []byte
	}{
		{"first.png", []byte("first-data")},
		{"second.png", []byte("second-data")},
		{"last.png", []byte("last-data")},
	}
	data := buildStoreZip(t, files)

	result, manifest, err := DeleteZipEntry(data, "last.png")
	if err != nil {
		t.Fatalf("DeleteZipEntry: %v", err)
	}

	z, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("result zip parse error: %v", err)
	}
	if len(z.File) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(z.File))
	}

	// Verify content
	rc, err := openZipEntry(z, "first.png")
	if err != nil {
		t.Fatalf("open first.png: %v", err)
	}
	got, err := readAll(rc)
	rc.Close()
	if err != nil {
		t.Fatalf("read first.png: %v", err)
	}
	if string(got) != "first-data" {
		t.Fatalf("first.png: want %q, got %q", "first-data", string(got))
	}

	rc, err = openZipEntry(z, "second.png")
	if err != nil {
		t.Fatalf("open second.png: %v", err)
	}
	got, err = readAll(rc)
	rc.Close()
	if err != nil {
		t.Fatalf("read second.png: %v", err)
	}
	if string(got) != "second-data" {
		t.Fatalf("second.png: want %q, got %q", "second-data", string(got))
	}

	if manifest.Total != 2 {
		t.Fatalf("manifest.Total: want 2, got %d", manifest.Total)
	}
}

// TestDeleteZipEntry_Store_Multiple performs three consecutive deletions on the
// same zip, verifying correctness after each deletion.
func TestDeleteZipEntry_Store_Multiple(t *testing.T) {
	files := []struct {
		Name    string
		Content []byte
	}{
		{"a.png", []byte("a-data")},
		{"b.png", []byte("b-data")},
		{"c.png", []byte("c-data")},
		{"d.png", []byte("d-data")},
		{"e.png", []byte("e-data")},
	}
	data := buildStoreZip(t, files)

	// Delete "c.png" (middle)
	result, _, err := DeleteZipEntry(data, "c.png")
	if err != nil {
		t.Fatalf("first delete: %v", err)
	}

	// Delete "a.png" (now first)
	result, _, err = DeleteZipEntry(result, "a.png")
	if err != nil {
		t.Fatalf("second delete: %v", err)
	}

	// Delete "e.png" (now last)
	result, manifest, err := DeleteZipEntry(result, "e.png")
	if err != nil {
		t.Fatalf("third delete: %v", err)
	}

	z, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("result zip parse error: %v", err)
	}
	if len(z.File) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(z.File))
	}

	// Verify remaining: b.png, d.png
	checkEntry := func(name, wantContent string) {
		rc, err := openZipEntry(z, name)
		if err != nil {
			t.Fatalf("open %q: %v", name, err)
		}
		got, err := readAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("read %q: %v", name, err)
		}
		if string(got) != wantContent {
			t.Fatalf("entry %q: want %q, got %q", name, wantContent, string(got))
		}
	}
	checkEntry("b.png", "b-data")
	checkEntry("d.png", "d-data")

	if manifest.Total != 2 {
		t.Fatalf("manifest.Total: want 2, got %d", manifest.Total)
	}
}

// TestDeleteZipEntry_Deflate_Rejected verifies that deleting from a zip that
// contains a Deflate entry returns ErrUnsupportedMethod.
func TestDeleteZipEntry_Deflate_Rejected(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	// Create a store entry
	fh := &zip.FileHeader{Name: "good.png", Method: zip.Store}
	w, err := zw.CreateHeader(fh)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("good-data")); err != nil {
		t.Fatal(err)
	}

	// Create a deflate entry (default method)
	w2, err := zw.Create("bad.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w2.Write([]byte("bad-data")); err != nil {
		t.Fatal(err)
	}

	zw.Close()
	data := buf.Bytes()

	_, _, err = DeleteZipEntry(data, "good.png")
	if !errors.Is(err, ErrUnsupportedMethod) {
		t.Fatalf("expected ErrUnsupportedMethod, got %v", err)
	}
}

// TestDeleteZipEntry_NotFound verifies that deleting a non-existent entry
// returns ErrEntryNotFound and that IsNotFound returns true.
func TestDeleteZipEntry_NotFound(t *testing.T) {
	files := []struct {
		Name    string
		Content []byte
	}{
		{"exists.png", []byte("data")},
	}
	data := buildStoreZip(t, files)

	_, _, err := DeleteZipEntry(data, "nonexistent.png")
	if !errors.Is(err, ErrEntryNotFound) {
		t.Fatalf("expected ErrEntryNotFound, got %v", err)
	}
	if !IsNotFound(err) {
		t.Fatalf("expected IsNotFound(err) to be true, got false")
	}
}

// TestDeleteZipEntry_HugeContent constructs a store zip with 3 entries each
// containing 256KB of random bytes, deletes the middle one, and verifies that
// the remaining entries are byte-for-byte identical to the original data.
func TestDeleteZipEntry_HugeContent(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	gen := func(n int) []byte {
		b := make([]byte, n)
		rng.Read(b)
		return b
	}

	files := []struct {
		Name    string
		Content []byte
	}{
		{"first.png", gen(256 * 1024)},
		{"second.png", gen(256 * 1024)},
		{"third.png", gen(256 * 1024)},
	}
	data := buildStoreZip(t, files)

	// Save original contents for comparison
	origFirst := make([]byte, len(files[0].Content))
	copy(origFirst, files[0].Content)
	origThird := make([]byte, len(files[2].Content))
	copy(origThird, files[2].Content)

	result, manifest, err := DeleteZipEntry(data, "second.png")
	if err != nil {
		t.Fatalf("DeleteZipEntry: %v", err)
	}

	z, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("result zip parse error: %v", err)
	}
	if len(z.File) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(z.File))
	}

	// Verify first entry
	rc, err := openZipEntry(z, "first.png")
	if err != nil {
		t.Fatalf("open first.png: %v", err)
	}
	gotFirst, err := readAll(rc)
	rc.Close()
	if err != nil {
		t.Fatalf("read first.png: %v", err)
	}
	if !bytes.Equal(gotFirst, origFirst) {
		t.Fatalf("first.png content mismatch (len got=%d want=%d)", len(gotFirst), len(origFirst))
	}

	// Verify third entry
	rc, err = openZipEntry(z, "third.png")
	if err != nil {
		t.Fatalf("open third.png: %v", err)
	}
	gotThird, err := readAll(rc)
	rc.Close()
	if err != nil {
		t.Fatalf("read third.png: %v", err)
	}
	if !bytes.Equal(gotThird, origThird) {
		t.Fatalf("third.png content mismatch (len got=%d want=%d)", len(gotThird), len(origThird))
	}

	if manifest.Total != 2 {
		t.Fatalf("manifest.Total: want 2, got %d", manifest.Total)
	}
}

// --- helpers ---

// openZipEntry opens a zip entry by name, returning the read closer.
func openZipEntry(z *zip.Reader, name string) (io.ReadCloser, error) {
	for _, f := range z.File {
		if CleanZipPath(f.Name) == CleanZipPath(name) {
			return f.Open()
		}
	}
	return nil, errors.New("entry not found in zip")
}

// readAll is a helper to read all bytes from a ReadCloser.
func readAll(rc io.ReadCloser) ([]byte, error) {
	if rc == nil {
		return nil, errors.New("nil ReadCloser")
	}
	var buf bytes.Buffer
	_, err := buf.ReadFrom(rc)
	return buf.Bytes(), err
}
