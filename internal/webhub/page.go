package webhub

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/chromedp/chromedp"
)

// Page is the narrow browser-page surface the workflow engine drives. It
// exists so the engine is testable without a real browser: tests substitute a
// fake page (see page_fake_test.go) and exercise the same action interpreter
// that drives Chrome in production.
type Page interface {
	// Eval runs script in the page and decodes its result into out (a pointer
	// or nil to discard). The script must be an expression.
	Eval(script string, out any) error
	// Click clicks the first element matching selector.
	Click(selector string) error
	// WaitVisible blocks until an element matching selector is visible, or
	// until timeout passes.
	WaitVisible(selector string, timeout time.Duration) error
	// Text returns the innerText of the LAST element matching selector (sites
	// append replies, so the newest one is last), or "" when none match.
	Text(selector string) (string, error)
	// Exists reports whether at least one element matches selector.
	Exists(selector string) (bool, error)
}

// chromedpPage drives a real tab over CDP.
type chromedpPage struct {
	ctx context.Context
}

// NewPage wraps a chromedp context (a context bound to one tab via
// chromedp.WithTargetID) as a Page.
func NewPage(ctx context.Context) Page { return &chromedpPage{ctx: ctx} }

func (p *chromedpPage) Eval(script string, out any) error {
	if err := chromedp.Run(p.ctx, chromedp.Evaluate(script, out)); err != nil {
		return fmt.Errorf("webhub: eval: %w", err)
	}
	return nil
}

func (p *chromedpPage) Click(selector string) error {
	if err := chromedp.Run(p.ctx,
		chromedp.WaitVisible(selector, chromedp.ByQuery),
		chromedp.Click(selector, chromedp.ByQuery),
	); err != nil {
		return fmt.Errorf("webhub: click %q: %w", selector, err)
	}
	return nil
}

func (p *chromedpPage) WaitVisible(selector string, timeout time.Duration) error {
	tctx, cancel := context.WithTimeout(p.ctx, timeout)
	defer cancel()
	if err := chromedp.Run(tctx, chromedp.WaitVisible(selector, chromedp.ByQuery)); err != nil {
		return fmt.Errorf("webhub: wait %q: %w", selector, err)
	}
	return nil
}

func (p *chromedpPage) Text(selector string) (string, error) {
	var text string
	script := fmt.Sprintf(`(function(){
		var els = document.querySelectorAll(%s);
		if (!els || !els.length) return '';
		var el = els[els.length-1];
		return el.innerText || el.textContent || '';
	})()`, jsString(selector))
	if err := p.Eval(script, &text); err != nil {
		return "", err
	}
	return text, nil
}

func (p *chromedpPage) Exists(selector string) (bool, error) {
	var ok bool
	script := fmt.Sprintf(`!!document.querySelector(%s)`, jsString(selector))
	if err := p.Eval(script, &ok); err != nil {
		return false, err
	}
	return ok, nil
}

// jsString renders a Go string as a safe JavaScript string literal. Every
// value interpolated into page-side JS goes through this — selector strings
// contain quotes and parentheses, and hand-rolled quoting would inject them
// into the script.
func jsString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

// stripCSSPrefix removes a leading "css:" marker some upstream selectors
// carry (e.g. "css:div.ds-markdown"). Those are plain CSS selectors in
// upstream too, so the marker is dropped rather than treated as part of the
// selector.
func stripCSSPrefix(sel string) string {
	return strings.TrimPrefix(strings.TrimSpace(sel), "css:")
}
