package archivetool

import (
	"strings"

	"github.com/tinyrouter/tinyrouter/internal/archive"
	"testing"
)

func TestParseSevenZipSLT(t *testing.T) {
	out := `Listing archive: sample.7z

Path = dir/
Folder = +
Size = 0
Packed Size = 0
Attributes = D_........

Path = dir/photo 01.png
Folder = -
Size = 12345
Packed Size = 1000
Attributes = A_........

Path = dir/photo 02.png
Folder = -
Size = 999
Packed Size = 100
Attributes = A_........

Path = 中文名.txt
Folder = -
Size = 42
Packed Size = 12
Attributes = A_........

`
	entries := parseSevenZipSLT([]byte(out))
	if len(entries) != 4 {
		t.Fatalf("got %d entries, want 4", len(entries))
	}
	first := entries[0]
	if first.Path != "dir/" || !first.IsDir {
		t.Errorf("entry 0 = %+v, want dir/ with IsDir", first)
	}
	if entries[1].Path != "dir/photo 01.png" || entries[1].Size != 12345 || entries[1].CompressedSize != 1000 {
		t.Errorf("entry 1 = %+v", entries[1])
	}
	if entries[3].Path != "中文名.txt" || entries[3].Size != 42 {
		t.Errorf("entry 3 = %+v", entries[3])
	}
}

func TestParseSevenZipSLT_EmptyBlocks(t *testing.T) {
	entries := parseSevenZipSLT([]byte("Path = a.txt\nSize = 1\n\n\nPath = b.txt\nFolder = -\n"))
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(entries))
	}
}

func TestParseRarLB(t *testing.T) {
	out := "photo/01.png\nphoto/02.png\ndir\\\n中文.png\n"
	entries := parseRarLB([]byte(out))
	if len(entries) != 4 {
		t.Fatalf("got %d entries, want 4", len(entries))
	}
	if entries[2].IsDir != true || entries[2].Path != "dir\\" {
		t.Errorf("entry 2 = %+v, want dir with IsDir", entries[2])
	}
	if entries[0].CompressedSize != -1 || entries[0].Size != 0 {
		t.Errorf("bare listing sizes must be unknown: %+v", entries[0])
	}
}

func TestBuildManifest_NaturalSort(t *testing.T) {
	raw := []rawEntry{
		{Path: "b/photo 10.png", Size: 1},
		{Path: "a/photo 2.png", Size: 2},
		{Path: "a/photo 1.png", Size: 3},
		{Path: "a/photo 10.png", Size: 4},
	}
	m, err := buildManifest("7z", raw, archive.DefaultBudget())
	if err != nil {
		t.Fatalf("buildManifest: %v", err)
	}
	var got []string
	for _, e := range m.Entries {
		got = append(got, e.Path)
	}
	want := []string{"a/photo 1.png", "a/photo 2.png", "a/photo 10.png", "b/photo 10.png"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("order = %v, want %v", got, want)
	}
	if m.TotalUncompressed != 10 {
		t.Errorf("TotalUncompressed = %d, want 10", m.TotalUncompressed)
	}
}

func TestBuildManifest_RejectsUnsafeAndCollisions(t *testing.T) {
	for _, raw := range [][]rawEntry{
		{{Path: "../evil.txt", Size: 1}},
		{{Path: "a.txt", Size: 1}, {Path: "a.txt", Size: 2}},
		{{Path: "dir/", IsDir: true}, {Path: "dir", Size: 1}},
	} {
		if _, err := buildManifest("zip", raw, archive.DefaultBudget()); err == nil {
			t.Errorf("expected rejection for %+v", raw)
		}
	}
}

func TestBuildManifest_Budget(t *testing.T) {
	b := archive.DefaultBudget()
	b.MaxEntries = 2
	if _, err := buildManifest("zip", []rawEntry{{Path: "a", Size: 1}, {Path: "b", Size: 1}, {Path: "c", Size: 1}}, b); err == nil {
		t.Error("expected entries budget error")
	}
	b = archive.DefaultBudget()
	b.MaxTotalBytes = 5
	if _, err := buildManifest("zip", []rawEntry{{Path: "a", Size: 3}, {Path: "b", Size: 3}}, b); err == nil {
		t.Error("expected total-bytes budget error")
	}
}

func TestParseToolVersion(t *testing.T) {
	cases := map[string]string{
		"7-Zip 24.08 (x64) : Copyright":  "24.08",
		"7-Zip 23.01  (x64)":             "23.01",
		"UNRAR 7.10 freeware  Copyright": "7.10",
		"RAR 7.01   Copyright (c)":       "7.01",
		"7zz 24.09 (x64)":                "24.09",
		"no banner here":                 "",
		"7-Zip 24.07 (x64)":              "24.07",
	}
	for in, want := range cases {
		if got := parseToolVersion(in); got != want {
			t.Errorf("parseToolVersion(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNaturalLess(t *testing.T) {
	pairs := [][2]string{
		{"photo 2.png", "photo 10.png"},
		{"a", "b"},
		{"photo 10.png", "photo 10.png"}, // equal: neither direction is less
	}
	for _, p := range pairs {
		if p[0] == p[1] {
			if naturalLess(p[0], p[1]) || naturalLess(p[1], p[0]) {
				t.Errorf("naturalLess(%q, %q) must be false for equal strings", p[0], p[1])
			}
			continue
		}
		if !naturalLess(p[0], p[1]) {
			t.Errorf("naturalLess(%q, %q) = false, want true", p[0], p[1])
		}
		if naturalLess(p[1], p[0]) {
			t.Errorf("naturalLess(%q, %q) = true, want false", p[1], p[0])
		}
	}
}

func TestEntrySelector(t *testing.T) {
	sel, isIndex, err := entrySelector("42")
	if err != nil || !isIndex || sel != "42" {
		t.Errorf("index: sel=%q isIndex=%v err=%v", sel, isIndex, err)
	}
	sel, isIndex, err = entrySelector("dir/photo 01.png")
	if err != nil || isIndex || sel != "dir/photo 01.png" {
		t.Errorf("path: sel=%q isIndex=%v err=%v", sel, isIndex, err)
	}
	if _, _, err := entrySelector("../escape"); err == nil {
		t.Error("expected unsafe path rejection")
	}
	if _, _, err := entrySelector("dir/*.png"); err == nil {
		t.Error("expected wildcard rejection")
	}
	if _, _, err := entrySelector(""); err == nil {
		t.Error("expected empty rejection")
	}
}
