package webhub

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// StreamBudget splits the reply watch into the two phases the P0 prototype
// proved necessary. All three fields are independent budgets — folding them
// into one timeout is exactly what made the prototype capture 0 characters.
type StreamBudget struct {
	// StartTimeout bounds "wait for the reply element to show ANY content".
	//
	// ⚠️ P0 DEFECT ②: the reply node does not exist until the model starts
	// answering, and a deep-thinking model took 5.71s to emit the first token
	// on a real site. When this wait shares the idle budget, the countdown has
	// already expired by the time content appears and the run returns 0 chars.
	// It MUST be its own budget, and it must not be charged against Idle.
	StartTimeout time.Duration
	// IdleTimeout bounds "no new content since the last delta" and only starts
	// ticking after the first content arrived.
	IdleTimeout time.Duration
	// HardTimeout bounds the whole watch (first content + streaming).
	HardTimeout time.Duration
	// PollInterval is the DOM poll cadence.
	PollInterval time.Duration
}

// DefaultStreamBudget returns the budget used when a site does not override it.
// The numbers are the P0 measurements with headroom: first token 5.71s on a
// deep-thinking reply, full reply ~30s.
func DefaultStreamBudget() StreamBudget {
	return StreamBudget{
		StartTimeout: 90 * time.Second,
		IdleTimeout:  12 * time.Second,
		HardTimeout:  300 * time.Second,
		PollInterval: 400 * time.Millisecond,
	}
}

// budgetFor adapts the default budget to a preset's declared hard_timeout.
// Only the hard timeout is taken from rule data (start/idle are latency
// behaviour, not site configuration).
func budgetFor(cfg StreamConfig) StreamBudget {
	b := DefaultStreamBudget()
	if cfg.HardTimeoutSec > 0 {
		b.HardTimeout = time.Duration(cfg.HardTimeoutSec * float64(time.Second))
	}
	return b
}

// StreamResult is the outcome of one reply watch.
type StreamResult struct {
	// Text is the complete reply text observed.
	Text string
	// FirstContentAfter is how long the first content took to appear (the
	// real TTFT of a page-driven site; 0 when nothing was ever seen).
	FirstContentAfter time.Duration
	// Resyncs counts how often the page replaced or rewound the reply node. A
	// non-zero count is normal for markdown re-renders; a large count on a
	// site that "works" means the selector is matching a volatile wrapper.
	Resyncs int
	// TimedOut reports the watch ended on the start or hard timeout rather
	// than on idle (i.e. the reply is probably incomplete).
	TimedOut bool
}

// WatchReply polls the reply container and emits only newly appended text.
//
// The core is a PREFIX DIFF plus a RESYNC GUARD:
//
//   - growth  (len(cur) > len(emitted) && cur starts with emitted)
//     → the new tail is a real delta;
//   - anything else (shorter text, or text that no longer starts with what we
//     already emitted) means the page REPLACED or REWOUND the node — real
//     sites do this on every markdown re-render. Emitting the naive diff then
//     would splice garbage into the client's stream, so we resynchronise
//     silently instead.
//
// ⚠️ P0 validated this against an adversarial fixture that replaces the node
// mid-stream and then rewinds it; without the guard the fixture produces
// corrupt deltas.
func WatchReply(ctx context.Context, page Page, selector string, budget StreamBudget, onDelta func(string)) (StreamResult, error) {
	sel := stripCSSPrefix(selector)
	if sel == "" {
		return StreamResult{}, fmt.Errorf("webhub: watch: empty selector")
	}
	if budget.PollInterval <= 0 {
		budget.PollInterval = DefaultStreamBudget().PollInterval
	}
	var res StreamResult
	emitted := ""
	start := time.Now()

	// Phase 1 — first content. Own budget, does not consume idle.
	seen := false
	for !seen {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		if time.Since(start) > budget.StartTimeout {
			res.TimedOut = true
			return res, fmt.Errorf("webhub: no reply content from %q after %s", sel, budget.StartTimeout)
		}
		cur, err := page.Text(sel)
		if err == nil && strings.TrimSpace(cur) != "" {
			emitted = cur
			seen = true
			res.FirstContentAfter = time.Since(start)
			if onDelta != nil {
				onDelta(cur)
			}
			break
		}
		select {
		case <-ctx.Done():
			return res, ctx.Err()
		case <-time.After(budget.PollInterval):
		}
	}

	// Phase 2 — incremental growth, with the resync guard. The idle clock
	// starts only now (from the first content), never during phase 1.
	last := time.Now()
	for {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		if time.Since(start) > budget.HardTimeout {
			res.Text = emitted
			res.TimedOut = true
			return res, fmt.Errorf("webhub: reply watch exceeded hard timeout %s", budget.HardTimeout)
		}
		cur, err := page.Text(sel)
		if err != nil {
			// Transient CDP hiccup: keep polling until the idle window closes
			// rather than failing the whole request on one bad read.
			cur = ""
		}
		switch {
		case strings.HasPrefix(cur, emitted) && len(cur) > len(emitted):
			delta := cur[len(emitted):]
			emitted = cur
			last = time.Now()
			if onDelta != nil {
				onDelta(delta)
			}
		case len(cur) < len(emitted) || !strings.HasPrefix(cur, emitted):
			// Replaced or rewound node → resync, do NOT emit a delta.
			if cur != emitted {
				res.Resyncs++
				emitted = cur
				last = time.Now()
			}
		}
		if time.Since(last) > budget.IdleTimeout {
			res.Text = emitted
			return res, nil
		}
		select {
		case <-ctx.Done():
			res.Text = emitted
			return res, ctx.Err()
		case <-time.After(budget.PollInterval):
		}
	}
}

// SnapshotText reads the current text of a selector once (used by readiness
// checks that only need "does this element hold anything").
func SnapshotText(page Page, selector string) (string, error) {
	sel := stripCSSPrefix(selector)
	if sel == "" {
		return "", nil
	}
	return page.Text(sel)
}
