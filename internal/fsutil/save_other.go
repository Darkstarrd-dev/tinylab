//go:build !windows

package fsutil

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

const (
	savePickerNameEnvVar = "TR_PICKER_SUGGESTED_NAME"
)

// osascriptSavePickerScript returns AppleScript to prompt for a save destination
// without injecting user strings into script text.
func osascriptSavePickerScript() string {
	return `set initialDir to (system attribute "` + pickerEnvVar + `")
set suggestedName to (system attribute "` + savePickerNameEnvVar + `")
if initialDir is not "" and suggestedName is not "" then
	return posix path of (choose file name default location (POSIX file initialDir) default name suggestedName)
else if initialDir is not "" then
	return posix path of (choose file name default location (POSIX file initialDir))
else if suggestedName is not "" then
	return posix path of (choose file name default name suggestedName)
else
	return posix path of (choose file name)
end if`
}

// SaveFilePickerAt displays a native file save dialog.
// On macOS it uses osascript; on Linux it returns ErrUnsupportedPlatform.
func SaveFilePickerAt(filter, initialDir, suggestedName string) (string, error) {
	if runtime.GOOS == "darwin" {
		cmd := exec.Command("osascript", "-e", osascriptSavePickerScript())
		cmd.Env = append(os.Environ(),
			pickerEnvVar+"="+initialDir,
			savePickerNameEnvVar+"="+suggestedName,
		)
		out, err := cmd.CombinedOutput()
		if err != nil {
			outStr := string(out)
			// User cancelled in AppleScript produces error -128 / "User canceled."
			if strings.Contains(outStr, "-128") || strings.Contains(strings.ToLower(outStr), "user canceled") {
				return "", nil
			}
			return "", fmt.Errorf("osascript save dialog failed: %w (output: %s)", err, strings.TrimSpace(outStr))
		}
		return strings.TrimSpace(string(out)), nil
	}
	return "", ErrUnsupportedPlatform
}
