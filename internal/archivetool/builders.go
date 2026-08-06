package archivetool

import "github.com/tinyrouter/tinyrouter/internal/archive"

// argvBuilder produces the machine-safe argument lists for one tool family.
// Every user-derived value (archive path, entry selector) is passed as its
// own argv element — never interpolated into a command string.
type argvBuilder interface {
	listArgs(archivePath string) []string
	readArgs(archivePath, selector string, isIndex bool) []string
}

// sevenZipBuilder covers 7z and 7zz. Listing uses the -slt machine format
// (plan §5.2: never parse localized tables); reading uses `x -so` (extract to
// stdout) with -sccUTF-8 so non-ASCII entry names survive the console code
// page, and -p- so encrypted archives fail fast instead of prompting.
type sevenZipBuilder struct{}

func (sevenZipBuilder) listArgs(p string) []string {
	return []string{"l", "-slt", "-sccUTF-8", "-p-", "--", p}
}

func (sevenZipBuilder) readArgs(p, sel string, isIndex bool) []string {
	return []string{"x", "-so", "-sccUTF-8", "-p-", "--", p, sel}
}

// rarBuilder covers rar and unrar. `lb` is the bare machine listing (names
// only; sizes are unknown); `p` prints one entry to stdout with all
// informational messages suppressed.
type rarBuilder struct{}

func (rarBuilder) listArgs(p string) []string {
	return []string{"lb", "-p-", "-idq", p}
}

func (rarBuilder) readArgs(p, sel string, isIndex bool) []string {
	return []string{"p", "-inul", "-p-", p, sel}
}

// packBuilder produces the args that create a new archive from staged input
// files. The runner sets cmd.Dir to the staging directory, so plain basenames
// become the archive entry names.
type packBuilder interface {
	packArgs(outName string, files []string) []string
}

type sevenZipPackBuilder struct{}

func (sevenZipPackBuilder) packArgs(outName string, files []string) []string {
	args := []string{"a", "-t7z", "-mx=5", outName}
	return append(args, files...)
}

type rarPackBuilder struct{}

func (rarPackBuilder) packArgs(outName string, files []string) []string {
	args := []string{"a", "-idq", outName}
	return append(args, files...)
}

// Tool output caps (bytes).
const (
	// listOutputCap bounds one -slt / lb listing read into memory. A real
	// 20k-entry listing is a few MB; the manifest entry-count budget is the
	// authoritative cap and this only prevents unbounded buffering first.
	listOutputCap = 64 << 20
	// packOutputCap bounds pack diagnostics (progress lines go to stdout).
	packOutputCap = 1 << 20
)

// TempStore owners used by the runner.
func packMIME(format archive.Format) string {
	switch format {
	case archive.Format7Z:
		return "application/x-7z-compressed"
	case archive.FormatRAR:
		return "application/vnd.rar"
	default:
		return "application/octet-stream"
	}
}

// TempStore owners used by the runner.
const (
	ownerPack = "pack"
	jobPack   = "out"
)
