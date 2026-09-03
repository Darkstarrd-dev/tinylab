package combo

import (
	"testing"

	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/registry"
	"github.com/tinylab/tinylab/internal/util"
)

func testRegistry(combos ...config.Combo) *registry.Registry {
	return registry.New(&config.Config{
		Combos: combos,
	})
}

func testRegistryWithProviders(providers []config.Provider, combos ...config.Combo) *registry.Registry {
	return registry.New(&config.Config{
		Providers: providers,
		Combos:    combos,
	})
}

func TestResolve_NotFound(t *testing.T) {
	r := New(testRegistry())
	plan, err := r.Resolve("nonexistent", EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan != nil {
		t.Fatalf("expected nil plan, got %+v", plan)
	}
}

func TestResolve_Fallback(t *testing.T) {
	providers := []config.Provider{
		{ID: "p1", Prefix: "provA", Name: "A"},
		{ID: "p2", Prefix: "provB", Name: "B"},
	}
	c := config.Combo{
		ID: "c1", Name: "fb", Strategy: "fallback",
		Models: []string{"provA/model-a", "provB/model-b"},
	}
	r := New(testRegistryWithProviders(providers, c))

	plan, err := r.Resolve("fb", EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan == nil {
		t.Fatal("expected non-nil plan")
	}
	if plan.Strategy != "fallback" {
		t.Errorf("expected strategy fallback, got %s", plan.Strategy)
	}
	if len(plan.Targets) != 2 {
		t.Fatalf("expected 2 targets, got %d", len(plan.Targets))
	}
	if plan.Targets[0].ProviderID != "p1" || plan.Targets[0].Model != "model-a" {
		t.Errorf("unexpected first target: %+v", plan.Targets[0])
	}
	if plan.Targets[1].ProviderID != "p2" || plan.Targets[1].Model != "model-b" {
		t.Errorf("unexpected second target: %+v", plan.Targets[1])
	}
}

func TestResolve_RoundRobin_Sticky(t *testing.T) {
	providers := []config.Provider{
		{ID: "p1", Prefix: "provA", Name: "A"},
		{ID: "p2", Prefix: "provB", Name: "B"},
		{ID: "p3", Prefix: "provC", Name: "C"},
	}
	c := config.Combo{
		ID: "c1", Name: "rr", Strategy: "round-robin",
		Models: []string{"provA/model-a", "provB/model-b", "provC/model-c"},
	}
	r := New(testRegistryWithProviders(providers, c))

	for i := 0; i < 3; i++ {
		plan, _ := r.Resolve("rr", EntryFormatOpenAI)
		if plan.Targets[0].ProviderID != "p1" {
			t.Errorf("call %d: expected p1 first, got %s", i, plan.Targets[0].ProviderID)
		}
	}
}

// TestResolve_RoundRobin_UsesConfiguredStickyLimit guards F-19: round-robin
// target rotation must honor the configured rotation.stickyLimit instead of a
// hardcoded 3. With stickyLimit=2 the first target must be reused for exactly
// 2 calls and rotate on the 3rd.
func TestResolve_RoundRobin_UsesConfiguredStickyLimit(t *testing.T) {
	providers := []config.Provider{
		{ID: "p1", Prefix: "provA", Name: "A"},
		{ID: "p2", Prefix: "provB", Name: "B"},
	}
	c := config.Combo{
		ID: "c1", Name: "rr", Strategy: "round-robin",
		Models: []string{"provA/model-a", "provB/model-b"},
	}
	cfg := &config.Config{
		Rotation:  config.RotationConfig{StickyLimit: 2},
		Providers: providers,
		Combos:    []config.Combo{c},
	}
	r := New(registry.New(cfg))

	for i := 0; i < 2; i++ {
		plan, err := r.Resolve("rr", EntryFormatOpenAI)
		if err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
		if plan.Targets[0].ProviderID != "p1" {
			t.Fatalf("call %d: expected p1 (sticky), got %s", i, plan.Targets[0].ProviderID)
		}
	}
	plan, err := r.Resolve("rr", EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("call 3: %v", err)
	}
	if plan.Targets[0].ProviderID != "p2" {
		t.Errorf("call 3: expected rotation to p2 after stickyLimit=2 uses, got %s", plan.Targets[0].ProviderID)
	}
}

// TestResolve_RoundRobin_ZeroStickyLimitFallsBackToDefault guards F-19: a
// zero/negative configured stickyLimit falls back to the historical default
// of 3 (rotation on the 4th call).
func TestResolve_RoundRobin_ZeroStickyLimitFallsBackToDefault(t *testing.T) {
	providers := []config.Provider{
		{ID: "p1", Prefix: "provA", Name: "A"},
		{ID: "p2", Prefix: "provB", Name: "B"},
	}
	c := config.Combo{
		ID: "c1", Name: "rr", Strategy: "round-robin",
		Models: []string{"provA/model-a", "provB/model-b"},
	}
	cfg := &config.Config{
		Rotation:  config.RotationConfig{StickyLimit: 0},
		Providers: providers,
		Combos:    []config.Combo{c},
	}
	r := New(registry.New(cfg))

	for i := 0; i < 3; i++ {
		plan, err := r.Resolve("rr", EntryFormatOpenAI)
		if err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
		if plan.Targets[0].ProviderID != "p1" {
			t.Fatalf("call %d: expected p1 (sticky), got %s", i, plan.Targets[0].ProviderID)
		}
	}
	plan, err := r.Resolve("rr", EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("call 4: %v", err)
	}
	if plan.Targets[0].ProviderID != "p2" {
		t.Errorf("call 4: expected rotation to p2 after default stickyLimit=3, got %s", plan.Targets[0].ProviderID)
	}
}

func TestResolve_RoundRobin_Rotate(t *testing.T) {
	providers := []config.Provider{
		{ID: "p1", Prefix: "provA", Name: "A"},
		{ID: "p2", Prefix: "provB", Name: "B"},
		{ID: "p3", Prefix: "provC", Name: "C"},
	}
	c := config.Combo{
		ID: "c1", Name: "rr", Strategy: "round-robin",
		Models: []string{"provA/model-a", "provB/model-b", "provC/model-c"},
	}
	r := New(testRegistryWithProviders(providers, c))

	for i := 0; i < 3; i++ {
		r.Resolve("rr", EntryFormatOpenAI)
	}
	plan, _ := r.Resolve("rr", EntryFormatOpenAI)
	if plan.Targets[0].ProviderID != "p2" {
		t.Errorf("after 3 calls, expected p2 first, got %s", plan.Targets[0].ProviderID)
	}
}

func TestResolve_EmptyModels(t *testing.T) {
	c := config.Combo{
		ID: "c1", Name: "empty", Strategy: "fallback",
		Models: []string{},
	}
	r := New(testRegistry(c))

	plan, _ := r.Resolve("empty", EntryFormatOpenAI)
	if plan != nil {
		t.Fatalf("expected nil for empty models, got %+v", plan)
	}
}

func TestResolve_InvalidModelFormat(t *testing.T) {
	c := config.Combo{
		ID: "c1", Name: "bad", Strategy: "fallback",
		Models: []string{"no-slash"},
	}
	r := New(testRegistry(c))

	plan, _ := r.Resolve("bad", EntryFormatOpenAI)
	if plan != nil {
		t.Fatalf("expected nil for invalid model, got %+v", plan)
	}
}

func TestResolve_GreedySquirrel_TierOrdering(t *testing.T) {
	providers := []config.Provider{
		{ID: "p1", Prefix: "provA", Name: "A", Models: []config.ModelDef{
			{ID: "model-a", QuotaType: "unlimited"},
		}},
		{ID: "p2", Prefix: "provB", Name: "B", Models: []config.ModelDef{
			{ID: "model-b", QuotaType: "paid"},
		}},
		{ID: "p3", Prefix: "provC", Name: "C", Models: []config.ModelDef{
			{ID: "model-c", QuotaType: "limited"},
		}},
	}
	c := config.Combo{
		ID: "c1", Name: "gs", Strategy: "greedy-squirrel",
		Models: []string{"provA/model-a", "provB/model-b", "provC/model-c"},
	}
	r := New(testRegistryWithProviders(providers, c))

	plan, err := r.Resolve("gs", EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan == nil {
		t.Fatal("expected non-nil plan")
	}
	if plan.Strategy != "greedy-squirrel" {
		t.Errorf("expected strategy greedy-squirrel, got %s", plan.Strategy)
	}
	if len(plan.Targets) != 3 {
		t.Fatalf("expected 3 targets, got %d", len(plan.Targets))
	}
	// Expected ordering: unlimited → limited → paid
	if plan.Targets[0].ProviderID != "p1" || plan.Targets[0].QuotaType != "unlimited" {
		t.Errorf("expected first target p1/unlimited, got %+v", plan.Targets[0])
	}
	if plan.Targets[1].ProviderID != "p3" || plan.Targets[1].QuotaType != "limited" {
		t.Errorf("expected second target p3/limited, got %+v", plan.Targets[1])
	}
	if plan.Targets[2].ProviderID != "p2" || plan.Targets[2].QuotaType != "paid" {
		t.Errorf("expected third target p2/paid, got %+v", plan.Targets[2])
	}
}

func TestResolve_GreedySquirrel_UnknownQuotaDefaultsLimited(t *testing.T) {
	providers := []config.Provider{
		{ID: "p1", Prefix: "provA", Name: "A", Models: []config.ModelDef{
			{ID: "model-a", QuotaType: "unlimited"},
		}},
		{ID: "p2", Prefix: "provB", Name: "B"},
		{ID: "p3", Prefix: "provC", Name: "C"},
	}
	c := config.Combo{
		ID: "c1", Name: "gs2", Strategy: "greedy-squirrel",
		Models: []string{"provA/model-a", "provB/model-b", "provC/model-c"},
	}
	r := New(testRegistryWithProviders(providers, c))

	plan, _ := r.Resolve("gs2", EntryFormatOpenAI)
	if plan == nil {
		t.Fatal("expected non-nil plan")
	}
	if len(plan.Targets) != 3 {
		t.Fatalf("expected 3 targets, got %d", len(plan.Targets))
	}
	// model-a is unlimited, model-b and model-c have empty quota → default to limited
	if plan.Targets[0].ProviderID != "p1" || plan.Targets[0].QuotaType != "unlimited" {
		t.Errorf("expected first target p1/unlimited, got %+v", plan.Targets[0])
	}
	if plan.Targets[1].QuotaType != "limited" {
		t.Errorf("expected second target limited, got %+v", plan.Targets[1])
	}
	if plan.Targets[2].QuotaType != "limited" {
		t.Errorf("expected third target limited, got %+v", plan.Targets[2])
	}
}

func TestIsComboName(t *testing.T) {
	c := config.Combo{Name: "mycombo", Strategy: "fallback", Models: []string{"p/m"}}
	r := New(testRegistry(c))

	if !r.IsComboName("mycombo") {
		t.Error("expected true for existing combo")
	}
	if r.IsComboName("nonexistent") {
		t.Error("expected false for non-existent combo")
	}
}

func TestSplitModel(t *testing.T) {
	provider, model := util.SplitModel("deepseek/deepseek-chat")
	if provider != "deepseek" || model != "deepseek-chat" {
		t.Errorf("expected deepseek/deepseek-chat, got %s/%s", provider, model)
	}

	provider, model = util.SplitModel("no-slash")
	if provider != "" || model != "no-slash" {
		t.Errorf("expected empty provider, got %s/%s", provider, model)
	}

	provider, model = util.SplitModel("a/b/c")
	if provider != "a" || model != "b/c" {
		t.Errorf("expected a/b/c, got %s/%s", provider, model)
	}
}

// anthropicProviders returns a provider set mixing anthropic and openai types.
func anthropicOpenaiProviders() []config.Provider {
	return []config.Provider{
		{ID: "a1", Prefix: "anthA", Name: "AnthA", APIType: "anthropic"},
		{ID: "a2", Prefix: "anthB", Name: "AnthB", APIType: "anthropic"},
		{ID: "o1", Prefix: "openA", Name: "OpenA", APIType: "openai"},
		{ID: "o2", Prefix: "openB", Name: "OpenB"},
	}
}

func mixedCombo() config.Combo {
	return config.Combo{
		ID: "c1", Name: "mx", Strategy: "fallback",
		Models: []string{"anthA/model-a", "openA/model-o", "anthB/model-b", "openB/model-ob"},
	}
}

func TestResolve_DoesNotFilterByEntryFormat(t *testing.T) {
	r := New(testRegistryWithProviders(anthropicOpenaiProviders(), mixedCombo()))

	plan, err := r.Resolve("mx", EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan == nil {
		t.Fatal("expected non-nil plan")
	}
	if len(plan.Targets) != 4 {
		t.Fatalf("expected 4 unfiltered targets, got %d: %+v", len(plan.Targets), plan.Targets)
	}
}

func TestResolve_AnthropicEntryDoesNotFilter(t *testing.T) {
	r := New(testRegistryWithProviders(anthropicOpenaiProviders(), mixedCombo()))

	plan, err := r.Resolve("mx", EntryFormatAnthropic)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan == nil {
		t.Fatal("expected non-nil plan")
	}
	// Anthropic entry no longer filters by provider.APIType: all 4 mixed
	// targets (anthropic + openai providers) must be available, identical to
	// the OpenAI entry behavior.
	if len(plan.Targets) != 4 {
		t.Fatalf("expected 4 unfiltered targets for anthropic entry, got %d: %+v", len(plan.Targets), plan.Targets)
	}
}
