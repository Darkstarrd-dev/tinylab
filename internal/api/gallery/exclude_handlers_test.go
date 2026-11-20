package gallery

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/pathgrant"
	"github.com/tinylab/tinylab/internal/registry"
)

func newExcludeTestServer(t *testing.T) (*Handler, *httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	cfg := config.DefaultConfig()
	cfgPath := filepath.Join(dir, "config.yaml")
	if err := config.Save(cfgPath, cfg); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(&apibase.Deps{
		Reg:        registry.New(cfg),
		ConfigPath: cfgPath,
		Logger:     console.New(100),
	})
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return h, srv, dir
}

func testDoJSON(t *testing.T, client *http.Client, method, url string, body any) (int, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, url, &buf)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func build20PackZipBytes(t *testing.T, adPayload []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i := 1; i <= 20; i++ {
		w, err := zw.Create(fmt.Sprintf("pack/%02d.png", i))
		if err != nil {
			t.Fatal(err)
		}
		if i > 15 {
			_, _ = w.Write(adPayload)
		} else {
			_, _ = fmt.Fprintf(w, "story-page-%02d", i)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestGalleryExcludeHashes_EndToEnd(t *testing.T) {
	h, srv, cfgDir := newExcludeTestServer(t)

	// Cookie-owning client: first call stamps owner cookie.
	status, state := testDoJSON(t, ownerClient, http.MethodGet, srv.URL+"/exclude-hashes", nil)
	if status != http.StatusOK {
		t.Fatalf("GET /exclude-hashes status = %d, want 200", status)
	}
	if int(state["count"].(float64)) != 0 {
		t.Fatalf("initial count = %v, want 0", state["count"])
	}

	adBytes := []byte("tail-ad-banner-bytes")
	sum := sha256.Sum256(adBytes)
	adSHA := hex.EncodeToString(sum[:])

	// Upload a 20-image zip session (last 5 are adBytes).
	upResp, err := post(srv.URL+"/zip", "application/zip", bytes.NewReader(build20PackZipBytes(t, adBytes)))
	if err != nil {
		t.Fatal(err)
	}
	var upData struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.NewDecoder(upResp.Body).Decode(&upData)
	upResp.Body.Close()
	sid := upData.SessionID

	// Fast path check on empty store.
	entries := make([]string, 0, 20)
	for i := 1; i <= 20; i++ {
		entries = append(entries, fmt.Sprintf("pack/%02d.png", i))
	}
	status, emptyCheck := testDoJSON(t, ownerClient, http.MethodPost, srv.URL+"/exclude-hashes/check", map[string]any{
		"sessionId": sid,
		"entries":   entries,
	})
	if status != http.StatusOK || len(emptyCheck["matched"].([]any)) != 0 {
		t.Fatalf("empty store check = (%d, %v), want (200, [])", status, emptyCheck)
	}

	// Add pack/20.png from zip session -> added=true, duplicate=false, count=1.
	status, addResp := testDoJSON(t, ownerClient, http.MethodPost, srv.URL+"/exclude-hashes/add", map[string]any{
		"sessionId": sid,
		"zipPath":   "pack/20.png",
		"name":      "20.png",
	})
	if status != http.StatusOK {
		t.Fatalf("add status = %d (%v)", status, addResp)
	}
	if addResp["added"] != true || addResp["duplicate"] != false || addResp["hash"] != adSHA || int(addResp["count"].(float64)) != 1 {
		t.Fatalf("unexpected addResp: %v", addResp)
	}

	// Verify excludehash.txt exists in configDir.
	if _, err := os.Stat(filepath.Join(cfgDir, "excludehash.txt")); err != nil {
		t.Fatalf("excludehash.txt missing in configDir: %v", err)
	}

	// Duplicate add on pack/19.png (same adBytes) -> added=false, duplicate=true.
	status, dupResp := testDoJSON(t, ownerClient, http.MethodPost, srv.URL+"/exclude-hashes/add", map[string]any{
		"sessionId": sid,
		"zipPath":   "pack/19.png",
	})
	if status != http.StatusOK || dupResp["added"] != false || dupResp["duplicate"] != true || int(dupResp["count"].(float64)) != 1 {
		t.Fatalf("unexpected dupResp: (%d, %v)", status, dupResp)
	}

	// Check zip session -> exactly 5 matched (16..20).
	status, chkResp := testDoJSON(t, ownerClient, http.MethodPost, srv.URL+"/exclude-hashes/check", map[string]any{
		"sessionId": sid,
		"entries":   entries[10:], // last 10
	})
	if status != http.StatusOK {
		t.Fatalf("check status = %d (%v)", status, chkResp)
	}
	matched := chkResp["matched"].([]any)
	if len(matched) != 5 {
		t.Fatalf("matched len = %d (%v), want 5", len(matched), matched)
	}

	// Foreign owner cannot check or add from owner's zip session.
	fStatus, _ := testDoJSON(t, foreignClient, http.MethodPost, srv.URL+"/exclude-hashes/check", map[string]any{
		"sessionId": sid,
		"entries":   entries,
	})
	if fStatus != http.StatusNotFound {
		t.Fatalf("foreign session check status = %d, want 404", fStatus)
	}

	// Check raw hashes endpoint (for fs/plain items).
	status, hashChk := testDoJSON(t, ownerClient, http.MethodPost, srv.URL+"/exclude-hashes/check", map[string]any{
		"hashes": []string{adSHA, "0000000000000000000000000000000000000000000000000000000000000000"},
	})
	if status != http.StatusOK || len(hashChk["matched"].([]any)) != 1 {
		t.Fatalf("hash check = (%d, %v), want 1 match", status, hashChk)
	}

	// Check backend grant directory.
	imgDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(imgDir, "good.png"), []byte("normal-story"), 0644)
	_ = os.WriteFile(filepath.Join(imgDir, "ad.png"), adBytes, 0644)
	g, err := h.grants.Grant(testOwner, []pathgrant.Operation{pathgrant.OpRead}, imgDir, true, false)
	if err != nil {
		t.Fatal(err)
	}
	status, grantChk := testDoJSON(t, ownerClient, http.MethodPost, srv.URL+"/exclude-hashes/check", map[string]any{
		"grantId": g.ID,
		"rels":    []string{"good.png", "ad.png"},
	})
	if status != http.StatusOK {
		t.Fatalf("grant check status = %d (%v)", status, grantChk)
	}
	gMatched := grantChk["matched"].([]any)
	if len(gMatched) != 1 || gMatched[0] != "ad.png" {
		t.Fatalf("grant matched = %v, want [ad.png]", gMatched)
	}

	// Remove by grant+rel, then verify check matches 0.
	status, remResp := testDoJSON(t, ownerClient, http.MethodPost, srv.URL+"/exclude-hashes/remove", map[string]any{
		"grantId": g.ID,
		"rel":     "ad.png",
	})
	if status != http.StatusOK || remResp["removed"] != true || int(remResp["count"].(float64)) != 0 {
		t.Fatalf("remove = (%d, %v)", status, remResp)
	}
	status, postRemChk := testDoJSON(t, ownerClient, http.MethodPost, srv.URL+"/exclude-hashes/check", map[string]any{
		"sessionId": sid,
		"entries":   entries,
	})
	if status != http.StatusOK || len(postRemChk["matched"].([]any)) != 0 {
		t.Fatalf("post-remove check = (%d, %v), want empty", status, postRemChk)
	}
}
