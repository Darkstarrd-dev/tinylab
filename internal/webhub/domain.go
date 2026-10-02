package webhub

import (
	"net/url"
	"strings"
)

// routeAliasGroups is the transplanted `route_aliases` table from
// ref/universal-web-api config/site_rules.json: domains that are the same site
// for routing purposes. Each group's first member is the preferred (canonical)
// alias. Sites without aliases are absent — they match only by their own
// domain and the www./non-www. pair.
//
// ⚠️ This is RULE DATA, not code: re-sync it from the upstream file via
// tools/ (see docs/webhub-upstream-sync.md) rather than editing by hand.
var routeAliasGroups = [][]string{
	{"gemini.google.com", "gemini.com"},
}

// normalizeDomain reduces a URL or a bare domain to a lowercase hostname
// (trailing dot and port stripped). It returns "" when no hostname can be
// recovered — callers must treat "" as "not a usable site" and never match it
// against a target (an unparseable tab URL must not be reused).
func normalizeDomain(value string) string {
	raw := strings.TrimSpace(strings.ToLower(value))
	if raw == "" {
		return ""
	}
	candidate := raw
	if !strings.Contains(candidate, "://") {
		candidate = "https://" + strings.TrimLeft(candidate, "/")
	}
	parsed, err := url.Parse(candidate)
	if err != nil {
		return ""
	}
	host := strings.Trim(strings.ToLower(parsed.Hostname()), ".")
	return host
}

// routeDomainAliases returns every hostname that can represent the given
// domain: itself, the www./non-www. counterpart, and every member of its
// alias group. Duplicates are removed; order is stable (self first).
func routeDomainAliases(domain string) []string {
	normalized := normalizeDomain(domain)
	if normalized == "" {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	add := func(v string) {
		h := normalizeDomain(v)
		if h == "" || seen[h] {
			return
		}
		seen[h] = true
		out = append(out, h)
	}
	add(normalized)
	if strings.HasPrefix(normalized, "www.") {
		add(normalized[4:])
	} else {
		add("www." + normalized)
	}
	for _, group := range routeAliasGroups {
		for _, member := range group {
			if normalizeDomain(member) == normalized {
				for _, alias := range group {
					add(alias)
				}
				break
			}
		}
	}
	return out
}

// preferredRouteDomain returns the canonical public alias for a domain (the
// first member of its alias group when it belongs to one, else the
// non-www. form).
func preferredRouteDomain(domain string) string {
	normalized := normalizeDomain(domain)
	if normalized == "" {
		return ""
	}
	for _, group := range routeAliasGroups {
		for _, member := range group {
			if normalizeDomain(member) == normalized {
				return group[0]
			}
		}
	}
	if strings.HasPrefix(normalized, "www.") {
		return normalized[4:]
	}
	return normalized
}

// domainMatches reports whether tabURL is a page of the site identified by
// siteDomain. Matching is by hostname alias only (never by substring): a
// totally different host — including a bare IP such as the DSH GUI's
// 127.0.0.1:20199 — never matches.
//
// ⚠️ This is the guard the P0 prototype lacked: it once attached to a
// non-target tab and navigated the user's DSH GUI page to DeepSeek. Nothing
// outside an exact alias match may ever be reused for a site.
func domainMatches(siteDomain, tabURL string) bool {
	tabHost := normalizeDomain(tabURL)
	if tabHost == "" {
		return false
	}
	for _, target := range routeDomainAliases(siteDomain) {
		if tabHost == target {
			return true
		}
		// Subdomain containment (chat.x.com vs x.com) counts as the same site;
		// it is still an exact host-level relation, not a substring match.
		if strings.HasSuffix(tabHost, "."+target) || strings.HasSuffix(target, "."+tabHost) {
			return true
		}
	}
	return false
}

// siteURL renders the https URL a site should be opened at.
func siteURL(domain string) string {
	return "https://" + preferredRouteDomain(domain) + "/"
}

// SiteURL is the exported form of siteURL: the URL the "open site" action
// sends the user to so they can sign in.
func SiteURL(domain string) string { return siteURL(domain) }

// NormalizeSite reduces a site identifier to its canonical lowercase hostname.
// The API layer uses it so a request for "Chat.DeepSeek.com" and
// "chat.deepseek.com" address the same site.
func NormalizeSite(domain string) string { return normalizeDomain(domain) }
