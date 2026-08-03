package gallery

import (
	"archive/zip"
	"bytes"
	"testing"
)

// entrySpec is an ordered (name, content) pair used to build test archives.
type entrySpec struct {
	Name    string
	Content []byte
}

// buildZipMethod builds a zip where every entry uses the given compression
// method (zip.Store or zip.Deflate), with a deterministic layout.
func buildZipMethod(t *testing.T, method uint16, files []entrySpec) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range files {
		fh := &zip.FileHeader{
			Name:   f.Name,
			Method: method,
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

// openAndRead opens the named entry from z and returns its decompressed bytes.
func openAndRead(t *testing.T, z *zip.Reader, name string) []byte {
	t.Helper()
	rc, err := openZipEntry(z, name)
	if err != nil {
		t.Fatalf("open %q: %v", name, err)
	}
	defer rc.Close()
	b, err := readAll(rc)
	if err != nil {
		t.Fatalf("read %q: %v", name, err)
	}
	return b
}

// assertEntryContent fails the test if entry name in z does not equal want.
func assertEntryContent(t *testing.T, z *zip.Reader, name, want string) {
	t.Helper()
	got := openAndRead(t, z, name)
	if string(got) != want {
		t.Fatalf("entry %q: want %q got %q", name, want, string(got))
	}
}

// findEntry returns the *zip.File whose cleaned name matches name, or fails.
func findEntry(t *testing.T, z *zip.Reader, name string) *zip.File {
	t.Helper()
	for _, f := range z.File {
		if CleanZipPath(f.Name) == CleanZipPath(name) {
			return f
		}
	}
	t.Fatalf("entry %q not found", name)
	return nil
}

func TestReplaceZipEntries_Store_ReplacesAndPreserves(t *testing.T) {
	files := []entrySpec{
		{"alpha.png", []byte("alpha-bytes")},
		{"notes.txt", []byte("not-an-image")},
		{"images/b.webp", []byte("webp-bytes")},
		{"images/sub/c.jpg", []byte("jpg-bytes")},
	}
	data := buildZipMethod(t, zip.Store, files)

	replacements := map[string][]byte{
		"alpha.png":     []byte("alpha-NEW"),
		"images/b.webp": []byte("webp-NEW"),
		// images/sub/c.jpg left unchanged on purpose.
	}
	result, manifest, err := ReplaceZipEntries(data, replacements)
	if err != nil {
		t.Fatalf("ReplaceZipEntries: %v", err)
	}
	if manifest.Total != 3 {
		t.Fatalf("expected manifest Total 3 (image entries), got %d", manifest.Total)
	}

	z, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("parse result: %v", err)
	}
	if len(z.File) != len(files) {
		t.Fatalf("expected %d entries preserved, got %d", len(files), len(z.File))
	}

	// Replaced entries carry the new bytes and keep their method.
	assertEntryContent(t, z, "alpha.png", "alpha-NEW")
	assertEntryContent(t, z, "images/b.webp", "webp-NEW")
	if f := findEntry(t, z, "alpha.png"); f.Method != zip.Store {
		t.Fatalf("alpha.png method changed: want %d got %d", zip.Store, f.Method)
	}

	// Untouched entries keep their original content and method.
	assertEntryContent(t, z, "images/sub/c.jpg", "jpg-bytes")
	assertEntryContent(t, z, "notes.txt", "not-an-image")
	if f := findEntry(t, z, "images/sub/c.jpg"); f.Method != zip.Store {
		t.Fatalf("c.jpg method changed: want %d got %d", zip.Store, f.Method)
	}
}

func TestReplaceZipEntries_Deflate_ReplacesAndPreserves(t *testing.T) {
	// Use compressible content so Deflate actually shrinks the payload and
	// is meaningfully distinct from Store.
	pngBody := bytes.Repeat([]byte("PNG"), 333)
	webpBody := bytes.Repeat([]byte("W"), 900)
	jpgBody := bytes.Repeat([]byte("J"), 500)
	files := []entrySpec{
		{"alpha.png", pngBody},
		{"images/b.webp", webpBody},
		{"images/sub/c.jpg", jpgBody},
	}
	data := buildZipMethod(t, zip.Deflate, files)

	replacements := map[string][]byte{
		"alpha.png": []byte("tiny-replacement"),
	}
	result, _, err := ReplaceZipEntries(data, replacements)
	if err != nil {
		t.Fatalf("ReplaceZipEntries: %v", err)
	}

	z, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("parse result: %v", err)
	}
	if len(z.File) != len(files) {
		t.Fatalf("expected %d entries, got %d", len(files), len(z.File))
	}

	// Replaced entry keeps Deflate method and carries new bytes.
	if f := findEntry(t, z, "alpha.png"); f.Method != zip.Deflate {
		t.Fatalf("alpha.png method changed: want Deflate(%d) got %d", zip.Deflate, f.Method)
	}
	assertEntryContent(t, z, "alpha.png", "tiny-replacement")

	// Untouched entries: byte-identical decompressed content and same method.
	if f := findEntry(t, z, "images/b.webp"); f.Method != zip.Deflate {
		t.Fatalf("b.webp method changed: want Deflate(%d) got %d", zip.Deflate, f.Method)
	}
	if got := openAndRead(t, z, "images/b.webp"); !bytes.Equal(got, webpBody) {
		t.Fatalf("b.webp content changed")
	}
	if got := openAndRead(t, z, "images/sub/c.jpg"); !bytes.Equal(got, jpgBody) {
		t.Fatalf("c.jpg content changed")
	}

	// The Deflate entries genuinely compressed: result should be smaller than
	// the raw decompressed payload, confirming the writer used Deflate.
	rawTotal := len(pngBody) + len(webpBody) + len(jpgBody)
	if len(result) >= rawTotal {
		t.Fatalf("deflate zip not smaller than raw: result=%d raw=%d", len(result), rawTotal)
	}
}

func TestReplaceZipEntries_MissingKey_NoOp(t *testing.T) {
	files := []entrySpec{
		{"a.png", []byte("aaa")},
		{"b.png", []byte("bbb")},
	}
	data := buildZipMethod(t, zip.Store, files)

	// Empty replacements map: every entry should be copied verbatim.
	result, manifest, err := ReplaceZipEntries(data, map[string][]byte{})
	if err != nil {
		t.Fatalf("ReplaceZipEntries: %v", err)
	}
	if manifest.Total != 2 {
		t.Fatalf("expected Total 2, got %d", manifest.Total)
	}

	z, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("parse result: %v", err)
	}
	if len(z.File) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(z.File))
	}
	assertEntryContent(t, z, "a.png", "aaa")
	assertEntryContent(t, z, "b.png", "bbb")

	// Unknown key path never appears: replacement of a missing name is ignored,
	// and the archive is rewritten unchanged.
	result2, _, err := ReplaceZipEntries(data, map[string][]byte{"ghost.png": []byte("nope")})
	if err != nil {
		t.Fatalf("ReplaceZipEntries missing key: %v", err)
	}
	if !bytes.Equal(result, result2) {
		t.Fatalf("missing-key run should equal no-op run")
	}
}

func TestReplaceZipEntries_CleanedKeyContract(t *testing.T) {
	files := []entrySpec{
		{"dir/alpha.png", []byte("orig")},
	}
	data := buildZipMethod(t, zip.Store, files)

	// Caller-normalized key already matches cleanZipPath output.
	replacements := map[string][]byte{
		"dir/alpha.png": []byte("NEW"),
	}
	result, _, err := ReplaceZipEntries(data, replacements)
	if err != nil {
		t.Fatalf("ReplaceZipEntries: %v", err)
	}
	z, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("parse result: %v", err)
	}
	assertEntryContent(t, z, "dir/alpha.png", "NEW")
}
