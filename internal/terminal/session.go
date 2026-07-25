package terminal

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/aymanbagabas/go-pty"
	"github.com/gorilla/websocket"
)

// Session represents a single interactive terminal session.
type Session struct {
	mu      sync.Mutex
	pty     pty.Pty
	cmd     *pty.Cmd
	conn    *websocket.Conn
	cancel  context.CancelFunc
	closed  bool
	onClose func()
}

// NewSession creates and starts an interactive terminal session.
func NewSession(shellPath string, conn *websocket.Conn, onClose func()) (*Session, error) {
	if shellPath == "" {
		shellPath = defaultShell()
	}

	path, err := exec.LookPath(shellPath)
	if err != nil {
		return nil, fmt.Errorf("shell not found: %s", shellPath)
	}

	pt, err := pty.New()
	if err != nil {
		return nil, fmt.Errorf("failed to create PTY: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cmd := pt.CommandContext(ctx, path)
	cmd.Env = buildShellEnv()
	// NOTE: CREATE_NO_WINDOW is NOT set here even though it would hide the
	// console window. go-pty uses ConPTY (CreatePseudoConsole) to create a
	// pseudo console for the shell. Setting CREATE_NO_WINDOW conflicts with
	// the ConPTY attribute list in CreateProcess, causing the shell to fail
	// to start (the WS connects but immediately aborts with no PTY output).
	// ConPTY itself provides the console — no visible window should appear
	// because the process is attached to the pseudo console, not a real one.
	// If window flashing is observed for child processes (e.g. nvidia-smi),
	// that is a ConPTY inheritance limitation, not fixable from here.

	if err := cmd.Start(); err != nil {
		cancel()
		_ = pt.Close()
		return nil, fmt.Errorf("failed to start shell: %w", err)
	}

	session := &Session{
		pty:     pt,
		cmd:     cmd,
		conn:    conn,
		cancel:  cancel,
		onClose: onClose,
	}

	_ = session.pty.Resize(80, 24)

	go session.readFromPTY()
	go session.readFromWebSocket()
	go session.waitForProcess()

	return session, nil
}

// GetConn returns the underlying WebSocket connection for the session.
func (s *Session) GetConn() *websocket.Conn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn
}

// Close terminates the session, cleaning up all resources.
func (s *Session) Close() {
	s.cleanup()
}

func defaultShell() string {
	if runtime.GOOS == "windows" {
		for _, shell := range []string{"pwsh.exe", "powershell.exe", "cmd.exe"} {
			if _, err := exec.LookPath(shell); err == nil {
				return shell
			}
		}
		return "cmd.exe"
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}
	if _, err := exec.LookPath(shell); err != nil {
		shell = "/bin/sh"
	}
	return shell
}

// parseResizeMessage parses a resize message from a WebSocket binary message.
// Format: 0x01 + 2 bytes rows (big-endian) + 2 bytes cols (big-endian).
// Returns rows, cols, and whether the message was valid.
func parseResizeMessage(data []byte) (rows, cols uint16, ok bool) {
	if len(data) < 5 || data[0] != 0x01 {
		return 0, 0, false
	}
	rows = uint16(data[1])<<8 | uint16(data[2])
	cols = uint16(data[3])<<8 | uint16(data[4])
	return rows, cols, true
}

func (s *Session) readFromPTY() {
	defer s.cleanup()
	buf := make([]byte, 32*1024)
	for {
		n, err := s.pty.Read(buf)
		if err != nil {
			if err == io.EOF {
				return
			}
			return
		}
		if n > 0 {
			s.mu.Lock()
			if s.conn != nil && !s.closed {
				_ = s.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				_ = s.conn.WriteMessage(websocket.BinaryMessage, buf[:n])
				_ = s.conn.SetWriteDeadline(time.Time{})
			}
			s.mu.Unlock()
		}
	}
}

func (s *Session) readFromWebSocket() {
	defer s.cleanup()
	for {
		msgType, data, err := s.conn.ReadMessage()
		if err != nil {
			return
		}

		switch msgType {
		case websocket.TextMessage:
			s.mu.Lock()
			if s.pty != nil && !s.closed {
				_, _ = s.pty.Write([]byte(data))
			}
			s.mu.Unlock()
		case websocket.BinaryMessage:
			if rows, cols, ok := parseResizeMessage(data); ok {
				s.mu.Lock()
				if s.pty != nil && !s.closed {
					_ = s.pty.Resize(int(cols), int(rows))
				}
				s.mu.Unlock()
			}
		}
	}
}

func (s *Session) waitForProcess() {
	_ = s.cmd.Wait()
	s.cleanup()
}

func (s *Session) cleanup() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	if s.cancel != nil {
		s.cancel()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		killProcessGroup(s.cmd.Process.Pid)
	}
	if s.pty != nil {
		// Run Close in a goroutine because ConPTY's ClosePseudoConsole can
		// deadlock indefinitely on Windows if the child process was force-killed.
		// recover guards against panics from the underlying PTY implementation
		// so a failed Close never crashes the process.
		go func(p pty.Pty) {
			defer func() { _ = recover() }()
			_ = p.Close()
		}(s.pty)
	}
	if s.conn != nil {
		_ = s.conn.Close()
	}
	s.mu.Unlock()

	if s.onClose != nil {
		s.onClose()
	}
}
