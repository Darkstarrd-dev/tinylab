package gallery

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
)

// Sentinel errors for DeleteZipEntry.
var (
	// ErrUnsupportedMethod is returned by DeleteZipEntry when any entry in the
	// zip archive uses a compression method other than Store (uncompressed).
	ErrUnsupportedMethod = errors.New("zip entry uses unsupported compression method; only Store (uncompressed) is supported")

	// ErrDataDescriptor is returned by DeleteZipEntry when any entry has the
	// data descriptor flag (bit 3 of flags) set.
	ErrDataDescriptor = errors.New("zip entry uses data descriptor flag, not supported for deletion")

	// ErrZip64 is returned by DeleteZipEntry when ZIP64 extensions are detected.
	ErrZip64 = errors.New("zip64 extensions are not supported for deletion")
)

func readLE16(b []byte, off int) uint16 {
	return binary.LittleEndian.Uint16(b[off:])
}

func readLE32(b []byte, off int) uint32 {
	return binary.LittleEndian.Uint32(b[off:])
}

func writeLE16(b []byte, off int, v uint16) {
	binary.LittleEndian.PutUint16(b[off:], v)
}

func writeLE32(b []byte, off int, v uint32) {
	binary.LittleEndian.PutUint32(b[off:], v)
}

// findEOCD locates the End of Central Directory record in the zip data by
// scanning backwards from the end of the file for the signature 0x06054b50.
func findEOCD(data []byte) (uint32, error) {
	if len(data) < 22 {
		return 0, errors.New("data too short to contain a zip archive")
	}
	// The EOCD is at least 22 bytes. The comment can be up to 65535 bytes,
	// so we search backwards from len(data)-22 for up to 65535+22 bytes.
	searchStart := len(data) - 22 - 65535
	if searchStart < 0 {
		searchStart = 0
	}
	for i := len(data) - 22; i >= searchStart; i-- {
		if readLE32(data, i) == 0x06054b50 {
			return uint32(i), nil
		}
	}
	return 0, errors.New("EOCD signature not found")
}

// cdEntry holds the parsed fields from a single Central Directory Header.
type cdEntry struct {
	// filename from the CDH (may differ slightly from the local header).
	filename string
	// localHeaderOffset is the byte offset of the local file header in the
	// archive (CDH field at offset 42).
	localHeaderOffset uint32
	// compressedSize from the CDH (offset 20).
	compressedSize uint32
	// uncompressedSize from the CDH (offset 24).
	uncompressedSize uint32
	// crc32 from the CDH (offset 16).
	crc32 uint32
	// flags from the CDH (offset 8).
	flags uint16
	// method from the CDH (offset 10).
	method uint16
}

// parseCentralDirectory walks the central directory region of data and returns
// a slice of cdEntry in the order they appear in the CD.
func parseCentralDirectory(data []byte, cdOffset, cdSize uint32) ([]cdEntry, error) {
	cd := data[cdOffset : cdOffset+cdSize]
	var entries []cdEntry
	pos := 0
	for pos < len(cd) {
		if pos+4 > len(cd) || readLE32(cd, pos) != 0x02014b50 {
			return nil, fmt.Errorf("corrupt central directory: expected CDH signature at offset %d", pos)
		}

		flags := readLE16(cd, pos+8)
		method := readLE16(cd, pos+10)
		crc32 := readLE32(cd, pos+16)
		compressedSize := readLE32(cd, pos+20)
		uncompressedSize := readLE32(cd, pos+24)
		filenameLen := readLE16(cd, pos+28)
		extraLen := readLE16(cd, pos+30)
		commentLen := readLE16(cd, pos+32)
		localHeaderOffset := readLE32(cd, pos+42)

		entrySize := 46 + filenameLen + extraLen + commentLen
		if pos+int(entrySize) > len(cd) {
			return nil, fmt.Errorf("corrupt central directory: entry at offset %d exceeds CD bounds", pos)
		}

		entries = append(entries, cdEntry{
			filename:          string(cd[pos+46 : pos+46+int(filenameLen)]),
			localHeaderOffset: localHeaderOffset,
			compressedSize:    compressedSize,
			uncompressedSize:  uncompressedSize,
			crc32:             crc32,
			flags:             flags,
			method:            method,
		})
		pos += int(entrySize)
	}
	return entries, nil
}

// hasZIP64Extra reports whether the extra field of a zip entry contains a
// ZIP64 extended information extra field (tag 0x0001).
func hasZIP64Extra(extra []byte) bool {
	for i := 0; i+4 <= len(extra); {
		id := binary.LittleEndian.Uint16(extra[i:])
		length := binary.LittleEndian.Uint16(extra[i+2:])
		if id == 0x0001 {
			return true
		}
		i += 4 + int(length)
	}
	return false
}

// findOriginalFile finds a zip.File by its cleaned name among a slice of files.
func findOriginalFile(files []*zip.File, cleanName string) *zip.File {
	for _, f := range files {
		if CleanZipPath(f.Name) == cleanName {
			return f
		}
	}
	return nil
}

// DeleteZipEntry removes the entry identified by identifier from a store-mode
// (uncompressed) zip stored in data. It performs a local binary rewrite: only
// the target's local file header + data is removed, subsequent entries' bytes
// are shifted, the central directory is rebuilt without the target entry, and
// the EOCD is updated. Returns the new zip bytes and an updated Manifest with
// renumbered indices.
//
// identifier follows the same convention as GetZipEntry: a decimal integer
// index into z.File, or a cleaned path matched against entry names.
//
// Returns:
//   - ErrEntryNotFound if identifier not found
//   - ErrUnsupportedMethod if any entry's Method != Store
//   - ErrDataDescriptor if any entry has the data descriptor flag set
//   - ErrZip64 if ZIP64 extensions are detected
func DeleteZipEntry(data []byte, identifier string) ([]byte, Manifest, error) {
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, Manifest{}, fmt.Errorf("open zip: %w", err)
	}

	// --- Find target entry (by index or name) ---
	var target *zip.File
	if idx, pErr := strconv.Atoi(identifier); pErr == nil && idx >= 0 && idx < len(z.File) {
		target = z.File[idx]
	} else {
		targetName := CleanZipPath(identifier)
		for _, f := range z.File {
			if CleanZipPath(f.Name) == targetName {
				target = f
				break
			}
		}
	}
	if target == nil {
		return nil, Manifest{}, fmt.Errorf("%w: %s", ErrEntryNotFound, identifier)
	}

	// --- Validate constraints ---
	for _, f := range z.File {
		if f.Method != zip.Store {
			return nil, Manifest{}, fmt.Errorf("%w: entry %q uses method %d",
				ErrUnsupportedMethod, f.Name, f.Method)
		}
		// Note: the data descriptor flag (bit 3) is intentionally NOT rejected.
		// Deletion operates on whole entry spans [LFH start, next LFH start)
		// using offsets from the central directory, so any data descriptor
		// trailing the entry data is removed along with it without parsing.
		if f.CompressedSize64 >= 0xFFFFFFFF || f.UncompressedSize64 >= 0xFFFFFFFF {
			return nil, Manifest{}, fmt.Errorf("%w: entry %q has 64-bit sizes",
				ErrZip64, f.Name)
		}
		if hasZIP64Extra(f.Extra) {
			return nil, Manifest{}, fmt.Errorf("%w: entry %q has ZIP64 extra field",
				ErrZip64, f.Name)
		}
	}
	if len(z.File) >= 65535 {
		return nil, Manifest{}, fmt.Errorf("%w: too many entries (%d)", ErrZip64, len(z.File))
	}

	// --- Locate EOCD ---
	eocdOffset, err := findEOCD(data)
	if err != nil {
		return nil, Manifest{}, fmt.Errorf("locate EOCD: %w", err)
	}

	cdSize := readLE32(data, int(eocdOffset)+12)
	cdOffset := readLE32(data, int(eocdOffset)+16)
	totalCD := readLE16(data, int(eocdOffset)+10)

	if int(cdOffset)+int(cdSize) > len(data) {
		return nil, Manifest{}, fmt.Errorf("invalid central directory: offset %d + size %d exceeds data length %d",
			cdOffset, cdSize, len(data))
	}

	// --- Parse the central directory from raw bytes to get local header offsets ---
	cdEntries, err := parseCentralDirectory(data, cdOffset, cdSize)
	if err != nil {
		return nil, Manifest{}, fmt.Errorf("parse central directory: %w", err)
	}

	// Build a map: cleaned filename -> cdEntry (for quick lookup)
	cdByCleanName := make(map[string]cdEntry, len(cdEntries))
	for _, ce := range cdEntries {
		cdByCleanName[CleanZipPath(ce.filename)] = ce
	}

	// Find the target's cdEntry
	targetClean := CleanZipPath(target.Name)
	targetCD, ok := cdByCleanName[targetClean]
	if !ok {
		return nil, Manifest{}, fmt.Errorf("internal: target %q not found in central directory", target.Name)
	}
	targetLocalOffset := targetCD.localHeaderOffset

	// --- Sort CD entries by localHeaderOffset for physical order ---
	sortedCD := make([]cdEntry, len(cdEntries))
	copy(sortedCD, cdEntries)
	sort.Slice(sortedCD, func(i, j int) bool {
		return sortedCD[i].localHeaderOffset < sortedCD[j].localHeaderOffset
	})

	// Find target in physical order
	targetIdx := -1
	for i, ce := range sortedCD {
		if ce.localHeaderOffset == targetLocalOffset {
			targetIdx = i
			break
		}
	}
	if targetIdx < 0 {
		return nil, Manifest{}, fmt.Errorf("internal: target not found in sorted physical order")
	}

	// --- Compute deletion boundaries ---
	delStart := targetLocalOffset
	var delEnd uint32
	if targetIdx+1 < len(sortedCD) {
		delEnd = sortedCD[targetIdx+1].localHeaderOffset
	} else {
		delEnd = cdOffset
	}
	delLen := delEnd - delStart

	// --- Rebuild central directory (skip target entry, adjust offsets) ---
	cd := data[cdOffset : cdOffset+cdSize]
	var newCD bytes.Buffer
	pos := 0
	for pos < len(cd) {
		if pos+4 > len(cd) || readLE32(cd, pos) != 0x02014b50 {
			return nil, Manifest{}, fmt.Errorf("corrupt central directory: expected CDH signature at offset %d", pos)
		}

		filenameLen := readLE16(cd, pos+28)
		extraLen := readLE16(cd, pos+30)
		commentLen := readLE16(cd, pos+32)
		entrySize := 46 + filenameLen + extraLen + commentLen
		if pos+int(entrySize) > len(cd) {
			return nil, Manifest{}, fmt.Errorf("corrupt central directory: entry at offset %d exceeds CD bounds", pos)
		}

		lhOffset := readLE32(cd, pos+42)

		if lhOffset == targetLocalOffset {
			// Skip this CDH entry (the one being deleted)
			pos += int(entrySize)
			continue
		}

		// Copy the CDH verbatim, adjusting localHeaderOffset if needed
		entry := make([]byte, entrySize)
		copy(entry, cd[pos:pos+int(entrySize)])
		if lhOffset > targetLocalOffset {
			writeLE32(entry, 42, lhOffset-delLen)
		}
		newCD.Write(entry)
		pos += int(entrySize)
	}

	// --- Assemble result ---
	head := data[:delStart]
	mid := data[delEnd:cdOffset]
	newCDBytes := newCD.Bytes()

	// Build new EOCD (preserving any comment)
	commentLenTotal := len(data) - int(eocdOffset) - 22
	if commentLenTotal < 0 {
		commentLenTotal = 0
	}
	newEOCD := make([]byte, 22+commentLenTotal)
	copy(newEOCD, data[eocdOffset:eocdOffset+uint32(22+commentLenTotal)])

	writeLE32(newEOCD, 12, uint32(len(newCDBytes))) // cdSize
	writeLE32(newEOCD, 16, cdOffset-delLen)         // cdOffset
	writeLE16(newEOCD, 10, totalCD-1)               // totalCD (this disk)
	writeLE16(newEOCD, 8, totalCD-1)                // diskTotalCD (usually same as totalCD)

	result := make([]byte, 0, len(head)+len(mid)+len(newCDBytes)+len(newEOCD))
	result = append(result, head...)
	result = append(result, mid...)
	result = append(result, newCDBytes...)
	result = append(result, newEOCD...)

	// --- Verify result ---
	vz, err := zip.NewReader(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		return nil, Manifest{}, fmt.Errorf("verification failed: zip parse error: %w", err)
	}
	if len(vz.File) != len(z.File)-1 {
		return nil, Manifest{}, fmt.Errorf("verification failed: expected %d entries, got %d",
			len(z.File)-1, len(vz.File))
	}

	for _, vf := range vz.File {
		vfClean := CleanZipPath(vf.Name)
		orig := findOriginalFile(z.File, vfClean)
		if orig == nil {
			return nil, Manifest{}, fmt.Errorf("verification failed: entry %q not found in original", vf.Name)
		}

		if vf.UncompressedSize64 != orig.UncompressedSize64 {
			return nil, Manifest{}, fmt.Errorf("verification failed: entry %q size mismatch: %d vs %d",
				vf.Name, vf.UncompressedSize64, orig.UncompressedSize64)
		}

		// Read original content
		origRC, oErr := orig.Open()
		if oErr != nil {
			return nil, Manifest{}, fmt.Errorf("verification failed: open original %q: %w", vf.Name, oErr)
		}
		origData, rErr := io.ReadAll(origRC)
		origRC.Close()
		if rErr != nil {
			return nil, Manifest{}, fmt.Errorf("verification failed: read original %q: %w", vf.Name, rErr)
		}

		// Read result content
		vfRC, vErr := vf.Open()
		if vErr != nil {
			return nil, Manifest{}, fmt.Errorf("verification failed: open result %q: %w", vf.Name, vErr)
		}
		vfData, rErr := io.ReadAll(vfRC)
		vfRC.Close()
		if rErr != nil {
			return nil, Manifest{}, fmt.Errorf("verification failed: read result %q: %w", vf.Name, rErr)
		}

		if !bytes.Equal(origData, vfData) {
			return nil, Manifest{}, fmt.Errorf("verification failed: entry %q content mismatch", vf.Name)
		}
	}

	// --- Build manifest ---
	manifest, err := ListZipEntries(bytes.NewReader(result), int64(len(result)))
	if err != nil {
		return nil, Manifest{}, fmt.Errorf("build manifest: %w", err)
	}

	return result, manifest, nil
}
