package auth

import (
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

type loginResponseWriter struct {
	http.ResponseWriter
	limiter *loginRateLimiter
	ip      string
}

func (w *loginResponseWriter) WriteHeader(code int) {
	if code == http.StatusUnauthorized {
		w.limiter.RecordFailure(w.ip)
	} else {
		w.limiter.RecordSuccess(w.ip)
	}
	w.ResponseWriter.WriteHeader(code)
}

func (l *loginRateLimiter) Wrap(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		l.cleanup()
		ip := r.RemoteAddr
		if idx := strings.LastIndex(ip, ":"); idx >= 0 {
			ip = ip[:idx]
		}
		if l.IsBlocked(ip) {
			http.Error(w, "too many login attempts", http.StatusTooManyRequests)
			return
		}
		lw := &loginResponseWriter{ResponseWriter: w, limiter: l, ip: ip}
		next(lw, r)
	}
}
