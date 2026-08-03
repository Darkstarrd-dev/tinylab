package registry

import "github.com/tinyrouter/tinyrouter/internal/config"

// --- TextReviewNodes ---

// ListTextReviewNodes returns a copy of the text-review processing pool nodes.
func (r *Registry) ListTextReviewNodes() []config.TextReviewNode {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	out := make([]config.TextReviewNode, len(r.config.TextReview.Nodes))
	copy(out, r.config.TextReview.Nodes)
	return out
}

// AddTextReviewNode appends a text-review node to the pool. Caller is responsible
// for assigning an ID (mirrors AddReviewPreset, which does not generate one).
func (r *Registry) AddTextReviewNode(n config.TextReviewNode) {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	r.config.TextReview.Nodes = append(r.config.TextReview.Nodes, n)
}

// UpdateTextReviewNode replaces the mutable fields of the node with the given ID.
// Returns false if no node with that ID exists.
func (r *Registry) UpdateTextReviewNode(id string, updates config.TextReviewNode) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.TextReview.Nodes {
		if r.config.TextReview.Nodes[i].ID == id {
			r.config.TextReview.Nodes[i].ProviderID = updates.ProviderID
			r.config.TextReview.Nodes[i].ModelID = updates.ModelID
			r.config.TextReview.Nodes[i].Concurrency = updates.Concurrency
			r.config.TextReview.Nodes[i].Enabled = updates.Enabled
			r.config.TextReview.Nodes[i].IntervalSec = updates.IntervalSec
			r.config.TextReview.Nodes[i].BatchChars = updates.BatchChars
			return true
		}
	}
	return false
}

// UpdateTextReviewNodeFields merges only the non-nil fields into the node with
// the given ID, preserving all other fields (ProviderID/ModelID/IntervalSec/
// BatchChars). Used by the scheduler ramp-down writeback, which must never wipe
// fields it does not manage. Returns false if no node with that ID exists.
func (r *Registry) UpdateTextReviewNodeFields(id string, concurrency *int, enabled *bool) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.TextReview.Nodes {
		if r.config.TextReview.Nodes[i].ID != id {
			continue
		}
		if concurrency != nil {
			r.config.TextReview.Nodes[i].Concurrency = *concurrency
		}
		if enabled != nil {
			r.config.TextReview.Nodes[i].Enabled = *enabled
		}
		return true
	}
	return false
}

// DeleteTextReviewNode removes the node with the given ID. Returns false if not found.
func (r *Registry) DeleteTextReviewNode(id string) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i, n := range r.config.TextReview.Nodes {
		if n.ID == id {
			r.config.TextReview.Nodes = append(r.config.TextReview.Nodes[:i], r.config.TextReview.Nodes[i+1:]...)
			return true
		}
	}
	return false
}

// --- SplitPatterns ---

// ListSplitPatterns returns a copy of the chapter-detection split patterns.
func (r *Registry) ListSplitPatterns() []config.SplitPattern {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	out := make([]config.SplitPattern, len(r.config.TextReview.SplitPatterns))
	copy(out, r.config.TextReview.SplitPatterns)
	return out
}

// AddSplitPattern appends a split pattern. The Key is user-provided (no generation).
func (r *Registry) AddSplitPattern(p config.SplitPattern) {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	r.config.TextReview.SplitPatterns = append(r.config.TextReview.SplitPatterns, p)
}

// UpdateSplitPattern replaces the mutable fields of the pattern with the given key.
// Returns false if no pattern with that key exists.
func (r *Registry) UpdateSplitPattern(key string, updates config.SplitPattern) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.TextReview.SplitPatterns {
		if r.config.TextReview.SplitPatterns[i].Key == key {
			r.config.TextReview.SplitPatterns[i].Label = updates.Label
			r.config.TextReview.SplitPatterns[i].Regex = updates.Regex
			r.config.TextReview.SplitPatterns[i].Flags = updates.Flags
			// Builtin is preserved: user edits to a builtin pattern keep its flag.
			r.config.TextReview.SplitPatterns[i].Builtin = r.config.TextReview.SplitPatterns[i].Builtin || updates.Builtin
			return true
		}
	}
	return false
}

// DeleteSplitPattern removes the pattern with the given key. Returns false if not found.
func (r *Registry) DeleteSplitPattern(key string) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i, p := range r.config.TextReview.SplitPatterns {
		if p.Key == key {
			r.config.TextReview.SplitPatterns = append(r.config.TextReview.SplitPatterns[:i], r.config.TextReview.SplitPatterns[i+1:]...)
			return true
		}
	}
	return false
}
