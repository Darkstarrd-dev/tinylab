//go:build windows

package monitor

import (
	"os/exec"

	"github.com/tinyrouter/tinyrouter/internal/procutil"
)

func setProcessGroup(cmd *exec.Cmd) {
	_ = procutil.SetProcessGroup(cmd)
}

func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	procutil.KillProcessGroup(cmd.Process.Pid)
}