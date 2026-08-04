package imagebatch

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSafePaths(t *testing.T) {
	if IsSafeSlug("../escape") || IsSafeSlug("CON") || IsSafeSlug("a/b") {
		t.Fatal("unsafe slug accepted")
	}
	root := t.TempDir()
	d, e := ProjectDir(root, "safe-project")
	if e != nil || d != filepath.Join(root, "safe-project") {
		t.Fatalf("project dir: %v %s", e, d)
	}
	if _, e = ResolveAssetPath(root, "safe-project", "../x"); e == nil {
		t.Fatal("traversal accepted")
	}
	rel, e := SlotRelativePath(1, 2, "png")
	if e != nil || rel != "p0001/v0002.png" {
		t.Fatalf("slot: %v %s", e, rel)
	}
	if _, e = SlotRelativePath(1, 2, "svg"); e == nil {
		t.Fatal("svg accepted")
	}
}
func TestAtomicManifestAndNoOverwrite(t *testing.T) {
	s, e := NewProjectStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	p := testProject()
	if e = s.CreateProject(p); e != nil {
		t.Fatal(e)
	}
	if e = s.CreateProject(p); e == nil {
		t.Fatal("collision accepted")
	}
	loaded, e := s.LoadProject(p.Slug)
	if e != nil || loaded.ProjectID != p.ProjectID {
		t.Fatalf("load: %v", e)
	}
	if _, e = os.Stat(filepath.Join(s.Root(), p.Slug, "project.json")); e != nil {
		t.Fatal(e)
	}
}
func testProject() Project {
	return Project{SchemaVersion: 1, ProjectID: "imgproj_1", DisplayName: "Demo", Slug: "demo", Status: ProjectDraft, PromptPlan: PromptPlan{PlanVersion: 1, SourceRequirement: "x"}, ImageConfig: ImageConfig{Model: "m", Protocol: "p"}, BatchConfig: BatchConfig{RetryBackoff: BackoffFixed, SeedMode: SeedRandom}, Prompts: []Prompt{{ID: "p0001", Index: 1, NaturalPrompt: "x", FinalFormat: FormatNatural, Quantity: 1, Variants: []Variant{{ID: "p0001-v0001", Index: 1, Status: VariantPending}}}}}
}
