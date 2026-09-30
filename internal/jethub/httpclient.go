package jethub

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/tinylab/tinylab/internal/sse"
)

// HTTPClient is the shared outbound client for jethub upstream calls
// (login/token/credits). One client per Manager keeps timeouts and the UA
// consistent across providers; provider adapters may pass per-call contexts.
type HTTPClient struct {
	client *http.Client
	// UA is the default User-Agent applied when the request does not set one.
	UA string
}

// NewHTTPClient builds the shared client with a bounded total timeout for
// non-streaming management calls. SSE reads consume resp.Body directly and use
// the request context, so a client timeout would cut long streams short —
// streaming callers must use NewRequest with a context and Client.Stream.
func NewHTTPClient(timeout time.Duration, userAgent string) *HTTPClient {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &HTTPClient{
		client: &http.Client{Timeout: timeout},
		UA:     userAgent,
	}
}

// Do executes an HTTP request with the shared client, applying the default
// User-Agent when absent.
func (c *HTTPClient) Do(req *http.Request) (*http.Response, error) {
	if req.Header.Get("User-Agent") == "" && c.UA != "" {
		req.Header.Set("User-Agent", c.UA)
	}
	return c.client.Do(req)
}

// PostJSON sends a JSON body and decodes a JSON response into out (out may be
// nil to ignore the body).
func (c *HTTPClient) PostJSON(ctx context.Context, url string, headers map[string]string, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &HTTPError{Status: resp.StatusCode, Body: string(data)}
	}
	if out != nil {
		return jsonUnmarshal(data, out)
	}
	return nil
}

// GetJSON sends a GET and decodes a JSON response into out.
func (c *HTTPClient) GetJSON(ctx context.Context, url string, headers map[string]string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &HTTPError{Status: resp.StatusCode, Body: string(data)}
	}
	if out != nil {
		return jsonUnmarshal(data, out)
	}
	return nil
}

// StreamLines reads an SSE/text stream from url, invoking onLine for every
// complete line. It uses the sse.SSELineBuffer budgeted framing shared with
// the proxy. Reading stops when the stream ends, the context is canceled, or
// onLine returns an error.
func (c *HTTPClient) StreamLines(ctx context.Context, url string, headers map[string]string, onLine func(line string) error) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return &HTTPError{Status: resp.StatusCode, Body: string(data)}
	}
	buf := sse.NewSSELineBuffer(0, 0)
	chunk := make([]byte, 16<<10)
	for {
		n, readErr := resp.Body.Read(chunk)
		if n > 0 {
			lines, feedErr := buf.Feed(chunk[:n])
			if feedErr != nil {
				return feedErr
			}
			for _, line := range lines {
				if err := onLine(line); err != nil {
					return err
				}
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				// Flush any trailing partial line.
				if rest := buf.Remaining(); rest != "" {
					return onLine(rest)
				}
				return nil
			}
			return readErr
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
}

// HTTPError is a non-2xx upstream response with its body preserved for error
// classification.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	body := e.Body
	if len(body) > 256 {
		body = body[:256]
	}
	return fmt.Sprintf("jethub: upstream HTTP %d: %s", e.Status, body)
}
