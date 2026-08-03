//go:build windows

package app

import (
	"fmt"
	"os/exec"
	"strings"
)

// PortOwner describes the process that owns a port.
type PortOwner struct {
	PID          int
	Name         string // process name (e.g. "tinyrouter.exe", "node.exe")
	Path         string // full executable path
	IsTinyRouter bool   // name or path contains "tinyrouter" / "tr-pg"
}

// identifyPortOwner attempts to discover the process listening on a given TCP
// port. On Windows it uses PowerShell Get-NetTCPConnection + Get-Process.
// Returns (PortOwner{}, false) if the port is free or the query fails.
func identifyPortOwner(port int) (PortOwner, bool) {
	// Step 1: find the owning PID via Get-NetTCPConnection
	psCmd := fmt.Sprintf(`Get-NetTCPConnection -LocalPort %d -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`, port)
	pidBytes, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", psCmd).Output()
	if err != nil || len(pidBytes) == 0 {
		return PortOwner{}, false
	}

	pidStr := strings.TrimSpace(string(pidBytes))
	if pidStr == "" {
		return PortOwner{}, false
	}

	var pid int
	if _, err := fmt.Sscanf(pidStr, "%d", &pid); err != nil || pid == 0 {
		return PortOwner{}, false
	}

	// Step 2: get process name and path via Get-Process
	psCmd2 := fmt.Sprintf(`Get-Process -Id %d -ErrorAction SilentlyContinue | Select-Object ProcessName,Path | ConvertTo-Json`, pid)
	infoBytes, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", psCmd2).Output()
	if err != nil || len(infoBytes) == 0 {
		// PID found but process info unavailable — return what we have.
		return PortOwner{PID: pid, Name: fmt.Sprintf("PID %d", pid)}, true
	}

	info := string(infoBytes)
	name := extractJSONValue(info, "ProcessName")
	path := extractJSONValue(info, "Path")

	isTR := false
	if name != "" {
		lower := strings.ToLower(name)
		if strings.Contains(lower, "tinyrouter") || strings.Contains(lower, "tr-pg") {
			isTR = true
		}
	}
	if !isTR && path != "" {
		lower := strings.ToLower(path)
		if strings.Contains(lower, "tinyrouter") || strings.Contains(lower, "tr-pg") {
			isTR = true
		}
	}

	return PortOwner{PID: pid, Name: name, Path: path, IsTinyRouter: isTR}, true
}

// extractJSONValue is a minimal JSON value extractor for PowerShell output.
// It finds "key": "value" or "key": value (unquoted numbers) in a JSON blob.
func extractJSONValue(json, key string) string {
	marker := fmt.Sprintf(`"%s"`, key)
	idx := strings.Index(json, marker)
	if idx < 0 {
		return ""
	}
	// Find the colon after the key
	colonIdx := strings.Index(json[idx+len(marker):], ":")
	if colonIdx < 0 {
		return ""
	}
	start := idx + len(marker) + colonIdx + 1
	// Skip whitespace
	for start < len(json) && (json[start] == ' ' || json[start] == '\t' || json[start] == '\r' || json[start] == '\n') {
		start++
	}
	if start >= len(json) {
		return ""
	}
	if json[start] == '"' {
		// Quoted string
		start++
		end := start
		for end < len(json) && json[end] != '"' {
			if json[end] == '\\' {
				end++ // skip escaped char
			}
			end++
		}
		if end > start {
			return json[start:end]
		}
		return ""
	}
	// Unquoted value (number, null)
	end := start
	for end < len(json) && json[end] != ',' && json[end] != '}' && json[end] != '\n' && json[end] != '\r' {
		end++
	}
	return strings.TrimSpace(json[start:end])
}
