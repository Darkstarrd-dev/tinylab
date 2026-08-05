// Package gallery handles zip archive parsing and TIFF transcoding for the
// Gallery image viewer. It is used by the internal/api Gallery handlers.
// This package performs no persistence and never writes to disk; zip archives
// are traversed in memory and TIFF decoding/encoding happens entirely in
// memory.
package gallery

import (
	"strings"
)

// SupportedExts maps lower-cased file extensions to a truthy value for the
// image formats Gallery can serve or transcode. Both "tiff" and "tif" are
// accepted; "tif" is treated identically to "tiff".
var SupportedExts = map[string]bool{
	"webp": true,
	"png":  true,
	"jpg":  true,
	"jpeg": true,
	"bmp":  true,
	"gif":  true,
	"tiff": true,
	"tif":  true,
}

// IsSupportedExt reports whether the file name's extension is an image format
// supported by Gallery. The extension is lower-cased after stripping it from
// the path; "tif" is treated as "tiff".
func IsSupportedExt(name string) bool {
	ext := strings.ToLower(strings.TrimPrefix(trimExt(name), "."))
	if ext == "tif" {
		ext = "tiff"
	}
	return SupportedExts[ext]
}

// trimExt returns the file extension (including the dot) of name, or the empty
// string when there is none. It uses the last dot in the final path segment.
func trimExt(name string) string {
	base := name
	if i := strings.LastIndexAny(base, "/\\"); i >= 0 {
		base = base[i+1:]
	}
	i := strings.LastIndexByte(base, '.')
	if i < 0 {
		return ""
	}
	return base[i:]
}

// Entry describes a single image file found inside a zip archive.
type Entry struct {
	Index int    `json:"index"`
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Kind  string `json:"kind"`
}

// Manifest is the list of image entries extracted from a zip archive.
type Manifest struct {
	Entries []Entry `json:"entries"`
	Total   int     `json:"total"`
}
