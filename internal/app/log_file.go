package app

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// errorLogName is the file name used for fatal startup error logs.
const errorLogName = "tinyrouter-error.log"

// writeErrorLog writes a timestamped error message to the error log file,
// overwriting any previous content. Errors are silently ignored to avoid
// blocking the startup flow.
func writeErrorLog(configDir, msg string) {
	if configDir == "" {
		return
	}
	path := filepath.Join(configDir, errorLogName)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()

	// Use Go standard library log-compatible timestamp format.
	_, _ = fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006/01/02 15:04:05"), msg)
}

// clearErrorLog removes the error log file after a successful startup, so a
// stale error log from a previous failed launch does not confuse the user.
// Errors are silently ignored.
func clearErrorLog(configDir string) {
	if configDir == "" {
		return
	}
	_ = os.Remove(filepath.Join(configDir, errorLogName))
}
