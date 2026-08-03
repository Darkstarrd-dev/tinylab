//go:build windows

package procutil

import (
	"os/exec"
	"strconv"
	"syscall"
)

const createNoWindow = 0x08000000

// KillProcessGroup terminates the process and its entire child process tree
// (Windows) using taskkill /T /F.
func KillProcessGroup(pid int) error {
	return exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
}

// SetProcessGroup configures the command with CREATE_NEW_PROCESS_GROUP so that
// taskkill /T can terminate the entire process tree, and sets CREATE_NO_WINDOW
// to prevent the spawned command from flashing a visible console window.
func SetProcessGroup(cmd *exec.Cmd) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createNoWindow,
	}
	return nil
}
