package webhub

import (
	"strings"
)

// ignoredSiteIDParts are the domain labels universal-web-api drops when it
// derives a short site id (app/utils/site_rules.py). "chat.deepseek.com"
// therefore yields "deepseek", not "chat".
//
// ⚠️ Transplanted RULE DATA (upstream site_rules.py) — re-sync via tools/.
var ignoredSiteIDParts = map[string]bool{
	"":        true,
	"www":     true,
	"chat":    true,
	"web":     true,
	"app":     true,
	"api":     true,
	"beta":    true,
	"console": true,
	"new":     true,
}

// SiteCardID derives the short card id for a domain: the first non-ignored
// label before the TLD (chat.deepseek.com → deepseek; gemini.google.com →
// gemini). It falls back to the first label when every label is ignored, and
// to the whole host when it carries no dot.
func SiteCardID(domain string) string {
	normalized := normalizeDomain(domain)
	if normalized == "" {
		return ""
	}
	// Drop the TLD, then take the first remaining label that is not generic.
	head := normalized
	if i := strings.LastIndex(head, "."); i > 0 {
		head = head[:i]
	}
	for _, part := range strings.Split(head, ".") {
		if !ignoredSiteIDParts[part] {
			return part
		}
	}
	return strings.Split(normalized, ".")[0]
}

// ModelIDCandidates builds every model id that must route to a site, in
// display order: the full domain, then its route aliases, then the short card
// ids derived from each of those.
//
// Ported from upstream app/utils/model_routing.py `_build_model_id_candidates`
// (+ site_rules.derive_site_card_id):
//
//	chat.deepseek.com → chat.deepseek.com, deepseek
//	gemini.google.com → gemini.google.com, gemini.com, gemini
func ModelIDCandidates(domain string) []string {
	normalized := normalizeDomain(domain)
	if normalized == "" {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	add := func(v string) {
		v = strings.ToLower(strings.TrimSpace(v))
		if v == "" || seen[v] {
			return
		}
		seen[v] = true
		out = append(out, v)
	}
	aliases := routeDomainAliases(normalized)
	add(normalized)
	for _, alias := range aliases {
		add(alias)
	}
	for _, candidate := range append([]string{normalized}, aliases...) {
		add(SiteCardID(candidate))
	}
	return out
}

// ModelIDsForSite returns the model ids registered on a bridged site provider:
// the candidate ids (domain / aliases / short ids) plus `<domain>/<preset>` for
// every preset the site declares, so a caller can pin an explicit preset.
//
// The preset form is always `<full domain>/<preset>`; the short form is not
// expanded per-preset because a short id plus a preset name would be ambiguous
// across sites (two sites can share a preset label such as "主预设").
//
// ⚠️ Preset names come from upstream rule data and may contain spaces or
// non-ASCII characters. They are kept verbatim — the caller (the UI, and the
// `{prefix}/{modelID}` routing below) treats them as opaque path segments.
func ModelIDsForSite(domain string, presetNames []string) []string {
	out := ModelIDCandidates(domain)
	normalized := normalizeDomain(domain)
	if normalized == "" {
		return out
	}
	seen := map[string]bool{}
	for _, id := range out {
		seen[id] = true
	}
	for _, preset := range presetNames {
		preset = strings.TrimSpace(preset)
		if preset == "" {
			continue
		}
		id := normalized + "/" + preset
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// matchesModelAlias reports whether modelID is id itself or id followed by an
// alias delimiter (one of - _ / : .). Upstream uses the same rule so
// "deepseek-chat" routes to the "deepseek" site.
func matchesModelAlias(modelID, aliasID string) bool {
	modelID = strings.ToLower(strings.TrimSpace(modelID))
	aliasID = strings.ToLower(strings.TrimSpace(aliasID))
	if modelID == aliasID {
		return true
	}
	if aliasID == "" || len(modelID) <= len(aliasID) {
		return false
	}
	if !strings.HasPrefix(modelID, aliasID) {
		return false
	}
	return strings.ContainsRune("-_/:.", rune(modelID[len(aliasID)]))
}

// ResolveModelID maps a caller-supplied model id (the part after the prefix)
// to a concrete site + preset, using the known model-id space.
//
// Matching is longest-prefix-wins so a specific alias is never shadowed by a
// shorter one (upstream inspect_model_route, priority 3). An empty modelID
// resolves to the site's default preset. ok is false when nothing matches.
func ResolveModelID(modelID, domain string, presets []string) (preset string, ok bool) {
	modelID = strings.TrimSpace(modelID)
	normalized := normalizeDomain(domain)
	if normalized == "" {
		return "", false
	}

	// A `<domain>/<preset>` form pins the preset explicitly.
	if strings.Contains(modelID, "/") {
		head, tail := modelID, ""
		if i := strings.Index(modelID, "/"); i >= 0 {
			head, tail = modelID[:i], modelID[i+1:]
		}
		if !matchesModelAlias(head, normalized) && !aliasMatchesDomain(head, normalized) {
			return "", false
		}
		if tail == "" {
			return defaultPreset(normalized, presets), true
		}
		for _, p := range presets {
			if p == tail {
				return p, true
			}
		}
		return "", false
	}

	// Bare id / alias / short id → the site's default preset.
	if modelID == "" {
		return defaultPreset(normalized, presets), true
	}
	for _, candidate := range ModelIDCandidates(normalized) {
		if matchesModelAlias(modelID, candidate) {
			return defaultPreset(normalized, presets), true
		}
	}
	return "", false
}

// aliasMatchesDomain reports whether head is one of the domain's aliases
// (or a delimited prefix of one).
func aliasMatchesDomain(head, domain string) bool {
	for _, alias := range routeDomainAliases(domain) {
		if matchesModelAlias(head, alias) {
			return true
		}
	}
	return false
}

// defaultPreset returns the first preset of a site, or "" when it declares
// none (a bare site with no preset table still works — the workflow is then
// the site's single implicit preset).
func defaultPreset(domain string, presets []string) string {
	for _, p := range presets {
		if strings.TrimSpace(p) != "" {
			return p
		}
	}
	return ""
}
