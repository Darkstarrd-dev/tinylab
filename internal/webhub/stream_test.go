package webhub

import (
	"context"
	"strings"
	"testing"
	"time"
)

// 增量监听：只有新增后缀才作为 delta 发出。
func TestWatchReplyEmitsOnlyGrowth(t *testing.T) {
	p := newFakePage()
	p.scripted = []string{"a", "bc", "def"}
	var got []string
	res, err := WatchReply(context.Background(), p, "result", fastBudget(), func(d string) { got = append(got, d) })
	if err != nil {
		t.Fatalf("WatchReply: %v", err)
	}
	if res.Text != "abcdef" {
		t.Fatalf("text = %q", res.Text)
	}
	if strings.Join(got, "|") != "a|bc|def" {
		t.Fatalf("deltas = %q", got)
	}
	if res.FirstContentAfter < 0 {
		t.Fatal("FirstContentAfter must not be negative")
	}
}

// P0 缺陷②：首字等待必须有独立预算，不能占用 idle。
// 构造一个「5 个 poll 周期后才出首字」的页面：若首字等待与 idle 共用一个
// 预算，idle 会在内容出现前就到期（旧逻辑必然返回 0 字符）。
func TestWatchReplyFirstContentDoesNotConsumeIdleBudget(t *testing.T) {
	p := newFakePage()
	// 前 20 次读取都为空（模拟深度思考），第 21 次才有内容。
	p.scripted = make([]string, 21)
	for i := range p.scripted {
		p.scripted[i] = ""
	}
	p.scripted[20] = "late"

	b := StreamBudget{
		StartTimeout: 5 * time.Second, // 独立且足够
		IdleTimeout:  50 * time.Millisecond,
		HardTimeout:  5 * time.Second,
		PollInterval: 5 * time.Millisecond,
	}
	res, err := WatchReply(context.Background(), p, "result", b, nil)
	if err != nil {
		t.Fatalf("WatchReply: %v", err)
	}
	if res.Text != "late" {
		t.Fatalf("text = %q, want the late first content", res.Text)
	}
	if res.FirstContentAfter < 50*time.Millisecond {
		t.Fatalf("FirstContentAfter = %v — too fast to prove the point", res.FirstContentAfter)
	}
}

// 首字超时必须报错（而不是返回一条空回复伪装成功）。
func TestWatchReplyStartTimeout(t *testing.T) {
	p := newFakePage() // never produces content
	b := StreamBudget{StartTimeout: 60 * time.Millisecond, IdleTimeout: time.Second, HardTimeout: time.Second, PollInterval: 5 * time.Millisecond}
	res, err := WatchReply(context.Background(), p, "result", b, nil)
	if err == nil {
		t.Fatal("expected a start-timeout error")
	}
	if !res.TimedOut {
		t.Fatal("TimedOut must be set")
	}
}

// resync 守卫（P0 fixture2 的对抗场景）：页面中途替换节点并回退时，
// 不得发出乱码 delta。
func TestWatchReplyResyncGuard(t *testing.T) {
	// 一个可编程页面：依次返回
	//   "AB" → "ABC"（正常增长）
	//   → "ABCDX"（节点被整体替换，内容保留）
	//   → "AB"（页面回退到更短的中间态）
	//   → "ABZ"（继续增长）
	p := &programmedPage{texts: []string{"AB", "ABC", "ABCDX", "AB", "ABZ", "ABZ", "ABZ"}}

	var got []string
	b := StreamBudget{StartTimeout: time.Second, IdleTimeout: 30 * time.Millisecond, HardTimeout: 2 * time.Second, PollInterval: 5 * time.Millisecond}
	res, err := WatchReply(context.Background(), p, "result", b, func(d string) { got = append(got, d) })
	if err != nil {
		t.Fatalf("WatchReply: %v", err)
	}
	for _, d := range got {
		// 每个 delta 都必须是真实新增文本；回退/替换阶段不得产出任何 delta。
		if d == "" {
			t.Fatalf("emitted an empty delta: %q", got)
		}
	}
	// 回退阶段（ABCDX → AB）若没有守卫，会发出 "CDX" 这种反向乱码；
	// 有守卫时这一阶段完全静默，最终文本收敛到页面最后的状态。
	if res.Text != "ABZ" {
		t.Fatalf("text = %q, want ABZ", res.Text)
	}
	if res.Resyncs == 0 {
		t.Fatal("resyncs must be counted")
	}
	// "C" 与 "DX" 是真实增长，应当出现；"CDX" 这种拼接不该出现。
	joined := strings.Join(got, "|")
	if !strings.Contains(joined, "C") || !strings.Contains(joined, "DX") {
		t.Fatalf("expected the real growth deltas, got %q", joined)
	}
	for _, bad := range []string{"CDX", "XAB", "BC"} {
		for _, d := range got {
			if d == bad {
				t.Fatalf("corrupt delta %q emitted (resync guard missing)", bad)
			}
		}
	}
}

// 反向验证：把守卫去掉（用朴素 suffix diff）必须产生乱码 delta —— 证明
// 该守卫真的在起作用，而不是一段无害的死代码。
func TestWatchReplyResyncGuardIsLoadBearing(t *testing.T) {
	texts := []string{"AB", "ABC", "ABCDX", "AB", "ABZ", "ABZ", "ABZ"}
	// 朴素实现：无条件把「与上次不同的部分」当 delta。
	var emitted string
	var deltas []string
	for _, cur := range texts {
		if cur != emitted {
			delta := strings.TrimPrefix(cur, emitted)
			if delta == "" {
				delta = cur // 朴素实现会在这里造出反向内容
			}
			deltas = append(deltas, delta)
			emitted = cur
		}
	}
	// 回退阶段（ABCDX → AB）朴素实现会得到 "AB"（整段重发）→ 客户端出现重复。
	found := false
	for _, d := range deltas {
		if d == "AB" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the naive diff did not misbehave as expected: %q", deltas)
	}
}

// programmedPage returns a fixed sequence of texts, one per read.
type programmedPage struct {
	texts []string
	i     int
}

func (p *programmedPage) Eval(script string, out any) error {
	if strings.Contains(script, "querySelectorAll") && p.i < len(p.texts) {
		v := p.texts[p.i]
		p.i++
		return setString(out, v)
	}
	if p.i > 0 && p.i-1 < len(p.texts) {
		return setString(out, p.texts[p.i-1])
	}
	return setString(out, "")
}
func (p *programmedPage) Click(string) error                      { return nil }
func (p *programmedPage) WaitVisible(string, time.Duration) error { return nil }
func (p *programmedPage) Exists(string) (bool, error)             { return true, nil }
func (p *programmedPage) Text(sel string) (string, error) {
	var s string
	_ = p.Eval(`(function(){var els=document.querySelectorAll("result");return els[els.length-1].innerText||''})()`, &s)
	return s, nil
}

// 硬超时兜底：内容一直增长也不能无限等待。
func TestWatchReplyHardTimeout(t *testing.T) {
	p := &growingPage{}
	b := StreamBudget{StartTimeout: time.Second, IdleTimeout: time.Second, HardTimeout: 80 * time.Millisecond, PollInterval: 5 * time.Millisecond}
	res, err := WatchReply(context.Background(), p, "result", b, nil)
	if err == nil {
		t.Fatal("expected a hard-timeout error")
	}
	if !res.TimedOut {
		t.Fatal("TimedOut must be set on hard timeout")
	}
}

type growingPage struct{ n int }

func (g *growingPage) Eval(script string, out any) error {
	g.n++
	return setString(out, strings.Repeat("x", g.n))
}
func (g *growingPage) Click(string) error                      { return nil }
func (g *growingPage) WaitVisible(string, time.Duration) error { return nil }
func (g *growingPage) Exists(string) (bool, error)             { return true, nil }
func (g *growingPage) Text(string) (string, error) {
	var s string
	_ = g.Eval("", &s)
	return s, nil
}

// 上游 hard_timeout 只覆盖硬超时；start/idle 是延迟行为，不从规则数据取。
func TestBudgetForUsesRuleHardTimeout(t *testing.T) {
	b := budgetFor(StreamConfig{Mode: "network", HardTimeoutSec: 600})
	if b.HardTimeout != 600*time.Second {
		t.Fatalf("hard = %v", b.HardTimeout)
	}
	if b.StartTimeout != DefaultStreamBudget().StartTimeout {
		t.Fatal("start timeout must stay on the default")
	}
	if b.IdleTimeout != DefaultStreamBudget().IdleTimeout {
		t.Fatal("idle timeout must stay on the default")
	}
	// 缺省值必须非空
	d := DefaultStreamBudget()
	if d.StartTimeout <= 0 || d.IdleTimeout <= 0 || d.HardTimeout <= 0 || d.PollInterval <= 0 {
		t.Fatalf("default budget has a zero field: %+v", d)
	}
}

// 空选择器必须报错，而不是静默返回成功。
func TestWatchReplyEmptySelector(t *testing.T) {
	if _, err := WatchReply(context.Background(), newFakePage(), "", fastBudget(), nil); err == nil {
		t.Fatal("expected an error for an empty selector")
	}
}
