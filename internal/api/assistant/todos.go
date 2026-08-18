package assistant

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
)

// TodoItem represents a user todo / reminder item.
type TodoItem struct {
	ID        string    `json:"id"`
	Text      string    `json:"text"`
	DueAt     string    `json:"dueAt,omitempty"` // RFC3339 formatted or empty
	Done      bool      `json:"done"`
	CreatedAt time.Time `json:"createdAt"`
	Notified  bool      `json:"notified"` // whether due notification has fired
}

// TodoStore holds in-memory todo items.
type TodoStore struct {
	mu    sync.RWMutex
	todos map[string]*TodoItem
}

// NewTodoStore creates an empty TodoStore.
func NewTodoStore() *TodoStore {
	return &TodoStore{
		todos: make(map[string]*TodoItem),
	}
}

func genID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// List returns a copy of all todos.
func (s *TodoStore) List() []*TodoItem {
	s.mu.RLock()
	defer s.mu.RUnlock()
	res := make([]*TodoItem, 0, len(s.todos))
	for _, item := range s.todos {
		cpy := *item
		res = append(res, &cpy)
	}
	return res
}

// Add adds a new todo item.
func (s *TodoStore) Add(text, dueAt string) *TodoItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := genID()
	item := &TodoItem{
		ID:        id,
		Text:      text,
		DueAt:     dueAt,
		Done:      false,
		CreatedAt: time.Now(),
	}
	s.todos[id] = item
	cpy := *item
	return &cpy
}

// Update modifies an existing todo.
func (s *TodoStore) Update(id string, text *string, dueAt *string, done *bool) (*TodoItem, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.todos[id]
	if !ok {
		return nil, false
	}
	if text != nil {
		item.Text = *text
	}
	if dueAt != nil {
		item.DueAt = *dueAt
		item.Notified = false // reset notification for new due date
	}
	if done != nil {
		item.Done = *done
	}
	cpy := *item
	return &cpy, true
}

// Delete removes a todo item.
func (s *TodoStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.todos[id]; !ok {
		return false
	}
	delete(s.todos, id)
	return true
}

// MarkNotified flags a todo as having fired its due notification.
func (s *TodoStore) MarkNotified(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if item, ok := s.todos[id]; ok {
		item.Notified = true
	}
}

// CheckDue returns pending unnotified todos whose DueAt is in the past.
func (s *TodoStore) CheckDue(now time.Time) []*TodoItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	var due []*TodoItem
	for _, item := range s.todos {
		if item.Done || item.Notified || item.DueAt == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339, item.DueAt)
		if err != nil {
			continue
		}
		if now.After(t) || now.Equal(t) {
			item.Notified = true
			cpy := *item
			due = append(due, &cpy)
		}
	}
	return due
}

// HTTP handlers for Todos

func (h *Handler) getTodos(w http.ResponseWriter, r *http.Request) {
	todos := h.todos.List()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"todos": todos})
}

func (h *Handler) createTodo(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text  string `json:"text"`
		DueAt string `json:"dueAt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Text == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "text cannot be empty")
		return
	}
	item := h.todos.Add(req.Text, req.DueAt)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"todo": item})
}

func (h *Handler) updateTodo(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing todo id")
		return
	}
	var req struct {
		Text  *string `json:"text"`
		DueAt *string `json:"dueAt"`
		Done  *bool   `json:"done"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	item, ok := h.todos.Update(id, req.Text, req.DueAt, req.Done)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "todo not found")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"todo": item})
}

func (h *Handler) deleteTodo(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing todo id")
		return
	}
	if !h.todos.Delete(id) {
		apibase.WriteAPIError(w, http.StatusNotFound, "todo not found")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
