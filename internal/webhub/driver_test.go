package webhub

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 并发排队：同一站点的两个请求必须串行，不得交叉。
//
// 这是 webhub 的核心约束（一个浏览器登录态只能承载一个对话）。若并发放行，
// 两个 prompt 会落在同一个输入框里，两条回复都会变成垃圾。
func TestDriverSerializesPerSite(t *testing.T) {
	d := NewDriver(nil)
	q := d.queueFor("chat.deepseek.com")

	var active int32
	var maxActive int
	var mu sync.Mutex
	order := []string{}

	var wg sync.WaitGroup
	run := func(name string) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, err := q.acquire(context.Background(), "chat.deepseek.com")
			if err != nil {
				t.Errorf("acquire: %v", err)
				return
			}
			defer release()
			cur := atomic.AddInt32(&active, 1)
			mu.Lock()
			order = append(order, name)
			if int(cur) > maxActive {
				maxActive = int(cur)
			}
			mu.Unlock()
			time.Sleep(20 * time.Millisecond)
			atomic.AddInt32(&active, -1)
		}()
	}
	// 起 5 个请求
	for i := 0; i < 5; i++ {
		run(string(rune('A' + i)))
	}
	wg.Wait()
	if maxActive != 1 {
		t.Fatalf("max concurrent = %d, want 1 (site sessions are strictly serial)", maxActive)
	}
	if len(order) != 5 {
		t.Fatalf("ran %d turns, want 5", len(order))
	}
}

// 取消排队：客户端断连时必须离开队列，不能一直堵在长回复后面。
func TestDriverQueueHonorsContextCancel(t *testing.T) {
	d := NewDriver(nil)
	q := d.queueFor("chat.deepseek.com")

	release, err := q.acquire(context.Background(), "chat.deepseek.com")
	if err != nil {
		t.Fatal(err)
	}
	// 第二个请求在队里等
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := q.acquire(ctx, "chat.deepseek.com")
		done <- err
	}()
	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled waiter must return an error")
		}
	case <-time.After(time.Second):
		t.Fatal("canceled waiter never returned")
	}
	release()
}

// 不同站点互不阻塞（每站点一条队列）。
func TestDriverQueuesArePerSite(t *testing.T) {
	d := NewDriver(nil)
	qa := d.queueFor("chat.deepseek.com")
	qb := d.queueFor("chatgpt.com")
	ra, err := qa.acquire(context.Background(), "chat.deepseek.com")
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan error, 1)
	go func() {
		_, err := qb.acquire(context.Background(), "chatgpt.com")
		got <- err
	}()
	select {
	case err := <-got:
		if err != nil {
			t.Fatalf("other site must not block: %v", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("a different site was blocked by another site's queue")
	}
	ra()
}

// prompt 拼装：单条 user 消息不装饰，多轮带角色前缀，system 置顶。
func TestBuildPrompt(t *testing.T) {
	body := func(msgs ...map[string]any) []byte {
		b, _ := json.Marshal(map[string]any{"messages": msgs})
		return b
	}
	// 单条 user → 裸文本（最常见的单次调用不该被装饰）
	got, err := BuildPrompt(body(map[string]any{"role": "user", "content": "hi"}))
	if err != nil {
		t.Fatal(err)
	}
	if got != "hi" {
		t.Fatalf("single-shot = %q", got)
	}

	// system + 多轮 → System 置顶 + 角色前缀
	got, err = BuildPrompt(body(
		map[string]any{"role": "system", "content": "be terse"},
		map[string]any{"role": "user", "content": "q1"},
		map[string]any{"role": "assistant", "content": "a1"},
		map[string]any{"role": "user", "content": "q2"},
	))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, "System: be terse") {
		t.Fatalf("system must lead: %q", got)
	}
	for _, want := range []string{"User: q1", "Assistant: a1", "User: q2"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %q", want, got)
		}
	}

	// 多段 content（数组形态）必须展平为文本
	got, err = BuildPrompt(body(map[string]any{"role": "user", "content": []any{
		map[string]any{"type": "text", "text": "part1"},
		map[string]any{"type": "image_url", "image_url": map[string]any{"url": "http://x"}},
		map[string]any{"type": "text", "text": "part2"},
	}}))
	if err != nil {
		t.Fatal(err)
	}
	if got != "part1\npart2" {
		t.Fatalf("multipart = %q", got)
	}

	// tool 结果也要让页面看到（页面无法真正调工具，但不能整段丢失）
	got, err = BuildPrompt(body(
		map[string]any{"role": "user", "content": "q"},
		map[string]any{"role": "tool", "content": "42"},
	))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "Tool result: 42") {
		t.Fatalf("tool result lost: %q", got)
	}

	// 空 body 不报错
	if _, err := BuildPrompt(nil); err != nil {
		t.Fatalf("nil body: %v", err)
	}
	// 坏 JSON 必须报错（否则会静默发一个空 prompt）
	if _, err := BuildPrompt([]byte("{not json")); err == nil {
		t.Fatal("expected a parse error")
	}
}

// 不支持的站点 / 无预设 / 空 prompt 都要在开跑前失败。
func TestChatRejectsBadInput(t *testing.T) {
	d := NewDriver(nil)
	if _, err := d.Chat(context.Background(), ChatRequest{Site: "nope.example"}); err == nil {
		t.Fatal("expected an error for an unsupported site")
	}
	if _, err := d.Chat(context.Background(), ChatRequest{Site: "chat.deepseek.com"}); err == nil {
		t.Fatal("expected an error for an empty prompt")
	}
	// 未连接时必须报 ErrNotConnected（UI 据此提示「打开站点」）
	if _, err := d.Chat(context.Background(), ChatRequest{Site: "chat.deepseek.com", Prompt: "hi"}); err != ErrNotConnected {
		t.Fatalf("err = %v, want ErrNotConnected", err)
	}
}

// 真实站点规则必须可用：每个站点的默认预设都要有 input_box + result_container。
// 这是选择器腐烂的哨兵 —— 上游改版会让这条先红。
func TestEverySiteHasUsableDefaultPreset(t *testing.T) {
	for _, r := range AllSites() {
		p := r.Default()
		if p == nil {
			t.Errorf("%s: no default preset", r.Domain)
			continue
		}
		if !p.HasSelectors() {
			t.Errorf("%s/%s: missing input_box or result_container", r.Domain, p.Name)
		}
		if p.Stream.HardTimeoutSec <= 0 {
			t.Errorf("%s/%s: no hard_timeout", r.Domain, p.Name)
		}
	}
}

// 每个站点的发送链路都必须包含 FILL_INPUT 与 STREAM_WAIT —— 否则规则转换
// 漏了关键步骤，站点会在真机上静默失败。
func TestEverySiteWorkflowHasFillAndStream(t *testing.T) {
	for _, r := range AllSites() {
		p := r.Default()
		if p == nil {
			continue
		}
		var fill, stream bool
		for i := range p.Workflow {
			switch p.Workflow[i].Action {
			case ActionFillInput:
				fill = true
			case ActionStreamWait:
				stream = true
			}
		}
		if !fill || !stream {
			t.Errorf("%s/%s: workflow missing FILL_INPUT(%v)/STREAM_WAIT(%v)", r.Domain, p.Name, fill, stream)
		}
	}
}

// 规则表覆盖架构文档 §6 的 12 个站点。
func TestSiteTableCoversDocumentedMatrix(t *testing.T) {
	want := []string{
		"chat.deepseek.com", "chatgpt.com", "claude.ai", "gemini.google.com",
		"www.doubao.com", "chat.qwen.ai", "www.kimi.com", "grok.com",
		"aistudio.google.com", "aistudio.xiaomimimo.com", "chatglm.cn", "arena.ai",
	}
	for _, w := range want {
		if SiteRuleByDomain(w) == nil {
			t.Errorf("missing site %q", w)
		}
	}
	if got := len(AllSites()); got != len(want) {
		t.Errorf("site count = %d, want %d", got, len(want))
	}
}

// 模型 ID 空间：arena（12 预设）应当显著大于单预设站点。
func TestModelIDSpaceScalesWithPresets(t *testing.T) {
	arena := SiteRuleByDomain("arena.ai")
	ds := SiteRuleByDomain("chat.deepseek.com")
	if arena == nil || ds == nil {
		t.Fatal("missing rules")
	}
	a := len(ModelIDsForSite("arena.ai", arena.PresetNames()))
	d := len(ModelIDsForSite("chat.deepseek.com", ds.PresetNames()))
	if a <= d {
		t.Fatalf("arena ids %d must exceed deepseek ids %d", a, d)
	}
}
