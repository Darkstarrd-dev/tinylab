package webhub

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// ProbeTimeout bounds one readiness probe. A probe is a real message sent to
// the site, so it costs the user a turn — keep it small but realistic (a page
// has to render before a reply exists).
const ProbeTimeout = 90 * time.Second

// ProbeMessage is the minimal message a readiness probe sends. Short and
// deterministic: the reply content is irrelevant, only "did the site answer"
// matters.
const ProbeMessage = "Reply with the single word: ok"

// ProbeResult reports what a readiness probe observed.
type ProbeResult struct {
	// OK is true when the site answered with any text.
	OK bool
	// Reply is the observed reply text (trimmed, capped for transport).
	Reply string
	// FirstContentAfter is the site's real first-token latency.
	FirstContentAfter time.Duration
	// Error carries the failure reason when OK is false.
	Error string
}

// Probe checks whether a site is usable right now: a tab of the site is
// attached, its composer accepts the probe message, and the site answers.
//
// ⚠️ UWA has no programmatic "is the user logged in" probe, so "answered a
// real message" is the only honest readiness signal — and it is the same
// approximation the architecture documents (§4.3). A site that is NOT logged
// in typically shows a login wall: the composer is missing, or the reply never
// comes. Both surface as an error here, with a message the UI can act on.
func (m *Manager) Probe(site string) error {
	_, err := m.ProbeDetail(site)
	return err
}

// ProbeDetail runs a probe and returns the structured observation (the API
// layer renders it; Probe is the boolean convenience wrapper).
func (m *Manager) ProbeDetail(site string) (ProbeResult, error) {
	var res ProbeResult
	domain := normalizeDomain(site)
	rule := SiteRuleByDomain(domain)
	if rule == nil {
		res.Error = fmt.Sprintf("unsupported site %q", site)
		return res, fmt.Errorf("webhub: %s", res.Error)
	}
	if m.sessions == nil || m.sessions.Endpoint() == "" {
		res.Error = "browser not connected"
		return res, ErrNotConnected
	}
	preset := rule.Default()
	if preset == nil || !preset.HasSelectors() {
		res.Error = "site rules lack the required selectors"
		return res, fmt.Errorf("webhub: %s", res.Error)
	}

	ctx, cancel := context.WithTimeout(context.Background(), ProbeTimeout)
	defer cancel()

	d := NewDriver(m)
	out, err := d.Chat(ctx, ChatRequest{Site: domain, Prompt: ProbeMessage})
	if err != nil {
		res.Error = err.Error()
		res.OK = false
		return res, err
	}
	res.OK = true
	res.Reply = clip(out.Text, 400)
	res.FirstContentAfter = out.FirstContentAfter
	return res, nil
}

// clip shortens s to at most n runes with an ellipsis marker.
func clip(s string, n int) string {
	runes := []rune(strings.TrimSpace(s))
	if len(runes) <= n {
		return string(runes)
	}
	return string(runes[:n]) + "…"
}
