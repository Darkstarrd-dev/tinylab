package app

import (
	"github.com/tinylab/tinylab/internal/console"
)

// HostContext carries everything the host loop needs to drive exit + UI without
// leaking platform specifics (tray/webview/console) back into the app package.
// It is built by App.Run and handed to the host loop (supplied by package main,
// which is build-tag-gated for systray/webview support).
type HostContext struct {
	Logger *console.Logger
	// ConsoleURL is the full URL to the admin UI (e.g. http://127.0.0.1:7700).
	ConsoleURL string
	SM         *ServerManager
	// Quit returns a channel that closes when the UI requests shutdown
	// (POST /api/shutdown).
	Quit func() <-chan struct{}
}
