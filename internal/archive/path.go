package archive

import (
	"fmt"
	"strings"
)

// reservedDeviceNames are Windows device names that cannot be used as file or
// directory names, regardless of extension ("CON.txt" is just as reserved as
// "CON").
var reservedDeviceNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true,
	"COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true,
	"LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// isControlByte reports whether b is a C0 control character or DEL. Such
// bytes are never valid in archive entry names under strict validation.
func isControlByte(b byte) bool {
	return b < 0x20 || b == 0x7f
}

// isDriveLetter reports whether b is an ASCII drive letter.
func isDriveLetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// StrictArchivePath validates p as an archive entry path and returns its
// canonical form: forward slashes, no leading slash, no "." or ".." segments,
// no empty segments, and no trailing slash (the caller decides directory-ness
// from the raw name before validating).
//
// Validation happens BEFORE any normalization, per the security contract:
//
//  1. Rejects NUL and C0 control bytes, empty paths, absolute "/" or "\"
//     prefixes, Windows drive letters ("C:"), UNC ("\\…"), and the "\\?\"
//     and "\\.\" device prefixes.
//  2. Rejects every "." / ".." segment, empty segments (double slashes), ADS
//     (a ":" anywhere), segments ending in "." or " " (Windows name
//     equivalence), and Windows reserved device names (CON, PRN, AUX, NUL,
//     COM1–9, LPT1–9, with or without an extension).
//  3. Only after all checks pass are "\" separators normalized to "/" and
//     the path rebuilt from its validated segments.
//
// The returned path is what callers may use as a map key, a server-side
// relative path, or an entry identifier. A directory entry "dir/" validates
// to "dir".
func StrictArchivePath(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	if strings.HasPrefix(p, "/") || strings.HasPrefix(p, "\\") {
		return "", fmt.Errorf("%w: absolute path %q", ErrUnsafePath, p)
	}
	if strings.HasPrefix(p, "\\\\") {
		return "", fmt.Errorf("%w: UNC or device path %q", ErrUnsafePath, p)
	}
	if len(p) >= 2 && isDriveLetter(p[0]) && p[1] == ':' {
		return "", fmt.Errorf("%w: drive letter in path %q", ErrUnsafePath, p)
	}
	for i := range p {
		if p[i] == 0 || isControlByte(p[i]) {
			return "", fmt.Errorf("%w: control byte in path %q", ErrUnsafePath, p)
		}
	}

	// Normalize separators, then validate the segments. Empty segments from
	// doubled separators ("a//b", "a/\b") are collapsed like path.Clean
	// would; if two distinct raw names collapse to the same path, the
	// collision map in ValidateEntryPaths rejects the archive.
	normalized := strings.ReplaceAll(p, "\\", "/")
	segments := strings.Split(normalized, "/")
	var kept []string
	for _, seg := range segments {
		if seg == "" {
			continue
		}
		if seg == "." || seg == ".." {
			return "", fmt.Errorf("%w: %q segment in path %q", ErrUnsafePath, seg, p)
		}
		if strings.Contains(seg, ":") {
			return "", fmt.Errorf("%w: ADS or drive separator in path %q", ErrUnsafePath, p)
		}
		if strings.HasSuffix(seg, ".") || strings.HasSuffix(seg, " ") {
			return "", fmt.Errorf("%w: Windows name-equivalent segment %q in path %q", ErrUnsafePath, seg, p)
		}
		if isReservedDeviceName(seg) {
			return "", fmt.Errorf("%w: reserved device name %q in path %q", ErrUnsafePath, seg, p)
		}
		kept = append(kept, seg)
	}
	if len(kept) == 0 {
		return "", fmt.Errorf("%w: path has no usable segments %q", ErrUnsafePath, p)
	}
	return strings.Join(kept, "/"), nil
}

// isReservedDeviceName reports whether seg is a Windows reserved device name.
// The base name before the first dot is compared case-insensitively, so
// "CON", "con.txt", and "NUL.1" are all reserved.
func isReservedDeviceName(seg string) bool {
	base := seg
	if i := strings.IndexByte(seg, '.'); i >= 0 {
		base = seg[:i]
	}
	return reservedDeviceNames[strings.ToUpper(base)]
}

// IsDirEntry reports whether a raw archive entry name is a directory marker
// (a trailing "/" or "\"). It is purely syntactic: the name must still pass
// StrictArchivePath.
func IsDirEntry(raw string) bool {
	return strings.HasSuffix(raw, "/") || strings.HasSuffix(raw, "\\")
}

// windowsEquivKey folds a normalized path to the key under which two entries
// would collide on a case-insensitive filesystem (Windows/macOS defaults).
// StrictArchivePath already removed trailing dots and spaces, so lowering the
// whole path is sufficient.
func windowsEquivKey(normalized string) string {
	return strings.ToLower(normalized)
}

// ValidateEntryPaths strict-validates every raw archive entry name and
// returns the normalized paths. The whole archive is rejected when:
//
//   - any name fails StrictArchivePath, or
//   - two names normalize to the same path (exact or Windows-equivalent
//     case-folded), or
//   - a file entry's path is a proper directory prefix of another entry's
//     path (an extraction conflict on every platform), or
//   - a directory entry ("dir/") and a file entry ("dir") share a name.
//
// The collision map runs over ALL entries — not just the ones a caller
// intends to serve — so a malicious entry cannot hide behind a later, clean
// one.
func ValidateEntryPaths(names []string) ([]string, error) {
	if len(names) == 0 {
		return nil, nil
	}
	normalized := make([]string, len(names))
	exact := make(map[string]bool, len(names))
	winEquiv := make(map[string]bool, len(names))
	prefixDirs := make(map[string]bool, len(names)*2)

	for i, raw := range names {
		n, err := StrictArchivePath(raw)
		if err != nil {
			return nil, fmt.Errorf("entry %d (%q): %w", i, raw, err)
		}
		normalized[i] = n
		if exact[n] {
			return nil, fmt.Errorf("%w: entry %d (%q) duplicates %q", ErrPathCollision, i, raw, n)
		}
		exact[n] = true
		if wk := windowsEquivKey(n); winEquiv[wk] {
			return nil, fmt.Errorf("%w: entry %d (%q) collides with another entry on case-insensitive filesystems", ErrPathCollision, i, raw)
		}
		winEquiv[windowsEquivKey(n)] = true
		// Every proper prefix of every entry is a directory in the final
		// layout; remember it for the file-as-directory check below.
		for prefix := dirPrefix(n); prefix != ""; prefix = dirPrefix(prefix) {
			prefixDirs[prefix] = true
		}
	}

	for i, n := range normalized {
		if IsDirEntry(names[i]) {
			continue // a real directory entry may be a prefix of others
		}
		if prefixDirs[n] {
			return nil, fmt.Errorf("%w: file entry %q is also used as a directory by another entry", ErrPathCollision, n)
		}
	}
	return normalized, nil
}

// dirPrefix returns the parent directory of a normalized path, or "" when
// the path has no "/".
func dirPrefix(normalized string) string {
	i := strings.LastIndexByte(normalized, '/')
	if i < 0 {
		return ""
	}
	return normalized[:i]
}
