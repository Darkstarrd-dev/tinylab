//go:build windows

package browserlaunch

import (
	"os"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// Default describes the OS default browser as far as it can be resolved.
// Path is empty when the association could not be read (the caller must then
// refuse a private/profile launch rather than silently fall back to a shared
// window — see ErrNoDefaultBrowser).
type Default struct {
	// Path is the resolved executable of the default browser.
	Path string `json:"path,omitempty"`
	// Family is its engine family (FamilyUnknown when unrecognized).
	Family Family `json:"family,omitempty"`
	// Label is the product name.
	Label string `json:"label,omitempty"`
	// PrivateOK reports whether the private switch is known for this family.
	PrivateOK bool `json:"privateOk"`
	// PrivateFlag is the switch text (e.g. "--incognito").
	PrivateFlag string `json:"privateFlag,omitempty"`
}

// DefaultBrowser resolves the user's default browser through the URL
// association chain:
//
//	HKCU\…\UrlAssociations\http\UserChoice  → ProgId (e.g. "ChromeHTML")
//	{HKCU,HKLM}\Software\Classes\<ProgId>\shell\open\command → command line
//
// Only the http association is consulted: it is the one the login flow would
// have used through the shell.
func DefaultBrowser() Default {
	progID := urlAssociationProgID()
	if progID == "" {
		return Default{}
	}
	cmd := classOpenCommand(progID)
	if cmd == "" {
		return Default{}
	}
	exe, err := commandExe(cmd, func(p string) bool {
		st, err := os.Stat(p)
		return err == nil && st != nil && !st.IsDir()
	})
	if err != nil || exe == "" {
		return Default{}
	}
	d := Default{Path: exe, Family: FamilyOf(exe), Label: LabelOf(exe)}
	if args, ok := PrivateArgs(d.Family); ok {
		d.PrivateOK = true
		d.PrivateFlag = strings.Join(args, " ")
	}
	return d
}

// urlAssociationProgID reads the http URL-association ProgId for the current
// user ("" when unset/unreadable).
func urlAssociationProgID() string {
	const key = `Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice`
	k, err := registry.OpenKey(registry.CURRENT_USER, key, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	progID, _, err := k.GetStringValue("ProgId")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(progID)
}

// classOpenCommand reads `shell\open\command` for a ProgId (user hive first,
// then machine hive) — "" when absent.
func classOpenCommand(progID string) string {
	if progID == "" {
		return ""
	}
	const suffix = `\shell\open\command`
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		k, err := registry.OpenKey(root, `Software\Classes\`+progID+suffix, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		cmd, _, err := k.GetStringValue("")
		k.Close()
		if err == nil && strings.TrimSpace(cmd) != "" {
			return cmd
		}
	}
	return ""
}
