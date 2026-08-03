package config

import (
	"encoding/json"
	"strings"

	"gopkg.in/yaml.v3"
)

// RotationConfig controls key selection behavior.
type RotationConfig struct {
	Strategy      string `yaml:"strategy" json:"strategy"`
	StickyLimit   int    `yaml:"stickyLimit" json:"stickyLimit"`
	MaxRetries    int    `yaml:"maxRetries" json:"maxRetries"`
	RetryDelaySec int    `yaml:"retryDelaySec" json:"retryDelaySec"`
	BackoffMaxSec int    `yaml:"backoffMaxSec" json:"backoffMaxSec"`
	StatePersist  bool   `yaml:"state_persist" json:"statePersist"`
	StatePath     string `yaml:"state_path" json:"statePath"`
}

// Key represents one API key within a provider.
type Key struct {
	ID       string `yaml:"id" json:"id"`
	Key      string `yaml:"key" json:"key"`
	Name     string `yaml:"name" json:"name"`
	Priority int    `yaml:"priority" json:"priority"`
	IsActive bool   `yaml:"isActive" json:"isActive"`
	Account  string `yaml:"account,omitempty" json:"account,omitempty"`
}

// Protocol values identify the upstream API protocols that a model is known
// to support, as determined by probing (Step 3b). They are persisted on
// ModelDef.Protocols and consumed by the multi-protocol composite detection UI.
const (
	ProtocolOpenAICompat    = "openai-compat"    // OpenAI Chat Completions compatible
	ProtocolOpenAIResponses = "openai-responses" // OpenAI Responses API
	ProtocolAnthropic       = "anthropic"        // Anthropic Messages API
	ProtocolOpenAIEmbedding = "openai-embedding" // OpenAI Embeddings API
)

// ModelDef represents one upstream model with its quota type tag.
type ModelDef struct {
	ID          string            `yaml:"id" json:"id"`
	QuotaType   string            `yaml:"quotaType,omitempty" json:"quotaType,omitempty"`
	Alias       string            `yaml:"alias,omitempty" json:"alias,omitempty"`
	Note        string            `yaml:"note,omitempty" json:"note,omitempty"`
	Kind        string            `yaml:"kind,omitempty" json:"kind,omitempty"`               // "text" (default/empty) | "image"
	ImgProtocol string            `yaml:"imgProtocol,omitempty" json:"imgProtocol,omitempty"` // "gpt" | "xai" | "modelscope" (only when kind=image)
	ImgSizes    []string          `yaml:"imgSizes,omitempty" json:"imgSizes,omitempty"`       // custom size option list (e.g. "1024x1024") for Playground image mode; empty = built-in defaults
	NIMOver     *ModelNIMOverride `yaml:"nim,omitempty" json:"nim,omitempty"`
	// Protocols records the set of protocols this model was probed to support
	// (legal values: ProtocolOpenAICompat, ProtocolOpenAIResponses,
	// ProtocolAnthropic). An empty/nil slice means "not yet probed" OR "probed
	// and found to support no known protocol". Absent in older config files
	// (backward compatible: defaults to nil).
	Protocols []string `yaml:"protocols,omitempty" json:"protocols,omitempty"`
}

// ModelNIMOverride enables per-model NIM-style rate limiting (per-key request
// counting and min-interval throttling). When nil or disabled, the model uses
// standard rotation. When enabled, the model gets the same throttling as a NIM
// provider, with its own per-key rotation count and min-interval values.
type ModelNIMOverride struct {
	Enabled            bool `yaml:"enabled" json:"enabled"`
	RequestCountPerKey int  `yaml:"request_count_per_key,omitempty" json:"request_count_per_key,omitempty"`
	MinIntervalMs      int  `yaml:"min_interval_ms,omitempty" json:"min_interval_ms,omitempty"`
}

// UnmarshalYAML supports both scalar strings and mapping nodes for backward compatibility.
func (m *ModelDef) UnmarshalYAML(value *yaml.Node) error {
	if value.Kind == yaml.ScalarNode {
		m.ID = value.Value
		m.QuotaType = ""
		return nil
	}
	type modelDefAlias ModelDef
	var alias modelDefAlias
	if err := value.Decode(&alias); err != nil {
		return err
	}
	*m = ModelDef(alias)
	return nil
}

// UnmarshalJSON supports both JSON strings and objects for backward compatibility.
func (m *ModelDef) UnmarshalJSON(data []byte) error {
	if len(data) > 0 && data[0] == '"' {
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		m.ID = s
		m.QuotaType = ""
		return nil
	}
	type modelDefAlias ModelDef
	var alias modelDefAlias
	if err := json.Unmarshal(data, &alias); err != nil {
		return err
	}
	*m = ModelDef(alias)
	return nil
}

// Provider represents one upstream OpenAI-compatible endpoint.
type Provider struct {
	ID               string     `yaml:"id" json:"id"`
	Name             string     `yaml:"name" json:"name"`
	Prefix           string     `yaml:"prefix" json:"prefix"`
	BaseURL          string     `yaml:"baseUrl" json:"baseUrl"`
	APIType          string     `yaml:"apiType" json:"apiType"`
	AnthropicVersion string     `yaml:"anthropicVersion,omitempty" json:"anthropicVersion,omitempty"`
	AnthropicBeta    string     `yaml:"anthropicBeta,omitempty" json:"anthropicBeta,omitempty"`
	IsActive         bool       `yaml:"isActive" json:"isActive"`
	Keys             []Key      `yaml:"keys" json:"keys"`
	Models           []ModelDef `yaml:"models,omitempty" json:"models,omitempty"`
	RotationStrategy string     `yaml:"rotationStrategy,omitempty" json:"rotationStrategy,omitempty"`
	StickyLimit      int        `yaml:"stickyLimit,omitempty" json:"stickyLimit,omitempty"`
	InjectStreamOpts bool       `yaml:"injectStreamOptions,omitempty" json:"injectStreamOptions,omitempty"`
	// NormalizeStreamChunks fixes upstreams (e.g. ModelScope) that emit
	// usage-only SSE chunks with "choices":null, which violates the OpenAI
	// chat-completion-chunk schema (choices must be an array or error an
	// object). When true, streamResponse rewrites "choices":null to
	// "choices":[] while preserving the usage field. Off by default.
	NormalizeStreamChunks bool         `yaml:"normalizeStreamChunks,omitempty" json:"normalizeStreamChunks,omitempty"`
	NIMConfig             *NIMSettings `yaml:"nim,omitempty" json:"nim,omitempty"`
	// UseProxy routes this provider's upstream requests through the global
	// upstream proxy (Config.Proxy) when enabled.
	UseProxy bool `yaml:"useProxy,omitempty" json:"useProxy,omitempty"`
}

// IsNIM reports whether this provider should use the NIM-specific key rotation
// and throttling path. It returns true when APIType == "nim" OR when the
// BaseURL contains "nvidia" (auto-detection fallback so a misconfigured
// apiType never silently bypasses NIM throttling).
func (p Provider) IsNIM() bool {
	if p.APIType == "nim" {
		return true
	}
	return strings.Contains(strings.ToLower(p.BaseURL), "nvidia")
}

// IsGeminiOpenAICompat reports whether this provider is the Google Gemini
// OpenAI-compatible endpoint, which requires thought_signature handling for
// tool calls. It matches when the BaseURL contains
// "generativelanguage.googleapis.com" AND the path contains "/openai".
func (p Provider) IsGeminiOpenAICompat() bool {
	u := strings.ToLower(p.BaseURL)
	return strings.Contains(u, "generativelanguage.googleapis.com") &&
		strings.Contains(u, "/openai")
}

// IsCline reports whether this provider targets api.cline.bot, which gates
// cline-free/* models behind an x-client-type product-surface header (see
// upstream.go applyClineHeaders). Matches by BaseURL substring, consistent
// with IsNIM/IsGeminiOpenAICompat auto-detection.
func (p Provider) IsCline() bool {
	return strings.Contains(strings.ToLower(p.BaseURL), "api.cline.bot")
}

// IsAnthropic reports whether this provider speaks the Anthropic Messages API
// (used to switch auth header, upstream URL construction and entry-format filtering).
func (p Provider) IsAnthropic() bool {
	return p.APIType == "anthropic"
}

// NIMSettings holds NVIDIA NIM-specific key rotation and throttling config.
// Effective when Provider.IsNIM() is true (apiType == "nim" or BaseURL contains "nvidia").
type NIMSettings struct {
	RequestCountPerKey int   `yaml:"request_count_per_key" json:"request_count_per_key"`
	MinIntervalMs      int   `yaml:"min_interval_ms" json:"min_interval_ms"`
	CooldownLadderMin  []int `yaml:"cooldown_ladder" json:"cooldown_ladder"`
	MaxConcurrent      int   `yaml:"max_concurrent" json:"max_concurrent"`
}

// Combo represents a model combination with a routing strategy.
type Combo struct {
	ID             string   `yaml:"id" json:"id"`
	Name           string   `yaml:"name" json:"name"`
	Strategy       string   `yaml:"strategy" json:"strategy"`
	Models         []string `yaml:"models" json:"models"`
	Disabled       bool     `yaml:"disabled,omitempty" json:"disabled,omitempty"`
	DisabledModels []string `yaml:"disabledModels,omitempty" json:"disabledModels,omitempty"`
}

// QuickSlot represents a quick model switch slot with an ordered position.
type QuickSlot struct {
	ID             string   `yaml:"id" json:"id"`
	Name           string   `yaml:"name" json:"name"`
	Models         []string `yaml:"models" json:"models"`
	Disabled       bool     `yaml:"disabled,omitempty" json:"disabled,omitempty"`
	DisabledModels []string `yaml:"disabledModels,omitempty" json:"disabledModels,omitempty"`
	Order          int      `yaml:"order" json:"order"`
	SelectedIndex  int      `yaml:"selectedIndex" json:"selectedIndex"`
}

// SecurityConfig controls password protection for the admin UI.
type SecurityConfig struct {
	PasswordEnabled   bool   `yaml:"passwordEnabled" json:"passwordEnabled"`
	PasswordEncrypted string `yaml:"passwordEncrypted,omitempty" json:"passwordEncrypted,omitempty"`
	EncryptionKey     string `yaml:"encryptionKey,omitempty" json:"encryptionKey,omitempty"`
}

// ServerConfig controls HTTP server and upstream proxy client timeouts.
// All values are in seconds. A zero value falls back to the default.
//
//   - ReadTimeoutSec: max duration for reading the entire request (incl. body).
//   - WriteTimeoutSec: max duration for writing the response. For non-streaming
//     requests this bounds the full upstream call; for streaming (SSE) responses
//     the write deadline is exempted (see proxy streamResponse) so long streams
//     are never force-terminated here.
//   - IdleTimeoutSec: max idle keep-alive time for a connection.
//   - UpstreamTimeoutSec: max duration for a single non-streaming upstream call.
//     Streaming upstream calls are intentionally unbounded (controlled by the
//     downstream request context instead).
type ServerConfig struct {
	ReadTimeoutSec     int `yaml:"readTimeoutSec" json:"readTimeoutSec"`
	WriteTimeoutSec    int `yaml:"writeTimeoutSec" json:"writeTimeoutSec"`
	IdleTimeoutSec     int `yaml:"idleTimeoutSec" json:"idleTimeoutSec"`
	UpstreamTimeoutSec int `yaml:"upstreamTimeoutSec" json:"upstreamTimeoutSec"`
}

// ProxyConfig is the global upstream HTTP proxy used only by providers that
// opt in via Provider.UseProxy.
type ProxyConfig struct {
	Enabled bool   `yaml:"enabled" json:"enabled"`
	Host    string `yaml:"host" json:"host"`
	Port    string `yaml:"port" json:"port"`
}

// DownloadConfig controls the video download feature.
type DownloadConfig struct {
	Enabled             bool   `yaml:"enabled" json:"enabled"`
	DefaultDir          string `yaml:"defaultDir,omitempty" json:"defaultDir,omitempty"`
	YtDlpPath           string `yaml:"ytDlpPath,omitempty" json:"ytDlpPath,omitempty"`
	FfmpegPath          string `yaml:"ffmpegPath,omitempty" json:"ffmpegPath,omitempty"`
	ConcurrentFragments int    `yaml:"concurrentFragments,omitempty" json:"concurrentFragments,omitempty"`
	MaxConcurrent       int    `yaml:"maxConcurrent,omitempty" json:"maxConcurrent,omitempty"`
	UseProxy            bool   `yaml:"useProxy,omitempty" json:"useProxy,omitempty"`
	BrowserCookies      string `yaml:"browserCookies,omitempty" json:"browserCookies,omitempty"`
	CookiesPath         string `yaml:"cookiesPath,omitempty" json:"cookiesPath,omitempty"`
}

// ShortcutBinding describes a keyboard shortcut binding usable by the
// frontend. CtrlOrCmd matches Ctrl on non-macOS platforms and Cmd on macOS.
// Only action IDs that the user has explicitly overridden are stored in
// Config.Shortcuts; bindings that equal the system preset are not persisted.
type ShortcutBinding struct {
	Key       string `yaml:"key" json:"key"`
	CtrlOrCmd bool   `yaml:"ctrlOrCmd,omitempty" json:"ctrlOrCmd,omitempty"`
	Alt       bool   `yaml:"alt,omitempty" json:"alt,omitempty"`
	Shift     bool   `yaml:"shift,omitempty" json:"shift,omitempty"`
}

// ShortcutsConfig maps action IDs (e.g. "global.goto-usage") to their
// user-overridden bindings. An empty (non-nil) map means "no overrides";
// a nil map is normalized to an empty map at load time so the JSON API
// returns {} rather than null.
type ShortcutsConfig map[string]ShortcutBinding

// ReviewPreset 是用户保存的审核预设，包含提示词与判定目标名称。
// 通过 /api/review-presets CRUD 端点持久化到 config.yaml。
type ReviewPreset struct {
	ID           string `yaml:"id" json:"id"`
	Name         string `yaml:"name" json:"name"`
	SystemPrompt string `yaml:"systemPrompt" json:"systemPrompt"`
	UserPrompt   string `yaml:"userPrompt,omitempty" json:"userPrompt,omitempty"`
}

// TextReviewNode 是文本审核处理池中的一个节点 = 一个 provider 的一个 model + 并发配置。
type TextReviewNode struct {
	ID          string `yaml:"id" json:"id"`
	ProviderID  string `yaml:"providerId" json:"providerId"`
	ModelID     string `yaml:"modelId" json:"modelId"`
	Concurrency int    `yaml:"concurrency" json:"concurrency"`
	Enabled     bool   `yaml:"enabled" json:"enabled"`
	// IntervalSec is the minimum number of seconds between two dispatches on
	// this node (node-level request rate limiting). 0 = no limit.
	IntervalSec int `yaml:"intervalSec,omitempty" json:"intervalSec,omitempty"`
	// BatchChars is the maximum accumulated chapter characters sent in one
	// LLM request (multi-chapter batching). 0 = no batching (one chapter per
	// request, the default single-chapter behavior).
	BatchChars int `yaml:"batchChars,omitempty" json:"batchChars,omitempty"`
}

// SplitPattern 章节检测正则（持久化形，regex 为字符串）。
type SplitPattern struct {
	Key     string `yaml:"key" json:"key"`
	Label   string `yaml:"label" json:"label"`
	Regex   string `yaml:"regex" json:"regex"`
	Flags   string `yaml:"flags,omitempty" json:"flags,omitempty"`
	Builtin bool   `yaml:"builtin,omitempty" json:"builtin,omitempty"`
}

// TextReviewConfig 持有文本审核功能的节点池、章节切分模式与默认清理 prompt 预设引用。
type TextReviewConfig struct {
	Nodes                 []TextReviewNode `yaml:"nodes,omitempty" json:"nodes,omitempty"`
	SplitPatterns         []SplitPattern   `yaml:"splitPatterns,omitempty" json:"splitPatterns,omitempty"`
	DefaultPromptPresetID string           `yaml:"defaultPromptPresetId,omitempty" json:"defaultPromptPresetId,omitempty"`
}

// AnySearchConfig stores the configuration for the AnySearch web search feature.
type AnySearchConfig struct {
	APIKey     string `yaml:"apiKey,omitempty" json:"apiKey,omitempty"`
	MaxResults int    `yaml:"maxResults,omitempty" json:"maxResults,omitempty"`
}

// ThemeConfig stores user theme preferences persisted across sessions.
// Each mode (dark/light) remembers its selected variant independently.
// Style controls the shape/motion dimension (default, sharp, soft, compact).
type ThemeConfig struct {
	DarkVariant  string `yaml:"darkVariant,omitempty" json:"darkVariant,omitempty"`   // default: "default"
	LightVariant string `yaml:"lightVariant,omitempty" json:"lightVariant,omitempty"` // default: "default"
	Style        string `yaml:"style,omitempty" json:"style,omitempty"`               // default: "default"
}

// TraceConfig controls per-request tracing (two-tier JSONL logging).
// Enabled defaults to false. Retention and disk caps are enforced by
// the background sweep goroutine in proxy.Handler.
type TraceConfig struct {
	Enabled    bool `yaml:"enabled" json:"enabled"`
	RetainDays int  `yaml:"retainDays" json:"retainDays"`
	MaxDiskMB  int  `yaml:"maxDiskMB" json:"maxDiskMB"`
	// LogDir overrides the default trace log directory ({configDir}/traces
	// when empty). A relative path is resolved against the config directory;
	// an absolute path is used verbatim. Changing it at runtime via the
	// settings API re-points the trace writer and reader immediately.
	LogDir string `yaml:"logDir,omitempty" json:"logDir,omitempty"`
}

// Config is the top-level configuration structure.
type Config struct {
	Port               int              `yaml:"port" json:"port"`
	ConsoleLogMaxLines int              `yaml:"consoleLogMaxLines" json:"consoleLogMaxLines"`
	UsageRingSize      int              `yaml:"usageRingSize" json:"usageRingSize"`
	Rotation           RotationConfig   `yaml:"rotation" json:"rotation"`
	EnablePlayground   bool             `yaml:"enablePlayground" json:"enablePlayground"`
	QuickSlotOnly      bool             `yaml:"quickSlotOnly" json:"quickSlotOnly"`
	Providers          []Provider       `yaml:"providers" json:"providers"`
	Combos             []Combo          `yaml:"combos" json:"combos"`
	QuickSlots         []QuickSlot      `yaml:"quickSlots" json:"quickSlots"`
	Security           SecurityConfig   `yaml:"security" json:"security"`
	Proxy              ProxyConfig      `yaml:"proxy" json:"proxy"`
	Server             ServerConfig     `yaml:"server" json:"server"`
	Download           DownloadConfig   `yaml:"download" json:"download"`
	Shortcuts          ShortcutsConfig  `yaml:"shortcuts,omitempty" json:"shortcuts,omitempty"`
	ReviewPresets      []ReviewPreset   `yaml:"reviewPresets,omitempty" json:"reviewPresets,omitempty"`
	AnySearch          AnySearchConfig  `yaml:"anySearch,omitempty" json:"anySearch,omitempty"`
	Trace              TraceConfig      `yaml:"trace" json:"trace"`
	ImageSaveDir       string           `yaml:"imageSaveDir,omitempty" json:"imageSaveDir,omitempty"`
	Theme              ThemeConfig      `yaml:"theme,omitempty" json:"theme,omitempty"`
	TextReview         TextReviewConfig `yaml:"textReview,omitempty" json:"textReview,omitempty"`
}
