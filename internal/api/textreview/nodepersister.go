package textreview

import (
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	tr "github.com/tinyrouter/tinyrouter/internal/textreview"
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
// enabled. Field-level merge: ProviderID/ModelID/IntervalSec/BatchChars are
// preserved. Returns false if the node was not found.
func (p *registryPersister) UpdateNodeConcurrency(id string, concurrency int) bool {
	if p.d == nil || p.d.Reg == nil {
		return false
	}
	c, e := concurrency, true
	if !p.d.Reg.UpdateTextReviewNodeFields(id, &c, &e) {
		return false
	}
	cfg := p.d.Reg.Config()
	_ = p.d.SaveConfig(&cfg)
	return true
}

// DisableNode marks the node disabled with concurrency 0 and persists. Field-level
// merge: ProviderID/ModelID/IntervalSec/BatchChars are preserved. Returns false if
// the node was not found.
func (p *registryPersister) DisableNode(id string) bool {
	if p.d == nil || p.d.Reg == nil {
		return false
	}
	c, e := 0, false
	if !p.d.Reg.UpdateTextReviewNodeFields(id, &c, &e) {
		return false
	}
	cfg := p.d.Reg.Config()
	_ = p.d.SaveConfig(&cfg)
	return true
}
