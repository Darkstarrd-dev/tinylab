//go:build !windows

package fsutil

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// pickerEnvVar carries the initial picker directory to osascript. The value
// travels through the environment, never through the AppleScript source, so a
// hostile initialDir (quotes, backslashes, newlines, AppleScript tokens)
// cannot inject script.
const pickerEnvVar = "TR_PICKER_INITIAL_DIR"

// osascriptPickerScript returns the AppleScript source for a file/folder
// picker. kind must be one of the fixed strings "file" or "folder". The
// initial directory is read from the environment at runtime, so no caller
// input is ever interpolated into the script text.
func osascriptPickerScript(kind string) string {
	return "set initialDir to (system attribute \"" + pickerEnvVar + "\")\n" +
		"if initialDir is not \"\" then\n" +
		"\treturn posix path of (choose " + kind + " default location (POSIX file initialDir))\n" +
		"end if\n" +
		"return posix path of (choose " + kind + ")"
}

// runOSAPicker executes the parameterized osascript picker for the given kind
// ("file" or "folder"), passing initialDir through the environment. Returns
// empty string if the user cancelled.
func runOSAPicker(kind, initialDir string) (string, error) {
	cmd := exec.Command("osascript", "-e", osascriptPickerScript(kind))
	cmd.Env = append(os.Environ(), pickerEnvVar+"="+initialDir)
	out, err := cmd.Output()
	if err != nil {
		return "", nil // user cancelled
	}
	return strings.TrimSpace(string(out)), nil
}

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
		return runOSAPicker("file", initialDir)
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
		return runOSAPicker("folder", initialDir)
	}
	return "", ErrUnsupportedPlatform
}
