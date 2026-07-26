package config

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// TestTextReviewDefaultsInjected verifies that a Config with a zero TextReview
// field gets the built-in SplitPatterns injected by finalizeConfig, and that
// Nodes stay nil (no empty-list injection).
func TestTextReviewDefaultsInjected(t *testing.T) {
	cfg := &Config{}
	finalizeConfig(cfg, []byte("port: 20128\n"))

	if len(cfg.TextReview.SplitPatterns) != 9 {
		t.Fatalf("expected 9 default split patterns, got %d", len(cfg.TextReview.SplitPatterns))
	}
	// Spot-check a couple of ported entries against split.ts.
	zhang := cfg.TextReview.SplitPatterns[0]
	if zhang.Key != "zhang" || zhang.Regex != "^(第[0-9零一二三四五六七八九十百千万]+章.*)" || !zhang.Builtin {
		t.Errorf("zhang pattern mismatch: %+v", zhang)
	}
	chapter := cfg.TextReview.SplitPatterns[5]
	if chapter.Key != "chapter" || chapter.Flags != "i" || chapter.Regex != `^(chapter\s+[0-9ivxlc]+.*)` {
		t.Errorf("chapter pattern mismatch: %+v", chapter)
	}
	if cfg.TextReview.Nodes != nil {
		t.Errorf("Nodes should remain nil, got %v", cfg.TextReview.Nodes)
	}
}

// TestTextReviewEmptySplitPatternsNotReinjected verifies that an explicit empty
// list (user cleared patterns) is NOT re-injected (nil vs empty distinction).
func TestTextReviewEmptySplitPatternsNotReinjected(t *testing.T) {
	cfg := &Config{TextReview: TextReviewConfig{SplitPatterns: []SplitPattern{}}}
	finalizeConfig(cfg, []byte("port: 20128\n"))
	if len(cfg.TextReview.SplitPatterns) != 0 {
		t.Errorf("expected 0 patterns for explicit empty, got %d", len(cfg.TextReview.SplitPatterns))
	}
}

// TestTextReviewYAMLRoundTrip verifies a Config with Nodes + SplitPatterns
// marshals and unmarshals without loss.
func TestTextReviewYAMLRoundTrip(t *testing.T) {
	src := Config{
		TextReview: TextReviewConfig{
			Nodes: []TextReviewNode{
				{ID: "trn-1", ProviderID: "p1", ModelID: "gpt-4o", Concurrency: 3, Enabled: true},
			},
			SplitPatterns: []SplitPattern{
				{Key: "zhang", Label: "第X章", Regex: "^(第.+章)", Builtin: true},
				{Key: "custom-x", Label: "自定义", Regex: "^XX"},
			},
			DefaultPromptPresetID: "builtin-ad",
		},
	}
	out, err := yaml.Marshal(src)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(out)
	if !strings.Contains(s, "textReview:") {
		t.Errorf("marshaled YAML missing textReview: key\n%s", s)
	}

	var dst Config
	if err := yaml.Unmarshal(out, &dst); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(dst.TextReview.Nodes) != 1 || dst.TextReview.Nodes[0].ID != "trn-1" {
		t.Errorf("node round-trip mismatch: %+v", dst.TextReview.Nodes)
	}
	if dst.TextReview.Nodes[0].Concurrency != 3 || !dst.TextReview.Nodes[0].Enabled {
		t.Errorf("node fields lost in round-trip: %+v", dst.TextReview.Nodes[0])
	}
	if len(dst.TextReview.SplitPatterns) != 2 {
		t.Fatalf("expected 2 split patterns, got %d", len(dst.TextReview.SplitPatterns))
	}
	if dst.TextReview.DefaultPromptPresetID != "builtin-ad" {
		t.Errorf("defaultPromptPresetId lost: %q", dst.TextReview.DefaultPromptPresetID)
	}
}
