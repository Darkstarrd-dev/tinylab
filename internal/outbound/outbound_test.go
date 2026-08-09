package outbound

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestValidateURLStructure(t *testing.T) {
	cases := []struct {
		raw     string
		wantErr string // substring; "" means must succeed
	}{
		{"https://api.example.com", ""},
		{"http://example.com:8080/v1/chat/completions", ""},
		{"http://example.com:11434", ""},
		{"https://example.com:443", ""},
		{"", "unsupported url scheme"},
		{"ftp://example.com", "unsupported url scheme"},
		{"file:///etc/passwd", "unsupported url scheme"},
		{"http://", "must have a host"},
		{"http://user:pass@example.com", "userinfo"},
		{"http://example.com:6379", "port 6379"},
		{"http://example.com:22", "port 22"},
		{"http://example.com:81", "port 81"},
		{"http://example.com:http", "port"},
		{"http://example.com:99999", "not a valid port"},
	}
	for _, c := range cases {
		_, err := ValidateURL(c.raw)
		if c.wantErr == "" {
			if err != nil {
				t.Errorf("%q: unexpected error %v", c.raw, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), c.wantErr) {
			t.Errorf("%q: got %v, want error containing %q", c.raw, err, c.wantErr)
		}
	}
}

func TestCheckIP(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "::1", "10.0.0.1", "192.168.1.1", "172.16.0.1",
		"169.254.169.254", "fe80::1", "224.0.0.1", "ff02::1", "0.0.0.0", "::",
		"100.64.0.1", "198.18.0.1", "192.0.0.9",
	}
	for _, s := range blocked {
		if err := (Policy{}).CheckIP(net.ParseIP(s)); err == nil {
			t.Errorf("%s: expected blocked", s)
		}
	}
	allowed := []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "93.184.216.34"}
	for _, s := range allowed {
		if err := (Policy{}).CheckIP(net.ParseIP(s)); err != nil {
			t.Errorf("%s: unexpected block %v", s, err)
		}
	}
	// AllowPrivate permits loopback/private/ULA but never multicast,
	// unspecified, or the extra always-blocked ranges.
	for _, s := range []string{"127.0.0.1", "10.1.2.3", "192.168.0.1", "::1", "fd00::1"} {
		if err := (Policy{AllowPrivate: true}).CheckIP(net.ParseIP(s)); err != nil {
			t.Errorf("AllowPrivate %s: %v", s, err)
		}
	}
	for _, s := range []string{"224.0.0.1", "0.0.0.0", "100.64.0.1", "198.18.0.1"} {
		if err := (Policy{AllowPrivate: true}).CheckIP(net.ParseIP(s)); err == nil {
			t.Errorf("AllowPrivate %s: expected still blocked", s)
		}
	}
}

func TestCheckHostFailsClosed(t *testing.T) {
	pub := []net.IP{net.ParseIP("93.184.216.34")}
	priv := []net.IP{net.ParseIP("10.0.0.1")}
	mixed := []net.IP{net.ParseIP("93.184.216.34"), net.ParseIP("192.168.0.1")}
	cases := []struct {
		name    string
		ips     []net.IP
		err     error
		allowPr bool
		wantErr bool
	}{
		{"public", pub, nil, false, false},
		{"private", priv, nil, false, true},
		{"mixed-any-blocked", mixed, nil, false, true},
		{"resolve-fail", nil, errors.New("nxdomain"), false, true},
		{"no-addresses", nil, nil, false, true},
		{"allow-private", priv, nil, true, false},
	}
	for _, c := range cases {
		p := Policy{AllowPrivate: c.allowPr}
		p.LookupIP = func(ctx context.Context, host string) ([]net.IP, error) {
			if c.err != nil {
				return nil, c.err
			}
			return c.ips, nil
		}
		err := p.CheckHost(context.Background(), "fixture.test")
		if c.wantErr != (err != nil) {
			t.Errorf("%s: got %v, wantErr %v", c.name, err, c.wantErr)
		}
	}
}

func TestDNSRebindingFixtureRejected(t *testing.T) {
	// Deterministic rebinding fixture: the first resolution yields a public
	// IP, a later resolution (as a real rebinding attack would produce)
	// yields a private IP. The policy resolves once per dial and rejects the
	// private answer, and the dial itself pins the validated IP literal.
	var calls int
	p := Policy{}
	p.LookupIP = func(ctx context.Context, host string) ([]net.IP, error) {
		calls++
		if calls == 1 {
			return []net.IP{net.ParseIP("93.184.216.34")}, nil
		}
		return []net.IP{net.ParseIP("127.0.0.1")}, nil
	}
	if err := p.CheckHost(context.Background(), "rebind.test"); err != nil {
		t.Fatalf("first resolution should pass: %v", err)
	}
	_, err := p.DialContext(context.Background(), "tcp", "rebind.test:443")
	if err == nil {
		t.Fatal("dial after rebinding to a private IP must fail")
	}
	if !strings.Contains(err.Error(), "blocked") {
		t.Fatalf("expected blocked-address error, got %v", err)
	}
}

func TestDialPinsValidatedIP(t *testing.T) {
	// The dialer must connect to the IP returned by LookupIP (pinning), not
	// re-resolve the hostname: a host whose DNS answer is loopback is dialed
	// at that loopback address under AllowPrivate.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	_, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	p := Policy{AllowPrivate: true}
	p.LookupIP = func(ctx context.Context, host string) ([]net.IP, error) {
		if host != "pinned.example" {
			return nil, fmt.Errorf("unexpected host %s", host)
		}
		return []net.IP{net.ParseIP("127.0.0.1")}, nil
	}
	conn, err := p.DialContext(context.Background(), "tcp", "pinned.example:"+port)
	if err != nil {
		t.Fatalf("dial should pin to the validated loopback IP: %v", err)
	}
	conn.Close()
}

func TestCheckRedirectRejectsBlockedHop(t *testing.T) {
	p := Policy{}
	p.LookupIP = func(ctx context.Context, host string) ([]net.IP, error) {
		if host == "public.example" {
			return []net.IP{net.ParseIP("93.184.216.34")}, nil
		}
		return []net.IP{net.ParseIP("10.0.0.5")}, nil
	}
	cr := p.CheckRedirect()

	req := httptest.NewRequest("GET", "http://10.0.0.5/steal", nil)
	via := []*http.Request{httptest.NewRequest("GET", "http://public.example/start", nil)}
	if err := cr(req, via); err == nil {
		t.Fatal("public→private redirect hop must be rejected")
	}

	// Hop cap: 5 prior hops is too many.
	req2 := httptest.NewRequest("GET", "http://public.example/step6", nil)
	var via2 []*http.Request
	for i := 0; i < 5; i++ {
		via2 = append(via2, httptest.NewRequest("GET", "http://public.example/x", nil))
	}
	if err := cr(req2, via2); err == nil {
		t.Fatal("redirect chain past the hop cap must fail")
	}
}
func TestClientRedirectToPrivateRejected(t *testing.T) {
	// Controlled redirect fixture: the initial request is allowed (loopback
	// under the explicit AllowPrivate capability) and the server redirects to
	// a private target. Redirect hops are re-validated against the outbound
	// policy, so the hop is refused before any connection is attempted.
	start := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://10.0.0.5/steal", http.StatusFound)
	}))
	defer start.Close()

	c := Policy{AllowPrivate: true, Timeout: 5 * time.Second}.Client()
	c.CheckRedirect = Policy{}.CheckRedirect()
	_, err := c.Get(start.URL + "/start")
	if err == nil {
		t.Fatal("redirect to a private target must be rejected")
	}
	if !strings.Contains(err.Error(), "blocked") {
		t.Fatalf("expected blocked-host error, got %v", err)
	}

	// Same-origin (loopback) redirect succeeds under AllowPrivate.
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "/ok", http.StatusFound)
			return
		}
		w.Write([]byte("ok"))
	}))
	defer ok.Close()
	c2 := Policy{AllowPrivate: true, Timeout: 5 * time.Second}.Client()
	resp, err := c2.Get(ok.URL + "/start")
	if err != nil {
		t.Fatalf("same-origin redirect should succeed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
}
