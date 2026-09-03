//go:build tray && !windows

package main

import (
	"github.com/tinylab/tinylab/internal/app"
)

// runHostLoop on non-Windows tray builds falls back to console behavior: there
// is no systray wired here yet. Linux/macOS tray support can be added later
// without touching main.go.
func runHostLoop(hctx *app.HostContext) {
	runHostLoopConsole(hctx)
}
