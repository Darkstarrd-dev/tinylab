//go:build windows

package browserlaunch

import (
	"os/exec"
	"syscall"
)

// prepare hides the console window of a spawned browser stub. A browser is a
// GUI process so this is normally a no-op, but a forwarded launch can flash a
// console when the host build is a console build.
func prepare(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
