// Package textreview provides HTTP handlers for the AI text-review API:
// the processing-node pool, chapter split patterns, the built-in default
// cleanup prompt (P1), and the session/scheduling endpoints that drive the
// in-process text-review engine (P2).
package textreview

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	tr "github.com/tinyrouter/tinyrouter/internal/textreview"
)

// defaultCleanSystemPrompt is the built-in cleanup prompt returned by
// /prompt-default. P2 will refine this into a fuller instruction set.
// TODO(P2): refine prompt
const defaultCleanSystemPrompt = `你是一名小说文本清理助手。请对输入的章节正文执行清理，规则如下：
- 删除广告、推广、二维码/公众号/加群/扫码等引流内容；
- 删除乱码、无意义装饰性符号行、纯分隔符行；
- 保留原文叙事内容、段落结构与作者文笔，不得改写、润色或增删剧情；
- 不得添加任何注释、说明、前后缀或格式标记。
仅输出清理后的正文，不要输出任何其它内容。`

// Handler wires up the text-review configuration routes. P2 adds session/
// scheduling endpoints backed by a lazily-constructed Engine.
type Handler struct {
	d       *apibase.Deps
	engine  *tr.Engine
	cleaner tr.Cleaner // optional test injection; nil uses the real ProxyCleaner
}

// NewHandler creates a new text-review Handler bound to the given deps.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// SetCleanerForTest injects a fake Cleaner for unit testing the session
// endpoints without a live proxy. Production code never calls this.
func (h *Handler) SetCleanerForTest(c tr.Cleaner) { h.cleaner = c }

// engineOnce lazily builds the Engine on first use. The cleaner defaults to a
// ProxyCleaner bound to the deps; tests override via SetCleanerForTest.
func (h *Handler) engineOnce() *tr.Engine {
	if h.engine != nil {
		return h.engine
	}
	cleaner := h.cleaner
	if cleaner == nil {
		cleaner = tr.NewProxyCleaner(h.d)
	}
	h.engine = tr.NewEngine(cleaner, NewRegistryPersister(h.d), h.d.Logger)
	return h.engine
}

// Register registers the text-review routes on the given router. The caller
// mounts this handler under the /api/text-review group (auth-gated, 32 MiB
// body limit), so the routes resolve at:
//
//	GET    /api/text-review/review-nodes          list the processing-node pool
//	POST   /api/text-review/review-nodes          upsert a node (create if no ID, update if ID)
//	DELETE /api/text-review/review-nodes/{id}     delete a node
//	GET    /api/text-review/split-patterns        list chapter-detection patterns
//	POST   /api/text-review/split-patterns        upsert a pattern (by key)
//	DELETE /api/text-review/split-patterns/{key}  delete a pattern
//	GET    /api/text-review/prompt-default        built-in default cleanup prompt
//	POST   /api/text-review/sessions              create + start a review session
//	GET    /api/text-review/sessions/{id}         full session snapshot
//	GET    /api/text-review/sessions/{id}/events SSE live stream (chunks + status)
//	POST   /api/text-review/sessions/{id}/pause  pause the dispatcher
//	POST   /api/text-review/sessions/{id}/resume resume the dispatcher
//	POST   /api/text-review/sessions/{id}/chapters/{idx}/reprocess  re-clean one chapter
//	DELETE /api/text-review/sessions/{id}   cancel + remove a session
func (h *Handler) Register(r chi.Router) {
	r.Get("/review-nodes", h.listReviewNodes)
	r.Post("/review-nodes", h.upsertReviewNode)
	r.Delete("/review-nodes/{id}", h.deleteReviewNode)

	r.Get("/split-patterns", h.listSplitPatterns)
	r.Post("/split-patterns", h.upsertSplitPattern)
	r.Delete("/split-patterns/{key}", h.deleteSplitPattern)

	r.Get("/prompt-default", h.getPromptDefault)

	// Sessions + scheduling (P2).
	r.Post("/sessions", h.createSession)
	r.Get("/sessions/{id}", h.getSession)
	r.Get("/sessions/{id}/events", h.sessionEvents)
	r.Post("/sessions/{id}/pause", h.pauseSession)
	r.Post("/sessions/{id}/resume", h.resumeSession)
	r.Post("/sessions/{id}/stop", h.stopSession)
	r.Post("/sessions/{id}/chapters/{idx}/reprocess", h.reprocessChapter)
	r.Delete("/sessions/{id}", h.deleteSession)
}

// listReviewNodes returns the text-review processing-node pool.
// GET /api/text-review/review-nodes
func (h *Handler) listReviewNodes(w http.ResponseWriter, r *http.Request) {
	nodes := h.d.Reg.ListTextReviewNodes()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"nodes": nodes})
}

// upsertReviewNode handles both create (no ID) and update (with ID) operations.
// POST /api/text-review/review-nodes
func (h *Handler) upsertReviewNode(w http.ResponseWriter, r *http.Request) {
	var n config.TextReviewNode
	if err := json.NewDecoder(r.Body).Decode(&n); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	if n.ID == "" {
		// Create
		n.ID = apibase.GenerateID("trn")
		h.d.Reg.AddTextReviewNode(n)
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{"node": n})
	} else {
		// Update
		if h.d.Reg.UpdateTextReviewNode(n.ID, n) {
			cfg := h.d.Reg.Config()
			if err := h.d.SaveConfig(&cfg); err != nil {
				apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"ok": true})
		} else {
			apibase.WriteAPIError(w, http.StatusNotFound, "review node not found")
		}
	}
}

// deleteReviewNode deletes a text-review node by ID.
// DELETE /api/text-review/review-nodes/{id}
func (h *Handler) deleteReviewNode(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if h.d.Reg.DeleteTextReviewNode(id) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "review node not found")
	}
}

// listSplitPatterns returns the chapter-detection split patterns.
// GET /api/text-review/split-patterns
func (h *Handler) listSplitPatterns(w http.ResponseWriter, r *http.Request) {
	patterns := h.d.Reg.ListSplitPatterns()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"patterns": patterns})
}

// upsertSplitPattern handles upsert-by-key: if a pattern with the given key
// exists it is updated, otherwise a new one is created. A non-empty key is
// required (it is the pattern's stable identifier).
// POST /api/text-review/split-patterns
func (h *Handler) upsertSplitPattern(w http.ResponseWriter, r *http.Request) {
	var p config.SplitPattern
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if p.Key == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "key is required")
		return
	}

	created := !h.d.Reg.UpdateSplitPattern(p.Key, p)
	if created {
		h.d.Reg.AddSplitPattern(p)
	}
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfig(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if created {
		w.WriteHeader(http.StatusCreated)
	}
	json.NewEncoder(w).Encode(map[string]any{"pattern": p})
}

// deleteSplitPattern deletes a split pattern by key.
// DELETE /api/text-review/split-patterns/{key}
func (h *Handler) deleteSplitPattern(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if h.d.Reg.DeleteSplitPattern(key) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "split pattern not found")
	}
}

// getPromptDefault returns the built-in default cleanup system prompt.
// GET /api/text-review/prompt-default
func (h *Handler) getPromptDefault(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"systemPrompt": defaultCleanSystemPrompt})
}
