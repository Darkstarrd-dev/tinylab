package jethub

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// TestAccioStreamToolShardsAndUsage: 上游把一次工具调用拆成多帧（首帧无参数、
// 后续帧重复完整 args_json）——合并必须取最后一份完整参数，且首帧的 `{}`
// 不得泄漏；终帧的 usage/finish 不得丢（「思考一下就中断」的根因）。
func TestAccioStreamToolShardsAndUsage(t *testing.T) {
	conv := newAccioStreamConverter("accio", true)
	lines := []string{
		`data: {"content":{"role":"assistant","parts":[{"text":"working"}]}}`,
		`data: {"content":{"role":"assistant","parts":[{"function_call":{"id":"call-1","name":"read_file"}}]}}`,
		`data: {"content":{"role":"assistant","parts":[{"function_call":{"id":"call-1","args_json":"{\"path\":\"a\""}}]}}`,
		`data: {"content":{"role":"assistant","parts":[{"function_call":{"id":"call-1","args_json":"{\"path\":\"a\",\"limit\":1}"}}]}}`,
		`data: {"usage_metadata":{"prompt_token_count":7,"candidates_token_count":9,"total_token_count":16},"finish_reason":"MAX_TOKENS"}`,
	}
	var frames []string
	for _, line := range lines {
		frames = append(frames, conv.feedLine(line)...)
	}
	frames = append(frames, conv.terminalFrames()...)
	out := strings.Join(frames, "")

	// 文本先发；工具调用在后续帧收尾前出现（流序保持）。
	if !strings.Contains(out, `"content":"working"`) {
		t.Fatalf("text delta lost: %s", out)
	}
	// 合并后的完整参数必须出现；首帧空参数不得单独成帧。
	if !strings.Contains(out, `"arguments":"{\"path\":\"a\",\"limit\":1}"`) {
		t.Fatalf("tool shard merge broken: %s", out)
	}
	if strings.Count(out, `"tool_calls"`) != 1 {
		t.Fatalf("one merged tool call expected, got %d: %s", strings.Count(out, `"tool_calls"`), out)
	}
	// 终帧（finish + usage + [DONE]）不能丢。
	if !strings.Contains(out, `"finish_reason":"length"`) {
		t.Fatalf("finish frame missing: %s", out)
	}
	if !strings.Contains(out, `"total_tokens":16`) {
		t.Fatalf("usage lost: %s", out)
	}
	if !strings.HasSuffix(out, "data: [DONE]\n\n") {
		t.Fatalf("terminator missing: %q", out)
	}
}

// TestAccioFirstFrame402IsBillingLock: 流内 402 必须在 peek 首帧阶段整体失败，
// 且按计费锁（而不是通用重试）分类；`error_code:200` 是成功哨兵，不得误判。
func TestAccioFirstFrame402IsBillingLock(t *testing.T) {
	sse := "data: {\"error_code\":\"402\",\"error_message\":\"quota exceeded\"}\n\n"
	req, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1/v1/chat/completions", nil)
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(sse)),
	}
	m := newTestManager(t).m
	_, _, err := m.accioInterceptResponse(req, resp, "accio", true)
	var lock *upstreamerr.BillingLockError
	if !errors.As(err, &lock) {
		t.Fatalf("in-stream 402 must map to BillingLockError, got %v", err)
	}
	if lock.Until.IsZero() {
		t.Fatal("billing lock must carry the reset deadline")
	}

	// 成功哨兵：error_code 200 不是错误帧。
	if _, _, ok := accioFrameError(map[string]any{"error_code": "200"}); ok {
		t.Fatal("error_code:200 is the success sentinel, not an error")
	}
}

// TestAccioAggregateSSEEmptyIsExplicit: 无任何内容块必须显式报错（静默空回复
// 比报错更糟）；成功哨兵帧不得触发该错误。
func TestAccioAggregateSSEEmptyIsExplicit(t *testing.T) {
	if _, err := accioAggregateSSE(strings.NewReader("data: {\"error_code\":\"200\"}\n\n"), true, "accio"); err == nil {
		t.Fatal("empty stream must fail explicitly")
	}
	body, err := accioAggregateSSE(strings.NewReader("data: {\"content\":{\"parts\":[{\"text\":\"hi\"}]}}\n\n"), true, "accio")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"content":"hi"`) {
		t.Fatalf("aggregate content lost: %s", body)
	}
}

// TestMergeAccioToolArgs: 前缀链 ⇒ 取最后一份完整参数；否则依次拼接。
func TestMergeAccioToolArgs(t *testing.T) {
	if got := mergeAccioToolArgs([]string{`{"a":1`, `{"a":1,"b":2}`}); got != `{"a":1,"b":2}` {
		t.Fatalf("cumulative shards must keep the last snapshot: %s", got)
	}
	if got := mergeAccioToolArgs([]string{"{\"a\":", "1}"}); got != `{"a":1}` {
		t.Fatalf("incremental shards must concatenate: %s", got)
	}
	if got := mergeAccioToolArgs([]string{"", ""}); got != "" {
		t.Fatalf("empty shards must produce empty args, got %q", got)
	}
}
