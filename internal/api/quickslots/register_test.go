package quickslots

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/registry"
)

func newTestQuickSlotsRouter(t *testing.T) (*Handler, *chi.Mux, *registry.Registry) {
	t.Helper()
	cfg := config.DefaultConfig()
	reg := registry.New(cfg)
	deps := &apibase.Deps{
		Reg:        reg,
		ConfigPath: filepath.Join(t.TempDir(), "config.yaml"),
		Logger:     console.New(100),
	}
	h := NewHandler(deps)
	r := chi.NewRouter()
	h.Register(r)
	return h, r, reg
}

func TestQuickSlotPresetsAPI(t *testing.T) {
	_, r, reg := newTestQuickSlotsRouter(t)

	// 准备初始 quickslots
	reg.AddQuickSlot(config.QuickSlot{
		ID:            "qs_1",
		Name:          "Coding",
		Models:        []string{"openai/gpt-4o", "anthropic/claude-3-5-sonnet"},
		SelectedIndex: 0,
	})

	// 1. GET /quickslots/presets -> 初始应为空
	req := httptest.NewRequest(http.MethodGet, "/quickslots/presets", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var listResp struct {
		Presets []config.QuickSlotPreset `json:"presets"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if len(listResp.Presets) != 0 {
		t.Fatalf("expected 0 presets, got %d", len(listResp.Presets))
	}

	// 2. POST /quickslots/presets -> 保存当前为 "Dev"
	createBody, _ := json.Marshal(map[string]string{"name": "Dev"})
	req = httptest.NewRequest(http.MethodPost, "/quickslots/presets", bytes.NewReader(createBody))
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create preset expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// 3. 修改 quickslot
	reg.UpdateQuickSlot("qs_1", config.QuickSlot{
		Name:          "Coding",
		Models:        []string{"google/gemini-flash"},
		SelectedIndex: 0,
	})

	// 4. POST /quickslots/presets/apply -> 应用 "Dev"
	applyBody, _ := json.Marshal(map[string]string{"name": "Dev"})
	req = httptest.NewRequest(http.MethodPost, "/quickslots/presets/apply", bytes.NewReader(applyBody))
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("apply preset expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	qs, ok := reg.GetQuickSlot("qs_1")
	if !ok || len(qs.Models) != 2 || qs.Models[0] != "openai/gpt-4o" {
		t.Fatalf("qs_1 was not restored by Dev preset: %+v", qs)
	}

	// 5. DELETE /quickslots/presets/Dev -> 删除预设
	req = httptest.NewRequest(http.MethodDelete, "/quickslots/presets/Dev", nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete preset expected 200, got %d", rec.Code)
	}

	// 6. 再次 GET -> 应该为空
	req = httptest.NewRequest(http.MethodGet, "/quickslots/presets", nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	var listResp2 struct {
		Presets []config.QuickSlotPreset `json:"presets"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &listResp2)
	if len(listResp2.Presets) != 0 {
		t.Fatalf("expected 0 presets after delete, got %d", len(listResp2.Presets))
	}
}
