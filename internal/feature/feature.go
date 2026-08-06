// Package feature declares TinyRouter's compile-time feature surface as a
// single honest manifest: what each feature is, what it depends on, which
// static assets it owns, and whether its code is actually compiled into this
// binary.
//
// # Status (P5 boundary, archive_compatibility_plan.md §11)
//
// This package is the registrar/asset-manifest half of the P5 "feature tags
// and build profiles" work. It does NOT claim pruning that does not exist:
//
//   - No `feature_*` build tags exist yet. Every feature package (gallery,
//     download, mediaedit, filetransfer, textreview, archive, archivetool,
//     api/*) compiles unconditionally today, so every feature is registered
//     compiled by default. The ONLY genuinely tag-gated surface today is the
//     `playground` static embed (web/embed_playground.go), and its real
//     compiled state is reported here via SetCompiled(Playground, ...) from
//     internal/api/router.go.
//
//   - Route registration (internal/api/router.go) and component construction
//     (internal/app/app.go) consult Enabled() so the manifest is the single
//     drop point when feature_* tags land. Default builds keep every feature
//     enabled, so wiring this manifest in changes no observable behavior.
//
// # What is still missing (exact P5 blockers)
//
//  1. feature_* build tags + stub files per package (plan §11.2 table).
//  2. Tagging the packages themselves (internal/gallery, internal/download,
//     internal/mediaedit, internal/filetransfer, internal/textreview,
//     internal/archive, internal/archivetool, internal/api/*) so imports in
//     router.go/app.go become conditional.
//  3. Per-feature go:embed (web/embed.go currently embeds all:static) and
//     index.html/index-nopg.html script-list generation from this manifest
//     (the pages still load every script unconditionally).
//  4. build.ps1/build_mac.ps1 `-Features` parameters (must wait until the
//     tags exist — a script flag without real tags would falsely claim
//     pruning).
//
// Until those land, "feature disabled" only exists as a manifest-level
// declaration for future wiring; it is not yet a real binary state.
package feature

import "sync"

// ID names one compile-time feature. The set mirrors plan §11.2 (plus core,
// which is never pruned).
type ID string

const (
	// Core is the proxy/config/registry/rotation/usage management surface
	// (Monitor/Settings/Console). It is the unconditional base of every build.
	Core ID = "core"

	// Playground is the playground SPA (chat/image/autochat/director/search)
	// plus its attached backends (comfyui proxy, image batch, anysearch). Its
	// static assets (web/playground/static-pg) are embedded only with the
	// `playground` build tag; the Go backends it calls compile unconditionally
	// today (see P5 blocker 2).
	Playground ID = "playground"

	// Download is the yt-dlp download manager, /api/downloads and UI
	// (web/static/download.js).
	Download ID = "download"

	// Archive is ArchiveCore: internal/archive contracts + ZIP adapter +
	// TempStore + /api/archive HTTP surface + web/static/media-bridge.js.
	Archive ID = "archive"

	// ArchiveExternal is the 7z/RAR external-tool layer (internal/archivetool,
	// resolver/runner/exec/parse). Requires Archive.
	ArchiveExternal ID = "archive_external"

	// Gallery is the Gallery UI/API, AI Review and MediaEdit. Requires Archive.
	Gallery ID = "gallery"

	// GIF is the standalone GIF editor page (web/static/gif-editor.js +
	// vendor/gif.js + vendor/gifuct-js). Requires Archive (PNG/archive export
	// and MediaBridge handoff).
	GIF ID = "gif"

	// Editor is the text editor + AI Text Review (editor.js + editor_textreview*).
	Editor ID = "editor"

	// FileTransfer is the temporary file transfer surface (/api/filetransfer,
	// web/static/filetransfer.js).
	FileTransfer ID = "filetransfer"
)

// StaticRoot names the embed root a feature's static assets live under.
type StaticRoot string

const (
	// RootStatic is web/static, embedded in every build (web/embed.go).
	RootStatic StaticRoot = "static"
	// RootPlaygroundPG is web/playground/static-pg, embedded only with the
	// `playground` build tag (web/embed_playground.go). Assets registered here
	// are physically absent from non-playground binaries.
	RootPlaygroundPG StaticRoot = "playground/static-pg"
)

// Feature describes one compile-time feature: identity, dependencies, owned
// static assets, and whether its code is actually compiled into this binary.
type Feature struct {
	ID          ID
	Name        string
	Description string
	// DependsOn lists features that must be enabled for this feature to be
	// usable (plan §11.2 dependency table). Disabling a dependency propagates:
	// Enabled() reports false for every dependent.
	DependsOn []ID
	// StaticRoot is where StaticFiles live (see StaticRoot constants).
	StaticRoot StaticRoot
	// StaticFiles is the feature-owned asset list relative to StaticRoot
	// (scripts referenced by index.html/index-nopg.html or the static file
	// routes). It is the manifest the router consults instead of a hard-coded
	// list.
	StaticFiles []string

	// compiled is the honest compiled flag: true means the feature's code and
	// assets are actually in this binary. Defaults to true at registration
	// (correct today — no feature_* tags exist); SetCompiled overrides it for
	// surfaces with a real build signal (playground embed).
	compiled bool
}

var (
	mu       sync.RWMutex
	features = map[ID]*Feature{}
	order    []ID // registration order, for deterministic iteration
	defaults sync.Once
)

// registerDefaults registers the standard feature set in dependency order.
// The order fixes iteration order for All()/Assets().
func registerDefaults() {
	register(Feature{
		ID: Core, Name: "Core",
		Description: "Proxy/Config/Registry/Rotation/Usage + Monitor/Settings management surface. Never pruned.",
		StaticRoot:  RootStatic,
		StaticFiles: []string{
			"api.js", "app.js", "auth.js", "combos.js", "console.js",
			"fs-api.js", "headerStats.js", "i18n.js", "info_common.js",
			"monitor.js", "monitor_io.js", "monitor_modal.js", "monitor_quota.js",
			"monitor_recent.js", "monitor_state.js", "providers.js", "quickslots.js",
			"settings.js", "settings_modal.js", "settings_shortcuts.js",
			"settings_trace.js", "shortcuts.js", "theme.js",
		},
	})
	register(Feature{
		ID: Playground, Name: "Playground",
		Description: "Playground SPA + attached backends (comfyui proxy, image batch, anysearch). Static assets only with the playground build tag.",
		StaticRoot:  RootPlaygroundPG,
		StaticFiles: []string{
			"playground.js", "pg-i18n.js",
			"pg-core.js", "pg-state.js", "pg-markdown.js",
			"pg-request.js", "pg-stream.js", "pg-comfyui.js", "pg-image-model.js", "pg-image-inspire.js", "pg-image-batch.js", "pg-autochat.js",
			"pg-render.js", "pg-ui.js", "pg-modal.js", "pg-lifecycle.js",
			"pg-setup.js", "pg-director.js", "pg-search.js",
		},
	})
	register(Feature{
		ID: Download, Name: "Download",
		Description: "yt-dlp download manager, /api/downloads and web/static/download.js.",
		StaticRoot:  RootStatic,
		StaticFiles: []string{"download.js"},
	})
	register(Feature{
		ID: Archive, Name: "Archive",
		Description: "ArchiveCore (ZIP read/write + TempStore) + /api/archive HTTP surface + MediaBridge asset registry.",
		StaticRoot:  RootStatic,
		StaticFiles: []string{"media-bridge.js"},
	})
	register(Feature{
		ID: ArchiveExternal, Name: "ArchiveExternal",
		Description: "7z/RAR external-tool layer (internal/archivetool: resolver/runner/exec/parse).",
		DependsOn:   []ID{Archive},
	})
	register(Feature{
		ID: Gallery, Name: "Gallery",
		Description: "Gallery UI/API, AI Review and MediaEdit (web/playground/static-pg/gallery*.js).",
		DependsOn:   []ID{Archive},
		StaticRoot:  RootPlaygroundPG,
		StaticFiles: []string{
			"gallery-state.js", "gallery-io.js", "gallery-layout.js",
			"gallery-tree.js", "gallery-review.js", "gallery-video.js", "gallery-fullscreen.js",
			"gallery-edit.js", "gallery-edit-operations.js", "gallery-edit-batch.js", "gallery.js",
		},
	})
	register(Feature{
		ID: GIF, Name: "GIF",
		Description: "Standalone GIF editor page (web/static/gif-editor.js + gif.js/gifuct-js vendors).",
		DependsOn:   []ID{Archive},
		StaticRoot:  RootStatic,
		StaticFiles: []string{
			"gif-editor.js",
			"vendor/gif.js/gif.js",
			"vendor/gifuct-js/gifuct-js.js",
		},
	})
	register(Feature{
		ID: Editor, Name: "Editor",
		Description: "Text editor + AI Text Review (editor.js + editor_textreview*).",
		StaticRoot:  RootPlaygroundPG,
		StaticFiles: []string{
			"editor-state.js", "editor.js", "editor-logs.js",
			// AI Text Review (load order: split/diff/state first, then steps, then entry).
			"editor_textreview_split.js", "editor_textreview_diff.js", "editor_textreview_state.js",
			"editor_textreview_step1.js", "editor_textreview_step2.js",
			"editor_textreview_step3.js", "editor_textreview_step4.js",
			"editor_textreview.js",
		},
	})
	register(Feature{
		ID: FileTransfer, Name: "FileTransfer",
		Description: "Temporary file transfer surface (/api/filetransfer, web/static/filetransfer.js).",
		StaticRoot:  RootStatic,
		StaticFiles: []string{"filetransfer.js"},
	})
}

// register adds one feature to the manifest. It panics on empty/duplicate IDs
// so manifest mistakes fail fast instead of silently mis-pruning later.
func register(f Feature) {
	if f.ID == "" {
		panic("feature: Register with empty ID")
	}
	mu.Lock()
	defer mu.Unlock()
	if _, dup := features[f.ID]; dup {
		panic("feature: duplicate registration of " + string(f.ID))
	}
	f.compiled = true
	cp := f
	features[f.ID] = &cp
	order = append(order, f.ID)
}

// ensureDefaults registers the standard feature set once on first use. Any
// package may Register additional features or SetCompiled existing ones before
// consulting the manifest.
func ensureDefaults() {
	defaults.Do(registerDefaults)
}

// Register adds a feature to the manifest. It panics on empty or duplicate IDs.
// Registration is additive on top of the standard set; a standard feature can
// be replaced by calling Register with the same ID (the stale registration-order
// entry is dropped so iteration stays duplicate-free).
func Register(f Feature) {
	ensureDefaults()
	mu.Lock()
	defer mu.Unlock()
	if f.ID == "" {
		panic("feature: Register with empty ID")
	}
	if _, exists := features[f.ID]; exists {
		for i, id := range order {
			if id == f.ID {
				order = append(order[:i], order[i+1:]...)
				break
			}
		}
	}
	f.compiled = true
	cp := f
	features[f.ID] = &cp
	order = append(order, f.ID)
}

// SetCompiled overrides the compiled state of a feature after registration. It
// exists for surfaces whose compilation is genuinely gated by an existing
// build signal — today only the playground static embed (web.PlaygroundCompiled,
// reported from internal/api/router.go). Disabling a feature propagates to its
// dependents via Enabled(). Setting an unknown ID is a no-op (callers should
// Get() first).
func SetCompiled(id ID, compiled bool) {
	ensureDefaults()
	mu.Lock()
	defer mu.Unlock()
	if f, ok := features[id]; ok {
		f.compiled = compiled
	}
}

// enabledLocked reports f.compiled && all dependencies enabled. Caller holds mu.
func enabledLocked(f *Feature) bool {
	if !f.compiled {
		return false
	}
	for _, dep := range f.DependsOn {
		d, ok := features[dep]
		if !ok || !enabledLocked(d) {
			return false
		}
	}
	return true
}

// Enabled reports whether the feature's code and assets are compiled into this
// binary and every dependency is enabled. In the default build every feature
// is enabled; this is the single check point the router and app wiring use so
// that adding feature_* tags later only flips manifest state.
func Enabled(id ID) bool {
	ensureDefaults()
	mu.RLock()
	defer mu.RUnlock()
	f, ok := features[id]
	if !ok {
		return false
	}
	return enabledLocked(f)
}

// Get returns a copy of the registered feature.
func Get(id ID) (Feature, bool) {
	ensureDefaults()
	mu.RLock()
	defer mu.RUnlock()
	f, ok := features[id]
	if !ok {
		return Feature{}, false
	}
	return *f, true
}

// All returns a snapshot of the manifest in registration order.
func All() []Feature {
	ensureDefaults()
	mu.RLock()
	defer mu.RUnlock()
	out := make([]Feature, 0, len(order))
	for _, id := range order {
		out = append(out, *features[id])
	}
	return out
}

// Assets returns the static files of every enabled feature rooted at root, in
// registration order. The router uses it to derive the per-root static file
// route list instead of a hard-coded script list.
func Assets(root StaticRoot) []string {
	ensureDefaults()
	mu.RLock()
	defer mu.RUnlock()
	var out []string
	for _, id := range order {
		f := features[id]
		if f.StaticRoot != root || !enabledLocked(f) {
			continue
		}
		out = append(out, f.StaticFiles...)
	}
	return out
}
