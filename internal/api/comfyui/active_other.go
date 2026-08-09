//go:build !windows

package comfyui

import "io/fs"

// readActiveWorkflow is unavailable outside Windows: ComfyUI Desktop stores
// the last-active workflow path in its Chromium LevelDB store under
// %APPDATA%, which has no equivalent on other platforms.
func readActiveWorkflow() (*activeWorkflow, error) {
	return nil, fs.ErrNotExist
}
