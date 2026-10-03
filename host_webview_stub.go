//go:build tray && windows && !webview

package main

import (
	"github.com/tinylab/tinylab/internal/app"
)

// addWebviewMenuItem when the `webview` tag is NOT set is a no-op: the tray
// menu omits the "开启/关闭控制台" entry. Returns nil — caller ignores the
// value. This stub keeps host_tray_windows.go build-tag-agnostic.
func addWebviewMenuItem(hctx *app.HostContext) interface{} { return nil }

// i18n stubs (webview tag absent — no webview binding, menu i18n is a no-op).
// The hardcoded Chinese titles in host_tray_windows.go are the only labels.
func setTrayBrowserItem(m interface{}) {}
func setTrayQuitItem(m interface{})    {}

func applyTrayLang(lang string) {}
func currentTrayLang() string   { return "en" }
func setTrayLang(lang string)   {}
