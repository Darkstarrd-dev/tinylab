//go:build tray && webview && windows

package main

import (
	"net/url"
	"os"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"fyne.io/systray"
	"github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/pkg/edge"
	"github.com/tinyrouter/tinyrouter/internal/app"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
	"golang.org/x/sys/windows"
)

// addWebviewMenuItem adds an "打开独立窗口" item to the tray menu and wires its
// click channel to launch a native WebView2 window per click. Only compiled when
// the `webview` build tag is set.
//
// Returns interface{} so the caller (host_tray_windows.go) stays build-tag-
// agnostic; the matching stub when `webview` is absent returns nil.
func addWebviewMenuItem(hctx *app.HostContext) interface{} {
	m := systray.AddMenuItem("打开独立窗口", "Open TinyRouter UI in a native WebView2 window")
	go runWebviewClickLoop(hctx, m)

	mPet := systray.AddMenuItem("释放桌面小精灵", "Open desktop pet assistant")
	go runPetClickLoop(hctx, mPet)

	// Auto-open the native window once at startup (independent of the click loop).
	go openWebviewAfterReady(hctx)

	// On UI shutdown, terminate all open native windows immediately so they
	// close at once instead of waiting for the user to close each one. Each
	// window's Run() returns on Terminate and its deferred cleanup unregisters
	// it and calls systray.Quit(); the existing tray Quit listener also quits
	// systray, so both paths are idempotent.
	go func() {
		<-hctx.Quit()
		hctx.Logger.Info("terminating webview windows (UI)")
		terminateAllWebviews()
	}()

	return m
}

func runPetClickLoop(hctx *app.HostContext, m *systray.MenuItem) {
	for range m.ClickedCh {
		go openPetWindow(hctx)
	}
}

// terminateAllWebviews force-closes every currently-open WebView2 window. Safe
// to call when no windows are open (it is a no-op then). It does NOT call
// Destroy; the owning goroutine's w.Run() returns on Terminate and handles its
// own teardown.
func terminateAllWebviews() {
	webviewMu.Lock()
	defer webviewMu.Unlock()
	for _, w := range webviews {
		if w != nil {
			w.Terminate()
		}
	}
}

// openWebviewAfterReady waits briefly for the HTTP server to be listening, then
// launches the first native window. Launched in a goroutine so systray.Run can
// block the main goroutine concurrently.
func openWebviewAfterReady(hctx *app.HostContext) {
	// The HTTP server is started just before runHostLoop, but on a slow boot it
	// may not yet be bound. Polling gctx.consoleURL is overkill; a short sleep is
	// enough since the server goroutine has already been scheduled by main.
	openWebviewWindow(hctx)
}


// runWebviewClickLoop listens for clicks on the "独立窗口" menu item and launches
// a new WebView2 window on each click. The window runs in its own goroutine;
// closing it only ends that goroutine, not the whole process.
func runWebviewClickLoop(hctx *app.HostContext, m *systray.MenuItem) {
	for range m.ClickedCh {
		go openWebviewWindow(hctx)
	}
}

// webviewWindowMu serializes window creation: jchv/go-webview2 is not designed
// to create two windows in parallel from different goroutines (shared window class).
var webviewWindowMu sync.Mutex

// webviewMu guards the registry of currently-open WebView2 windows so shutdown
// can terminate them (close the native window immediately) even though each
// window's message pump runs on a different locked OS thread.
var webviewMu sync.Mutex

// webviews maps each open WebView2 window keyed by its HWND, registered while
// running and unregistered on close.
var webviews = map[uintptr]webview2.WebView{}

// openWebviewWindow creates and runs a single WebView2 window. Each invocation
// blocks until the user closes the window, then returns. Multiple concurrent
// windows are allowed as long as creation itself is serialized.
//
// WebView2 (COM-backed) REQUIRES its message pump to run on a thread that:
//  1. Is locked with runtime.LockOSThread so the Go scheduler won't move the
//     goroutine mid-pump (otherwise COM vtable calls jump threads and panic).
//  2. Has been initialized into the STA concurrency model via CoInitializeEx.
//
// Without LockOSThread, systray + webview interact to corrupt COM state and the
// process crashes the moment the WebView2 controller tries to dispatch a message.
func openWebviewWindow(hctx *app.HostContext) {
	// Isolate panics from this window's goroutine so a creation failure doesn't
	// propagate to systray and kill the process. We log + recover instead.
	defer func() {
		if r := recover(); r != nil {
			hctx.Logger.Error("webview window panic: %v", r)
		}
	}()

	// Acquire the creation lock OUTSIDE the locked thread, so other clicks don't
	// hold it while we run a message pump for an arbitrary amount of time.
	webviewWindowMu.Lock()
	defer webviewWindowMu.Unlock()

	// Pin this goroutine to a single OS thread for the lifetime of the window.
	// Combined with CoInitializeEx this gives WebView2 a stable STA apartment.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// Initialize COM STA for this thread. COINIT_APARTMENTTHREADED = 0x2.
	// S_FALSE (1) and RPC_E_CHANGED_MODE (0x80010106) are tolerable here.
	if err := windows.CoInitializeEx(0, 2); err != nil {
		// RPC_E_CHANGED_MODE means the thread already entered MTA. We explicitly
		// want STA; if we can't get it, fail with a log line instead of crashing.
		if err != windows.Errno(0x80010106) {
			hctx.Logger.Error("CoInitializeEx failed: %v", err)
			return
		}
	}
	// CoUninitialize must run on the same thread that called CoInitializeEx.
	// Deferred here runs before the UnlockOSThread defer (LIFO), which is correct.
	defer windows.CoUninitialize()

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "TinyRouter V" + app.Version,
			Width:  1280,
			Height: 800,
			// IconId is intentionally 0; jchv uses it to LoadImageW as RT_ICON,
			// but rsrc places the manifest at ID 1 and the icon group at ID 2 —
			// so IconId=1 picks up nothing useful and IconId=2 hits the RT_ICON
			// bucket, not RT_GROUP_ICON. We override the class icon ourselves
			// below via SetClassLongPtrW + LoadIconW (which DOES understand
			// RT_GROUP_ICON) once we have the HWND.
			IconId: 0,
			Center: true,
		},
	})
	if w == nil {
		hctx.Logger.Error("failed to create WebView2 window (WebView2 runtime missing?)")
		return
	}
	w.SetTitle("TinyRouter V" + app.Version)

	// Register this window so shutdown can terminate it immediately.
	webviewMu.Lock()
	webviews[uintptr(w.Window())] = w
	webviewMu.Unlock()
	defer func() {
		webviewMu.Lock()
		delete(webviews, uintptr(w.Window()))
		webviewMu.Unlock()
	}()

	var (
		fsSavedStyle     uint32
		fsSavedPlacement tagWINDOWPLACEMENT
		isFS             bool
		gwlStyle         uintptr = ^uintptr(15)
	)

	// Bind toggleNativeFullscreen BEFORE calling Navigate so it is immediately
	// available in the DOM environment.
	w.Bind("toggleNativeFullscreen", func(enable bool) error {
		hwnd := uintptr(w.Window())
		if hwnd == 0 {
			return nil
		}
		if enable && !isFS {
			style, _, _ := procGetWindowLongPtrW.Call(hwnd, gwlStyle)
			fsSavedStyle = uint32(style)

			fsSavedPlacement.length = uint32(unsafe.Sizeof(fsSavedPlacement))
			procGetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&fsSavedPlacement)))

			hMon, _, _ := procMonitorFromWindow.Call(hwnd, monitorDefaultToNearest)
			var mi tagMONITORINFO
			mi.cbSize = uint32(unsafe.Sizeof(mi))
			procGetMonitorInfoW.Call(hMon, uintptr(unsafe.Pointer(&mi)))

			newStyle := (fsSavedStyle &^ (wsCaption | wsThickFrame | wsSysMenu)) | wsPopup
			procSetWindowLongPtrW.Call(hwnd, gwlStyle, uintptr(newStyle))

			width := mi.rcMonitor.Right - mi.rcMonitor.Left
			height := mi.rcMonitor.Bottom - mi.rcMonitor.Top
			procSetWindowPos.Call(
				hwnd,
				0,
				uintptr(mi.rcMonitor.Left),
				uintptr(mi.rcMonitor.Top),
				uintptr(width),
				uintptr(height),
				swpFrameChanged|swpShowWindow,
			)
			isFS = true
			hctx.Logger.Info("WebView2 window entered native borderless fullscreen")
		} else if !enable && isFS {
			procSetWindowLongPtrW.Call(hwnd, gwlStyle, uintptr(fsSavedStyle))
			procSetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&fsSavedPlacement)))
			procSetWindowPos.Call(
				hwnd,
				0,
				0, 0, 0, 0,
				swpNoMove|swpNoSize|swpFrameChanged|swpShowWindow,
			)
			isFS = false
			hctx.Logger.Info("WebView2 window exited native borderless fullscreen")
		}
		return nil
	})

	// Bind openExternalURL to launch system default browser for external URLs
	w.Bind("openExternalURL", func(rawURL string) error {
		parsed, err := url.Parse(rawURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return nil
		}
		return fsutil.OpenInBrowser(rawURL)
	})

	// Inject auto-fullscreen sync and external link interception script into every document load.
	w.Init(`
		(function() {
			function syncFS() {
				var isFS = !!(document.fullscreenElement || document.webkitFullscreenElement || document.body.classList.contains('gallery-fullscreen-active'));
				if (typeof window.toggleNativeFullscreen === 'function') {
					try { window.toggleNativeFullscreen(isFS); } catch(e) {}
				}
			}
			document.addEventListener('fullscreenchange', syncFS);
			document.addEventListener('webkitfullscreenchange', syncFS);

			function handleExternal(href) {
				if (!href || typeof href !== 'string') return false;
				try {
					var u = new URL(href, window.location.href);
					if (u.protocol === 'http:' || u.protocol === 'https:') {
						if (u.origin !== window.location.origin) {
							if (typeof window.openExternalURL === 'function') {
								try { window.openExternalURL(u.href); } catch(e) {}
							} else {
								fetch('/api/open-url', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({ url: u.href })
								}).catch(function() {});
							}
							return true;
						}
					}
				} catch(e) {}
				return false;
			}

			document.addEventListener('click', function(e) {
				var target = e.target;
				var a = target && target.closest ? target.closest('a') : null;
				if (!a) return;
				var href = a.getAttribute('href') || a.href;
				if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
				if (handleExternal(href)) {
					e.preventDefault();
					e.stopPropagation();
				}
			}, true);

			var origOpen = window.open;
			window.open = function(url, target, features) {
				if (typeof url === 'string' && handleExternal(url)) {
					return null;
				}
				return origOpen ? origOpen.apply(this, arguments) : null;
			};
		})();
	`)

	// Navigate AFTER bindings and init scripts are setup.
	w.Navigate(hctx.ConsoleURL)

	// Apply our own icon to the window class (covers alt-tab, taskbar,
	// and the title-bar icon). rsrc puts the icon GROUP at resource ID 2,
	// so LoadIconW(hinst, MAKEINTRESOURCE(2)) is the right call.
	hwnd := uintptr(w.Window())
	if hwnd != 0 {
		user32 := windows.NewLazySystemDLL("user32.dll")
		kernel32 := windows.NewLazySystemDLL("kernel32.dll")

		// GetModuleHandle(NULL) → our own exe handle.
		hinst, _, _ := kernel32.NewProc("GetModuleHandleW").Call(0)

		// LoadIconW(hinst, MAKEINTRESOURCE(2)) loads the RT_GROUP_ICON@2
		// we embedded via rsrc -ico web/static/favicon.ico.
		hicon, _, _ := user32.NewProc("LoadIconW").Call(hinst, 2)

		if hicon != 0 {
			// Win32 GCLP_HICON (=-14) and GCLP_HICONSM (=-34) as uintptr.
			// Use int32 cast (not const decl) — a bare negative const overflows
			// uintptr in Go's const type inference, but runtime conversion is fine.
			gclpHIcon := int32(-14)   // large icon (alt-tab / taskbar)
			gclpHIconSm := int32(-34) // small icon (title bar)
			// SetClassLongPtrW replaces both entries on the window class.
			_, _, _ = user32.NewProc("SetClassLongPtrW").Call(hwnd, uintptr(gclpHIcon), hicon)
			_, _, _ = user32.NewProc("SetClassLongPtrW").Call(hwnd, uintptr(gclpHIconSm), hicon)

			// Force a non-client repaint so the title-bar icon updates immediately.
			const (
				rdwInvalidate = 0x0001
				rdwFrame      = 0x0400
				rdwUpdNow     = 0x0100
			)
			_, _, _ = user32.NewProc("RedrawWindow").Call(
				hwnd,
				0, 0,
				rdwInvalidate|rdwFrame|rdwUpdNow,
			)
		}

		// Maximize the window after creation. jchv/go-webview2 has no Maximize
		// API; ShowWindow(hwnd, SW_MAXIMIZE=3) does it. Must run after Navigate
		// so the WebView2 controller is already attached to the window.
		const swMaximize = 3
		_, _, _ = user32.NewProc("ShowWindow").Call(hwnd, swMaximize)
	}

	// w.Run() pumps Win32 messages for this thread until the window is closed.
	// On close it returns; the deferred cleanup runs and the goroutine exits.
	// We call systray.Quit() here so closing the window exits the whole app.
	w.Run()
	systray.Quit()
}

var (
	procGetWindowLongPtrW  = user32Dll.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW  = user32Dll.NewProc("SetWindowLongPtrW")
	procGetWindowPlacement = user32Dll.NewProc("GetWindowPlacement")
	procSetWindowPlacement = user32Dll.NewProc("SetWindowPlacement")
	procGetMonitorInfoW    = user32Dll.NewProc("GetMonitorInfoW")
	procMonitorFromWindow  = user32Dll.NewProc("MonitorFromWindow")
	procSetWindowPos       = user32Dll.NewProc("SetWindowPos")
	user32Dll              = windows.NewLazySystemDLL("user32.dll")
	dwmapiDll              = windows.NewLazySystemDLL("dwmapi.dll")
	procDwmExtendFrame     = dwmapiDll.NewProc("DwmExtendFrameIntoClientArea")
)

const (
	wsPopup                 = 0x80000000
	wsCaption               = 0x00C00000
	wsThickFrame            = 0x00040000
	wsSysMenu               = 0x00080000
	monitorDefaultToNearest = 2
	swpFrameChanged         = 0x0020
	swpShowWindow           = 0x0040
	swpNoMove               = 0x0002
	swpNoSize               = 0x0001
	swpNoZOrder             = 0x0004
)

// dwmMARGINS 用于 DwmExtendFrameIntoClientArea，所有字段设为 -1 表示
// 将 DWM 玻璃合成管线扩展至整个客户区，使 WebView2 DComp 表面的透明
// alpha 通道可以直接穿透到桌面。
type dwmMARGINS struct {
	CxLeftWidth, CxRightWidth, CyTopHeight, CyBottomHeight int32
}

// chromiumOf reaches the *edge.Chromium behind a webview2.WebView. The
// concrete *webview struct begins with {hwnd, mainthread uintptr, browser
// interface}; mirroring that prefix is the only way to reach the underlying
// controller without forking the module (its public interface does not expose
// the controller, and upstream HEAD matches the pinned pseudo-version).
type webviewPrefix struct {
	hwnd       uintptr
	mainthread uintptr
	browserItf [2]uintptr // interface (itab, data); dynamic type *edge.Chromium
}

func chromiumOf(w webview2.WebView) *edge.Chromium {
	iface := (*[2]uintptr)(unsafe.Pointer(&w))
	inner := (*webviewPrefix)(unsafe.Pointer(iface[1]))
	if inner == nil || inner.browserItf[1] == 0 {
		return nil
	}
	return (*edge.Chromium)(unsafe.Pointer(inner.browserItf[1]))
}

// setTransparentBackground 通过正确的 COM QueryInterface 获取
// ICoreWebView2Controller2 并调用 PutDefaultBackgroundColor 设置全透明。
// 旧代码直接在 Controller v1 vtable 上按 slot 27 偏移调用，属于越界未定义行为。
func setTransparentBackground(ctrl *edge.ICoreWebView2Controller) error {
	ctrl2 := ctrl.GetICoreWebView2Controller2()
	if ctrl2 == nil {
		return windows.ERROR_NOT_FOUND
	}
	return ctrl2.PutDefaultBackgroundColor(edge.COREWEBVIEW2_COLOR{
		A: 0, R: 0, G: 0, B: 0,
	})
}

// openPetWindow creates a lightweight, borderless desktop pet window (L3).
func openPetWindow(hctx *app.HostContext) {
	// Pin this goroutine to a single OS thread first, then initialize COM STA
	// on that thread BEFORE anything WebView2-related. The edge package's
	// init() only STA-initializes the MAIN thread; this window runs on its own
	// goroutine thread, and without STA its WebView2 COM calls cross apartments
	// and the message pump hangs (window shows "not responding", the page never
	// finishes loading, and the process eventually dies). openWebviewWindow has
	// the same dance — keep them in sync. RPC_E_CHANGED_MODE (0x80010106) and
	// S_FALSE are tolerable.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.CoInitializeEx(0, 2); err != nil {
		if err != windows.Errno(0x80010106) && err != windows.Errno(1) {
			hctx.Logger.Error("pet window: CoInitializeEx failed: %v", err)
			return
		}
	}
	defer windows.CoUninitialize()

	webviewWindowMu.Lock()
	// The documented WEBVIEW2_DEFAULT_BACKGROUND_COLOR escape hatch (read by
	// the WebView2 loader when the environment is created) is the only
	// mechanism that actually yields per-pixel transparency here: the
	// PutDefaultBackgroundColor vtable call alone stays white once the page
	// paints any root background, and the color-key approach never worked.
	// Value "0" = fully transparent (0xAARRGGBB). Scoped to this creation and
	// unset right after — webviewWindowMu serializes environment creation, so
	// no other window can observe the variable mid-flight.
	os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "00000000")
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: false,
		WindowOptions: webview2.WindowOptions{
			Title:  "",
			Width:  240,
			Height: 240,
			IconId: 0,
			Center: false,
		},
	})
	os.Unsetenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR")
	webviewWindowMu.Unlock()

	hwnd := uintptr(w.Window())
	if hwnd != 0 {
		gwlStyle := ^uintptr(15)
		style, _, _ := procGetWindowLongPtrW.Call(hwnd, gwlStyle)
		newStyle := (uint32(style) &^ (wsCaption | wsThickFrame | wsSysMenu)) | wsPopup
		procSetWindowLongPtrW.Call(hwnd, gwlStyle, uintptr(newStyle))

		// 关键：将 DWM 玻璃合成管线扩展至全客户区，使 WebView2 DComp 表面的
		// 透明 alpha 通道可以直接穿透到桌面。没有这一步，宿主窗口的 GDI 画刷
		// 会在 WebView2 透明层下方叠一层不透明背景，导致要么看到白色矩形，
		// 要么 DWM 合成器判定"无可见内容"使整个窗口不可见。
		margins := dwmMARGINS{-1, -1, -1, -1}
		procDwmExtendFrame.Call(hwnd, uintptr(unsafe.Pointer(&margins)))

		// Set Topmost (HWND_TOPMOST = -1 = ^uintptr(0))
		procSetWindowPos.Call(
			hwnd,
			^uintptr(0),
			100, 100, 240, 240,
			swpFrameChanged|swpShowWindow,
		)
		// True per-pixel transparency via WebView2's DefaultBackgroundColor.
		// The controller is not ready immediately after NewWithOptions (Embed
		// is async) — poll until it appears then apply transparency. The env
		// var scoping above handles first-navigation white flicker when the
		// pet happens to be the first WebView2 in the process; the API call
		// here handles the normal case where the main window already created
		// the shared environment and the env var is ignored.
		go func(targetHwnd uintptr, view webview2.WebView) {
			for range 30 {
				time.Sleep(100 * time.Millisecond)
				chromium := chromiumOf(view)
				if chromium == nil {
					continue
				}
				ctrl := chromium.GetController()
				if ctrl == nil {
					continue
				}
				if err := setTransparentBackground(ctrl); err != nil {
					hctx.Logger.Error("pet window: transparent background: %v", err)
				} else {
					hctx.Logger.Info("pet window: transparent background applied")
				}
				// 强制 DComp 重新合成，确保透明变更立即生效。
				_ = ctrl.NotifyParentWindowPositionChanged()
				_ = targetHwnd // keep hwnd alive for logging if needed
				return
			}
			hctx.Logger.Error("pet window: controller not ready for transparency")
		}(hwnd, w)
	}
	// Register window
	webviewMu.Lock()
	webviews[hwnd] = w
	webviewMu.Unlock()
	defer func() {
		webviewMu.Lock()
		delete(webviews, hwnd)
		webviewMu.Unlock()
	}()

	var pos tagWINDOWPLACEMENT
	pos.length = uint32(unsafe.Sizeof(pos))

	w.Bind("movePetWindow", func(dx, dy int) error {
		if hwnd == 0 {
			return nil
		}
		procGetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&pos)))
		curX := pos.rcNormalPosition.Left + int32(dx)
		curY := pos.rcNormalPosition.Top + int32(dy)
		procSetWindowPos.Call(
			hwnd,
			0,
			uintptr(curX),
			uintptr(curY),
			0, 0,
			swpNoSize|swpNoZOrder|swpShowWindow,
		)
		return nil
	})

	w.Bind("closePetWindow", func() error {
		w.Terminate()
		return nil
	})

	w.Navigate(hctx.ConsoleURL + "/sprite-pet.html")
	w.Run()
}

type tagWINDOWPLACEMENT struct {
	length           uint32
	flags            uint32
	showCmd          uint32
	ptMinPosition    [2]int32
	ptMaxPosition    [2]int32
	rcNormalPosition windows.Rect
}

type tagMONITORINFO struct {
	cbSize    uint32
	rcMonitor windows.Rect
	rcWork    windows.Rect
	dwFlags   uint32
}
