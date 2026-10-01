//go:build !playground

package web

import "embed"

// Static embeds the core UI assets (the admin SPA: app/api/i18n/endpoint/providers/
// combos/usage/console JS, style.css, logos, favicons, manifest, and a no-playground
// index.html variant). Playground-specific assets (vendor JS/CSS, KaTeX fonts,
// playground.js, playground.css) are NOT in this FS; they live in
// web/playground/static-pg and are only embedded when the `playground` build tag
// is set. See web/playground/embed_playground.go and embed_playground_stub.go.
//
// The Playground runtime toggle is controlled by Config.EnablePlayground in
// config.yaml; even with the `playground` build tag the user can disable the
// feature at runtime to serve index-nopg.html.
//
//go:embed all:static
var Static embed.FS

// PlaygroundCompiled reports whether the playground module was compiled into
// this binary (build tag `playground` set). Always false in this file variant.
func PlaygroundCompiled() bool { return false }
