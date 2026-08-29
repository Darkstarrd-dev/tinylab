package textreview

import (
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"runtime/debug"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	tr "github.com/tinyrouter/tinyrouter/internal/textreview"
)

// createSession creates and starts a text-review session.
// POST /api/text-review/sessions
// Body: {fileName, rawText, chapters:[{title,content}], systemPrompt, nodeIds:[]}
// Response: {sessionId}
func (h *Handler) createSession(w http.ResponseWriter, r *http.Request) {
	var req tr.CreateSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if len(req.Chapters) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "at least one chapter is required")
		return
	}
	if len(req.NodeIDs) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "at least one nodeId is required")
		return
	}
	if req.SystemPrompt == "" {
		req.SystemPrompt = defaultCleanSystemPrompt
	}
	if tr.SessionCount() >= tr.MaxSessions {
		apibase.WriteAPIError(w, http.StatusTooManyRequests, fmt.Sprintf("too many sessions (%d max)", tr.MaxSessions))
		return
	}
	if tr.EstimateBytes() > tr.MaxSessionBytes {
		apibase.WriteAPIError(w, http.StatusTooManyRequests, "session store byte budget exceeded; delete old sessions first")
		return
	}
	s := tr.CreateSession(req, h.d)
	tr.StoreSession(s)
	h.engineOnce().Start(s)
	// Return the authoritative post-Start status so the client can surface an
	// instantly-terminated session (e.g. no usable node) instead of waiting for
	// SSE and silently showing nothing.
	status := tr.SessionRunning
	s.Lock()
	if s.Status != "" {
		status = s.Status
	}
	s.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"sessionId": s.ID, "status": status})
}

// getSession returns a full snapshot of the session.
// GET /api/text-review/sessions/{id}
func (h *Handler) getSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s := tr.GetSession(id)
	if s == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "session not found")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.Snapshot())
}

// sessionEvents streams SSE events for a session. The handler subscribes,
// writes each event as "data: <json>\n\n" with a Flush, and unsubscribes on
// client disconnect. On a missing session it returns 404.
// GET /api/text-review/sessions/{id}/events
func (h *Handler) sessionEvents(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s := tr.GetSession(id)
	if s == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "session not found")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	// Subscribe BEFORE the initial flush: callers that synchronize on the
	// flush (tests, reconnecting clients) must be guaranteed that every
	// event broadcast after the flush reaches this subscriber.
	sub := tr.Subscribe(s)
	defer tr.Unsubscribe(s, sub)

	flusher.Flush()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case evt, ok := <-sub.Events():
			if !ok {
				return
			}
			data := evt.JSON()
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.Type, data); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// pauseSession pauses the dispatcher (in-flight workers continue).
// POST /api/text-review/sessions/{id}/pause
func (h *Handler) pauseSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s := tr.GetSession(id)
	if s == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "session not found")
		return
	}
	h.engineOnce().Pause(s)
	writeOK(w)
}

// resumeSession clears the paused flag and signals the dispatcher.
// POST /api/text-review/sessions/{id}/resume
func (h *Handler) resumeSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s := tr.GetSession(id)
	if s == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "session not found")
		return
	}
	h.engineOnce().Resume(s)
	writeOK(w)
}

// stopSession cancels the session (in-flight workers abort).
// POST /api/text-review/sessions/{id}/stop
func (h *Handler) stopSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s := tr.GetSession(id)
	if s == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "session not found")
		return
	}
	h.engineOnce().Stop(s)
	writeOK(w)
}

// restartSession resumes a cancelled/completed session: resets non-completed
// chapters to pending (keeping completed as-is) and restarts the dispatcher
// with an optional refreshed node pool. Returns 409 if already running/paused.
// POST /api/text-review/sessions/{id}/restart
func (h *Handler) restartSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s := tr.GetSession(id)
	if s == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "session not found")
		return
	}
	var req struct {
		NodeIDs []string `json:"nodeIds"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	s.Lock()
	if s.Status == tr.SessionRunning || s.Status == tr.SessionPaused {
		s.Unlock()
		apibase.WriteAPIError(w, http.StatusConflict, "session already running")
		return
	}
	hasPending := false
	for i := range s.Chapters {
		if s.Chapters[i].Status == tr.StatusCompleted {
			continue
		}
		s.Chapters[i].Status = tr.StatusPending
		s.Chapters[i].Cleaned = ""
		s.Chapters[i].Error = ""
		s.Chapters[i].NodeID = ""
		s.Chapters[i].Retry = 0
		s.Chapters[i].DebugRequest = ""
		s.Chapters[i].DebugRawBody = ""
		s.Chapters[i].DebugStatusCode = 0
		hasPending = true
	}
	if len(req.NodeIDs) > 0 && h.d != nil && h.d.Reg != nil {
		configNodes := map[string]config.TextReviewNode{}
		for _, n := range h.d.Reg.ListTextReviewNodes() {
			configNodes[n.ID] = n
		}
		newNodes := make([]tr.NodeRuntime, 0, len(req.NodeIDs))
		for _, nid := range req.NodeIDs {
			if n, ok := configNodes[nid]; ok {
				newNodes = append(newNodes, tr.NodeRuntime{TextReviewNode: n, Target: n.Concurrency})
			}
		}
		if len(newNodes) > 0 {
			s.Nodes = newNodes
		}
	}
	s.Unlock()
	if !hasPending {
		apibase.WriteAPIError(w, http.StatusBadRequest, "no pending chapters to restart")
		return
	}
	if !h.engineOnce().Start(s) {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to restart session")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"sessionId": s.ID})
}

// deleteSession cancels the session and removes it from the store so sessions
// cannot grow unbounded.
// DELETE /api/text-review/sessions/{id}
func (h *Handler) deleteSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if tr.GetSession(id) == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "session not found")
		return
	}
	if !tr.DeleteSession(id) {
		apibase.WriteAPIError(w, http.StatusNotFound, "session not found")
		return
	}
	writeOK(w)
}

// reprocessChapter resets a single chapter to pending and nudges the dispatcher.
// POST /api/text-review/sessions/{id}/chapters/{idx}/reprocess
func (h *Handler) reprocessChapter(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s := tr.GetSession(id)
	if s == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "session not found")
		return
	}
	idx, err := strconv.Atoi(chi.URLParam(r, "idx"))
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid chapter index")
		return
	}
	if !h.engineOnce().ReprocessChapter(s, idx) {
		apibase.WriteAPIError(w, http.StatusBadRequest, "chapter index out of range")
		return
	}
	writeOK(w)
}

// writeOK writes the standard {ok:true} success envelope.
func writeOK(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// clearAllSessions cancels and removes all in-memory sessions, releasing memory.
// POST /api/text-review/clear
func (h *Handler) clearAllSessions(w http.ResponseWriter, r *http.Request) {
	tr.ClearAllSessions()
	if h.d != nil && h.d.Logger != nil {
		h.d.Logger.Info("textreview: cleared all sessions & released memory")
	}
	go func() {
		time.Sleep(100 * time.Millisecond)
		runtime.GC()
		debug.FreeOSMemory()
	}()
	writeOK(w)
}
