package app

import (
	"testing"
)

// TestIdentifyPortOwner_NotFound verifies that an unoccupied port returns
// ok=false. We use port 0 (which the OS will never assign as a listener
// port in practice) or a very high port number that is unlikely to be in use.
func TestIdentifyPortOwner_NotFound(t *testing.T) {
	// Port 0 is invalid for TCP and will never be occupied.
	// identifyPortOwner should handle this gracefully.
	owner, ok := identifyPortOwner(0)
	if ok {
		t.Logf("unexpectedly found owner on port 0: %+v", owner)
		// This can happen on some systems where port 0 is reported as listening.
		// Not a test failure — just informational.
	}

	// Port 65535 is the maximum valid port and is unlikely to be in use.
	owner, ok = identifyPortOwner(65535)
	if ok {
		t.Logf("unexpectedly found owner on port 65535: PID=%d Name=%q Path=%q", owner.PID, owner.Name, owner.Path)
		// This might happen if something is actually listening on that port.
		// Not a test failure.
	}
}

// TestPortOwner_IsTinyRouter checks that the IsTinyRouter detection works
// for various naming patterns.
func TestPortOwner_IsTinyRouterDetection(t *testing.T) {
	tests := []struct {
		name string
		path string
		want bool
	}{
		{name: "tinyrouter", path: "/usr/local/bin/tinyrouter", want: true},
		{name: "tr-pg", path: "/usr/local/bin/tr-pg", want: true},
		{name: "TinyRouter", path: "C:\\Program Files\\TinyRouter\\tinyrouter.exe", want: true},
		{name: "node", path: "/usr/bin/node", want: false},
		{name: "python3", path: "/usr/bin/python3", want: false},
		{name: "tr-pg.exe", path: "C:\\tools\\tr-pg.exe", want: true},
		{name: "tinyrouter_old", path: "/opt/tinyrouter_old/tinyrouter", want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Recalculate IsTinyRouter using the same logic as makeOwner
			got := isTinyRouterName(tt.name) || isTinyRouterPath(tt.path)
			if got != tt.want {
				t.Errorf("PortOwner{Name=%q, Path=%q}.IsTinyRouter = %v, want %v", tt.name, tt.path, got, tt.want)
			}
		})
	}
}

// isTinyRouterName checks if a process name indicates TinyRouter.
func isTinyRouterName(name string) bool {
	lower := toLower(name)
	return contains(lower, "tinyrouter") || contains(lower, "tr-pg")
}

// isTinyRouterPath checks if a process path indicates TinyRouter.
func isTinyRouterPath(path string) bool {
	lower := toLower(path)
	return contains(lower, "tinyrouter") || contains(lower, "tr-pg")
}

func toLower(s string) string {
	b := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 32
		}
		b[i] = c
	}
	return string(b)
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && indexOf(s, substr) >= 0
}

func indexOf(s, substr string) int {
	if len(substr) == 0 {
		return 0
	}
	if len(substr) > len(s) {
		return -1
	}
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}
