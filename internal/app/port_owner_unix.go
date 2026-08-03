//go:build !windows

package app

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// PortOwner describes the process that owns a port.
type PortOwner struct {
	PID          int
	Name         string // process name
	Path         string // full executable path
	IsTinyRouter bool   // name or path contains "tinyrouter" / "tr-pg"
}

// identifyPortOwner attempts to discover the process listening on a given TCP
// port. It uses lsof -i, falling back to ss -tlnp if lsof is not available.
// Returns (PortOwner{}, false) if the port is free or the query fails.
func identifyPortOwner(port int) (PortOwner, bool) {
	// Try lsof first (most portable)
	owner, ok := identifyWithLsof(port)
	if ok {
		return owner, true
	}

	// Fallback to ss (common on Linux without lsof)
	owner, ok = identifyWithSS(port)
	if ok {
		return owner, true
	}

	return PortOwner{}, false
}

func identifyWithLsof(port int) (PortOwner, bool) {
	cmd := exec.Command("lsof", "-i", fmt.Sprintf(":%d", port), "-sTCP:LISTEN", "-F", "pfn")
	out, err := cmd.Output()
	if err != nil || len(out) == 0 {
		return PortOwner{}, false
	}

	lines := strings.Split(string(out), "\n")
	var pid int
	var name, path string

	for i := 0; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if strings.HasPrefix(line, "p") {
			pid, _ = strconv.Atoi(line[1:])
		} else if strings.HasPrefix(line, "f") {
			// file descriptor, skip
		} else if strings.HasPrefix(line, "n") {
			path = line[1:]
		}
	}

	if pid == 0 {
		// Try parsing "COMMAND PID ..." format from -F pfn output didn't work
		// Fall back to standard output parsing
		return identifyWithLsofStandard(port)
	}

	return makeOwner(pid, name, path)
}

func identifyWithLsofStandard(port int) (PortOwner, bool) {
	cmd := exec.Command("lsof", "-i", fmt.Sprintf(":%d", port), "-sTCP:LISTEN")
	out, err := cmd.Output()
	if err != nil || len(out) == 0 {
		return PortOwner{}, false
	}

	lines := strings.Split(string(out), "\n")
	if len(lines) < 2 {
		return PortOwner{}, false
	}

	// Skip header line, parse first data line
	for _, line := range lines[1:] {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 9 {
			name := fields[0]
			pid, _ := strconv.Atoi(fields[1])
			path := strings.Join(fields[8:], " ")
			return makeOwner(pid, name, path)
		}
	}
	return PortOwner{}, false
}

func identifyWithSS(port int) (PortOwner, bool) {
	cmd := exec.Command("ss", "-tlnp", fmt.Sprintf("sport = :%d", port))
	out, err := cmd.Output()
	if err != nil || len(out) == 0 {
		return PortOwner{}, false
	}

	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "State") || strings.HasPrefix(line, "Netid") {
			continue
		}
		// Parse: LISTEN 0 128 127.0.0.1:20128 users:(("tinyrouter",pid=1234,fd=5))
		pidIdx := strings.Index(line, "pid=")
		if pidIdx < 0 {
			continue
		}
		pidEnd := strings.Index(line[pidIdx:], ",")
		if pidEnd < 0 {
			pidEnd = strings.Index(line[pidIdx:], ")")
		}
		if pidEnd < 0 {
			continue
		}
		pidStr := line[pidIdx+4 : pidIdx+pidEnd]
		pid, _ := strconv.Atoi(pidStr)

		// Extract process name from users:(("name",...
		nameStart := strings.Index(line, `("`)
		var name string
		if nameStart >= 0 {
			nameEnd := strings.Index(line[nameStart+2:], `"`)
			if nameEnd >= 0 {
				name = line[nameStart+2 : nameStart+2+nameEnd]
			}
		}

		return makeOwner(pid, name, "")
	}
	return PortOwner{}, false
}

func makeOwner(pid int, name, path string) (PortOwner, bool) {
	isTR := false
	lower := strings.ToLower(name)
	if strings.Contains(lower, "tinyrouter") || strings.Contains(lower, "tr-pg") {
		isTR = true
	}
	if !isTR {
		lower = strings.ToLower(path)
		if strings.Contains(lower, "tinyrouter") || strings.Contains(lower, "tr-pg") {
			isTR = true
		}
	}
	return PortOwner{PID: pid, Name: name, Path: path, IsTinyRouter: isTR}, true
}
