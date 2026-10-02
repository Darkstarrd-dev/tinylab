package webhub

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// fakePage is an in-memory Page used to exercise the workflow engine and the
// incremental watcher without a browser. It models the two behaviours that
// broke the P0 prototype: a React-controlled input that only accepts writes
// through the native setter, and a reply node that gets replaced/rewound
// mid-stream.
type fakePage struct {
	mu sync.Mutex

	// selectors present on the "page".
	elements map[string]bool
	// texts is the current text per selector.
	texts map[string]string
	// values is the current input value per selector (mirrors el.value).
	values map[string]string

	// clickFails makes Click fail for the given selectors.
	clickFails map[string]bool
	// clickDelay delays Click (to exercise the optional-step bound).
	clickDelay time.Duration

	// clicks records clicked selectors in order.
	clicks []string
	// presses counts Enter presses.
	presses int
	// scripts records every evaluated script (for injection assertions).
	scripts []string

	// scripted drives the reply text when set: each entry is appended to the
	// result container on the next Text() call.
	scripted []string
	// scriptIdx is the next scripted entry to apply.
	scriptIdx int
}

func newFakePage() *fakePage {
	return &fakePage{
		elements:   map[string]bool{},
		texts:      map[string]string{},
		values:     map[string]string{},
		clickFails: map[string]bool{},
	}
}

func (f *fakePage) add(sel string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.elements[sel] = true
}

func (f *fakePage) setText(sel, text string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.elements[sel] = true
	f.texts[sel] = text
}

func (f *fakePage) Eval(script string, out any) error {
	f.mu.Lock()
	f.scripts = append(f.scripts, script)
	// Advance the scripted reply only on result-container reads: that is the
	// poll the watcher performs, and it models the page growing BETWEEN polls
	// (a read-back of the input must not advance the reply).
	if strings.Contains(script, "querySelectorAll") {
		sel, _ := extractJSArg(script, 0)
		if f.scriptIdx < len(f.scripted) && sel == "result" {
			f.texts["result"] = f.texts["result"] + f.scripted[f.scriptIdx]
			f.elements["result"] = true
			f.scriptIdx++
		}
	}
	f.mu.Unlock()

	switch {
	case strings.Contains(script, "Object.getOwnPropertyDescriptor"):
		// Native-setter write: the value lands verbatim (this is the whole
		// point of the fix — a value written through the setter is kept).
		sel, _ := extractJSArg(script, 0)
		txt, _ := extractJSArg(script, 1)
		f.mu.Lock()
		_, known := f.elements[sel]
		f.mu.Unlock()
		if !known {
			return setString(out, "no-element")
		}
		f.mu.Lock()
		f.values[sel] = txt
		f.texts[sel] = txt
		f.mu.Unlock()
		return setString(out, "ok")
	case strings.Contains(script, "insertText"):
		// contenteditable branch: extract and store the text.
		if txt, ok := extractJSArg(script, 1); ok {
			f.mu.Lock()
			f.elements["editor"] = true
			f.texts["editor"] += txt
			f.mu.Unlock()
		}
		return setString(out, "ok")
	case strings.Contains(script, "el.value"):
		// Value read-back.
		sel, _ := extractJSArg(script, 0)
		f.mu.Lock()
		v := f.values[sel]
		f.mu.Unlock()
		return setString(out, v)
	case strings.Contains(script, "querySelectorAll"):
		sel, _ := extractJSArg(script, 0)
		f.mu.Lock()
		v := f.texts[sel]
		f.mu.Unlock()
		return setString(out, v)
	case strings.Contains(script, "!!document.querySelector"):
		sel, _ := extractJSArg(script, 0)
		f.mu.Lock()
		v := f.elements[sel]
		f.mu.Unlock()
		return setBool(out, v)
	case strings.Contains(script, "return 'ok'"):
		// PressEnter on a fake page.
		f.mu.Lock()
		f.presses++
		f.mu.Unlock()
		return setString(out, "ok")
	}
	return setString(out, "")
}

func (f *fakePage) Click(sel string) error {
	if f.clickDelay > 0 {
		time.Sleep(f.clickDelay)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clicks = append(f.clicks, sel)
	if f.clickFails[sel] {
		return fmt.Errorf("fake: click %s failed", sel)
	}
	if !f.elements[sel] {
		return fmt.Errorf("fake: no element %s", sel)
	}
	return nil
}

func (f *fakePage) WaitVisible(sel string, timeout time.Duration) error {
	f.mu.Lock()
	ok := f.elements[sel]
	f.mu.Unlock()
	if ok {
		return nil
	}
	time.Sleep(timeout)
	return fmt.Errorf("fake: %s not visible", sel)
}

func (f *fakePage) Text(sel string) (string, error) {
	// Route through Eval so scripted growth advances (the real page grows
	// between polls too).
	var out string
	if err := f.Eval(fmt.Sprintf(`(function(){var els=document.querySelectorAll(%s);return els[els.length-1].innerText||''})()`, jsString(sel)), &out); err != nil {
		return "", err
	}
	return out, nil
}

func (f *fakePage) Exists(sel string) (bool, error) {
	var ok bool
	if err := f.Eval(fmt.Sprintf(`!!document.querySelector(%s)`, jsString(sel)), &ok); err != nil {
		return false, err
	}
	return ok, nil
}

func setString(out any, v string) error {
	if out == nil {
		return nil
	}
	p, ok := out.(*string)
	if !ok {
		return nil
	}
	*p = v
	return nil
}

func setBool(out any, v bool) error {
	if out == nil {
		return nil
	}
	p, ok := out.(*bool)
	if !ok {
		return nil
	}
	*p = v
	return nil
}

// extractJSArg pulls the nth JSON-string-literal argument out of a generated
// script. It is deliberately naive: it only has to work on the scripts this
// package generates, which always pass JSON-encoded string literals.
func extractJSArg(script string, n int) (string, bool) {
	var vals []string
	in := false
	esc := false
	var cur strings.Builder
	for i := 0; i < len(script); i++ {
		c := script[i]
		if !in {
			if c == '"' {
				in = true
				cur.Reset()
			}
			continue
		}
		if esc {
			cur.WriteByte(c)
			esc = false
			continue
		}
		if c == '\\' {
			cur.WriteByte(c)
			esc = true
			continue
		}
		if c == '"' {
			vals = append(vals, cur.String())
			in = false
			continue
		}
		cur.WriteByte(c)
	}
	if n >= len(vals) {
		return "", false
	}
	return unescapeJSONString(vals[n]), true
}

// unescapeJSONString decodes the handful of escapes json.Marshal emits for
// our data (quotes, backslash, \n, \t, \r, \uXXXX). Keeping it local avoids
// depending on encoding/json's unexported helpers.
func unescapeJSONString(v string) string {
	var sb strings.Builder
	for i := 0; i < len(v); i++ {
		c := v[i]
		if c != '\\' || i+1 >= len(v) {
			sb.WriteByte(c)
			continue
		}
		i++
		switch v[i] {
		case 'n':
			sb.WriteByte('\n')
		case 't':
			sb.WriteByte('\t')
		case 'r':
			sb.WriteByte('\r')
		case 'b':
			sb.WriteByte('\b')
		case 'f':
			sb.WriteByte('\f')
		case '"':
			sb.WriteByte('"')
		case '\\':
			sb.WriteByte('\\')
		case '/':
			sb.WriteByte('/')
		case 'u':
			if i+4 < len(v) {
				var r rune
				if _, err := fmt.Sscanf(v[i+1:i+5], "%04x", &r); err == nil {
					sb.WriteRune(r)
					i += 4
					continue
				}
			}
			sb.WriteByte('\\')
		default:
			sb.WriteByte('\\')
			sb.WriteByte(v[i])
		}
	}
	return sb.String()
}
