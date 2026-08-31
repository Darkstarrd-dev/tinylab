package sse

import (
	"encoding/json"
	"testing"
)

// TestAppendVersion verifies the version field is injected into a marshalled
// top-level JSON object (review Bug1/U1 version-lag compensation), and that
// non-object payloads are passed through untouched.
func TestAppendVersion(t *testing.T) {
	// Typical RequestEvent JSON: top-level object without a version member.
	data := []byte(`{"type":"request-start","id":"r1","entry":{"inputTokens":10}}`)
	out := appendVersion(data, 7)

	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("appendVersion output is not valid JSON: %v\nraw: %s", err, out)
	}
	if m["version"] != float64(7) {
		t.Fatalf("expected version=7, got %v (raw: %s)", m["version"], out)
	}
	if m["type"] != "request-start" {
		t.Fatalf("type field lost after appendVersion: %s", out)
	}
	if m["entry"] == nil {
		t.Fatalf("entry field lost after appendVersion: %s", out)
	}
}

// TestAppendVersion_NonObject passthrough: a payload that is not a JSON object
// (should not happen for RequestEvent, but must not corrupt anything).
func TestAppendVersion_NonObject(t *testing.T) {
	data := []byte(`"bare"`)
	out := appendVersion(data, 3)
	if string(out) != string(data) {
		t.Fatalf("non-object payload should be passed through untouched, got %s", out)
	}

	empty := appendVersion([]byte{}, 3)
	if len(empty) != 0 {
		t.Fatalf("empty payload should stay empty, got %s", empty)
	}
}
