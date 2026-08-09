package auth

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"
)

type loginAttempt struct {
	failCount    int
	firstFail    time.Time
	blockedUntil time.Time
}

type loginRateLimiter struct {
	mu       sync.Mutex
	attempts map[string]*loginAttempt
}

const (
	maxLoginAttempts   = 5
	loginWindow        = 1 * time.Minute
	loginBlockDuration = 1 * time.Minute
)

func newLoginRateLimiter() *loginRateLimiter {
	return &loginRateLimiter{
		attempts: make(map[string]*loginAttempt),
	}
}

func (l *loginRateLimiter) cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	for ip, a := range l.attempts {
		if now.After(a.blockedUntil) && now.Sub(a.firstFail) > loginWindow {
			delete(l.attempts, ip)
		}
	}
}

func (l *loginRateLimiter) IsBlocked(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, exists := l.attempts[ip]
	if !exists {
		return false
	}
	if time.Now().Before(a.blockedUntil) {
		return true
	}
	if time.Now().Sub(a.firstFail) > loginWindow {
		delete(l.attempts, ip)
		return false
	}
	return false
}

func (l *loginRateLimiter) RecordFailure(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	a, exists := l.attempts[ip]
	if !exists {
		l.attempts[ip] = &loginAttempt{
			failCount: 1,
			firstFail: now,
		}
		return
	}
	if now.Sub(a.firstFail) > loginWindow {
		// Reset window
		a.failCount = 1
		a.firstFail = now
		a.blockedUntil = time.Time{}
		return
	}
	a.failCount++
	if a.failCount >= maxLoginAttempts {
		a.blockedUntil = now.Add(loginBlockDuration)
	}
}

func (l *loginRateLimiter) RecordSuccess(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, ip)
}

// loginGuard carries the limiter and the resolved client IP to the wrapped
// handler so a successful login is recorded explicitly — never inferred from
// a response status code or an implicit 200 Write. This closes the
// malformed-JSON (400) and implicit-Write paths that previously reset the
// failure counter and let an attacker bypass the brute-force threshold (F-26).
type loginGuard struct {
	limiter *loginRateLimiter
	ip      string
}

// Success clears the failure counter for this client after a genuine
// successful login. It is called only by LoginHandler on the correct-password
// path.
func (g *loginGuard) Success() {
	g.limiter.RecordSuccess(g.ip)
}

type loginGuardCtxKey struct{}

func loginGuardFrom(ctx context.Context) (*loginGuard, bool) {
	g, ok := ctx.Value(loginGuardCtxKey{}).(*loginGuard)
	return g, ok
}

type loginResponseWriter struct {
	http.ResponseWriter
	limiter *loginRateLimiter
	ip      string
}

// WriteHeader records failures for every non-success status. Success is never
// inferred here: the implicit-200 path (handler writes a body without calling
// WriteHeader) bypasses this override entirely and therefore never resets the
// counter, and the only way to reset it is LoginHandler's explicit
// loginGuard.Success call.
func (w *loginResponseWriter) WriteHeader(code int) {
	if code >= http.StatusBadRequest {
		w.limiter.RecordFailure(w.ip)
	}
	w.ResponseWriter.WriteHeader(code)
}

func (l *loginRateLimiter) Wrap(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		l.cleanup()
		ip := clientIP(r)
		if l.IsBlocked(ip) {
			http.Error(w, "too many login attempts", http.StatusTooManyRequests)
			return
		}
		lw := &loginResponseWriter{ResponseWriter: w, limiter: l, ip: ip}
		g := &loginGuard{limiter: l, ip: ip}
		ctx := context.WithValue(r.Context(), loginGuardCtxKey{}, g)
		next(lw, r.WithContext(ctx))
	}
}

// clientIP strips the port from r.RemoteAddr. All management traffic is local
// (127.0.0.1 / ::1 / localhost), so this yields a stable per-client key.
func clientIP(r *http.Request) string {
	ip := r.RemoteAddr
	if idx := strings.LastIndex(ip, ":"); idx >= 0 {
		ip = ip[:idx]
	}
	return ip
}
