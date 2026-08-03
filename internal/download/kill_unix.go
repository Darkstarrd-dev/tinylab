//go:build !windows

package download

import (
	"os/exec"

	"github.com/tinyrouter/tinyrouter/internal/procutil"
)

// killProcessTree terminates the process group by delegating to internal/procutil.
func killProcessTree(pid int) error {
	return procutil.KillProcessGroup(pid)
}

// setupProcessGroup 让子进程成为独立进程组的组长（Unix），
// 以便 killProcessTree 能整组终止（含 ffmpeg 子进程）。
func setupProcessGroup(cmd *exec.Cmd) {
	_ = procutil.SetProcessGroup(cmd)
}
