package archive

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// zipSpec describes one entry for the test zip builder.
type zipSpec struct {
	name  string
	data  []byte
	store bool // true → zip.Store (uncompressed); false → zip.Deflate
}

func buildZIPBytes(t *testing.T, specs []zipSpec, comment string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	if comment != "" {
		if err := zw.SetComment(comment); err != nil {
			t.Fatalf("set comment: %v", err)
		}
	}
	for _, s := range specs {
		method := zip.Deflate
		if s.store {
			method = zip.Store
		}
		w, err := zw.CreateHeader(&zip.FileHeader{Name: s.name, Method: method})
		if err != nil {
			t.Fatalf("create %q: %v", s.name, err)
		}
		if _, err := w.Write(s.data); err != nil {
			t.Fatalf("write %q: %v", s.name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

// writeSource stores zip bytes on disk and returns a Source referencing them.
func writeSource(t *testing.T, data []byte) Source {
	t.Helper()
	p := filepath.Join(t.TempDir(), "test.zip")
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatalf("write test zip: %v", err)
	}
	return Source{ID: "test-source", Format: FormatZIP, Name: "test.zip", Path: p, Size: int64(len(data)), Writable: true}
}

func TestZIP_List_AllEntriesStrictPaths(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{
		{"a.png", []byte("png-fake"), false},
		{"notes.txt", []byte("not an image"), false},
		{"images/b.webp", []byte("webp-fake"), false},
		{"images/sub/c.jpg", []byte("jpg-fake"), false},
		{"images/", nil, false},
	}, "")
	manifest, err := (ZIP{}).List(context.Background(), writeSource(t, data), DefaultBudget())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if manifest.Format != FormatZIP {
		t.Fatalf("format = %s, want zip", manifest.Format)
	}
	if manifest.TotalEntries != 5 {
		t.Fatalf("TotalEntries = %d, want 5 (all entries incl. non-image and dir)", manifest.TotalEntries)
	}
	// Natural ascending order, dirs flagged.
	want := []string{"a.png", "images", "images/b.webp", "images/sub/c.jpg", "notes.txt"}
	got := make([]string, 0, len(manifest.Entries))
	for _, e := range manifest.Entries {
		got = append(got, e.Path)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("entry order = %v, want %v", got, want)
	}
	if manifest.Entries[1].Path != "images" || !manifest.Entries[1].IsDir || manifest.Entries[1].Kind != "dir" {
		t.Fatalf("dir entry not flagged: %+v", manifest.Entries[1])
	}
	if manifest.TotalUncompressed <= 0 {
		t.Fatalf("TotalUncompressed = %d, want > 0", manifest.TotalUncompressed)
	}
}

func TestZIP_List_NaturalSort(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{
		{"file10.png", []byte("x"), false},
		{"file2.png", []byte("x"), false},
		{"file1.png", []byte("x"), false},
	}, "")
	manifest, err := (ZIP{}).List(context.Background(), writeSource(t, data), DefaultBudget())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var got []string
	for _, e := range manifest.Entries {
		got = append(got, e.Path)
	}
	want := []string{"file1.png", "file2.png", "file10.png"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("natural order = %v, want %v", got, want)
	}
}

func TestZIP_List_RejectsTraversal(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{
		{"ok.png", []byte("x"), false},
		{"../evil.png", []byte("x"), false},
	}, "")
	_, err := (ZIP{}).List(context.Background(), writeSource(t, data), DefaultBudget())
	if !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("traversal entry must reject the whole archive, got %v", err)
	}
}

func TestZIP_List_RejectsCollisions(t *testing.T) {
	tests := [][]zipSpec{
		{{"A.png", []byte("x"), false}, {"a.png", []byte("x"), false}},          // case-insensitive
		{{"dir/a.png", []byte("x"), false}, {"dir\\a.png", []byte("x"), false}}, // separator normalization
		{{"a", []byte("x"), false}, {"a/b.png", []byte("x"), false}},            // file as directory
		{{"a/", nil, false}, {"a", []byte("x"), false}},                         // dir entry vs file
	}
	for i, specs := range tests {
		data := buildZIPBytes(t, specs, "")
		_, err := (ZIP{}).List(context.Background(), writeSource(t, data), DefaultBudget())
		if !errors.Is(err, ErrPathCollision) {
			t.Errorf("case %d: expected ErrPathCollision, got %v", i, err)
		}
	}
}

func TestZIP_List_DirEntryWithChildrenValid(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{
		{"images/", nil, false},
		{"images/a.png", []byte("x"), false},
	}, "")
	if _, err := (ZIP{}).List(context.Background(), writeSource(t, data), DefaultBudget()); err != nil {
		t.Fatalf("dir entry with children must be valid: %v", err)
	}
}

func TestZIP_List_BudgetCaps(t *testing.T) {
	t.Run("entry count", func(t *testing.T) {
		data := buildZIPBytes(t, []zipSpec{{"a.png", []byte("x"), false}, {"b.png", []byte("x"), false}}, "")
		_, err := (ZIP{}).List(context.Background(), writeSource(t, data), Budget{MaxEntries: 1})
		if !IsBudgetExceeded(err) {
			t.Fatalf("expected budget error, got %v", err)
		}
	})
	t.Run("total bytes", func(t *testing.T) {
		data := buildZIPBytes(t, []zipSpec{{"a.png", bytes.Repeat([]byte("x"), 100), false}}, "")
		_, err := (ZIP{}).List(context.Background(), writeSource(t, data), Budget{MaxTotalBytes: 50})
		if !IsBudgetExceeded(err) {
			t.Fatalf("expected budget error, got %v", err)
		}
	})
	t.Run("compression ratio", func(t *testing.T) {
		// 1 MiB of zeros deflates to ~1 KiB: ratio ~1000:1 blows a 10:1 cap.
		data := buildZIPBytes(t, []zipSpec{{"zeros.bin", bytes.Repeat([]byte{0}, 1<<20), false}}, "")
		_, err := (ZIP{}).List(context.Background(), writeSource(t, data), Budget{MaxCompressedRatio: 10})
		if !IsBudgetExceeded(err) {
			t.Fatalf("expected ratio budget error, got %v", err)
		}
	})
	t.Run("input size", func(t *testing.T) {
		data := buildZIPBytes(t, []zipSpec{{"a.png", []byte("x"), false}}, "")
		_, err := (ZIP{}).List(context.Background(), writeSource(t, data), Budget{MaxInputBytes: 1})
		if !IsBudgetExceeded(err) {
			t.Fatalf("expected input-bytes budget error, got %v", err)
		}
	})
}

func TestZIP_List_UnsupportedFormat(t *testing.T) {
	_, err := (ZIP{}).List(context.Background(), Source{ID: "s", Format: Format7Z, Path: "x"}, DefaultBudget())
	if !errors.Is(err, ErrUnsupportedFormat) {
		t.Fatalf("expected ErrUnsupportedFormat, got %v", err)
	}
}

func TestZIP_List_CanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	data := buildZIPBytes(t, []zipSpec{{"a.png", []byte("x"), false}}, "")
	_, err := (ZIP{}).List(ctx, writeSource(t, data), DefaultBudget())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestZIP_ReadEntry_ByPathAndIndex(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{
		{"a.png", []byte("png-bytes"), false},
		{"images/b.webp", []byte("webp-bytes"), false},
	}, "")
	src := writeSource(t, data)
	z := ZIP{}

	got, ct, err := z.ReadEntry(context.Background(), src, "images/b.webp", DefaultBudget())
	if err != nil {
		t.Fatalf("ReadEntry by path: %v", err)
	}
	if string(got) != "webp-bytes" {
		t.Fatalf("bytes = %q", got)
	}
	if ct != "image/webp" {
		t.Fatalf("content type = %q, want image/webp", ct)
	}

	got, _, err = z.ReadEntry(context.Background(), src, "1", DefaultBudget())
	if err != nil {
		t.Fatalf("ReadEntry by index: %v", err)
	}
	if string(got) != "webp-bytes" {
		t.Fatalf("index 1 bytes = %q, want webp-bytes", got)
	}

	if _, _, err := z.ReadEntry(context.Background(), src, "missing.png", DefaultBudget()); !IsNotFound(err) {
		t.Fatalf("missing entry: expected ErrEntryNotFound, got %v", err)
	}
}

func TestZIP_ReadEntry_UnsafeIdentifier(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{{"a.png", []byte("x"), false}}, "")
	z := ZIP{}
	for _, id := range []string{"../evil.png", "/abs.png", "C:/x.png", "a/../b.png"} {
		_, _, err := z.ReadEntry(context.Background(), writeSource(t, data), id, DefaultBudget())
		if !errors.Is(err, ErrUnsafePath) {
			t.Errorf("identifier %q: expected ErrUnsafePath, got %v", id, err)
		}
	}
}

func TestZIP_ReadEntry_EntryCap(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{{"big.png", bytes.Repeat([]byte("x"), 100), false}}, "")
	_, _, err := (ZIP{}).ReadEntry(context.Background(), writeSource(t, data), "big.png", Budget{MaxEntryBytes: 50})
	if !IsBudgetExceeded(err) {
		t.Fatalf("expected budget error, got %v", err)
	}
}

func TestZIP_Replace_PreservesHeadersAndComment(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{
		{"alpha.png", []byte("alpha-orig"), true},
		{"beta.png", bytes.Repeat([]byte("beta"), 100), false},
		{"notes.txt", []byte("keep me"), false},
	}, "archive-level-comment")

	z := ZIP{}
	result, manifest, err := z.Replace(context.Background(), data, map[string][]byte{
		"alpha.png": []byte("alpha-new"),
	}, DefaultBudget())
	if err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if manifest.TotalEntries != 3 {
		t.Fatalf("manifest TotalEntries = %d, want 3", manifest.TotalEntries)
	}

	zr, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("result is not a valid zip: %v", err)
	}
	if zr.Comment != "archive-level-comment" {
		t.Fatalf("archive comment lost: %q", zr.Comment)
	}
	methods := map[string]uint16{}
	contents := map[string]string{}
	for _, f := range zr.File {
		methods[f.Name] = f.Method
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, err := ReadCapped(rc, 1<<20)
		rc.Close()
		if err != nil {
			t.Fatalf("read %s: %v", f.Name, err)
		}
		contents[f.Name] = string(b)
	}
	if methods["alpha.png"] != zip.Store {
		t.Fatalf("Store method not preserved: %d", methods["alpha.png"])
	}
	if methods["beta.png"] != zip.Deflate {
		t.Fatalf("Deflate method not preserved: %d", methods["beta.png"])
	}
	if contents["alpha.png"] != "alpha-new" {
		t.Fatalf("replacement not applied: %q", contents["alpha.png"])
	}
	if contents["beta.png"] != strings.Repeat("beta", 100) {
		t.Fatalf("untouched entry modified")
	}
	if contents["notes.txt"] != "keep me" {
		t.Fatalf("untouched entry modified")
	}
}

func TestZIP_Replace_MissingKeyNoOp(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{{"a.png", []byte("aaa"), false}, {"b.png", []byte("bbb"), false}}, "")
	z := ZIP{}
	result, manifest, err := z.Replace(context.Background(), data, map[string][]byte{"ghost.png": []byte("nope")}, DefaultBudget())
	if err != nil {
		t.Fatalf("Replace with missing key: %v", err)
	}
	if manifest.TotalEntries != 2 {
		t.Fatalf("TotalEntries = %d, want 2", manifest.TotalEntries)
	}
	// A missing key is a no-op: the re-encoded result must be byte-identical
	// to a run with an empty replacement map (both are deterministic
	// re-encodings of the same input, like gallery's no-op contract).
	noop, _, err := z.Replace(context.Background(), data, map[string][]byte{}, DefaultBudget())
	if err != nil {
		t.Fatalf("Replace with empty map: %v", err)
	}
	if !bytes.Equal(result, noop) {
		t.Fatal("missing-key run must equal the no-op run byte-for-byte")
	}
}

func TestZIP_Replace_UnsafeKeyRejected(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{{"a.png", []byte("aaa"), false}}, "")
	for _, key := range []string{"../evil.png", "/abs.png", "a/../b.png", "C:/x.png", "con.txt"} {
		_, _, err := (ZIP{}).Replace(context.Background(), data, map[string][]byte{key: []byte("x")}, DefaultBudget())
		if err == nil {
			t.Errorf("replacement key %q must be rejected", key)
			continue
		}
		if !errors.Is(err, ErrUnsafePath) {
			t.Errorf("key %q: expected ErrUnsafePath, got %v", key, err)
		}
	}
}

func TestZIP_Replace_UnsafeSourceEntryRejected(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{
		{"ok.png", []byte("x"), false},
		{"../evil.png", []byte("x"), false},
	}, "")
	_, _, err := (ZIP{}).Replace(context.Background(), data, map[string][]byte{"ok.png": []byte("y")}, DefaultBudget())
	if !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("unsafe source entry must reject the rewrite, got %v", err)
	}
}

func TestZIP_Replace_OutputCap(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{{"a.png", []byte("aaa"), false}}, "")
	_, _, err := (ZIP{}).Replace(context.Background(), data, map[string][]byte{"a.png": bytes.Repeat([]byte("x"), 100)}, Budget{MaxOutputBytes: 20})
	if !IsBudgetExceeded(err) {
		t.Fatalf("expected output-bytes budget error, got %v", err)
	}
}

func TestZIP_Replace_EntrySizeCap(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{{"a.png", []byte("aaa"), false}}, "")
	_, _, err := (ZIP{}).Replace(context.Background(), data, map[string][]byte{"a.png": bytes.Repeat([]byte("x"), 100)}, Budget{MaxEntryBytes: 50})
	if !IsBudgetExceeded(err) {
		t.Fatalf("expected entry-bytes budget error, got %v", err)
	}
}

func TestZIP_DeleteEntries_DropsAndPreserves(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{
		{"alpha.png", []byte("alpha"), true},
		{"beta.png", bytes.Repeat([]byte("beta"), 100), false},
		{"sub/gamma.png", []byte("gamma"), false},
		{"notes.txt", []byte("keep me"), false},
	}, "archive-level-comment")

	result, manifest, err := (ZIP{}).DeleteEntries(context.Background(), data, []string{"beta.png", "sub/gamma.png"}, DefaultBudget())
	if err != nil {
		t.Fatalf("DeleteEntries: %v", err)
	}
	if manifest.TotalEntries != 2 {
		t.Fatalf("manifest TotalEntries = %d, want 2", manifest.TotalEntries)
	}

	zr, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("result is not a valid zip: %v", err)
	}
	if zr.Comment != "archive-level-comment" {
		t.Fatalf("archive comment lost: %q", zr.Comment)
	}
	seen := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, err := ReadCapped(rc, 1<<20)
		rc.Close()
		if err != nil {
			t.Fatalf("read %s: %v", f.Name, err)
		}
		seen[f.Name] = string(b)
	}
	if _, ok := seen["beta.png"]; ok {
		t.Fatal("deleted entry beta.png still present")
	}
	if _, ok := seen["sub/gamma.png"]; ok {
		t.Fatal("deleted entry sub/gamma.png still present")
	}
	if seen["alpha.png"] != "alpha" {
		t.Fatalf("untouched entry modified: %q", seen["alpha.png"])
	}
	if seen["notes.txt"] != "keep me" {
		t.Fatalf("untouched entry modified: %q", seen["notes.txt"])
	}
	// Store method of the surviving entry must be preserved.
	for _, f := range zr.File {
		if f.Name == "alpha.png" && f.Method != zip.Store {
			t.Fatalf("Store method not preserved: %d", f.Method)
		}
	}
}

func TestZIP_DeleteEntries_MissingPathNoOp(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{{"a.png", []byte("aaa"), false}, {"b.png", []byte("bbb"), false}}, "")
	result, manifest, err := (ZIP{}).DeleteEntries(context.Background(), data, []string{"ghost.png"}, DefaultBudget())
	if err != nil {
		t.Fatalf("DeleteEntries with missing path: %v", err)
	}
	if manifest.TotalEntries != 2 {
		t.Fatalf("TotalEntries = %d, want 2", manifest.TotalEntries)
	}
	noop, _, err := (ZIP{}).DeleteEntries(context.Background(), data, nil, DefaultBudget())
	if err != nil {
		t.Fatalf("DeleteEntries with empty set: %v", err)
	}
	if !bytes.Equal(result, noop) {
		t.Fatal("missing-path run must equal the no-op run byte-for-byte")
	}
}

func TestZIP_DeleteEntries_UnsafePathRejected(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{{"a.png", []byte("aaa"), false}}, "")
	for _, p := range []string{"../evil.png", "/abs.png", "a/../b.png", "C:/x.png", "con.txt", ""} {
		_, _, err := (ZIP{}).DeleteEntries(context.Background(), data, []string{p}, DefaultBudget())
		if err == nil {
			t.Errorf("delete path %q must be rejected", p)
			continue
		}
		if !errors.Is(err, ErrUnsafePath) {
			t.Errorf("delete path %q: expected ErrUnsafePath, got %v", p, err)
		}
	}
}

func TestZIP_DeleteEntries_WithReplacements(t *testing.T) {
	data := buildZIPBytes(t, []zipSpec{
		{"a.png", []byte("aaa"), false},
		{"b.png", []byte("bbb"), false},
		{"c.png", []byte("ccc"), false},
	}, "")
	result, manifest, err := (ZIP{}).rewrite(context.Background(), data, map[string][]byte{"a.png": []byte("new-a")}, []string{"b.png"}, DefaultBudget())
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if manifest.TotalEntries != 2 {
		t.Fatalf("TotalEntries = %d, want 2", manifest.TotalEntries)
	}
	zr, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("result zip invalid: %v", err)
	}
	contents := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, _ := ReadCapped(rc, 1<<20)
		rc.Close()
		contents[f.Name] = string(b)
	}
	if contents["a.png"] != "new-a" {
		t.Fatalf("replacement not applied: %q", contents["a.png"])
	}
	if _, ok := contents["b.png"]; ok {
		t.Fatal("deleted entry b.png still present")
	}
	if contents["c.png"] != "ccc" {
		t.Fatalf("untouched entry modified: %q", contents["c.png"])
	}
}
