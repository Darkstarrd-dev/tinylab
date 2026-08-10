package image

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"reflect"
	"strings"
	"testing"
)

// writePNGChunk appends one well-formed PNG chunk (length, type, data, CRC)
// to buf, mirroring how the writer assembles chunks.
func writePNGChunk(buf *bytes.Buffer, chunkType string, data []byte) {
	var hdr [8]byte
	binary.BigEndian.PutUint32(hdr[:4], uint32(len(data)))
	copy(hdr[4:], chunkType)
	buf.Write(hdr[:])
	buf.Write(data)
	var crc [4]byte
	sum := crc32.Update(0, crc32.IEEETable, []byte(chunkType))
	sum = crc32.Update(sum, crc32.IEEETable, data)
	binary.BigEndian.PutUint32(crc[:], sum)
	buf.Write(crc[:])
}

// buildMinimalPNG assembles a valid 1x1 RGB PNG: signature, IHDR (13 bytes),
// one zlib-compressed IDAT, and IEND.
func buildMinimalPNG() []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'})

	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], 1) // width
	binary.BigEndian.PutUint32(ihdr[4:8], 1) // height
	ihdr[8] = 8                              // bit depth
	ihdr[9] = 2                              // color type: truecolor RGB
	ihdr[10] = 0                             // compression
	ihdr[11] = 0                             // filter
	ihdr[12] = 0                             // interlace
	writePNGChunk(&buf, "IHDR", ihdr)

	var zlibBuf bytes.Buffer
	zw := zlib.NewWriter(&zlibBuf)
	zw.Write([]byte{0, 0xFF, 0xFF, 0xFF}) // filter byte 0 + one RGB pixel
	zw.Close()
	writePNGChunk(&buf, "IDAT", zlibBuf.Bytes())

	writePNGChunk(&buf, "IEND", nil)
	return buf.Bytes()
}

// textChunk represents a parsed tEXt chunk payload.
type textChunk struct {
	keyword string
	value   string
}

// parsePNG walks the chunks of data and returns the ordered list of chunk
// types plus the (keyword, value) pairs of every tEXt chunk.
func parsePNG(t *testing.T, data []byte) (types []string, texts []textChunk) {
	t.Helper()
	if len(data) < 8 || !bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		t.Fatalf("not a PNG signature: % x", data[:min(len(data), 8)])
	}
	for offset := 8; offset+8 <= len(data); {
		length := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		chunkType := string(data[offset+4 : offset+8])
		chunkEnd := offset + 8 + length
		if chunkEnd+4 > len(data) {
			t.Fatalf("chunk %q runs past end of data", chunkType)
		}
		types = append(types, chunkType)
		payload := data[offset+8 : chunkEnd]
		if chunkType == "tEXt" {
			nul := bytes.IndexByte(payload, 0)
			if nul < 0 {
				t.Fatalf("tEXt chunk without NUL separator")
			}
			texts = append(texts, textChunk{keyword: string(payload[:nul]), value: string(payload[nul+1:])})
		}
		if chunkType == "IEND" {
			return types, texts
		}
		offset = chunkEnd + 4
	}
	t.Fatalf("no IEND chunk found")
	return types, texts
}

// extractChunk returns the raw bytes of the first chunk with the given type
// (length + type + data + CRC).
func extractChunk(t *testing.T, data []byte, wantType string) []byte {
	t.Helper()
	for offset := 8; offset+8 <= len(data); {
		length := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		chunkType := string(data[offset+4 : offset+8])
		chunkEnd := offset + 8 + length
		if chunkEnd+4 > len(data) {
			t.Fatalf("chunk %q runs past end of data", chunkType)
		}
		if chunkType == wantType {
			return data[offset : chunkEnd+4]
		}
		if chunkType == "IEND" {
			t.Fatalf("no %q chunk before IEND", wantType)
		}
		offset = chunkEnd + 4
	}
	t.Fatalf("no %q chunk found", wantType)
	return nil
}

func TestAsciiJSON(t *testing.T) {
	in := map[string]string{"p": "你好世界"}
	s, err := AsciiJSON(in)
	if err != nil {
		t.Fatalf("AsciiJSON error: %v", err)
	}
	// Every Chinese rune must be escaped; no raw multi-byte bytes may remain.
	if !strings.Contains(s, `\u4f60\u597d\u4e16\u754c`) {
		t.Fatalf("output %q missing expected \\uXXXX escapes for 你好世界", s)
	}
	for i := 0; i < len(s); i++ {
		if s[i] > 127 {
			t.Fatalf("output %q contains non-ASCII byte %d at index %d", s, s[i], i)
		}
	}
	var back map[string]string
	if err := json.Unmarshal([]byte(s), &back); err != nil {
		t.Fatalf("output %q is not valid JSON: %v", s, err)
	}
	if !reflect.DeepEqual(back, in) {
		t.Fatalf("round-trip mismatch: got %v want %v", back, in)
	}
}

func TestInjectPNGText_RoundTrip(t *testing.T) {
	original := buildMinimalPNG()
	meta := map[string]interface{}{
		"prompt": "一只可爱的猫, 在阳光下",
		"model":  "test-model",
	}
	jsonStr, err := AsciiJSON(meta)
	if err != nil {
		t.Fatalf("AsciiJSON error: %v", err)
	}
	out, err := InjectPNGText(original, "prompt", jsonStr)
	if err != nil {
		t.Fatalf("InjectPNGText error: %v", err)
	}

	_, texts := parsePNG(t, out)
	var got *textChunk
	for i := range texts {
		if texts[i].keyword == "prompt" {
			got = &texts[i]
		}
	}
	if got == nil {
		t.Fatalf("no tEXt chunk with keyword %q found in output", "prompt")
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal([]byte(got.value), &parsed); err != nil {
		t.Fatalf("injected value %q is not valid JSON: %v", got.value, err)
	}
	if parsed["prompt"] != meta["prompt"] {
		t.Fatalf("round-trip prompt mismatch: got %v want %v", parsed["prompt"], meta["prompt"])
	}
	if parsed["model"] != meta["model"] {
		t.Fatalf("round-trip model mismatch: got %v want %v", parsed["model"], meta["model"])
	}

	// Pixel data and IEND must be byte-identical to the input.
	if !bytes.Equal(extractChunk(t, out, "IDAT"), extractChunk(t, original, "IDAT")) {
		t.Fatalf("IDAT chunk changed after injection")
	}
	if !bytes.Equal(extractChunk(t, out, "IEND"), extractChunk(t, original, "IEND")) {
		t.Fatalf("IEND chunk changed after injection")
	}
}

func TestInjectPNGText_ReplacesDuplicate(t *testing.T) {
	// Build a PNG that already carries a tEXt chunk with keyword "prompt".
	base := buildMinimalPNG()
	ihdrLen := int(binary.BigEndian.Uint32(base[8:12]))
	var withOld bytes.Buffer
	withOld.Write(base[:8])
	withOld.Write(base[8 : 8+8+ihdrLen+4]) // IHDR chunk verbatim
	writePNGChunk(&withOld, "tEXt", append(append([]byte("prompt"), 0), "old"...))
	withOld.Write(base[8+8+ihdrLen+4:]) // IDAT + IEND verbatim
	input := withOld.Bytes()

	_, texts := parsePNG(t, input)
	if len(texts) != 1 || texts[0].value != "old" {
		t.Fatalf("test setup broken: got texts %v", texts)
	}

	out, err := InjectPNGText(input, "prompt", "new")
	if err != nil {
		t.Fatalf("InjectPNGText error: %v", err)
	}
	_, texts = parsePNG(t, out)
	var prompts []textChunk
	for _, tc := range texts {
		if tc.keyword == "prompt" {
			prompts = append(prompts, tc)
		}
	}
	if len(prompts) != 1 {
		t.Fatalf("expected exactly one tEXt chunk with keyword %q, got %d: %v", "prompt", len(prompts), prompts)
	}
	if prompts[0].value != "new" {
		t.Fatalf("replacement failed: got value %q want %q", prompts[0].value, "new")
	}
}

func TestInjectPNGText_NonPNG(t *testing.T) {
	in := []byte{1, 2, 3}
	out, err := InjectPNGText(in, "prompt", "x")
	if err != nil {
		t.Fatalf("InjectPNGText error: %v", err)
	}
	if !bytes.Equal(out, in) {
		t.Fatalf("non-PNG input changed: got % x want % x", out, in)
	}
}

func TestInjectPNGText_InsertionPosition(t *testing.T) {
	original := buildMinimalPNG()
	out, err := InjectPNGText(original, "prompt", "v")
	if err != nil {
		t.Fatalf("InjectPNGText error: %v", err)
	}
	types, _ := parsePNG(t, out)
	if len(types) < 3 || types[0] != "IHDR" || types[1] != "tEXt" || types[2] != "IDAT" {
		t.Fatalf("expected IHDR, tEXt, IDAT... but got %v", types)
	}
}
