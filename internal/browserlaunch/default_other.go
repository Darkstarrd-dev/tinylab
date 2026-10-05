//go:build !windows

package browserlaunch

// Default describes the OS default browser as far as it can be resolved. On
// macOS/Linux there is no portable, dependency-free query for the default
// browser handler, so Path stays empty: a private/profile launch against "the
// current default browser" is refused (ErrNoDefaultBrowser) instead of opening
// a normal window and calling it private. The user can still pick a detected
// browser (the registration-free path) — see detect.go.
type Default struct {
	Path        string `json:"path,omitempty"`
	Family      Family `json:"family,omitempty"`
	Label       string `json:"label,omitempty"`
	PrivateOK   bool   `json:"privateOk"`
	PrivateFlag string `json:"privateFlag,omitempty"`
}

// DefaultBrowser is unavailable outside Windows (see the type comment). The
// "shared session + default browser" arm still works through the OS shell
// (fsutil.OpenInBrowser), which is exactly the legacy behavior.
func DefaultBrowser() Default { return Default{} }
