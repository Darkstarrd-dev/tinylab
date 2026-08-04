// Package customheaders applies provider-configured custom request headers
// to outbound upstream requests (proxy forwards, GET task polling, management
// probes, and combo speed tests).
package customheaders

import (
	"net/http"
	"strings"
)

// Config carries the per-provider custom header settings. A zero Config is a
// safe no-op: nothing is applied.
type Config struct {
	// Enabled gates application of Headers.
	Enabled bool
	// Headers maps header name to value.
	Headers map[string]string
}

// Apply sets each configured custom header on dst. It is a no-op when enabled
// is false or headers is empty. Names are trimmed; empty names are ignored.
// Names or values containing CR/LF are skipped to prevent header injection.
// Values replace any existing header with the same name (Set semantics), so
// callers that must keep a hardcoded header authoritative apply it after this
// call.
func Apply(dst http.Header, enabled bool, headers map[string]string) {
	if !enabled || len(headers) == 0 {
		return
	}
	for name, value := range headers {
		name = strings.TrimSpace(name)
		if name == "" || !validHeaderName(name) {
			continue
		}
		if strings.ContainsAny(name, "\r\n") || strings.ContainsAny(value, "\r\n") {
			continue
		}
		dst.Set(name, value)
	}
}

func validHeaderName(name string) bool {
	for i := 0; i < len(name); i++ {
		c := name[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') {
			continue
		}
		switch c {
		case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
		default:
			return false
		}
	}
	return name != ""
}
