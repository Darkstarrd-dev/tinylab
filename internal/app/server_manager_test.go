package app

import (
	"context"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
)

func findFreePort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to find free port: %v", err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

func httpGet(t *testing.T, url string) (int, string) {
	t.Helper()
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return 0, err.Error()
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func TestServerManager_StartAndServe(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("hello"))
	})
	logger := console.New(100)
	addr := findFreePort(t)

	sm := NewServerManager(handler, addr, logger, config.ServerConfig{})
	sm.Start()

	// Give server time to start
	time.Sleep(200 * time.Millisecond)

	status, body := httpGet(t, "http://"+addr)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	if body != "hello" {
		t.Fatalf("expected body 'hello', got %s", body)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := sm.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
}

func TestServerManager_Restart(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	logger := console.New(100)
	addrA := findFreePort(t)
	addrB := findFreePort(t)

	sm := NewServerManager(handler, addrA, logger, config.ServerConfig{})
	sm.Start()
	time.Sleep(200 * time.Millisecond)

	// Verify addrA serves
	status, _ := httpGet(t, "http://"+addrA)
	if status != http.StatusOK {
		t.Fatalf("expected 200 on addrA before restart, got %d", status)
	}

	// Restart to addrB
	sm.Restart(addrB)
	time.Sleep(200 * time.Millisecond)

	// Verify addrB serves
	status, _ = httpGet(t, "http://"+addrB)
	if status != http.StatusOK {
		t.Fatalf("expected 200 on addrB after restart, got %d", status)
	}

	// Verify addrA is no longer serving
	client := &http.Client{Timeout: 2 * time.Second}
	_, err := client.Get("http://" + addrA)
	if err == nil {
		t.Fatal("expected addrA to be unresponsive after restart")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := sm.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
}

func TestServerManager_Shutdown(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	logger := console.New(100)
	addr := findFreePort(t)

	sm := NewServerManager(handler, addr, logger, config.ServerConfig{})
	sm.Start()
	time.Sleep(200 * time.Millisecond)

	// Shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := sm.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	// Verify port is no longer serving
	client := &http.Client{Timeout: 2 * time.Second}
	_, err := client.Get("http://" + addr)
	if err == nil {
		t.Fatal("expected port to be unresponsive after shutdown")
	}
}

func TestServerManager_Restart_NoExistingServer(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	logger := console.New(100)
	addr := findFreePort(t)

	// Create manager without starting
	sm := NewServerManager(handler, addr, logger, config.ServerConfig{})
	sm.Restart(addr)

	time.Sleep(200 * time.Millisecond)

	status, body := httpGet(t, "http://"+addr)
	if status != http.StatusOK {
		t.Fatalf("expected 200 after restart (no prior server), got %d", status)
	}
	if body != "ok" {
		t.Fatalf("expected body 'ok', got %s", body)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sm.Shutdown(ctx)
}

func TestServerManager_ShutdownWithoutStart(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	logger := console.New(100)

	sm := NewServerManager(handler, "127.0.0.1:9999", logger, config.ServerConfig{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := sm.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown without Start should return nil, got: %v", err)
	}
}

func TestServerManager_RestartMultipleTimes(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	logger := console.New(100)
	addrA := findFreePort(t)
	addrB := findFreePort(t)
	addrC := findFreePort(t)

	sm := NewServerManager(handler, addrA, logger, config.ServerConfig{})
	sm.Start()
	time.Sleep(200 * time.Millisecond)

	// First restart
	sm.Restart(addrB)
	time.Sleep(200 * time.Millisecond)

	status, _ := httpGet(t, "http://"+addrB)
	if status != http.StatusOK {
		t.Fatalf("expected 200 on addrB after first restart, got %d", status)
	}

	// Second restart
	sm.Restart(addrC)
	time.Sleep(200 * time.Millisecond)

	status, _ = httpGet(t, "http://"+addrC)
	if status != http.StatusOK {
		t.Fatalf("expected 200 on addrC after second restart, got %d", status)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sm.Shutdown(ctx)
}

func TestServerManager_SameAddrAfterRestart(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	logger := console.New(100)
	addr := findFreePort(t)

	sm := NewServerManager(handler, addr, logger, config.ServerConfig{})
	sm.Start()
	time.Sleep(200 * time.Millisecond)

	status, _ := httpGet(t, "http://"+addr)
	if status != http.StatusOK {
		t.Fatalf("expected 200 before restart, got %d", status)
	}

	sm.Restart(addr)
	time.Sleep(200 * time.Millisecond)

	status, _ = httpGet(t, "http://"+addr)
	if status != http.StatusOK {
		t.Fatalf("expected 200 after restart on same addr, got %d", status)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sm.Shutdown(ctx)
}
