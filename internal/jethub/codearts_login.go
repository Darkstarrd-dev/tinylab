package jethub

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// CodeArts login flow constants (1:1 from ref src/login.ts oauth flow).
const (
	// Callback wait budget (browser open + user interaction).
	codeartsOAuthCallbackTimeout = 180 * time.Second
	// The portal rejects callback ports below 10000.
	codeartsMinCallbackPort = 10000
	// portal login result URL parameters.
	codeartsOAuthTheme  = "2"
	codeartsOAuthLocale = "zh-cn"
)

// ErrLoginTimeout is returned when the user does not complete authorization
// within the callback budget.
var ErrLoginTimeout = errors.New("jethub: codearts oauth login timed out")

// BuildOAuthLoginURL assembles the portal authorization URL (parameters
// aligned with the real plugin buildOAuthLoginUrl — code_challenge_method is
// "SHA-256", NOT the RFC name "S256", and no auth_callback_url is appended).
func BuildOAuthLoginURL(port int, pkce PkcePair, ticketID string) string {
	return fmt.Sprintf(
		"%s?theme=%s&locale=%s&uri_scheme=%s&client_id=%s&port=%d&code_challenge=%s&code_challenge_method=SHA-256&ticket_id=%s&plugin-name=%s&plugin-version=%s",
		CodeArtsPortalAuthorizeBase, codeartsOAuthTheme, codeartsOAuthLocale,
		CodeArtsClientID, CodeArtsClientID, port, pkce.CodeChallenge, url.QueryEscape(ticketID),
		CodeArtsPortalLoginPluginName, CodeArtsPortalLoginPluginVersion,
	)
}

// BuildPortalLoginResultURL is the post-callback redirect target.
func BuildPortalLoginResultURL(succeeded bool) string {
	return fmt.Sprintf("%s?login_succeed=%t&uri_scheme=%s&locale=%s", CodeArtsPortalLoginBase, succeeded, CodeArtsClientID, codeartsOAuthLocale)
}

// StartedLogin is a two-step login session: the caller surfaces loginUrl
// immediately, then awaits Result.
type StartedLogin struct {
	LoginURL string
	Result   <-chan LoginOutcome
	cancel   context.CancelFunc
	// resultCh is the writable side of Result (SetResult rewires it for
	// device-code flows that deliver from a custom goroutine).
	resultCh chan LoginOutcome
}

// SetResult constructs a StartedLogin-style flow around an existing channel
// (device-code flows deliver from a custom goroutine, not a callback server).
// Use NewStartedLoginWithChannel instead of mutating after construction.
func NewStartedLoginWithChannel(loginURL string, ch chan LoginOutcome) *StartedLogin {
	return &StartedLogin{LoginURL: loginURL, Result: ch, resultCh: ch}
}

// deliverOutcomes exposes deliver for API-layer device flows.
func DeliverLoginOutcome(ch chan<- LoginOutcome, outcome LoginOutcome) {
	deliver(ch, outcome)
}

// LoginOutcome carries the persisted credential JSON (already encoded by the
// provider-specific flow) or the failure. Raw JSON keeps the shape
// provider-agnostic (codearts/buddy/... flows all deliver into it).
type LoginOutcome struct {
	// CredentialJSON is the provider credential for SetCredential; nil on
	// failure. ExpiresAt/Refreshable are display hints for the account entry.
	CredentialJSON []byte
	ExpiresAt      int64
	Refreshable    bool
	Err            error
}

// Close shuts the callback server (idempotent).
func (s *StartedLogin) Close() {
	if s.cancel != nil {
		s.cancel()
	}
}

// StartCodeArtsLogin starts the OAuth callback server on a random port
// >=10000 and returns the login URL immediately (two-step login, matching
// the plugin's startOAuthFlow). The result resolves on success/timeout.
// openURL, when non-nil, is invoked with the login URL (the app passes
// fsutil.OpenInBrowser); failures to open do not abort the flow.
func StartCodeArtsLogin(openURL func(string)) (*StartedLogin, error) {
	pkce, err := GeneratePkcePair()
	if err != nil {
		return nil, err
	}
	privJwk, err := GenerateDpopKeyPair()
	if err != nil {
		return nil, err
	}
	priv, err := KeyPairFromStoredJwk(privJwk)
	if err != nil {
		return nil, err
	}
	ticketID := randomHex(32)

	ctx, cancel := context.WithCancel(context.Background())
	ln, port, err := listenCallbackPort()
	if err != nil {
		cancel()
		return nil, err
	}

	result := make(chan LoginOutcome, 1)
	// deliverCredential encodes the credential and pushes the outcome.
	deliverCredential := func(cred *CodeArtsCredential, err error) {
		if err != nil {
			deliver(result, LoginOutcome{Err: err})
			return
		}
		data, err := json.Marshal(cred)
		deliver(result, LoginOutcome{
			CredentialJSON: data, ExpiresAt: codeartsCredentialExpiresAt(cred),
			Refreshable: codeartsRefreshable(cred), Err: err,
		})
	}
	mux := http.NewServeMux()
	mux.HandleFunc(CodeArtsRedirectPath, func(w http.ResponseWriter, r *http.Request) {
		// Legacy ticket fallback: portal redirects back with secret+redirect.
		if secret := r.URL.Query().Get("secret"); secret != "" {
			redirectTo := r.URL.Query().Get("redirect")
			if redirectTo == "" {
				redirectTo = BuildPortalLoginResultURL(true)
			}
			http.Redirect(w, r, redirectTo, http.StatusTemporaryRedirect)
			cred, err := pollCodeArtsTicket(ctx, ticketID, secret, CodeArtsPortalLoginPluginName, CodeArtsPortalLoginPluginVersion)
			deliverCredential(cred, err)
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			http.Error(w, "Missing authorization code or secret", http.StatusBadRequest)
			return
		}
		token, err := exchangeCodeArtsAuthorizationCode(ctx, code, pkce.CodeVerifier, port, priv)
		if err != nil {
			http.Redirect(w, r, BuildPortalLoginResultURL(false), http.StatusTemporaryRedirect)
			deliverCredential(nil, err)
			return
		}
		http.Redirect(w, r, BuildPortalLoginResultURL(true), http.StatusTemporaryRedirect)
		deliverCredential(CredentialFromTokenResponse(token, pkce, &privJwk), nil)
	})

	server := &http.Server{Handler: mux}
	go func() {
		_ = server.Serve(ln)
	}()
	go func() {
		<-ctx.Done()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
		defer shutdownCancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	go func() {
		select {
		case <-time.After(codeartsOAuthCallbackTimeout):
			deliver(result, LoginOutcome{Err: ErrLoginTimeout})
			cancel()
		case <-ctx.Done():
		}
	}()

	loginURL := BuildOAuthLoginURL(port, pkce, ticketID)
	if openURL != nil {
		go openURL(loginURL)
	}
	return &StartedLogin{LoginURL: loginURL, Result: result, cancel: cancel}, nil
}

func deliver(ch chan<- LoginOutcome, outcome LoginOutcome) {
	select {
	case ch <- outcome:
	default:
	}
}

// listenCallbackPort binds 127.0.0.1 on a random port >= 10000 (portal
// requirement; low ports are rejected by the portal).
func listenCallbackPort() (net.Listener, int, error) {
	for attempt := 0; attempt < 20; attempt++ {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, 0, err
		}
		port := ln.Addr().(*net.TCPAddr).Port
		if port >= codeartsMinCallbackPort {
			return ln, port, nil
		}
		ln.Close()
	}
	// Deterministic fallback: pick a random port in the allowed range and try
	// once explicitly.
	return nil, 0, fmt.Errorf("jethub: no free callback port >= %d", codeartsMinCallbackPort)
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// Non-catastrophic fallback: timestamp-derived id (login ticket ids are
		// session-scoped; collision risk is negligible).
		now := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	return hex.EncodeToString(b)
}

// ExchangeCodeArtsRefreshToken performs the silent renewal exchange with DPoP.
func ExchangeCodeArtsRefreshToken(ctx context.Context, refreshToken, codeVerifier string, priv *ecdsa.PrivateKey) (*CodeArtsTokenResponse, error) {
	return codeartsTokenRequest(ctx, map[string]string{
		"client_id":     CodeArtsClientID,
		"code_verifier": codeVerifier,
		"grant_type":    GrantRefreshToken,
		"refresh_token": refreshToken,
	}, priv)
}

func exchangeCodeArtsAuthorizationCode(ctx context.Context, code, codeVerifier string, port int, priv *ecdsa.PrivateKey) (*CodeArtsTokenResponse, error) {
	return codeartsTokenRequest(ctx, map[string]string{
		"client_id":     CodeArtsClientID,
		"code":          code,
		"code_verifier": codeVerifier,
		"grant_type":    GrantAuthorizationCode,
		"redirect_uri":  fmt.Sprintf("http://127.0.0.1:%d%s", port, CodeArtsRedirectPath),
	}, priv)
}

// codeartsTokenRequest POSTs the form-encoded token request with a DPoP
// header (60s budget, aligned with the plugin TOKEN_TIMEOUT_MS).
func codeartsTokenRequest(ctx context.Context, form map[string]string, priv *ecdsa.PrivateKey) (*CodeArtsTokenResponse, error) {
	dpop, err := SignDpopJws(priv, "POST", codeartsSTSURL)
	if err != nil {
		return nil, err
	}
	values := url.Values{}
	for k, v := range form {
		values.Set(k, v)
	}
	tctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(tctx, http.MethodPost, codeartsSTSURL, strings.NewReader(values.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("DPoP", dpop)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := callbackClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("jethub: codearts token request network error: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var token CodeArtsTokenResponse
	if err := json.Unmarshal(data, &token); err != nil {
		return nil, fmt.Errorf("jethub: codearts token response unparsable (HTTP %d)", resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || token.Credentials == nil {
		return nil, ClassifyTokenError(&token)
	}
	return &token, nil
}

// callbackClient is the client used by the callback server's outbound token
// exchanges (bounded, shared).
var callbackClient = &http.Client{Timeout: 70 * time.Second}
