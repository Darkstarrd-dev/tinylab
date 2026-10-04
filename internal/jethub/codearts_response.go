package jethub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// CodeArts 响应侧：**HTTP 200 + 流内 `error_code` 也是失败**，以及并发排队
// 的等待重试。
//
// ⚠️ 用户实测（trace r28I5xUHpjJs-2 / r28I5xdd3XRo-3）：codearts 请求返回
// `respStatus=200`、`decision=success`，但响应体是
//
//	data:{"text":"[DONE]","error_code":"InferHub.ModelArts.81114.429","error_msg":"Too many requests, the rate limit is 500000 tokens per minute."}
//	data:{"error_code":"InferHub.4004.200","error_msg":"benefit not found", …}
//
// 客户端于是**只看到空回复**（正文为空、finish 帧也没了），而真正的错误被静默
// 吞掉 —— 与 Qoder 那次「干净地停止、无任何报错」同型。CodeArts 用 200 + 流内
// error_code 表达限流/排队/权益错误，故必须有响应侧判据。
//
// 判据/延迟/上限 1:1 对齐 ref llm-adapter.ts：
//   - `isQueueError(400, body)`：`TM.00001041`（"并发会话数已达上限"）或
//     peak usage / try again after / high demand / too many requests；
//   - `isSseQueueErrorCode(code)`：`TM.00001041` 或 `81111|TPM|429|rate limit|
//     too many requests|排队|限流`（实测还见到 `81114.429`）；
//   - 处理方式：**等 QUEUE_RETRY_DELAY_MS (10s) 后用同一个 Key 重发整个请求**
//     （不冷却、不换号、不等待 `working`），上限由代理的 `maxQueueAttempts`
//     （180 次 ≈ 30 分钟）兜底。
//
// ⚠️ `InferHub.4004.200 benefit not found` 的处置（ref 3bf2be7，2026-10-01）：
// 积分制账号（没有 benefit 免费额度包）带 `maas_type: benefit` 会被 200 + 该码
// 拒绝，而**同一模型不带该头可以正常出流** ⇒ 去掉该头**同 Key 重试一次**
// （`upstreamerr.SameKeyRetryError` + 回环标记，见 augmenter）。标记已在却仍是
// 该码 ⇒ 不是「缺 benefit 包」这一种情形，按真实失败处理（避免与真实失败互相
// 掩盖）。

// codeartsQueueErrorDelay mirrors ref QUEUE_RETRY_DELAY_MS.
const codeartsQueueErrorDelay = 10 * time.Second

// codeartsBenefitNotFoundCode is the stable failure code for "this account has
// no benefit package" (ref BENEFIT_NOT_FOUND_CODE / CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE).
const codeartsBenefitNotFoundCode = "InferHub.4004.200"

// retryDropHeaderOf reads the loopback retry marker the proxy retry loop sets
// on the client request when it resends because of a SameKeyRetryError; ""
// when absent (nil-safe for tests).
func retryDropHeaderOf(r *http.Request) string {
	if r == nil {
		return ""
	}
	return r.Header.Get(upstreamerr.RetryDropHeaderMarker)
}

// codeartsQueueBodyRe mirrors the non-TM.00001041 half of the reference
// isQueueError predicate.
var codeartsQueueBodyRe = regexp.MustCompile(`(?i)peak\s+usage|try\s+again\s+after|peak\s+hours|high\s+demand|too\s+many\s+requests`)

// codeartsSSEQueueCodeRe mirrors the reference isSseQueueErrorCode pattern.
// ⚠️ `429` must be anchored as a STANDALONE number — `(^|[^0-9])429([^0-9]|$)`
// (ref 784210d, 2026-10-02 real-user incident): the quota-exhausted code
// `InferHub.4291.200` has `4291` which a bare `429` substring matches, sending
// a deterministic daily-quota failure into the 10s×180 retry loop (30 minutes
// of silent retries, zero output). `…81114.429` (trailing) and `429 Too Many
// Requests` (space) still match; `4291` does not.
var codeartsSSEQueueCodeRe = regexp.MustCompile(`(?i)81111|81114|TPM|(^|[^0-9])429([^0-9]|$)|rate.?limit|too many requests|排队|限流`)

// codeartsQuotaExhaustedCodeRe / codeartsQuotaExhaustedMsgRe mirror the
// reference isSseQuotaExhaustedErrorCode (ref 784210d): code substring `4291`
// (deliberately not full-equality — the server assigns the suffix, other
// `InferHub.4291.xxx` tails should still classify) plus an
// `insufficient quota` message fallback in case the code value ever changes.
// ⚠️ Must be checked BEFORE isCodeArtsSSEQueueCode at every call site.
var (
	codeartsQuotaExhaustedCodeRe = regexp.MustCompile(`4291`)
	codeartsQuotaExhaustedMsgRe  = regexp.MustCompile(`(?i)insufficient[\s_-]+quota`)
)

// isCodeArtsSSEQuotaExhausted reports whether an error code/message means
// "quota exhausted" — a DETERMINISTIC daily-settled failure. Retrying is
// pointless (the same result after 180 attempts); the key+model must be
// billing-locked until UTC+8 midnight and the account switched, mirroring
// qoder's `110` / opencode quota handling.
func isCodeArtsSSEQuotaExhausted(code, msg string) bool {
	return codeartsQuotaExhaustedCodeRe.MatchString(code) ||
		codeartsQuotaExhaustedMsgRe.MatchString(msg)
}

// isCodeArtsQueueError reports whether an HTTP error body means "queued /
// concurrency limit" (⚠️ 400 only, same as the reference).
func isCodeArtsQueueError(status int, body string) bool {
	if status != http.StatusBadRequest {
		return false
	}
	return strings.Contains(body, "TM.00001041") || codeartsQueueBodyRe.MatchString(body)
}

// isCodeArtsSSEQueueCode reports whether an in-stream error_code means
// "queued / rate limited" (retryable with the same key).
func isCodeArtsSSEQueueCode(code string) bool {
	if code == "TM.00001041" {
		return true
	}
	return codeartsSSEQueueCodeRe.MatchString(code)
}

// codeartsErrorFrame extracts (code, msg) from a CodeArts error frame. A frame
// counts as an error only when `error_code` is non-empty (normal frames carry
// just `{"text": …}`; the terminal frame is `{"text":"[DONE]"}` WITHOUT an
// error_code).
func codeartsErrorFrame(payload string) (code, msg string, ok bool) {
	payload = strings.TrimSpace(payload)
	if payload == "" || !strings.HasPrefix(payload, "{") {
		return "", "", false
	}
	var frame struct {
		ErrorCode string `json:"error_code"`
		ErrorMsg  string `json:"error_msg"`
	}
	if err := json.Unmarshal([]byte(payload), &frame); err != nil {
		return "", "", false
	}
	if frame.ErrorCode == "" {
		return "", "", false
	}
	return frame.ErrorCode, frame.ErrorMsg, true
}

// codeartsInterceptResponse implements proxy.ResponseInterceptor for codearts.
//
// Streaming is the norm here, but the same body shape can arrive on the
// non-stream path, so both are inspected.
func (m *Manager) codeartsInterceptResponse(clientReq *http.Request, resp *http.Response, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	queueRetryMs := int64(codeartsQueueErrorDelay / time.Millisecond)

	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		body := string(raw)
		// 额度用尽（不可重试，ref 784210d）：必须排在排队判据**之前**——
		// `insufficient quota` 这类文案若被限流判据先接走，就会被当成
		// 「重试可自愈」，而它其实是按自然日结算的确定性失败。实测该码
		// 主要走 SSE 通道（HTTP 200），但服务端同样可能以 4xx 下发——
		// 两条通道都接，避免哪天改了形态就漏。
		if isCodeArtsSSEQuotaExhausted(body, body) {
			_ = resp.Body.Close()
			return nil, 0, &upstreamerr.BillingLockError{
				Until:  time.UnixMilli(NextUtc8DayStartMs(nowMillis())),
				Reason: fmt.Sprintf("codearts: 模型 %s 的免费额度（benefit）已用尽（预计 UTC+8 当日 24:00 重置），可改用其它模型或切换账号", upstreamModel),
			}
		}
		if isCodeArtsQueueError(resp.StatusCode, body) {
			// 排队/并发上限：等 10s 后用同一个 Key 重发（ref 同款；由代理的
			// maxQueueAttempts 兜 30 分钟上限）。
			_ = resp.Body.Close()
			return nil, queueRetryMs, nil
		}
		// 其它错误原样透传（代理统一分类/展示）—— 必须把已读走的 body 还回去。
		_ = resp.Body.Close()
		resp.Body = io.NopCloser(bytes.NewReader(raw))
		return nil, 0, nil
	}

	// 2xx：peek 首个 `data:` 帧（或非 SSE 的整个 JSON 体），检查 error_code。
	peeked, firstLine, _ := peekFirstSSEDataLine(resp.Body)
	payload := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(firstLine), "data:"))
	if payload == "" && len(peeked) > 0 {
		// 非 SSE（没有 data: 行）：把已读部分当 JSON 体检查。
		payload = strings.TrimSpace(string(peeked))
	}
	if code, msg, ok := codeartsErrorFrame(payload); ok {
		_ = resp.Body.Close()
		// 额度用尽（`InferHub.4291.200`，不可重试）：必须排在排队判据之前
		// （否则 4291 命中排队正则的 429 前缀 → 30 分钟静默重试零输出，
		// ref 784210d 的真实报障）。锁 key+model 至 UTC+8 当日 24:00 并换号，
		// 与 qoder 的 110 / opencode 额度错误同款。
		if isCodeArtsSSEQuotaExhausted(code, msg) {
			if msg == "" {
				msg = "insufficient quota"
			}
			return nil, 0, &upstreamerr.BillingLockError{
				Until:  time.UnixMilli(NextUtc8DayStartMs(nowMillis())),
				Reason: fmt.Sprintf("codearts: %s %s（模型 %s 免费额度已用尽，预计 UTC+8 当日 24:00 重置）", code, msg, upstreamModel),
			}
		}
		if isCodeArtsSSEQueueCode(code) {
			return nil, queueRetryMs, nil
		}
		// 该账号没有 benefit 包（积分制账户）：去掉 `maas_type: benefit` 后
		// 同一 Key 重试一次（ref 3bf2be7）。重试循环把「丢弃该头」写进回环标记，
		// augmenter 在下次尝试时跳过它；标记已在 ⇒ 已经试过，按真实失败处理。
		if code == codeartsBenefitNotFoundCode && isCodeArtsBenefitModel(upstreamModel) && retryDropHeaderOf(clientReq) != "maas_type" {
			if msg == "" {
				msg = "no error_msg"
			}
			return nil, 0, &upstreamerr.SameKeyRetryError{
				Header: "maas_type",
				Reason: fmt.Sprintf("codearts: %s %s (retrying without maas_type)", code, msg),
			}
		}
		// 非排队错误（如 `InferHub.4004.200 benefit not found`）：让本次尝试失败，
		// 由代理按错误分类处理（换号/重试/把真实原因报给客户端），而不是返回
		// 一个空回复。
		if msg == "" {
			msg = "no error_msg"
		}
		return nil, 0, fmt.Errorf("codearts: %s %s", code, msg)
	}
	// 正常流：把 peek 到的字节原样接回去（一个字节都不能丢）。
	return io.MultiReader(bytes.NewReader(peeked), resp.Body), 0, nil
}
