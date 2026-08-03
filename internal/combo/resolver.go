package combo

import (
	"fmt"
	"os"
	"sync"

	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/state"
	"github.com/tinyrouter/tinyrouter/internal/util"
)

// EntryFormat identifies the upstream protocol of the incoming request.
type EntryFormat string

const (
	// EntryFormatOpenAI is the OpenAI-compatible /v1/chat/completions entry.
	EntryFormatOpenAI EntryFormat = "openai"
	// EntryFormatAnthropic is the Anthropic Messages /v1/messages entry.
	EntryFormatAnthropic EntryFormat = "anthropic"
	// EntryFormatOpenAIResponses is the OpenAI Responses /v1/responses entry.
	// Like the OpenAI chat entry it transparently proxies using the standard
	// Authorization: Bearer scheme; no x-api-key is used.
	EntryFormatOpenAIResponses EntryFormat = "openai-responses"
)

// ModelTarget is a resolved provider+model pair within a combo.
type ModelTarget struct {
	ProviderID string
	Model      string
	QuotaType  string
}

// ComboPlan describes how to execute a combo request.
type ComboPlan struct {
	Strategy string        // "fallback" | "round-robin" | "greedy-squirrel"
	Targets  []ModelTarget // ordered; greedy-squirrel sorts by quota tier internally
}

// Resolver resolves combo names into execution plans.
type Resolver struct {
	reg   *registry.Registry
	mu    sync.Mutex
	state map[string]*comboState // combo name → rotation state

	onStateChange func() // injected by main.go for state persistence
}

type comboState struct {
	index       int
	consecCount int
}

// New creates a Resolver.
func New(reg *registry.Registry) *Resolver {
	return &Resolver{reg: reg, state: make(map[string]*comboState)}
}

// Resolve returns a ComboPlan for the given combo name, or nil if not found.
//
// entryFormat is the protocol of the incoming request (OpenAI vs Anthropic).
// It is retained as a parameter because it identifies the routing protocol and
// may drive protocol-specific behavior in the future. Historically it controlled
// target filtering (anthropic entries kept only anthropic-typed providers), but
// that filtering was removed: providers are aggregating proxies that serve
// multiple protocols from the same backend, so capabilities are per-model and
// not per-provider. Targets are therefore never filtered by entryFormat here;
// protocol acceptance is decided by the upstream.
func (r *Resolver) Resolve(comboName string, entryFormat EntryFormat) (*ComboPlan, error) {
	combo, ok := r.reg.GetComboByName(comboName)
	if !ok {
		return nil, nil
	}
	if combo.Disabled {
		return nil, fmt.Errorf("combo is disabled: %s", comboName)
	}

	var targets []ModelTarget
	for _, m := range combo.Models {
		if isModelDisabled(m, combo.DisabledModels) {
			continue
		}
		prefix, model := util.SplitModel(m)
		if prefix == "" {
			continue
		}
		// Resolve prefix to actual provider ID
		provider, ok := r.reg.GetProviderByPrefix(prefix)
		if !ok {
			fmt.Fprintf(os.Stderr, "[combo] warning: combo %q model %q: provider prefix %q not found\n", comboName, m, prefix)
			continue
		}
		mt := ModelTarget{ProviderID: provider.ID, Model: model}
		// Resolve alias to real model ID: combo config may reference models by
		// alias (matching the display ID returned by the API).
		if realID, found := r.reg.ResolveModelAlias(prefix, model); found {
			mt.Model = realID
			model = realID
		}
		for _, md := range provider.Models {
			if md.ID == model {
				mt.QuotaType = md.QuotaType
				break
			}
		}
		if mt.QuotaType == "" {
			mt.QuotaType = "limited"
		}
		targets = append(targets, mt)
	}

	// entryFormat is intentionally not consumed here (see Resolve doc comment):
	// no protocol-based target filtering is performed.

	if len(targets) == 0 {
		return nil, nil
	}

	plan := &ComboPlan{
		Strategy: combo.Strategy,
		Targets:  targets,
	}

	if combo.Strategy == "round-robin" {
		plan.Targets = r.rotateTargets(combo.Name, targets)
	} else if combo.Strategy == "greedy-squirrel" {
		plan.Targets = sortTargetsByTier(targets)
	}

	return plan, nil
}

// rotateTargets rotates the target list based on internal state.
func (r *Resolver) rotateTargets(comboName string, targets []ModelTarget) []ModelTarget {
	r.mu.Lock()
	defer r.mu.Unlock()

	st, ok := r.state[comboName]
	if !ok {
		st = &comboState{index: 0, consecCount: 0}
		r.state[comboName] = st
	}

	st.consecCount++
	if st.consecCount > 3 { // stickyLimit=3
		st.index = (st.index + 1) % len(targets)
		st.consecCount = 1
	}

	if r.onStateChange != nil {
		r.onStateChange()
	}

	// Rotate slice so current index is first
	result := make([]ModelTarget, len(targets))
	for i := range targets {
		result[i] = targets[(st.index+i)%len(targets)]
	}
	return result
}

// SetStateHook sets a callback that is called when combo rotation state changes.
func (r *Resolver) SetStateHook(fn func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.onStateChange = fn
}

// SnapshotComboStates returns a map of combo snapshot data keyed by combo ID.
func (r *Resolver) SnapshotComboStates() map[string]state.ComboSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()

	result := make(map[string]state.ComboSnapshot, len(r.state))
	for id, st := range r.state {
		result[id] = state.ComboSnapshot{
			Index:       st.index,
			ConsecCount: st.consecCount,
		}
	}
	return result
}

// RestoreComboState restores a combo's rotation state from a snapshot. Returns
// an error if the combo ID does not exist in the current config.
func (r *Resolver) RestoreComboState(id string, s state.ComboSnapshot) error {
	if _, ok := r.reg.GetComboByName(id); !ok {
		return fmt.Errorf("combo not found: %s", id)
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	st, ok := r.state[id]
	if !ok {
		st = &comboState{}
		r.state[id] = st
	}
	st.index = s.Index
	st.consecCount = s.ConsecCount
	return nil
}

// sortTargetsByTier sorts targets by quota tier: unlimited → limited → paid,
// preserving original order within each tier.
func sortTargetsByTier(targets []ModelTarget) []ModelTarget {
	var unlimited, limited, paid []ModelTarget
	for _, t := range targets {
		switch t.QuotaType {
		case "unlimited":
			unlimited = append(unlimited, t)
		case "paid":
			paid = append(paid, t)
		default:
			limited = append(limited, t)
		}
	}
	result := make([]ModelTarget, 0, len(targets))
	result = append(result, unlimited...)
	result = append(result, limited...)
	result = append(result, paid...)
	return result
}

func isModelDisabled(model string, disabled []string) bool {
	for _, d := range disabled {
		if d == model {
			return true
		}
	}
	return false
}

// IsComboName checks if the given model string matches a combo name.
func (r *Resolver) IsComboName(name string) bool {
	_, ok := r.reg.GetComboByName(name)
	return ok
}

// ListCombos returns all combos.
func (r *Resolver) ListCombos() []config.Combo {
	return r.reg.ListCombos()
}
