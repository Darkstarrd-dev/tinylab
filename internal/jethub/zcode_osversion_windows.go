//go:build windows

package jethub

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// zcodeOSVersion reports the real Windows NT version (`10.0.<build>`) for the
// X-Os-Version header. os.release() is what the official Node client sends; the
// three platform values must stay self-consistent (ref zcodeClientPlatform).
func zcodeOSVersion() string {
	info := windows.RtlGetVersion()
	if info == nil {
		return zcodeSpoofOSVersion
	}
	return fmt.Sprintf("%d.%d.%d", info.MajorVersion, info.MinorVersion, info.BuildNumber)
}
