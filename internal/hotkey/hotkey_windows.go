//go:build windows

package hotkey

import (
	"runtime"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
)

// Win32 message constants used by the pump.
const (
	wmHotkey    = 0x0312     // WM_HOTKEY (wParam = hotkey id)
	wmAppReload = 0x8000 + 1 // WM_APP+1: re-read the desired registration set
	wmQuit      = 0x0012     // WM_QUIT: ends the GetMessage loop
)

// Fixed hotkey ids handed to RegisterHotKey / reported back via WM_HOTKEY.
const (
	idOpenBrowser = 1
	idOpenConsole = 2
)

var (
	user32                 = windows.NewLazySystemDLL("user32.dll")
	procRegisterHotKey     = user32.NewProc("RegisterHotKey")
	procUnregisterHotKey   = user32.NewProc("UnregisterHotKey")
	procGetMessageW        = user32.NewProc("GetMessageW")
	procPostThreadMessageW = user32.NewProc("PostThreadMessageW")
)

// msg mirrors Win32 MSG (x64 layout: hwnd, message+pad, wParam, lParam,
// time+pad, pt). RegisterHotKey with hWnd=NULL posts WM_HOTKEY to the
// *thread* message queue, so no window is needed — GetMessageW returns the
// thread message with hwnd == NULL.
type msg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
}

var (
	pumpThreadID atomic.Uint32 // owning thread, set after LockOSThread
	pumpRunning  atomic.Bool   // wakePump gates on this
)

// registered maps hotkey id → live registration. Confined to the pump thread
// (applyRegistrations / dispatch run there exclusively).
var registered = map[int]planEntry{}

// startPump spawns the hotkey message pump on a dedicated locked OS thread.
// RegisterHotKey is thread-affine: hotkeys are registered on this thread and
// WM_HOTKEY is delivered to this thread's queue, so every (un)registration
// must happen here — config changes are marshalled via WM_APP+1.
func startPump(logger *console.Logger) {
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		pumpThreadID.Store(windows.GetCurrentThreadId())
		// Mark the pump live BEFORE the first apply: any Set* call racing in
		// between stores its state and posts a reload message that the loop
		// below consumes, so no wake is ever lost.
		pumpRunning.Store(true)
		applyRegistrations(logger)

		var m msg
		for {
			r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
			// GetMessageW: >0 = message retrieved, 0 = WM_QUIT, -1 = error.
			if int32(r) <= 0 {
				break
			}
			switch m.message {
			case wmHotkey:
				if p, ok := registered[int(m.wParam)]; ok {
					if h := handlerFor(p.ActionID); h != nil {
						go h() // never block the pump on a handler
					}
				}
			case wmAppReload:
				applyRegistrations(logger)
			}
		}

		unregisterAll(logger)
		pumpRunning.Store(false)
		pumpThreadID.Store(0)
	}()
}

// stopPump asks the pump thread to exit via WM_QUIT (GetMessageW returns 0).
// Best effort: the OS also releases hotkeys when the process exits.
func stopPump() {
	if id := pumpThreadID.Load(); id != 0 {
		procPostThreadMessageW.Call(uintptr(id), wmQuit, 0, 0)
	}
}

// wakePump nudges the pump thread to reconcile the desired registration set.
// No-op while the pump is not live (state-only updates, e.g. unit tests).
func wakePump() {
	if !pumpRunning.Load() {
		return
	}
	if id := pumpThreadID.Load(); id != 0 {
		procPostThreadMessageW.Call(uintptr(id), wmAppReload, 0, 0)
	}
}

// applyRegistrations reconciles the live registration set with the desired
// plan: registers new/changed hotkeys, unregisters removed ones. Runs on the
// pump thread only.
func applyRegistrations(logger *console.Logger) {
	desired, skipped := registrationPlan()
	for _, reason := range skipped {
		logf(logger, false, "not registered: %s", reason)
	}
	keep := make(map[int]bool, len(desired))
	for _, p := range desired {
		id := hotkeyIDFor(p.ActionID)
		keep[id] = true
		if cur, ok := registered[id]; ok && cur.Mods == p.Mods && cur.VK == p.VK {
			continue // unchanged
		}
		if _, ok := registered[id]; ok {
			procUnregisterHotKey.Call(0, uintptr(id))
			delete(registered, id)
		}
		r, _, callErr := procRegisterHotKey.Call(0, uintptr(id), uintptr(p.Mods), uintptr(p.VK))
		if r == 0 {
			// Most common cause: the combo is already registered by another
			// application. Menu access keeps working; log and move on.
			logf(logger, true, "register failed for %s (%s likely owned by another app): %v",
				p.ActionID, bindingText(p), callErr)
			continue
		}
		registered[id] = p
		logf(logger, false, "registered %s → %s", p.ActionID, bindingText(p))
	}
	for id, cur := range registered {
		if !keep[id] {
			procUnregisterHotKey.Call(0, uintptr(id))
			delete(registered, id)
			logf(logger, false, "unregistered %s", cur.ActionID)
		}
	}
}

// unregisterAll releases every live hotkey (pump shutdown).
func unregisterAll(logger *console.Logger) {
	for id, cur := range registered {
		procUnregisterHotKey.Call(0, uintptr(id))
		delete(registered, id)
		logf(logger, false, "unregistered %s", cur.ActionID)
	}
}

func hotkeyIDFor(actionID string) int {
	if actionID == ActionOpenConsole {
		return idOpenConsole
	}
	return idOpenBrowser
}

// bindingText renders the combo for logs, e.g. "Ctrl+Alt+Shift+T".
func bindingText(p planEntry) string {
	return formatBinding(config.ShortcutBinding{
		Key:       p.Key,
		CtrlOrCmd: p.Mods&modControl != 0,
		Alt:       p.Mods&modAlt != 0,
		Shift:     p.Mods&modShift != 0,
	})
}
