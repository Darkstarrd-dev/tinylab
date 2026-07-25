package terminal

import (
	"os"
	"strings"
	"testing"
)

// sep is the OS path-list separator, used to build platform-agnostic test
// PATH strings. The merge logic is exercised with single-component entries
// (e.g. "alpha", "beta") so filepath.Clean does not transform them and the
// tests are deterministic on every platform.
var sep = string(os.PathListSeparator)

func TestWithAugmentedPath_NoopWhenInheritedComplete(t *testing.T) {
	env := []string{"PATH=alpha" + sep + "beta", "OTHER=x"}
	got := withAugmentedPath(env, "alpha")
	if !equalEnv(got, env) {
		t.Errorf("expected no-op when inherited contains all registry entries\ngot:  %v\nwant: %v", got, env)
	}
}

func TestWithAugmentedPath_AugmentsWhenMissing(t *testing.T) {
	env := []string{"PATH=alpha", "OTHER=x"}
	got := withAugmentedPath(env, "alpha"+sep+"beta")
	wantPath := "alpha" + sep + "beta"
	if p := envLookup(got, "PATH"); p != wantPath {
		t.Errorf("PATH not augmented: got %q want %q", p, wantPath)
	}
	if envLookup(got, "OTHER") != "x" {
		t.Error("non-PATH env entries were disturbed")
	}
}

func TestWithAugmentedPath_PreservesInheritedExtras(t *testing.T) {
	// Inherited has an extra entry "gamma" not in the registry; it must be
	// appended after the registry entries.
	env := []string{"PATH=alpha" + sep + "gamma"}
	got := withAugmentedPath(env, "alpha"+sep+"beta")
	wantPath := "alpha" + sep + "beta" + sep + "gamma"
	if p := envLookup(got, "PATH"); p != wantPath {
		t.Errorf("inherited extras not preserved: got %q want %q", p, wantPath)
	}
}

func TestWithAugmentedPath_Deduplicates(t *testing.T) {
	// Registry already contains "alpha"; inherited also has "alpha" and
	// "beta". Registry is the source of truth (alpha, beta, gamma); inherited
	// extras (none new) must not duplicate.
	env := []string{"PATH=alpha" + sep + "beta"}
	got := withAugmentedPath(env, "alpha"+sep+"beta"+sep+"gamma")
	wantPath := "alpha" + sep + "beta" + sep + "gamma"
	if p := envLookup(got, "PATH"); p != wantPath {
		t.Errorf("dedup failed: got %q want %q", p, wantPath)
	}
}

func TestWithAugmentedPath_AddsPathWhenAbsent(t *testing.T) {
	env := []string{"OTHER=x", "TERM=dumb"}
	got := withAugmentedPath(env, "alpha"+sep+"beta")
	if p := envLookup(got, "PATH"); p != "alpha"+sep+"beta" {
		t.Errorf("PATH not added when absent: got %q want %q", p, "alpha"+sep+"beta")
	}
	if envLookup(got, "OTHER") != "x" || envLookup(got, "TERM") != "dumb" {
		t.Error("existing entries disturbed when adding PATH")
	}
}

func TestWithAugmentedPath_EmptyRegPathIsNoop(t *testing.T) {
	env := []string{"PATH=alpha", "OTHER=x"}
	got := withAugmentedPath(env, "")
	if !equalEnv(got, env) {
		t.Errorf("empty regPath should be a no-op\ngot:  %v\nwant: %v", got, env)
	}
}

func TestWithAugmentedPath_CaseInsensitivePathKey(t *testing.T) {
	// Env var names are case-insensitive on Windows; the lookup must match
	// "path" regardless of the case used in the inherited block.
	env := []string{"path=alpha", "OTHER=x"}
	got := withAugmentedPath(env, "alpha"+sep+"beta")
	if p := envLookup(got, "PATH"); p != "alpha"+sep+"beta" {
		t.Errorf("PATH key lookup not case-insensitive: got %q want %q", p, "alpha"+sep+"beta")
	}
}

func TestBuildShellEnv_AppendsTermWhenNoRegistry(t *testing.T) {
	// With no registry contribution (regPath=""), buildShellEnv must reduce to
	// os.Environ() + TERM=xterm-256color, i.e. unchanged prior behavior.
	got := buildShellEnvWith("")
	want := append(os.Environ(), "TERM=xterm-256color")
	if !equalEnv(got, want) {
		t.Errorf("buildShellEnvWith(\"\") diverged from os.Environ()+TERM\ngot:  %v\nwant: %v", got, want)
	}
	if got[len(got)-1] != "TERM=xterm-256color" {
		t.Error("TERM must be the last env entry")
	}
}

func TestBuildShellEnv_AugmentsThenAppendsTerm(t *testing.T) {
	// Force an augmentation by injecting a tiny inherited PATH via a regPath
	// that has an extra entry, then ensure TERM is still appended last.
	regPath := "alpha" + sep + "beta"
	got := buildShellEnvWith(regPath)
	// Only assert TERM is last and PATH present; the exact merged value depends
	// on the host's own inherited PATH, which we cannot control here.
	if got[len(got)-1] != "TERM=xterm-256color" {
		t.Error("TERM must be the last env entry after augmentation")
	}
	if envLookup(got, "PATH") == "" {
		t.Error("PATH missing from augmented env")
	}
}

// equalEnv compares two env slices ignoring order of unrelated entries but
// preserving exact match for the test cases above, which are fully
// deterministic.
func equalEnv(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func envLookup(env []string, key string) string {
	for _, kv := range env {
		if strings.EqualFold(envKey(kv), key) {
			return envValue(kv)
		}
	}
	return ""
}
