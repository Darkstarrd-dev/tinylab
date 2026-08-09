package download

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/outbound"
)

// proxyClient returns an http.Client whose traffic is routed through the
// given proxy URL.
func proxyClient(proxyURL string) *http.Client {
	pu, _ := url.Parse(proxyURL)
	return &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyURL(pu)},
		Timeout:   10 * time.Second,
	}
}

// TestSSRFProxyForwardsAllowedRequest: a loopback target is reachable through
// the proxy under the explicit AllowPrivate capability.
func TestSSRFProxyForwardsAllowedRequest(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))
	defer target.Close()

	p, err := newSSRFProxy(outbound.Policy{AllowPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	resp, err := proxyClient(p.URL()).Get(target.URL)
	if err != nil {
		t.Fatalf("forward through proxy: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != "ok" {
		t.Fatalf("got %d %q, want 200 ok", resp.StatusCode, body)
	}
}

// TestSSRFProxyBlocksPrivateTarget: the strict policy refuses a private
// target at the proxy before any connection is attempted.
func TestSSRFProxyBlocksPrivateTarget(t *testing.T) {
	p, err := newSSRFProxy(outbound.Policy{})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	resp, err := proxyClient(p.URL()).Get("http://10.0.0.5/steal")
	if err != nil {
		t.Fatalf("expected 403 response from proxy, got err: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("got %d, want 403", resp.StatusCode)
	}
}

// TestSSRFProxyRejectsRedirectToPrivate is the controlled redirect fixture:
// an allowed server redirects to a target that is always blocked (the CGNAT
// range 100.64.0.0/10 is refused even under AllowPrivate). The client follows
// the redirect through the proxy, and the second hop must be refused there.
func TestSSRFProxyRejectsRedirectToPrivate(t *testing.T) {
	start := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://100.64.0.1/steal", http.StatusFound)
	}))
	defer start.Close()

	p, err := newSSRFProxy(outbound.Policy{AllowPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	resp, err := proxyClient(p.URL()).Get(start.URL + "/start")
	if err != nil {
		t.Fatalf("redirect chain should terminate at the proxy with a response, got err: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("redirected hop must be refused by the proxy, got %d, want 403", resp.StatusCode)
	}
}

// TestSSRFProxyConnectBlocksPrivateTarget: CONNECT to a private target is
// refused with 403 before any tunnel is opened.
func TestSSRFProxyConnectBlocksPrivateTarget(t *testing.T) {
	p, err := newSSRFProxy(outbound.Policy{})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	addr := strings.TrimPrefix(p.URL(), "http://")
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "CONNECT 10.0.0.5:443 HTTP/1.1\r\nHost: 10.0.0.5:443\r\n\r\n")
	br := bufio.NewReader(conn)
	line, err := br.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(line, "403") {
		t.Fatalf("CONNECT to private target: got %q, want 403", strings.TrimSpace(line))
	}
}

// TestInjectProxyKeepsURLLast: the --proxy option is inserted before the
// final URL argument.
func TestInjectProxyKeepsURLLast(t *testing.T) {
	args := []string{"--no-playlist", "https://example.com/v"}
	out := injectProxy(args, "http://127.0.0.1:9")
	if out[len(out)-1] != args[len(args)-1] {
		t.Fatalf("URL must stay last: %v", out)
	}
	if out[len(out)-3] != "--proxy" || out[len(out)-2] != "http://127.0.0.1:9" {
		t.Fatalf("--proxy not inserted before URL: %v", out)
	}
}

// TestEnsureProxyArgRespectsUserProxy: a user-configured download proxy is
// used as-is (no local SSRF proxy started) — BuildDownloadArgs already
// injected the user's --proxy.
func TestEnsureProxyArgRespectsUserProxy(t *testing.T) {
	settings := RuntimeSettings{Proxy: "http://127.0.0.1:8080"}
	e := &Executor{settings: settings}
	args := BuildDownloadArgs("https://example.com/v", TypeVideo, QualityBest, ContainerAuto, "/tmp/dl", 4, settings)
	args, cleanup, err := e.ensureProxyArg(args)
	if err != nil {
		t.Fatal(err)
	}
	cleanup()
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--proxy http://127.0.0.1:8080") {
		t.Fatalf("user proxy not used: %v", args)
	}
	if strings.Contains(joined, "127.0.0.1:0") {
		t.Fatalf("local proxy unexpectedly started: %v", args)
	}
}

// TestEnsureProxyArgStartsLocalProxy: without a user proxy, a local
// SSRF-enforcing proxy is started and wired as --proxy.
func TestEnsureProxyArgStartsLocalProxy(t *testing.T) {
	e := &Executor{settings: RuntimeSettings{}}
	args, cleanup, err := e.ensureProxyArg([]string{"--no-playlist", "https://x/v"})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--proxy http://127.0.0.1:") {
		t.Fatalf("local proxy not wired: %v", args)
	}
	if strings.Contains(joined, "--proxy http://127.0.0.1:8080") {
		t.Fatalf("unexpected user proxy: %v", args)
	}
}
