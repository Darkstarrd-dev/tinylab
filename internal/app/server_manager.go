package app

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
)

// ServerManager wraps an *http.Server so it can be gracefully restarted
// on a new address without restarting the entire process.
type ServerManager struct {
	mu        sync.Mutex
	srv       *http.Server
	handler   http.Handler
	addr      string
	configDir string // directory for error logs and config files
	logger    *console.Logger
	serverCfg config.ServerConfig
}

// NewServerManager creates a ServerManager that will serve handler on addr.
// serverCfg controls the HTTP server timeouts (seconds); see config.ServerConfig.
func NewServerManager(handler http.Handler, addr string, logger *console.Logger, serverCfg config.ServerConfig) *ServerManager {
	return &ServerManager{handler: handler, addr: addr, logger: logger, serverCfg: serverCfg}
}

// Start begins listening on the configured address.
func (m *ServerManager) Start() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.startLocked()
}

// SetConfigDir sets the config directory path for error log file writing.
// Must be called before Start if port conflict handling is desired.
func (m *ServerManager) SetConfigDir(configDir string) {
	m.configDir = configDir
}

// startLocked creates and starts the http.Server. Caller must hold m.mu.
func (m *ServerManager) startLocked() {
	m.srv = &http.Server{
		Addr:           m.addr,
		Handler:        m.handler,
		ReadTimeout:    time.Duration(m.serverCfg.ReadTimeoutSec) * time.Second,
		WriteTimeout:   time.Duration(m.serverCfg.WriteTimeoutSec) * time.Second,
		IdleTimeout:    time.Duration(m.serverCfg.IdleTimeoutSec) * time.Second,
		MaxHeaderBytes: 1 << 20, // 1 MB
	}

	// Use net.Listen to get a listener with port conflict resolution.
	ln, err := net.Listen("tcp", m.addr)
	if err != nil && isAddrInUse(err) {
		// Extract port number from addr string.
		_, portStr, _ := net.SplitHostPort(m.addr)
		port, _ := strconv.Atoi(portStr)
		if port > 0 && m.configDir != "" {
			if resolvePortConflict(m.configDir, port) {
				// User agreed to kill the old instance; retry listening
				ln, err = net.Listen("tcp", m.addr)
			} else {
				// resolvePortConflict already showed feedback (dialog + log); exit silently
				os.Exit(1)
			}
		}
	}
	if err != nil {
		FeedbackFatalError(m.configDir, fmt.Sprintf("listen %s failed: %v", m.addr, err))
		log.Fatalf("server error: %v", err)
	}

	go func() {
		m.logger.Info("TinyLab v%s starting on http://%s", Version, m.addr)
		if err := m.srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			if isAddrInUse(err) {
				FeedbackFatalError(m.configDir, fmt.Sprintf("端口 %s 已被占用，可能已有另一个 TinyLab 实例在运行", m.addr))
			}
			FeedbackFatalError(m.configDir, fmt.Sprintf("server error: %v", err))
			log.Fatalf("server error: %v", err)
		}
	}()
}

// SetServerConfig updates the server timeout settings used when (re)starting
// the underlying *http.Server. It takes effect on the next Start/Restart, not
// for the currently running server instance.
func (m *ServerManager) SetServerConfig(cfg config.ServerConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.serverCfg = cfg
}

// Restart gracefully shuts down the current server and starts a new one on
// newAddr. The HTTP handler is reused; only the listening address changes.
func (m *ServerManager) Restart(newAddr string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := m.srv.Shutdown(ctx); err != nil {
			m.logger.Warn("server shutdown error during restart: %v", err)
		}
	}
	m.addr = newAddr
	m.startLocked()
}

// Shutdown gracefully stops the current server.
func (m *ServerManager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.srv != nil {
		return m.srv.Shutdown(ctx)
	}
	return nil
}

// ForceClose immediately closes the listener and all active connections
// ("power-cut" shutdown). Used by App.Shutdown when graceful drain does not
// finish in the short allotted window. Safe to call after Shutdown.
func (m *ServerManager) ForceClose() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.srv != nil {
		_ = m.srv.Close()
	}
}
