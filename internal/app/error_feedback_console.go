//go:build !tray

package app

import (
	"fmt"
	"os"
)

// FeedbackFatalError writes a fatal error message to stderr and the error log
// file. For the console variant, stderr is visible to the user so no dialog is
// needed. The caller is expected to call log.Fatalf or os.Exit after this.
func FeedbackFatalError(configDir, msg string) {
	fmt.Fprintln(os.Stderr, msg)
	writeErrorLog(configDir, msg)
}

// feedbackPortConflict reports a port conflict. For console builds the user
// can see the error on stderr; we write the status and return false (no kill)
// since the user can resolve the conflict manually.
func feedbackPortConflict(configDir string, port int, owner PortOwner) (shouldKill bool) {
	var msg string
	if owner.IsTinyRouter {
		msg = fmt.Sprintf("检测到另一个 TinyRouter 实例运行中（PID %d，路径 %s）。是否关闭它并接管端口 %d？\n请关闭该实例后重试，或修改 config.yaml 的 port 字段。", owner.PID, owner.Path, port)
	} else {
		msg = fmt.Sprintf("端口 127.0.0.1:%d 被 %s (PID %d, 路径 %s) 占用。\n请关闭该程序或修改 config.yaml 的 port 字段。", port, owner.Name, owner.PID, owner.Path)
	}
	fmt.Fprintln(os.Stderr, msg)
	writeErrorLog(configDir, msg)
	// Console variant: user can see the error, no kill dialog.
	return false
}
