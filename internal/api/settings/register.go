// Package settings provides HTTP handlers for the settings management API
// (get/update settings, reload config, shutdown).
package settings

import (
	"encoding/json"
	"fmt"
	"net/http"
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
		"port":               cfg.Port,
		"consoleLogMaxLines": cfg.ConsoleLogMaxLines,
		"usageRingSize":      cfg.UsageRingSize,
		"rotation":           cfg.Rotation,
		"enablePlayground":   cfg.EnablePlayground,
		"quickSlotOnly":      cfg.QuickSlotOnly,
		"debugMode":          h.d.DebugMode.Load(),
		"proxy":              cfg.Proxy,
		"server":             cfg.Server,
		"download":           cfg.Download,
		"shortcuts":          cfg.Shortcuts,
		"security": map[string]any{
			"passwordEnabled": cfg.Security.PasswordEnabled,
			"hasPassword":     cfg.Security.PasswordEncrypted != "",
		},
		"anySearch": map[string]any{
			"apiKey":     cfg.AnySearch.APIKey,
			"maxResults": cfg.AnySearch.MaxResults,
		},
		"theme": cfg.Theme,
	})
}

func (h *Handler) updateSettings(w http.ResponseWriter, r *http.Request) {
	var updates struct {
		Port               *int                   `json:"port"`
		ConsoleLogMaxLines *int                   `json:"consoleLogMaxLines"`
		UsageRingSize      *int                   `json:"usageRingSize"`
		Rotation           *config.RotationConfig `json:"rotation"`
		EnablePlayground   *bool                  `json:"enablePlayground"`
		QuickSlotOnly      *bool                  `json:"quickSlotOnly"`
		DebugMode          *bool                  `json:"debugMode"`
		Proxy              *config.ProxyConfig    `json:"proxy"`
		Server             *config.ServerConfig   `json:"server"`
		Download           *config.DownloadConfig `json:"download"`
		Shortcuts          *config.ShortcutsConfig `json:"shortcuts"`
		Security           *struct {
			PasswordEnabled *bool  `json:"passwordEnabled"`
			Password        string `json:"password"`
		} `json:"security"`
		AnySearch *struct {
			APIKey     *string `json:"apiKey"`
			MaxResults *int    `json:"maxResults"`
		} `json:"anySearch"`
		Theme *config.ThemeConfig `json:"theme"`
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
		cfg.Rotation = *updates.Rotation
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
	if updates.Security != nil {
		if updates.Security.PasswordEnabled != nil {
			cfg.Security.PasswordEnabled = *updates.Security.PasswordEnabled
			if !*updates.Security.PasswordEnabled {
				cfg.Security.PasswordEncrypted = ""
				cfg.Security.EncryptionKey = ""
			}
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
		// Merge partial download updates from the frontend. String fields are
		// always copied (empty means "clear the override"). Numeric fields are
		// only overwritten when non-zero so a partial update from the download
		// page doesn't reset concurrentFragments/maxConcurrent/enabled.
		cfg.Download.YtDlpPath = updates.Download.YtDlpPath
		cfg.Download.FfmpegPath = updates.Download.FfmpegPath
		cfg.Download.DefaultDir = updates.Download.DefaultDir
		cfg.Download.Proxy = updates.Download.Proxy
		cfg.Download.BrowserCookies = updates.Download.BrowserCookies
		cfg.Download.CookiesPath = updates.Download.CookiesPath
		if updates.Download.ConcurrentFragments > 0 {
			cfg.Download.ConcurrentFragments = updates.Download.ConcurrentFragments
		}
		if updates.Download.MaxConcurrent > 0 {
			cfg.Download.MaxConcurrent = updates.Download.MaxConcurrent
		}
		// Push the updated paths (and other download settings) to the running
		// download manager so active and future downloads pick them up without
		// an app restart.
		if h.d.DownloadMgr != nil {
			h.d.DownloadMgr.UpdateSettings(download.RuntimeSettings{
				DownloadDir:         cfg.Download.DefaultDir,
				YtDlpPath:           cfg.Download.YtDlpPath,
				FfmpegPath:          cfg.Download.FfmpegPath,
				ConcurrentFragments: cfg.Download.ConcurrentFragments,
				MaxConcurrent:       cfg.Download.MaxConcurrent,
				Proxy:               cfg.Download.Proxy,
				BrowserCookies:      cfg.Download.BrowserCookies,
				CookiesPath:         cfg.Download.CookiesPath,
			})
		}
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
		if updates.Theme.DarkVariant != "" {
			cfg.Theme.DarkVariant = updates.Theme.DarkVariant
		}
		if updates.Theme.LightVariant != "" {
			cfg.Theme.LightVariant = updates.Theme.LightVariant
		}
	}

	if err := h.d.SaveConfigAndReload(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	h.d.Selector.UpdateSettings(cfg.Rotation)

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