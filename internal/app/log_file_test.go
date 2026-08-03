package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteErrorLog_Overwrite(t *testing.T) {
	dir := t.TempDir()

	// First write
	writeErrorLog(dir, "first error message")
	logPath := filepath.Join(dir, errorLogName)

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("failed to read error log after first write: %v", err)
	}
	if !strings.Contains(string(data), "first error message") {
		t.Errorf("first write: expected to contain 'first error message', got: %s", string(data))
	}

	// Second write — should overwrite, not append
	writeErrorLog(dir, "second error message")
	data, err = os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("failed to read error log after second write: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "second error message") {
		t.Errorf("second write: expected to contain 'second error message', got: %s", content)
	}
	if strings.Contains(content, "first error message") {
		t.Errorf("second write should have overwritten, but both messages present: %s", content)
	}
}

func TestWriteErrorLog_EmptyConfigDir(t *testing.T) {
	// Should not panic or create a file
	writeErrorLog("", "test message")
	// No assertion needed — just ensure no crash
}

func TestClearErrorLog(t *testing.T) {
	dir := t.TempDir()

	// Write then clear
	writeErrorLog(dir, "test message")
	logPath := filepath.Join(dir, errorLogName)

	// Verify file exists
	if _, err := os.Stat(logPath); os.IsNotExist(err) {
		t.Fatal("error log file should exist after write")
	}

	clearErrorLog(dir)

	// Verify file is gone
	if _, err := os.Stat(logPath); !os.IsNotExist(err) {
		t.Errorf("error log file should be removed after clear, but it still exists")
	}
}

func TestClearErrorLog_NoFile(t *testing.T) {
	// Clearing a non-existent file should not error
	dir := t.TempDir()
	clearErrorLog(dir)
	// No assertion needed — just ensure no crash
}

func TestWriteErrorLog_Format(t *testing.T) {
	dir := t.TempDir()
	writeErrorLog(dir, "启动失败: 端口被占用")

	logPath := filepath.Join(dir, errorLogName)
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("failed to read error log: %v", err)
	}

	content := string(data)
	// Should have a timestamp prefix like "2026/07/19 09:11:24 "
	if len(content) < 20 {
		t.Fatalf("log content too short: %q", content)
	}
	// Check timestamp format: YYYY/MM/DD HH:MM:SS
	if content[4] != '/' || content[7] != '/' {
		t.Errorf("expected timestamp format YYYY/MM/DD, got prefix: %q", content[:10])
	}
	if !strings.Contains(content, "启动失败: 端口被占用") {
		t.Errorf("expected message in log, got: %q", content)
	}
}
