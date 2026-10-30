package jethub

// Cline 默认输出预算（ref 0eeea3c）：缺 max_tokens 时网关缺省 4096 会静默截断。

import (
	"encoding/json"
	"testing"
)

func TestClineDefaultMaxTokens(t *testing.T) {
	cases := []struct {
		model string
		want  float64
	}{
		{"cline-free/minimax-m3.1-flash", 131072},
		{"cline-free/mimo-v2.6-flash", 131072},
		{"stealth/space-bunny-alpha", 524288},
		{"cline-free/muse-spark-1.3-contributor", 943718},
	}
	for _, tc := range cases {
		body := []byte(`{"model":"` + tc.model + `","messages":[{"role":"user","content":"hi"}]}`)
		out := clineApplyDefaultMaxTokens(body, tc.model)
		var parsed map[string]any
		if err := json.Unmarshal(out, &parsed); err != nil {
			t.Fatal(err)
		}
		if got, _ := parsed["max_tokens"].(float64); got != tc.want {
			t.Fatalf("%s max_tokens = %v, want %v (缺省 4096 会静默截断)", tc.model, got, tc.want)
		}
	}

	// 已指定预算（任一字段）⇒ 字节级透传，绝不覆盖用户选择。
	for _, field := range []string{"max_tokens", "max_completion_tokens"} {
		body := []byte(`{"model":"cline-free/minimax-m3.1-flash","` + field + `":4096}`)
		if out := clineApplyDefaultMaxTokens(body, "cline-free/minimax-m3.1-flash"); string(out) != string(body) {
			t.Fatalf("%s present must pass through unchanged, got %s", field, out)
		}
	}
	// 无默认预算表的模型 / 非 JSON / 空 body ⇒ 原样。
	plain := []byte(`{"model":"cline-pass/qwen3.8-max"}`)
	if out := clineApplyDefaultMaxTokens(plain, "cline-pass/qwen3.8-max"); string(out) != string(plain) {
		t.Fatalf("models without a default budget must pass through, got %s", out)
	}
	if out := clineApplyDefaultMaxTokens([]byte("not json"), "cline-free/minimax-m3.1-flash"); string(out) != "not json" {
		t.Fatalf("non-JSON body must pass through, got %s", out)
	}
	if out := clineApplyDefaultMaxTokens(nil, "cline-free/minimax-m3.1-flash"); len(out) != 0 {
		t.Fatalf("nil body must stay nil, got %q", out)
	}
}
