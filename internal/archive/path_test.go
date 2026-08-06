package archive

import (
	"errors"
	"reflect"
	"testing"
)

func TestStrictArchivePath_Valid(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"a.png", "a.png"},
		{"dir/sub/file.png", "dir/sub/file.png"},
		{"dir\\sub\\file.png", "dir/sub/file.png"},
		{"dir/", "dir"},
		{"dir\\", "dir"},
		{"dir//file.png", "dir/file.png"},
		{"a/\\b.png", "a/b.png"},
		{"a b.png", "a b.png"},
		{"Café/写真.png", "Café/写真.png"},
		{"frame_001.png", "frame_001.png"},
		{"nested/deep/leaf.webp", "nested/deep/leaf.webp"},
	}
	for _, tt := range tests {
		got, err := StrictArchivePath(tt.in)
		if err != nil {
			t.Errorf("StrictArchivePath(%q): unexpected error %v", tt.in, err)
			continue
		}
		if got != tt.want {
			t.Errorf("StrictArchivePath(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestStrictArchivePath_Rejected(t *testing.T) {
	tests := []string{
		"",
		"/abs/path",
		"\\abs\\path",
		"/",
		"\\",
		"C:/x.png",
		"c:\\x.png",
		"\\\\server\\share\\x.png",
		"\\\\?\\C:\\x.png",
		"\\\\.\\C:\\x.png",
		"../evil.png",
		"a/../evil.png",
		"./a.png",
		"a/./b.png",
		"a:b.png",    // ADS
		"a/b:c.png",  // ADS in a segment
		"con",        // reserved device name
		"CON.txt",    // reserved with extension
		"nul.1",      // reserved with extension
		"COM1",       // reserved
		"lpt9/x.png", // reserved in a segment
		"a.",         // trailing dot
		"a ",         // trailing space
		"a/b. ",      // trailing dot/space in a segment
		"a\x00b.png", // NUL
		"a\nb.png",   // control byte
		"a\tb.png",   // control byte
		"a\x7fb.png", // DEL
		".../x.png",  // dots-only segment
		"//",         // all slashes
		"\\\\",       // UNC prefix
	}
	for _, in := range tests {
		got, err := StrictArchivePath(in)
		if err == nil {
			t.Errorf("StrictArchivePath(%q) = %q, want error", in, got)
			continue
		}
		if !errors.Is(err, ErrUnsafePath) {
			t.Errorf("StrictArchivePath(%q): error %v does not wrap ErrUnsafePath", in, err)
		}
	}
}

func TestStrictArchivePath_NeverCleansBeforeValidating(t *testing.T) {
	// A path.Clean-first implementation would accept these; strict
	// validation must reject them.
	for _, in := range []string{"../a", "a/../../b", "/a/b", "C:/a"} {
		if _, err := StrictArchivePath(in); err == nil {
			t.Errorf("StrictArchivePath(%q): expected rejection before normalization", in)
		}
	}
}

func TestValidateEntryPaths_Collisions(t *testing.T) {
	tests := []struct {
		name  string
		names []string
	}{
		{"exact duplicate", []string{"a.png", "a.png"}},
		{"normalized duplicate", []string{"dir/a.png", "dir\\a.png"}},
		{"case-insensitive duplicate", []string{"A.png", "a.png"}},
		{"case-insensitive nested", []string{"Dir/File.png", "dir/file.png"}},
		{"dir entry vs file same name", []string{"a/", "a"}},
		{"file used as directory", []string{"a", "a/b.png"}},
		{"nested file as directory", []string{"a/b", "a/b/c.png"}},
		{"unsafe member", []string{"ok.png", "../evil.png"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ValidateEntryPaths(tt.names)
			if err == nil {
				t.Fatalf("ValidateEntryPaths(%v) = %v, want error", tt.names, got)
			}
			if !errors.Is(err, ErrPathCollision) && !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("ValidateEntryPaths(%v): error %v wraps neither ErrPathCollision nor ErrUnsafePath", tt.names, err)
			}
		})
	}
}

func TestValidateEntryPaths_Valid(t *testing.T) {
	names := []string{
		"a.png",
		"dir/",
		"dir/b.webp",
		"dir/sub/c.jpg",
		"Dir2/file.png",
	}
	got, err := ValidateEntryPaths(names)
	if err != nil {
		t.Fatalf("ValidateEntryPaths: unexpected error %v", err)
	}
	want := []string{"a.png", "dir", "dir/b.webp", "dir/sub/c.jpg", "Dir2/file.png"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ValidateEntryPaths = %v, want %v", got, want)
	}
}

func TestValidateEntryPaths_DirEntryAndChild(t *testing.T) {
	// A real directory entry plus entries under it is the normal layout and
	// must not be flagged as a collision.
	names := []string{"images/", "images/a.png", "images/sub/", "images/sub/b.png"}
	if _, err := ValidateEntryPaths(names); err != nil {
		t.Fatalf("directory entries with children must be valid, got %v", err)
	}
}

func TestIsDirEntry(t *testing.T) {
	if !IsDirEntry("dir/") || !IsDirEntry("dir\\") {
		t.Fatal("IsDirEntry should detect trailing separators")
	}
	if IsDirEntry("dir") || IsDirEntry("dir/a.png") || IsDirEntry("") {
		t.Fatal("IsDirEntry false positives")
	}
}
