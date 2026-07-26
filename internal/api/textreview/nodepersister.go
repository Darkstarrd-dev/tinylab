package textreview

import (
	tr "github.com/tinyrouter/tinyrouter/internal/textreview"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// registryPersister is the production NodePersister: it applies ramp-down
// decisions to the registry and persists them to config.yaml via SaveConfig.
// The registry does not SaveConfig itself (the caller saves), so we snapshot
// the live config, apply the change, and write it back.
type registryPersister struct {
	d *apibase.Deps
}

// NewRegistryPersister builds a NodePersister backed by the given deps.
func NewRegistryPersister(d *apibase.Deps) tr.NodePersister {
	return &registryPersister{d: d}
}

// UpdateNodeConcurrency persists the new concurrency for the node, keeping it
// enabled. Returns false if the node was not found.
func (p *registryPersister) UpdateNodeConcurrency(id string, concurrency int) bool {
	if p.d == nil || p.d.Reg == nil {
		return false
	}
	if !p.d.Reg.UpdateTextReviewNode(id, config.TextReviewNode{Concurrency: concurrency, Enabled: true}) {
		return false
	}
	cfg := p.d.Reg.Config()
	_ = p.d.SaveConfig(&cfg)
	return true
}

// DisableNode marks the node disabled with concurrency 0 and persists. Returns
// false if the node was not found.
func (p *registryPersister) DisableNode(id string) bool {
	if p.d == nil || p.d.Reg == nil {
		return false
	}
	if !p.d.Reg.UpdateTextReviewNode(id, config.TextReviewNode{Concurrency: 0, Enabled: false}) {
		return false
	}
	cfg := p.d.Reg.Config()
	_ = p.d.SaveConfig(&cfg)
	return true
}
