package jethub

import (
	"context"
	"strings"
	"testing"
)

// TestQoderWasmInstantiateAndAuthFields validates the full glue against the
// REAL embedded binary: instantiate + object heap + string layout +
// generate_runtime_auth_fields (the entry the encrypted-inference chain uses).
func TestQoderWasmInstantiateAndAuthFields(t *testing.T) {
	g, err := buildQoderGlue(context.Background())
	if err != nil {
		t.Fatalf("instantiate: %v", err)
	}
	if g == nil {
		t.Fatal("glue nil")
	}
	// 对象堆哨兵：前 1024 个 undefined + 4 个哨兵（与官方 wW 一致）。
	// ⚠️ null（1025）必须是独立哨兵——JS 里 null !== undefined，探测链按
	// 严格相等比较，混用会让 is_undefined 判错。
	// ⚠️ 总长可以 > 1028：其他测试先用了单例 glue、推入了运行期对象。
	if len(g.objects) < 1028 || g.firstFree < 1028 {
		t.Fatalf("object heap shape: len=%d firstFree=%d", len(g.objects), g.firstFree)
	}
	if g.heapObject(1027) != false || g.heapObject(1026) != true || g.heapObject(1024) != nil {
		t.Fatalf("sentinels wrong: %v %v %v", g.heapObject(1027), g.heapObject(1026), g.heapObject(1024))
	}
	if _, isNull := g.heapObject(1025).(*qoderWasmNull); !isNull {
		t.Fatalf("null sentinel missing at 1025: %v", g.heapObject(1025))
	}

	// generate_runtime_auth_fields（字符串返回值布局 A）。
	payload := `{"uid":"uid-9","security_oauth_token":"qtok","organization_id":"","organization_tags":[],"data_policy_agreed":false}`
	fields, err := g.generateRuntimeAuthFields(payload)
	if err != nil {
		t.Fatalf("generate_runtime_auth_fields: %v", err)
	}
	if fields == nil || fields.EncryptUserInfo == "" || fields.Key == "" {
		t.Fatalf("auth fields empty: %+v", fields)
	}
}

// TestQoderWasmObjectHeapRecycling exercises push/take recycling.
func TestQoderWasmObjectHeapRecycling(t *testing.T) {
	g := &qoderGlue{}
	g.objects = make([]any, 1024)
	g.objects = append(g.objects, nil, nil, true, false)
	g.firstFree = len(g.objects)

	i1 := g.pushObject("a")
	i2 := g.pushObject("b")
	if g.heapObject(i1) != "a" || g.heapObject(i2) != "b" {
		t.Fatal("push/read broken")
	}
	// take 回收非哨兵槽位。
	v := g.takeObject(i1)
	if v != "a" {
		t.Fatalf("take broken: %v", v)
	}
	i3 := g.pushObject("c")
	if i3 != i1 {
		t.Fatalf("recycled slot expected: %d vs %d", i3, i1)
	}
	// 哨兵不可回收。
	_ = g.takeObject(1026)
	i4 := g.pushObject("d")
	if i4 == 1026 {
		t.Fatal("sentinel slots must not be recycled")
	}
}

// TestQoderWasmStringLayoutRoundTrip validates writeString/callString against
// a wasm round trip via generate_runtime_auth_fields' JSON parse (the output
// must be valid JSON, proving the string layout A read is byte-accurate).
func TestQoderWasmStringLayoutRoundTrip(t *testing.T) {
	g, err := buildQoderGlue(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// 大载荷（2KB uid）经 write → call → read 的完整往返。
	big := strings.Repeat("x", 2048)
	fields, err := g.generateRuntimeAuthFields(
		`{"uid":"`+big+`","security_oauth_token":"t"}`)
	if err != nil {
		t.Fatalf("big payload round trip: %v", err)
	}
	// ⚠️ 必须校验内容非空：`{}` 也能 Unmarshal 成功，会掩盖布局读错。
	if fields == nil || fields.EncryptUserInfo == "" || fields.Key == "" {
		t.Fatalf("round trip fields empty: %+v", fields)
	}
}
