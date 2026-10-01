//go:build tray && webview && windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2/pkg/edge"
	"github.com/tinylab/tinylab/internal/app"
	"github.com/tinylab/tinylab/internal/petstate"
	"golang.org/x/sys/windows"
)

// Helpers restored (no tray button, but still needed for settings toggle callbacks).
func terminateAllPetWindows() {
	var hwnds []uintptr
	petMu.Lock()
	for hwnd := range petWindows {
		hwnds = append(hwnds, hwnd)
	}
	petMu.Unlock()
	for _, hwnd := range hwnds {
		procPostMessageW.Call(hwnd, wmClose, 0, 0)
	}
}

func openPetIfNeeded(hctx *app.HostContext) {
	if !petstate.Enabled() {
		return
	}
	if !petCreateMu.TryLock() {
		return
	}
	petCreateMu.Unlock()
	petMu.Lock()
	hasWindow := len(petWindows) > 0
	petMu.Unlock()
	if hasWindow {
		return
	}
	go openPetWindow(hctx)
}

func setPetWindowVisible(show bool) bool {
	var hwnd uintptr
	petMu.Lock()
	for h := range petWindows {
		hwnd = h
		break
	}
	petMu.Unlock()
	if hwnd == 0 {
		return false
	}
	var cmd uintptr = 0 // SW_HIDE
	if show {
		cmd = 5 // SW_SHOWNA (show without activating, avoids stealing focus)
	}
	procShowWindow.Call(hwnd, cmd)
	return true
}

// terminateAllWebviews force-closes every currently-open WebView2 window. Safe
// to call when no windows are open (it is a no-op then). It does NOT call
// Destroy; the owning goroutine's w.Run() returns on Terminate and handles its
// own teardown.

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

// mustStockObject returns a GDI stock object handle (never fails for BLACK_BRUSH).
func mustStockObject(idx uintptr) uintptr {
	r, _, _ := procGetStockObject.Call(idx)
	return r
}

// Pet window recipe constants (see openPetWindow doc comment).

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

// dwmBlurBehind mirrors DWM_BLURBEHIND. An EMPTY region (CreateRectRgn(0,0,-1,-1))
// enables per-pixel alpha compositing with no blur.
type dwmBlurBehind struct {
	DwFlags                uint32
	FEnable                uint32
	HRgnBlur               uintptr
	FTransitionOnMaximized uint32
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
	petWndOnce sync.Once
	// petMu guards petWindows; wndProc (any window's thread) and shutdown
	// (systray thread) both touch it.
	petMu       sync.Mutex
	petWindows  = map[uintptr]*petWindow{}
	petCreateMu sync.Mutex
	petEnvOnce  sync.Once
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
	// 初始/兜底窗口尺寸（物理 px）。实际大小由页面驱动：sprite-pet.js
	// postPetSize 按当前 action 帧宽高比发 {type:'size', w, h, dpr}（CSS px），
	// 宿主乘 dpr 转物理像素 —— 见 petOnMessage "size" 分支。
	petAreaW = 300
	petBaseH = 300
	wmClose  = 0x0010
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

// petCursorPos returns the physical-pixel cursor position (DPI-safe drag).
func petCursorPos() (x, y int32) {
	var pt tagPOINT
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	return pt.X, pt.Y
}

// petOnMessage dispatches chrome.webview.postMessage payloads from sprite-pet.js.

// petOnMessage dispatches chrome.webview.postMessage payloads from sprite-pet.js.
func petOnMessage(pw *petWindow, msg string) {
	var m struct {
		Type  string    `json:"type"`
		F     float64   `json:"f,omitempty"`
		W     float64   `json:"w,omitempty"`
		H     float64   `json:"h,omitempty"`
		Dpr   float64   `json:"dpr,omitempty"`
		Rects [][]int32 `json:"rects,omitempty"`
		Vp    []int32   `json:"vp,omitempty"`
		Scr   []int32   `json:"scr,omitempty"`
		State string    `json:"state,omitempty"`
	}
	if err := json.Unmarshal([]byte(msg), &m); err != nil {
		return
	}
	if petstate.Debug() && m.Type != "hit" {
		pw.hctx.Logger.Info("pet msg: %s", m.Type)
	}
	switch m.Type {
	case "state":
		// State pushes are informational; no host-side reader (the settings
		// panel polls /api/assistant/pet-state instead).
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
	case "size":
		// Page-driven window size (sprite-pet.js postPetSize): w/h are CSS px,
		// dpr = window.devicePixelRatio. Physical = css*dpr keeps the CSS
		// layout exact on any DPI; the old f-multiplied sizing was wrong on
		// DPI-scaled monitors (viewport = physical/dpi, not physical/f).
		dpr := m.Dpr
		if dpr < 0.5 || dpr > 5 {
			dpr = 1
		}
		w, h := int32(m.W*dpr), int32(m.H*dpr)
		if w < 40 {
			w = 40
		} else if w > 2000 {
			w = 2000
		}
		if h < 40 {
			h = 40
		} else if h > 2000 {
			h = 2000
		}
		procSetWindowPos.Call(pw.hwnd, 0, 0, 0, uintptr(w), uintptr(h),
			swpNoMove|swpNoZOrder|swpNoActivate)
		pw.chromium.Resize()
	case "close":
		procDestroyWindow.Call(pw.hwnd)
	}
}

// applyPetRegion clips the window to the union of the page's interactive
// rects (physical px, window-relative). Outside the region the window renders
// nothing and clicks fall through to whatever is beneath. Runs on the window
// thread (MessageCallback fires during the message pump).

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

// applyPetScale delegates scaling to the page: setPetScale recomputes the CSS
// layout (avatar box from the active action's frame aspect) and posts a "size"
// message; the host no longer derives physical px from f.

// applyPetScale delegates scaling to the page: setPetScale recomputes the CSS
// layout (avatar box from the active action's frame aspect) and posts a "size"
// message; the host no longer derives physical px from f.
func applyPetScale(pw *petWindow, f float64) {
	pw.scale = f
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

	petEnvOnce.Do(func() { os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "00000000") })

	// Only the WebView2 environment creation (Embed + async controller wait)
	// races. Holding petCreateMu for the entire window lifetime (message pump)
	// would keep the LockOSThread goroutine pinned on the mutex and make every
	// later toggle block for the whole lifetime of the window — the freeze on
	// rapid toggle. Serialize creation then immediately release; the pump runs
	// without the mutex.
	petCreateMu.Lock()
	petWndOnce.Do(func() {
		hInstance, _, _ := procGetModuleHandleW.Call(0)
		wc := petWNDCLASSEX{
			CbSize:        uint32(unsafe.Sizeof(petWNDCLASSEX{})),
			Style:         csHredraw | csVredraw,
			LpfnWndProc:   windows.NewCallback(petWndProc),
			HInstance:     syscall.Handle(hInstance),
			HbrBackground: syscall.Handle(mustStockObject(blackBrush)),
			LpszClassName: windows.StringToUTF16Ptr("TinyLabPetWnd"),
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
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("TinyLabPetWnd"))),
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(""))),
		uintptr(wsPopup|wsVisible),
		100, 100, petAreaW, petBaseH,
		0, 0, 0, 0,
	)
	if hwnd == 0 {
		petCreateMu.Unlock()
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
		petCreateMu.Unlock()
		hctx.Logger.Error("pet window: DwmEnableBlurBehindWindow failed: 0x%x", hr)
		procDestroyWindow.Call(hwnd)
		return
	}

	pw := &petWindow{hctx: hctx, hwnd: hwnd, scale: 1.0}
	chromium := edge.NewChromium()
	pw.chromium = chromium
	chromium.MessageCallback = func(msg string) { petOnMessage(pw, msg) }
	if !chromium.Embed(hwnd) {
		petCreateMu.Unlock()
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
			petCreateMu.Unlock()
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
	// ENV/Embed race window is over — release so next rapid toggle doesn't block.
	petCreateMu.Unlock()

	// Message pump: runs until WM_DESTROY -> PostQuitMessage.
	for petPumpOnce() {
	}
}

// petPumpOnce dispatches one queued message; returns false on WM_QUIT/error.

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
