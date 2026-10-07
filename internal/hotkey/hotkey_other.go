//go:build !windows

package hotkey

import "github.com/tinylab/tinylab/internal/console"

// startPump is a no-op off Windows: RegisterHotKey is a Win32 API and no
// other platform bridge exists yet (tray builds on Linux/macOS already fall
// back to console behavior). State set via SetBindings/SetActionHandler is
// still kept so behavior is consistent if support lands later.
func startPump(logger *console.Logger) {}

// stopPump mirrors the Windows pump shutdown; nothing to do here.
func stopPump() {}

// wakePump mirrors the Windows reload nudge; nothing to do here.
func wakePump() {}
