package jethub

import (
	"errors"
	"testing"
	"time"
)

// TestSettleAndCleanupFailureDeletesPlaceholder covers the +new-account
// failure path: a flow that delivers an error (timeout / user cancel /
// upstream rejection) must delete the placeholder account, not leave a
// credential-less entry that renders as usable.
func TestSettleAndCleanupFailureDeletesPlaceholder(t *testing.T) {
	env := newTestManager(t)
	id, _ := NewAccountID("raccoon")
	if err := env.m.AddAccount(Account{ID: id, Provider: "raccoon", Nickname: id, Enabled: true, CredentialRef: "X"}); err != nil {
		t.Fatal(err)
	}
	resultCh := make(chan LoginOutcome, 1)
	sess := &LoginSession{
		Key: "test-failed", Account: id, Manager: env.m,
		Started: NewStartedLoginWithChannel("https://example.com/login", resultCh),
	}
	RegisterLoginSession(sess.Key, sess)
	go SettleAndCleanup(sess, nil)

	// The status poll must see done:false until the outcome arrives.
	if done, _, _ := SessionStatus(sess); done {
		t.Fatal("session reported settled before the outcome was delivered")
	}
	resultCh <- LoginOutcome{Err: errors.New("扫码登录超时")}

	waitFor(t, 2*time.Second, func() bool {
		_, ok := FindTestAccount(env.m, id)
		return !ok
	})
	// ⚠️ The session stays observable through the grace period (the UI poll
	// must be able to read the outcome), so it is NOT reaped immediately.
	if _, still := PeekLoginSession(sess.Key); !still {
		t.Fatal("session reaped before the UI could observe the outcome")
	}
	done, success, msg := SessionStatus(sess)
	if !done || success || msg != "扫码登录超时" {
		t.Fatalf("status after failure = (%v, %v, %q), want (true, false, 扫码登录超时)", done, success, msg)
	}
}

// TestSettleAndCleanupSuccessKeepsAccount: a delivered credential with a nil
// completer must keep the account (the flow persisted it internally) and
// record a successful settle.
func TestSettleAndCleanupSuccessKeepsAccount(t *testing.T) {
	env := newTestManager(t)
	id, _ := NewAccountID("cline")
	if err := env.m.AddAccount(Account{ID: id, Provider: "cline", Nickname: id, Enabled: true, CredentialRef: "X"}); err != nil {
		t.Fatal(err)
	}
	resultCh := make(chan LoginOutcome, 1)
	sess := &LoginSession{
		Key: "test-ok", Account: id, Manager: env.m,
		Started: NewStartedLoginWithChannel("https://example.com/login", resultCh),
	}
	RegisterLoginSession(sess.Key, sess)
	go SettleAndCleanup(sess, nil)
	resultCh <- LoginOutcome{CredentialJSON: []byte(`{"access_token":"a"}`), ExpiresAt: 123}

	waitFor(t, 2*time.Second, func() bool {
		done, _, _ := SessionStatus(sess)
		return done
	})
	if _, ok := FindTestAccount(env.m, id); !ok {
		t.Fatal("successful flow deleted the account")
	}
	// The session stays observable through the grace period (not reaped yet).
	if _, still := PeekLoginSession(sess.Key); !still {
		t.Fatal("session reaped before the UI could observe the outcome")
	}
	if done, success, _ := SessionStatus(sess); !done || !success {
		t.Fatalf("status after success = (%v, %v), want (true, true)", done, success)
	}
}

// TestSettleAndCleanupCompleteErrorDeletes: when the provider-specific
// persistence callback fails, the placeholder is removed too (an account
// whose credential could not be stored is unusable).
func TestSettleAndCleanupCompleteErrorDeletes(t *testing.T) {
	env := newTestManager(t)
	id, _ := NewAccountID("buddy")
	if err := env.m.AddAccount(Account{ID: id, Provider: "buddy", Nickname: id, Enabled: true, CredentialRef: "X"}); err != nil {
		t.Fatal(err)
	}
	resultCh := make(chan LoginOutcome, 1)
	sess := &LoginSession{
		Key: "test-cpl", Account: id, Manager: env.m,
		Started: NewStartedLoginWithChannel("https://example.com/login", resultCh),
	}
	RegisterLoginSession(sess.Key, sess)
	go SettleAndCleanup(sess, func(LoginOutcome) error { return errors.New("persist failed") })
	resultCh <- LoginOutcome{CredentialJSON: []byte(`{}`)}

	waitFor(t, 2*time.Second, func() bool {
		_, ok := FindTestAccount(env.m, id)
		return !ok
	})
}

// TestSessionStatusUnsettled: a fresh session reports not-done with empty
// fields (the UI poll's "still waiting" branch).
func TestSessionStatusUnsettled(t *testing.T) {
	resultCh := make(chan LoginOutcome, 1)
	sess := &LoginSession{Started: NewStartedLoginWithChannel("u", resultCh)}
	if done, success, msg := SessionStatus(sess); done || success || msg != "" {
		t.Fatalf("fresh session = (%v,%v,%q), want all zero", done, success, msg)
	}
}

// TestSessionReapedAfterGrace: the settled session stays in the registry for
// the UI poll's grace period, then is reaped (real defect: immediate reap
// made the 2s poller 404 and the dialog never observed done:true).
func TestSessionReapedAfterGrace(t *testing.T) {
	resultCh := make(chan LoginOutcome, 1)
	sess := &LoginSession{Key: "test-grace", Started: NewStartedLoginWithChannel("u", resultCh)}
	RegisterLoginSession(sess.Key, sess)
	go SettleAndCleanup(sess, nil)
	resultCh <- LoginOutcome{Err: errors.New("x")}

	// Immediately after settle: still observable.
	waitFor(t, 2*time.Second, func() bool {
		_, _, _ = SessionStatus(sess)
		return func() bool { _, ok := PeekLoginSession(sess.Key); return ok }()
	})
	if _, ok := PeekLoginSession(sess.Key); !ok {
		t.Fatal("session reaped before the grace period elapsed")
	}
	// After the grace period: reaped.
	waitFor(t, loginSessionGracePeriod+2*time.Second, func() bool {
		_, ok := PeekLoginSession(sess.Key)
		return !ok
	})
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not reached within deadline")
}

// FindTestAccount is a test-only alias of Manager.FindAccount.
func FindTestAccount(m *Manager, id string) (Account, bool) { return m.FindAccount(id) }
