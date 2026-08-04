package imagebatch

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

var slotFileRE = regexp.MustCompile(`^p([0-9]{4})/v([0-9]{4})\.([a-z0-9]+)$`)
var allowedImageExtensions = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true, ".tif": true, ".tiff": true}

func IsSafeProjectID(s string) bool { return safeID.MatchString(s) && !isReservedName(s) }
func IsSafeSlug(s string) bool {
	if s == "" || s == "." || s == ".." || isReservedName(s) || len(s) > 96 || strings.ContainsAny(s, `/\\`) {
		return false
	}
	for _, r := range s {
		if r == unicode.ReplacementChar || unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func SanitizeSlug(name string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(strings.ToLower(name)) {
		if unicode.IsControl(r) || r == '/' || r == '\\' {
			b.WriteRune('-')
			continue
		}
		b.WriteRune(r)
	}
	s := strings.Trim(b.String(), " .")
	if s == "" {
		s = "project"
	}
	if isReservedName(s) {
		s = s + "-project"
	}
	if len(s) > 96 {
		s = s[:96]
	}
	return s
}
func isReservedName(s string) bool {
	u := strings.ToUpper(strings.TrimSuffix(s, "."))
	switch u {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		return true
	}
	return false
}
func ValidateRelativePath(rel string) error {
	if rel == "" || filepath.IsAbs(rel) || strings.ContainsAny(rel, `\\`) {
		return errors.New("unsafe relative path")
	}
	clean := filepath.ToSlash(filepath.Clean(rel))
	if clean != rel || clean == "." || strings.HasPrefix(clean, "../") || strings.Contains(clean, "/../") {
		return errors.New("unsafe relative path")
	}
	return nil
}
func ProjectDir(root, slug string) (string, error) {
	if !IsSafeSlug(slug) {
		return "", errors.New("invalid project slug")
	}
	base, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	p := filepath.Join(base, slug)
	if rel, err := filepath.Rel(base, p); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("project path escapes root")
	}
	return p, nil
}
func SlotRelativePath(promptIndex, variantIndex int, ext string) (string, error) {
	if promptIndex < 1 || promptIndex > 9999 || variantIndex < 1 || variantIndex > 9999 {
		return "", errors.New("slot index out of range")
	}
	ext = strings.ToLower(ext)
	if !strings.HasPrefix(ext, ".") {
		ext = "." + ext
	}
	if !allowedImageExtensions[ext] {
		return "", fmt.Errorf("unsupported image extension %q", ext)
	}
	return fmt.Sprintf("p%04d/v%04d%s", promptIndex, variantIndex, ext), nil
}
func ParseSlotPath(rel string) (promptIndex, variantIndex int, ext string, err error) {
	if err = ValidateRelativePath(rel); err != nil {
		return
	}
	m := slotFileRE.FindStringSubmatch(filepath.ToSlash(rel))
	if m == nil {
		err = errors.New("invalid slot path")
		return
	}
	fmt.Sscanf(m[1], "%d", &promptIndex)
	fmt.Sscanf(m[2], "%d", &variantIndex)
	ext = "." + m[3]
	if !allowedImageExtensions[ext] {
		err = errors.New("unsupported image extension")
	}
	return
}
func ResolveAssetPath(root, slug, rel string) (string, error) {
	dir, err := ProjectDir(root, slug)
	if err != nil {
		return "", err
	}
	if err = ValidateRelativePath(rel); err != nil {
		return "", err
	}
	p := filepath.Join(dir, filepath.FromSlash(rel))
	absBase, _ := filepath.Abs(dir)
	abs, _ := filepath.Abs(p)
	r, e := filepath.Rel(absBase, abs)
	if e != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", errors.New("asset path escapes project")
	}
	return p, nil
}
