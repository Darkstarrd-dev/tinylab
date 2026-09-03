package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/assistant"
)

// chat handles POST /api/assistant/chat {message: string} → {reply, preset}.
func (h *Handler) chat(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	msg := strings.TrimSpace(req.Message)
	if msg == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "message is required")
		return
	}

	h.mu.RLock()
	presets := h.presets
	memory := h.memory
	sessions := h.sessions
	d := h.d
	chatAddrFn := h.chatAddr
	h.mu.RUnlock()

	if presets == nil || memory == nil || sessions == nil || d == nil || d.Reg == nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "assistant chat not configured")
		return
	}
	cfg := d.Reg.Config()
	if cfg.Assistant.Model == "" {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "assistant chat not configured: no model")
		return
	}

	preset := presets.ActivePreset()
	mem := memory.Read(preset.Name)

	// Resolve loopback addr.
	addr := ""
	if chatAddrFn != nil {
		addr = chatAddrFn()
	}
	if addr == "" {
		port := cfg.Port
		if port <= 0 {
			port = 20128
		}
		addr = fmt.Sprintf("http://127.0.0.1:%d", port)
	}

	messages := []assistant.ChatMessage{
		{Role: "system", Content: assistant.BuildSystemPrompt(preset, mem)},
	}
	messages = append(messages, sessions.Get(preset.Name)...)
	messages = append(messages, assistant.ChatMessage{Role: "user", Content: msg})

	client := &assistant.ChatClient{Addr: addr, Model: cfg.Assistant.Model}
	reply, err := client.Chat(r.Context(), messages, preset.Params)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}

	sessions.Append(preset.Name,
		assistant.ChatMessage{Role: "user", Content: msg},
		assistant.ChatMessage{Role: "assistant", Content: reply},
	)
	memory.NoteTurn(preset)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"reply":  reply,
		"preset": preset.Name,
	})
}

// getModelPresets handles GET /api/assistant/model-presets.
func (h *Handler) getModelPresets(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	presets := h.presets
	h.mu.RUnlock()
	if presets == nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "model presets not configured")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(presets.Get())
}

// putModelPresets handles PUT /api/assistant/model-presets.
func (h *Handler) putModelPresets(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	presets := h.presets
	h.mu.RUnlock()
	if presets == nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "model presets not configured")
		return
	}
	var f assistant.ModelPresetFile
	if err := json.NewDecoder(r.Body).Decode(&f); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if err := presets.Save(f); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// buildSummarizeMessages builds the system+user messages for the memory summarization call.
func buildSummarizeMessages(transcript, existing string) []assistant.ChatMessage {
	ex := existing
	if strings.TrimSpace(ex) == "" {
		ex = "（空）"
	}
	user := "【既有记忆】\n" + ex + "\n\n【新对话记录】\n" + transcript
	return []assistant.ChatMessage{
		{Role: "system", Content: assistant.SummarizeSystemPrompt},
		{Role: "user", Content: user},
	}
}

// summarizeViaChat is the MemoryManager.Summarize closure helper (called from router wiring).
func summarizeViaChat(ctx context.Context, preset assistant.ModelPreset, transcript, existing, addr, model string) (string, error) {
	if model == "" {
		return "", fmt.Errorf("no model for summarization")
	}
	msgs := buildSummarizeMessages(transcript, existing)
	client := &assistant.ChatClient{Addr: addr, Model: model}
	return client.Chat(ctx, msgs, nil)
}
