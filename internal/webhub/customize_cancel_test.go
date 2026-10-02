package webhub

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// 缺陷 22（2026-10-03 用户实测）：流式回合的 context 被提前取消。
//
// 现场：deepseek 站点 status 已 connected/attached，但一次调用只吐出首帧
// role chunk，紧接着 `{"error":{"message":"context canceled"}}`。
// 根因：InterceptResponse 用 `defer cancel()`，而流式路径在启动 streamTurn
// goroutine 后**立即返回** —— cancel 在返回瞬间生效，goroutine 里 driver 的
// 第一次页面读取就命中已取消的 ctx（客户端看到的就是 role 帧 + 错误帧）。
//
// 本测试固定「cancel 归属」：流式回合的 ctx 必须活到回合结束，不能随
// InterceptResponse 返回而死。
func TestStreamingTurnContextOutlivesInterceptResponse(t *testing.T) {
	m := newTestManager(t)
	b := NewBridge(m, newFakeRegistry())
	d := b.Driver()

	gate := make(chan struct{})
	chatCtx := make(chan context.Context, 1)
	// 替换整个回合：先把自己拿到的 ctx 交给测试，再等 gate 放行，
	// 然后在放行那一刻检查 ctx 是否还活着。
	d.chatHook = func(ctx context.Context, req ChatRequest) (ChatResult, error) {
		chatCtx <- ctx
		<-gate
		if err := ctx.Err(); err != nil {
			return ChatResult{}, err
		}
		if req.OnDelta != nil {
			req.OnDelta("hello")
		}
		return ChatResult{Text: "hello"}, nil
	}

	turn := &turnState{site: "chat.deepseek.com", preset: "", prompt: "hi", model: "chat.deepseek.com", isStream: true}
	tok := turn.token()
	clientReq, err := http.NewRequest(http.MethodPost, "http://127.0.0.1/v1/chat/completions", strings.NewReader(`{"model":"chat.deepseek.com","messages":[{"role":"user","content":"hi"}],"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	clientReq.Header.Set(turnHeaderName, tok)
	pendingTurns.Store(tok, turn)

	resp := &http.Response{StatusCode: http.StatusOK, Header: http.Header{}}
	outBody, _, err := b.InterceptResponse(clientReq, resp, ProviderID("chat.deepseek.com"), SyntheticKeyID, "chat.deepseek.com", true)
	if err != nil {
		t.Fatalf("InterceptResponse: %v", err)
	}
	// io.Pipe 是同步的：写入阻塞直到有人读。必须并发读，否则回合根本跑不起来。
	readDone := make(chan string, 1)
	go func() {
		raw, _ := io.ReadAll(outBody)
		readDone <- string(raw)
	}()
	// InterceptResponse 已返回 —— 这正是旧代码 defer cancel() 生效的时刻。
	var handed context.Context
	select {
	case handed = <-chatCtx:
	case <-time.After(2 * time.Second):
		t.Fatal("streamTurn never started the turn")
	}
	if err := handed.Err(); err != nil {
		t.Fatalf("turn context already dead when InterceptResponse returned: %v", err)
	}
	close(gate)

	var body string
	select {
	case body = <-readDone:
	case <-time.After(3 * time.Second):
		t.Fatal("stream never finished")
	}
	if strings.Contains(string(body), "context canceled") {
		t.Fatalf("stream reported a canceled context: %s", body)
	}
	if !strings.Contains(string(body), "hello") {
		t.Fatalf("stream missing the reply delta: %s", body)
	}
	if !strings.Contains(string(body), "[DONE]") {
		t.Fatalf("stream missing terminator: %s", body)
	}
	for _, line := range strings.Split(string(body), "\n") {
		if !strings.HasPrefix(line, "data: {") {
			continue
		}
		var m map[string]any
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &m) == nil {
			if _, ok := m["error"]; ok {
				t.Fatalf("stream carried an error frame: %s", body)
			}
		}
	}
}

// 非流式路径是同步的：InterceptResponse 返回时回合已结束，cancel 必须照旧
// 在函数返回时执行（不能泄漏）。
func TestNonStreamingTurnCancelsOnReturn(t *testing.T) {
	m := newTestManager(t)
	b := NewBridge(m, newFakeRegistry())
	d := b.Driver()

	var handed context.Context
	d.chatHook = func(ctx context.Context, req ChatRequest) (ChatResult, error) {
		handed = ctx
		return ChatResult{Text: "hello"}, nil
	}

	turn := &turnState{site: "chat.deepseek.com", prompt: "hi", model: "chat.deepseek.com", isStream: false}
	tok := turn.token()
	clientReq, err := http.NewRequest(http.MethodPost, "http://127.0.0.1/v1/chat/completions", strings.NewReader(`{"model":"chat.deepseek.com","messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	clientReq.Header.Set(turnHeaderName, tok)
	pendingTurns.Store(tok, turn)

	resp := &http.Response{StatusCode: http.StatusOK, Header: http.Header{}}
	if _, _, err := b.InterceptResponse(clientReq, resp, ProviderID("chat.deepseek.com"), SyntheticKeyID, "chat.deepseek.com", false); err != nil {
		t.Fatalf("InterceptResponse: %v", err)
	}
	if handed == nil {
		t.Fatal("turn never ran")
	}
	if err := handed.Err(); err == nil {
		t.Fatal("non-streaming turn context must be canceled on return (no leak)")
	}
}
