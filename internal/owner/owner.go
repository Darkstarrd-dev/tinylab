// Package owner provides the per-request owner identity used to bind
// temporary resources (path grants, archive assets, editor files) to the
// browser session that created them. The owner is a cryptographically random
// cookie value issued lazily by the middleware; clients never submit an owner
// themselves, and the server treats it as an unguessable capability namespace.
//
// Two independent browser sessions receive two distinct owner values, so a
// resource created under one owner can never be read, modified, released, or
// packed by another session even when the random resource ID is known.
package owner

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"time"
)

// CookieName is the name of the HttpOnly owner cookie.
const CookieName = "tinyrouter_owner"

// tokenBytes is the entropy of one owner value (32 bytes = 256 bits).
const tokenBytes = 32

// maxAge bounds how long a browser keeps the owner cookie. Asset TTLs are
// shorter (see archive.DefaultTempTTL), so a stale cookie that outlives its
// assets simply resolves to an empty resource namespace.
const maxAge = 30 * 24 * time.Hour

type ctxKey struct{}

// Middleware ensures every request carries an owner identity: a valid owner
// cookie is stamped into the request context; a missing or malformed one is
// replaced with a fresh random value and set on the response. The middleware
// never rejects a request — an anonymous caller simply receives its own
// isolated namespace.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		value := ""
		if c, err := r.Cookie(CookieName); err == nil {
			if Valid(c.Value) {
				value = c.Value
			}
		}
		if value == "" {
			value = newOwnerID()
			http.SetCookie(w, &http.Cookie{
				Name:     CookieName,
				Value:    value,
				Path:     "/",
				HttpOnly: true,
				SameSite: http.SameSiteLaxMode,
				MaxAge:   int(maxAge.Seconds()),
			})
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, value)))
	})
}

// From returns the owner identity stamped by Middleware, or "" when the
// request never passed through the middleware.
func From(ctx context.Context) string {
	v, _ := ctx.Value(ctxKey{}).(string)
	return v
}

// Valid reports whether s is a well-formed owner value. The check is purely
// structural: validity does not confer authority, it only distinguishes a
// cookie this process issued from a malformed or truncated value.
func Valid(s string) bool {
	if len(s) != tokenBytes*2 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// newOwnerID returns a random 256-bit hex owner value. crypto/rand failure is
// treated as unrecoverable (the process cannot build a safe isolation
// boundary without randomness).
func newOwnerID() string {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		panic("owner: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}
