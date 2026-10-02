package webhub

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/chromedp/chromedp"
)

// ErrInputTruncated is returned when the page-side input element does not end
// up holding the full prompt. It is a hard failure: sending a truncated prompt
// silently produces an answer to a different question, which is worse than
// erroring out.
var ErrInputTruncated = errors.New("webhub: prompt was truncated by the page")

// insertTextScript is the page-side text injection used for FILL_INPUT.
//
// ⚠️ P0 DEFECT ① (observed on a real site): chromedp.SendKeys dispatches
// per-character key events, which React-controlled inputs coalesce or drop —
// a 31-character prompt arrived as a lone "\n". The fix is to write through
// the NATIVE value setter (the same one React's own change tracking hooks)
// and then dispatch real input/change events so the framework's onChange
// fires and the component state matches the DOM.
//
// The setter is resolved from the element's actual prototype chain (textarea →
// HTMLTextAreaElement, input → HTMLInputElement, else the generic
// HTMLElement/Node value setter) because a contenteditable div needs a
// different write path entirely (below).
//
// ⚠️ 缺陷 23（2026-10-03 用户实测）：注入脚本曾写成 `setter.call(el, text)`，
// 而 setter 是 `Object.getOwnPropertyDescriptor` 返回的 **PropertyDescriptor**
// （{get, set, ...}）不是函数——页面侧直接抛 `TypeError: setter.call is not
// a function`，deepseek/arena.ai 等所有 textarea/input 站点在 FILL_INPUT
// 第一步就死。正确写法是取描述符里的 `.set` 再 call。回归守卫：
// `TestInsertScriptUsesDescriptorSetter`（脚本静态断言）+ `FillInput` 两个
// 用例（fakePage 只对含 `setter.set.call` 的脚本承认写入成功）。
const insertTextScript = `(function(sel, text){
	var el = document.querySelector(sel);
	if (!el) return 'no-element';
	var tag = (el.tagName || '').toLowerCase();
	if (el.isContentEditable) {
		el.focus();
		var selObj = window.getSelection();
		var range = document.createRange();
		range.selectNodeContents(el);
		selObj.removeAllRanges();
		selObj.addRange(range);
		document.execCommand('insertText', false, text);
		el.dispatchEvent(new Event('input', {bubbles:true}));
		return 'ok';
	}
	var proto = null;
	if (tag === 'textarea') proto = window.HTMLTextAreaElement.prototype;
	else if (tag === 'input') proto = window.HTMLInputElement.prototype;
	else if (window.HTMLElement && el instanceof window.HTMLElement) proto = window.HTMLElement.prototype;
	var setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
	if (!setter || !setter.set) return 'no-setter';
	setter.set.call(el, text);
	el.dispatchEvent(new Event('input', {bubbles:true}));
	el.dispatchEvent(new Event('change', {bubbles:true}));
	return 'ok';
})(%s, %s)`

// readValueScript reads back an input's current value (textarea/input) or text
// content (contenteditable), used to verify the write actually landed.
const readValueScript = `(function(sel){
	var el = document.querySelector(sel);
	if (!el) return '';
	if (el.isContentEditable) return el.innerText || el.textContent || '';
	return String(el.value || '');
})(%s)`

// FillInput writes text into the element matching selector and VERIFIES the
// page actually holds it.
//
// The verification is not optional and not a debug aid: it is the only signal
// that a React-controlled input accepted the write. A length check
// (len(got) >= len(want)) rather than equality is deliberate — some sites
// normalize whitespace or append a zero-width marker, and rejecting those
// would break working sites.
func FillInput(page Page, selector, text string) error {
	sel := stripCSSPrefix(selector)
	if sel == "" {
		return fmt.Errorf("webhub: fill: empty selector")
	}
	var res string
	script := fmt.Sprintf(insertTextScript, jsString(sel), jsString(text))
	if err := page.Eval(script, &res); err != nil {
		return fmt.Errorf("webhub: fill: %w", err)
	}
	switch res {
	case "ok":
	case "no-element":
		return fmt.Errorf("webhub: fill: no element matches %q", sel)
	case "no-setter":
		return fmt.Errorf("webhub: fill: no native value setter for %q", sel)
	default:
		return fmt.Errorf("webhub: fill: %s", res)
	}

	var got string
	if err := page.Eval(fmt.Sprintf(readValueScript, jsString(sel)), &got); err != nil {
		return fmt.Errorf("webhub: fill verify: %w", err)
	}
	if len(got) < len(text) {
		return fmt.Errorf("%w: got %d of %d chars", ErrInputTruncated, len(got), len(text))
	}
	return nil
}

// PressEnter sends a real Enter key to the focused element. It is the send
// mechanism for sites whose workflow declares KEY_PRESS Enter (the alternative
// is CLICK send_btn).
//
// chromedp.KeyEvent inserts "\r" — a real Enter keydown/keyup pair, not a
// synthetic click, so sites that listen for Enter (and auto-grow textareas)
// behave as they do for a human.
// pressEnterFn is the CDP key dispatch hook (injected in tests).
var pressEnterFn = func(page Page) error {
	cp, ok := page.(*chromedpPage)
	if !ok {
		// Fake/test pages: Enter only needs to be observed by the driver's
		// fake page, which reacts to it in Eval.
		return page.Eval(`(function(){return 'ok'})()`, nil)
	}
	return chromedp.Run(cp.ctx, chromedp.KeyEvent("\r"))
}

func PressEnter(page Page) error {
	if err := pressEnterFn(page); err != nil {
		return fmt.Errorf("webhub: press enter: %w", err)
	}
	return nil
}

// WaitVisible waits for an element to appear, bounded by timeout.
func WaitVisible(page Page, selector string, timeout time.Duration) error {
	return page.WaitVisible(stripCSSPrefix(selector), timeout)
}

// ElementExists reports whether a selector matches anything.
func ElementExists(page Page, selector string) (bool, error) {
	sel := stripCSSPrefix(selector)
	if sel == "" {
		return false, nil
	}
	return page.Exists(sel)
}

// normalizeText collapses the whitespace a rendered page produces so deltas
// compare stably (markdown re-renders routinely change whitespace without
// changing content).
func normalizeText(s string) string {
	return strings.TrimRight(strings.TrimSpace(s), "\n")
}
