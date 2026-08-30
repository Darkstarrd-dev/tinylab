package assistant

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"

	"github.com/tinyrouter/tinyrouter/internal/fsutil"
)

// KnownParams is the fixed set of sampling parameters exposed in the model settings modal.
var KnownParams = []string{
	"temperature", "top_p", "top_k", "min_p",
	"presence_penalty", "repetition_penalty",
	"reasoning", "reasoning_effort",
}

// ValidReasoningEffort enumerates allowed reasoning_effort wire values.
var ValidReasoningEffort = map[string]bool{
	"none": true, "minimal": true, "low": true, "medium": true, "high": true, "xhigh": true,
}

// ParamValue is one sampling parameter plus its enable toggle.
type ParamValue struct {
	Enabled bool `json:"enabled"`
	Value   any  `json:"value"`
}

// ModelPreset is one assistant persona preset: name, system prompt, memory-model override, sampling params.
type ModelPreset struct {
	Name          string                `json:"name"`
	AssistantName string                `json:"assistantName,omitempty"` // legacy: kept for migration; use Name
	SystemPrompt  string                `json:"systemPrompt,omitempty"`
	MemoryModel   string                `json:"memoryModel,omitempty"`
	Params        map[string]ParamValue `json:"params,omitempty"`
	Actions       []AssistantAction     `json:"actions,omitempty"`
}

// AssistantAction mirrors config.AssistantAction for decoupling.
type AssistantAction struct {
	Name            string `json:"name"`
	SpritesheetPath string `json:"spritesheetPath,omitempty"`
	Cols            int    `json:"cols,omitempty"`
	Rows            int    `json:"rows,omitempty"`
	FrameStart      int    `json:"frameStart,omitempty"`
	FrameEnd        int    `json:"frameEnd,omitempty"`
	Fps             int    `json:"fps,omitempty"`
	Mirror          bool   `json:"mirror,omitempty"`
}

// ModelPresetFile is the on-disk JSON format for {assistantDir}/model-presets.json.
type ModelPresetFile struct {
	Active  string        `json:"active"`
	Presets []ModelPreset `json:"presets"`
}

func defaultPresetFile() ModelPresetFile {
	return ModelPresetFile{
		Active:  "default",
		Presets: []ModelPreset{{Name: "default"}},
	}
}

// ApplyParams injects only enabled params into the outbound chat.completions body.
// Numeric keys are written verbatim; reasoning/reasoning_effort use their wire shapes.
func ApplyParams(body map[string]any, params map[string]ParamValue) {
	for k, pv := range params {
		if !pv.Enabled {
			continue
		}
		switch k {
		case "temperature", "top_p", "top_k", "min_p", "presence_penalty", "repetition_penalty":
			body[k] = pv.Value
		case "reasoning":
			b, ok := pv.Value.(bool)
			if !ok {
				// JSON numbers/strings that slipped through SanitizeParams should not happen;
				// treat non-bool as false.
				b = false
			}
			body["reasoning"] = map[string]any{"enabled": b}
		case "reasoning_effort":
			body["reasoning_effort"] = pv.Value
		}
	}
}

// SanitizeParams drops unknown keys, clamps numeric ranges, and validates reasoning_effort.
// Returns an error for an invalid reasoning_effort value; all other corrections are silent clamps.
func SanitizeParams(params map[string]ParamValue) (map[string]ParamValue, error) {
	if params == nil {
		return nil, nil
	}
	known := map[string]bool{}
	for _, k := range KnownParams {
		known[k] = true
	}
	out := make(map[string]ParamValue, len(params))
	for k, pv := range params {
		if !known[k] {
			continue
		}
		switch k {
		case "temperature":
			v := toFloat(pv.Value, 0.7)
			if v < 0 {
				v = 0
			}
			if v > 2 {
				v = 2
			}
			out[k] = ParamValue{Enabled: pv.Enabled, Value: v}
		case "top_p":
			v := toFloat(pv.Value, 1)
			if v < 0 {
				v = 0
			}
			if v > 1 {
				v = 1
			}
			out[k] = ParamValue{Enabled: pv.Enabled, Value: v}
		case "top_k":
			v := int(toFloat(pv.Value, 0))
			if v < 0 {
				v = 0
			}
			if v > 4096 {
				v = 4096
			}
			out[k] = ParamValue{Enabled: pv.Enabled, Value: float64(v)}
		case "min_p":
			v := toFloat(pv.Value, 0)
			if v < 0 {
				v = 0
			}
			if v > 1 {
				v = 1
			}
			out[k] = ParamValue{Enabled: pv.Enabled, Value: v}
		case "presence_penalty":
			v := toFloat(pv.Value, 0)
			if v < -2 {
				v = -2
			}
			if v > 2 {
				v = 2
			}
			out[k] = ParamValue{Enabled: pv.Enabled, Value: v}
		case "repetition_penalty":
			v := toFloat(pv.Value, 1)
			if v < 0 {
				v = 0
			}
			if v > 2 {
				v = 2
			}
			out[k] = ParamValue{Enabled: pv.Enabled, Value: v}
		case "reasoning":
			b, ok := pv.Value.(bool)
			if !ok {
				b = false
			}
			out[k] = ParamValue{Enabled: pv.Enabled, Value: b}
		case "reasoning_effort":
			s, ok := pv.Value.(string)
			if !ok {
				return nil, fmt.Errorf("reasoning_effort must be a string")
			}
			if !ValidReasoningEffort[s] {
				return nil, fmt.Errorf("invalid reasoning_effort %q", s)
			}
			out[k] = ParamValue{Enabled: pv.Enabled, Value: s}
		}
	}
	return out, nil
}

func toFloat(v any, fallback float64) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case json.Number:
		f, _ := x.Float64()
		return f
	default:
		return fallback
	}
}

// PresetStore is a concurrency-safe on-disk store for model presets.
type PresetStore struct {
	mu   sync.RWMutex
	path string
	file ModelPresetFile
}

// LoadPresets loads the store from path. Missing or invalid file yields the built-in default (not persisted).
func LoadPresets(path string) *PresetStore {
	s := &PresetStore{path: path, file: defaultPresetFile()}
	data, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var f ModelPresetFile
	if err := json.Unmarshal(data, &f); err != nil {
		return s
	}
	if len(f.Presets) == 0 {
		return s
	}
	// Migrate legacy assistantName → Name and sanitize on load; ignore sanitize errors.
	for i := range f.Presets {
		if f.Presets[i].Name == "" && f.Presets[i].AssistantName != "" {
			f.Presets[i].Name = f.Presets[i].AssistantName
		}
		sanitized, err := SanitizeParams(f.Presets[i].Params)
		if err == nil {
			f.Presets[i].Params = sanitized
		}
	}
	if f.Active == "" {
		f.Active = f.Presets[0].Name
	}
	s.file = f
	return s
}

// Get returns a deep copy of the current file.
func (s *PresetStore) Get() ModelPresetFile {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return clonePresetFile(s.file)
}

// Save validates and persists f. It also updates the in-memory snapshot on success.
func (s *PresetStore) Save(f ModelPresetFile) error {
	if len(f.Presets) == 0 {
		return fmt.Errorf("at least one preset is required")
	}
	seen := map[string]bool{}
	for i, p := range f.Presets {
		// Normalize legacy: if Name empty but AssistantName set, promote it.
		if p.Name == "" && p.AssistantName != "" {
			p.Name = p.AssistantName
			f.Presets[i].Name = p.Name
		}
		if p.Name == "" {
			return fmt.Errorf("preset[%d] name is required", i)
		}
		if seen[p.Name] {
			return fmt.Errorf("duplicate preset name %q", p.Name)
		}
		seen[p.Name] = true
		sanitized, err := SanitizeParams(p.Params)
		if err != nil {
			return err
		}
		f.Presets[i].Params = sanitized
		f.Presets[i].AssistantName = ""
	}
	if f.Active == "" {
		f.Active = f.Presets[0].Name
	} else if !seen[f.Active] {
		return fmt.Errorf("active preset %q not found", f.Active)
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dirOf(s.path), 0755); err != nil {
		return err
	}
	if err := fsutil.AtomicWrite(s.path, data, 0644); err != nil {
		return err
	}
	s.mu.Lock()
	s.file = clonePresetFile(f)
	s.mu.Unlock()
	return nil
}

// ActivePreset returns the active preset, falling back to the first or a built-in default.
func (s *PresetStore) ActivePreset() ModelPreset {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.file.Presets) == 0 {
		return ModelPreset{Name: "default"}
	}
	for _, p := range s.file.Presets {
		if p.Name == s.file.Active {
			return clonePreset(p)
		}
	}
	return clonePreset(s.file.Presets[0])
}

func clonePresetFile(f ModelPresetFile) ModelPresetFile {
	out := ModelPresetFile{Active: f.Active, Presets: make([]ModelPreset, len(f.Presets))}
	for i, p := range f.Presets {
		out.Presets[i] = clonePreset(p)
	}
	return out
}

func clonePreset(p ModelPreset) ModelPreset {
	cp := ModelPreset{
		Name:          p.Name,
		AssistantName: p.AssistantName,
		SystemPrompt:  p.SystemPrompt,
		MemoryModel:   p.MemoryModel,
	}
	if p.Params != nil {
		cp.Params = make(map[string]ParamValue, len(p.Params))
		for k, v := range p.Params {
			cp.Params[k] = v
		}
	}
	if len(p.Actions) > 0 {
		cp.Actions = make([]AssistantAction, len(p.Actions))
		copy(cp.Actions, p.Actions)
	}
	return cp
}

func dirOf(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			return path[:i]
		}
	}
	return "."
}
