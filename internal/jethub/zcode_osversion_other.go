//go:build !windows

package jethub

// zcodeOSVersion is unused on non-Windows hosts: zcodeClientPlatform spoofs the
// whole Windows triple there (ref ZCODE_SPOOF_PLATFORM). Kept for compilation.
func zcodeOSVersion() string { return zcodeSpoofOSVersion }
