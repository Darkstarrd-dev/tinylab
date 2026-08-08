package feature

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// repoRoot is the repository root relative to this package's test working
// directory (internal/feature → ../../). Asset-existence checks are done on
// disk so they hold in every build-tag combination (the playground embed FS is
// empty without the `playground` tag).
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	root := filepath.Clean(filepath.Join(dir, "..", ".."))
	if _, err := os.Stat(filepath.Join(root, "AGENTS.md")); err != nil {
		t.Fatalf("repo root %q does not look like tinyrouter root: %v", root, err)
	}
	return root
}

func TestDefaultManifestComplete(t *testing.T) {
	all := All()
	ids := make(map[ID]bool, len(all))
	for _, f := range all {
		ids[f.ID] = true
	}
	// Every plan §11.2 feature (plus core) must be declared.
	for _, id := range []ID{Core, Playground, Download, Archive, ArchiveExternal, Gallery, GIF, Editor, FileTransfer} {
		if !ids[id] {
			t.Errorf("feature %q missing from default manifest", id)
		}
	}
	// Default build claim: every feature is compiled (no feature_* tags exist).
	for _, id := range []ID{Core, Playground, Download, Archive, ArchiveExternal, Gallery, GIF, Editor, FileTransfer} {
		if !Enabled(id) {
			t.Errorf("default build must enable %q (no feature_* tags exist)", id)
		}
	}
}

func TestUniqueIDs(t *testing.T) {
	all := All()
	seen := make(map[ID]bool, len(all))
	for _, f := range all {
		if f.ID == "" {
			t.Error("feature with empty ID registered")
		}
		if seen[f.ID] {
			t.Errorf("duplicate feature ID %q in manifest", f.ID)
		}
		seen[f.ID] = true
	}
}

func TestDependencyClosure(t *testing.T) {
	all := All()
	ids := make(map[ID]bool, len(all))
	for _, f := range all {
		ids[f.ID] = true
	}
	// Every dependency is a known feature; the graph is acyclic.
	visiting := make(map[ID]bool)
	visited := make(map[ID]bool)
	var visit func(id ID) bool
	visit = func(id ID) bool {
		if visited[id] {
			return true
		}
		if visiting[id] {
			return false // cycle
		}
		visiting[id] = true
		for _, f := range all {
			if f.ID != id {
				continue
			}
			for _, dep := range f.DependsOn {
				if !ids[dep] {
					t.Errorf("feature %q depends on unknown feature %q", id, dep)
				}
				if !visit(dep) {
					t.Errorf("dependency cycle involving %q", dep)
				}
			}
		}
		visiting[id] = false
		visited[id] = true
		return true
	}
	for id := range ids {
		visit(id)
	}
	// Plan §11.2 edges.
	want := map[ID][]ID{
		Archive:         nil,
		ArchiveExternal: {Archive},
		Gallery:         {Archive},
		GIF:             {Archive},
	}
	for id, deps := range want {
		f, ok := Get(id)
		if !ok {
			t.Errorf("Get(%q) failed", id)
			continue
		}
		if !reflect.DeepEqual(f.DependsOn, deps) {
			t.Errorf("feature %q DependsOn = %v, want %v", id, f.DependsOn, deps)
		}
	}
}

func TestDependencyPropagation(t *testing.T) {
	// Disabling a dependency must disable its dependents and only them.
	SetCompiled(Archive, false)
	t.Cleanup(func() { SetCompiled(Archive, true) })

	if Enabled(Archive) {
		t.Error("Archive must be disabled after SetCompiled(false)")
	}
	for _, id := range []ID{ArchiveExternal, Gallery, GIF} {
		if Enabled(id) {
			t.Errorf("dependent %q must be disabled when Archive is disabled", id)
		}
	}
	// Unrelated features stay enabled.
	for _, id := range []ID{Core, Download, Editor, FileTransfer, Playground} {
		if !Enabled(id) {
			t.Errorf("unrelated feature %q must stay enabled when Archive is disabled", id)
		}
	}
	// Re-enable restores dependents.
	SetCompiled(Archive, true)
	for _, id := range []ID{Archive, ArchiveExternal, Gallery, GIF} {
		if !Enabled(id) {
			t.Errorf("feature %q must be re-enabled after Archive restore", id)
		}
	}
}

func TestSetCompiledUnknownIDNoop(t *testing.T) {
	// Must not panic and must not add a feature.
	SetCompiled("no_such_feature", false)
	if _, ok := Get("no_such_feature"); ok {
		t.Error("SetCompiled created an unknown feature")
	}
	if Enabled("no_such_feature") {
		t.Error("Enabled(unknown) must be false")
	}
}

func TestAssetsGroupedByRoot(t *testing.T) {
	pg := Assets(RootPlaygroundPG)
	static := Assets(RootStatic)

	for _, want := range []string{"playground/playground.js", "playground/pg-comfyui.js"} {
		if !contains(pg, want) {
			t.Errorf("Assets(playground/static-pg) missing %q", want)
		}
	}
	for _, want := range []string{
		"gallery/gallery-state.js", "gallery/gallery-edit-batch.js", "gallery/gallery.js",
	} {
		if !contains(pg, want) {
			t.Errorf("Assets(playground/static-pg) missing %q", want)
		}
	}
	for _, want := range []string{
		"download.js", "media-bridge.js", "gif-editor/gif-editor.js", "filetransfer.js",
		"vendor/gif.js/gif.js", "vendor/gifuct-js/gifuct-js.js",
		"vendor/utility-editor/markdown-it/markdown-it.min.js", "vendor/utility-editor/prism/prism.js",
		"vendor/utility-editor/diff-match-patch/diff-match-patch.js", "vendor/utility-editor/turndown/turndown.js",
		"vendor/utility-editor/dompurify/purify.min.js",
		"utility/editor/editor-state.js", "utility/editor/editor_workspace.js", "utility/editor/editor_commands.js",
		"utility/editor/editor_markdown.js", "utility/editor/editor_layout.js", "utility/editor/editor.js",
		"utility/editor/editor_shell.js", "utility/editor/editor-logs.js",
		"utility/editor/editor_textreview_step3.js", "utility/editor/editor_textreview.js", "utility/editor/review.js",
	} {
		if !contains(static, want) {
			t.Errorf("Assets(static) missing %q", want)
		}
	}
	// No asset may be claimed under the wrong root; features without assets
	// (e.g. archive_external, a backend-only surface) may have an empty root.
	for _, f := range All() {
		if len(f.StaticFiles) == 0 {
			continue
		}
		switch f.StaticRoot {
		case RootStatic, RootPlaygroundPG:
		default:
			t.Errorf("feature %q has invalid StaticRoot %q", f.ID, f.StaticRoot)
		}
	}
}

func TestEditorReviewAssetLoadsLast(t *testing.T) {
	f, ok := Get(Editor)
	if !ok {
		t.Fatal("Editor feature missing from default manifest")
	}
	if len(f.StaticFiles) < 2 {
		t.Fatalf("Editor StaticFiles unexpectedly short: %v", f.StaticFiles)
	}
	got := f.StaticFiles
	if got[len(got)-1] != "utility/editor/review.js" {
		t.Errorf("review.js must be the final Editor asset, got %q", got[len(got)-1])
	}
	if got[len(got)-2] != "utility/editor/editor_textreview.js" {
		t.Errorf("review.js must load after textreview entry, previous asset is %q", got[len(got)-2])
	}
}

// TestAssetsPlaygroundPGExactOrder locks the router contract for playground-only assets.
// Editor assets are rooted in web/static/utility/editor and are intentionally absent.
func TestAssetsPlaygroundPGExactOrder(t *testing.T) {
	want := []string{
		"playground/playground.js", "playground/pg-i18n.js",
		"playground/pg-core.js", "playground/pg-state.js", "playground/pg-markdown.js",
		"playground/pg-request.js", "playground/pg-stream.js", "playground/pg-comfyui.js", "playground/pg-image-model.js", "playground/pg-image-inspire.js", "playground/pg-image-batch.js", "playground/pg-autochat.js",
		"playground/pg-render.js", "playground/pg-ui.js", "playground/pg-modal.js", "playground/pg-lifecycle.js",
		"playground/pg-setup.js", "playground/pg-director.js", "playground/pg-search.js",
		"gallery/gallery-state.js", "gallery/gallery-io.js", "gallery/gallery-layout.js",
		"gallery/gallery-tree.js", "gallery/gallery-review.js", "gallery/gallery-video.js", "gallery/gallery-fullscreen.js",
		"gallery/gallery-edit.js", "gallery/gallery-edit-operations.js", "gallery/gallery-edit-batch.js", "gallery/gallery.js",
	}
	got := Assets(RootPlaygroundPG)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Assets(RootPlaygroundPG) mismatch\n got: %v\nwant: %v", got, want)
	}
}

func TestAssetsExistOnDisk(t *testing.T) {
	root := repoRoot(t)
	for _, f := range All() {
		if f.StaticFiles == nil {
			continue
		}
		for _, asset := range f.StaticFiles {
			p := filepath.Join(root, "web", string(f.StaticRoot), filepath.FromSlash(asset))
			if fi, err := os.Stat(p); err != nil || fi.IsDir() {
				t.Errorf("feature %q asset %q does not exist at %s", f.ID, asset, p)
			}
		}
	}
}

func TestRegisterReplaceKeepsOrderUnique(t *testing.T) {
	before := len(All())
	Register(Feature{ID: Download, Name: "Download (custom)", StaticRoot: RootStatic})
	after := All()
	if len(after) != before {
		t.Errorf("Register replace changed manifest size: %d → %d", before, len(after))
	}
	count := 0
	for _, f := range after {
		if f.ID == Download {
			count++
		}
	}
	if count != 1 {
		t.Errorf("Register replace produced %d entries for %q, want 1", count, Download)
	}
	if f, _ := Get(Download); f.Name != "Download (custom)" {
		t.Errorf("Register replace did not apply: Name = %q", f.Name)
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
