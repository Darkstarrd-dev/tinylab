package textreview

import (
	"encoding/json"
	"testing"
)

// TestBuildRequestBodyReasoningToggle locks the wire contract of the node
// Reasoning switch: true → reasoning_effort "medium"; false → explicit
// reasoning_effort "none". Omitting the field on false leaves llama.cpp-class
// servers on their template default (thinking ON), which is the reported
// "Reasoning 关闭时仍然思考" bug. Neither branch may emit the nonstandard
// top-level enable_thinking (ignored by llama.cpp).
func TestBuildRequestBodyReasoningToggle(t *testing.T) {
	on, err := buildRequestBody("m", "sys", "content", true)
	if err != nil {
		t.Fatal(err)
	}
	var onBody map[string]any
	if err := json.Unmarshal(on, &onBody); err != nil {
		t.Fatal(err)
	}
	if got := onBody["reasoning_effort"]; got != "medium" {
		t.Errorf("reasoning=true: reasoning_effort = %v, want medium", got)
	}
	if _, ok := onBody["enable_thinking"]; ok {
		t.Error("reasoning=true: top-level enable_thinking must not be sent")
	}

	off, err := buildRequestBody("m", "sys", "content", false)
	if err != nil {
		t.Fatal(err)
	}
	var offBody map[string]any
	if err := json.Unmarshal(off, &offBody); err != nil {
		t.Fatal(err)
	}
	if got := offBody["reasoning_effort"]; got != "none" {
		t.Errorf("reasoning=false: reasoning_effort = %v, want none", got)
	}
	if _, ok := offBody["enable_thinking"]; ok {
		t.Error("reasoning=false: top-level enable_thinking must not be sent")
	}
}

// TestBuildBatchRequestBodyReasoningToggle covers the multi-chapter batch path
// (node BatchChars > 0), which builds its own request body.
func TestBuildBatchRequestBodyReasoningToggle(t *testing.T) {
	batch := []BatchChapter{{Key: "0", Content: "c1"}, {Key: "1", Content: "c2"}}

	on, err := buildBatchRequestBody("m", "sys", batch, true)
	if err != nil {
		t.Fatal(err)
	}
	var onBody map[string]any
	if err := json.Unmarshal(on, &onBody); err != nil {
		t.Fatal(err)
	}
	if got := onBody["reasoning_effort"]; got != "medium" {
		t.Errorf("batch reasoning=true: reasoning_effort = %v, want medium", got)
	}

	off, err := buildBatchRequestBody("m", "sys", batch, false)
	if err != nil {
		t.Fatal(err)
	}
	var offBody map[string]any
	if err := json.Unmarshal(off, &offBody); err != nil {
		t.Fatal(err)
	}
	if got := offBody["reasoning_effort"]; got != "none" {
		t.Errorf("batch reasoning=false: reasoning_effort = %v, want none", got)
	}
}