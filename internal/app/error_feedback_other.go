//go:build tray && !windows

package app

import (
	"fmt"
	"os"
)

// FeedbackFatalError writes the error to stderr and the error log file.
// Non-Windows tray builds have no native MessageBox, so stderr is the
// fallback. The caller is expected to call log.Fatalf or os.Exit after.
func FeedbackFatalError(configDir, msg string) {
	fmt.Fprintln(os.Stderr, msg)
	writeErrorLog(configDir, msg)
}

// feedbackPortConflict reports a port conflict. Non-Windows tray builds
// have no native dialog, so we write to stderr and the error log, and
// return false (no kill) since the user can resolve manually.
func feedbackPortConflict(configDir string, port int, owner PortOwner) (shouldKill bool) {
	var msg string
	if owner.IsTinyRouter {
		msg = fmt.Sprintf("检测到另一个 TinyRouter 实例运行中（PID %d，路径 %s）。是否关闭它并接管端口 %d？\n请关闭该实例后重试，或修改 config.yaml 的 port 字段。", owner.PID, owner.Path, port)
	} else {
		msg = fmt.Sprintf("端口 127.0.0.1:%d 被 %s (PID %d, 路径 %s) 占用。\n请关闭该程序或修改 config.yaml 的 port 字段。", port, owner.Name, owner.PID, owner.Path)
	}
	fmt.Fprintln(os.Stderr, msg)
	writeErrorLog(configDir, msg)
	return false
}
