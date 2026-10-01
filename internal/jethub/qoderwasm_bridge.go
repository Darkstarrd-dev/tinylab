package jethub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// Qoder WASM bridge — 1:1 port of ref qoder-wasm.ts (wasm-bindgen glue for
// the embedded qoder_auth_wasm.wasm). NOT cryptanalysis: the WASM exports
// paired encode/decode functions and we call them.
//
// ⚠️ THREE measured traps (AGENTS.md) — all locked by tests:
//  1. the TWO getRandomValues imports have OPPOSITE signatures: one writes
//     wasm memory, one calls a JS object — swapping them Rust-panics
//     `unreachable`;
//  2. return layouts come in TWO shapes: strings carry ptr/len/valIdx/isErr,
//     while qodercontext_new/prepareInferRequest carry ptr/errIdx/isErr —
//     mixing them yields `null pointer passed to rust`;
//  3. requestresult_url(stack, ptr) has the STACK POINTER FIRST — the
//     intuitive order is wrong.
const (
	qoderWasmImportModule = "./qoder_auth_wasm_bg.js"
	qoderCosyVersion      = "1.1.49"
)

// QoderRuntimeAuthFields = generate_runtime_auth_fields output.
type QoderRuntimeAuthFields struct {
	EncryptUserInfo string `json:"encrypt_user_info"`
	Key             string `json:"key"`
}

// QoderWasmUserInfo feeds the WASM context.
type QoderWasmUserInfo struct {
	UID                string
	SecurityOauthToken string
	OrganizationID     string
	OrganizationTags   []string
	DataPolicyAgreed   bool
}

// JS-object stand-ins. The wasm never inspects fields — it only asks type
// questions (via the __wbindgen_is_* imports) and moves bytes through the
// Uint8Array imports, so the behavior lives in the import impls below.
type qoderWasmGlobal struct{ name string }

// qoderWasmCrypto is the stand-in handed out for globalThis.crypto. ⚠️ It
// MUST be a non-undefined object: getrandom's source detection walks
// `globalThis.crypto → globalThis.msCrypto → process/Node`, and finding no
// source makes the Rust side panic — with panic=abort that lands on a bare
// `unreachable` WITHOUT ever reaching __wbindgen_throw (exactly the trap
// this bridge hit first).
type qoderWasmCrypto struct{}

// qoderWasmMap stands in for a JS Map (requestresult_headers builds one and
// fills it through the generic __wbg_set_… import).
type qoderWasmMap struct {
	keys []any
	vals []any
}

func (m *qoderWasmMap) set(key, value any) {
	for i, k := range m.keys {
		if qoderWasmSameKey(k, key) {
			m.vals[i] = value
			return
		}
	}
	m.keys = append(m.keys, key)
	m.vals = append(m.vals, value)
}

// qoderWasmMapPairs extracts the entries of a Map stand-in (headers).
func qoderWasmMapPairs(v any) ([]any, []any) {
	if m, ok := v.(*qoderWasmMap); ok {
		return m.keys, m.vals
	}
	return nil, nil
}

func qoderWasmSameKey(a, b any) bool {
	as, aok := a.(string)
	bs, bok := b.(string)
	if aok && bok {
		return as == bs
	}
	return a == b
}

// qoderWasmNull distinguishes JS `null` from `undefined` (the detection
// chain compares them strictly).
type qoderWasmNull struct{}

var qoderNullSentinel = &qoderWasmNull{}

// qoderWasmAsInt reads a JS-number stand-in.
func qoderWasmAsInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int32:
		return int(n)
	}
	return 0
}

// qoderGlue holds the instantiated module state.
type qoderGlue struct {
	mu        sync.Mutex
	instance  api.Module
	objects   []any // JS-object heap (1024 undefineds + 4 sentinels)
	firstFree int
}

var (
	qoderGlueOnce sync.Once
	qoderGlueRef  *qoderGlue
	qoderGlueErr  error
)

// generateRuntimeAuthFields invokes the WASM export and parses its JSON
// output (the identity fields the server recognizes).
func (g *qoderGlue) generateRuntimeAuthFields(payload string) (*QoderRuntimeAuthFields, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.generateRuntimeAuthFieldsLocked(payload)
}

func (g *qoderGlue) generateRuntimeAuthFieldsLocked(payload string) (*QoderRuntimeAuthFields, error) {
	raw, err := g.callString(func(stack int64) {
		a, aLen := g.writeString(payload)
		if _, callErr := g.instance.ExportedFunction("generate_runtime_auth_fields").Call(
			context.Background(), uint64(uint32(stack)), uint64(uint32(a)), uint64(uint32(aLen))); callErr != nil {
			panic(fmt.Sprintf("wasm call failed: %v", callErr))
		}
	})
	if err != nil {
		return nil, err
	}
	var fields QoderRuntimeAuthFields
	if err := json.Unmarshal([]byte(raw), &fields); err != nil {
		return nil, fmt.Errorf("jethub: wasm auth fields unparsable: %w", err)
	}
	return &fields, nil
}

// qoderRuntimeAuthPayload builds the generate_runtime_auth_fields input
// (ref field set — uid / security_oauth_token / organization_id /
// organization_tags / data_policy_agreed; tags must be [] not null).
func qoderRuntimeAuthPayload(user QoderWasmUserInfo) string {
	tags := user.OrganizationTags
	if tags == nil {
		tags = []string{}
	}
	b, _ := json.Marshal(map[string]any{
		"uid":                  user.UID,
		"security_oauth_token": user.SecurityOauthToken,
		"organization_id":      user.OrganizationID,
		"organization_tags":    tags,
		"data_policy_agreed":   user.DataPolicyAgreed,
	})
	return string(b)
}

// DecryptQoderModelCatalog decrypts the local model-catalog cache via the
// WASM's own model_cache_decrypt (read-only local introspection; the online
// model list stays on the fallback table). ⚠️ machineID is a REQUIRED second
// argument (ref trap: omitting it yields `AES-GCM decrypt failed:
// aead::Error`, which masquerades as corrupt ciphertext).
func (g *qoderGlue) DecryptQoderModelCatalog(encrypted, machineID string) (json.RawMessage, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	raw, err := g.callString(func(stack int64) {
		a, aLen := g.writeString(encrypted)
		b, bLen := g.writeString(machineID)
		if _, callErr := g.instance.ExportedFunction("model_cache_decrypt").Call(
			context.Background(),
			uint64(uint32(stack)),
			uint64(uint32(a)), uint64(uint32(aLen)),
			uint64(uint32(b)), uint64(uint32(bLen))); callErr != nil {
			panic(fmt.Sprintf("wasm call failed: %v", callErr))
		}
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// buildQoderGlue instantiates the embedded WASM with the full import object.
func buildQoderGlue(ctx context.Context) (*qoderGlue, error) {
	qoderGlueOnce.Do(func() {
		g := &qoderGlue{firstFree: -1}
		if err := g.instantiate(ctx); err != nil {
			qoderGlueErr = err
			return
		}
		qoderGlueRef = g
	})
	return qoderGlueRef, qoderGlueErr
}

func (g *qoderGlue) instantiate(ctx context.Context) error {
	r := wazero.NewRuntime(ctx)
	// The full __wbg_* import object (wasm-bindgen convention). The module
	// NAME must match the embedded "./qoder_auth_wasm_bg.js" exactly, or
	// instantiation fails.
	hostModule := r.NewHostModuleBuilder(qoderWasmImportModule)
	for _, fn := range qoderHostFunctions(g) {
		hostModule.NewFunctionBuilder().WithFunc(fn.impl).Export(fn.name)
	}
	if _, err := hostModule.Instantiate(ctx); err != nil {
		return fmt.Errorf("jethub: instantiate qoder host module: %w", err)
	}
	mod, err := r.Instantiate(ctx, qoderAuthWASM)
	if err != nil {
		return fmt.Errorf("jethub: instantiate qoder wasm: %w", err)
	}
	// 对象堆与官方 wW 一致：1024 个 undefined，再 push 四个哨兵
	// （undefined/null/true/false —— null 必须与 undefined 可区分）。
	g.objects = make([]any, 1024)
	g.objects = append(g.objects, nil, qoderNullSentinel, true, false)
	g.firstFree = len(g.objects)
	g.instance = mod
	return nil
}

// qoderHostFunction is one (name, wasm-bindgen import) pair.
type qoderHostFunction struct {
	name string
	impl any
}

// qoderHostFunctions builds the import table against this glue. The TWO
// getRandomValues layouts are preserved verbatim (TRAP 1):
//   - d49329ff89a07af1(ptr, len) WRITES wasm memory;
//   - c44a50d8cfdaebeb(objIdx, argIdx) CALLS the JS object.
//
// Swapping them Rust-panics `unreachable`.
func qoderHostFunctions(g *qoderGlue) []qoderHostFunction {
	return []qoderHostFunction{
		{"__wbindgen_object_drop_ref", func(i int32) { g.takeObject(i) }},
		{"__wbindgen_object_clone_ref", func(i int32) int32 { return g.pushObject(g.heapObject(i)) }},
		{"__wbindgen_cast_0000000000000001", func(a, e int32) int32 {
			return g.pushObject(g.wasmBytes(a, e))
		}},
		{"__wbindgen_cast_0000000000000002", func(a, e int32) int32 {
			return g.pushObject(g.readString(a, e))
		}},
		{"__wbg_set_08463b1df38a7e29", func(a, e, t int32) int32 {
			// ref: pushObject(heapObject(a).set(heapObject(e), heapObject(t)))
			// — the GENERIC .set method on the RECEIVER object: Map.set(key,
			// value) for the headers map, Uint8Array.set(source, offset) for
			// byte arrays. Both return the receiver, which is what gets
			// pushed.
			recv := g.heapObject(a)
			switch target := recv.(type) {
			case *qoderWasmMap:
				target.set(g.heapObject(e), g.heapObject(t))
			case []byte:
				src, _ := g.heapObject(e).([]byte)
				off := qoderWasmAsInt(g.heapObject(t))
				if off >= 0 && off <= len(target) {
					copy(target[off:], src)
				}
			}
			return g.pushObject(recv)
		}},
		// TRAP 1: opposite-direction signatures.
		{"__wbg_getRandomValues_d49329ff89a07af1", func(a, e int32) {
			g.guarded(func() { g.cryptoGetRandom(a, e) })
		}},
		{"__wbg_getRandomValues_c44a50d8cfdaebeb", func(a, e int32) {
			g.guarded(func() { g.objectGetRandom(a, e) })
		}},
		{"__wbg_crypto_38df2bab126b63dc", func(a int32) int32 {
			return g.pushObject(g.getProperty(a, "crypto"))
		}},
		{"__wbg_process_44c7a14e11e9f69e", func(a int32) int32 {
			return g.pushObject(g.getProperty(a, "process"))
		}},
		{"__wbg_versions_276b2795b1c6a219", func(a int32) int32 {
			return g.pushObject(g.getProperty(a, "versions"))
		}},
		{"__wbg_node_84ea875411254db1", func(a int32) int32 {
			return g.pushObject(g.getProperty(a, "node"))
		}},
		{"__wbg_require_b4edbdcf3e2a1ef0", func() int32 {
			return g.pushObject(nil) // module require: no JS module system here
		}},
		{"__wbg_msCrypto_bd5a034af96bcba6", func(a int32) int32 {
			return g.pushObject(g.getProperty(a, "msCrypto"))
		}},
		{"__wbg_randomFillSync_6c25eac9869eb53c", func(a, e int32) {
			g.guarded(func() {
				// ref: heapObject(a).randomFillSync(takeObject(e)) — fill the
				// TAKEN object's backing bytes with randomness.
				_ = a
				if buf, ok := g.takeObject(e).([]byte); ok {
					_, _ = rand.Read(buf)
				}
			})
		}},
		{"__wbg_call_d578befcc3145dee", func(fn, self, arg int32) int32 {
			var out int32
			g.guarded(func() { out = g.pushObject(g.callMethod(fn, self, arg)) })
			return out
		}},
		{"__wbg_new_with_length_9cedd08484b73942", func(a int32) int32 {
			return g.pushObject(make([]byte, a))
		}},
		{"__wbg_length_0c32cb8543c8e4c8", func(a int32) int32 {
			if buf, ok := g.heapObject(a).([]byte); ok {
				return int32(len(buf))
			}
			return 0
		}},
		{"__wbg_prototypesetcall_3e05eb9545565046", func(a, e, t int32) {
			// ref: Uint8Array.prototype.set.call(wasmView(a, a+e), heapObject(t))
			// — copies the OBJECT's bytes INTO wasm memory [a, a+e). The old
			// implementation copied into a throwaway read-back buffer, which
			// silently dropped the data.
			data, ok := g.heapObject(t).([]byte)
			if !ok || e <= 0 {
				return
			}
			n := int(e)
			if n > len(data) {
				n = len(data)
			}
			_ = g.instance.Memory().Write(uint32(a), data[:n])
		}},
		{"__wbg_subarray_0f98d3fb634508ad", func(a, e, t int32) int32 {
			// ref: pushObject(heapObject(a).subarray(e, t)) — the receiver is
			// a heap OBJECT (byte holder); the bounds are raw i32 (JS
			// subarray semantics: negative counts from the end).
			data, ok := g.heapObject(a).([]byte)
			if !ok {
				return g.pushObject(make([]byte, 0))
			}
			start, end := int(e), int(t)
			if start < 0 {
				start = len(data) + start
			}
			if end < 0 {
				end = len(data) + end
			}
			if start < 0 {
				start = 0
			}
			if end > len(data) {
				end = len(data)
			}
			if start > end {
				start = end
			}
			return g.pushObject(append([]byte(nil), data[start:end]...))
		}},
		{"__wbg_new_99cabae501c0a8a0", func() int32 {
			return g.pushObject(&qoderWasmMap{}) // Map stand-in
		}},
		{"__wbg_now_88621c9c9a4f3ffc", func() float64 { return float64(time.Now().UnixMilli()) }},
		{"__wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f", func() int32 {
			// ⚠️ Must be an OBJECT, not a string: the detection chain runs
			// is_object/is_undefined against it.
			return g.pushObject(&qoderWasmGlobal{name: "globalThis"})
		}},
		{"__wbg_static_accessor_GLOBAL_f2e0f995a21329ff", func() int32 {
			return g.pushObject(&qoderWasmGlobal{name: "globalThis"})
		}},
		{"__wbg_static_accessor_SELF_24f78b6d23f286ea", func() int32 { return 0 }},
		{"__wbg_static_accessor_WINDOW_59fd959c540fe405", func() int32 { return 0 }},
		{"__wbg___wbindgen_throw_81fc77679af83bc6", func(p, l int32) {
			message := g.readString(p, l)
			// ⚠️ Rust panics surface here (wasm-bindgen's throw channel).
			// Propagate as a panic carrying the REAL message — wazero converts
			// it into a wasm trap, and the caller's Call returns it as an
			// error; discarding the message would reduce every failure to a
			// bare `unreachable`.
			panic(&qoderWasmThrow{msg: message})
		}},
		{"__wbg_Error_2e59b1b37a9a34c3", func(p, l int32) int32 {
			return g.pushObject(errors.New(g.readString(p, l)))
		}},
		{"__wbg___wbindgen_is_object_40c5a80572e8f9d3", func(i int32) int32 {
			v := g.heapObject(i)
			if v == nil {
				return 0 // undefined
			}
			if _, isStr := v.(string); isStr {
				return 0
			}
			if _, isNull := v.(*qoderWasmNull); isNull {
				return 0 // JS null is not an object here
			}
			return 1
		}},
		{"__wbg___wbindgen_is_string_b29b5c5a8065ba1a", func(i int32) int32 {
			_, isStr := g.heapObject(i).(string)
			if isStr {
				return 1
			}
			return 0
		}},
		{"__wbg___wbindgen_is_function_49868bde5eb1e745", func(i int32) int32 { return 0 }},
		{"__wbg___wbindgen_is_undefined_c0cca72b82b86f4d", func(i int32) int32 {
			if g.heapObject(i) == nil {
				return 1
			}
			return 0
		}},
	}
}

// wasmBytes reads a byte range out of wasm memory (for the cast imports).
func (g *qoderGlue) wasmBytes(ptr, length int32) []byte {
	if length <= 0 {
		return nil
	}
	data, ok := g.instance.Memory().Read(uint32(ptr), uint32(length))
	if !ok {
		return nil
	}
	out := make([]byte, length)
	copy(out, data)
	return out
}

// qoderWasmThrow carries the wasm-side error text through a host-function
// panic (wazero converts the panic into a wasm trap whose message includes
// the thrown text).
type qoderWasmThrow struct{ msg string }

func (e *qoderWasmThrow) Error() string { return "qoder wasm: " + e.msg }

// getProperty returns stand-in property values for the environment-detection
// chain. ⚠️ `crypto` MUST be a non-undefined object: getrandom walks
// `globalThis.crypto → msCrypto → process/Node` and finding no source makes
// the Rust side panic — with panic=abort that lands on a bare `unreachable`
// without ever reaching __wbindgen_throw. We force the BROWSER branch
// (crypto present, Node absent), so the fill lands on the d493 memory import
// which is fully implemented here.
func (g *qoderGlue) getProperty(_ int32, name string) any {
	switch name {
	case "crypto":
		return &qoderWasmCrypto{}
	default:
		return nil
	}
}

// callMethod stands in for fn.call(self, arg).
func (g *qoderGlue) callMethod(fn, self, arg int32) any {
	_ = self
	return g.heapObject(arg)
}

// objectHeap accessors (JS-object ↔ int index).
func (g *qoderGlue) heapObject(index int32) any {
	if index < 0 || int(index) >= len(g.objects) {
		return nil
	}
	return g.objects[index]
}

func (g *qoderGlue) pushObject(value any) int32 {
	if g.firstFree == len(g.objects) {
		g.objects = append(g.objects, int32(len(g.objects)+1))
	}
	index := int32(g.firstFree)
	g.firstFree = int(g.objects[index].(int32))
	g.objects[index] = value
	return index
}

func (g *qoderGlue) takeObject(index int32) any {
	value := g.heapObject(index)
	if index >= 1028 { // sentinels (undefined/null/true/false) are not recycled
		g.objects[index] = int32(g.firstFree)
		g.firstFree = int(index)
	}
	return value
}

// readString reads a wasm-allocated UTF-8 string.
func (g *qoderGlue) readString(ptr, length int32) string {
	if ptr == 0 || length <= 0 {
		return ""
	}
	data, ok := g.instance.Memory().Read(uint32(ptr), uint32(length))
	if !ok {
		return ""
	}
	return string(data)
}

// writeString allocates in wasm memory and returns the pointer; the length
// goes through __wbindgen_export2's return value.
func (g *qoderGlue) writeString(text string) (int32, int32) {
	encoded := []byte(text)
	alloc := g.instance.ExportedFunction("__wbindgen_export2")
	ret, err := alloc.Call(context.Background(), uint64(len(encoded)), 1)
	if err != nil || len(ret) == 0 {
		return 0, 0
	}
	ptr := int32(ret[0])
	if !g.instance.Memory().Write(uint32(ptr), encoded) {
		return 0, 0
	}
	return ptr, int32(len(encoded))
}

// callString invokes a string-returning function: the stack frame carries
// ptr/len/valIdx/isErr (LAYOUT A — trap 2). ⚠️ The string is READ BEFORE the
// wasm allocation is freed (the reference frees in `finally` — reading after
// the free yields an empty string).
func (g *qoderGlue) callString(invoke func(stack int64)) (string, error) {
	sp := g.addStack(-16)
	defer g.addStack(16)
	invoke(sp)
	mem := g.instance.Memory()
	frame, ok := mem.Read(uint32(sp), 16)
	if !ok {
		return "", errors.New("jethub: wasm stack read failed")
	}
	ptr := int32(leInt32(frame[0:4]))
	length := int32(leInt32(frame[4:8]))
	valIdx := int32(leInt32(frame[8:12]))
	isErr := leInt32(frame[12:16])
	if isErr != 0 {
		return "", fmt.Errorf("jethub: wasm error: %v", g.takeObject(valIdx))
	}
	out := g.readString(ptr, length)
	if ptr != 0 {
		g.freeWasm(ptr, length)
	}
	return out, nil
}

// callPointer invokes a pointer-returning function: ptr/errIdx/isErr
// (LAYOUT B — the qodercontext_new/prepareInferRequest shape; trap 2).
func (g *qoderGlue) callPointer(invoke func(stack int64)) (int32, error) {
	sp := g.addStack(-16)
	defer g.addStack(16)
	invoke(sp)
	mem := g.instance.Memory()
	frame, ok := mem.Read(uint32(sp), 16)
	if !ok {
		return 0, errors.New("jethub: wasm stack read failed")
	}
	ptr := int32(leInt32(frame[0:4]))
	errIdx := int32(leInt32(frame[4:8]))
	isErr := leInt32(frame[8:12])
	if isErr != 0 {
		return 0, fmt.Errorf("jethub: wasm error: %v", g.takeObject(errIdx))
	}
	return ptr, nil
}

func (g *qoderGlue) addStack(delta int64) int64 {
	ret, err := g.instance.ExportedFunction("__wbindgen_add_to_stack_pointer").Call(context.Background(), uint64(uint32(delta)))
	if err != nil || len(ret) == 0 {
		return 0
	}
	return int64(ret[0])
}

func (g *qoderGlue) freeWasm(ptr, length int32) {
	_, _ = g.instance.ExportedFunction("__wbindgen_export4").Call(context.Background(), uint64(uint32(ptr)), uint64(uint32(length)), 1)
}

func leInt32(b []byte) uint32 {
	return uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
}

// guarded wraps a host call, pushing thrown errors onto the object heap
// (wasm-bindgen's exception channel).
func (g *qoderGlue) guarded(fn func()) {
	defer func() {
		if r := recover(); r != nil {
			_, _ = g.instance.ExportedFunction("__wbindgen_export").Call(
				context.Background(), uint64(uint32(g.pushObject(r))))
		}
	}()
	fn()
}

// cryptoGetRandom fills wasm memory directly (TRAP 1, layout A).
func (g *qoderGlue) cryptoGetRandom(ptr, length int32) {
	if length <= 0 {
		return
	}
	buf := make([]byte, length)
	if _, err := rand.Read(buf); err != nil {
		// Time-derived fallback (never panic inside a wasm host call).
		now := time.Now().UnixNano()
		for i := range buf {
			buf[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	g.instance.Memory().Write(uint32(ptr), buf)
}

// objectGetRandom fills the taken object's backing bytes (TRAP 1, layout B):
// ref calls heapObject(objIdx).getRandomValues(heapObject(argIdx)) — the
// second object is a Uint8Array stand-in whose bytes the wasm later copies
// out via prototypesetcall. Leaving this a no-op feeds all-zero "randomness".
func (g *qoderGlue) objectGetRandom(objIdx, argIdx int32) {
	_ = objIdx
	if buf, ok := g.heapObject(argIdx).([]byte); ok {
		_, _ = rand.Read(buf)
	}
}

// QoderInferRequest is the prepareInferRequest output (ref QoderInferRequest):
// url / headers / body. ⚠️ headers MUST be passed through verbatim — the
// Authorization is the WASM-generated `Bearer COSY.<载荷>.<签名>`; overwriting
// it with the plain bearer yields 403 Signature invalid.
type QoderInferRequest struct {
	URL     string
	Headers map[string]string
	Body    string
}

// qoderEncryptedInfer is the per-account WASM context (ref QoderEncryptedInfer
// — one instance per account, reused across requests; every call serializes
// on the glue mutex).
type qoderEncryptedInfer struct {
	g       *qoderGlue
	context int32
	host    string
}

// newQoderEncryptedInfer: generate_runtime_auth_fields → qodercontext_new.
// ⚠️ qodercontext_new parameter order (ref): (sp, machineId, len, version,
// len, userInfo, len, clientMeta, len); LAYOUT B return (ptr/errIdx/isErr).
func newQoderEncryptedInfer(user QoderWasmUserInfo, machineID, host string) (*qoderEncryptedInfer, error) {
	g, err := buildQoderGlue(context.Background())
	if err != nil {
		return nil, err
	}
	fields, err := g.generateRuntimeAuthFields(qoderRuntimeAuthPayload(user))
	if err != nil {
		return nil, fmt.Errorf("jethub: qoder runtime auth fields: %w", err)
	}
	tags := user.OrganizationTags
	if tags == nil {
		tags = []string{}
	}
	userInfo, _ := json.Marshal(map[string]any{
		"uid":                user.UID,
		"encrypt_user_info":  fields.EncryptUserInfo,
		"key":                fields.Key,
		"organization_id":    user.OrganizationID,
		"organization_tags":  tags,
		"data_policy_agreed": user.DataPolicyAgreed,
	})
	metaJSON, _ := json.Marshal(qoderClientMetadata)

	g.mu.Lock()
	defer g.mu.Unlock()
	ctxPtr, err := g.callPointer(func(stack int64) {
		machine, machineLen := g.writeString(machineID)
		ver, verLen := g.writeString(qoderCosyVersion)
		info, infoLen := g.writeString(string(userInfo))
		meta, metaLen := g.writeString(string(metaJSON))
		if _, callErr := g.instance.ExportedFunction("qodercontext_new").Call(
			context.Background(), uint64(uint32(stack)),
			uint64(uint32(machine)), uint64(uint32(machineLen)),
			uint64(uint32(ver)), uint64(uint32(verLen)),
			uint64(uint32(info)), uint64(uint32(infoLen)),
			uint64(uint32(meta)), uint64(uint32(metaLen))); callErr != nil {
			panic(fmt.Sprintf("wasm call failed: %v", callErr))
		}
	})
	if err != nil {
		return nil, fmt.Errorf("jethub: qodercontext_new: %w", err)
	}
	return &qoderEncryptedInfer{g: g, context: ctxPtr, host: host}, nil
}

// prepareInfer runs qodercontext_prepareInferRequest and extracts
// url / headers / body from the RequestResult.
// ⚠️ TRAP 3: requestresult_url / requestresult_body take the STACK POINTER
// FIRST — (stack, result), the intuitive (result, stack) is wrong.
func (e *qoderEncryptedInfer) prepareInfer(payloadJSON, modelKey, source string) (*QoderInferRequest, error) {
	g := e.g
	g.mu.Lock()
	defer g.mu.Unlock()
	result, err := g.callPointer(func(stack int64) {
		host, hostLen := g.writeString(e.host)
		body, bodyLen := g.writeString(payloadJSON)
		key, keyLen := g.writeString(modelKey)
		src, srcLen := g.writeString(source)
		if _, callErr := g.instance.ExportedFunction("qodercontext_prepareInferRequest").Call(
			context.Background(), uint64(uint32(stack)), uint64(uint32(e.context)),
			uint64(uint32(host)), uint64(uint32(hostLen)),
			uint64(uint32(body)), uint64(uint32(bodyLen)),
			uint64(uint32(key)), uint64(uint32(keyLen)),
			uint64(uint32(src)), uint64(uint32(srcLen))); callErr != nil {
			panic(fmt.Sprintf("wasm call failed: %v", callErr))
		}
	})
	if err != nil {
		return nil, fmt.Errorf("jethub: prepareInferRequest: %w", err)
	}

	headers := map[string]string{}
	if ret, callErr := g.instance.ExportedFunction("requestresult_headers").Call(
		context.Background(), uint64(uint32(result))); callErr == nil && len(ret) > 0 {
		obj := g.takeObject(int32(ret[0]))
		keys, vals := qoderWasmMapPairs(obj)
		for i := range keys {
			k, _ := keys[i].(string)
			v, _ := vals[i].(string)
			if k != "" {
				headers[k] = v
			}
		}
	}

	// requestresult_url/body: stack-pointer-first string read (no free —
	// mirrors the reference glue; the result strings are owned by the result
	// box whose lifetime matches the per-request window).
	readResultString := func(fnName string) string {
		stack := g.addStack(-16)
		defer g.addStack(16)
		if _, callErr := g.instance.ExportedFunction(fnName).Call(
			context.Background(), uint64(uint32(stack)), uint64(uint32(result))); callErr != nil {
			return ""
		}
		frame, ok := g.instance.Memory().Read(uint32(stack), 16)
		if !ok {
			return ""
		}
		ptr := int32(leInt32(frame[0:4]))
		length := int32(leInt32(frame[4:8]))
		if ptr == 0 {
			return ""
		}
		return g.readString(ptr, length)
	}

	return &QoderInferRequest{
		URL:     readResultString("requestresult_url"),
		Headers: headers,
		Body:    readResultString("requestresult_body"),
	}, nil
}
