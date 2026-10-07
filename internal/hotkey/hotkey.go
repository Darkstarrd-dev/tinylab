// Package hotkey registers the systray **system-wide global hotkeys**
// (Settings → Shortcut Settings → Systray) with the OS and dispatches them to
// host actions. Like petstate, it exists to break an import cycle: the
// settings API (which persists overrides), the app package (which wires the
// browser action) and package main (which wires the console-window toggle)
// all import it, and it depends only on leaf packages.
//
// Two actions are supported (action IDs mirror the `systray` region in
// web/static/shortcuts.js):
//
//	systray.open-browser — open the admin UI in the default browser
//	systray.open-console — open/close the WebView2 console window
//
// Semantics:
//   - Effective binding = user override from config.yaml (`shortcuts` map)
//     when present, else the built-in default (mirrored from the frontend
//     presets — see defaultBindings).
//   - Windows only: RegisterHotKey on a dedicated locked-OS-thread message
//     pump (hotkey_windows.go). Everywhere else Start/Stop are no-ops.
//   - An action without a registered handler is never registered with the OS,
//     so its combo stays free for other applications (e.g. Open Console on
//     builds without the WebView console window).
//   - Without Start(), SetBindings/SetActionHandler only update state — unit
//     tests never touch the real OS hotkey table.
package hotkey

import (
	"strconv"
	"strings"
	"sync"

	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
)

// Win32 RegisterHotKey modifier flags (fixed ABI values; kept here so the
// binding→flags computation is platform-independent and unit-testable).
const (
	modAlt      uint32 = 0x0001
	modControl  uint32 = 0x0002
	modShift    uint32 = 0x0004
	modNoRepeat uint32 = 0x4000
)

// Systray action IDs — must match SHORTCUT_PRESETS.systray in
// web/static/shortcuts.js (guarded by web/systray-shortcuts.test.js).
const (
	ActionOpenBrowser = "systray.open-browser"
	ActionOpenConsole = "systray.open-console"
)

// actionIDs is the stable registration/dispatch order (browser first).
var actionIDs = []string{ActionOpenBrowser, ActionOpenConsole}

// defaultBindings mirror SHORTCUT_PRESETS.systray in web/static/shortcuts.js.
// The frontend owns preset display; the Go side needs the same defaults to
// register the hotkey when no user override exists. Keep both in sync —
// web/systray-shortcuts.test.js guards the mirror.
var defaultBindings = map[string]config.ShortcutBinding{
	ActionOpenBrowser: {Key: "t", CtrlOrCmd: true, Shift: true},
	ActionOpenConsole: {Key: "t", CtrlOrCmd: true, Alt: true, Shift: true},
}

var (
	mu        sync.Mutex
	overrides map[string]config.ShortcutBinding // actionID -> user override (config.yaml `shortcuts`)
	handlers  map[string]func()                 // actionID -> dispatch callback
	started   bool                              // Start() has been called (pump may or may not be live yet)
)

func init() {
	overrides = make(map[string]config.ShortcutBinding)
	handlers = make(map[string]func())
}

// SetBindings applies the systray shortcut overrides from config.yaml. Called
// at startup (app.Run) and from the settings convergence path after every
// PATCH /api/settings and POST /api/reload, so rebinding takes effect without
// a restart. Entries for non-systray action IDs are ignored; an empty/nil map
// resets both actions to their defaults.
func SetBindings(sc config.ShortcutsConfig) {
	next := make(map[string]config.ShortcutBinding)
	for id, b := range sc {
		if id == ActionOpenBrowser || id == ActionOpenConsole {
			next[id] = b
		}
	}
	mu.Lock()
	overrides = next
	mu.Unlock()
	wakePump()
}

// SetActionHandler registers the callback fired when the global hotkey for
// actionID triggers. The callback runs on its own goroutine (never on the
// message-pump thread). Registering a handler may register the OS hotkey; nil
// removes the handler and unregisters the hotkey on the next reconcile.
func SetActionHandler(actionID string, fn func()) {
	if actionID != ActionOpenBrowser && actionID != ActionOpenConsole {
		return
	}
	mu.Lock()
	if fn == nil {
		delete(handlers, actionID)
	} else {
		handlers[actionID] = fn
	}
	mu.Unlock()
	wakePump()
}

// Start launches the platform hotkey pump. Idempotent and intended to be
// called once during app startup. Until Start, SetBindings/SetActionHandler
// only update state (so unit tests never register real OS hotkeys).
func Start(logger *console.Logger) {
	mu.Lock()
	if started {
		mu.Unlock()
		return
	}
	started = true
	mu.Unlock()
	startPump(logger)
}

// Stop shuts the pump down (best effort; the OS also releases registered
// hotkeys when the process exits). Safe to call unconditionally.
func Stop() {
	mu.Lock()
	if !started {
		mu.Unlock()
		return
	}
	mu.Unlock()
	stopPump()
}

// planEntry is one desired OS hotkey registration. Key keeps the original
// frontend key name (e.g. "t", "F5") for log rendering.
type planEntry struct {
	ActionID string
	Mods     uint32
	VK       uint32
	Key      string
}

// registrationPlan computes the desired registration set: every systray
// action that (a) has a handler and (b) resolves to a registrable key combo.
// Returns the plan in stable order plus human-readable skip reasons for
// logging. Reads state under mu.
func registrationPlan() (desired []planEntry, skipped []string) {
	mu.Lock()
	defer mu.Unlock()
	for _, id := range actionIDs {
		if handlers[id] == nil {
			// Normal on builds without the console window (tray-only /
			// console hosts): the combo intentionally stays free.
			skipped = append(skipped, id+": no action handler registered")
			continue
		}
		b, ok := overrides[id]
		if !ok {
			b = defaultBindings[id]
		}
		vk, ok := virtualKey(b.Key)
		if !ok {
			skipped = append(skipped, id+": unbindable key "+strconv.Quote(b.Key))
			continue
		}
		mods, ok := bindingMods(b)
		if !ok {
			skipped = append(skipped, id+": combo has no modifier (a bare key would be swallowed system-wide)")
			continue
		}
		desired = append(desired, planEntry{ActionID: id, Mods: mods, VK: vk, Key: b.Key})
	}
	return desired, skipped
}

// bindingMods maps a ShortcutBinding onto RegisterHotKey modifier flags.
// CtrlOrCmd is Ctrl here: global hotkeys are Windows-only and on Windows
// CtrlOrCmd always means Ctrl. A combo with no modifier at all is rejected —
// registering a bare key would swallow it system-wide for every application.
func bindingMods(b config.ShortcutBinding) (uint32, bool) {
	var mods uint32 = modNoRepeat
	any := false
	if b.CtrlOrCmd {
		mods |= modControl
		any = true
	}
	if b.Alt {
		mods |= modAlt
		any = true
	}
	if b.Shift {
		mods |= modShift
		any = true
	}
	return mods, any
}

// virtualKey resolves a frontend e.key value (ShortcutBinding.Key) to a Win32
// virtual-key code. Recognizes letters, digits, F1-F24 and common named keys;
// anything else is rejected and the hotkey is skipped (logged, never fatal).
func virtualKey(key string) (uint32, bool) {
	// The literal space key (" ") must be checked before any trimming.
	if key == " " {
		return 0x20, true
	}
	k := strings.ToLower(strings.TrimSpace(key))
	if k == "" {
		return 0, false
	}
	// Single characters: e.key may be lower- or upper-case (Shift state).
	runes := []rune(k)
	if len(runes) == 1 {
		c := runes[0]
		switch {
		case c >= 'a' && c <= 'z':
			return uint32(c-'a') + 0x41, true // VK_A..VK_Z
		case c >= '0' && c <= '9':
			return uint32(c-'0') + 0x30, true // VK_0..VK_9
		}
	}
	switch k {
	case "space":
		return 0x20, true
	case "enter", "return":
		return 0x0D, true
	case "escape", "esc":
		return 0x1B, true
	case "tab":
		return 0x09, true
	case "backspace":
		return 0x08, true
	case "delete", "del":
		return 0x2E, true
	case "insert", "ins":
		return 0x2D, true
	case "home":
		return 0x24, true
	case "end":
		return 0x23, true
	case "pageup":
		return 0x21, true
	case "pagedown":
		return 0x22, true
	case "arrowleft", "left":
		return 0x25, true
	case "arrowup", "up":
		return 0x26, true
	case "arrowright", "right":
		return 0x27, true
	case "arrowdown", "down":
		return 0x28, true
	}
	// F1..F24 → VK_F1 (0x70) .. VK_F24 (0x87).
	if len(k) > 1 && k[0] == 'f' {
		if n, err := strconv.Atoi(k[1:]); err == nil && n >= 1 && n <= 24 {
			return uint32(0x70 + n - 1), true
		}
	}
	return 0, false
}

// formatBinding renders a binding like the frontend (Ctrl+Alt+Shift+T) for
// logs.
func formatBinding(b config.ShortcutBinding) string {
	var parts []string
	if b.CtrlOrCmd {
		parts = append(parts, "Ctrl")
	}
	if b.Alt {
		parts = append(parts, "Alt")
	}
	if b.Shift {
		parts = append(parts, "Shift")
	}
	key := strings.ToUpper(b.Key)
	if key == " " {
		key = "Space"
	}
	parts = append(parts, key)
	return strings.Join(parts, "+")
}

// handlerFor returns a copy of the handler slot for actionID (safe to invoke
// outside mu).
func handlerFor(actionID string) func() {
	mu.Lock()
	h := handlers[actionID]
	mu.Unlock()
	return h
}

// logf writes through the injected console logger; nil logger (unit tests)
// discards.
func logf(logger *console.Logger, warn bool, format string, args ...any) {
	if logger == nil {
		return
	}
	if warn {
		logger.Warn("[hotkey] "+format, args...)
		return
	}
	logger.Info("[hotkey] "+format, args...)
}
