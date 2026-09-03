//go:build tray && webview && !windows

package main

import (
	"github.com/tinylab/tinylab/internal/app"
)

// On non-Windows platforms the native WebView2 window is unavailable.
// `webview` tag MUST always be paired with `tray` (build.ps1 enforces this),
// otherwise runHostLoop is undefined. This constraint is reflected by the
// build tag `tray && webview && !windows` above; building with `-tags webview`
// alone (without tray) deliberately fails with a clear "runHostLoop undefined"
// compile error.
//
// (Linux/macOS support would require webview/webview with CGO; intentionally
// out of scope for this iteration.)
func addWebviewMenuItem(hctx *app.HostContext) interface{} { return nil }
