package app

import (
	"github.com/tinylab/tinylab/internal/fsutil"
)

// OpenBrowser opens the default browser for the current OS. It is used both by
// the console host (auto-open on start) and by the tray menu "打开控制台" item.
func OpenBrowser(url string) error {
	return fsutil.OpenInBrowser(url)
}
