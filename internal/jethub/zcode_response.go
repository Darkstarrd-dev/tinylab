package jethub

// ZCode 响应侧：错误分类 + 空流权益判定 + Anthropic SSE → OpenAI 转换。
//
// 分类口径来自 ref src/zcode-adapter.ts（全部实测）：
//
//	3007 captcha 校验失败   → 本端无推理侧产出能力 ⇒ 明确报错（不重试、不冷却）
//	3012 风控拦截           → **绝不重试**（账号冷却惩罚 30min→24h→停用）
//	1005/1113 额度用尽      → 标记 账号×模型 至 UTC+8 次日 24:00 并切号
//	1002/401 凭据失效       → 交回代理（401 → 冷却+切号），提示重新登录
//	3009 并发限流（429）    → 退避 1.5s×n 同号重发（**不切号、不标记**），
//	                          重试预算用尽后原样透传
//	5xx / 其余 429          → 交回代理的常规退避
//
// ⚠️ 3009 与 1005/1113 都走 HTTP 429 —— 判据必须按**正文业务码**，只看状态码
// 会把并发限流误判成额度耗尽，白白标记一个完全可用的账号（ref 的显式告诫）。
//
// 空流：上游对"该账号在该模型上无权益"的形态是 **HTTP 200 + 空流**（实测
// 150–200ms 返回）；链路卡住的空流则是超时级耗时。本端按「拦截器入口 → 读到
// EOF 的墙钟」区分：快空 ⇒ 标记 账号×模型 并切号；慢空 ⇒ 可重试错误。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

const (
	// zcodeConcurrencyCode is the upstream's concurrency-limit business code.
	zcodeConcurrencyCode = "3009"
	//
	// zcodeConcurrencyRetryDelay is the linear backoff base (ref
	// concurrencyRetryBaseMs = 1_500; measured: 900ms still collided).
	zcodeConcurrencyRetryDelay = 1500 * time.Millisecond
	// zcodeConcurrencyRetryMax is the number of extra attempts after the first
	// (ref concurrencyRetryMax = 2).
	zcodeConcurrencyRetryMax = 2
)

// zcodeFastEmptyWindow is the fast/slow empty boundary (ref
// ZCODE_FAST_EMPTY_MS = 3_000; measured no-entitlement empties: 150–200ms,
// stuck-link empties: ≈ the 180s timeout). Var so tests can shrink it.
var zcodeFastEmptyWindow = 3 * time.Second

// zcodeConcurrencyState remembers per (account, model) 3009 retry counts so the
// budget is per request burst, not per retry loop (the loop itself allows 180
// queue attempts — far too many for a saturated concurrency window).
var zcodeConcurrencyState = struct {
	sync.Mutex
	m map[string]zcodeConcurrencyEntry
}{m: map[string]zcodeConcurrencyEntry{}}

type zcodeConcurrencyEntry struct {
	count   int
	expires int64
}

// zcodeNoteConcurrency counts a 3009 for account×model and returns the number
// of retries already spent before this hit (0 = first hit).
func zcodeNoteConcurrency(accountID, model string, now time.Time) int {
	key := accountID + "|" + model
	zcodeConcurrencyState.Lock()
	defer zcodeConcurrencyState.Unlock()
	entry := zcodeConcurrencyState.m[key]
	if entry.expires < now.UnixMilli() {
		entry = zcodeConcurrencyEntry{}
	}
	count := entry.count
	entry.count++
	entry.expires = now.Add(time.Minute).UnixMilli()
	zcodeConcurrencyState.m[key] = entry
	return count
}

// zcodeIsConcurrencyLimited: 3009 / "concurrency limit" (ref
// isZcodeConcurrencyLimited; 状态码不参与判据 —— 上游也会用 200/403 包裹).
func zcodeIsConcurrencyLimited(body string) bool {
	return strings.Contains(body, zcodeConcurrencyCode) ||
		strings.Contains(strings.ToLower(body), "concurrency limit")
}

// zcodeIsQuotaExhausted: 1005 / 1113 / 余额不足 / narrow quota text (ref
// isZcodeQuotaExhausted). ⚠️ 必须先排除 3009（同为 429）。
func zcodeIsQuotaExhausted(body string) bool {
	if zcodeIsConcurrencyLimited(body) {
		return false
	}
	if strings.Contains(body, "1113") || strings.Contains(body, "余额不足") || strings.Contains(body, "1005") {
		return true
	}
	lower := strings.ToLower(body)
	return strings.Contains(lower, "exceed quota limit") || strings.Contains(lower, "quota exhausted") ||
		strings.Contains(lower, "quota has been exhausted")
}

// zcodeIsCaptchaRejected: 3007 / "captcha verify failed" (ref
// isZcodeCaptchaRejected; 不判状态码).
func zcodeIsCaptchaRejected(body string) bool {
	return strings.Contains(body, "3007") || strings.Contains(strings.ToLower(body), "captcha verify failed")
}

// zcodeIsRiskBlocked: 3012 (the identity gate's rejection).
func zcodeIsRiskBlocked(body string) bool {
	return strings.Contains(body, "3012")
}

// zcodeIsAuthDead: 1002 business code (credential invalid; 401 由状态码路径处理).
func zcodeIsAuthDead(body string) bool {
	return strings.Contains(body, "1002")
}

// zcodeInterceptResponse is the zcode response hook (dispatched from
// Manager.InterceptResponse in qoder_adapter.go).
func (m *Manager) zcodeInterceptResponse(clientReq *http.Request, resp *http.Response, keyID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	if resp.StatusCode >= 400 {
		return m.zcodeClassifyErrorResponse(resp, keyID, upstreamModel)
	}
	start := time.Now()
	peeked, line, err := zcodePeekMeaningfulDataLine(resp.Body)
	if err != nil && err != io.EOF {
		return nil, 0, fmt.Errorf("zcode: 读取上游流失败：%w", err)
	}
	if line == "" {
		// 空流：区分"无权益"（快）与"链路卡住"（慢）。
		if elapsed := time.Since(start); elapsed < zcodeFastEmptyWindow {
			_ = resp.Body.Close()
			return nil, 0, &upstreamerr.BillingLockError{
				Until: time.UnixMilli(NextUtc8DayStartMs(nowMillis())),
				Reason: fmt.Sprintf("zcode: 上游返回空响应（%.0fms，该账号在 %s 上无可用权益或额度已用尽）→ 标记并切号",
					float64(elapsed.Milliseconds()), upstreamModel),
			}
		}
		return nil, 0, fmt.Errorf("zcode: 上游返回空响应（链路可能卡住）——请重试")
	}
	// 200 包裹的业务错误（上游也会用 200/403 包裹同一批业务码）。
	if code := zcodeBusinessCodeOf(line); code != "" {
		if out, retryMs, handled, err := m.zcodeHandleBusinessCode(code, resp, keyID, upstreamModel); handled {
			return out, retryMs, err
		}
	}
	if msg, ok := minimaxFirstErrorFrame(line); ok {
		_ = resp.Body.Close()
		return nil, 0, fmt.Errorf("zcode: 流内错误：%s", msg)
	}

	src := io.MultiReader(bytes.NewReader(peeked), resp.Body)
	model := upstreamModel
	if model == "" {
		model = "zcode"
	}
	anthropicEntry := minimaxIsAnthropicEntry(clientEntryPathOf(clientReq))
	// 原生 Anthropic 流式：字节级透传（上游就是 Anthropic SSE）。
	if anthropicEntry && isStream {
		return nil, 0, nil
	}
	if isStream {
		return newMinimaxSSEReader(src, !anthropicEntry, model), 0, nil
	}
	body, err := minimaxAggregateSSE(src, !anthropicEntry, model)
	if err != nil {
		return nil, 0, err
	}
	resp.Header.Set("Content-Type", "application/json; charset=utf-8")
	resp.Header.Del("Content-Length")
	resp.ContentLength = -1
	return bytes.NewReader(body), 0, nil
}

// zcodeClassifyErrorResponse handles HTTP >= 400 responses.
func (m *Manager) zcodeClassifyErrorResponse(resp *http.Response, keyID, upstreamModel string) (io.Reader, int64, error) {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()
	text := string(raw)
	// 恢复 body：透传路径（5xx / 其余 429 / 401）仍要把它交给代理。
	resp.Body = io.NopCloser(bytes.NewReader(raw))

	if code := zcodeBusinessCodeOf(text); code != "" {
		if out, retryMs, handled, err := m.zcodeHandleBusinessCode(code, resp, keyID, upstreamModel); handled {
			return out, retryMs, err
		}
	}
	return nil, 0, nil
}

// zcodeBusinessCodeOf extracts the business code from an error body
// (`{"code":3007,...}` / `{"error":{"code":...}}`), "" when absent.
func zcodeBusinessCodeOf(body string) string {
	trimmed := strings.TrimSpace(body)
	if trimmed == "" {
		return ""
	}
	idx := strings.Index(trimmed, "{")
	if idx < 0 {
		return ""
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(trimmed[idx:]), &parsed); err != nil {
		return ""
	}
	if code, ok := parsed["code"]; ok {
		if s := zcodeCodeString(code); s != "" {
			return s
		}
	}
	if errObj, ok := parsed["error"].(map[string]any); ok {
		if code, ok := errObj["code"]; ok {
			if s := zcodeCodeString(code); s != "" {
				return s
			}
		}
	}
	return ""
}

// zcodeCodeString renders a JSON business code (number or string).
func zcodeCodeString(v any) string {
	switch t := v.(type) {
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
	case string:
		return strings.TrimSpace(t)
	}
	return ""
}

// zcodeHandleBusinessCode applies the shared classification for a business
// code. handled=false means "no special handling — let the proxy classify".
func (m *Manager) zcodeHandleBusinessCode(code string, resp *http.Response, keyID, upstreamModel string) (io.Reader, int64, bool, error) {
	switch code {
	case zcodeConcurrencyCode:
		// 并发限流：同号退避重发（不切号、不标记）。预算用尽后原样透传。
		if zcodeNoteConcurrency(keyID, upstreamModel, time.Now()) <= zcodeConcurrencyRetryMax {
			return nil, zcodeConcurrencyRetryDelay.Milliseconds(), true, nil
		}
		return nil, 0, false, nil
	case "1005", "1113":
		// 额度用尽：标记 账号×模型 至 UTC+8 次日 24:00，切下一个账号。
		_ = resp.Body.Close()
		return nil, 0, true, &upstreamerr.BillingLockError{
			Until:  time.UnixMilli(NextUtc8DayStartMs(nowMillis())),
			Reason: "zcode: 额度用尽（1005/1113）→ 标记至 UTC+8 次日 24:00 并切号",
		}
	case "3007":
		// captcha：本端推理侧没有产出能力（3.14.4 起上游也几乎不再索要）。
		// 明确报错且**不重试**（重试只会重复撞同一堵墙）。
		zcodeRewriteAsClientError(resp, "该模型当前要求阿里云 captcha 验证（3007）。"+
			"本端未实现推理侧的验证码产出；请在官方 ZCode 客户端完成一次请求，或稍后重试。")
		return nil, 0, true, nil
	case "3012":
		// 风控拦截：**绝不重试**（账号冷却惩罚 30min → 24h → 停用）。
		zcodeRewriteAsClientError(resp, "上游风控拦截（3012 unusual activity）。"+
			"该错误有账号冷却惩罚（30 分钟，反复触发会升级到 24 小时乃至停用），请勿连续重试。")
		return nil, 0, true, nil
	case "1002":
		// 凭据失效：改写提示后交回代理（401 → 冷却 + 切号）。
		zcodeRewriteErrorBody(resp, "zcode: 凭据失效（1002）——请在 Free Hub 重新登录该 ZCode 账号", "auth_error")
		return nil, 0, false, nil
	}
	return nil, 0, false, nil
}

// zcodeRewriteAsClientError rewrites the body and normalizes the status to 400
// so the proxy treats it as a pass-through client error: written to the client
// as-is, no retry, no key cooldown/exclusion.
//
// ⚠️ 这是本端唯一能表达「硬停 + 不罚 key」的机制（代理只有 400/422 走透传）：
// 3012/3007 若按原状态分类，会触发冷却+切号 → 下一个账号收到**同一个请求体**
// 再撞一次 3012，把整池账号的惩罚次数一起推高。
//
// ⚠️ 3012 的原状态实测是 **405**（不是 403；上游 2026-10-03 复测修正，见 ref
// c94e659 与 zcode-identity.ts 文件头）。本端的分类**只看响应体**（3012/3007 的
// 业务码），状态码不参与判据，故对这条修正是功能性免疫 —— 但排查时别按 403 找，
// 现场的响应体里还带 logid，向用户索取时优先要它。
func zcodeRewriteAsClientError(resp *http.Response, message string) {
	resp.StatusCode = http.StatusBadRequest
	zcodeRewriteErrorBody(resp, message, "zcode_client_error")
}

// zcodeRewriteErrorBody replaces the response body with an OpenAI-shaped error
// envelope (keeping the status code).
func zcodeRewriteErrorBody(resp *http.Response, message, errType string) {
	body, err := json.Marshal(map[string]any{"error": map[string]any{
		"message": message,
		"type":    errType,
		"code":    resp.StatusCode,
	}})
	if err != nil {
		return
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.Header.Set("Content-Type", "application/json; charset=utf-8")
	resp.Header.Del("Content-Length")
	resp.ContentLength = -1
}

// zcodePeekMeaningfulDataLine reads src until the first `data:` line that is
// not a ping/heartbeat frame, returning every consumed byte (for replay) and
// the raw line itself. io.EOF with an empty line = the stream produced nothing.
func zcodePeekMeaningfulDataLine(src io.Reader) (peeked []byte, line string, err error) {
	var acc []byte
	scanned := 0
	buf := make([]byte, 16_384)
	for {
		for {
			idx := bytes.IndexByte(acc[scanned:], '\n')
			if idx < 0 {
				break
			}
			end := scanned + idx // index of '\n'
			raw := strings.TrimSuffix(string(acc[scanned:end]), "\r")
			scanned = end + 1
			trimmed := strings.TrimSpace(raw)
			if !strings.HasPrefix(trimmed, "data:") {
				continue
			}
			payload := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
			if payload == "" || payload == "[DONE]" {
				continue
			}
			if strings.Contains(payload, "\"ping\"") { // 心跳不构成"有内容"
				continue
			}
			// ⚠️ 回放**全部已消费字节**（acc 可能已把整条流读进缓冲，只回放
			// `acc[:scanned]` 会把该行之后的内容吞掉 —— 表现为转换器拿到截断流、
			// 报"未返回任何内容块"）。
			return acc, raw, nil
		}
		n, readErr := src.Read(buf)
		if n > 0 {
			acc = append(acc, buf[:n]...)
			continue
		}
		if readErr != nil {
			return acc, "", readErr
		}
		if len(acc) > 1<<20 {
			return acc, "", nil // 防御：超长无换行
		}
	}
}
