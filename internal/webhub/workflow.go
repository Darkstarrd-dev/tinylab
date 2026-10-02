package webhub

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// optionalStepTimeout bounds ONE optional step.
//
// ⚠️ P0 DEFECT ③: an optional "new chat" click whose selector had rotted
// consumed the entire 90s request budget, so the real work never ran. Every
// optional step now gets its own small bound and a failure is logged, never
// propagated.
const optionalStepTimeout = 5 * time.Second

// waitStepCap ceiling for a WAIT step's declared seconds (rule data is
// upstream-controlled; never let a stale value stall a request).
const waitStepCap = 30 * time.Second

// RunOptions parameterizes one workflow run (one request).
type RunOptions struct {
	// Prompt is the text to send.
	Prompt string
	// Budget is the reply-watch budget (zero fields → defaults).
	Budget StreamBudget
	// OnDelta receives each incremental text delta (may be nil).
	OnDelta func(string)
	// Log records a diagnostic line (may be nil).
	Log func(format string, args ...any)
}

// RunResult is the outcome of a workflow run.
type RunResult struct {
	// Text is the reply text ("" when nothing was captured).
	Text string
	// FirstContentAfter / Resyncs / TimedOut mirror StreamResult.
	FirstContentAfter time.Duration
	Resyncs           int
	TimedOut          bool
	// StepsSkipped counts optional steps that failed and were skipped.
	StepsSkipped int
}

// RunWorkflow executes a preset's declarative step list against a page.
//
// Supported actions (upstream action set, subset needed for send-and-read):
//
//	CLICK        click a selector (optional → bounded, failure skipped)
//	FILL_INPUT   inject the prompt (native setter + verified; see input.go)
//	KEY_PRESS    press a key (only "Enter" is meaningful here)
//	STREAM_WAIT  watch the reply container and stream deltas (stream.go)
//	WAIT         settle delay (uses the step's declared seconds)
//
// Actions this port does not implement (CAPTURE / IF / SELECT_MODEL /
// JS_EXEC / COORD_CLICK / READONLY_HINT) are SKIPPED, not failed: they exist
// upstream for per-site model pickers and conditional guard steps. Skipping
// them keeps the common send-and-read path working on every site instead of
// hard-failing on a step whose semantics were not ported.
func RunWorkflow(ctx context.Context, page Page, preset *Preset, opts RunOptions) (RunResult, error) {
	var res RunResult
	if preset == nil {
		return res, fmt.Errorf("webhub: nil preset")
	}
	if !preset.HasSelectors() {
		return res, fmt.Errorf("webhub: preset %q lacks the required selectors (input_box/result_container)", preset.Name)
	}
	budget := opts.Budget
	if budget.StartTimeout <= 0 && budget.IdleTimeout <= 0 && budget.HardTimeout <= 0 {
		budget = budgetFor(preset.Stream)
	}
	logf := opts.Log
	if logf == nil {
		logf = func(string, ...any) {}
	}

	for i := range preset.Workflow {
		step := &preset.Workflow[i]
		// Resolve the logical target (a selector key) to the real CSS
		// selector; a step naming a raw selector still works (Target is used
		// verbatim when it is not a known key).
		sel := resolveTarget(preset, step.Target)

		switch step.Action {
		case ActionFillInput:
			if err := FillInput(page, sel, opts.Prompt); err != nil {
				return res, fmt.Errorf("webhub: %s: %w", step.Action, err)
			}

		case ActionKeyPress:
			if !strings.EqualFold(strings.TrimSpace(step.Target), "Enter") {
				logf("webhub: unsupported KEY_PRESS %q (only Enter is ported), skipping", step.Target)
				continue
			}
			if err := PressEnter(page); err != nil {
				return res, fmt.Errorf("webhub: KEY_PRESS: %w", err)
			}

		case ActionClick:
			if sel == "" {
				logf("webhub: CLICK with empty selector, skipping")
				continue
			}
			if step.Optional {
				if err := clickBounded(ctx, page, sel, optionalStepTimeout, logf); err != nil {
					res.StepsSkipped++
					logf("webhub: optional CLICK %q failed, skipping: %v", sel, err)
				}
				continue
			}
			if err := page.Click(sel); err != nil {
				return res, fmt.Errorf("webhub: CLICK %q: %w", sel, err)
			}

		case ActionWait:
			time.Sleep(waitDuration(step.Seconds))

		case ActionStreamWait:
			sr, err := WatchReply(ctx, page, sel, budget, opts.OnDelta)
			res.Text = sr.Text
			res.FirstContentAfter = sr.FirstContentAfter
			res.Resyncs = sr.Resyncs
			res.TimedOut = sr.TimedOut
			if err != nil {
				return res, err
			}

		default:
			// Not ported (see the doc comment): skip, but record it so a
			// site that relies on the skipped step is diagnosable.
			logf("webhub: action %q not ported, skipping (step %q)", step.Action, step.Label)
		}
	}
	if res.Text == "" && !res.TimedOut {
		return res, fmt.Errorf("webhub: workflow produced no reply text")
	}
	return res, nil
}

// resolveTarget maps a step target to a CSS selector: known selector keys are
// looked up in the preset's selector map; anything else is used verbatim (some
// upstream steps name raw CSS or a non-selector token such as "Enter").
func resolveTarget(preset *Preset, target string) string {
	target = strings.TrimSpace(target)
	if target == "" {
		return ""
	}
	if v := preset.Selector(target); v != "" {
		return stripCSSPrefix(v)
	}
	return stripCSSPrefix(target)
}

// waitDuration clamps a WAIT step's declared seconds.
func waitDuration(seconds float64) time.Duration {
	if seconds <= 0 {
		return 0
	}
	d := time.Duration(seconds * float64(time.Second))
	if d > waitStepCap {
		return waitStepCap
	}
	return d
}

// clickBounded clicks selector under a hard bound so a stale optional
// selector can never eat the request budget (P0 defect ③).
func clickBounded(ctx context.Context, page Page, selector string, bound time.Duration, logf func(string, ...any)) error {
	done := make(chan error, 1)
	go func() { done <- page.Click(selector) }()
	select {
	case err := <-done:
		return err
	case <-time.After(bound):
		logf("webhub: click %q exceeded %s, abandoning", selector, bound)
		return fmt.Errorf("timeout after %s", bound)
	case <-ctx.Done():
		return ctx.Err()
	}
}
