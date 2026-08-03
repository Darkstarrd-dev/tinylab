package gallery

import (
	"bytes"
	"fmt"
	"image/jpeg"
	"io"

	"golang.org/x/image/tiff"
)

// ConvertTIFFToJPEG decodes a TIFF image from r and re-encodes it as JPEG,
// returning the encoded bytes. quality must be in [1, 100]; values outside
// that range are clamped to 85. Decode failures are wrapped and returned.
// The TIFF header is pre-checked for oversized dimensions before decoding.
func ConvertTIFFToJPEG(r io.Reader, quality int) ([]byte, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("read tiff: %w", err)
	}
	return convertTIFFToJPEGBytes(data, quality)
}

// ConvertTIFFBlobToJPEG is a convenience wrapper around ConvertTIFFToJPEG that
// accepts an in-memory TIFF byte slice, for direct use by HTTP handlers.
func ConvertTIFFBlobToJPEG(data []byte, quality int) ([]byte, error) {
	return convertTIFFToJPEGBytes(data, quality)
}

func convertTIFFToJPEGBytes(data []byte, quality int) ([]byte, error) {
	// Pre-check dimensions from the TIFF header BEFORE decoding: a crafted
	// small file declaring a huge canvas would otherwise allocate
	// width×height×4 bytes during tiff.Decode (decompression bomb).
	if w, h, err := ImageDimensions(data); err == nil && (w > maxImageDim || h > maxImageDim) {
		return nil, fmt.Errorf("tiff image too large: %dx%d (max %dx%d)", w, h, maxImageDim, maxImageDim)
	}
	img, err := tiff.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode tiff: %w", err)
	}
	// Defense in depth: the header pre-check may miss unusual IFD layouts.
	b := img.Bounds()
	if dx, dy := b.Dx(), b.Dy(); dx > maxImageDim || dy > maxImageDim {
		return nil, fmt.Errorf("tiff image too large: %dx%d (max %dx%d)", dx, dy, maxImageDim, maxImageDim)
	}
	if quality < 1 || quality > 100 {
		quality = 85
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, fmt.Errorf("encode jpeg: %w", err)
	}
	return buf.Bytes(), nil
}
