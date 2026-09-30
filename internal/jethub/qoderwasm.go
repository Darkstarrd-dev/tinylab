package jethub

import (
	"context"
	_ "embed"
	"fmt"
	"sync"

	"github.com/tetratelabs/wazero"
)

// qoderAuthWASM is the qoder-auth-wasm.wasm (wasm-bindgen product, 298 KB)
// copied verbatim from the reference plugin (P1.8). It encrypts/signs Qoder
// inference request bodies. The full wasm-bindgen bridge lands in P3.4;
// P1 only embeds the binary and smoke-tests module compilation.
//
//go:embed qoder_auth_wasm.wasm
var qoderAuthWASM []byte

// wasmOnce guards one-time runtime/module compilation; wazero compiled
// modules are safe for concurrent instantiation.
var (
	wasmMu      sync.Mutex
	wasmRuntime wazero.Runtime
	wasmModule  wazero.CompiledModule
)

// CompileQoderModule lazily compiles the embedded WASM module and returns the
// compiled module. The runtime is process-lifetime; no explicit close (the
// app owns process shutdown).
func CompileQoderModule(ctx context.Context) (wazero.CompiledModule, error) {
	wasmMu.Lock()
	defer wasmMu.Unlock()
	if wasmModule != nil {
		return wasmModule, nil
	}
	if wasmRuntime == nil {
		wasmRuntime = wazero.NewRuntime(ctx)
	}
	mod, err := wasmRuntime.CompileModule(ctx, qoderAuthWASM)
	if err != nil {
		return nil, fmt.Errorf("jethub: compile qoder wasm: %w", err)
	}
	wasmModule = mod
	return mod, nil
}

// QoderWASMSize reports the embedded WASM binary size (diagnostics).
func QoderWASMSize() int { return len(qoderAuthWASM) }
