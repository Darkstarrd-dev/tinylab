package state

import (
	"os"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/fsutil"
	"gopkg.in/yaml.v3"
)

const (
	// CurrentVersion is the snapshot format version.
	CurrentVersion = 1
)

// Snapshot is the top-level persisted runtime state.
type Snapshot struct {
	Version int                       `yaml:"version"`
	SavedAt time.Time                 `yaml:"saved_at"`
	Keys    map[string]*KeySnapshot   `yaml:"keys"`
	Combos  map[string]*ComboSnapshot `yaml:"combos"`
	// Probes holds the latest lightweight probe detail per (provider, model).
	// Map key format is "providerID::modelID". Only status/latency/error/ok and
	// timestamps are persisted here — full request/response bodies are NOT kept
	// in state.yaml to avoid bloating the file.
	Probes map[string]*ProbeRecord `yaml:"probes,omitempty"`
}

// ProbeDetail is the persistable subset of a single protocol probe outcome.
type ProbeDetail struct {
	Ok        bool      `yaml:"ok"`
	Status    int       `yaml:"status"`
	LatencyMs int64     `yaml:"latency_ms"`
	Error     string    `yaml:"error,omitempty"`
	LastAt    time.Time `yaml:"last_at,omitempty"`
}

// ProbeRecord aggregates the probe outcome for a single model across all three
// protocols plus the derived supported-protocol set.
type ProbeRecord struct {
	ProviderID      string      `yaml:"provider_id"`
	ModelID         string      `yaml:"model_id"`
	OpenAICompat    ProbeDetail `yaml:"openai_compat"`
	OpenAIResponses ProbeDetail `yaml:"openai_responses"`
	Anthropic       ProbeDetail `yaml:"anthropic"`
	Protocols       []string    `yaml:"protocols,omitempty"`
	LastProbeAt     time.Time   `yaml:"last_probe_at,omitempty"`
}

// KeySnapshot holds the persistable subset of a key's runtime state.
type KeySnapshot struct {
	BackoffLevel int                  `yaml:"backoff_level"`
	ModelLocks   map[string]time.Time `yaml:"model_locks,omitempty"`
	// ModelStatus persists per-model cooldown/lock status so the lock type
	// (cooldown vs daily-locked) survives a restart.
	ModelStatus      map[string]string `yaml:"model_status,omitempty"`
	RotatedAt        time.Time         `yaml:"rotated_at,omitempty"`
	ConsecCount      int               `yaml:"consec_count"`
	LastUsedAt       time.Time         `yaml:"last_used_at,omitempty"`
	NIMRequestCount  int               `yaml:"nim_request_count,omitempty"`
	NIMLastSendTime  time.Time         `yaml:"nim_last_send_time,omitempty"`
	NIMCooldownLevel int               `yaml:"nim_cooldown_level,omitempty"`
	NIMLast429Time   time.Time         `yaml:"nim_last_429_time,omitempty"`
	// ExhaustedModelLimits persists the per-model limit for keys that were daily-
	// quota-locked (ModelRemaining == 0) so that after a restart the provider-level
	// aggregate "used/capacity" still counts the exhausted key's contribution.
	// Map key is the model ID; value is ModelLimit. Only entries with Remaining==0
	// are persisted — partial-usage snapshots are NOT persisted (they are re-fetched
	// from upstream on the next probe/request).
	ExhaustedModelLimits map[string]int `yaml:"exhausted_model_limits,omitempty"`
}

// ComboSnapshot holds the persistable subset of a combo's rotation state.
type ComboSnapshot struct {
	Index       int `yaml:"index"`
	ConsecCount int `yaml:"consec_count"`
}

// Load reads a snapshot from path. If the file does not exist it returns an
// empty snapshot with CurrentVersion.
func Load(path string) (*Snapshot, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Snapshot{
				Version: CurrentVersion,
				Keys:    make(map[string]*KeySnapshot),
				Combos:  make(map[string]*ComboSnapshot),
			}, nil
		}
		return nil, err
	}
	var s Snapshot
	if err := yaml.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	if s.Keys == nil {
		s.Keys = make(map[string]*KeySnapshot)
	}
	if s.Combos == nil {
		s.Combos = make(map[string]*ComboSnapshot)
	}
	if s.Probes == nil {
		s.Probes = make(map[string]*ProbeRecord)
	}
	return &s, nil
}

// Save writes a snapshot to path atomically (temp file + rename) via
// fsutil.AtomicWrite.
//
// On Windows the target file may be locked by a stale handle, causing
// os.Rename to fail. AtomicWrite then falls back to a direct write; if that
// also fails the .tmp file remains for the next restart to retry.
func Save(path string, s *Snapshot) error {
	data, err := yaml.Marshal(s)
	if err != nil {
		return err
	}
	return fsutil.AtomicWrite(path, data, 0600)
}
