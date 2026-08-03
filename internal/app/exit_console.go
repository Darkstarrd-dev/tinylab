//go:build !tray

package app

// forceExitIfNeeded is a no-op on the default console host: Shutdown returns
// normally and main exits via return. Tray/webview builds override this to
// os.Exit(0) to prevent zombie processes when message loops resist termination.
func forceExitIfNeeded() {}
