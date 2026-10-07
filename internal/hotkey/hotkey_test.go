package hotkey

import (
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

// resetState clears the package-level state between tests. Never calls
// Start(), so no real OS hotkey is registered by these tests.
func resetState(t *testing.T) {
	t.Helper()
	mu.Lock()
	defer mu.Unlock()
	overrides = make(map[string]config.ShortcutBinding)
	handlers = make(map[string]func())
	started = false
}

// TestDefaultBindingsMatchSpec locks the two systray defaults
// (Ctrl+Shift+T / Ctrl+Alt+Shift+T). They must stay in sync with
// SHORTCUT_PRESETS.systray in web/static/shortcuts.js — web/systray-shortcuts.test.js
// guards the same mirror from the frontend side.
func TestDefaultBindingsMatchSpec(t *testing.T) {
	want := map[string]config.ShortcutBinding{
		ActionOpenBrowser: {Key: "t", CtrlOrCmd: true, Shift: true},
		ActionOpenConsole: {Key: "t", CtrlOrCmd: true, Alt: true, Shift: true},
	}
	for id, w := range want {
		if got := defaultBindings[id]; got != w {
			t.Errorf("defaultBindings[%s] = %+v, want %+v", id, got, w)
		}
	}
}

func TestVirtualKey(t *testing.T) {
	cases := []struct {
		in   string
		want uint32
		ok   bool
	}{
		{"t", 0x54, true},
		{"T", 0x54, true},
		{"5", 0x35, true},
		{"F5", 0x74, true},
		{"f24", 0x87, true},
		{"F25", 0, false},
		{"Escape", 0x1B, true},
		{"esc", 0x1B, true},
		{"Enter", 0x0D, true},
		{" ", 0x20, true},
		{"Space", 0x20, true},
		{"Tab", 0x09, true},
		{"ArrowLeft", 0x25, true},
		{"Home", 0x24, true},
		{"Delete", 0x2E, true},
		{"", 0, false},
		{"   ", 0, false},
		{"日", 0, false},
		{"Ctrl", 0, false},
	}
	for _, c := range cases {
		got, ok := virtualKey(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("virtualKey(%q) = (%d, %v), want (%d, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestBindingMods(t *testing.T) {
	mods, ok := bindingMods(config.ShortcutBinding{Key: "t", CtrlOrCmd: true, Shift: true})
	if !ok || mods != modControl|modShift|modNoRepeat {
		t.Errorf("ctrl+shift = (%x, %v), want (%x, true)", mods, ok, modControl|modShift|modNoRepeat)
	}
	mods, ok = bindingMods(config.ShortcutBinding{Key: "t", CtrlOrCmd: true, Alt: true, Shift: true})
	if !ok || mods != modControl|modAlt|modShift|modNoRepeat {
		t.Errorf("ctrl+alt+shift = (%x, %v), want (%x, true)", mods, ok, modControl|modAlt|modShift|modNoRepeat)
	}
	// A bare key without any modifier must be rejected: registering it would
	// swallow the key system-wide for every application.
	if _, ok := bindingMods(config.ShortcutBinding{Key: "t"}); ok {
		t.Error("bare-key combo must be rejected")
	}
}

// TestRegistrationPlanHandlerlessActionsNotRegistered verifies the "don't
// steal system-wide combos for actions we can't fire" rule (e.g. Open Console
// on tray-only/console builds where no console window exists).
func TestRegistrationPlanHandlerlessActionsNotRegistered(t *testing.T) {
	resetState(t)
	desired, skipped := registrationPlan()
	if len(desired) != 0 {
		t.Fatalf("no handlers registered, desired = %+v", desired)
	}
	if len(skipped) != len(actionIDs) {
		t.Fatalf("expected %d skip reasons, got %v", len(actionIDs), skipped)
	}

	SetActionHandler(ActionOpenBrowser, func() {})
	desired, _ = registrationPlan()
	if len(desired) != 1 || desired[0].ActionID != ActionOpenBrowser {
		t.Fatalf("only the browser action should be planned, got %+v", desired)
	}
	// Default binding: Ctrl+Shift+T.
	if desired[0].VK != 0x54 || desired[0].Mods != modControl|modShift|modNoRepeat {
		t.Errorf("default plan entry = %+v", desired[0])
	}
}

func TestRegistrationPlanOverridesAndInvalidKeys(t *testing.T) {
	resetState(t)
	SetActionHandler(ActionOpenBrowser, func() {})
	SetActionHandler(ActionOpenConsole, func() {})
	SetBindings(config.ShortcutsConfig{
		ActionOpenBrowser: {Key: "F9", CtrlOrCmd: true},
		ActionOpenConsole: {Key: "〇", CtrlOrCmd: true},
		// Non-systray entries must be ignored entirely.
		"global.goto-monitor": {Key: "x", CtrlOrCmd: true},
	})
	desired, skipped := registrationPlan()
	if len(desired) != 1 || desired[0].ActionID != ActionOpenBrowser {
		t.Fatalf("want only the overridden browser entry, got %+v (skipped=%v)", desired, skipped)
	}
	if desired[0].VK != 0x78 { // VK_F9 (VK_F1=0x70 + 8)
		t.Errorf("override VK = %x, want F9 (0x78)", desired[0].VK)
	}
	if len(skipped) != 1 || skipped[0] != ActionOpenConsole+": unbindable key \"〇\"" {
		t.Errorf("console action should be skipped for the unbindable key, got %v", skipped)
	}
}

func TestSetBindingsResetsToDefaultsOnEmpty(t *testing.T) {
	resetState(t)
	SetActionHandler(ActionOpenBrowser, func() {})
	SetBindings(config.ShortcutsConfig{ActionOpenBrowser: {Key: "F9", CtrlOrCmd: true}})
	SetBindings(nil) // e.g. user cleared all overrides → back to preset
	desired, _ := registrationPlan()
	if len(desired) != 1 || desired[0].VK != 0x54 || desired[0].Mods != modControl|modShift|modNoRepeat {
		t.Errorf("empty override map must fall back to defaults, got %+v", desired)
	}
}

func TestHandlerFor(t *testing.T) {
	resetState(t)
	if handlerFor(ActionOpenBrowser) != nil {
		t.Error("no handler expected initially")
	}
	called := false
	SetActionHandler(ActionOpenBrowser, func() { called = true })
	handlerFor(ActionOpenBrowser)()
	if !called {
		t.Error("handler not invoked")
	}
	SetActionHandler(ActionOpenBrowser, nil)
	if handlerFor(ActionOpenBrowser) != nil {
		t.Error("nil handler should remove the slot")
	}
	SetActionHandler("unknown.action", func() {}) // unknown ids are ignored
}

func TestFormatBinding(t *testing.T) {
	cases := []struct {
		in   config.ShortcutBinding
		want string
	}{
		{config.ShortcutBinding{Key: "t", CtrlOrCmd: true, Shift: true}, "Ctrl+Shift+T"},
		{config.ShortcutBinding{Key: "t", CtrlOrCmd: true, Alt: true, Shift: true}, "Ctrl+Alt+Shift+T"},
		{config.ShortcutBinding{Key: "F5", CtrlOrCmd: true}, "Ctrl+F5"},
		{config.ShortcutBinding{Key: " "}, "Space"},
	}
	for _, c := range cases {
		if got := formatBinding(c.in); got != c.want {
			t.Errorf("formatBinding(%+v) = %q, want %q", c.in, got, c.want)
		}
	}
}
