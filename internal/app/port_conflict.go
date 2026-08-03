package app

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"
	"time"
)

// isAddrInUse reports whether the given error is a TCP address-in-use error.
func isAddrInUse(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "address already in use") ||
		strings.Contains(msg, "only one usage of each socket address")
}

// resolvePortConflict checks which process is using the port and, if it is
// another TinyRouter instance, asks the user whether to kill it. Returns true
// if the caller should retry listening (after killing the conflicting process).
func resolvePortConflict(configDir string, port int) (retry bool) {
	owner, ok := identifyPortOwner(port)
	if !ok {
		// Could not identify the owner; just report the error.
		FeedbackFatalError(configDir, fmt.Sprintf("端口 127.0.0.1:%d 被占用，但无法识别占用进程。请关闭占用程序或修改 config.yaml 的 port 字段。", port))
		return false
	}

	shouldKill := feedbackPortConflict(configDir, port, owner)
	if !shouldKill || !owner.IsTinyRouter {
		return false
	}

	// Attempt to kill the other TinyRouter instance.
	proc, err := os.FindProcess(owner.PID)
	if err != nil {
		FeedbackFatalError(configDir, fmt.Sprintf("无法找到进程 %d 以关闭它: %v", owner.PID, err))
		return false
	}

	if err := proc.Kill(); err != nil {
		FeedbackFatalError(configDir, fmt.Sprintf("无法关闭进程 %d: %v", owner.PID, err))
		return false
	}

	// Wait for the port to be released.
	time.Sleep(500 * time.Millisecond)
	return true
}
