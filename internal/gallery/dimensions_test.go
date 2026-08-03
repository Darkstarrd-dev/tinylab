package gallery

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

// craftPNGHeader builds a minimal PNG IHDR declaring w×h (no pixel data).
func craftPNGHeader(w, h uint32) []byte {
	buf := make([]byte, 24)
	copy(buf, pngMagic)
	binary.BigEndian.PutUint32(buf[8:12], 13) // IHDR length
	copy(buf[12:16], "IHDR")
	binary.BigEndian.PutUint32(buf[16:20], w)
	binary.BigEndian.PutUint32(buf[20:24], h)
	return buf
}

// craftTIFFHeader builds a minimal little-endian TIFF whose first IFD declares
// ImageWidth/ImageLength (LONG) — no pixel data, no strip tables.
func craftTIFFHeader(w, h uint32) []byte {
	var buf bytes.Buffer
	buf.WriteString("II")
	buf.Write([]byte{0x2A, 0x00})
	_ = binary.Write(&buf, binary.LittleEndian, uint32(8)) // IFD offset
	_ = binary.Write(&buf, binary.LittleEndian, uint16(2)) // entry count
	entry := func(tag uint16, val uint32) {
		_ = binary.Write(&buf, binary.LittleEndian, tag)
		_ = binary.Write(&buf, binary.LittleEndian, uint16(4)) // LONG
		_ = binary.Write(&buf, binary.LittleEndian, uint32(1)) // count
		_ = binary.Write(&buf, binary.LittleEndian, val)
	}
	entry(0x0100, w)                                       // ImageWidth
	entry(0x0101, h)                                       // ImageLength
	_ = binary.Write(&buf, binary.LittleEndian, uint32(0)) // next IFD
	return buf.Bytes()
}

// craftJPEGHeader builds SOI + SOF0 declaring w×h (no pixel data).
func craftJPEGHeader(w, h uint32) []byte {
	buf := []byte{0xFF, 0xD8}
	buf = append(buf, 0xFF, 0xC0) // SOF0
	segLen := 10                  // 2 length bytes + precision(1) + h(2) + w(2) + 1 component(3)
	buf = append(buf, byte(segLen>>8), byte(segLen))
	buf = append(buf, 8) // precision
	buf = append(buf, byte(h>>8), byte(h), byte(w>>8), byte(w))
	buf = append(buf, 1, 0x11, 0x00) // 1 component
	return buf
}

func TestImageDimensions(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		w, h int
	}{
		{"png", craftPNGHeader(640, 480), 640, 480},
		{"gif", []byte("GIF89a\x80\x02\xe0\x01"), 640, 480},
		{"tiff", craftTIFFHeader(640, 480), 640, 480},
		{"jpeg", craftJPEGHeader(640, 480), 640, 480},
	}
	for _, c := range cases {
		w, h, err := ImageDimensions(c.data)
		if err != nil {
			t.Errorf("%s: ImageDimensions: %v", c.name, err)
			continue
		}
		if w != c.w || h != c.h {
			t.Errorf("%s: dims = %dx%d, want %dx%d", c.name, w, h, c.w, c.h)
		}
	}
	if _, _, err := ImageDimensions([]byte("not an image")); err == nil {
		t.Error("ImageDimensions(non-image) = nil error, want errNotImage")
	}
}

// TestCheckImageSizeRejectsOversized covers the decompression-bomb guard: a
// crafted header declaring >16384px must be rejected WITHOUT decoding.
func TestCheckImageSizeRejectsOversized(t *testing.T) {
	const big = 20000
	cases := []struct {
		name string
		data []byte
	}{
		{"png", craftPNGHeader(big, big)},
		{"gif", []byte("GIF89a\x20\x4e\x20\x4e")},
		{"tiff", craftTIFFHeader(big, big)},
		{"jpeg", craftJPEGHeader(big, big)},
	}
	for _, c := range cases {
		err := CheckImageSize(c.data)
		if err == nil || !strings.Contains(err.Error(), "image too large") {
			t.Errorf("%s: CheckImageSize = %v, want 'image too large' error", c.name, err)
		}
	}
	// Legitimate sizes pass; non-image data passes (decode decides).
	if err := CheckImageSize(craftPNGHeader(64, 64)); err != nil {
		t.Errorf("CheckImageSize(64x64 png) = %v, want nil", err)
	}
	if err := CheckImageSize([]byte("not an image")); err != nil {
		t.Errorf("CheckImageSize(non-image) = %v, want nil", err)
	}
}

// TestConvertTIFFBlobToJPEGRejectsOversizedHeader verifies the TIFF conversion
// rejects a crafted oversized header before decoding: the error must be the
// pre-check's "too large" (a decode attempt would fail with "decode tiff").
func TestConvertTIFFBlobToJPEGRejectsOversizedHeader(t *testing.T) {
	_, err := ConvertTIFFBlobToJPEG(craftTIFFHeader(20000, 20000), 85)
	if err == nil || !strings.Contains(err.Error(), "tiff image too large") {
		t.Fatalf("ConvertTIFFBlobToJPEG(oversized) = %v, want 'tiff image too large'", err)
	}
}
