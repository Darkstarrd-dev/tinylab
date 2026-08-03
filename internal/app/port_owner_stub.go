//go:build never

package app

// identifyPortOwner is a stub that is never compiled (build tag "never" is
// never set). The real implementations are in port_owner_windows.go (windows)
// and port_owner_unix.go (!windows).
func identifyPortOwner(port int) (PortOwner, bool) {
	return PortOwner{}, false
}
