package main

import (
	"os"
	"os/signal"
	"syscall"

	"github.com/tinylab/tinylab/internal/app"
)

// runHostLoopConsole blocks on OS signal (SIGINT/SIGTERM) or UI-triggered
// shutdown via the quit channel. Shared by console-host builds and by
// non-Windows platform tray/webview builds as a fallback.
func runHostLoopConsole(hctx *app.HostContext) {
	quitSig := make(chan os.Signal, 1)
	signal.Notify(quitSig, syscall.SIGINT, syscall.SIGTERM)

	select {
	case <-quitSig:
		hctx.Logger.Info("shutting down (signal)...")
	case <-hctx.Quit():
		hctx.Logger.Info("shutting down (UI)...")
	}
}
