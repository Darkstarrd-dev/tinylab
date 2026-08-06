package archive

import (
	"bytes"
	"unicode/utf8"

	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"
	"golang.org/x/text/transform"
)

// decoderPair bundles a CJK decoder with its corresponding encoder for
// round-trip verification.
type decoderPair struct {
	name string
	dec  transform.Transformer
	enc  transform.Transformer
}

// cjkDecoders lists CJK decoders in priority order. Shift-JIS is first
// (most common for Japanese Windows zip files), followed by GBK (most common
// for Chinese Windows zip files), then the remaining encodings. This mirrors
// internal/gallery/charset.go so the ArchiveCore adapter presents the same
// entry names Gallery does (P3 will dedupe the two copies).
var cjkDecoders = []decoderPair{
	{"ShiftJIS", japanese.ShiftJIS.NewDecoder(), japanese.ShiftJIS.NewEncoder()},
	{"GBK", simplifiedchinese.GBK.NewDecoder(), simplifiedchinese.GBK.NewEncoder()},
	{"EUCJP", japanese.EUCJP.NewDecoder(), japanese.EUCJP.NewEncoder()},
	{"Big5", traditionalchinese.Big5.NewDecoder(), traditionalchinese.Big5.NewEncoder()},
	{"EUCKR", korean.EUCKR.NewDecoder(), korean.EUCKR.NewEncoder()},
	{"GB18030", simplifiedchinese.GB18030.NewDecoder(), simplifiedchinese.GB18030.NewEncoder()},
}

// decodeZipName recovers the correct filename for a zip entry whose Name
// field holds raw non-UTF-8 bytes (common when an archive declares the UTF-8
// flag but actually stores Shift-JIS/GBK/EUC-KR/Big5 encoded names, as is
// typical for Japanese/Chinese Windows zip tools).
//
// Go's archive/zip stores Name as string(rawBytes) for UTF-8-flagged entries.
// string(bytes) preserves the raw bytes, so []byte(name) yields the original
// bytes. If they aren't valid UTF-8, we try common CJK decoders and pick the
// one producing the most valid (non-replacement) runes, with a preference for
// non-halfwidth characters (halfwidth katakana in the U+FF00–U+FFEF range
// typically indicates a wrong decoder).
//
// A round-trip verification step filters out decoders whose output cannot be
// re-encoded back to the original bytes — this catches cases where the
// decoded string contains characters not representable in the source
// encoding.
//
// For entries that are already valid UTF-8 (genuine UTF-8 archives, or
// non-flagged entries that Go CP437-decoded), the name is returned unchanged.
func decodeZipName(name string) string {
	if name == "" {
		return name
	}
	if utf8.ValidString(name) {
		return name
	}
	raw := []byte(name)
	best := name
	bestScore := -1
	for _, dp := range cjkDecoders {
		decoded, _, err := transform.Bytes(dp.dec, raw)
		if err != nil {
			continue
		}
		s := string(decoded)

		// Reject if any replacement character leaked through.
		if hasReplacementRune(s) {
			continue
		}

		// Round-trip check: re-encode with the corresponding encoder.
		// If the re-encoded bytes don't match the original, this decoder
		// is not the correct one for these bytes.
		reEnc, _, err := transform.Bytes(dp.enc, decoded)
		if err != nil || !bytes.Equal(reEnc, raw) {
			continue
		}

		score := scoreDecoded(s)
		if score > bestScore {
			bestScore = score
			best = s
		}
	}
	return best
}

// hasReplacementRune returns true if the string contains U+FFFD (the Unicode
// replacement character) or utf8.RuneError, indicating a decoding failure.
func hasReplacementRune(s string) bool {
	for _, r := range s {
		if r == utf8.RuneError || r == '\uFFFD' {
			return true
		}
	}
	return false
}

// scoreDecoded scores a decoded string. Non-ASCII characters outside the
// halfwidth katakana range (U+FF00–U+FFEF) are weighted higher, since
// halfwidth characters typically indicate a wrong decoder when the raw bytes
// are actually CJK encoded.
func scoreDecoded(s string) int {
	score := 0
	for _, r := range s {
		if r == utf8.RuneError || r == '\uFFFD' {
			continue
		}
		// Halfwidth katakana/forms (U+FF00–U+FFEF) typically indicate
		// a wrong decoder when the raw bytes are actually CJK encoded.
		// Score them lower than characters in the CJK ideograph range.
		if r > 0x7F && (r < 0xFF00 || r > 0xFFEF) {
			score += 2
		} else {
			score++
		}
	}
	return score
}
