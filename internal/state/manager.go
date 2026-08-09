package state

import (
	"strings"
	"sync"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/console"
)

// Manager coordinates debounced writes of runtime state to the state.yaml file.
// It uses function callbacks to extract and restore state from registry/combo,
// avoiding circular imports.
type Manager struct {
	path   string
	logger *console.Logger

	keySnapshotFn   func() map[string]KeySnapshot
	keyRestoreFn    func(providerID, keyID string, s KeySnapshot) error
	comboSnapshotFn func() map[string]ComboSnapshot
	comboRestoreFn  func(id string, s ComboSnapshot) error
	probeSnapshotFn func() map[string]*ProbeRecord
	probeRestoreFn  func(providerID, modelID string, rec ProbeRecord) error

	mu      sync.Mutex
	writeMu sync.Mutex
	pending bool
	timer   *time.Timer
	closed  bool

	debounce time.Duration
}

// ManagerOption configures a Manager callback.
type ManagerOption func(*Manager)

// WithKeyStateProvider sets the key state snapshot and restore callbacks.
func WithKeyStateProvider(snapshotFn func() map[string]KeySnapshot, restoreFn func(providerID, keyID string, s KeySnapshot) error) ManagerOption {
	return func(m *Manager) {
		m.keySnapshotFn = snapshotFn
		m.keyRestoreFn = restoreFn
	}
}

// WithComboStateProvider sets the combo state snapshot and restore callbacks.
func WithComboStateProvider(snapshotFn func() map[string]ComboSnapshot, restoreFn func(id string, s ComboSnapshot) error) ManagerOption {
	return func(m *Manager) {
		m.comboSnapshotFn = snapshotFn
		m.comboRestoreFn = restoreFn
	}
}

// WithProbeStateProvider sets the model-probe snapshot and restore callbacks.
func WithProbeStateProvider(snapshotFn func() map[string]*ProbeRecord, restoreFn func(providerID, modelID string, rec ProbeRecord) error) ManagerOption {
	return func(m *Manager) {
		m.probeSnapshotFn = snapshotFn
		m.probeRestoreFn = restoreFn
	}
}

// NewManager creates a Manager. If path is empty, it returns a noop manager
// whose methods are safe to call but do nothing.
func NewManager(path string, logger *console.Logger, opts ...ManagerOption) *Manager {
	m := &Manager{
		path:     path,
		logger:   logger,
		debounce: 500 * time.Millisecond,
	}
	for _, opt := range opts {
		opt(m)
	}
	return m
}

// ScheduleWrite schedules a debounced flush. Multiple calls within the
// debounce window are coalesced into a single write.
func (m *Manager) ScheduleWrite() {
	if m == nil || m.path == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.closed {
		return
	}

	if !m.pending {
		m.pending = true
		m.timer = time.AfterFunc(m.debounce, m.flushNow)
	}
}

// flushNow captures the current runtime state and writes it to disk.
func (m *Manager) flushNow() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.pending = false
	m.mu.Unlock()
	m.flushNowLocked()
}

// flushNowLocked is called directly from FlushSync without the pending guard.
// Snapshot extraction happens UNDER writeMu so two concurrent writers can
// never let an older snapshot (extracted before a newer one) be written last
// and overwrite newer state.
func (m *Manager) flushNowLocked() {
	m.writeMu.Lock()
	defer m.writeMu.Unlock()

	snapshot := &Snapshot{
		Version: CurrentVersion,
		SavedAt: time.Now(),
		Keys:    make(map[string]*KeySnapshot),
		Combos:  make(map[string]*ComboSnapshot),
	}

	if m.keySnapshotFn != nil {
		for k, v := range m.keySnapshotFn() {
			ks := v
			snapshot.Keys[k] = &ks
		}
	}
	if m.comboSnapshotFn != nil {
		for k, v := range m.comboSnapshotFn() {
			cs := v
			snapshot.Combos[k] = &cs
		}
	}
	if m.probeSnapshotFn != nil {
		if probes := m.probeSnapshotFn(); len(probes) > 0 {
			snapshot.Probes = make(map[string]*ProbeRecord, len(probes))
			for k, v := range probes {
				snapshot.Probes[k] = v
			}
		}
	}

	if err := Save(m.path, snapshot); err != nil {
		m.logger.Warn("failed to save state.yaml: %v", err)
	}
}

// FlushSync immediately captures and writes state, stopping any pending timer.
// Safe to call multiple times.
func (m *Manager) FlushSync() error {
	if m == nil || m.path == "" {
		return nil
	}

	m.mu.Lock()
	if m.timer != nil {
		m.timer.Stop()
	}
	m.pending = false
	m.mu.Unlock()

	m.flushNowLocked()

	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	return nil
}

// Restore applies a snapshot back into the registry and combo resolver.
func (m *Manager) Restore(snapshot *Snapshot) error {
	if m == nil || m.path == "" {
		return nil
	}

	for key, ks := range snapshot.Keys {
		providerID, keyID := ks.ProviderID, ks.KeyID
		if providerID == "" || keyID == "" {
			// Legacy snapshot: no structured identity fields on the value.
			// Try the length-prefixed key encoding, then the historical
			// "providerID::keyID" split (ambiguous for IDs containing '/' or
			// '::' — best-effort migration for files written by older builds).
			var ok bool
			providerID, keyID, ok = decodeSnapshotKey(key)
			if !ok {
				parts := strings.SplitN(key, "::", 2)
				if len(parts) != 2 {
					m.logger.Debug("invalid key snapshot key (expected 'providerID::keyID'): %s", key)
					continue
				}
				providerID, keyID = parts[0], parts[1]
			}
		}
		if m.keyRestoreFn != nil {
			if err := m.keyRestoreFn(providerID, keyID, *ks); err != nil {
				m.logger.Debug("skip restoring key %s: %v", key, err)
			}
		}
	}

	for id, cs := range snapshot.Combos {
		if m.comboRestoreFn != nil {
			if err := m.comboRestoreFn(id, *cs); err != nil {
				m.logger.Debug("skip restoring combo %s: %v", id, err)
			}
		}
	}

	for key, pr := range snapshot.Probes {
		providerID, modelID := pr.ProviderID, pr.ModelID
		if providerID == "" || modelID == "" {
			// Legacy snapshot: fall back to the length-prefixed key encoding,
			// then the historical "providerID::modelID" split.
			var ok bool
			providerID, modelID, ok = decodeSnapshotKey(key)
			if !ok {
				parts := strings.SplitN(key, "::", 2)
				if len(parts) != 2 {
					m.logger.Debug("invalid probe snapshot key (expected 'providerID::modelID'): %s", key)
					continue
				}
				providerID, modelID = parts[0], parts[1]
			}
		}
		if m.probeRestoreFn != nil {
			if err := m.probeRestoreFn(providerID, modelID, *pr); err != nil {
				m.logger.Debug("skip restoring probe %s: %v", key, err)
			}
		}
	}

	return nil
}
