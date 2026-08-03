// Package compress provides brotli/gzip HTTP response compression middleware.
package compress

import (
	"bufio"
	"compress/gzip"
	"io"
	"net"
	"net/http"
	"strings"

	"github.com/andybalholm/brotli"
)

// skipTypes lists content types that are already compressed or streaming;
// they bypass the encoder to preserve chunked flushing (SSE) and avoid wasted
// CPU on already-compressed binary payloads (woff2, images).
var skipTypes = []string{
	"text/event-stream",
	"font/woff2", "font/woff", "application/font-woff",
	"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/tiff",
	"application/zip", "application/gzip",
}

func shouldCompress(ct string) bool {
	if ct == "" {
		return true
	}
	for _, s := range skipTypes {
		if strings.HasPrefix(ct, s) {
			return false
		}
	}
	return true
}

// pickEncoding returns the best supported encoding ("br" > "gzip" > "").
func pickEncoding(r *http.Request) string {
	ae := r.Header.Get("Accept-Encoding")
	if ae == "" {
		return ""
	}
	if strings.Contains(ae, "br") {
		return "br"
	}
	if strings.Contains(ae, "gzip") {
		return "gzip"
	}
	return ""
}

// compressWriter defers encoder selection until WriteHeader so it can decide
// whether to compress based on the response Content-Type. SSE streams stay
// uncompressed (preserving chunked flushing) while JS/CSS/JSON get encoded.
type compressWriter struct {
	http.ResponseWriter
	encoding string
	encoder  io.WriteCloser
	decided  bool
	bypass   bool
}

func (cw *compressWriter) WriteHeader(code int) {
	if cw.decided {
		cw.ResponseWriter.WriteHeader(code)
		return
	}
	cw.decided = true
	ct := cw.Header().Get("Content-Type")
	if cw.encoding == "" || !shouldCompress(ct) {
		cw.bypass = true
		cw.ResponseWriter.WriteHeader(code)
		return
	}
	// Compression changes the body length, drop any pre-set Content-Length.
	cw.Header().Del("Content-Length")
	cw.Header().Set("Content-Encoding", cw.encoding)
	switch cw.encoding {
	case "br":
		cw.encoder = brotli.NewWriterLevel(cw.ResponseWriter, brotli.DefaultCompression)
	case "gzip":
		gw, err := gzip.NewWriterLevel(cw.ResponseWriter, gzip.BestCompression)
		if err != nil {
			cw.bypass = true
			cw.ResponseWriter.WriteHeader(code)
			return
		}
		cw.encoder = gw
	}
	cw.ResponseWriter.WriteHeader(code)
}

func (cw *compressWriter) Write(b []byte) (int, error) {
	if !cw.decided {
		// Caller wrote without WriteHeader; treat as 200 with sniffed type.
		cw.WriteHeader(http.StatusOK)
	}
	if cw.bypass || cw.encoder == nil {
		return cw.ResponseWriter.Write(b)
	}
	return cw.encoder.Write(b)
}

// Flush propagates to the upstream flusher so streaming handlers keep working
// when bypassing compression (e.g. SSE). For compressible responses, also
// flushes the brotli/gzip encoder so buffered bytes reach the client.
func (cw *compressWriter) Flush() {
	if cw.encoder != nil && !cw.bypass {
		if fl, ok := cw.encoder.(interface{ Flush() error }); ok {
			_ = fl.Flush()
		}
	}
	if fl, ok := cw.ResponseWriter.(http.Flusher); ok {
		fl.Flush()
	}
}

func (cw *compressWriter) Push(target string, opts *http.PushOptions) error {
	if p, ok := cw.ResponseWriter.(http.Pusher); ok {
		return p.Push(target, opts)
	}
	return http.ErrNotSupported
}

// Unwrap exposes the underlying http.ResponseWriter so that
// http.ResponseController can chain through middleware wrappers to reach
// the standard *response type (which implements SetWriteDeadline, Flush, etc.).
func (cw *compressWriter) Unwrap() http.ResponseWriter {
	return cw.ResponseWriter
}

func (cw *compressWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := cw.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

// closeEncoder finalizes the compression stream so buffered bytes get flushed.
func (cw *compressWriter) closeEncoder() {
	if cw.encoder != nil && !cw.bypass {
		_ = cw.encoder.Close()
	}
}

// Compress is an http middleware that encodes responses with brotli or gzip
// when the client supports it and the content-type is compressible.
func Compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Bypass compression for long-running non-streaming endpoints
		// (e.g. image generation). These endpoints use an early flush to
		// keep the browser alive during ~50s upstream generation; brotli/
		// gzip would buffer that flush so the browser never sees
		// decompressed body bytes and aborts on its body first-byte timer.
		if r.URL.Path == "/v1/images/generations" || r.URL.Path == "/v1/images/edits" {
			next.ServeHTTP(w, r)
			return
		}
		enc := pickEncoding(r)
		if enc == "" {
			next.ServeHTTP(w, r)
			return
		}
		cw := &compressWriter{ResponseWriter: w, encoding: enc}
		// Defer close so the body write completes before the encoder is closed.
		defer cw.closeEncoder()
		next.ServeHTTP(cw, r)
	})
}
