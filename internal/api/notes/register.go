package notes

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/pathgrant"
)

var appendMu sync.Mutex

// Handler exposes the notes append endpoint.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register wires up routes.
func (h *Handler) Register(r chi.Router) {
	r.Post("/notes/append", h.appendNote)
}

func (h *Handler) appendNote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "content is empty")
		return
	}
	if len(content) > 1<<20 {
		apibase.WriteAPIError(w, http.StatusRequestEntityTooLarge, "content too large (max 1MiB)")
		return
	}

	docDir := h.resolveDocDir()
	if err := os.MkdirAll(docDir, 0o755); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	fileName := time.Now().Format("20060102") + "-NOTE.md"
	// Validate fileName is a safe relative path.
	if _, err := pathgrant.StrictRel(fileName); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "invalid note filename")
		return
	}
	full := filepath.Join(docDir, filepath.FromSlash(fileName))

	// Ensure the resolved path stays inside docDir (protect against symlink escape).
	if !realPathWithin(docDir, filepath.Dir(full)) {
		apibase.WriteAPIError(w, http.StatusBadRequest, "path escapes the document directory")
		return
	}

	appendMu.Lock()
	defer appendMu.Unlock()

	// Ensure newline separation.
	var needNewline bool
	if st, err := os.Stat(full); err == nil && st.Size() > 0 {
		f, err := os.Open(full)
		if err == nil {
			buf := make([]byte, 1)
			if _, err := f.Seek(-1, 2); err == nil {
				if _, err := f.Read(buf); err == nil {
					if buf[0] != '\n' {
						needNewline = true
					}
				}
			}
			f.Close()
		}
	}

	f, err := os.OpenFile(full, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer f.Close()

	if needNewline {
		if _, err := f.WriteString("\n"); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	if _, err := f.WriteString(content); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = f.Sync()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":     true,
		"fileId": fileName,
	})
}

func (h *Handler) resolveDocDir() string {
	docDir := "docs"
	if h != nil && h.d != nil {
		cfg := h.d.Reg.Config()
		configDir := ""
		if h.d.ConfigPath != "" {
			configDir = filepath.Dir(h.d.ConfigPath)
		}
		docDir = config.ResolveDocDir(cfg.DocDir, configDir)
	}
	abs, err := filepath.Abs(docDir)
	if err != nil {
		return docDir
	}
	return abs
}

func realPathWithin(root, dir string) bool {
	cur := dir
	for {
		if real, err := filepath.EvalSymlinks(cur); err == nil {
			return real == root || strings.HasPrefix(real, root+string(filepath.Separator))
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return false
		}
		cur = parent
	}
}
