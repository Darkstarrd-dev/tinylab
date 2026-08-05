package comfyui

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
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

func readActiveWorkflow() (*activeWorkflow, error) {
	if runtime.GOOS != "windows" {
		return nil, fs.ErrNotExist
	}
	for _, dir := range comfyDesktopLevelDBDirs() {
		active, err := readActiveWorkflowFromDir(dir)
		if err == nil {
			return active, nil
		}
	}
	return nil, fs.ErrNotExist
}

func comfyDesktopLevelDBDirs() []string {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return nil
	}
	root := filepath.Join(appData, "Comfy Desktop", "Partitions")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	type partitionDir struct {
		path string
		when int64
	}
	var dirs []partitionDir
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(root, entry.Name(), "Local Storage", "leveldb")
		info, statErr := os.Stat(path)
		if statErr == nil {
			dirs = append(dirs, partitionDir{path: path, when: info.ModTime().UnixNano()})
		}
	}
	sort.Slice(dirs, func(i, j int) bool {
		if dirs[i].when != dirs[j].when {
			return dirs[i].when > dirs[j].when
		}
		return dirs[i].path < dirs[j].path
	})
	out := make([]string, 0, len(dirs))
	for _, dir := range dirs {
		out = append(out, dir.path)
	}
	return out
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
