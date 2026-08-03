//go:build !windows

package fsutil

import (
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// OpenInFileManager opens path in the platform's file manager. On macOS it
// uses `open -R` to reveal the file in Finder. On Linux it opens the parent
// directory with xdg-open.
func OpenInFileManager(path string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", "-R", path)
	default:
		cmd = exec.Command("xdg-open", filepath.Dir(path))
	}
	return cmd.Start()
}

// OpenInBrowser opens the given URL in the default web browser.
func OpenInBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

// OpenFilePicker shows a native file picker dialog. On macOS it uses
// osascript; on Linux it returns ErrUnsupportedPlatform. The filter parameter
// is ignored on macOS (osascript does not support filters). Returns empty
// string if the user cancelled.
func OpenFilePicker(filter string) (string, error) {
	return OpenFilePickerAt(filter, "")
}

// OpenFilePickerAt is like OpenFilePicker but starts the dialog in the given
// directory. On macOS the initialDir is passed to "default location".
func OpenFilePickerAt(filter, initialDir string) (string, error) {
	if runtime.GOOS == "darwin" {
		script := "posix path of (choose file"
		if initialDir != "" {
			script += " default location (POSIX file \"" + initialDir + "\")"
		}
		script += ")"
		out, err := exec.Command("osascript", "-e", script).Output()
		if err != nil {
			return "", nil // user cancelled
		}
		return strings.TrimSpace(string(out)), nil
	}
	return "", ErrUnsupportedPlatform
}

// OpenDirectoryPicker shows a native directory picker dialog. On macOS it
// uses osascript; on Linux it returns ErrUnsupportedPlatform. Returns empty
// string if the user cancelled.
func OpenDirectoryPicker() (string, error) {
	return OpenDirectoryPickerAt("")
}

// OpenDirectoryPickerAt is like OpenDirectoryPicker but starts the dialog in
// the given directory.
func OpenDirectoryPickerAt(initialDir string) (string, error) {
	if runtime.GOOS == "darwin" {
		script := "posix path of (choose folder"
		if initialDir != "" {
			script += " default location (POSIX file \"" + initialDir + "\")"
		}
		script += ")"
		out, err := exec.Command("osascript", "-e", script).Output()
		if err != nil {
			return "", nil // user cancelled
		}
		return strings.TrimSpace(string(out)), nil
	}
	return "", ErrUnsupportedPlatform
}
