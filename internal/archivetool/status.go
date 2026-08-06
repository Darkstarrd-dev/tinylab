// Package archivetool implements the P2 external-tool layer for ArchiveCore:
// 7z/7zz/unrar/rar executable resolution, capability probing, machine-output
// listing/reading, packing, and a Runner that wires the tools together with a
// TempStore, deadlines, process-group cancellation, bounded output and a
// concurrency semaphore.
//
// It is a sibling of internal/archive (the P0/P1 foundation): it imports the
// foundation's frozen contracts (Format, Source, Entry, Manifest, Budget,
// Reader, Writer, TempStore) and implements the external-tool adapters against
// them, without touching the foundation package itself.
package archivetool

import "time"

// ToolStatus reports one tool/format capability set to the status endpoint
// (archive_compatibility_plan.md §5.3). ZIP is always read+write (stdlib);
// sevenZip and rar depend on the resolved external tools.
type ToolStatus struct {
	Available bool   `json:"available"`
	Read      bool   `json:"read"`
	Write     bool   `json:"write"`
	Path      string `json:"path,omitempty"`
	Version   string `json:"version,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Status is the GET /api/archive/status response shape.
type Status struct {
	ZIP      ToolStatus `json:"zip"`
	SevenZip ToolStatus `json:"sevenZip"`
	RAR      ToolStatus `json:"rar"`
}

// statusCacheTTL bounds how often the resolver re-probes external tools. A
// freshly installed tool becomes visible within this window without a restart;
// UpdateSettings clears the cache immediately when paths change.
const statusCacheTTL = 30 * time.Second
