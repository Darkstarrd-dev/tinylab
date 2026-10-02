package webhub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/config"
)

// ErrIntercepted is the sentinel the RequestCustomizer returns so the proxy's
// retry loop treats the attempt as "handled by the bridge" rather than a
// transport failure. It is exported for tests and for the app's wiring docs;
// the bridge itself maps it to a synthesized *http.Response.
var ErrIntercepted = errors.New("webhub: request intercepted (served by the browser)")

// turnTimeout bounds ONE site turn inside the proxy request. It is shorter
// than driverRequestTimeout because the client is waiting: a page turn that
// exceeds this is reported as a 504 rather than hanging the caller.
const turnTimeout = 600 * time.Second

// maxPromptChars caps the prompt handed to a page. Composers reject very long
// pastes (and a page-driven site is not the place to send a novel); the cap
// keeps failures legible instead of silently truncated.
const maxPromptChars = 32000

// Customize implements proxy.RequestCustomizer for the webhub bridge.
//
// ⚠️ THE KEY DIFFERENCE FROM jethub: webhub has no BaseURL, so there is no
// real HTTP request to build. This method therefore does NOT return a URL —
// it executes the turn against the browser page, synthesizes an OpenAI-shaped
// *http.Response, and returns it via the interceptor's outBody channel.
//
// The proxy's forwardUpstream calls Customize *before* the URL is used, and
// the interceptor (InterceptResponse) is what actually supplies the body to
// the client. See the flow notes in bridge_exec.go.
func (b *Bridge) Customize(r *http.Request, body []byte, providerID, keyID, upstreamModel string) (string, []byte, error) {
	site, ok := SiteFromProviderID(providerID)
	if !ok {
		// Not a webhub provider: let the proxy use its default construction.
		return "", body, nil
	}
	if b == nil || b.m == nil || b.driver == nil {
		return "", body, fmt.Errorf("webhub: bridge not wired")
	}
	isStream := streamRequested(body)
	prompt, err := BuildPrompt(body)
	if err != nil {
		return "", body, err
	}
	if len([]rune(prompt)) > maxPromptChars {
		return "", body, fmt.Errorf("webhub: prompt too long for a page (%d chars, max %d)", len([]rune(prompt)), maxPromptChars)
	}
	preset := ""
	if upstreamModel != "" {
		rule := SiteRuleByDomain(site)
		var names []string
		if rule != nil {
			names = rule.PresetNames()
		}
		if p, ok := ResolveModelID(upstreamModel, site, names); ok {
			preset = p
		}
	}
	// Remember what this attempt is so InterceptResponse can drive it.
	turn := &turnState{
		site:     site,
		preset:   preset,
		prompt:   prompt,
		model:    upstreamModel,
		isStream: isStream,
	}
	if r != nil {
		r.Header.Set(turnHeaderName, turn.token())
		pendingTurns.Store(turn.token(), turn)
	}
	return "", body, nil
}

// Augment implements proxy.RequestAugmenter. Webhub never rewrites the body
// for a real HTTP send (there is no send), so it is a pass-through — it exists
// only because the proxy's augmenter interface requires it on the injected
// object.
func (b *Bridge) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	return body, nil
}

// InterceptResponse implements proxy.ResponseInterceptor for webhub.
//
// The upstream "response" the proxy built is a placeholder (there is no
// upstream). This method replaces it with the real, page-produced reply:
//
//   - non-streaming: one complete chat.completion body;
//   - streaming: a reader that emits SSE chunks as the page produces deltas,
//     then the terminal chunk and [DONE].
func (b *Bridge) InterceptResponse(clientReq *http.Request, resp *http.Response, providerID, keyID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	if _, ok := SiteFromProviderID(providerID); !ok {
		return nil, 0, nil
	}
	var turn *turnState
	if clientReq != nil {
		if raw, ok := pendingTurns.Load(clientReq.Header.Get(turnHeaderName)); ok {
			turn, _ = raw.(*turnState)
			pendingTurns.Delete(clientReq.Header.Get(turnHeaderName))
		}
	}
	if turn == nil {
		return nil, 0, fmt.Errorf("webhub: lost the request context for %s", providerID)
	}

	ctx := context.Background()
	if clientReq != nil && clientReq.Context() != nil {
		ctx = clientReq.Context()
	}
	ctx, cancel := context.WithTimeout(ctx, turnTimeout)
	// ⚠️ CANCEL OWNERSHIP (2026-10-03 用户实测缺陷 22): a streaming turn drives
	// the browser page from a background goroutine and InterceptResponse
	// returns as soon as the pipe reader exists — `defer cancel()` here killed
	// the context at return, so the driver's very first page read failed with
	// "context canceled" (the client saw the role chunk, then an error frame).
	// The non-streaming path calls Chat synchronously, so it keeps defer; the
	// streaming path hands ownership to the goroutine, which cancels when the
	// turn finishes (or when the client disconnects — parent ctx cancellation
	// propagates either way).

	if !turn.isStream {
		defer cancel()
		out, err := b.driver.Chat(ctx, ChatRequest{
			Site:   turn.site,
			Preset: turn.preset,
			Prompt: turn.prompt,
		})
		if err != nil {
			return nil, 0, err
		}
		raw, err := BuildChatCompletion(turn.model, out.Text, estimateTokens(turn.prompt))
		if err != nil {
			return nil, 0, err
		}
		if resp != nil {
			resp.Header.Set("Content-Type", "application/json")
		}
		return strings.NewReader(string(raw)), 0, nil
	}

	// Streaming: hand back a reader that emits SSE as deltas arrive. The proxy
	// streams it to the client verbatim, so the chunk shape must be exactly
	// OpenAI's (see response.go).
	pr, pw := io.Pipe()
	go func() {
		defer cancel()
		b.streamTurn(ctx, pw, turn)
	}()
	if resp != nil {
		resp.Header.Set("Content-Type", "text/event-stream")
	}
	return pr, 0, nil
}

// streamTurn drives one streaming turn, writing OpenAI SSE frames to pw.
func (b *Bridge) streamTurn(ctx context.Context, pw *io.PipeWriter, turn *turnState) {
	id := responseID()
	model := turn.model
	var first atomicBool
	writeErr := func(err error) {
		// Surface the failure as an SSE error frame AND close the pipe with
		// the error so the proxy's read loop sees it (a silently closed pipe
		// would look like a clean end-of-stream).
		frame, _ := json.Marshal(map[string]any{
			"error": map[string]any{"message": err.Error(), "type": "webhub_error"},
		})
		_, _ = pw.Write([]byte("data: " + string(frame) + "\n\n"))
		_ = pw.CloseWithError(err)
	}
	chunk, err := BuildChunk(id, model, "", true, false)
	if err == nil {
		if _, werr := pw.Write([]byte("data: " + string(chunk) + "\n\n")); werr != nil {
			_ = pw.CloseWithError(werr)
			return
		}
	}
	_, err = b.driver.Chat(ctx, ChatRequest{
		Site:   turn.site,
		Preset: turn.preset,
		Prompt: turn.prompt,
		Stream: true,
		OnDelta: func(d string) {
			if d == "" {
				return
			}
			c, cerr := BuildChunk(id, model, d, false, false)
			if cerr != nil {
				return
			}
			if _, werr := pw.Write([]byte("data: " + string(c) + "\n\n")); werr != nil {
				return
			}
			_ = first.set()
		},
	})
	if err != nil {
		writeErr(err)
		return
	}
	last, err := BuildChunk(id, model, "", false, true)
	if err == nil {
		_, _ = pw.Write([]byte("data: " + string(last) + "\n\n"))
	}
	_, _ = pw.Write([]byte("data: [DONE]\n\n"))
	_ = pw.Close()
}

// turnHeaderName is the loopback-only header carrying the pending-turn token
// from Customize to InterceptResponse. It never leaves the process (the
// proxy's header copy guard drops unknown client headers, and this one is set
// server-side on the client request object only).
const turnHeaderName = "X-TinyLab-WebHub-Turn"

// pendingTurns carries per-attempt state between Customize and
// InterceptResponse. Keyed by a per-attempt token, so two concurrent attempts
// on the same site cannot read each other's state.
var pendingTurns sync.Map

// turnState is one outbound attempt's parameters.
type turnState struct {
	site     string
	preset   string
	prompt   string
	model    string
	isStream bool
	tokenVal string
	once     sync.Once
}

// token lazily mints a unique key for this turn.
func (t *turnState) token() string {
	t.once.Do(func() {
		t.tokenVal = fmt.Sprintf("%s-%d", t.site, time.Now().UnixNano())
	})
	return t.tokenVal
}

// atomicBool is a tiny bool flag (only one writer in practice, but the delta
// callback can fire from the driver's goroutine).
type atomicBool struct {
	mu sync.Mutex
	v  bool
}

func (a *atomicBool) set() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.v = true
	return a.v
}

// streamRequested reports whether the request body asks for a stream.
func streamRequested(body []byte) bool {
	if len(body) == 0 {
		return false
	}
	var parsed struct {
		Stream bool `json:"stream"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return false
	}
	return parsed.Stream
}

// Ensure the provider shape the proxy sees stays honest: a webhub provider
// must never carry a BaseURL (the customizer intercepts; any BaseURL would
// make the proxy build a real request).
func assertNoBaseURL(p config.Provider) error {
	if p.APIType == APIType && strings.TrimSpace(p.BaseURL) != "" {
		return fmt.Errorf("webhub: provider %s must not carry a BaseURL", p.ID)
	}
	return nil
}
