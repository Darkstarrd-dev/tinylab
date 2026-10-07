//go:build tray && webview && windows

package main

import (
	"sync"

	"fyne.io/systray"
	"github.com/tinylab/tinylab/internal/app"
	"github.com/tinylab/tinylab/internal/hotkey"
	"github.com/tinylab/tinylab/internal/petstate"
)

// addWebviewMenuItem adds the "开启/关闭控制台" toggle item to the tray menu:
// clicking opens the WebView2 console window when none is open, and closes it
// with plain window-close semantics (app keeps running in the tray) when one
// is. The app itself quits only via the tray Quit item, the UI Shutdown
// button, or an OS signal. The app does NOT auto-open a window at startup:
// tray-only is the default state.
//
// The "Open Console" systray global hotkey (Settings → Shortcut Settings →
// Systray, default Ctrl+Alt+Shift+T) triggers the same toggle — wired here
// because only the webview variant has a console window. On tray-only/console
// builds no handler is registered, and internal/hotkey then never registers
// that combo with the OS, leaving it free for other applications.
//
// Returns interface{} so the caller (host_tray_windows.go) stays build-tag-
// agnostic; the matching stub when `webview` is absent returns nil.
func addWebviewMenuItem(hctx *app.HostContext) interface{} {
	mToggle := systray.AddMenuItem("开启控制台", "打开管理界面窗口")
	trayWebviewItem = mToggle
	go runWebviewToggleLoop(hctx, mToggle)
	hotkey.SetActionHandler(hotkey.ActionOpenConsole, func() { toggleConsoleWindow(hctx) })
	applyTrayLang(currentTrayLang())
	go func() {
		<-hctx.Quit()
		hctx.Logger.Info("terminating webview windows (UI)")
		terminateAllWebviews()
	}()
	petstate.SetCloseAll(terminateAllPetWindows)
	petstate.SetOpen(func() { openPetIfNeeded(hctx) })
	petstate.SetHideAll(func() bool { return setPetWindowVisible(false) })
	petstate.SetShowAll(func() bool { return setPetWindowVisible(true) })
	return mToggle
}

// runWebviewToggleLoop dispatches "开启/关闭控制台" clicks by toggling the
// console window. Runs in its own goroutine since systray.Run is blocking the
// main goroutine.
func runWebviewToggleLoop(hctx *app.HostContext, m *systray.MenuItem) {
	for range m.ClickedCh {
		toggleConsoleWindow(hctx)
	}
}

// toggleConsoleWindow is the shared body of the tray toggle item and the
// "Open Console" systray global hotkey: open the console window when none is
// up, close all when one is. Window operations spawn their own goroutines so
// a wedged window can never park the caller (tray menu loop or hotkey pump).
func toggleConsoleWindow(hctx *app.HostContext) {
	if hasAnyWebview() {
		hctx.Logger.Info("console toggle: closing console window")
		// Independent goroutine: never park the menu loop on a wedged
		// window's Terminate (terminateAllWebviews has per-window timeouts).
		go terminateAllWebviews()
	} else {
		hctx.Logger.Info("console toggle: opening console window")
		go openWebviewWindow(hctx)
	}
}

// onWebviewCountChanged refreshes tray labels after a console window opened or
// closed so the toggle item reflects the new state ("开启控制台" vs "关闭控
// 制台"). Called from openWebviewWindow strictly outside webviewMu.
func onWebviewCountChanged() {
	applyTrayLang(currentTrayLang())
}

// Tray i18n: the host receives lang='en'|'cn' from JS via the setTrayLang
// binding (bound in host_webview_window.go; the injected init script pushes
// the document's data-lang on load and on every change), then updates every
// native menu title/tooltip. Language is process-local: after a restart the
// menu stays on "en" until a console window pushes the persisted UI language.
var trayLangMu sync.RWMutex

var trayLang = "en"

func currentTrayLang() string {
	trayLangMu.RLock()
	defer trayLangMu.RUnlock()
	if trayLang == "cn" {
		return "cn"
	}
	return "en"
}

func setTrayLang(lang string) {
	if lang != "cn" {
		lang = "en"
	}
	trayLangMu.Lock()
	trayLang = lang
	trayLangMu.Unlock()
}

// applyTrayLang rewrites every tray label for lang. The console toggle item is
// state-aware: a console window is open → "关闭控制台", none → "开启控制台".
func applyTrayLang(lang string) {
	cn := lang == "cn"
	if trayBrowserItem != nil {
		if cn {
			trayBrowserItem.SetTitle("开启浏览器")
			trayBrowserItem.SetTooltip("在浏览器中打开管理界面")
		} else {
			trayBrowserItem.SetTitle("Open Browser")
			trayBrowserItem.SetTooltip("Open the admin UI in your browser")
		}
	}
	if trayWebviewItem != nil {
		if hasAnyWebview() {
			if cn {
				trayWebviewItem.SetTitle("关闭控制台")
				trayWebviewItem.SetTooltip("关闭管理界面窗口（App 继续在托盘运行）")
			} else {
				trayWebviewItem.SetTitle("Close Console")
				trayWebviewItem.SetTooltip("Close the console window (app stays in tray)")
			}
		} else {
			if cn {
				trayWebviewItem.SetTitle("开启控制台")
				trayWebviewItem.SetTooltip("打开管理界面窗口")
			} else {
				trayWebviewItem.SetTitle("Open Console")
				trayWebviewItem.SetTooltip("Open the console window")
			}
		}
	}
	if trayQuitItem != nil {
		if cn {
			trayQuitItem.SetTitle("退出")
			trayQuitItem.SetTooltip("退出 TinyLab")
		} else {
			trayQuitItem.SetTitle("Quit")
			trayQuitItem.SetTooltip("Quit TinyLab")
		}
	}
}

var trayBrowserItem *systray.MenuItem

var trayWebviewItem *systray.MenuItem

var trayQuitItem *systray.MenuItem

func setTrayBrowserItem(m *systray.MenuItem) { trayBrowserItem = m; applyTrayLang(currentTrayLang()) }

func setTrayQuitItem(m *systray.MenuItem) { trayQuitItem = m; applyTrayLang(currentTrayLang()) }
