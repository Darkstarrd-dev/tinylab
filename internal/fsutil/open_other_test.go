//go:build !windows

package fsutil

import (
	"strings"
	"testing"
)

// F-09: the macOS picker passes the initial directory through the
// environment; a hostile value must never be interpolated into the
// AppleScript source.

func TestOSAPickerScriptIsParameterized(t *testing.T) {
	evil := "\"; do shell script \"rm -rf /\"; & \"\n\\'$(touch /tmp/pwned)\u2028end if"
	for _, kind := range []string{"file", "folder"} {
		script := osascriptPickerScript(kind)
		if strings.Contains(script, evil) {
			t.Fatalf("%s: initialDir interpolated into AppleScript source", kind)
		}
		if strings.Contains(script, "do shell script") {
			t.Fatalf("%s: script contains an injectable command primitive", kind)
		}
		if !strings.Contains(script, `system attribute "TR_PICKER_INITIAL_DIR"`) {
			t.Fatalf("%s: script must read the initial dir from the environment", kind)
		}
		// The only variable part is the fixed kind token; no other
		// interpolation points exist.
		want := "set initialDir to (system attribute \"TR_PICKER_INITIAL_DIR\")\n" +
			"if initialDir is not \"\" then\n" +
			"\treturn posix path of (choose " + kind + " default location (POSIX file initialDir))\n" +
			"end if\n" +
			"return posix path of (choose " + kind + ")"
		if script != want {
			t.Fatalf("%s: unexpected script shape:\n%s", kind, script)
		}
	}
}

func TestOSAPickerKindIsFixed(t *testing.T) {
	// The kind token is a compile-time constant at both call sites; a stray
	// runtime interpolation would show up as a non-whitelisted choose target.
	for _, s := range []string{osascriptPickerScript("file"), osascriptPickerScript("folder")} {
		if strings.Contains(s, "choose ") && !strings.Contains(s, "choose file") && !strings.Contains(s, "choose folder") {
			t.Fatalf("unexpected choose target in script: %s", s)
		}
	}
}
