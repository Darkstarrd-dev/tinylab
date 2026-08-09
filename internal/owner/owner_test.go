package owner

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMiddleware_IssuesStableOwnerPerSession(t *testing.T) {
	var got []string
	handler := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, From(r.Context()))
	}))

	// Two requests from one "browser" (shared cookie jar) must resolve the
	// same owner; a second jar gets a different one.
	jar := newCookieJar()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	handler.ServeHTTP(rec, req)
	jar.add(rec)
	req2 := httptest.NewRequest(http.MethodGet, "/", nil)
	req2.Header.Set("Cookie", jar.header())
	handler.ServeHTTP(httptest.NewRecorder(), req2)

	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodGet, "/", nil)
	handler.ServeHTTP(rec3, req3)

	if len(got) != 3 {
		t.Fatalf("middleware stamped %d requests, want 3", len(got))
	}
	if got[0] == "" || got[0] != got[1] {
		t.Fatalf("same session owner must be stable: %q vs %q", got[0], got[1])
	}
	if got[0] == got[2] {
		t.Fatalf("distinct sessions must not share an owner")
	}
}

func TestMiddleware_ReplacesMalformedCookie(t *testing.T) {
	var stamped string
	handler := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stamped = From(r.Context())
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Cookie", CookieName+"=not-a-valid-owner-value")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if !Valid(stamped) {
		t.Fatalf("malformed cookie must be replaced with a valid owner, got %q", stamped)
	}
	if rec.Header().Get("Set-Cookie") == "" {
		t.Fatal("middleware must set the owner cookie")
	}
}

func TestValid(t *testing.T) {
	valid := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if !Valid(valid) {
		t.Fatalf("64-hex value must be valid")
	}
	for _, bad := range []string{"", "abc", strings.Repeat("z", 64), strings.Repeat("0", 63)} {
		if Valid(bad) {
			t.Errorf("Valid(%q) = true, want false", bad)
		}
	}
}

func TestFrom_EmptyWithoutMiddleware(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if From(req.Context()) != "" {
		t.Fatal("From must return empty when the middleware did not run")
	}
}

// cookieJar is a minimal single-cookie jar for the middleware tests.
type cookieJar struct {
	value string
}

func newCookieJar() *cookieJar { return &cookieJar{} }

func (c *cookieJar) add(rec *httptest.ResponseRecorder) {
	for _, sc := range rec.Result().Cookies() {
		if sc.Name == CookieName {
			c.value = sc.Value
		}
	}
}

func (c *cookieJar) header() string { return CookieName + "=" + c.value }
