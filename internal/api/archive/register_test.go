package archive

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/archive"
	"github.com/tinyrouter/tinyrouter/internal/archivetool"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// newTestServer wires a real runner (zip works without external tools) and the
// handler behind a chi router, exactly like the production mount.
func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	_, srv := newHandlerServer(t, config.ArchiveConfig{})
	return srv
}

// newHandlerServer builds the handler + httptest server and returns both so
// tests can inspect/inject handler-internal state (sources registry).
func newHandlerServer(t *testing.T, cfg config.ArchiveConfig) (*Handler, *httptest.Server) {
	t.Helper()
	runner, err := archivetool.NewRunner(t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("NewRunner: %v", err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	h := NewHandler(&apibase.Deps{}, runner)
	rr := chi.NewRouter()
	h.Register(rr)
	srv := httptest.NewServer(rr)
	t.Cleanup(srv.Close)
	return h, srv
}

// makeZIP builds a zip with the given entries (name -> content) in memory.
func makeZIP(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip.Create(%q): %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %q: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip.Close: %v", err)
	}
	return buf.Bytes()
}

func decodeJSON(t *testing.T, body io.Reader, into any) {
	t.Helper()
	if err := json.NewDecoder(body).Decode(into); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

func TestZipSourceFlow(t *testing.T) {
	srv := newTestServer(t)
	zipData := makeZIP(t, map[string]string{"a.png": "AAA", "b.png": "BBB"})

	resp, err := http.Post(srv.URL+"/sources?name=test.zip", "application/octet-stream", bytes.NewReader(zipData))
	if err != nil {
		t.Fatalf("POST sources: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST sources = %d, want 200", resp.StatusCode)
	}
	var created struct {
		SourceID string `json:"sourceId"`
		Format   string `json:"format"`
		Writable bool   `json:"writable"`
		Manifest struct {
			TotalEntries int `json:"totalEntries"`
		} `json:"manifest"`
	}
	decodeJSON(t, resp.Body, &created)
	if created.SourceID == "" || created.Format != "zip" || !created.Writable {
		t.Fatalf("bad create response: %+v", created)
	}
	if created.Manifest.TotalEntries != 2 {
		t.Errorf("TotalEntries = %d, want 2", created.Manifest.TotalEntries)
	}

	// Entry read by strict path.
	resp, err = http.Get(srv.URL + "/sources/" + created.SourceID + "/entries/a.png")
	if err != nil {
		t.Fatalf("GET entry: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(got) != "AAA" {
		t.Errorf("entry read = %d %q, want 200 AAA", resp.StatusCode, got)
	}

	// Malformed path: traversal rejected before any matching.
	resp, err = http.Get(srv.URL + "/sources/" + created.SourceID + "/entries/../evil.txt")
	if err != nil {
		t.Fatalf("GET traversal: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("traversal = %d, want 400", resp.StatusCode)
	}

	// Missing entry -> 404.
	resp, err = http.Get(srv.URL + "/sources/" + created.SourceID + "/entries/missing.png")
	if err != nil {
		t.Fatalf("GET missing: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("missing entry = %d, want 404", resp.StatusCode)
	}

	// Delete releases the source.
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/sources/"+created.SourceID, nil)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE source: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("DELETE source = %d, want 204", resp.StatusCode)
	}

	// Entries after release -> 404.
	resp, err = http.Get(srv.URL + "/sources/" + created.SourceID + "/entries/a.png")
	if err != nil {
		t.Fatalf("GET after delete: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("entry after delete = %d, want 404", resp.StatusCode)
	}
}

func TestZipReplaceEndToEnd(t *testing.T) {
	srv := newTestServer(t)
	zipData := makeZIP(t, map[string]string{"a.png": "OLD", "b.png": "BBB"})

	resp, err := http.Post(srv.URL+"/sources?name=test.zip", "application/octet-stream", bytes.NewReader(zipData))
	if err != nil {
		t.Fatalf("POST sources: %v", err)
	}
	var created struct {
		SourceID string `json:"sourceId"`
	}
	decodeJSON(t, resp.Body, &created)
	resp.Body.Close()

	// Register the replacement asset.
	resp, err = http.Post(srv.URL+"/assets?name=a.png", "image/png", strings.NewReader("NEW"))
	if err != nil {
		t.Fatalf("POST asset: %v", err)
	}
	var asset struct {
		AssetID string `json:"assetId"`
	}
	decodeJSON(t, resp.Body, &asset)
	resp.Body.Close()
	if asset.AssetID == "" {
		t.Fatal("no assetId returned")
	}

	// zip-replace swaps a.png content.
	payload := fmt.Sprintf(`{"sourceId":%q,"replacements":[{"entryPath":"a.png","assetId":%q}]}`, created.SourceID, asset.AssetID)
	resp, err = http.Post(srv.URL+"/zip-replace", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST zip-replace: %v", err)
	}
	var replaced struct {
		AssetID string `json:"assetId"`
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("zip-replace = %d: %s", resp.StatusCode, body)
	}
	decodeJSON(t, resp.Body, &replaced)
	resp.Body.Close()
	if replaced.AssetID == "" {
		t.Fatal("zip-replace returned no assetId")
	}

	// The registered source now serves the replacement content.
	resp, err = http.Get(srv.URL + "/sources/" + created.SourceID + "/entries/a.png")
	if err != nil {
		t.Fatalf("GET replaced entry: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(got) != "NEW" {
		t.Errorf("replaced entry = %q, want NEW", got)
	}

	// Owner binding: the source-owned output asset cannot be released by id.
	resp, err = http.Post(srv.URL+"/release/"+replaced.AssetID, "application/json", nil)
	if err != nil {
		t.Fatalf("POST release: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("release of source-owned asset = %d, want 409", resp.StatusCode)
	}

	// Releasing an unknown id is idempotent.
	resp, err = http.Post(srv.URL+"/release/does-not-exist", "application/json", nil)
	if err != nil {
		t.Fatalf("POST release unknown: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("release unknown = %d, want 200", resp.StatusCode)
	}
}

func TestZipReplaceRejectsBadInput(t *testing.T) {
	srv := newTestServer(t)

	// Unknown sourceId -> 404.
	payload := `{"sourceId":"nope","replacements":[{"entryPath":"a.png","assetId":"x"}]}`
	resp, err := http.Post(srv.URL+"/zip-replace", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST zip-replace: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("unknown source = %d, want 404", resp.StatusCode)
	}

	// Unsafe entry path -> 400 before any asset resolution.
	zipData := makeZIP(t, map[string]string{"a.png": "A"})
	resp, err = http.Post(srv.URL+"/sources?name=t.zip", "application/octet-stream", bytes.NewReader(zipData))
	if err != nil {
		t.Fatalf("POST sources: %v", err)
	}
	var created struct {
		SourceID string `json:"sourceId"`
	}
	decodeJSON(t, resp.Body, &created)
	resp.Body.Close()
	payload = fmt.Sprintf(`{"sourceId":%q,"replacements":[{"entryPath":"../evil","assetId":"x"}]}`, created.SourceID)
	resp, err = http.Post(srv.URL+"/zip-replace", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST zip-replace unsafe: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("unsafe entry path = %d, want 400", resp.StatusCode)
	}

	// Missing replacement asset -> 404.
	payload = fmt.Sprintf(`{"sourceId":%q,"replacements":[{"entryPath":"a.png","assetId":"missing"}]}`, created.SourceID)
	resp, err = http.Post(srv.URL+"/zip-replace", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST zip-replace missing asset: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("missing replacement asset = %d, want 404", resp.StatusCode)
	}
}

func TestPackZip(t *testing.T) {
	srv := newTestServer(t)
	ids := make([]string, 0, 2)
	for _, n := range []string{"x.png", "y.txt"} {
		resp, err := http.Post(srv.URL+"/assets?name="+n, "application/octet-stream", strings.NewReader("content-"+n))
		if err != nil {
			t.Fatalf("POST asset %s: %v", n, err)
		}
		var a struct {
			AssetID string `json:"assetId"`
		}
		decodeJSON(t, resp.Body, &a)
		resp.Body.Close()
		ids = append(ids, a.AssetID)
	}
	payload := fmt.Sprintf(`{"assetIds":[%q,%q],"format":"zip","name":"out.zip"}`, ids[0], ids[1])
	resp, err := http.Post(srv.URL+"/pack", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST pack: %v", err)
	}
	var packed struct {
		AssetID string `json:"assetId"`
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("pack = %d: %s", resp.StatusCode, body)
	}
	decodeJSON(t, resp.Body, &packed)
	resp.Body.Close()

	resp, err = http.Get(srv.URL + "/assets/" + packed.AssetID)
	if err != nil {
		t.Fatalf("GET packed asset: %v", err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("packed output is not a valid zip: %v", err)
	}
	if len(zr.File) != 2 {
		t.Errorf("packed entries = %d, want 2", len(zr.File))
	}
}

func TestCreateSourceRejectsMislabeledUpload(t *testing.T) {
	srv := newTestServer(t)
	// 7z magic bytes mislabeled as .zip must be rejected, not fed to the tool.
	body := append([]byte{0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c}, bytes.Repeat([]byte{0}, 64)...)
	resp, err := http.Post(srv.URL+"/sources?name=evil.zip", "application/octet-stream", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST sources: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("mislabeled upload = %d, want 400", resp.StatusCode)
	}
}

func TestStatusEndpoint(t *testing.T) {
	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/status")
	if err != nil {
		t.Fatalf("GET status: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", resp.StatusCode)
	}
	var st struct {
		ZIP struct {
			Available bool   `json:"available"`
			Read      bool   `json:"read"`
			Write     bool   `json:"write"`
			Error     string `json:"error"`
		} `json:"zip"`
		SevenZip map[string]any `json:"sevenZip"`
		RAR      map[string]any `json:"rar"`
	}
	decodeJSON(t, resp.Body, &st)
	if !st.ZIP.Available || !st.ZIP.Read || !st.ZIP.Write {
		t.Errorf("zip capability = %+v, want available read+write", st.ZIP)
	}
	if st.ZIP.Error != "" {
		t.Errorf("zip.error = %q, want empty", st.ZIP.Error)
	}
	if st.SevenZip == nil || st.RAR == nil {
		t.Errorf("status missing sevenZip/rar sections: %+v", st)
	}
}

// TestRunnerUnavailable503 verifies every endpoint reports a diagnostic 503
// when the archive runner was not wired at startup (nil runner).
func TestRunnerUnavailable503(t *testing.T) {
	h := NewHandler(&apibase.Deps{}, nil)
	rr := chi.NewRouter()
	h.Register(rr)
	srv := httptest.NewServer(rr)
	t.Cleanup(srv.Close)

	cases := []struct {
		method, path string
		body         io.Reader
	}{
		{http.MethodGet, "/status", nil},
		{http.MethodPost, "/sources?name=x.zip", strings.NewReader("PK")},
		{http.MethodGet, "/sources/nope/entries/a.png", nil},
		{http.MethodDelete, "/sources/nope", nil},
		{http.MethodPost, "/assets?name=a.png", strings.NewReader("A")},
		{http.MethodGet, "/assets/nope", nil},
		{http.MethodPost, "/pack", strings.NewReader(`{"assetIds":["x"],"format":"zip"}`)},
		{http.MethodPost, "/zip-replace", strings.NewReader(`{"sourceId":"x","replacements":[]}`)},
		{http.MethodPost, "/release/nope", nil},
	}
	for _, tc := range cases {
		req, err := http.NewRequest(tc.method, srv.URL+tc.path, tc.body)
		if err != nil {
			t.Fatalf("NewRequest %s %s: %v", tc.method, tc.path, err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.method, tc.path, err)
		}
		var body struct {
			Code string `json:"code"`
		}
		decodeJSON(t, resp.Body, &body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusServiceUnavailable || body.Code != "archive.unavailable" {
			t.Errorf("%s %s = %d code=%q, want 503 archive.unavailable", tc.method, tc.path, resp.StatusCode, body.Code)
		}
	}
}

// TestCreateSourceRejectsBadRequests pins the format contract: missing name,
// unknown extension, mislabeled magic and corrupt content all fail with
// stable 4xx codes before any archive data is served.
func TestCreateSourceRejectsBadRequests(t *testing.T) {
	srv := newTestServer(t)
	zipData := makeZIP(t, map[string]string{"a.png": "AAA"})

	// Missing name query parameter.
	resp, err := http.Post(srv.URL+"/sources", "application/octet-stream", bytes.NewReader(zipData))
	if err != nil {
		t.Fatalf("POST sources: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("missing name = %d, want 400", resp.StatusCode)
	}

	// Unknown extension (not .zip/.7z/.rar).
	resp, err = http.Post(srv.URL+"/sources?name=notes.txt", "application/octet-stream", bytes.NewReader(zipData))
	if err != nil {
		t.Fatalf("POST sources: %v", err)
	}
	var unk struct {
		Code string `json:"code"`
	}
	decodeJSON(t, resp.Body, &unk)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || unk.Code != "archive.unsupported-format" {
		t.Errorf("unknown extension = %d code=%q, want 400 archive.unsupported-format", resp.StatusCode, unk.Code)
	}

	// Mislabeled: zip magic named .rar must be sniffed and rejected.
	resp, err = http.Post(srv.URL+"/sources?name=evil.rar", "application/octet-stream", bytes.NewReader(zipData))
	if err != nil {
		t.Fatalf("POST sources: %v", err)
	}
	var mis struct {
		Code string `json:"code"`
	}
	decodeJSON(t, resp.Body, &mis)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || mis.Code != "archive.unsupported-format" {
		t.Errorf("mislabeled .rar = %d code=%q, want 400 archive.unsupported-format", resp.StatusCode, mis.Code)
	}

	// Corrupt content (garbage, truncated zip, empty) named .zip must not be
	// served as a source: distinguishable archive.corrupt, not a 500.
	valid := makeZIP(t, map[string]string{"a.png": "AAA"})
	corrupt := map[string][]byte{
		"garbage.zip":   []byte("this is definitely not a zip file"),
		"truncated.zip": valid[:16],
		"empty.zip":     {},
	}
	for name, body := range corrupt {
		resp, err = http.Post(srv.URL+"/sources?name="+name, "application/octet-stream", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("POST sources %s: %v", name, err)
		}
		var c struct {
			Code string `json:"code"`
		}
		decodeJSON(t, resp.Body, &c)
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnprocessableEntity || c.Code != "archive.corrupt" {
			t.Errorf("%s = %d code=%q, want 422 archive.corrupt", name, resp.StatusCode, c.Code)
		}
	}
}

// TestSourceManifestDeterministic pins the create-source manifest: entries
// are natural-sorted (not zip-write-order), sizes and kinds are reported, and
// totals are exact — independent of map iteration order in makeZIP.
func TestSourceManifestDeterministic(t *testing.T) {
	srv := newTestServer(t)
	zipData := makeZIP(t, map[string]string{"b.png": "BBB", "a.png": "AAA", "dir/x.txt": "X"})
	resp, err := http.Post(srv.URL+"/sources?name=test.zip", "application/octet-stream", bytes.NewReader(zipData))
	if err != nil {
		t.Fatalf("POST sources: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("POST sources = %d: %s", resp.StatusCode, body)
	}
	var created struct {
		SourceID string `json:"sourceId"`
		Format   string `json:"format"`
		Writable bool   `json:"writable"`
		Size     int64  `json:"size"`
		Manifest struct {
			Format  string `json:"format"`
			Entries []struct {
				Path string `json:"path"`
				Size int64  `json:"size"`
				Kind string `json:"kind"`
			} `json:"entries"`
			TotalEntries      int   `json:"totalEntries"`
			TotalUncompressed int64 `json:"totalUncompressed"`
		} `json:"manifest"`
	}
	decodeJSON(t, resp.Body, &created)
	resp.Body.Close()

	if created.SourceID == "" || created.Format != "zip" || !created.Writable {
		t.Fatalf("bad create response: %+v", created)
	}
	m := created.Manifest
	if m.Format != "zip" || m.TotalEntries != 3 || m.TotalUncompressed != 7 {
		t.Errorf("manifest = format %q entries %d uncompressed %d, want zip/3/7", m.Format, m.TotalEntries, m.TotalUncompressed)
	}
	wantPaths := []string{"a.png", "b.png", "dir/x.txt"}
	if len(m.Entries) != len(wantPaths) {
		t.Fatalf("entries = %d, want %d", len(m.Entries), len(wantPaths))
	}
	for i, want := range wantPaths {
		if m.Entries[i].Path != want {
			t.Errorf("entries[%d].Path = %q, want %q", i, m.Entries[i].Path, want)
		}
	}
	if m.Entries[0].Size != 3 || m.Entries[2].Size != 1 {
		t.Errorf("entry sizes = %d/%d, want 3/1", m.Entries[0].Size, m.Entries[2].Size)
	}
	// Manifest kinds are structural (file/dir), not mime-derived.
	if m.Entries[0].Kind != "file" || m.Entries[2].Kind != "file" {
		t.Errorf("entry kinds = %q/%q, want file/file", m.Entries[0].Kind, m.Entries[2].Kind)
	}
}

// TestEntryReadRejectsUnsafePaths pins the per-read strict path contract:
// traversal (raw and encoded), absolute and drive-letter paths never reach
// the archive reader, and unknown source ids are 404.
func TestEntryReadRejectsUnsafePaths(t *testing.T) {
	srv := newTestServer(t)
	zipData := makeZIP(t, map[string]string{"a.png": "AAA"})
	resp, err := http.Post(srv.URL+"/sources?name=test.zip", "application/octet-stream", bytes.NewReader(zipData))
	if err != nil {
		t.Fatalf("POST sources: %v", err)
	}
	var created struct {
		SourceID string `json:"sourceId"`
	}
	decodeJSON(t, resp.Body, &created)
	resp.Body.Close()
	id := created.SourceID
	unsafe := []string{
		"../evil.txt",      // parent traversal
		"a/../../evil.txt", // nested traversal
		"/etc/passwd",      // absolute
		"C:%5CWindows%5Cx", // drive letter (encoded backslashes)
	}
	for _, p := range unsafe {
		resp, err = http.Get(srv.URL + "/sources/" + id + "/entries/" + p)
		if err != nil {
			t.Fatalf("GET entry %q: %v", p, err)
		}
		var body struct {
			Code string `json:"code"`
		}
		decodeJSON(t, resp.Body, &body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest || body.Code != "archive.unsafe-path" {
			t.Errorf("entry %q = %d code=%q, want 400 archive.unsafe-path", p, resp.StatusCode, body.Code)
		}
	}

	// URL-encoded traversal is routed on chi's RawPath, so the handler sees
	// the literal name "..%2Fevil.txt" (never decoded): it is safe (no path
	// segment ever reaches the reader) and simply misses the archive -> 404.
	resp, err = http.Get(srv.URL + "/sources/" + id + "/entries/..%2Fevil.txt")
	if err != nil {
		t.Fatalf("GET encoded traversal: %v", err)
	}
	var enc struct {
		Code string `json:"code"`
	}
	decodeJSON(t, resp.Body, &enc)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound || enc.Code != "archive.not-found" {
		t.Errorf("encoded traversal = %d code=%q, want 404 archive.not-found", resp.StatusCode, enc.Code)
	}

	// Unknown source id -> 404, not a fallthrough read.
	resp, err = http.Get(srv.URL + "/sources/deadbeef/entries/a.png")
	if err != nil {
		t.Fatalf("GET unknown source: %v", err)
	}
	var nb struct {
		Code string `json:"code"`
	}
	decodeJSON(t, resp.Body, &nb)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound || nb.Code != "archive.not-found" {
		t.Errorf("unknown source = %d code=%q, want 404 archive.not-found", resp.StatusCode, nb.Code)
	}
}

// TestPackValidation pins pack input validation and capability errors:
// unknown format, empty asset list, unresolvable asset and a missing external
// tool (7z) all fail with stable codes, deterministically (the configured
// SevenZipPath is a nonexistent file, which never falls back to PATH).
func TestPackValidation(t *testing.T) {
	srv := newTestServer(t)
	post := func(payload string) (int, string) {
		t.Helper()
		resp, err := http.Post(srv.URL+"/pack", "application/json", strings.NewReader(payload))
		if err != nil {
			t.Fatalf("POST pack: %v", err)
		}
		var body struct {
			Code string `json:"code"`
		}
		decodeJSON(t, resp.Body, &body)
		resp.Body.Close()
		return resp.StatusCode, body.Code
	}

	if code, got := post(`{"assetIds":["x"],"format":"gzip","name":"o.zip"}`); code != http.StatusBadRequest || got != "archive.unsupported-format" {
		t.Errorf("unknown format = %d %q, want 400 archive.unsupported-format", code, got)
	}
	if code, got := post(`{"assetIds":[],"format":"zip","name":"o.zip"}`); code != http.StatusBadRequest || got != "archive.bad-request" {
		t.Errorf("empty assetIds = %d %q, want 400 archive.bad-request", code, got)
	}
	if code, got := post(`{"assetIds":["nope"],"format":"zip","name":"o.zip"}`); code != http.StatusNotFound || got != "archive.not-found" {
		t.Errorf("missing asset = %d %q, want 404 archive.not-found", code, got)
	}

	// 7z pack with no usable tool -> deterministic 503 tool-missing.
	noTool := filepath.Join(t.TempDir(), "no-7z.exe")
	h, srv2 := newHandlerServer(t, config.ArchiveConfig{SevenZipPath: noTool})
	_ = h
	resp, err := http.Post(srv2.URL+"/assets?name=a.png", "image/png", strings.NewReader("AAA"))
	if err != nil {
		t.Fatalf("POST asset: %v", err)
	}
	var asset struct {
		AssetID string `json:"assetId"`
	}
	decodeJSON(t, resp.Body, &asset)
	resp.Body.Close()
	payload := fmt.Sprintf(`{"assetIds":[%q],"format":"7z","name":"o.7z"}`, asset.AssetID)
	resp, err = http.Post(srv2.URL+"/pack", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST pack 7z: %v", err)
	}
	var pb struct {
		Code string `json:"code"`
	}
	decodeJSON(t, resp.Body, &pb)
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable || pb.Code != "archive.tool-missing" {
		t.Errorf("7z pack missing tool = %d code=%q, want 503 archive.tool-missing", resp.StatusCode, pb.Code)
	}
}

// TestReleaseAssetLifecycle pins release semantics: a plain asset releases
// once (GET then 404, second release idempotent), a registered source's own
// temp asset and its outputs are source-owned (409), and DELETE of an unknown
// source is an idempotent 204.
func TestReleaseAssetLifecycle(t *testing.T) {
	h, srv := newHandlerServer(t, config.ArchiveConfig{})

	// Plain uploaded asset.
	resp, err := http.Post(srv.URL+"/assets?name=p.png", "image/png", strings.NewReader("PNG"))
	if err != nil {
		t.Fatalf("POST asset: %v", err)
	}
	var asset struct {
		AssetID string `json:"assetId"`
	}
	decodeJSON(t, resp.Body, &asset)
	resp.Body.Close()

	resp, err = http.Get(srv.URL + "/assets/" + asset.AssetID)
	if err != nil {
		t.Fatalf("GET asset: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET asset = %d, want 200", resp.StatusCode)
	}

	resp, err = http.Post(srv.URL+"/release/"+asset.AssetID, "application/json", nil)
	if err != nil {
		t.Fatalf("POST release: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("release asset = %d, want 200", resp.StatusCode)
	}
	resp, err = http.Get(srv.URL + "/assets/" + asset.AssetID)
	if err != nil {
		t.Fatalf("GET released asset: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("GET released asset = %d, want 404", resp.StatusCode)
	}
	resp, err = http.Post(srv.URL+"/release/"+asset.AssetID, "application/json", nil)
	if err != nil {
		t.Fatalf("POST double release: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("double release = %d, want 200", resp.StatusCode)
	}

	// A registered source's own temp asset is source-owned: releasing it by
	// id must 409 and the source must remain usable.
	zipData := makeZIP(t, map[string]string{"a.png": "AAA"})
	resp, err = http.Post(srv.URL+"/sources?name=test.zip", "application/octet-stream", bytes.NewReader(zipData))
	if err != nil {
		t.Fatalf("POST sources: %v", err)
	}
	var src struct {
		SourceID string `json:"sourceId"`
	}
	decodeJSON(t, resp.Body, &src)
	resp.Body.Close()
	h.mu.Lock()
	refID := h.sources[src.SourceID].refID
	h.mu.Unlock()
	if refID == "" {
		t.Fatal("source has no registered refID")
	}
	resp, err = http.Post(srv.URL+"/release/"+refID, "application/json", nil)
	if err != nil {
		t.Fatalf("POST release source-owned: %v", err)
	}
	var owned struct {
		Code string `json:"code"`
	}
	decodeJSON(t, resp.Body, &owned)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict || owned.Code != "archive.source-owned" {
		t.Errorf("release source-owned = %d code=%q, want 409 archive.source-owned", resp.StatusCode, owned.Code)
	}
	resp, err = http.Get(srv.URL + "/sources/" + src.SourceID + "/entries/a.png")
	if err != nil {
		t.Fatalf("GET entry after failed release: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(got) != "AAA" {
		t.Errorf("entry after failed release = %d %q, want 200 AAA", resp.StatusCode, got)
	}

	// Unknown source delete is idempotent 204.
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/sources/does-not-exist", nil)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE unknown source: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("DELETE unknown source = %d, want 204", resp.StatusCode)
	}
}

// TestZipReplaceReadOnlySource pins the writeback contract for non-ZIP
// sources: a registered 7z source is read-only and zip-replace must 403
// before resolving any replacement asset.
func TestZipReplaceReadOnlySource(t *testing.T) {
	h, srv := newHandlerServer(t, config.ArchiveConfig{})
	h.mu.Lock()
	h.sources["ro7z"] = &sourceEntry{
		src:       archive.Source{ID: "ro7z", Format: archive.Format7Z, Name: "x.7z", Path: "unused", Writable: false},
		refID:     "ref7z",
		createdAt: time.Now(),
	}
	h.mu.Unlock()

	payload := `{"sourceId":"ro7z","replacements":[{"entryPath":"a.png","assetId":"whatever"}]}`
	resp, err := http.Post(srv.URL+"/zip-replace", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST zip-replace: %v", err)
	}
	var body struct {
		Code string `json:"code"`
	}
	decodeJSON(t, resp.Body, &body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden || body.Code != "archive.read-only" {
		t.Errorf("read-only zip-replace = %d code=%q, want 403 archive.read-only", resp.StatusCode, body.Code)
	}
}

// blockingRunner wraps a real runner and gates ReplaceZIP so tests can hold a
// writeback in flight deterministically. Every zip-replace (including the
// follow-up one after release) passes through the override.
type blockingRunner struct {
	*archivetool.Runner
	enteredOnce sync.Once
	entered     chan struct{}
	release     chan struct{}
}

func (b *blockingRunner) ReplaceZIP(ctx context.Context, src archive.Source, replacements map[string]archive.AssetRef, budget archive.Budget) (archive.AssetRef, error) {
	b.enteredOnce.Do(func() { close(b.entered) })
	<-b.release // closed channel returns immediately once released
	return b.Runner.ReplaceZIP(ctx, src, replacements, budget)
}

// TestZipReplaceConcurrentRejected pins the plan §8.3 rule "冲突时拒绝第二个
// 并发写回": while one zip-replace on a source is in flight, a second one is
// rejected with 409 archive.busy; the in-flight one completes, and the source
// is writable again afterwards (the busy flag is cleared on every exit path).
func TestZipReplaceConcurrentRejected(t *testing.T) {
	base, err := archivetool.NewRunner(t.TempDir(), config.ArchiveConfig{})
	if err != nil {
		t.Fatalf("NewRunner: %v", err)
	}
	t.Cleanup(func() { _ = base.Close() })
	br := &blockingRunner{Runner: base, entered: make(chan struct{}), release: make(chan struct{})}
	h := NewHandler(&apibase.Deps{}, br)
	rr := chi.NewRouter()
	h.Register(rr)
	srv := httptest.NewServer(rr)
	t.Cleanup(srv.Close)
	zipData := makeZIP(t, map[string]string{"a.png": "OLD"})
	resp, err := http.Post(srv.URL+"/sources?name=test.zip", "application/octet-stream", bytes.NewReader(zipData))
	if err != nil {
		t.Fatalf("POST sources: %v", err)
	}
	var src struct {
		SourceID string `json:"sourceId"`
	}
	decodeJSON(t, resp.Body, &src)
	resp.Body.Close()
	resp, err = http.Post(srv.URL+"/assets?name=a.png", "image/png", strings.NewReader("NEW"))
	if err != nil {
		t.Fatalf("POST asset: %v", err)
	}
	var asset struct {
		AssetID string `json:"assetId"`
	}
	decodeJSON(t, resp.Body, &asset)
	resp.Body.Close()

	payload := fmt.Sprintf(`{"sourceId":%q,"replacements":[{"entryPath":"a.png","assetId":%q}]}`, src.SourceID, asset.AssetID)
	first := make(chan int, 1)
	go func() {
		r, err := http.Post(srv.URL+"/zip-replace", "application/json", strings.NewReader(payload))
		if err != nil {
			first <- 0
			return
		}
		r.Body.Close()
		first <- r.StatusCode
	}()

	// Wait until the first writeback is inside the runner (busy flag set).
	<-br.entered
	resp, err = http.Post(srv.URL+"/zip-replace", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST concurrent zip-replace: %v", err)
	}
	var busy struct {
		Code string `json:"code"`
	}
	decodeJSON(t, resp.Body, &busy)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict || busy.Code != "archive.busy" {
		t.Errorf("concurrent zip-replace = %d code=%q, want 409 archive.busy", resp.StatusCode, busy.Code)
	}

	close(br.release)
	if code := <-first; code != http.StatusOK {
		t.Errorf("first zip-replace = %d, want 200", code)
	}

	// Busy flag cleared: the same source accepts a follow-up writeback.
	resp, err = http.Post(srv.URL+"/zip-replace", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST follow-up zip-replace: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("follow-up zip-replace = %d, want 200", resp.StatusCode)
	}
}
