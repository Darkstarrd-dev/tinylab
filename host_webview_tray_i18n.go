//go:build tray && webview && windows

package main

import (
	"sync"
	"time"

	"fyne.io/systray"
	"github.com/tinylab/tinylab/internal/app"
	"github.com/tinylab/tinylab/internal/petstate"
)

// addWebviewMenuItem adds a "重新打开独立窗口" item to the tray menu; each click
// terminates every open window first, then rebuilds one. Only compiled when the
// `webview` build tag is set.
//
// Returns interface{} so the caller (host_tray_windows.go) stays build-tag-
// agnostic; the matching stub when `webview` is absent returns nil.
func addWebviewMenuItem(hctx *app.HostContext) interface{} {
	// “打开独立窗口”已无意义：关闭窗口的 X 现在就是退出（w.Run 后 systray.Quit 带动
	// 整个进程退出），仅关窗不退出的旧前后端解耦语义已失效，故移除该条目。
	mRestart := systray.AddMenuItem("重新打开独立窗口", "当窗口卡死或已关闭时重新打开")
	trayRestartItem = mRestart
	go runWebviewRestartLoop(hctx, mRestart)
	applyTrayLang(currentTrayLang())
	go openWebviewAfterReady(hctx)
	go func() {
		<-hctx.Quit()
		hctx.Logger.Info("terminating webview windows (UI)")
		terminateAllWebviews()
	}()
	petstate.SetCloseAll(terminateAllPetWindows)
	petstate.SetOpen(func() { openPetIfNeeded(hctx) })
	petstate.SetHideAll(func() bool { return setPetWindowVisible(false) })
	petstate.SetShowAll(func() bool { return setPetWindowVisible(true) })
	return mRestart
}

func runWebviewRestartLoop(hctx *app.HostContext, m *systray.MenuItem) {
	for range m.ClickedCh {
		hctx.Logger.Info("tray: reopen/recover webview — kill current then respawn")
		// 独立 goroutine：绝不把托盘线程堵在卡死窗口的 Terminate 上
		go func() {
			// 无论是否有窗口，先终止一切（有则消、无则空）。Terminate 本身带超时。
			terminateAllWebviews()
			// 等待窗体 pump 退出后再 respawn，避免 CreateWindow 与 WM_DESTROY 竞争。
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) && hasAnyWebview() {
				time.Sleep(80 * time.Millisecond)
			}
			go openWebviewWindow(hctx)
		}()
	}
}

// Tray i18n: the host receives lang='en'|'cn' from JS via the onTrayLang binding
// (called from i18n.js setLang), then updates every native menu title/tooltip.
// Persist last lang so new windows started after a language switch get the right labels.

// Tray i18n: the host receives lang='en'|'cn' from JS via the onTrayLang binding
// (called from i18n.js setLang), then updates every native menu title/tooltip.
// Persist last lang so new windows started after a language switch get the right labels.
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

func applyTrayLang(lang string) {
	cn := lang == "cn"
	if trayRestartItem != nil {
		if cn {
			trayRestartItem.SetTitle("重新打开独立窗口")
			trayRestartItem.SetTooltip("当窗口卡死或已关闭时重新打开")
		} else {
			trayRestartItem.SetTitle("Reopen Window")
			trayRestartItem.SetTooltip("Reopen the independent window")
		}
	}
	if trayConsoleItem != nil {
		if cn {
			trayConsoleItem.SetTitle("打开控制台")
			trayConsoleItem.SetTooltip("在浏览器中打开管理界面")
		} else {
			trayConsoleItem.SetTitle("Open Console")
			trayConsoleItem.SetTooltip("Open the admin UI in your browser")
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

var trayRestartItem *systray.MenuItem

var trayConsoleItem *systray.MenuItem

var trayQuitItem *systray.MenuItem

func setTrayConsoleItem(m *systray.MenuItem) { trayConsoleItem = m; applyTrayLang(currentTrayLang()) }

func setTrayQuitItem(m *systray.MenuItem) { trayQuitItem = m; applyTrayLang(currentTrayLang()) }

// Helpers restored (no tray button, but still needed for settings toggle callbacks).
