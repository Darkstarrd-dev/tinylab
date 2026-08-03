//go:build !windows

package procutil

import (
	"os/exec"
	"syscall"
	"time"
)

// KillProcessGroup terminates the process group by first sending SIGTERM, then
// escalating to SIGKILL after a 2-second grace period if the group is still
// alive. This ensures stubborn child processes that ignore SIGTERM are
// force-killed, preventing zombie processes.
func KillProcessGroup(pid int) {
	pgid, err := syscall.Getpgid(pid)
	if err != nil {
		return
	}
	// Send SIGTERM to the entire process group.
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	// SIGKILL fallback: after the grace period, check if the group still
	// exists and force-kill it if so.
	go func() {
		time.Sleep(2 * time.Second)
		// Signal 0 checks process existence without actually sending a signal.
		if err := syscall.Kill(-pgid, 0); err == nil {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}()
}

// SetProcessGroup configures the command to become a new process group leader
// (Unix) so KillProcessGroup can terminate the entire group.
func SetProcessGroup(cmd *exec.Cmd) error {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	return nil
}
