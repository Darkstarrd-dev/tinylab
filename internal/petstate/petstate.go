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
