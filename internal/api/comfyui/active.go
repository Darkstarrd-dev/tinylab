package comfyui

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// activeWorkflow describes the workflow currently selected in ComfyUI
// Desktop. The path is resolved through ComfyUI's /userdata API by the
// Playground, which keeps the workflow contents on the ComfyUI side.
type activeWorkflow struct {
	Path      string `json:"path"`
	Workspace string `json:"workspaceId,omitempty"`
}

type activeWorkflowPath struct {
	Workspace string `json:"workspaceId"`
	Path      string `json:"path"`
}

func readActiveWorkflowFromDir(dir string) (*activeWorkflow, error) {
	activePath, err := findActiveWorkflowPath(dir)
	if err != nil {
		return nil, err
	}
	cleanPath := normalizeComfyWorkflowPath(activePath.Path)
	if !validComfyWorkflowPath(cleanPath) {
		return nil, fs.ErrNotExist
	}
	return &activeWorkflow{
		Path:      strings.TrimPrefix(cleanPath, "workflows/"),
		Workspace: activePath.Workspace,
	}, nil
}

func normalizeComfyWorkflowPath(path string) string {
	return strings.ReplaceAll(strings.TrimSpace(path), "\\", "/")
}

func validComfyWorkflowPath(path string) bool {
	if !strings.HasPrefix(path, "workflows/") || !strings.HasSuffix(strings.ToLower(path), ".json") {
		return false
	}
	for _, part := range strings.Split(strings.TrimPrefix(path, "workflows/"), "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func findActiveWorkflowPath(dir string) (*activeWorkflowPath, error) {
	files := levelDBDataFiles(dir)
	const key = "Comfy.Workflow.LastActivePath:"
	var found *activeWorkflowPath
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		for offset := 0; offset < len(data); {
			idx := bytes.Index(data[offset:], []byte(key))
			if idx < 0 {
				break
			}
			offset += idx + len(key)
			value, ok := jsonAfterKey(data[offset:])
			if !ok {
				continue
			}
			var active activeWorkflowPath
			if json.Unmarshal(value, &active) == nil && active.Path != "" {
				found = &active
			}
		}
	}
	if found == nil {
		return nil, fs.ErrNotExist
	}
	return found, nil
}

func levelDBDataFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var files []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := strings.ToLower(entry.Name())
		if strings.HasSuffix(name, ".log") || strings.HasSuffix(name, ".ldb") {
			files = append(files, filepath.Join(dir, entry.Name()))
		}
	}
	sort.Strings(files)
	return files
}

func jsonAfterKey(data []byte) ([]byte, bool) {
	for i := range data {
		if data[i] != '{' {
			continue
		}
		var value json.RawMessage
		decoder := json.NewDecoder(bytes.NewReader(data[i:]))
		if decoder.Decode(&value) == nil && len(value) > 0 {
			return value, true
		}
	}
	return nil, false
}
