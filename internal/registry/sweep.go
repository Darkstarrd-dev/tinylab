package registry

import (
	"strings"

	"github.com/tinylab/tinylab/internal/config"
)

// SweepStaleComboModels removes combo model references that no longer resolve
// to a live provider model (provider deleted, model deleted, or prefix gone)
// and persists nothing by itself — callers save via SaveConfigAndReload.
// Bare references matching a live combo name are kept; unknown bare strings
// are dropped. Returns the number of removed entries (Models+DisabledModels).
func (r *Registry) SweepStaleComboModels() int {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	return r.sweepStaleComboModelsLocked()
}

// SweepStaleQuickSlotModels removes quickslot model references that no longer
// resolve to a live provider model or combo name. QuickSlot SelectedIndex
// follows the previously selected model when it survives, otherwise it is
// clamped into range. Returns the number of removed entries.
func (r *Registry) SweepStaleQuickSlotModels() int {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	return r.sweepStaleQuickSlotModelsLocked()
}

// SweepStaleModelRefs sweeps both combos and quickslots. It is invoked
// automatically by DeleteProvider/DeleteModel so provider/model deletion
// never leaves dangling references behind.
func (r *Registry) SweepStaleModelRefs() (combos, quickslots int) {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	return r.sweepStaleComboModelsLocked(), r.sweepStaleQuickSlotModelsLocked()
}

// sweepStaleRefsLocked runs both sweeps. Caller must hold cfgMu for writing.
func (r *Registry) sweepStaleRefsLocked() {
	r.sweepStaleComboModelsLocked()
	r.sweepStaleQuickSlotModelsLocked()
}

func (r *Registry) sweepStaleComboModelsLocked() int {
	comboNames := make(map[string]bool, len(r.config.Combos))
	for i := range r.config.Combos {
		comboNames[r.config.Combos[i].Name] = true
	}
	removed := 0
	for i := range r.config.Combos {
		kept, n := filterAliveRefs(r.config.Combos[i].Models, r, comboNames)
		r.config.Combos[i].Models = kept
		keptD, nD := filterAliveRefs(r.config.Combos[i].DisabledModels, r, comboNames)
		r.config.Combos[i].DisabledModels = keptD
		removed += n + nD
	}
	return removed
}

func (r *Registry) sweepStaleQuickSlotModelsLocked() int {
	comboNames := make(map[string]bool, len(r.config.Combos))
	for i := range r.config.Combos {
		comboNames[r.config.Combos[i].Name] = true
	}
	removed := 0
	for i := range r.config.QuickSlots {
		qs := &r.config.QuickSlots[i]
		selModel := ""
		if qs.SelectedIndex >= 0 && qs.SelectedIndex < len(qs.Models) {
			selModel = qs.Models[qs.SelectedIndex]
		}
		kept, n := filterAliveRefs(qs.Models, r, comboNames)
		qs.Models = kept
		keptD, nD := filterAliveRefs(qs.DisabledModels, r, comboNames)
		qs.DisabledModels = keptD
		removed += n + nD
		switch {
		case len(kept) == 0:
			qs.SelectedIndex = 0
		case selModel != "":
			if idx := indexOfStr(kept, selModel); idx >= 0 {
				qs.SelectedIndex = idx
			} else if qs.SelectedIndex >= len(kept) {
				qs.SelectedIndex = len(kept) - 1
			}
		case qs.SelectedIndex >= len(kept):
			qs.SelectedIndex = len(kept) - 1
		}
	}
	return removed
}

func filterAliveRefs(in []string, r *Registry, comboNames map[string]bool) ([]string, int) {
	if len(in) == 0 {
		return in, 0
	}
	kept := make([]string, 0, len(in))
	for _, ref := range in {
		if r.isRefAliveLocked(ref, comboNames) {
			kept = append(kept, ref)
		}
	}
	return kept, len(in) - len(kept)
}

// isRefAliveLocked reports whether a combo/quickslot model reference still
// resolves to a live provider model (by ID or alias) or to a live combo name
// (quickslot-only references). Caller must hold cfgMu (read or write).
func (r *Registry) isRefAliveLocked(ref string, comboNames map[string]bool) bool {
	if ref == "" {
		return false
	}
	if comboNames[ref] {
		return true
	}
	prefix, rest := splitRefPrefix(ref)
	if prefix == "" || rest == "" {
		return false
	}
	for i := range r.config.Providers {
		p := &r.config.Providers[i]
		if p.Prefix != prefix {
			continue
		}
		cleaned := stripProviderPrefix(p, rest)
		for _, md := range p.Models {
			if md.ID == rest || md.ID == cleaned || md.Alias == rest || md.Alias == cleaned {
				return true
			}
		}
		return false
	}
	return false
}

// splitRefPrefix splits "prefix/rest" at the first '/'. It mirrors
// util.SplitModel without adding an import edge.
func splitRefPrefix(s string) (string, string) {
	if i := strings.IndexByte(s, '/'); i > 0 {
		return s[:i], s[i+1:]
	}
	return "", s
}

// stripProviderPrefix removes repeated provider prefix/ID segments from a
// model rest (e.g. "or/or/m" or "lm/id/m"), mirroring the proxy forward path
// and sanitizeAlias so stored refs with redundant segments still match.
func stripProviderPrefix(p *config.Provider, rest string) string {
	for {
		trimmed := false
		if p.Prefix != "" && strings.HasPrefix(rest, p.Prefix+"/") {
			rest = strings.TrimPrefix(rest, p.Prefix+"/")
			trimmed = true
		}
		if p.ID != "" && strings.HasPrefix(rest, p.ID+"/") {
			rest = strings.TrimPrefix(rest, p.ID+"/")
			trimmed = true
		}
		if !trimmed {
			return rest
		}
	}
}

func indexOfStr(s []string, v string) int {
	for i, x := range s {
		if x == v {
			return i
		}
	}
	return -1
}
