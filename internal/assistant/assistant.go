// Package assistant implements the 小精灵 (sprite) assistant core: it maps a
// natural-language user intent to a set of TinyLab's own callable
// capabilities (its real REST routes), confirms the model-routing layer where
// a model is involved, and tracks periodic jobs the assistant can run on the
// user's behalf (e.g. cleaning expired traces).
//
// The assistant is intentionally a thin dispatch brain: it does not perform
// side effects itself — it resolves intents to (method, route) tuples that the
// project's real handlers already serve. This keeps the assistant a routing
// layer over the existing architecture (proxy + rotation + combo + the /api/*
// capability surface) rather than a parallel one, which is exactly the
// feasibility question under study: can the project host such an assistant on
// top of its model-routing foundation?
package assistant

import "strings"

// ToolSpec describes one callable project capability the assistant can route
// an intent to. Path is a chi route pattern exactly as registered by the
// project's router (e.g. "/v1/images/generations" or "/api/editor/save").
type ToolSpec struct {
	Name       string // stable tool id, e.g. "image.generate"
	Method     string // HTTP method, e.g. "POST"
	Path       string // chi route pattern as registered
	NeedsModel bool   // true when fulfilling this tool requires the model-routing layer
}

// MethodPath returns the canonical "METHOD path" key used to match a tool
// against the project's real registered route set.
func (t ToolSpec) MethodPath() string {
	return t.Method + " " + NormalizePath(t.Path)
}

// ToolRegistry holds the assistant's tool catalog: the map from tool id to
// the real REST route that fulfills it.
type ToolRegistry struct {
	tools map[string]ToolSpec
}

// NewRegistry returns an empty tool registry.
func NewRegistry() *ToolRegistry {
	return &ToolRegistry{tools: make(map[string]ToolSpec)}
}

// Register adds (or replaces) a tool in the catalog. A tool with an empty name
// is ignored.
func (r *ToolRegistry) Register(t ToolSpec) {
	if t.Name == "" {
		return
	}
	r.tools[t.Name] = t
}

// Resolve looks up a tool by name.
func (r *ToolRegistry) Resolve(name string) (ToolSpec, bool) {
	t, ok := r.tools[name]
	return t, ok
}

// Count returns the number of registered tools.
func (r *ToolRegistry) Count() int { return len(r.tools) }


// classifyRule maps an intent to a set of tools the rule contributes when it
// fires. A rule fires when the intent contains at least one of any (OR), all
// of all (AND), and none of none (NOT); each empty clause is satisfied
// trivially. any/all/none carry broad, domain-level keywords (not
// scenario-specific strings) so the classifier generalizes: e.g. "生成"+"图"
// routes to image generation, unless "批量"/"向量"/"编辑" are present,
// which reroute to batch/embeddings/edit.
type classifyRule struct {
	any   []string
	all   []string
	none  []string
	tools []string
}

// Assistant is the 小精灵: it classifies a user intent into tool names,
// resolves them to real project routes, confirms model routing, and exposes
// scheduled jobs. It is the optimization target measured by the dispatch
// benchmark (cmd/assistant-bench).
type Assistant struct {
	reg        *ToolRegistry
	sched      *Scheduler
	rules      []classifyRule
	modelRoute bool
}

// New constructs an Assistant backed by the given registry and scheduler.
// hasModelRoute reports whether the project's model-routing layer (the /v1/*
// proxy + rotation + combo resolver) is wired; model-dependent intents are
// gated on it so an assistant without routing cannot claim model capability.
func New(reg *ToolRegistry, sched *Scheduler, hasModelRoute bool) *Assistant {
	return &Assistant{reg: reg, sched: sched, modelRoute: hasModelRoute}
}

// SetScheduler sets or updates the scheduler instance on the Assistant.
func (a *Assistant) SetScheduler(s *Scheduler) {
	a.sched = s
}

// AddRule adds a simple OR intent→tools mapping: the rule fires when the
// intent contains any of keywords. It is a convenience shorthand for
// AddRuleCond(keywords, nil, nil, tools). Multiple rules may fire for one
// intent (useful for multi-step requests).
func (a *Assistant) AddRule(keywords, tools []string) {
	a.AddRuleCond(keywords, nil, nil, tools)
}

// AddRuleCond adds an expressive intent→tools mapping. The rule fires when
// the intent contains at least one of any (OR; empty = "any intent"), all of
// all (AND; empty = satisfied), and none of none (NOT; empty = satisfied).
// This lets overlapping intents be disambiguated semantically rather than by
// brittle exact-string matching.
func (a *Assistant) AddRuleCond(any, all, none, tools []string) {
	a.rules = append(a.rules, classifyRule{
		any:   append([]string(nil), any...),
		all:   append([]string(nil), all...),
		none:  append([]string(nil), none...),
		tools: append([]string(nil), tools...),
	})
}

// Classify returns the deduplicated set of tool names the assistant believes
// the intent needs, based on its keyword rules. Order is stable (rule order,
// then first-seen within a rule).
func (a *Assistant) Classify(intent string) []string {
	l := strings.ToLower(intent)
	seen := make(map[string]bool)
	var out []string
	for _, rl := range a.rules {
		if ruleMatches(l, rl) {
			for _, t := range rl.tools {
				if !seen[t] {
					seen[t] = true
					out = append(out, t)
				}
			}
		}
	}
	return out
}

// ruleMatches evaluates a classifyRule's any/all/none clauses against a
// lowercased intent. Empty any means the all/none clauses decide alone.
func ruleMatches(l string, rl classifyRule) bool {
	for _, n := range rl.none {
		if n != "" && strings.Contains(l, strings.ToLower(n)) {
			return false
		}
	}
	for _, k := range rl.all {
		if k == "" {
			continue
		}
		if !strings.Contains(l, strings.ToLower(k)) {
			return false
		}
	}
	if len(rl.any) == 0 {
		return true
	}
	return anyContains(l, rl.any)
}

// Resolve looks up a tool name in the catalog.
func (a *Assistant) Resolve(name string) (ToolSpec, bool) {
	return a.reg.Resolve(name)
}

// Scheduler returns the assistant's job scheduler.
func (a *Assistant) Scheduler() *Scheduler { return a.sched }

// HasModelRoute reports whether the model-routing layer is available.
func (a *Assistant) HasModelRoute() bool { return a.modelRoute }

// Registry returns the assistant's tool registry.
func (a *Assistant) Registry() *ToolRegistry { return a.reg }

// anyContains reports whether hay contains any needle (case-insensitive).
func anyContains(hay string, needles []string) bool {
	for _, n := range needles {
		if n == "" {
			continue
		}
		if strings.Contains(hay, strings.ToLower(n)) {
			return true
		}
	}
	return false
}

// NormalizePath canonicalizes a chi route pattern for matching: it trims
// surrounding whitespace and collapses a trailing slash so that a group root
// registered both as "/api/x" (RegisterRoot) and "/api/x/" (the "/" child of
// r.Route("/api/x")) compare equal.
func NormalizePath(p string) string {
	p = strings.TrimSpace(p)
	if len(p) > 1 && strings.HasSuffix(p, "/") {
		p = p[:len(p)-1]
	}
	return p
}
