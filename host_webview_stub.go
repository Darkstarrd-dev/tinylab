//go:build tray && windows && !webview

package main

import (
	"github.com/tinyrouter/tinyrouter/internal/app"
)

// addWebviewMenuItem when the `webview` tag is NOT set is a no-op: the tray
// menu omits the "独立窗口" entry. Returns nil — caller ignores the value.
// This stub keeps host_tray_windows.go build-tag-agnostic.
func addWebviewMenuItem(hctx *app.HostContext) interface{} { return nil }

// i18n + assistant toggle stubs (webview tag absent — no webview binding, menu i18n is a no-op).
func setTrayConsoleItem(m interface{}) {}
func setTrayQuitItem(m interface{}) {}
func registerTrayLangBinding() {}
func applyTrayLang(lang string) {}
func currentTrayLang() string { return "en" }
func setTrayLang(lang string) {}
