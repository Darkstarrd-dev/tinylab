//go:build !windows

package browserlaunch

import "os/exec"

// prepare is a no-op outside Windows (no hidden-console concern).
func prepare(cmd *exec.Cmd) {}
