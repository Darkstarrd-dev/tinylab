package config

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DefaultServerConfig returns the default server timeout settings.
func DefaultServerConfig() ServerConfig {
	return ServerConfig{
		ReadTimeoutSec:     300,
		WriteTimeoutSec:    300,
		IdleTimeoutSec:     120,
		UpstreamTimeoutSec: 300,
	}
}

// FinalizeServerConfig fills zero-valued fields with their defaults so a
// partial server config (e.g. from a settings PATCH) keeps sane values.
func FinalizeServerConfig(s *ServerConfig) {
	def := DefaultServerConfig()
	if s.ReadTimeoutSec == 0 {
		s.ReadTimeoutSec = def.ReadTimeoutSec
	}
	if s.WriteTimeoutSec == 0 {
		s.WriteTimeoutSec = def.WriteTimeoutSec
	}
	if s.IdleTimeoutSec == 0 {
		s.IdleTimeoutSec = def.IdleTimeoutSec
	}
	if s.UpstreamTimeoutSec == 0 {
		s.UpstreamTimeoutSec = def.UpstreamTimeoutSec
	}
}

// DefaultConfig returns a sane default configuration.
func DefaultConfig() *Config {
	return &Config{
		Port:               20128,
		ConsoleLogMaxLines: 200,
		UsageRingSize:      500,
		Rotation: RotationConfig{
			Strategy:      "fill-first",
			StickyLimit:   3,
			MaxRetries:    5,
			RetryDelaySec: 5,
			BackoffMaxSec: 300,
			StatePersist:  true,
			StatePath:     "state.yaml",
		},
		EnablePlayground: true,
		Trace: TraceConfig{
			Enabled:    false,
			RetainDays: 2,
			MaxDiskMB:  500,
		},
		Providers:        []Provider{},
		Combos:           []Combo{},
		QuickSlots:       []QuickSlot{},
		Server:           DefaultServerConfig(),
		Download: DownloadConfig{
			Enabled:             true,
			ConcurrentFragments: 4,
			MaxConcurrent:       3,
		},
	}
}

// finalizeConfig fills in default values for zero-valued fields and normalizes
// model quota types. raw is the original YAML bytes (used to detect whether
// enablePlayground was explicitly set in the file).
func finalizeConfig(cfg *Config, raw []byte) *Config {
	if cfg.Port == 0 {
		cfg.Port = 20128
	}
	// Validate the port after applying the default.
	if err := validatePort(cfg.Port); err != nil {
		fmt.Fprintf(os.Stderr, "[config] error: %v\n", err)
	}
	if cfg.ConsoleLogMaxLines == 0 {
		cfg.ConsoleLogMaxLines = 200
	}
	if cfg.UsageRingSize == 0 {
		cfg.UsageRingSize = 500
	}
	// Default EnablePlayground to true if not explicitly set in config.
	// Existing configs from before this field was added would otherwise
	// get the zero value (false) and silently hide the playground.
	if !bytes.Contains(raw, []byte("enablePlayground")) {
		cfg.EnablePlayground = true
	}
	// StatePersist 默认 true（向后兼容旧 config 无此字段时启用持久化）。
	// 仅当文件里没有出现 state_persist 时才填默认值，避免用户显式写 false 被覆盖。
	if !cfg.Rotation.StatePersist && !bytes.Contains(raw, []byte("state_persist")) {
		cfg.Rotation.StatePersist = true
	}
	if cfg.Rotation.StatePath == "" {
		cfg.Rotation.StatePath = "state.yaml"
	}
	// Fill zero-valued server timeouts with defaults so a partial `server:`
	// block in config.yaml keeps sane values for the unspecified fields.
	FinalizeServerConfig(&cfg.Server)
	for i := range cfg.Providers {
		if cfg.Providers[i].APIType == "anthropic" && cfg.Providers[i].AnthropicVersion == "" {
			cfg.Providers[i].AnthropicVersion = "2023-06-01"
		}
		for j := range cfg.Providers[i].Models {
			if cfg.Providers[i].Models[j].QuotaType == "" {
				cfg.Providers[i].Models[j].QuotaType = "limited"
			}
		}
	}
	validateProviders(cfg)
	// Download defaults. If the `download:` section is entirely absent from the
	// config file (e.g., config created before this feature was added), default
	// Enabled to true. If the section IS present, respect the user's settings
	// (including an explicit enabled: false).
	hasDownloadSection := bytes.Contains(raw, []byte("\ndownload:")) || bytes.HasPrefix(raw, []byte("download:"))
	if !hasDownloadSection {
		cfg.Download.Enabled = true
	}
	if cfg.Download.ConcurrentFragments == 0 {
		cfg.Download.ConcurrentFragments = 4
	}
	if cfg.Download.MaxConcurrent == 0 {
		cfg.Download.MaxConcurrent = 3
	}
	if cfg.Download.DefaultDir == "" {
		// 使用用户主目录下的 "Downloads" 文件夹
		if home, err := os.UserHomeDir(); err == nil {
			cfg.Download.DefaultDir = filepath.Join(home, "Downloads")
		}
	}
	// Security consistency: PasswordEnabled without a stored password is an
	// inconsistent state (e.g., user toggled on without setting a password,
	// or manually edited config.yaml). Normalize to disabled to prevent
	// lockout and the LoginHandler defensive-bypass security hole.
	if cfg.Security.PasswordEnabled && (cfg.Security.PasswordEncrypted == "" || cfg.Security.EncryptionKey == "") {
		fmt.Fprintf(os.Stderr, "[config] warning: passwordEnabled is true but no password is set; disabling password protection\n")
		cfg.Security.PasswordEnabled = false
	}
	if !cfg.Security.PasswordEnabled {
		hasEncryptedKeys := false
		for i := range cfg.Providers {
			for j := range cfg.Providers[i].Keys {
				if strings.HasPrefix(cfg.Providers[i].Keys[j].Key, "enc:") {
					hasEncryptedKeys = true
					break
				}
			}
			if hasEncryptedKeys {
				break
			}
		}
		if hasEncryptedKeys {
			fmt.Fprintf(os.Stderr, "[config] warning: encrypted API keys found but password protection is disabled; these keys cannot be decrypted and will not work\n")
		}
	}

	// Decrypt API keys if password protection is enabled.
	// Encrypted keys are prefixed with "enc:" in the YAML file.
	if cfg.Security.PasswordEnabled && cfg.Security.EncryptionKey != "" {
		for i := range cfg.Providers {
			for j := range cfg.Providers[i].Keys {
				k := &cfg.Providers[i].Keys[j]
				if strings.HasPrefix(k.Key, "enc:") {
					encrypted := strings.TrimPrefix(k.Key, "enc:")
					if decrypted, err := Decrypt(cfg.Security.EncryptionKey, encrypted); err == nil {
						k.Key = decrypted
					}
				}
			}
		}
	}
	// Normalize Shortcuts: a nil map becomes an empty map so the JSON API
	// returns {} rather than null, and so callers can safely range over it.
	// User-overridden bindings are persisted as-is; the system preset lives
	// in the frontend and is the fallback for any action ID not present here.
	if cfg.Shortcuts == nil {
		cfg.Shortcuts = ShortcutsConfig{}
	}
	// 若 reviewPresets 为 nil（首次启动），注入内置广告审核预设。
	// 是 nil 而非 len==0 判断：用户清空后存为 []，不应再次注入。
	if cfg.ReviewPresets == nil {
		cfg.ReviewPresets = []ReviewPreset{
			{
				ID:           "builtin-ad",
				Name:         "广告审核",
				SystemPrompt: "You review images and judge whether each image matches the criterion below. The criterion is: the image is an advertisement or promotion page. Treat as a match (match=true) if it contains QR codes, URLs, store/product promotions, coupons/discounts, game downloads, gambling, recruitment, or Chinese marketing text such as '关注公众号', '扫码', '推广', '促销', '下载游戏', '官方微博', '官方QQ群', '加群领取', '长按扫码'. Also treat pure-color or near-pure-color pages (solid white/black separator or blank pages) as a match. Ignore normal story pages. Respond JSON only: {\"match\": true/false, \"reason\": string}.",
				UserPrompt:   "Does this image match the criterion? Return JSON only.",
			},
		}
	}

	// 若 textReview.splitPatterns 为 nil（首次启动或配置无此字段），注入内置章节检测模式。
	// 是 nil 而非 len==0 判断：用户清空后存为 []，不应再次注入。移植自
	// novelhelper/frontend/src/utils/split.ts::DEFAULT_SPLIT_PATTERNS。
	if cfg.TextReview.SplitPatterns == nil {
		cfg.TextReview.SplitPatterns = []SplitPattern{
			{Key: "zhang", Label: "第X章（中文/阿拉伯数字）", Regex: "^(第[0-9零一二三四五六七八九十百千万]+章.*)", Builtin: true},
			{Key: "hui", Label: "第X回", Regex: "^(第[0-9零一二三四五六七八九十百千万]+回.*)", Builtin: true},
			{Key: "juan", Label: "第X卷", Regex: "^(第[0-9零一二三四五六七八九十百千万]+卷.*)", Builtin: true},
			{Key: "jie", Label: "第X节", Regex: "^(第[0-9零一二三四五六七八九十百千万]+节.*)", Builtin: true},
			{Key: "x-zhang", Label: "X章（无「第」字）", Regex: "^([0-9零一二三四五六七八九十百千万]+章.*)", Builtin: true},
			{Key: "chapter", Label: "Chapter N（英文）", Regex: "^(chapter\\s+[0-9ivxlc]+.*)", Flags: "i", Builtin: true},
			{Key: "dunhao", Label: "数字+顿号（3、标题）", Regex: "^(\\d{1,4}、.*)", Builtin: true},
			{Key: "maohao", Label: "数字+冒号（001：标题）", Regex: "^(\\d{1,4}[:：].*)", Builtin: true},
			{Key: "custom", Label: "自定义正则", Regex: "", Builtin: true},
		}
	}
	if cfg.AnySearch.MaxResults == 0 {
		cfg.AnySearch.MaxResults = 5
	}
	// Theme variant defaults.
	if cfg.Theme.DarkVariant == "" {
		cfg.Theme.DarkVariant = "default"
	}
	if cfg.Theme.LightVariant == "" {
		cfg.Theme.LightVariant = "default"
	}
	if cfg.Theme.Style == "" {
		cfg.Theme.Style = "default"
	}
	// Trace defaults. If the `trace:` section is entirely absent from the
	// config file (e.g. config created before this feature was added),
	// default Enabled to false (opt-in) and RetainDays/MaxDiskMB to their
	// defaults. If the section IS present, respect the user's settings
	// (including an explicit enabled: true). Zero-valued RetainDays/MaxDiskMB
	// are filled from defaults so a partial trace block keeps sane values.
	hasTraceSection := bytes.Contains(raw, []byte("\ntrace:")) || bytes.HasPrefix(raw, []byte("trace:"))
	if !hasTraceSection {
		cfg.Trace.Enabled = false
		cfg.Trace.RetainDays = 2
		cfg.Trace.MaxDiskMB = 500
	}
	if cfg.Trace.RetainDays == 0 {
		cfg.Trace.RetainDays = 2
	}
	if cfg.Trace.MaxDiskMB == 0 {
		cfg.Trace.MaxDiskMB = 500
	}
	return cfg
}
