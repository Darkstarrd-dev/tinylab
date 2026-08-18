package assistant

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed semantics.json
var semanticsJSON []byte

// SemRule is one contract entry: a (tool, real route, intent-keyword group)
// triple. Multiple rules may share a tool — e.g. Chinese + English phrasings of
// image generation each contribute their own classify rule while the tool is
// registered once. all is AND (every keyword must match); none is NOT (no
// keyword may match); keywords is OR (at least one must match).
//
// This file is the assistant's ONLY source of capability knowledge: there is
// no hand-maintained Go catalog. semantics.json is the contract — the norm the
// project follows. When a route is added, changed, or removed, the developer
// updates semantics.json; the bench (cmd/assistant-bench) cross-checks every
// rule against the real chi route set and flags drift (a rule whose route no
// longer exists), so the assistant cannot silently go out of sync with the
// project's real capability surface.
type SemRule struct {
	Tool       string   `json:"tool"`
	Method     string   `json:"method"`
	Path       string   `json:"path"`
	NeedsModel bool     `json:"needsModel"`
	Keywords   []string `json:"keywords"`
	All        []string `json:"all,omitempty"`
	None       []string `json:"none,omitempty"`
	Desc       string   `json:"desc"`
}

// SemJob is one periodic job declared in the contract.
type SemJob struct {
	Name        string `json:"name"`
	IntervalSec int    `json:"intervalSec"`
}

// Contract is the assistant's source-of-truth capability declaration: the
// rules (intent → tool → real route) and the scheduled jobs it can run.
type Contract struct {
	Rules []SemRule `json:"rules"`
	Jobs  []SemJob  `json:"jobs"`
}

// LoadContract parses the embedded semantics.json contract. It is the single
// entry point through which the assistant learns its capabilities.
func LoadContract() (*Contract, error) {
	var c Contract
	if err := json.Unmarshal(semanticsJSON, &c); err != nil {
		return nil, fmt.Errorf("parse semantics.json: %w", err)
	}
	return &c, nil
}

// DistinctTools returns the set of tool names referenced by the contract rules.
func (c *Contract) DistinctTools() []string {
	seen := make(map[string]bool)
	var tools []string
	for _, r := range c.Rules {
		if !seen[r.Tool] {
			seen[r.Tool] = true
			tools = append(tools, r.Tool)
		}
	}
	return tools
}

// BuildAssistant constructs an assistant whose tool catalog and classifier are
// derived SOLELY from the contract, intersected with the real route set.
//
// A rule registers its tool only if its (method, path) exists in routeSet;
// rules whose route is absent are collected as drift — the contract references
// a capability the project no longer exposes, which is a sync violation the
// bench flags. hasModelRoute reports whether the model-routing layer is wired.
//
// This makes the assistant self-correcting against route removal and contract
// drift: deleting a project route automatically drops the corresponding tool
// from the assistant's resolvable set (so it can no longer be dispatched), and
// the drift list tells the developer exactly which contract entries are now
// stale and must be updated.
func (c *Contract) BuildAssistant(routeSet map[string]bool, hasModelRoute bool) (*Assistant, []string) {
	reg := NewRegistry()
	sched := NewScheduler()
	for _, j := range c.Jobs {
		sched.RegisterJob(Job{Name: j.Name, IntervalSec: j.IntervalSec})
	}
	a := New(reg, sched, hasModelRoute)
	var drift []string
	seenDrift := make(map[string]bool)
	for _, r := range c.Rules {
		ts := ToolSpec{Name: r.Tool, Method: r.Method, Path: r.Path, NeedsModel: r.NeedsModel}
		if !routeSet[ts.MethodPath()] {
			// Contract references a route the project no longer serves: drift.
			if !seenDrift[r.Tool] {
				drift = append(drift, r.Tool)
				seenDrift[r.Tool] = true
			}
			continue
		}
		reg.Register(ts) // idempotent: a tool shared by several rules registers once
		a.AddRuleCond(r.Keywords, r.All, r.None, []string{r.Tool})
	}
	return a, drift
}
