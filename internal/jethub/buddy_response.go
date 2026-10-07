package jethub

// Buddy（CodeBuddy / WorkBuddy）响应侧判据。
//
// ⚠️ 本文件的存在理由是一条**真实的用户可见缺陷**（ref 29a42ea）：buddy 的
// 「模型饱和」业务码 `14003` 也是 **HTTP 429**，而代理的通用 429 分支对任何
// 429 都会给当前 key 写一条限流标记并换号 ⇒ 一个模型级信号把**整个账号池**
// 逐个锁死（上游实测：4 个互不相干的腾讯 uid 在 20 秒内全部被写 `space-bunny`
// 标记，解禁时刻全是「写入 + 兜底 1 小时」，而服务端对该模型完全可用）。
//
// 报文自己就否证了「账号问题」：
//
//	{"code":14003,"msg":"too many requests",
//	 "displayMsg":{"zh":"模型繁忙，请换模型或稍后重试"},
//	 "displayTips":{"zh":"这个模型当前请求量饱和，与你的网络无关。…"},
//	 "actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","RETRY"]}
//
// `actions` 里**只有** `SWITCH_MODEL`，没有换号选项。与账号额度限流
// （`6004`，带「将在…重置」时刻）的动作正好相反：
//
//	|              | 额度限流 6004      | 模型饱和 14003        |
//	|--------------|--------------------|-----------------------|
//	| 换号         | 有效               | **无益**（同一堵墙）  |
//	| 写限流标记   | 必须               | **绝对不许**（锁整池）|
//	| 建议         | 等解禁 / 换账号    | **换模型** / 稍后重试 |
//
// 与 zcode `3009 model concurrency limit exceeded` 同型（那边同样是「退避重试、
// 不换号、不标记」）。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// buddyModelSaturationCode is the Tencent gateway's model-saturation business
// code (HTTP 429). ⚠️ **不得**并进任何「账号额度」判据：两者动作相反。
const buddyModelSaturationCode = 14003

// buddySaturationRetryAfter is the first backoff for a saturated model
// (ref 29a42ea: 2s → 4s linear, always the same credential).
const buddySaturationRetryAfter = 2 * time.Second

// buddyModelSaturationTexts is the **narrow** natural-language fallback for the
// saturation code (ref MODEL_SATURATION_PATTERN 逐字同值). ⚠️ 泛词（`busy` /
// `saturated` 单独出现）不认 —— 模型正文里正常讨论「服务器繁忙」会被误判。
var buddyModelSaturationTexts = []string{
	"模型繁忙", "请求量饱和", "model busy", "currently saturated",
}

// buddyIsModelSaturation reports whether a failed response is MODEL-level
// backpressure rather than account-level quota exhaustion.
//
// ⚠️ 判据要求 `status >= 400`：状态码已知且 < 400 时正文里的字样不算错误
// （ref isModelSaturationError 同口径）。业务码分支不受此限（JSON 里带
// `code:14003` 本身就是服务端在报错）。
func buddyIsModelSaturation(status int, body string) bool {
	if status > 0 && status < 400 {
		return false
	}
	if body == "" {
		return false
	}
	// ① 业务码（可解析 JSON 且 code 为 14003，数字或字符串两种形态）。
	var probe struct {
		Code json.RawMessage `json:"code"`
	}
	if err := json.Unmarshal([]byte(body), &probe); err == nil && len(probe.Code) > 0 {
		var num float64
		if json.Unmarshal(probe.Code, &num) == nil && num == buddyModelSaturationCode {
			return true
		}
		var str string
		if json.Unmarshal(probe.Code, &str) == nil && str == fmt.Sprint(buddyModelSaturationCode) {
			return true
		}
	}
	// ② 窄文案兜底（上游可能改用别的码值表达同一语义）。
	lower := strings.ToLower(body)
	for _, t := range buddyModelSaturationTexts {
		if strings.Contains(lower, strings.ToLower(t)) {
			return true
		}
	}
	return false
}

// buddyInterceptResponse is the buddy-family response hook (dispatched from
// Manager.InterceptResponse). It runs **before** the generic 429 handling
// (that is the whole point — 14003 satisfies "429", so a later check would
// never be reached; the upstream commit calls the ordering "判据顺序就是修复
// 本体").
//
// Only non-2xx responses are inspected: a 200 streaming body may legitimately
// contain the word 「模型繁忙」 in its content.
func (m *Manager) buddyInterceptResponse(resp *http.Response, upstreamModel string) (io.Reader, int64, error) {
	if resp == nil || resp.StatusCode < 400 {
		return nil, 0, nil
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, 0, nil // 读不出正文 → 交给通用分类，不猜
	}
	body := string(raw)
	if !buddyIsModelSaturation(resp.StatusCode, body) {
		// 非饱和错误：把正文还回 resp.Body，让通用分类照常处理
		// （6004 额度限流的换号 + 标记行为**不得**回退）。
		resp.Body = io.NopCloser(bytes.NewReader(raw))
		return nil, 0, nil
	}
	_ = resp.Body.Close()
	model := upstreamModel
	if model == "" {
		model = "该模型"
	}
	return nil, 0, &upstreamerr.ModelSaturationError{
		RetryAfter: buddySaturationRetryAfter,
		Reason: fmt.Sprintf("模型 %s 当前请求量饱和（与账号额度无关）——请换模型或稍后重试",
			model),
	}
}
