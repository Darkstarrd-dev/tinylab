// pngmeta.go — ComfyUI-compatible prompt/workflow metadata injection for PNG
// images. The tEXt value is written as ASCII-safe JSON (every non-ASCII rune
// escaped to \uXXXX), matching Python's json.dumps(v, ensure_ascii=True):
// PIL reads tEXt chunks as latin-1, so raw UTF-8 bytes would come back as
// mojibake, while \uXXXX escapes round-trip byte-for-byte.
package image

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"unicode/utf8"
)

// pngSignature is the fixed 8-byte signature every PNG file starts with.
var pngSignature = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

// AsciiJSON marshals v to JSON and escapes every non-ASCII rune as \uXXXX,
// mirroring Python's json.dumps(v, ensure_ascii=True). Runes outside the BMP
// become UTF-16 surrogate pairs, exactly as Python emits them, so the result
// is pure ASCII and stays valid JSON.
func AsciiJSON(v interface{}) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	var out bytes.Buffer
	out.Grow(len(b))
	for _, r := range string(b) {
		switch {
		case r < utf8.RuneSelf:
			out.WriteByte(byte(r))
		case r <= 0xFFFF:
			fmt.Fprintf(&out, `\u%04x`, r)
		default:
			// Non-BMP rune: emit a UTF-16 surrogate pair like Python.
			r -= 0x10000
			fmt.Fprintf(&out, `\u%04x\u%04x`, 0xD800+(r>>10), 0xDC00+(r&0x3FF))
		}
	}
	return out.String(), nil
}

// InjectPNGText inserts a tEXt chunk with the given keyword and value
// immediately after the IHDR chunk, replacing any existing tEXt/zTXt/iTXt
// chunk carrying the same keyword first (PIL keeps the first duplicate, so no
// duplicates may remain). Pixel data (IDAT) and every other chunk are copied
// verbatim.
//
// If data does not start with the PNG signature, or a chunk length would run
// past the end of the buffer, data is returned unchanged with a nil error.
func InjectPNGText(data []byte, key, value string) ([]byte, error) {
	if len(data) < len(pngSignature) || !bytes.Equal(data[:len(pngSignature)], pngSignature) {
		return data, nil
	}
	var out bytes.Buffer
	out.Grow(len(data) + len(key) + len(value) + 64)
	out.Write(data[:len(pngSignature)])

	offset := len(pngSignature)
	inserted := false
	for offset+8 <= len(data) {
		length := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		chunkType := data[offset+4 : offset+8]
		chunkEnd := offset + 8 + length
		if chunkEnd+4 > len(data) { // length or CRC would run past EOF
			return data, nil
		}
		chunkData := data[offset+8 : chunkEnd]
		if isTextChunk(chunkType) && textKeyword(chunkData) == key {
			// Replace semantics: drop any chunk already carrying this keyword
			// so exactly one remains after insertion.
			offset = chunkEnd + 4
			continue
		}
		out.Write(data[offset : chunkEnd+4])
		offset = chunkEnd + 4
		if bytes.Equal(chunkType, []byte("IEND")) {
			break
		}
		if !inserted && bytes.Equal(chunkType, []byte("IHDR")) {
			writeTextChunk(&out, key, value)
			inserted = true
		}
	}
	if !inserted {
		// No IHDR chunk found — not a well-formed PNG; leave the input untouched.
		return data, nil
	}
	if offset < len(data) {
		out.Write(data[offset:]) // any trailing bytes after IEND, verbatim
	}
	return out.Bytes(), nil
}

// isTextChunk reports whether chunkType is one of the PNG text chunk types.
func isTextChunk(chunkType []byte) bool {
	return bytes.Equal(chunkType, []byte("tEXt")) ||
		bytes.Equal(chunkType, []byte("zTXt")) ||
		bytes.Equal(chunkType, []byte("iTXt"))
}

// textKeyword returns the keyword of a text chunk: the payload bytes up to the
// first NUL, or the whole payload when no NUL is present.
func textKeyword(chunkData []byte) string {
	if i := bytes.IndexByte(chunkData, 0); i >= 0 {
		return string(chunkData[:i])
	}
	return string(chunkData)
}

// writeTextChunk appends a well-formed tEXt chunk (length, type, data, CRC)
// to out. The length field excludes the 4 type bytes; the CRC covers type+data.
func writeTextChunk(out *bytes.Buffer, keyword, value string) {
	data := make([]byte, 0, len(keyword)+1+len(value))
	data = append(data, keyword...)
	data = append(data, 0)
	data = append(data, value...)

	var hdr [8]byte
	binary.BigEndian.PutUint32(hdr[:4], uint32(len(data)))
	copy(hdr[4:], "tEXt")
	out.Write(hdr[:])
	out.Write(data)

	var crc [4]byte
	sum := crc32.Update(0, crc32.IEEETable, []byte("tEXt"))
	sum = crc32.Update(sum, crc32.IEEETable, data)
	binary.BigEndian.PutUint32(crc[:], sum)
	out.Write(crc[:])
}
