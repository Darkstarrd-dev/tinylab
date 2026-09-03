//go:build !tray && !webview

package main

import (
	"github.com/tinylab/tinylab/internal/app"
)

// runHostLoop blocks the main goroutine until an OS signal (SIGINT/SIGTERM) is
// received or the UI requests shutdown via POST /api/shutdown (quit channel).
// This is the original console-host behavior.
func runHostLoop(hctx *app.HostContext) {
	runHostLoopConsole(hctx)
}
