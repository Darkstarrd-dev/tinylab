//go:build !windows

package monitor

import (
	"os/exec"

	"github.com/tinyrouter/tinyrouter/internal/procutil"
)

func setProcessGroup(cmd *exec.Cmd) {
	_ = procutil.SetProcessGroup(cmd)
}

// killProcessGroup sends SIGTERM to the process group, then escalates to
// SIGKILL after a 2-second grace period. This ensures stubborn monitor
// commands that ignore SIGTERM are force-killed, preventing the Manager from
// getting stuck in "running" state forever.
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	procutil.KillProcessGroup(cmd.Process.Pid)
}