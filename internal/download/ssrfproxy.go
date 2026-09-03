package download

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/outbound"
)

// ssrfProxy is a minimal forward HTTP proxy that revalidates every request
// target — the initial URL, every redirect hop, and every media segment —
// against the outbound SSRF policy before a connection is made. yt-dlp is
// pointed at it via --proxy, so yt-dlp's own redirect handling and DNS
// resolution can never escape the policy: each hop is a fresh request through
// this proxy and is revalidated against the policy (DNS resolution per hop,
// fail-closed on private/loopback/link-local/multicast targets, and DNS
// rebinding cannot redirect a connection because validated IPs are pinned at
// dial time).
//
// The proxy is only installed when the user has NOT configured their own
// download proxy (DownloadConfig.Proxy), which is an explicit opt-out into an
// unenforced proxy chain.
type ssrfProxy struct {
	policy outbound.Policy
	ln     net.Listener
	srv    *http.Server
	addr   string
	mu     sync.Mutex
	closed bool
}

// newSSRFProxy starts the proxy on an ephemeral loopback port.
func newSSRFProxy(policy outbound.Policy) (*ssrfProxy, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	p := &ssrfProxy{policy: policy, ln: ln, addr: ln.Addr().String()}
	p.srv = &http.Server{Handler: http.HandlerFunc(p.handle)}
	go func() { _ = p.srv.Serve(ln) }()
	return p, nil
}

// URL returns the proxy endpoint to pass as yt-dlp's --proxy value.
func (p *ssrfProxy) URL() string { return "http://" + p.addr }

// Close stops the proxy and releases its port.
func (p *ssrfProxy) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	p.mu.Unlock()
	return p.srv.Close()
}

func (p *ssrfProxy) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.handleConnect(w, r)
		return
	}
	p.handlePlain(w, r)
}

// handlePlain forwards an absolute-form HTTP request after validating its
// target. Redirects are returned to the client (yt-dlp), which issues a fresh
// request through this proxy — so every hop is revalidated here.
func (p *ssrfProxy) handlePlain(w http.ResponseWriter, r *http.Request) {
	if r.URL == nil || r.URL.Hostname() == "" || r.URL.Scheme == "" {
		http.Error(w, "missing request target", http.StatusBadRequest)
		return
	}
	if err := p.policy.CheckHost(r.Context(), r.URL.Hostname()); err != nil {
		http.Error(w, "target blocked by TinyLab SSRF policy", http.StatusForbidden)
		return
	}
	// Strip hop-by-hop headers (RFC 9110 §7.6.1) so they are never forwarded
	// as end-to-end headers.
	r.Header.Del("Proxy-Connection")
	r.Header.Del("Proxy-Authorization")
	r.Header.Del("Connection")
	r.Header.Del("Keep-Alive")
	r.Header.Del("TE")
	r.Header.Del("Trailer")
	r.Header.Del("Transfer-Encoding")
	r.Header.Del("Upgrade")
	r.RequestURI = ""

	// DialContext re-resolves the target and pins the validated IP literal,
	// so a DNS rebinding between the check above and the connection cannot
	// redirect it to a private address.
	tr := &http.Transport{
		DialContext:           p.policy.DialContext,
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   10 * time.Second,
		IdleConnTimeout:       60 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	defer tr.CloseIdleConnections()

	resp, err := tr.RoundTrip(r)
	if err != nil {
		http.Error(w, "proxy error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// handleConnect tunnels a CONNECT request (HTTPS) after validating the target
// host. The tunnel is a raw byte pipe pinned to the validated IPs, so a DNS
// rebinding between validation and dial cannot redirect the connection.
func (p *ssrfProxy) handleConnect(w http.ResponseWriter, r *http.Request) {
	host, port := r.Host, "443"
	if h, p2, err := net.SplitHostPort(r.Host); err == nil {
		host, port = h, p2
	}
	if host == "" {
		http.Error(w, "missing connect target", http.StatusBadRequest)
		return
	}
	ips, err := p.policy.Resolve(r.Context(), host)
	if err != nil {
		http.Error(w, "connect target blocked by TinyLab SSRF policy", http.StatusForbidden)
		return
	}
	var dst net.Conn
	for _, ip := range ips {
		d := net.Dialer{Timeout: 10 * time.Second}
		dst, err = d.DialContext(r.Context(), "tcp", net.JoinHostPort(ip.String(), port))
		if err == nil {
			break
		}
	}
	if dst == nil {
		http.Error(w, "connect failed", http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		_ = dst.Close()
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	conn, buf, err := hj.Hijack()
	if err != nil {
		_ = dst.Close()
		return
	}
	_, _ = buf.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
	_ = buf.Flush()

	// Bidirectional pipe. Client bytes may already be buffered in buf.Reader.
	go func() {
		_, _ = io.Copy(dst, buf.Reader)
		if tcp, ok := dst.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
	}()
	_, _ = io.Copy(conn, dst)
	_ = conn.Close()
	_ = dst.Close()
}

// injectProxy inserts --proxy before the final (URL) argument so the option
// precedes the URL, keeping the canonical yt-dlp invocation shape.
func injectProxy(args []string, proxyURL string) []string {
	if len(args) == 0 {
		return []string{"--proxy", proxyURL}
	}
	out := make([]string, 0, len(args)+2)
	out = append(out, args[:len(args)-1]...)
	out = append(out, "--proxy", proxyURL, args[len(args)-1])
	return out
}

// ensureProxyArg returns the args with the effective --proxy: the user
// configured download proxy when set (explicit opt-out), otherwise a per-run
// local SSRF-enforcing proxy. The cleanup func must be called after the
// command finishes.
func (e *Executor) ensureProxyArg(args []string) ([]string, func(), error) {
	if e.settings.Proxy != "" {
		return args, func() {}, nil
	}
	p, err := newSSRFProxy(outbound.Policy{})
	if err != nil {
		return nil, nil, fmt.Errorf("start SSRF proxy: %w", err)
	}
	return injectProxy(args, p.URL()), func() { _ = p.Close() }, nil
}
