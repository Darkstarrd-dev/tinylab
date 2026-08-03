//go:build windows

package download

import (
	"os/exec"

	"github.com/tinyrouter/tinyrouter/internal/procutil"
)

// killProcessTree 终止进程及其整个子进程树（Windows）。
// 使用 taskkill /PID <pid> /T /F。
func killProcessTree(pid int) error {
	procutil.KillProcessGroup(pid)
	return nil
}

// setupProcessGroup 在 Windows 上为子进程设置创建标志，避免弹出可见控制台窗口。
// 保留 CREATE_NEW_PROCESS_GROUP 以便 taskkill /T 能终止整棵进程树。
func setupProcessGroup(cmd *exec.Cmd) {
	_ = procutil.SetProcessGroup(cmd)
}
