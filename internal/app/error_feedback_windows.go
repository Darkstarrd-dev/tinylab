//go:build tray && windows

package app

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	user32          = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW = user32.NewProc("MessageBoxW")
	procMessageBeep = user32.NewProc("MessageBeep")
)

const (
	mbOK           = 0x00000000
	mbOKCancel     = 0x00000001
	mbYesNo        = 0x00000004
	mbIconError    = 0x00000010
	mbIconQuestion = 0x00000020
	idYes          = 6
)

// messageBox wraps the Win32 MessageBoxW API.
func messageBox(hwnd uintptr, text, caption string, mbType uintptr) int {
	tPtr, _ := syscall.UTF16PtrFromString(text)
	cPtr, _ := syscall.UTF16PtrFromString(caption)
	ret, _, _ := procMessageBoxW.Call(hwnd, uintptr(unsafe.Pointer(tPtr)), uintptr(unsafe.Pointer(cPtr)), mbType)
	return int(ret)
}

// FeedbackFatalError shows a Windows MessageBox with the error, then writes
// to the error log. The caller is expected to call log.Fatalf or os.Exit after.
func FeedbackFatalError(configDir, msg string) {
	// Write log first so it's persisted even if the user doesn't dismiss the dialog
	writeErrorLog(configDir, msg)
	// Play a system beep to draw attention
	procMessageBeep.Call(0xFFFFFFFF) // MB_ICONERROR beep

	messageBox(0, msg, "TinyRouter 启动失败", mbOK|mbIconError)
}

// feedbackPortConflict shows a dialog asking the user how to handle the port
// conflict. If the owner is another TinyRouter instance, it offers a "Yes/No"
// choice to kill it. Otherwise it shows an informational OK dialog.
func feedbackPortConflict(configDir string, port int, owner PortOwner) (shouldKill bool) {
	if owner.IsTinyRouter {
		msg := fmt.Sprintf("检测到另一个 TinyRouter 实例正在运行（PID %d，路径 %s）。\n\n是否关闭它并接管端口 %d？", owner.PID, owner.Path, port)
		writeErrorLog(configDir, msg)
		result := messageBox(0, msg, "TinyRouter 启动失败", mbYesNo|mbIconQuestion)
		shouldKill = (result == idYes)
		if shouldKill {
			writeErrorLog(configDir, fmt.Sprintf("用户确认关闭另一个 TinyRouter (PID %d) 并接管端口 %d", owner.PID, port))
		} else {
			writeErrorLog(configDir, "用户选择不关闭另一个 TinyRouter，启动终止")
		}
	} else {
		msg := fmt.Sprintf("端口 127.0.0.1:%d 被 %s (PID %d, 路径 %s) 占用。\n\n请关闭该程序或修改 config.yaml 中的 port 字段，然后重新启动 TinyRouter。", port, owner.Name, owner.PID, owner.Path)
		writeErrorLog(configDir, msg)
		messageBox(0, msg, "TinyRouter 启动失败", mbOK|mbIconError)
	}
	return shouldKill
}
