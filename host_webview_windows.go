//go:build tray && webview && windows

package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"fyne.io/systray"
	"github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/pkg/edge"
	"github.com/tinyrouter/tinyrouter/internal/app"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
	"github.com/tinyrouter/tinyrouter/internal/petstate"
	"golang.org/x/sys/windows"
)

// addWebviewMenuItem adds an "打开独立窗口" item to the tray menu and wires its
// click channel to launch a native WebView2 window per click. Only compiled when
// the `webview` build tag is set.
//
// Returns interface{} so the caller (host_tray_windows.go) stays build-tag-
// agnostic; the matching stub when `webview` is absent returns nil.
func addWebviewMenuItem(hctx *app.HostContext) interface{} {
	hctxGlob = hctx
	m := systray.AddMenuItem("打开独立窗口", "Open TinyRouter UI in a native WebView2 window")
	go runWebviewClickLoop(hctx, m)

	mPet := systray.AddMenuItem("释放桌面小精灵", "Open desktop pet assistant")
	go runPetClickLoop(hctx, mPet)

	// Auto-open the native window once at startup (independent of the click loop).
	go openWebviewAfterReady(hctx)

	// The desktop pet IS the assistant surface (the in-app dock was removed):
	// settings toggle off closes it, toggle on / tray click brings it back.
	petstate.SetCloseAll(terminateAllPetWindows)
	petstate.SetOpen(openPetIfNeeded)

	// Auto-release the pet at startup when the assistant is enabled.
	go openPetAfterReady(hctx)

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
		if !petstate.Enabled() {
			hctx.Logger.Info("pet window: disabled in Assistant settings")
			continue
		}
		openPetIfNeeded()
	}
}

// openPetAfterReady waits for the HTTP server (the pet page loads from it),
// then opens the pet unless the feature is off or it is already open.
func openPetAfterReady(hctx *app.HostContext) {
	for i := 0; i < 100; i++ {
		if petWindowsOpen() || !petstate.Enabled() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	openPetIfNeeded()
}

// openPetIfNeeded opens a pet window unless one is already up or the feature
// is disabled. Registered with petstate so the settings toggle can re-open.
func openPetIfNeeded() {
	if petWindowsOpen() || !petstate.Enabled() {
		return
	}
	go openPetWindow(hctxGlob)
}

// petWindowsOpen reports whether any pet window is currently up.
func petWindowsOpen() bool {
	petMu.Lock()
	defer petMu.Unlock()
	return len(petWindows) > 0
}

// terminateAllPetWindows posts WM_CLOSE to every open pet window (safe from a
// foreign thread; the owning pump turns it into DestroyWindow).
func terminateAllPetWindows() {
	petMu.Lock()
	defer petMu.Unlock()
	for hwnd := range petWindows {
		procPostMessageW.Call(hwnd, wmClose, 0, 0)
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
	procGetWindowPlacement        = user32Dll.NewProc("GetWindowPlacement")
	procSetWindowPlacement        = user32Dll.NewProc("SetWindowPlacement")
	procGetMonitorInfoW           = user32Dll.NewProc("GetMonitorInfoW")
	procMonitorFromWindow         = user32Dll.NewProc("MonitorFromWindow")
	procSetWindowPos              = user32Dll.NewProc("SetWindowPos")
	user32Dll                     = windows.NewLazySystemDLL("user32.dll")
	gdi32Dll                      = windows.NewLazySystemDLL("gdi32.dll")
	kernel32Dll                   = windows.NewLazySystemDLL("kernel32.dll")
	dwmapiDll                     = windows.NewLazySystemDLL("dwmapi.dll")
	procDwmExtendFrame            = dwmapiDll.NewProc("DwmExtendFrameIntoClientArea")
	procDwmEnableBlurBehindWindow = dwmapiDll.NewProc("DwmEnableBlurBehindWindow")
	procRegisterClassExW          = user32Dll.NewProc("RegisterClassExW")
	procCreateWindowExW           = user32Dll.NewProc("CreateWindowExW")
	procDefWindowProcW            = user32Dll.NewProc("DefWindowProcW")
	procGetMessageW               = user32Dll.NewProc("GetMessageW")
	procTranslateMessage          = user32Dll.NewProc("TranslateMessage")
	procDispatchMessageW          = user32Dll.NewProc("DispatchMessageW")
	procPostQuitMessage           = user32Dll.NewProc("PostQuitMessage")
	procPostMessageW              = user32Dll.NewProc("PostMessageW")
	procDestroyWindow             = user32Dll.NewProc("DestroyWindow")
	procShowWindow                = user32Dll.NewProc("ShowWindow")
	procGetCursorPos              = user32Dll.NewProc("GetCursorPos")
	procIsIconic                  = user32Dll.NewProc("IsIconic")
	procGetForegroundWindow       = user32Dll.NewProc("GetForegroundWindow")
	procGetWindowRect             = user32Dll.NewProc("GetWindowRect")
	procGetWindowLongPtrW         = user32Dll.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW         = user32Dll.NewProc("SetWindowLongPtrW")
	procSetWindowRgn              = user32Dll.NewProc("SetWindowRgn")
	procCombineRgn                = gdi32Dll.NewProc("CombineRgn")
	procGetStockObject            = gdi32Dll.NewProc("GetStockObject")
	procCreateRectRgn             = gdi32Dll.NewProc("CreateRectRgn")
	procDeleteObject              = gdi32Dll.NewProc("DeleteObject")
	procGetModuleHandleW          = kernel32Dll.NewProc("GetModuleHandleW")
)

// mustStockObject returns a GDI stock object handle (never fails for BLACK_BRUSH).
func mustStockObject(idx uintptr) uintptr {
	r, _, _ := procGetStockObject.Call(idx)
	return r
}

// Pet window recipe constants (see openPetWindow doc comment).
const (
	csHredraw       = 0x0002
	csVredraw       = 0x0001
	blackBrush      = 4 // GetStockObject: writes alpha=0 into the redirection surface
	dwmBbEnable     = 1
	dwmBbBlurRegion = 2
	wsExTopmost     = 0x00000008
	wsExToolWindow  = 0x00000080
	// Click-through: SetWindowRgn clips the window to the union of the page's
	// interactive rects — pixels outside render nothing AND receive no clicks.
	// (WS_EX_LAYERED|WS_EX_TRANSPARENT toggling was tried first: on a window
	// WITH a redirection surface the layered style blanks the WebView2 DComp
	// output; it only works on WS_EX_NOREDIRECTIONBITMAP windows like Wails.)
	wmRgn         = 0
	wmSize        = 0x0005
	wmDestroy     = 0x0002
	swpNoActivate = 0x0010
)

// petWNDCLASSEX mirrors WNDCLASSEXW.
type petWNDCLASSEX struct {
	CbSize        uint32
	Style         uint32
	LpfnWndProc   uintptr
	CbClsExtra    int32
	CbWndExtra    int32
	HInstance     syscall.Handle
	HIcon         syscall.Handle
	HCursor       syscall.Handle
	HbrBackground syscall.Handle
	LpszMenuName  *uint16
	LpszClassName *uint16
	HIconSm       syscall.Handle
}

// petMSG mirrors MSGW.
type petMSG struct {
	Hwnd    windows.HWND
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

// dwmBlurBehind mirrors DWM_BLURBEHIND. An EMPTY region (CreateRectRgn(0,0,-1,-1))
// enables per-pixel alpha compositing with no blur.
type dwmBlurBehind struct {
	DwFlags                uint32
	FEnable                uint32
	HRgnBlur               uintptr
	FTransitionOnMaximized uint32
}

type tagPOINT struct {
	X, Y int32
}

const (
	wsPopup                 = 0x80000000
	wsVisible               = 0x10000000
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
//
// Transparency recipe (verified in webview-pet-test, see
// docs/desktop-pet-progress.md): DefaultBackgroundColor=transparent only
// reveals the HOST window; the host window itself must composite per-pixel
// alpha against the desktop. That requires a window class whose background
// brush is BLACK_BRUSH (zeroes redirection-surface alpha) plus
// DwmEnableBlurBehindWindow with an EMPTY region (enables DWM per-pixel alpha
// compositing, no blur). The former DwmExtendFrameIntoClientArea(-1) call was
// the wrong API and never produced transparency; WS_EX_LAYERED/colorkey break
// DirectComposition content and must NOT be used.
//
// jchv/go-webview2's webview2.New() creates its own window class (opaque
// brush), so the pet window is built by hand (RegisterClassExW + CreateWindowExW)
// and the WebView2 controller is embedded via edge.Chromium.Embed. Interactions
// (drag/close/scale) use chrome.webview.postMessage — the Bind host-object API
// is not available on the raw edge.Chromium.
var (
	hctxGlob   *app.HostContext
	petWndOnce sync.Once
	// petMu guards petWindows; wndProc (any window's thread) and shutdown
	// (systray thread) both touch it.
	petMu      sync.Mutex
	petWindows = map[uintptr]*petWindow{}
)

type petWindow struct {
	hctx     *app.HostContext
	hwnd     uintptr
	chromium *edge.Chromium
	scale    float64
	dragging bool
	dragCur  struct{ X, Y int32 }
	dragWin  struct{ X, Y int32 }
	// hitRects: window-relative interactive regions reported by the page
	// (avatar, close button, bubble, input row). Empty => fully pass-through.
	hitRects [][4]int32
	passthru bool // current WS_EX_TRANSPARENT state
}

const (
	// 宠物区基准 300 + 交流列固定 260；高恒 300（交流列不随缩放变化）
	petAreaW  = 300
	petPanelW = 260
	petBaseH  = 300
	wmClose   = 0x0010
)

func petWndProc(hwnd windows.HWND, msg uint32, wp, lp uintptr) uintptr {
	petMu.Lock()
	pw := petWindows[uintptr(hwnd)]
	petMu.Unlock()
	switch msg {
	case wmClose:
		procDestroyWindow.Call(uintptr(hwnd))
		return 0
	case wmDestroy:
		if pw != nil {
			petMu.Lock()
			delete(petWindows, uintptr(hwnd))
			petMu.Unlock()
			pw.hctx.Logger.Info("pet window: closed")
		}
		procPostQuitMessage.Call(0)
		return 0
	case wmSize:
		if pw != nil && pw.chromium != nil {
			pw.chromium.Resize()
		}
		return 0
	}
	return petDefWndProc(hwnd, msg, wp, lp)
}

func petDefWndProc(hwnd windows.HWND, msg uint32, wp, lp uintptr) uintptr {
	r, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wp, lp)
	return r
}

// petCursorPos returns the physical-pixel cursor position (DPI-safe drag).
func petCursorPos() (x, y int32) {
	var pt tagPOINT
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	return pt.X, pt.Y
}

// petOnMessage dispatches chrome.webview.postMessage payloads from sprite-pet.js.
func petOnMessage(pw *petWindow, msg string) {
	var m struct {
		Type  string    `json:"type"`
		F     float64   `json:"f,omitempty"`
		Rects [][]int32 `json:"rects,omitempty"`
		Vp    []int32   `json:"vp,omitempty"`
		Scr   []int32   `json:"scr,omitempty"`
	}
	if err := json.Unmarshal([]byte(msg), &m); err != nil {
		return
	}
	if petstate.Debug() && m.Type != "hit" {
		pw.hctx.Logger.Info("pet msg: %s", m.Type)
	}
	switch m.Type {
	case "dragstart":
		pw.dragging = true
		pw.dragCur.X, pw.dragCur.Y = petCursorPos()
		var r windows.Rect
		procGetWindowRect.Call(pw.hwnd, uintptr(unsafe.Pointer(&r)))
		pw.dragWin.X, pw.dragWin.Y = r.Left, r.Top
	case "dragmove":
		if !pw.dragging {
			return
		}
		cx, cy := petCursorPos()
		procSetWindowPos.Call(pw.hwnd, 0,
			uintptr(pw.dragWin.X+cx-pw.dragCur.X),
			uintptr(pw.dragWin.Y+cy-pw.dragCur.Y),
			0, 0, swpNoSize|swpNoZOrder|swpNoActivate)
	case "dragend":
		pw.dragging = false
	case "scale":
		if m.F >= 0.5 && m.F <= 2.0 {
			applyPetScale(pw, m.F)
		}
	case "hit":
		// JS rects are in the webview's CSS px (DPI-virtualized); the host is
		// DPI-aware (physical px). Scale by winW/vpW before storing.
		scale := 1.0
		if len(m.Vp) == 2 && m.Vp[0] > 0 {
			var wr windows.Rect
			procGetWindowRect.Call(pw.hwnd, uintptr(unsafe.Pointer(&wr)))
			scale = float64(wr.Right-wr.Left) / float64(m.Vp[0])
		}
		rects := make([][4]int32, 0, len(m.Rects))
		for _, r := range m.Rects {
			if len(r) == 4 {
				rects = append(rects, [4]int32{
					int32(float64(r[0]) * scale), int32(float64(r[1]) * scale),
					int32(float64(r[2]) * scale), int32(float64(r[3]) * scale),
				})
			}
		}
		pw.hitRects = rects
		applyPetRegion(pw)
	case "close":
		procDestroyWindow.Call(pw.hwnd)
	}
}

// applyPetRegion clips the window to the union of the page's interactive
// rects (physical px, window-relative). Outside the region the window renders
// nothing and clicks fall through to whatever is beneath. Runs on the window
// thread (MessageCallback fires during the message pump).
func applyPetRegion(pw *petWindow) {
	if len(pw.hitRects) == 0 {
		procSetWindowRgn.Call(pw.hwnd, 0, 1) // NULL region = whole window
		return
	}
	union, _, _ := procCreateRectRgn.Call(0, 0, 0, 0)
	for _, h := range pw.hitRects {
		rgn, _, _ := procCreateRectRgn.Call(
			uintptr(h[0]), uintptr(h[1]),
			uintptr(h[0]+h[2]), uintptr(h[1]+h[3]))
		procCombineRgn.Call(union, union, rgn, 2) // RGN_OR
		procDeleteObject.Call(rgn)
	}
	procSetWindowRgn.Call(pw.hwnd, union, 1)
	procDeleteObject.Call(union)
}

// applyPetScale resizes the pet AREA to 300*f while the chat panel keeps its
// physical size: window width = 300*f + 260, height constant 300.
// sprite-pet.html must NOT use vw/vh units (they ignore zoom and crop).
func applyPetScale(pw *petWindow, f float64) {
	pw.scale = f
	w, h := int32(float64(petAreaW)*f)+petPanelW, int32(petBaseH)
	procSetWindowPos.Call(pw.hwnd, 0, 0, 0, uintptr(w), uintptr(h),
		swpNoMove|swpNoZOrder|swpNoActivate)
	pw.chromium.Resize()
	pw.chromium.Eval(fmt.Sprintf("setPetScale(%v)", f))
}

func openPetWindow(hctx *app.HostContext) {
	// Pin this goroutine to a single OS thread first, then initialize COM STA
	// on that thread BEFORE anything WebView2-related. The edge package's
	// init() only STA-initializes the MAIN thread; this window runs on its own
	// goroutine thread, and without STA its WebView2 COM calls cross apartments
	// and the message pump hangs. RPC_E_CHANGED_MODE (0x80010106) and S_FALSE
	// are tolerable.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.CoInitializeEx(0, 2); err != nil {
		if err != windows.Errno(0x80010106) && err != windows.Errno(1) {
			hctx.Logger.Error("pet window: CoInitializeEx failed: %v", err)
			return
		}
	}
	defer windows.CoUninitialize()

	// The documented WEBVIEW2_DEFAULT_BACKGROUND_COLOR escape hatch is read
	// when the WebView2 environment is created; set it just before Embed.
	// NOTE: webviewWindowMu must NOT be taken here — openWebviewWindow holds
	// it for the LIFETIME of the main window (deferred unlock after Run), so
	// acquiring it would deadlock the pet until the main window closes. The
	// pet path does not use webview2.New() (the mutex's actual guard target).

	os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "00000000")

	// Register the pet window class once: BLACK_BRUSH class brush zeroes the
	// redirection-surface alpha (prerequisite 1 of the transparency recipe).
	petWndOnce.Do(func() {
		hInstance, _, _ := procGetModuleHandleW.Call(0)
		wc := petWNDCLASSEX{
			CbSize:        uint32(unsafe.Sizeof(petWNDCLASSEX{})),
			Style:         csHredraw | csVredraw,
			LpfnWndProc:   windows.NewCallback(petWndProc),
			HInstance:     syscall.Handle(hInstance),
			HbrBackground: syscall.Handle(mustStockObject(blackBrush)),
			LpszClassName: windows.StringToUTF16Ptr("TinyRouterPetWnd"),
		}
		if r, _, _ := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
			hctx.Logger.Error("pet window: RegisterClassExW failed")
		}
	})

	// Create VISIBLE from the start (verified-recipe parity): a WebView2
	// controller created on a hidden parent window does not commit its
	// DComp frames after a later ShowWindow. An empty window under this
	// recipe is fully transparent anyway, so there is no flash to avoid.
	hwnd, _, callErr := procCreateWindowExW.Call(
		uintptr(wsExTopmost|wsExToolWindow),
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("TinyRouterPetWnd"))),
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(""))),
		uintptr(wsPopup|wsVisible),
		100, 100, petAreaW+petPanelW, petBaseH,
		0, 0, 0, 0,
	)
	if hwnd == 0 {
		hctx.Logger.Error("pet window: CreateWindowExW failed: %v", callErr)
		return
	}

	// Prerequisite 2: DwmEnableBlurBehindWindow with an empty region switches
	// DWM to per-pixel alpha compositing for this window (no blur).
	emptyRgn := ^uintptr(0) // 0xFFFFFFFF: CreateRectRgn treats it as -1 (empty region)
	rgn, _, _ := procCreateRectRgn.Call(0, 0, emptyRgn, emptyRgn)
	bb := dwmBlurBehind{
		DwFlags:  dwmBbEnable | dwmBbBlurRegion,
		FEnable:  1,
		HRgnBlur: rgn,
	}
	if hr, _, _ := procDwmEnableBlurBehindWindow.Call(hwnd, uintptr(unsafe.Pointer(&bb))); hr != 0 {
		hctx.Logger.Error("pet window: DwmEnableBlurBehindWindow failed: 0x%x", hr)
		procDestroyWindow.Call(hwnd)
		return
	}

	pw := &petWindow{hctx: hctx, hwnd: hwnd, scale: 1.0}
	chromium := edge.NewChromium()
	pw.chromium = chromium
	chromium.MessageCallback = func(msg string) { petOnMessage(pw, msg) }
	if !chromium.Embed(hwnd) {
		hctx.Logger.Error("pet window: chromium.Embed failed (WebView2 runtime missing?)")
		procDestroyWindow.Call(hwnd)
		return
	}

	petMu.Lock()
	petWindows[hwnd] = pw
	petMu.Unlock()
	defer func() {
		petMu.Lock()
		delete(petWindows, hwnd)
		petMu.Unlock()
	}()

	// Pump until the async controller creation completes, then apply
	// transparency and show.
	deadline := time.Now().Add(15 * time.Second)
	for chromium.GetController() == nil {
		if !petPumpOnce() || time.Now().After(deadline) {
			hctx.Logger.Error("pet window: WebView2 controller not ready in time")
			procDestroyWindow.Call(hwnd)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	chromium.Resize()
	if err := setTransparentBackground(chromium.GetController()); err != nil {
		hctx.Logger.Error("pet window: transparent background: %v", err)
	} else {
		hctx.Logger.Info("pet window: transparent background applied")
	}
	// Belt and braces: the page also preventDefaults contextmenu, but disable
	// the Chromium default menu at the settings level too.
	if settings, err := chromium.GetSettings(); err == nil {
		_ = settings.PutAreDefaultContextMenusEnabled(false)
	}
	chromium.Navigate(hctx.ConsoleURL + "/sprite-pet.html")

	// Message pump: runs until WM_DESTROY -> PostQuitMessage.
	for petPumpOnce() {
	}
}

// petPumpOnce dispatches one queued message; returns false on WM_QUIT/error.
func petPumpOnce() bool {
	var m petMSG
	r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
	if int32(r) <= 0 {
		return false
	}
	procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
	procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	return true
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
