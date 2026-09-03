package rotation

import (
	"net/http"
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

func TestGetAdapter(t *testing.T) {
	// modelscope.cn -> ModelScopeAdapter
	ms := GetAdapter(config.Provider{BaseURL: "https://modelscope.cn/api/v1"})
	if _, ok := ms.(*ModelScopeAdapter); !ok {
		t.Errorf("expected ModelScopeAdapter for modelscope URL, got %T", ms)
	}
	// default -> NoopAdapter
	noop := GetAdapter(config.Provider{BaseURL: "https://api.openai.com/v1"})
	if _, ok := noop.(*NoopAdapter); !ok {
		t.Errorf("expected NoopAdapter for generic URL, got %T", noop)
	}
}

func TestParseHeaders_ModelScope(t *testing.T) {
	a := &ModelScopeAdapter{}
	h := http.Header{}
	h.Set("Modelscope-Ratelimit-Model-Requests-Limit", "100")
	h.Set("Modelscope-Ratelimit-Model-Requests-Remaining", "80")
	snap := a.ParseHeaders(h)
	if snap == nil {
		t.Fatal("ParseHeaders returned nil")
	}
	if snap.ModelLimit != 100 || snap.ModelRemaining != 80 {
		t.Errorf("limit/remaining = %d/%d, want 100/80", snap.ModelLimit, snap.ModelRemaining)
	}
	if !snap.HasQuota() {
		t.Error("HasQuota should be true when remaining > 0")
	}
	if snap.ModelExhausted() {
		t.Error("ModelExhausted should be false when remaining > 0")
	}
}

func TestParseHeaders_Exhausted(t *testing.T) {
	a := &ModelScopeAdapter{}
	h := http.Header{}
	h.Set("Modelscope-Ratelimit-Model-Requests-Limit", "100")
	h.Set("Modelscope-Ratelimit-Model-Requests-Remaining", "0")
	snap := a.ParseHeaders(h)
	if snap == nil {
		t.Fatal("ParseHeaders returned nil")
	}
	if !snap.ModelExhausted() {
		t.Error("ModelExhausted should be true when remaining == 0")
	}
	// HasQuota reports whether quota *info* is present (limit > 0), which is
	// still true even when the model is exhausted.
	if !snap.HasQuota() {
		t.Error("HasQuota should be true when limit > 0 (even if exhausted)")
	}
}

func TestParseHeaders_Noop(t *testing.T) {
	a := &NoopAdapter{}
	snap := a.ParseHeaders(http.Header{})
	if snap != nil {
		t.Errorf("NoopAdapter.ParseHeaders should return nil, got %+v", snap)
	}
}

func TestAtoiSafe(t *testing.T) {
	cases := map[string]int{
		"100":     100,
		"0":       0,
		"":        0,
		"notanum": 0,
		" 42 ":    42, // atoiSafe trims whitespace
	}
	for in, want := range cases {
		if got := atoiSafe(in); got != want {
			t.Errorf("atoiSafe(%q) = %d, want %d", in, got, want)
		}
	}
}
