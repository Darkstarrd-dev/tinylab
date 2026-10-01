//go:build tray && webview && windows

package main

import (
	"net/url"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"fyne.io/systray"
	"github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/pkg/edge"
	"github.com/tinylab/tinylab/internal/app"
	"github.com/tinylab/tinylab/internal/fsutil"
	"golang.org/x/sys/windows"
)

func hasAnyWebview() bool {
	webviewMu.Lock()
	n := len(webviews)
	webviewMu.Unlock()
	return n > 0
}

// terminateAllWebviews force-closes every currently-open WebView2 window. Safe
// to call when no windows are open (it is a no-op then). It does NOT call
// Destroy; the owning goroutine's w.Run() returns on Terminate and handles its
// own teardown.
func terminateAllWebviews() {
	// 复制句柄后释放锁再逐个 Terminate：若目标窗口的 COM 已卡死，
	// 在锁内同步等待会堵住托盘线程，表现为重启/开启无反应。
	webviewMu.Lock()
	ws := make([]webview2.WebView, 0, len(webviews))
	for _, w := range webviews {
		if w != nil {
			ws = append(ws, w)
		}
	}
	webviewMu.Unlock()
	for _, w := range ws {
		func(ww webview2.WebView) {
			defer func() { _ = recover() }()
			// 带超时的 Terminate：卡死窗口的 Terminate 可能不返回
			done := make(chan struct{})
			go func() { ww.Terminate(); close(done) }()
			select {
			case <-done:
			case <-time.After(900 * time.Millisecond):
			}
		}(w)
	}
}

// openWebviewAfterReady starts the first window directly; the HTTP server is
// already started by main before runHostLoop.

// openWebviewAfterReady starts the first window directly; the HTTP server is
// already started by main before runHostLoop.
func openWebviewAfterReady(hctx *app.HostContext) {
	openWebviewWindow(hctx)
}

// webviewWindowMu serializes window creation: jchv/go-webview2 is not designed
// to create two windows in parallel from different goroutines (shared window class).

// webviewWindowMu serializes window creation: jchv/go-webview2 is not designed
// to create two windows in parallel from different goroutines (shared window class).
var webviewWindowMu sync.Mutex

// webviewMu guards the registry of currently-open WebView2 windows so shutdown
// can terminate them (close the native window immediately) even though each
// window's message pump runs on a different locked OS thread.

// webviewMu guards the registry of currently-open WebView2 windows so shutdown
// can terminate them (close the native window immediately) even though each
// window's message pump runs on a different locked OS thread.
var webviewMu sync.Mutex

// webviews maps each open WebView2 window keyed by its HWND, registered while
// running and unregistered on close.

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
			Title:  "TinyLab V" + app.Version,
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
	w.SetTitle("TinyLab V" + app.Version)

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

	// Disable WebView2's built-in IsZoomControlEnabled (Ctrl±/Ctrl0/Ctrl+Wheel).
	// Our app owns all zoom: global via CSS zoom (zoom.js) and contextual text-only
	// zoom (playground .pg-input/.pg-bubble, editor #ed-main-input). Keeping the
	// native control enabled makes WebView2 scale the whole page under us and fight
	// our handlers.
	go func() {
		for range 40 {
			time.Sleep(50 * time.Millisecond)
			ch := chromiumOf(w)
			if ch == nil {
				continue
			}
			s, err := ch.GetSettings()
			if err != nil || s == nil {
				continue
			}
			_ = s.PutIsZoomControlEnabled(false)
			_ = s.PutIsPinchZoomEnabled(false)
			return
		}
	}()

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

	// Bind setTrayLang so JS setLang(lang) can push lang to the native tray.
	w.Bind("setTrayLang", func(lang string) error {
		if lang != "cn" {
			lang = "en"
		}
		setTrayLang(lang)
		applyTrayLang(lang)
		hctx.Logger.Info("tray lang -> %s", lang)
		return nil
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
			try {
				var cur = (document.documentElement.getAttribute('data-lang')||'en');
				if (typeof window.setTrayLang === 'function') { try{ window.setTrayLang(cur);}catch(e){} }
			} catch(e){}
			try {
				new MutationObserver(function(muts){
					for (var i=0;i<muts.length;i++){
						var m=muts[i];
						if (m.attributeName==='data-lang' && m.target===document.documentElement){
							var nl=document.documentElement.getAttribute('data-lang')||'en';
							if (typeof window.setTrayLang==='function'){ try{ window.setTrayLang(nl);}catch(e){} }
						}
					}
				}).observe(document.documentElement, {attributes:true, attributeFilter:['data-lang']});
			} catch(e){}
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
	// 行为：点 X 即退出整个 app（用户明确不保留“只关窗不退出”的旧语义）。
	// 随后 runWebviewRestartLoop 可以用 Tray 菜单重新打开新窗口。
	w.Run()
	systray.Quit()
}

type tagPOINT struct {
	X, Y int32
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
