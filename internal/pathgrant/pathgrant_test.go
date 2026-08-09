package pathgrant

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestGrantResolve_OwnerAndOperationBound(t *testing.T) {
	s := NewStore(0)
	f := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	g, err := s.Grant("owner-a", []Operation{OpRead}, f, false, false)
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if got, err := s.Resolve("owner-a", g.ID, OpRead); err != nil || got != f {
		t.Fatalf("Resolve = %q, %v", got, err)
	}
	// Wrong owner: denied even with the correct ID.
	if _, err := s.Resolve("owner-b", g.ID, OpRead); !IsDenied(err) {
		t.Fatalf("foreign owner Resolve: expected denied, got %v", err)
	}
	// Wrong operation: denied.
	if _, err := s.Resolve("owner-a", g.ID, OpWrite); !IsDenied(err) {
		t.Fatalf("wrong operation Resolve: expected denied, got %v", err)
	}
}

func TestGrantRejectsSymlink(t *testing.T) {
	s := NewStore(0)
	target := filepath.Join(t.TempDir(), "real.txt")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := s.Grant("o", []Operation{OpRead}, link, false, false); err == nil {
		t.Fatal("symlink grant must be rejected")
	}
}

func TestGrantTTLAndScavenge(t *testing.T) {
	s := NewStore(10 * time.Millisecond)
	f := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	g, err := s.Grant("o", []Operation{OpRead}, f, false, false)
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}
	time.Sleep(30 * time.Millisecond)
	if n := s.Scavenge(time.Now()); n != 1 {
		t.Fatalf("Scavenge reclaimed %d, want 1", n)
	}
	if _, err := s.Resolve("o", g.ID, OpRead); !IsDenied(err) {
		t.Fatalf("expired grant must be denied, got %v", err)
	}
}

func TestGrantOneShot(t *testing.T) {
	s := NewStore(0)
	f := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	g, err := s.Grant("o", []Operation{OpRead}, f, false, true)
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if _, err := s.Resolve("o", g.ID, OpRead); err != nil {
		t.Fatalf("first Resolve: %v", err)
	}
	if _, err := s.Resolve("o", g.ID, OpRead); !IsDenied(err) {
		t.Fatalf("one-shot grant must be revoked after use, got %v", err)
	}
}

func TestResolveChild_Containment(t *testing.T) {
	s := NewStore(0)
	root := t.TempDir()
	sub := filepath.Join(root, "pics")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "a.webp"), []byte("img"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(filepath.Dir(root), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	g, err := s.Grant("o", []Operation{OpRead}, root, true, false)
	if err != nil {
		t.Fatalf("Grant dir: %v", err)
	}
	if got, err := s.ResolveChild("o", g.ID, "pics/a.webp", OpRead); err != nil || got != filepath.Join(root, "pics", "a.webp") {
		t.Fatalf("ResolveChild = %q, %v", got, err)
	}
	attacks := []string{
		"../secret.txt",
		"..\\secret.txt",
		"../../secret.txt",
		"/etc/passwd",
		"C:/Windows/win.ini",
		"\\\\server\\share",
		"pics/../../secret.txt",
		"pics/..",
		"a\000b",
	}
	for _, a := range attacks {
		if _, err := s.ResolveChild("o", g.ID, a, OpRead); !IsDenied(err) && err != ErrUnsafePath {
			t.Errorf("ResolveChild(%q): expected denial, got %v", a, err)
		}
	}
	// Foreign owner cannot use the directory grant.
	if _, err := s.ResolveChild("other", g.ID, "pics/a.webp", OpRead); !IsDenied(err) {
		t.Fatalf("foreign owner child: expected denied, got %v", err)
	}
}

func TestGrantPerOwnerCap(t *testing.T) {
	s := NewStore(0)
	dir := t.TempDir()
	for i := range maxGrantsPerOwner {
		f := filepath.Join(dir, string(rune('a'+i%26))+".txt")
		if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Grant("o", []Operation{OpRead}, f, false, false); err != nil {
			t.Fatalf("Grant %d: %v", i, err)
		}
	}
	f := filepath.Join(dir, "z.txt")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Grant("o", []Operation{OpRead}, f, false, false); err == nil {
		t.Fatal("per-owner grant cap must be enforced")
	}
}

func TestStrictRel(t *testing.T) {
	valid := []string{"a.txt", "dir/a.txt", "dir/sub/b.webp"}
	for _, v := range valid {
		if _, err := StrictRel(v); err != nil {
			t.Errorf("StrictRel(%q) rejected: %v", v, err)
		}
	}
	invalid := []string{"", ".", "..", "../a", "a/../b", "/abs", "\\abs", "C:/x", "C:\\x", "a:b", "..\\a", "a/./b", "x\000y", "trailing.", "trailing "}
	for _, v := range invalid {
		if _, err := StrictRel(v); err == nil {
			t.Errorf("StrictRel(%q) must be rejected", v)
		}
	}
}
