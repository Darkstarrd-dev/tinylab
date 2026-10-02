package webhub

import (
	"context"
	"strings"
	"testing"
	"time"
)

func fastBudget() StreamBudget {
	return StreamBudget{
		StartTimeout: 2 * time.Second,
		IdleTimeout:  60 * time.Millisecond,
		HardTimeout:  3 * time.Second,
		PollInterval: 5 * time.Millisecond,
	}
}

// 最小 send-and-read：FILL_INPUT → KEY_PRESS → STREAM_WAIT 跑通并拿到回复。
func TestRunWorkflowFillPressStream(t *testing.T) {
	p := newFakePage()
	p.add("#prompt")
	p.scripted = []string{"Hello", " world"}

	preset := &Preset{
		Name: "主预设",
		Selectors: map[string]string{
			SelInputBox:      "#prompt",
			SelResultContain: "result",
		},
		Stream: StreamConfig{Mode: "dom"},
		Workflow: []Step{
			{Action: ActionFillInput, Target: SelInputBox},
			{Action: ActionKeyPress, Target: "Enter"},
			{Action: ActionStreamWait, Target: SelResultContain},
		},
	}
	var got []string
	out, err := RunWorkflow(context.Background(), p, preset, RunOptions{
		Prompt:  "Say hi",
		Budget:  fastBudget(),
		OnDelta: func(d string) { got = append(got, d) },
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if out.Text != "Hello world" {
		t.Fatalf("text = %q", out.Text)
	}
	if strings.Join(got, "|") != "Hello| world" {
		t.Fatalf("deltas = %q", got)
	}
	if p.values["#prompt"] != "Say hi" {
		t.Fatalf("input value = %q", p.values["#prompt"])
	}
	if p.presses != 1 {
		t.Fatalf("presses = %d, want 1", p.presses)
	}
}

// P0 缺陷①：文本必须经原生 setter 写入，且写入后校验长度。
// React 受控组件吞掉 SendKeys 的历史缺陷正是靠这条守住。
func TestFillInputVerifiesWrite(t *testing.T) {
	p := newFakePage()
	p.add("#box")
	if err := FillInput(p, "#box", "你好, world"); err != nil {
		t.Fatalf("FillInput: %v", err)
	}
	if p.values["#box"] != "你好, world" {
		t.Fatalf("value = %q", p.values["#box"])
	}
	// 原生 setter 路径必须被用到（而不是 SendKeys 的逐字符事件）。
	var usedSetter bool
	for _, s := range p.scripts {
		if strings.Contains(s, "Object.getOwnPropertyDescriptor") {
			usedSetter = true
		}
	}
	if !usedSetter {
		t.Fatal("expected the native value setter path")
	}
}

// 写入被截断必须报错（宁可失败也不能把半个 prompt 发出去）。
func TestFillInputTruncatedFails(t *testing.T) {
	p := newFakePage()
	p.add("#box")
	// 页面「接受」了写入但只读回一部分：模拟框架把值改回去了。
	old := FillInput
	_ = old
	p.values["#box"] = ""
	// 用一个只写入空值的页面：长度校验必然失败。
	q := &shortWritePage{fakePage: p}
	if err := FillInput(q, "#box", "abcdef"); err == nil {
		t.Fatal("expected ErrInputTruncated")
	} else if !strings.Contains(err.Error(), "truncated") {
		t.Fatalf("err = %v, want truncation", err)
	}
}

// shortWritePage writes nothing, so the read-back length check trips.
type shortWritePage struct{ *fakePage }

func (s *shortWritePage) Eval(script string, out any) error {
	if strings.Contains(script, "el.value") {
		return setString(out, "")
	}
	return s.fakePage.Eval(script, out)
}

// 元素不存在必须明确报错（登录态过期最常见的表现）。
func TestFillInputNoElement(t *testing.T) {
	p := newFakePage()
	if err := FillInput(p, "#missing", "x"); err == nil {
		t.Fatal("expected an error for a missing element")
	}
}

// P0 缺陷③：optional 步骤必须有界，且失败只跳过不报错。
func TestOptionalClickBoundedAndSkipped(t *testing.T) {
	p := newFakePage()
	p.add("#result")
	p.setText("#result", "done")
	p.clickFails["#gone"] = true
	p.clickDelay = 200 * time.Millisecond // 远超 5s 不行，但足证有界调用本身不阻塞

	preset := &Preset{
		Selectors: map[string]string{SelInputBox: "#prompt", SelResultContain: "#result"},
		Workflow: []Step{
			{Action: ActionClick, Target: "#gone", Optional: true},
			{Action: ActionStreamWait, Target: SelResultContain},
		},
	}
	start := time.Now()
	out, err := RunWorkflow(context.Background(), p, preset, RunOptions{Budget: fastBudget()})
	if err != nil {
		t.Fatalf("optional failure must not be fatal: %v", err)
	}
	if out.StepsSkipped != 1 {
		t.Fatalf("StepsSkipped = %d, want 1", out.StepsSkipped)
	}
	if out.Text != "done" {
		t.Fatalf("text = %q", out.Text)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("optional step took %v — not bounded as expected", elapsed)
	}
}

// 非 optional 的 CLICK 失败必须让请求失败（不能静默继续）。
func TestRequiredClickFailureIsFatal(t *testing.T) {
	p := newFakePage()
	p.clickFails["#send"] = true
	preset := &Preset{
		Selectors: map[string]string{SelSendButton: "#send"},
		Workflow:  []Step{{Action: ActionClick, Target: SelSendButton}},
	}
	if _, err := RunWorkflow(context.Background(), p, preset, RunOptions{}); err == nil {
		t.Fatal("expected a fatal error")
	}
}

// WAIT 步骤按规则数据的秒数等待（并被上限夹住）。
func TestWaitStepClamped(t *testing.T) {
	if d := waitDuration(0.5); d != 500*time.Millisecond {
		t.Fatalf("d = %v", d)
	}
	if d := waitDuration(9999); d != waitStepCap {
		t.Fatalf("d = %v, want the cap", d)
	}
	if d := waitDuration(0); d != 0 {
		t.Fatalf("d = %v", d)
	}
}

// 未移植的动作（IF / CAPTURE / JS_EXEC …）跳过而不失败 —— 否则 gemini 这类
// 带条件步骤的站点会整站不可用。
func TestUnportedActionsSkipped(t *testing.T) {
	p := newFakePage()
	p.add("#result")
	p.setText("#result", "ok")
	preset := &Preset{
		Selectors: map[string]string{SelInputBox: "#prompt", SelResultContain: "#result"},
		Workflow: []Step{
			{Action: ActionReadonly, Label: "声明"},
			{Action: ActionIf, Label: "条件"},
			{Action: ActionCapture, Target: "current_model"},
			{Action: ActionJSEval, Target: "..."},
			{Action: ActionSelect, Target: "model"},
			{Action: ActionCoordClick, Target: "x,y"},
			{Action: ActionStreamWait, Target: SelResultContain},
		},
	}
	out, err := RunWorkflow(context.Background(), p, preset, RunOptions{Budget: fastBudget()})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if out.Text != "ok" {
		t.Fatalf("text = %q", out.Text)
	}
}

// 缺少必需选择器必须提前报错，而不是等到请求中途炸掉。
func TestRunWorkflowRequiresSelectors(t *testing.T) {
	p := newFakePage()
	if _, err := RunWorkflow(context.Background(), p, &Preset{Name: "x"}, RunOptions{}); err == nil {
		t.Fatal("expected an error for a preset without selectors")
	}
	if _, err := RunWorkflow(context.Background(), p, nil, RunOptions{}); err == nil {
		t.Fatal("expected an error for a nil preset")
	}
}

// 选择器带 "css:" 前缀（上游规则里确实有）必须被剥掉。
func TestStripCSSPrefix(t *testing.T) {
	if got := stripCSSPrefix("css:div.ds-markdown"); got != "div.ds-markdown" {
		t.Fatalf("got %q", got)
	}
	if got := stripCSSPrefix("  div.x  "); got != "div.x" {
		t.Fatalf("got %q", got)
	}
}

// 空回复必须报错（否则桥接会返回一条空 content 的"成功"响应）。
func TestRunWorkflowEmptyReplyFails(t *testing.T) {
	p := newFakePage()
	preset := &Preset{
		Selectors: map[string]string{SelInputBox: "#prompt", SelResultContain: "#result"},
		Workflow:  []Step{{Action: ActionFillInput, Target: SelInputBox}},
	}
	if _, err := RunWorkflow(context.Background(), p, preset, RunOptions{Prompt: "x"}); err == nil {
		t.Fatal("expected an error when no reply text was produced")
	}
}
