package archive

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

func newWriterStore(t *testing.T) (*TempStore, Writer) {
	t.Helper()
	s := newTestStore(t, 0)
	return s, NewZIPWriter(s)
}

func TestZIPWriter_ReplaceZIP(t *testing.T) {
	store, w := newWriterStore(t)
	data := buildZIPBytes(t, []zipSpec{
		{"alpha.png", []byte("alpha-orig"), false},
		{"beta.png", []byte("beta-orig"), false},
	}, "keep-comment")
	src := writeSource(t, data)

	replAsset, err := store.Create(t.Context(), "editor", "job-1", "new-alpha.png", "image/png", strings.NewReader("alpha-new"), 0)
	if err != nil {
		t.Fatalf("Create replacement: %v", err)
	}

	out, err := w.ReplaceZIP(context.Background(), src, map[string]AssetRef{"alpha.png": *replAsset}, DefaultBudget())
	if err != nil {
		t.Fatalf("ReplaceZIP: %v", err)
	}
	if out.ID == "" || out.Size == 0 {
		t.Fatalf("output asset incomplete: %+v", out)
	}
	if out.Name != "test.zip" {
		t.Fatalf("output name = %q, want test.zip", out.Name)
	}

	rc, _, err := store.Open(out.ID)
	if err != nil {
		t.Fatalf("Open output: %v", err)
	}
	result, err := ReadCapped(rc, 1<<20)
	rc.Close()
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	zr, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("output is not a valid zip: %v", err)
	}
	if zr.Comment != "keep-comment" {
		t.Fatalf("comment lost: %q", zr.Comment)
	}
	contents := map[string]string{}
	for _, f := range zr.File {
		r, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, err := ReadCapped(r, 1<<20)
		r.Close()
		if err != nil {
			t.Fatalf("read %s: %v", f.Name, err)
		}
		contents[f.Name] = string(b)
	}
	if contents["alpha.png"] != "alpha-new" {
		t.Fatalf("replacement not applied: %q", contents["alpha.png"])
	}
	if contents["beta.png"] != "beta-orig" {
		t.Fatalf("untouched entry modified")
	}
}

func TestZIPWriter_ReplaceZIP_UnsupportedFormat(t *testing.T) {
	_, w := newWriterStore(t)
	_, err := w.ReplaceZIP(context.Background(), Source{ID: "s", Format: FormatRAR}, nil, DefaultBudget())
	if !errors.Is(err, ErrUnsupportedWriteback) {
		t.Fatalf("expected ErrUnsupportedWriteback, got %v", err)
	}
}

func TestZIPWriter_ReplaceZIP_SourcePathUnchanged(t *testing.T) {
	store, w := newWriterStore(t)
	data := buildZIPBytes(t, []zipSpec{{"a.png", []byte("orig"), false}}, "")
	src := writeSource(t, data)
	repl, err := store.Create(t.Context(), "e", "j", "a.png", "", strings.NewReader("new"), 0)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := w.ReplaceZIP(context.Background(), src, map[string]AssetRef{"a.png": *repl}, DefaultBudget()); err != nil {
		t.Fatalf("ReplaceZIP: %v", err)
	}
	// The original source file must be untouched; the output is a new asset.
	f := mustOpen(t, src.Path)
	got, err := ReadCapped(f, 1<<20)
	f.Close()
	if err != nil {
		t.Fatalf("read source: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("ReplaceZIP mutated the original source file")
	}
}

func TestZIPWriter_ReplaceZIPDeleting(t *testing.T) {
	store, w := newWriterStore(t)
	data := buildZIPBytes(t, []zipSpec{
		{"alpha.png", []byte("alpha-orig"), false},
		{"beta.png", []byte("beta-orig"), false},
		{"gamma.png", []byte("gamma-orig"), false},
	}, "keep-comment")
	src := writeSource(t, data)

	replAsset, err := store.Create(t.Context(), "editor", "job-1", "alpha.png", "image/png", strings.NewReader("alpha-new"), 0)
	if err != nil {
		t.Fatalf("Create replacement: %v", err)
	}

	out, err := w.ReplaceZIPDeleting(context.Background(), src, map[string]AssetRef{"alpha.png": *replAsset}, []string{"beta.png"}, DefaultBudget())
	if err != nil {
		t.Fatalf("ReplaceZIPDeleting: %v", err)
	}
	if out.ID == "" || out.Size == 0 {
		t.Fatalf("output asset incomplete: %+v", out)
	}

	rc, _, err := store.Open(out.ID)
	if err != nil {
		t.Fatalf("Open output: %v", err)
	}
	result, err := ReadCapped(rc, 1<<20)
	rc.Close()
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	zr, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		t.Fatalf("output is not a valid zip: %v", err)
	}
	if zr.Comment != "keep-comment" {
		t.Fatalf("comment lost: %q", zr.Comment)
	}
	contents := map[string]string{}
	for _, f := range zr.File {
		r, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, err := ReadCapped(r, 1<<20)
		r.Close()
		if err != nil {
			t.Fatalf("read %s: %v", f.Name, err)
		}
		contents[f.Name] = string(b)
	}
	if contents["alpha.png"] != "alpha-new" {
		t.Fatalf("replacement not applied: %q", contents["alpha.png"])
	}
	if _, ok := contents["beta.png"]; ok {
		t.Fatal("deleted entry beta.png still present")
	}
	if contents["gamma.png"] != "gamma-orig" {
		t.Fatalf("untouched entry modified: %q", contents["gamma.png"])
	}
	// The original source file must remain untouched.
	f := mustOpen(t, src.Path)
	got, err := ReadCapped(f, 1<<20)
	f.Close()
	if err != nil {
		t.Fatalf("read source: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("ReplaceZIPDeleting mutated the original source file")
	}
}

func TestZIPWriter_ReplaceZIPDeleting_UnsupportedFormat(t *testing.T) {
	_, w := newWriterStore(t)
	_, err := w.ReplaceZIPDeleting(context.Background(), Source{ID: "s", Format: Format7Z}, nil, nil, DefaultBudget())
	if !errors.Is(err, ErrUnsupportedWriteback) {
		t.Fatalf("expected ErrUnsupportedWriteback, got %v", err)
	}
}

func TestZIPWriter_Pack(t *testing.T) {
	store, w := newWriterStore(t)
	a, err := store.Create(t.Context(), "gif", "job-1", "frame_01.png", "image/png", strings.NewReader("frame-1"), 0)
	if err != nil {
		t.Fatalf("Create a: %v", err)
	}
	b, err := store.Create(t.Context(), "gif", "job-1", "frame_02.png", "image/png", strings.NewReader("frame-2"), 0)
	if err != nil {
		t.Fatalf("Create b: %v", err)
	}

	out, err := w.Pack(context.Background(), FormatZIP, []AssetRef{*a, *b}, "frames.zip", DefaultBudget())
	if err != nil {
		t.Fatalf("Pack: %v", err)
	}
	rc, _, err := store.Open(out.ID)
	if err != nil {
		t.Fatalf("Open pack: %v", err)
	}
	blob, err := ReadCapped(rc, 1<<20)
	rc.Close()
	if err != nil {
		t.Fatalf("read pack: %v", err)
	}

	zr, err := zip.NewReader(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		t.Fatalf("pack output is not a valid zip: %v", err)
	}
	if len(zr.File) != 2 {
		t.Fatalf("packed %d entries, want 2", len(zr.File))
	}
	if zr.File[0].Name != "frame_01.png" || zr.File[1].Name != "frame_02.png" {
		t.Fatalf("entry names = %q, %q", zr.File[0].Name, zr.File[1].Name)
	}
}

func TestZIPWriter_Pack_UnsupportedFormat(t *testing.T) {
	_, w := newWriterStore(t)
	_, err := w.Pack(context.Background(), Format7Z, nil, "x.7z", DefaultBudget())
	if !errors.Is(err, ErrUnsupportedWriteback) {
		t.Fatalf("expected ErrUnsupportedWriteback, got %v", err)
	}
}

func TestZIPWriter_Pack_UnsafeAssetName(t *testing.T) {
	store, w := newWriterStore(t)
	asset, err := store.Create(t.Context(), "gif", "j", "..", "", strings.NewReader("x"), 0)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if asset.Name != "asset" {
		t.Fatalf("sanitized name = %q, want asset", asset.Name)
	}
	// Sanitization already made the name safe, so pack must succeed.
	if _, err := w.Pack(context.Background(), FormatZIP, []AssetRef{*asset}, "out.zip", DefaultBudget()); err != nil {
		t.Fatalf("Pack with sanitized name: %v", err)
	}
}

func TestZIPWriter_Pack_FileCountCap(t *testing.T) {
	store, w := newWriterStore(t)
	assets := make([]AssetRef, 3)
	for i := range assets {
		ref, err := store.Create(t.Context(), "o", "j", "f.png", "", strings.NewReader("x"), 0)
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		assets[i] = *ref
	}
	_, err := w.Pack(context.Background(), FormatZIP, assets, "out.zip", Budget{MaxEntries: 2})
	if !IsBudgetExceeded(err) {
		t.Fatalf("expected budget error, got %v", err)
	}
}

func TestZIPWriter_Pack_MissingAsset(t *testing.T) {
	_, w := newWriterStore(t)
	_, err := w.Pack(context.Background(), FormatZIP, []AssetRef{{ID: "deadbeef", Name: "x.png"}}, "out.zip", DefaultBudget())
	if !IsNotFound(err) {
		t.Fatalf("expected ErrEntryNotFound, got %v", err)
	}
}

func mustOpen(t *testing.T, path string) *os.File {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	return f
}
