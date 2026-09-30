package jethub

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newMockServer is the shared httptest helper for provider mock servers.
func newMockServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

// ctxBackground keeps call sites terse in tests.
func ctxBackground() context.Context { return context.Background() }
