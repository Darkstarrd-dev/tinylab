package imagebatch

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func validPrompt() Prompt {
	return Prompt{ID: "p0001", Index: 1, NaturalPrompt: "a snowy forest", FinalFormat: FormatNatural, FinalPrompt: "a snowy forest", Quantity: 2,
		Variants: []Variant{{ID: "p0001-v0001", Index: 1, Status: VariantPending}}}
}

func validProject() Project {
	return Project{SchemaVersion: 1, ProjectID: "imgproj_01", DisplayName: "Winter", Slug: "winter", Status: ProjectDraft,
		PromptPlan:  PromptPlan{HelperModel: "provider/text", SourceRequirement: "winter scenes", OutputFormat: FormatNatural, PlanVersion: 1},
		ImageConfig: ImageConfig{Model: "provider/image", Protocol: "openai", Endpoint: "generations"},
		BatchConfig: BatchConfig{IntervalMs: 100, MaxRetries: 2, RetryDelayMs: 1000, RetryBackoff: BackoffExponentialJitter, OnError: OnErrorContinue, SeedMode: SeedIncrement, BaseSeed: 420000},
		Prompts:     []Prompt{validPrompt()}}
}

func assertInvalid(t *testing.T, err error, field string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s validation error", field)
	}
	var ve *ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("error %T does not wrap ValidationError: %v", err, err)
	}
	if !strings.Contains(ve.Field, field) {
		t.Fatalf("error field = %q, want %q: %v", ve.Field, field, err)
	}
}

func TestTransformValidationRejectsMalformedFormat(t *testing.T) {
	in := TransformInput{HelperModel: "helper", Format: "yaml", Items: []Prompt{validPrompt()}}
	assertInvalid(t, in.Validate(), "format")
	in.Format = FormatJSON
	in.Items[0].FinalFormat = "xml"
	assertInvalid(t, in.Validate(), "finalFormat")
}

func TestPlanAndManifestRejectEmptyOrDuplicateIDs(t *testing.T) {
	p := validPrompt()
	p.ID = ""
	assertInvalid(t, p.Validate(), "id")

	plan := PlanOutput{Items: []PlanItem{{ID: "p1", NaturalPrompt: "one", Quantity: 1}, {ID: "p1", NaturalPrompt: "two", Quantity: 1}}}
	assertInvalid(t, plan.Validate(), "items")

	project := validProject()
	dup := validPrompt()
	dup.ID = project.Prompts[0].ID
	project.Prompts = append(project.Prompts, dup)
	assertInvalid(t, project.ValidateManifest(), "prompts")
}

func TestValidationEnforcesQuantityRetryAndIntervalBounds(t *testing.T) {
	p := validPrompt()
	p.Quantity = 0
	assertInvalid(t, p.Validate(), "quantity")
	p.Quantity = MaxPromptQuantity + 1
	assertInvalid(t, p.Validate(), "quantity")

	cfg := validProject().BatchConfig
	cfg.IntervalMs = -1
	assertInvalid(t, cfg.Validate(), "intervalMs")
	cfg.IntervalMs = MaxIntervalMs + 1
	assertInvalid(t, cfg.Validate(), "intervalMs")
	cfg = validProject().BatchConfig
	cfg.MaxRetries = MaxRetries + 1
	assertInvalid(t, cfg.Validate(), "maxRetries")
	cfg.MaxRetries = -1
	assertInvalid(t, cfg.Validate(), "maxRetries")
}

func TestValidationRejectsStatusSeedAndBackoff(t *testing.T) {
	p := validProject()
	p.Status = ProjectStatus("unknown")
	assertInvalid(t, p.ValidateManifest(), "status")

	cfg := validProject().BatchConfig
	cfg.RetryBackoff = "linear"
	assertInvalid(t, cfg.Validate(), "retryBackoff")
	cfg.RetryBackoff = BackoffFixed
	cfg.SeedMode = "per-prompt"
	assertInvalid(t, cfg.Validate(), "seedMode")

	v := validPrompt().Variants[0]
	v.Status = VariantStatus("wat")
	assertInvalid(t, v.Validate(), "status")
}

func TestManifestValidationRejectsUnsafeValues(t *testing.T) {
	project := validProject()
	project.Slug = "../outside"
	assertInvalid(t, project.ValidateManifest(), "slug")
	project = validProject()
	project.ImageConfig.Endpoint = "https://evil.example/generate"
	assertInvalid(t, project.ValidateManifest(), "endpoint")
	project = validProject()
	project.Prompts[0].Variants[0].RelativePath = "../secret.png"
	assertInvalid(t, project.ValidateManifest(), "relativePath")
}

func TestSeedCalculationAndStats(t *testing.T) {
	if got := SeedForVariant(420000, 2, 1, 10); got != 420010 {
		t.Fatalf("seed = %d, want 420010", got)
	}
	if got := CalculateSeed(SeedProviderControlled, 42, 1, 1, 1); got != nil {
		t.Fatalf("provider-controlled seed = %v, want nil", *got)
	}
	s := Stats{}
	prompts := []Prompt{validPrompt(), {ID: "p0002", Index: 2, NaturalPrompt: "lake", FinalFormat: FormatNatural, Quantity: 1, Variants: []Variant{{ID: "p0002-v0001", Index: 1, Status: VariantSucceeded}}}}
	s.Recompute(prompts)
	if s.PromptCount != 2 || s.TotalVariants != 3 || s.Completed != 1 || s.Pending != 1 {
		t.Fatalf("unexpected stats: %+v", s)
	}
}

func TestGenerationResultNeverSerializesCredentialsOrBytes(t *testing.T) {
	result := ImageGenerationResult{Key: "secret-key", RawMeta: map[string]any{"authorization": "secret"}, Assets: []GeneratedAsset{{Bytes: []byte("png")}}}
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, "secret-key") || strings.Contains(text, "authorization") || strings.Contains(text, "png") {
		t.Fatalf("sensitive result data serialized: %s", text)
	}
}
