package assistant

import "testing"

// These tests guard the contract-driven assistant (the optimization target
// measured by cmd/assistant-bench). The assistant's knowledge now comes solely
// from semantics.json, intersected with the real route set; these tests pin
// contract loading, route-intersection wiring, and drift detection.

func TestLoadContractHasRulesAndJobs(t *testing.T) {
	c, err := LoadContract()
	if err != nil {
		t.Fatalf("LoadContract: %v", err)
	}
	if len(c.Rules) == 0 {
		t.Error("contract has no rules")
	}
	if len(c.Jobs) == 0 {
		t.Error("contract has no jobs")
	}
	if !jobExists(c, "clean-traces") || !jobExists(c, "clean-traces-daily") {
		t.Error("expected clean-traces and clean-traces-daily jobs")
	}
}

func jobExists(c *Contract, name string) bool {
	for _, j := range c.Jobs {
		if j.Name == name {
			return true
		}
	}
	return false
}

// allRoutes yields a route set that contains every contract rule's route, so
// nothing drifts — used to test the in-sync path.
func allRoutes(c *Contract) map[string]bool {
	m := map[string]bool{}
	for _, r := range c.Rules {
		m[ToolSpec{Name: r.Tool, Method: r.Method, Path: r.Path}.MethodPath()] = true
	}
	return m
}

func TestBuildAssistantWiresWhenInSync(t *testing.T) {
	c, _ := LoadContract()
	a, drift := c.BuildAssistant(allRoutes(c), true)
	if len(drift) != 0 {
		t.Errorf("expected no drift when all routes exist, got %v", drift)
	}
	tt, ok := a.Resolve("image.generate")
	if !ok {
		t.Fatal("expected image.generate wired when in sync")
	}
	if got := tt.MethodPath(); got != "POST /v1/images/generations" {
		t.Fatalf("MethodPath = %q", got)
	}
	if !tt.NeedsModel {
		t.Error("image.generate must require model routing")
	}
	if !a.Scheduler().Has("clean-traces") {
		t.Error("expected clean-traces job from contract")
	}
}

func TestBuildAssistantClassifiesFromContract(t *testing.T) {
	c, _ := LoadContract()
	a, _ := c.BuildAssistant(allRoutes(c), true)
	got := set(a.Classify("生成一张猫的图片然后写文档保存"))
	if !got["image.generate"] || !got["editor.save"] {
		t.Errorf("expected image.generate+editor.save from contract classifier, got %v", got)
	}
}

func TestBuildAssistantDetectsDrift(t *testing.T) {
	c, _ := LoadContract()
	// Empty route set: every contract rule references a route that "no longer
	// exists" → all distinct tools drift, none wire, none classify.
	a, drift := c.BuildAssistant(map[string]bool{}, true)
	if len(drift) == 0 {
		t.Error("expected drift when no routes exist")
	}
	if a.Registry().Count() != 0 {
		t.Errorf("expected zero wired tools under drift, got %d", a.Registry().Count())
	}
	if got := a.Classify("帮我生成一张猫的图片"); len(got) != 0 {
		t.Errorf("drifted tools must not classify, got %v", got)
	}
}

func TestBuildAssistantDropsOnlyDriftedTool(t *testing.T) {
	c, _ := LoadContract()
	// Route set contains everything EXCEPT image.generate's route: only
	// image.generate should drift; the rest wire and classify.
	rs := allRoutes(c)
	delete(rs, "POST /v1/images/generations")
	a, drift := c.BuildAssistant(rs, true)
	found := false
	for _, d := range drift {
		if d == "image.generate" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected image.generate in drift, got %v", drift)
	}
	if _, ok := a.Resolve("image.generate"); ok {
		t.Error("image.generate must NOT be wired when its route is absent")
	}
	if _, ok := a.Resolve("editor.save"); !ok {
		t.Error("editor.save must still be wired when its route is present")
	}
}

func TestNormalizePathCollapsesTrailingSlash(t *testing.T) {
	cases := map[string]string{
		"/api/image-batches":  "/api/image-batches",
		"/api/image-batches/": "/api/image-batches",
		"  /v1/models  ":      "/v1/models",
		"/":                   "/",
	}
	for in, want := range cases {
		if got := NormalizePath(in); got != want {
			t.Errorf("NormalizePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func set(items []string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, x := range items {
		m[x] = true
	}
	return m
}
