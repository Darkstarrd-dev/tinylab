// Package outbound provides scenario-scoped outbound network policy for
// SSRF-sensitive client calls: URL structure validation, DNS/IP filtering,
// DNS-rebinding-safe dialing, and per-redirect revalidation.
//
// The package has no dependencies outside the standard library so every
// caller (image proxy, provider management probes, download pre-flight,
// image batch) shares one enforcement model that can be unit-tested with
// deterministic DNS fixtures.
package outbound

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Policy controls how outbound requests are validated. The zero value is the
// strictest scenario: http/https only, no userinfo, no private/loopback
// targets, 5 redirect hops, no client timeout.
type Policy struct {
	// AllowPrivate permits loopback, RFC1918, link-local and ULA targets
	// (e.g. an explicitly opted-in local Ollama provider). It never permits
	// unspecified or multicast addresses.
	AllowPrivate bool
	// MaxRedirects caps redirect hops; 0 means 5.
	MaxRedirects int
	// Timeout is the client timeout; 0 means no timeout.
	Timeout time.Duration
	// LookupIP resolves a host to IPs. Defaults to net.DefaultResolver and
	// may be replaced in tests to build deterministic DNS fixtures.
	LookupIP func(ctx context.Context, host string) ([]net.IP, error)
}

const defaultMaxRedirects = 5

var (
	errBlockedIP   = errors.New("target resolves to a blocked address")
	errNoAddresses = errors.New("target resolves to no usable addresses")
)

// blockedPorts are well-known non-HTTP service ports that are never a
// legitimate HTTP(S) API target (SSRF exfiltration channels: SSH, SMTP, DNS,
// SMB, databases, Redis, Docker, Elasticsearch, Memcached, MongoDB, ...).
var blockedPorts = map[int]bool{
	21: true, 22: true, 23: true, 25: true, 53: true, 69: true,
	110: true, 135: true, 137: true, 138: true, 139: true, 143: true,
	161: true, 389: true, 445: true, 465: true, 514: true, 587: true,
	636: true, 873: true, 993: true, 995: true,
	1433: true, 1521: true, 1723: true, 2049: true, 2375: true, 2376: true,
	3128: true, 3306: true, 3389: true, 5432: true, 5900: true, 6379: true,
	6443: true, 9200: true, 9300: true, 11211: true, 27017: true,
}

// extraBlockedNets are non-global-unicast ranges not covered by net.IP's
// IsPrivate/IsLinkLocal* helpers: CGNAT, benchmarking and IETF protocol
// assignments. They are always blocked, even when AllowPrivate is set.
var extraBlockedNets = func() []*net.IPNet {
	var out []*net.IPNet
	for _, cidr := range []string{"100.64.0.0/10", "198.18.0.0/15", "192.0.0.0/24"} {
		if _, n, err := net.ParseCIDR(cidr); err == nil {
			out = append(out, n)
		}
	}
	return out
}()

// ValidateURL performs strict structural validation without any DNS
// resolution: the scheme must be http/https, the host non-empty, URL userinfo
// credentials are rejected, and the port must not be a known internal-service
// port. It is the check every caller applies to the initial URL.
func ValidateURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid url: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return nil, fmt.Errorf("unsupported url scheme %q (only http/https are allowed)", u.Scheme)
	}
	if u.Hostname() == "" {
		return nil, errors.New("url must have a host")
	}
	if u.User != nil {
		return nil, errors.New("url userinfo credentials are not allowed")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nil, fmt.Errorf("url port %q is not a valid port number", port)
		}
		if blockedPorts[n] || (n < 1024 && n != 80 && n != 443) {
			return nil, fmt.Errorf("url port %d is not an allowed HTTP(S) port", n)
		}
	}
	return u, nil
}

// CheckIP reports whether a single IP is permitted by the policy.
func (p Policy) CheckIP(ip net.IP) error {
	if ip == nil {
		return errBlockedIP
	}
	if ip.IsUnspecified() || ip.IsMulticast() {
		return fmt.Errorf("%w (%s)", errBlockedIP, ip)
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		if p.AllowPrivate {
			return nil
		}
		return fmt.Errorf("%w (%s)", errBlockedIP, ip)
	}
	for _, n := range extraBlockedNets {
		if n.Contains(ip) {
			return fmt.Errorf("%w (%s)", errBlockedIP, ip)
		}
	}
	return nil
}

// Resolve resolves host and returns the validated IPs: every returned IP
// passes the policy check, and resolution failure, an empty answer set, or
// any blocked IP fails closed. Callers that need to pin a connection to the
// validated address (e.g. a CONNECT tunnel) should dial the returned IPs
// directly instead of resolving again.
func (p Policy) Resolve(ctx context.Context, host string) ([]net.IP, error) {
	ips, err := p.lookupIP(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", host, err)
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("resolve %s: %w", host, errNoAddresses)
	}
	for _, ip := range ips {
		if err := p.CheckIP(ip); err != nil {
			return nil, err
		}
	}
	return ips, nil
}

// CheckHost resolves host and verifies every returned IP against the policy.
// Resolution failure, an empty answer set, or any blocked IP fails closed.
func (p Policy) CheckHost(ctx context.Context, host string) error {
	_, err := p.Resolve(ctx, host)
	return err
}

// DialContext dials addr after resolving the host and verifying every IP
// against the policy. The connection is pinned to a validated IP literal, so
// a DNS rebinding between validation and connect cannot redirect the
// connection to a different (private) address.
func (p Policy) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ips, err := p.lookupIP(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", host, err)
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("resolve %s: %w", host, errNoAddresses)
	}
	var lastErr error
	for _, ip := range ips {
		if err := p.CheckIP(ip); err != nil {
			lastErr = err
			continue
		}
		d := net.Dialer{Timeout: 10 * time.Second}
		conn, err := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errNoAddresses
	}
	return nil, lastErr
}

// CheckRedirect returns an http.Client CheckRedirect func that revalidates
// every redirect hop against the policy (a public→private redirect is
// refused) and caps the number of hops.
func (p Policy) CheckRedirect() func(req *http.Request, via []*http.Request) error {
	maxHops := p.MaxRedirects
	if maxHops <= 0 {
		maxHops = defaultMaxRedirects
	}
	return func(req *http.Request, via []*http.Request) error {
		if len(via) >= maxHops {
			return fmt.Errorf("stopped after %d redirects", maxHops)
		}
		if err := p.CheckHost(req.Context(), req.URL.Hostname()); err != nil {
			return fmt.Errorf("redirect to blocked host %s: %w", req.URL.Hostname(), err)
		}
		return nil
	}
}

// Client builds an *http.Client enforcing the policy: IP checks on dial
// (DNS-rebinding safe) and per-hop redirect revalidation. Connections are
// always direct — proxied scenarios opt out of this client deliberately.
func (p Policy) Client() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext:           p.DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          32,
			IdleConnTimeout:       60 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: time.Second,
		},
		CheckRedirect: p.CheckRedirect(),
		Timeout:       p.Timeout,
	}
}

func (p Policy) lookupIP(ctx context.Context, host string) ([]net.IP, error) {
	if p.LookupIP != nil {
		return p.LookupIP(ctx, host)
	}
	return net.DefaultResolver.LookupIP(ctx, "ip", host)
}
