package gallery

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
)

// maxImageDim is the maximum allowed pixel dimension (width or height) for a
// decoded image. 16384×16384 at 4 bytes/pixel = 1 GiB worst case, which is
// generous for any legitimate image while blocking decompression-bomb DoS.
const maxImageDim = 16384

var pngMagic = []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}

var errNotImage = errors.New("not a recognized image header")

// ImageDimensions sniffs the container header of a still image and returns its
// pixel dimensions WITHOUT decoding the pixel data. Supported formats: PNG
// (IHDR), GIF (logical screen descriptor), TIFF (IFD ImageWidth/ImageLength,
// both byte orders, SHORT/LONG types), JPEG (SOF marker), and WebP
// (VP8/VP8L/VP8X chunk). This is the decompression-bomb guard: a crafted small
// file declaring a huge canvas must be rejected before image.Decode allocates
// width×height×4 bytes.
func ImageDimensions(data []byte) (int, int, error) {
	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], pngMagic):
		return pngDimensions(data)
	case len(data) >= 6 && (string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a"):
		return gifDimensions(data)
	case len(data) >= 4 && ((data[0] == 'I' && data[1] == 'I') || (data[0] == 'M' && data[1] == 'M')):
		return tiffDimensions(data)
	case len(data) >= 2 && data[0] == 0xFF && data[1] == 0xD8:
		return jpegDimensions(data)
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return webpDimensions(data)
	default:
		return 0, 0, errNotImage
	}
}

// CheckImageSize rejects sniffable images whose dimensions exceed maxImageDim in
// either direction without decoding them. Non-image or unparsable data is
// allowed through (nil) so callers keep their existing decode error paths.
func CheckImageSize(data []byte) error {
	w, h, err := ImageDimensions(data)
	if err != nil {
		return nil
	}
	if w > maxImageDim || h > maxImageDim {
		return fmt.Errorf("image too large: %dx%d (max %dx%d)", w, h, maxImageDim, maxImageDim)
	}
	return nil
}

// pngDimensions reads the IHDR width/height (big-endian, offsets 16/20).
func pngDimensions(data []byte) (int, int, error) {
	if len(data) < 24 || string(data[12:16]) != "IHDR" {
		return 0, 0, errors.New("png: missing IHDR chunk")
	}
	return int(binary.BigEndian.Uint32(data[16:20])), int(binary.BigEndian.Uint32(data[20:24])), nil
}

// gifDimensions reads the logical screen descriptor width/height
// (little-endian, offsets 6/8).
func gifDimensions(data []byte) (int, int, error) {
	if len(data) < 10 {
		return 0, 0, errors.New("gif: truncated header")
	}
	return int(binary.LittleEndian.Uint16(data[6:8])), int(binary.LittleEndian.Uint16(data[8:10])), nil
}

// tiffDimensions walks the first IFD looking for ImageWidth (0x0100) and
// ImageLength (0x0101) tags, supporting II/MM byte order and SHORT/LONG types.
func tiffDimensions(data []byte) (int, int, error) {
	if len(data) < 8 {
		return 0, 0, errNotImage
	}
	var order binary.ByteOrder
	switch {
	case data[0] == 'I' && data[1] == 'I':
		order = binary.LittleEndian
		if data[2] != 0x2A || data[3] != 0 {
			return 0, 0, errors.New("tiff: bad magic")
		}
	case data[0] == 'M' && data[1] == 'M':
		order = binary.BigEndian
		if data[2] != 0 || data[3] != 0x2A {
			return 0, 0, errors.New("tiff: bad magic")
		}
	default:
		return 0, 0, errNotImage
	}
	ifdOff := int(order.Uint32(data[4:8]))
	if ifdOff < 8 || ifdOff+2 > len(data) {
		return 0, 0, errors.New("tiff: bad IFD offset")
	}
	count := int(order.Uint16(data[ifdOff : ifdOff+2]))
	var w, h int
	var foundW, foundH bool
	for j := 0; j < count; j++ {
		ent := ifdOff + 2 + j*12
		if ent+12 > len(data) {
			break
		}
		tag := order.Uint16(data[ent : ent+2])
		typ := order.Uint16(data[ent+2 : ent+4])
		if tag != 0x0100 && tag != 0x0101 {
			continue
		}
		v, err := tiffEntryValue(data, ent+8, typ, order)
		if err != nil {
			continue
		}
		if tag == 0x0100 {
			w, foundW = v, true
		} else {
			h, foundH = v, true
		}
		if foundW && foundH {
			return w, h, nil
		}
	}
	return 0, 0, errors.New("tiff: dimensions not found in first IFD")
}

// tiffEntryValue extracts an inline SHORT (type 3) or LONG (type 4) IFD entry
// value. Dimension tags always have count 1 and inline values.
func tiffEntryValue(data []byte, valOff int, typ uint16, order binary.ByteOrder) (int, error) {
	switch typ {
	case 3: // SHORT
		if valOff+2 > len(data) {
			return 0, errors.New("tiff: short value out of range")
		}
		return int(order.Uint16(data[valOff : valOff+2])), nil
	case 4: // LONG
		if valOff+4 > len(data) {
			return 0, errors.New("tiff: long value out of range")
		}
		return int(order.Uint32(data[valOff : valOff+4])), nil
	default:
		return 0, fmt.Errorf("tiff: unsupported value type %d", typ)
	}
}

// jpegDimensions walks the marker segments until a SOF marker (SOF0..SOF15,
// excluding DHT/DAC/JPG) yields height/width, or SOS begins scan data.
func jpegDimensions(data []byte) (int, int, error) {
	if len(data) < 4 {
		return 0, 0, errors.New("jpeg: truncated header")
	}
	i := 2
	for i+1 < len(data) {
		if data[i] != 0xFF {
			return 0, 0, errors.New("jpeg: expected marker")
		}
		i++
		for i < len(data) && data[i] == 0xFF {
			i++
		}
		if i >= len(data) {
			break
		}
		marker := data[i]
		i++
		// Standalone markers carry no length.
		if marker == 0xD8 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			continue
		}
		if i+1 >= len(data) {
			break
		}
		segLen := int(data[i])<<8 | int(data[i+1])
		if segLen < 2 || i+segLen > len(data) {
			return 0, 0, errors.New("jpeg: bad segment length")
		}
		if marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
			if segLen < 7 {
				return 0, 0, errors.New("jpeg: short SOF segment")
			}
			h := int(data[i+3])<<8 | int(data[i+4])
			w := int(data[i+5])<<8 | int(data[i+6])
			return w, h, nil
		}
		if marker == 0xDA { // SOS: entropy-coded data follows; SOF must precede it.
			break
		}
		i += segLen
	}
	return 0, 0, errors.New("jpeg: no SOF marker found")
}

// webpDimensions reads the first chunk of a RIFF/WEBP container: VP8X canvas
// size, VP8 lossy frame header, or VP8L lossless header.
func webpDimensions(data []byte) (int, int, error) {
	chunk := data[12:]
	if len(chunk) < 8 {
		return 0, 0, errors.New("webp: truncated chunk header")
	}
	payload := chunk[8:]
	switch string(chunk[:4]) {
	case "VP8X":
		if len(payload) < 10 {
			return 0, 0, errors.New("webp: short VP8X chunk")
		}
		w := int(payload[4]) | int(payload[5])<<8 | int(payload[6])<<16
		h := int(payload[7]) | int(payload[8])<<8 | int(payload[9])<<16
		return w + 1, h + 1, nil
	case "VP8 ":
		if len(payload) < 10 {
			return 0, 0, errors.New("webp: short VP8 chunk")
		}
		if payload[3] != 0x9D || payload[4] != 0x01 || payload[5] != 0x2A {
			return 0, 0, errors.New("webp: VP8 frame is not a key frame")
		}
		w := int(payload[6]) | int(payload[7])<<8
		h := int(payload[8]) | int(payload[9])<<8
		return (w & 0x3FFF) + 1, (h & 0x3FFF) + 1, nil
	case "VP8L":
		if len(payload) < 5 {
			return 0, 0, errors.New("webp: short VP8L chunk")
		}
		if payload[0] != 0x2F {
			return 0, 0, errors.New("webp: bad VP8L signature")
		}
		v := uint32(payload[1]) | uint32(payload[2])<<8 | uint32(payload[3])<<16 | uint32(payload[4])<<24
		return int(v&0x3FFF) + 1, int((v>>14)&0x3FFF) + 1, nil
	default:
		return 0, 0, fmt.Errorf("webp: unsupported chunk %q", string(chunk[:4]))
	}
}
