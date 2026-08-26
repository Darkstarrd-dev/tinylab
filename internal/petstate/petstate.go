// Package petstate carries the desktop pet's runtime switches between the
// settings API (which writes them) and the host pet window (which reads them).
// It exists to avoid an import cycle: internal/api/settings and the host
// loop both import it, and it depends on nothing.
package petstate

import "sync/atomic"

var (
	enabled  atomic.Bool  // desktop pet feature switch (default true)
	debug    atomic.Bool  // pet/assistant debug logging (default false)
	closeAll atomic.Value // func() — closes every open pet window
	open     atomic.Value // func() — opens a pet window if none is up
	hideAll  atomic.Value // func() — hides the pet without destroying WebView2
	showAll  atomic.Value // func() — re-shows a hidden pet window
)

// SetOpen registers the host callback that opens a pet window.
func SetOpen(f func()) { open.Store(f) }

// Open invokes the registered open callback (no-op if none).
func Open() {
	if f, ok := open.Load().(func()); ok && f != nil {
		f()
	}
}

// SetEnabled flips the pet feature switch.
func SetEnabled(v bool) { enabled.Store(v) }

// Enabled reports whether the pet feature is on.
func Enabled() bool { return enabled.Load() }

// SetDebug flips pet debug logging.
func SetDebug(v bool) { debug.Store(v) }

// Debug reports whether pet debug logging is on.
func Debug() bool { return debug.Load() }

// SetCloseAll registers the host callback that closes every open pet window.
func SetCloseAll(f func()) { closeAll.Store(f) }

// CloseAll invokes the registered close callback (no-op if none).
func CloseAll() {
	if f, ok := closeAll.Load().(func()); ok && f != nil {
		f()
	}
}

// SetHideAll registers the hide callback.
func SetHideAll(f func() bool) { hideAll.Store(f) }

// HideAll hides the pet window if one exists. Returns true if a handler ran.
func HideAll() bool {
	if f, ok := hideAll.Load().(func() bool); ok && f != nil {
		return f()
	}
	return false
}

// SetShowAll registers the show callback.
func SetShowAll(f func() bool) { showAll.Store(f) }

// ShowAll re-shows a hidden pet window. Returns true if a handler ran and made a window visible.
func ShowAll() bool {
	if f, ok := showAll.Load().(func() bool); ok && f != nil {
		return f()
	}
	return false
}
