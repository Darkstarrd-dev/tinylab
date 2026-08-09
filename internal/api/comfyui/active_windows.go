//go:build windows

package comfyui

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// readActiveWorkflow resolves the workflow currently selected in ComfyUI
// Desktop from its Chromium LevelDB store under %APPDATA%.
func readActiveWorkflow() (*activeWorkflow, error) {
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
