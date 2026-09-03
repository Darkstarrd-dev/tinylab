// Package fsbrowse exposes a feature-independent endpoint that opens the
// native OS file/directory picker dialog and returns the selected absolute
// path. It is shared by the assistant, gallery, and download frontends and is
// therefore mounted on /api without any feature gating.
package fsbrowse

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/fsutil"
)

// Handler implements the fsbrowse HTTP handlers. The picker endpoint is
// stateless, so the struct carries no dependencies.
type Handler struct{}

// NewHandler creates a new fsbrowse Handler.
func NewHandler() *Handler {
	return &Handler{}
}

// Register registers the fsbrowse routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Post("/browse", h.browseSystemPath)
}

// browseSystemPath launches the native OS file/directory picker dialog and
// returns the selected absolute path.
// POST /api/browse
// Body: { "mode": "file"|"directory", "initialPath": "...", "filter": "..." }
// filter is an optional Win32 dialog filter; it defaults to executables+all
// for file mode.
func (h *Handler) browseSystemPath(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Mode        string `json:"mode"`        // "file" or "directory"
		InitialPath string `json:"initialPath"` // optional; if the path is a file, its parent dir is used
		Filter      string `json:"filter"`      // optional Win32 dialog filter; defaults to executables+all for file mode
	}
	_ = json.NewDecoder(r.Body).Decode(&input)

	initialDir := resolveBrowseInitialDir(input.InitialPath, input.Mode)

	var selectedPath string
	if input.Mode == "directory" {
		selectedPath, _ = fsutil.OpenDirectoryPickerAt(initialDir)
	} else {
		fileFilter := input.Filter
		if fileFilter == "" {
			fileFilter = "Executables (*.exe)|*.exe|All Files (*.*)|*.*"
		}
		selectedPath, _ = fsutil.OpenFilePickerAt(fileFilter, initialDir)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"path": selectedPath})
}

// resolveBrowseInitialDir resolves the initial directory for a file/directory
// picker. If initialPath is empty, returns empty (picker uses default location).
// If initialPath is a file, returns its parent directory. If it's a directory,
// returns it as-is. If the path doesn't exist, attempts to create it as a
// directory (idempotent for existing dirs) so directory pickers can open at
// freshly configured subdirectories like imgs/ or traces/.
func resolveBrowseInitialDir(initialPath string, mode string) string {
	if initialPath == "" {
		return ""
	}
	info, err := os.Stat(initialPath)
	if err != nil {
		// Path doesn't exist — do NOT create arbitrary directories.
		// Previously this unconditionally MkdirAll'd the user-supplied path,
		// allowing an authenticated caller to create any directory the
			// server process can write. Returning empty lets the picker fall
			// back to its default location; the frontend may retry with a
			// known-good configDir subtree if needed.
		return ""
	}
	if info.IsDir() {
		return initialPath
	}
	return filepath.Dir(initialPath)
}
