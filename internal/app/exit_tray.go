//go:build tray

package app

import "os"

// forceExitIfNeeded forces immediate process exit on tray/webview builds.
// systray and WebView2 message loops can resist termination on Windows,
// leaving a zombie process. All cleanup (HTTP drain, state flush, lock
// release) has already completed before this is called.
func forceExitIfNeeded() {
	os.Exit(0)
}
