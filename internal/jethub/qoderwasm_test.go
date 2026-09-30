package jethub

import (
	"context"
	"strings"
	"testing"
)

// TestCompileQoderModule is the P1.8 smoke test: the embedded 298 KB
// wasm-bindgen binary must compile into a wazero module (validates embed +
// dependency wiring; full host-function bridge lands in P3.4).
func TestCompileQoderModule(t *testing.T) {
	if QoderWASMSize() == 0 {
		t.Fatal("embedded qoder wasm is empty")
	}
	mod, err := CompileQoderModule(context.Background())
	if err != nil {
		t.Fatalf("compile qoder wasm: %v", err)
	}
	// Second call returns the cached compiled module.
	mod2, err := CompileQoderModule(context.Background())
	if err != nil {
		t.Fatalf("compile (cached): %v", err)
	}
	if mod != mod2 {
		t.Fatal("expected cached compiled module")
	}
}

func TestNewAccountIDShape(t *testing.T) {
	id, ref := NewAccountID("codearts")
	if len(id) != len("codearts")+1+8 {
		t.Fatalf("unexpected id shape %q", id)
	}
	if id[:len("codearts")] != "codearts" || id[len("codearts")] != '-' {
		t.Fatalf("id should start with provider-: %q", id)
	}
	wantRef := "CODEARTS_ACCOUNT_" + strings.ToUpper(id[len(id)-8:])
	if ref != wantRef {
		t.Fatalf("credential ref mismatch: %q want %q", ref, wantRef)
	}
}
