// Package settings provides HTTP handlers for the settings management API
// (get/update settings, reload config, shutdown).
package settings

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/api/auth"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/download"
)

// Handler exposes the settings API endpoints.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers settings routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/settings", h.getSettings)
	r.Patch("/settings", h.updateSettings)
	r.Post("/reload", h.reload)
	r.Post("/shutdown", h.handleShutdown)
}

// --- Settings / Lifecycle ---

func (h *Handler) getSettings(w http.ResponseWriter, r *http.Request) {
	cfg := h.d.Reg.Config()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"configDir":          filepath.Dir(h.d.ConfigPath),
		"port":               cfg.Port,
		"consoleLogMaxLines": cfg.ConsoleLogMaxLines,
		"usageRingSize":      cfg.UsageRingSize,
		"rotation":           cfg.Rotation,
		"enablePlayground":   cfg.EnablePlayground,
		"quickSlotOnly":      cfg.QuickSlotOnly,
		"debugMode":          h.d.DebugMode.Load(),
		"trace": map[string]any{
			"enabled":    h.d.LogRequests.Load(),
			"retainDays": cfg.Trace.RetainDays,
			"maxDiskMB":  cfg.Trace.MaxDiskMB,
			"logDir":     cfg.Trace.LogDir,
		},
		"proxy":        cfg.Proxy,
		"server":       cfg.Server,
		"imageSaveDir": cfg.ImageSaveDir,
		"download":     cfg.Download,
		"shortcuts":    cfg.Shortcuts,
		"security": map[string]any{
			"passwordEnabled": cfg.Security.PasswordEnabled,
			"hasPassword":     cfg.Security.PasswordEncrypted != "",
		},
		"anySearch": map[string]any{
			"apiKey":     cfg.AnySearch.APIKey,
			"maxResults": cfg.AnySearch.MaxResults,
		},
		"theme": cfg.Theme,
		"archive": map[string]any{
			"sevenZipPath": cfg.Archive.SevenZipPath,
			"rarPath":      cfg.Archive.RarPath,
			"tempDir":      cfg.Archive.TempDir,
		},
	})
}

func (h *Handler) updateSettings(w http.ResponseWriter, r *http.Request) {
	var updates struct {
		Port               *int           `json:"port"`
		ConsoleLogMaxLines *int           `json:"consoleLogMaxLines"`
		UsageRingSize      *int           `json:"usageRingSize"`
		Rotation           *rotationPatch `json:"rotation"`
		EnablePlayground   *bool          `json:"enablePlayground"`
		QuickSlotOnly      *bool          `json:"quickSlotOnly"`
		DebugMode          *bool          `json:"debugMode"`
		Trace              *struct {
			Enabled    *bool   `json:"enabled"`
			RetainDays *int    `json:"retainDays"`
			MaxDiskMB  *int    `json:"maxDiskMB"`
			LogDir     *string `json:"logDir"`
		} `json:"trace"`
		Proxy    *config.ProxyConfig  `json:"proxy"`
		Server   *config.ServerConfig `json:"server"`
		Download *struct {
			YtDlpPath           *string `json:"ytDlpPath"`
			FfmpegPath          *string `json:"ffmpegPath"`
			DefaultDir          *string `json:"defaultDir"`
			UseProxy            *bool   `json:"useProxy"`
			BrowserCookies      *string `json:"browserCookies"`
			CookiesPath         *string `json:"cookiesPath"`
			ConcurrentFragments *int    `json:"concurrentFragments"`
			MaxConcurrent       *int    `json:"maxConcurrent"`
		} `json:"download"`
		Shortcuts *config.ShortcutsConfig `json:"shortcuts"`
		Security  *struct {
			PasswordEnabled *bool  `json:"passwordEnabled"`
			Password        string `json:"password"`
		} `json:"security"`
		AnySearch *struct {
			APIKey     *string `json:"apiKey"`
			MaxResults *int    `json:"maxResults"`
		} `json:"anySearch"`
		Theme        *config.ThemeConfig `json:"theme"`
		ImageSaveDir *string             `json:"imageSaveDir"`
		Archive      *archivePatch       `json:"archive"`
	}
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	cfg := h.d.Reg.Config()
	portChanged := false
	serverChanged := false
	if updates.Port != nil {
		newPort := *updates.Port
		if newPort < 1 || newPort > 65535 {
			apibase.WriteAPIError(w, http.StatusBadRequest, fmt.Sprintf("invalid port number: %d", newPort))
			return
		}
		if newPort != cfg.Port {
			if err := apibase.CheckPortAvailable(newPort); err != nil {
				apibase.WriteAPIError(w, http.StatusBadRequest, fmt.Sprintf("port %d is not available: %v", newPort, err))
				return
			}
			portChanged = true
		}
		cfg.Port = newPort
	}
	if updates.ConsoleLogMaxLines != nil {
		cfg.ConsoleLogMaxLines = *updates.ConsoleLogMaxLines
	}
	if updates.UsageRingSize != nil {
		cfg.UsageRingSize = *updates.UsageRingSize
	}
	if updates.Rotation != nil {
		applyRotationUpdates(&cfg, updates.Rotation)
	}
	if updates.EnablePlayground != nil {
		cfg.EnablePlayground = *updates.EnablePlayground
	}
	if updates.QuickSlotOnly != nil {
		cfg.QuickSlotOnly = *updates.QuickSlotOnly
		h.d.QuickSlotOnly.Store(*updates.QuickSlotOnly)
	}
	if updates.DebugMode != nil {
		h.d.DebugMode.Store(*updates.DebugMode)
	}
	if updates.Trace != nil {
		if updates.Trace.Enabled != nil {
			h.d.LogRequests.Store(*updates.Trace.Enabled)
			cfg.Trace.Enabled = *updates.Trace.Enabled
		}
		if updates.Trace.RetainDays != nil {
			cfg.Trace.RetainDays = *updates.Trace.RetainDays
		}
		if updates.Trace.MaxDiskMB != nil {
			cfg.Trace.MaxDiskMB = *updates.Trace.MaxDiskMB
		}
		if updates.Trace.LogDir != nil {
			cfg.Trace.LogDir = *updates.Trace.LogDir
			h.d.ProxyHandler.SetRequestLogDir(config.ResolveTraceDir(cfg.Trace.LogDir, filepath.Dir(h.d.ConfigPath)))
		}
	}
	if updates.Security != nil {
		if updates.Security.PasswordEnabled != nil && *updates.Security.PasswordEnabled {
			if updates.Security.Password == "" && cfg.Security.PasswordEncrypted == "" {
				apibase.WriteAPIError(w, http.StatusBadRequest, "cannot enable password protection without setting a password")
				return
			}
			cfg.Security.PasswordEnabled = true
		} else if updates.Security.PasswordEnabled != nil && !*updates.Security.PasswordEnabled {
			cfg.Security.PasswordEnabled = false
			cfg.Security.PasswordEncrypted = ""
			cfg.Security.EncryptionKey = ""
		}
		if updates.Security.Password != "" {
			key, err := config.GenerateKey()
			if err != nil {
				apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to generate encryption key")
				return
			}
			encrypted, err := config.Encrypt(key, updates.Security.Password)
			if err != nil {
				apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to encrypt password")
				return
			}
			cfg.Security.EncryptionKey = key
			cfg.Security.PasswordEncrypted = encrypted
			cfg.Security.PasswordEnabled = true
		}
	}
	if updates.Proxy != nil {
		if err := validateProxyConfig(*updates.Proxy); err != nil {
			apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
			return
		}
		cfg.Proxy = *updates.Proxy
		if err := h.d.ProxyHandler.SetProxy(cfg.Proxy.Enabled, cfg.Proxy.Host, cfg.Proxy.Port); err != nil {
			apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	// Changing proxy may affect download proxy routing.
	h.pushDownloadSettings(cfg)
	if updates.Server != nil {
		cfg.Server = *updates.Server
		config.FinalizeServerConfig(&cfg.Server)
		serverChanged = true
		if h.d.ServerCfgFn != nil {
			h.d.ServerCfgFn(cfg.Server)
		}
		if h.d.UpstreamTimeoutFn != nil {
			h.d.UpstreamTimeoutFn(cfg.Server.UpstreamTimeoutSec)
		}
	}
	if updates.Download != nil {
		if updates.Download.YtDlpPath != nil {
			cfg.Download.YtDlpPath = *updates.Download.YtDlpPath
		}
		if updates.Download.FfmpegPath != nil {
			cfg.Download.FfmpegPath = *updates.Download.FfmpegPath
		}
		if updates.Download.DefaultDir != nil {
			cfg.Download.DefaultDir = *updates.Download.DefaultDir
		}
		if updates.Download.UseProxy != nil {
			cfg.Download.UseProxy = *updates.Download.UseProxy
		}
		if updates.Download.BrowserCookies != nil {
			cfg.Download.BrowserCookies = *updates.Download.BrowserCookies
		}
		if updates.Download.CookiesPath != nil {
			cfg.Download.CookiesPath = *updates.Download.CookiesPath
		}
		if updates.Download.ConcurrentFragments != nil {
			cfg.Download.ConcurrentFragments = *updates.Download.ConcurrentFragments
		}
		if updates.Download.MaxConcurrent != nil {
			cfg.Download.MaxConcurrent = *updates.Download.MaxConcurrent
		}
		h.pushDownloadSettings(cfg)
	}

	// Shortcuts: replace the entire overrides map. The frontend always
	// sends the full current set of overrides (possibly {}) so we don't
	// need to merge — a direct assignment drops any override the user
	// just reset to default. A nil map here is normalized to {} by
	// finalizeConfig on the next Load, but we set it explicitly so the
	// in-memory cfg is consistent immediately.
	if updates.Shortcuts != nil {
		cfg.Shortcuts = *updates.Shortcuts
		if cfg.Shortcuts == nil {
			cfg.Shortcuts = config.ShortcutsConfig{}
		}
	}

	if updates.AnySearch != nil {
		if updates.AnySearch.APIKey != nil {
			cfg.AnySearch.APIKey = *updates.AnySearch.APIKey
		}
		if updates.AnySearch.MaxResults != nil {
			cfg.AnySearch.MaxResults = *updates.AnySearch.MaxResults
		}
	}

	if updates.Theme != nil {
		applyThemeUpdates(&cfg, updates.Theme)
	}
	if updates.ImageSaveDir != nil {
		cfg.ImageSaveDir = *updates.ImageSaveDir
	}

	if updates.Archive != nil {
		applyArchiveUpdates(&cfg, updates.Archive)
	}

	if err := h.d.SaveConfigAndReload(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	h.d.Selector.UpdateSettings(cfg.Rotation)
	if h.d.ArchiveSettingsFn != nil {
		h.d.ArchiveSettingsFn(cfg.Archive)
	}

	// If password protection was just enabled or a new password was set,
	// issue a session token to the current client so it stays authenticated.
	// Without this, enabling password protection would immediately lock out
	// the current session (AuthMiddleware activates on Reload), making the
	// subsequent "save password" request fail with 401.
	if updates.Security != nil {
		justEnabled := updates.Security.PasswordEnabled != nil && *updates.Security.PasswordEnabled
		passwordSet := updates.Security.Password != ""
		passwordChanged := justEnabled || passwordSet
		if passwordChanged {
			auth.SessionStore.ClearAll()
			if token, err := auth.GenerateToken(); err == nil {
				auth.SessionStore.StoreToken(token)
				auth.SetSessionCookie(w, token)
			}
		}
	}

	if portChanged && h.d.RestartFn != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"ok":      true,
			"restart": true,
			"port":    cfg.Port,
		})
		newAddr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
		go func() {
			time.Sleep(300 * time.Millisecond)
			h.d.RestartFn(newAddr)
		}()
		return
	}

	if serverChanged && !portChanged && h.d.RestartFn != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"ok":      true,
			"restart": true,
			"port":    cfg.Port,
		})
		newAddr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
		go func() {
			time.Sleep(300 * time.Millisecond)
			h.d.RestartFn(newAddr)
		}()
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// rotationPatch carries the presence-aware rotation fields accepted by the
// settings PATCH endpoint. Pointer fields distinguish "field not sent" from
// "zero value", so a partial update can never wipe RotationConfig fields the
// frontend does not manage (StatePersist / StatePath are runtime-managed by
// the app and must survive any rotation PATCH).
type rotationPatch struct {
	Strategy      *string `json:"strategy"`
	StickyLimit   *int    `json:"stickyLimit"`
	MaxRetries    *int    `json:"maxRetries"`
	RetryDelaySec *int    `json:"retryDelaySec"`
	BackoffMaxSec *int    `json:"backoffMaxSec"`
}

// applyRotationUpdates merges the presence-aware patch into cfg.Rotation.
// Fields absent from the patch (nil pointer) are left untouched.
func applyRotationUpdates(cfg *config.Config, patch *rotationPatch) {
	if patch == nil {
		return
	}
	if patch.Strategy != nil {
		cfg.Rotation.Strategy = *patch.Strategy
	}
	if patch.StickyLimit != nil {
		cfg.Rotation.StickyLimit = *patch.StickyLimit
	}
	if patch.MaxRetries != nil {
		cfg.Rotation.MaxRetries = *patch.MaxRetries
	}
	if patch.RetryDelaySec != nil {
		cfg.Rotation.RetryDelaySec = *patch.RetryDelaySec
	}
	if patch.BackoffMaxSec != nil {
		cfg.Rotation.BackoffMaxSec = *patch.BackoffMaxSec
	}
}

// pushDownloadSettings pushes the current download runtime settings to the
// download manager, so active and future downloads pick up the latest config
// without an app restart.
func (h *Handler) pushDownloadSettings(cfg config.Config) {
	if h.d.DownloadMgr == nil {
		return
	}

	h.d.DownloadMgr.UpdateSettings(download.RuntimeSettings{
		DownloadDir:         cfg.Download.DefaultDir,
		YtDlpPath:           cfg.Download.YtDlpPath,
		FfmpegPath:          cfg.Download.FfmpegPath,
		ConcurrentFragments: cfg.Download.ConcurrentFragments,
		MaxConcurrent:       cfg.Download.MaxConcurrent,
		Proxy:               config.ResolveDownloadProxy(&cfg),
		BrowserCookies:      cfg.Download.BrowserCookies,
		CookiesPath:         cfg.Download.CookiesPath,
	})
}

// applyThemeUpdates merges the non-empty theme fields from a settings PATCH.
// Empty fields are treated as absent so partial updates preserve existing
// mode variants and style preferences.
func applyThemeUpdates(cfg *config.Config, patch *config.ThemeConfig) {
	if patch == nil {
		return
	}
	if patch.DarkVariant != "" {
		cfg.Theme.DarkVariant = patch.DarkVariant
	}
	if patch.LightVariant != "" {
		cfg.Theme.LightVariant = patch.LightVariant
	}
	if patch.Style != "" {
		cfg.Theme.Style = patch.Style
	}
}

// archivePatch carries the presence-aware archive fields accepted by the
// settings PATCH endpoint. Pointer fields distinguish "field not sent" from
// "explicitly cleared", so a partial update can never wipe fields the
// frontend does not manage, while an empty string is honored as an explicit
// clear back to environment/PATH tool resolution.
type archivePatch struct {
	SevenZipPath *string `json:"sevenZipPath"`
	RarPath      *string `json:"rarPath"`
	TempDir      *string `json:"tempDir"`
}

// applyArchiveUpdates merges the presence-aware patch into cfg.Archive.
// Fields absent from the patch (nil pointer) are left untouched; an explicit
// empty string clears the field back to its zero value (environment/PATH
// resolution at runtime).
func applyArchiveUpdates(cfg *config.Config, patch *archivePatch) {
	if patch == nil {
		return
	}
	if patch.SevenZipPath != nil {
		cfg.Archive.SevenZipPath = *patch.SevenZipPath
	}
	if patch.RarPath != nil {
		cfg.Archive.RarPath = *patch.RarPath
	}
	if patch.TempDir != nil {
		cfg.Archive.TempDir = *patch.TempDir
	}
}

// validateProxyConfig checks that the proxy host and port are well-formed when
// proxying is enabled. Port must be a numeric value in [1,65535].
func validateProxyConfig(p config.ProxyConfig) error {
	if !p.Enabled {
		return nil
	}
	host := strings.TrimSpace(p.Host)
	port := strings.TrimSpace(p.Port)
	if host == "" {
		return fmt.Errorf("proxy host is required")
	}
	if port == "" {
		return fmt.Errorf("proxy port is required")
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("proxy port must be a number between 1 and 65535")
	}
	return nil
}

func (h *Handler) reload(w http.ResponseWriter, r *http.Request) {
	cfg, err := config.Load(h.d.ConfigPath)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to reload config")
		return
	}
	h.d.Reg.Reload(cfg)
	h.d.Selector.UpdateSettings(cfg.Rotation)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (h *Handler) handleShutdown(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	// Trigger shutdown after a short delay so the response is flushed.
	go func() {
		time.Sleep(100 * time.Millisecond)
		h.d.Shutdown()
	}()
}
