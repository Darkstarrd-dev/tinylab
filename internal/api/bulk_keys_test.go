package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

func TestBulkAddKeys_NameOffset(t *testing.T) {
	srv, reg, _, _ := setupTestServer(t)
	defer srv.Close()

	// Add a provider with 4 keys (Key-1 through Key-4)
	prov := config.Provider{
		ID: "bp", Name: "BulkProv", Prefix: "bp", BaseURL: "https://bp.com",
		APIType: "openai-compatible", IsActive: true,
		Keys: []config.Key{
			{ID: "k1", Key: "sk-1", Name: "Key-1", Priority: 1, IsActive: true},
			{ID: "k2", Key: "sk-2", Name: "Key-2", Priority: 1, IsActive: true},
			{ID: "k3", Key: "sk-3", Name: "Key-3", Priority: 1, IsActive: true},
			{ID: "k4", Key: "sk-4", Name: "Key-4", Priority: 1, IsActive: true},
		},
	}
	reg.AddProvider(prov)

	// Bulk add 2 keys without explicit names
	resp := requestJSON(t, "POST", srv.URL+"/api/providers/bp/keys/bulk",
		`{"keys":[{"key":"sk-x"},{"key":"sk-y"}]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var body map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &body)
	if body["added"] != float64(2) {
		t.Errorf("expected added=2, got %v", body["added"])
	}

	// Verify keys in config
	p, ok := reg.GetProvider("bp")
	if !ok {
		t.Fatal("provider bp not found")
	}
	if len(p.Keys) != 6 {
		t.Fatalf("expected 6 keys, got %d", len(p.Keys))
	}
	if p.Keys[4].Name != "Key-5" {
		t.Errorf("expected key[4].Name=Key-5, got %q", p.Keys[4].Name)
	}
	if p.Keys[5].Name != "Key-6" {
		t.Errorf("expected key[5].Name=Key-6, got %q", p.Keys[5].Name)
	}
}

func TestBulkAddKeys_ExplicitNamePreserved(t *testing.T) {
	srv, reg, _, _ := setupTestServer(t)
	defer srv.Close()

	prov := config.Provider{
		ID: "bp", Name: "BulkProv", Prefix: "bp", BaseURL: "https://bp.com",
		APIType: "openai-compatible", IsActive: true,
		Keys: []config.Key{
			{ID: "k1", Key: "sk-1", Name: "Key-1", Priority: 1, IsActive: true},
			{ID: "k2", Key: "sk-2", Name: "Key-2", Priority: 1, IsActive: true},
			{ID: "k3", Key: "sk-3", Name: "Key-3", Priority: 1, IsActive: true},
			{ID: "k4", Key: "sk-4", Name: "Key-4", Priority: 1, IsActive: true},
		},
	}
	reg.AddProvider(prov)

	resp := requestJSON(t, "POST", srv.URL+"/api/providers/bp/keys/bulk",
		`{"keys":[{"name":"Foo","key":"sk-x"},{"name":"Bar","key":"sk-y"}]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var body map[string]any
	json.Unmarshal([]byte(readBody(t, resp)), &body)
	if body["added"] != float64(2) {
		t.Errorf("expected added=2, got %v", body["added"])
	}

	p, ok := reg.GetProvider("bp")
	if !ok {
		t.Fatal("provider bp not found")
	}
	if len(p.Keys) != 6 {
		t.Fatalf("expected 6 keys, got %d", len(p.Keys))
	}
	if p.Keys[4].Name != "Foo" {
		t.Errorf("expected key[4].Name=Foo, got %q", p.Keys[4].Name)
	}
	if p.Keys[5].Name != "Bar" {
		t.Errorf("expected key[5].Name=Bar, got %q", p.Keys[5].Name)
	}
}
