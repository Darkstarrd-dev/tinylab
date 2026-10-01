package jethub

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// Qoder 加密端点响应解包 —— 1:1 移植 ref qoder-envelope.ts。
//
// 加密端点的响应是 SSE，但每帧多一层信封：
//
//	data:{"headers":{...},"body":"{\"choices\":[...]}","statusCodeValue":200,"statusCode":"OK"}
//	                       ↑ 内层才是标准 OpenAI chunk（JSON 字符串，未加密）
//
// 只做「剥信封」，不涉及任何解密。错误形态必须抛出/分类而不是当成无内容
// —— 否则会重演「静默停止」缺陷。⚠️ 转发错误帧必须保留独立 `code` 字段且
// `message` 不拼后缀（保真转发）：旧实现把 {code,message} 降级重组为
// {error:{message:"… (10605)"}} 会 ① 丢掉排队识别依赖的 code、② 污染
// message 里的内层 JSON 使二次解析拿不到 retryAfterSeconds。

// qoderEnvelopeInnerText extracts the inner frame text; ok=false when the
// payload is not an envelope (no "body" field — treat as an already-standard
// frame). body 是字符串时取字符串，其他类型 JSON 序列化（ref innerTextOf）。
func qoderEnvelopeInnerText(payload string) (string, bool) {
	var probe struct {
		Body *json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal([]byte(payload), &probe); err != nil {
		return "", false
	}
	if probe.Body == nil {
		return "", false
	}
	var s string
	if err := json.Unmarshal(*probe.Body, &s); err == nil {
		return s, true
	}
	return string(*probe.Body), true
}

// qoderEnvelopeReader wraps an envelope SSE stream into a standard OpenAI SSE
// stream (line-wise transform; non-data lines like `event: error` pass
// through for diagnostics; `[DONE]` passes through).
type qoderEnvelopeReader struct {
	src     io.Reader
	in      []byte // unprocessed input (may start with peeked bytes)
	out     []byte // processed output pending delivery
	eof     bool
	flushed bool
}

func newQoderEnvelopeReader(src io.Reader, prefill []byte) *qoderEnvelopeReader {
	return &qoderEnvelopeReader{src: src, in: append([]byte(nil), prefill...)}
}

func (r *qoderEnvelopeReader) Read(p []byte) (int, error) {
	for len(r.out) == 0 {
		if r.eof {
			if !r.flushed {
				r.flushed = true
				// ref flush(): 只处理尾部残留的 data: 行，其余丢弃。
				if rest := strings.TrimSpace(string(r.in)); rest != "" {
					r.in = nil
					if out := qoderFlushSSELine(rest); out != nil {
						r.out = append(r.out, out...)
					}
				}
			}
			if len(r.out) == 0 {
				return 0, io.EOF
			}
			break
		}
		if err := r.pull(); err != nil {
			if err == io.EOF {
				r.eof = true
				continue
			}
			return 0, err
		}
	}
	n := copy(p, r.out)
	r.out = r.out[n:]
	return n, nil
}

// pull reads more input and processes every COMPLETE line into out.
func (r *qoderEnvelopeReader) pull() error {
	buf := make([]byte, 16_384)
	n, err := r.src.Read(buf)
	if n > 0 {
		r.in = append(r.in, buf[:n]...)
	}
	// ⚠️ prefill（peek 已读字节）可能已含完整行 —— 无论本次是否读到新数据
	// 都要处理一遍完整行（否则 EOF 时机下 prefill 永远不被消费）。
	for {
		idx := bytes.IndexByte(r.in, '\n')
		if idx < 0 {
			break
		}
		line := string(r.in[:idx])
		r.in = r.in[idx+1:]
		r.out = append(r.out, qoderTransformSSELine(strings.TrimSuffix(line, "\r"))...)
	}
	return err
}

// qoderTransformSSELine transforms one complete SSE line.
func qoderTransformSSELine(line string) []byte {
	if line == "" {
		return []byte("\n")
	}
	if !strings.HasPrefix(line, "data:") {
		// event: 等行原样保留（`event: error` 对诊断有价值）。
		return []byte(line + "\n")
	}
	payload := strings.TrimSpace(line[len("data:"):])
	if payload == "[DONE]" {
		return []byte("data: [DONE]\n")
	}
	inner, ok := qoderEnvelopeInnerText(payload)
	if !ok {
		// 不是信封 → 原样透传（容错：服务端某天直接回标准帧）。
		return []byte("data: " + payload + "\n")
	}
	if !strings.Contains(inner, `"choices"`) && !strings.Contains(inner, "[DONE]") {
		// 业务错误：内层是错误 JSON 而非 choices → 保真转发
		// {code?, message, type:'model_error'}。
		return []byte("data: " + qoderFaithfulErrorFrame(inner) + "\n")
	}
	return []byte("data: " + inner + "\n")
}

// qoderFlushSSELine handles a trailing partial line at stream end (ref
// flush(): only a trailing data: line is unwrapped, everything else drops).
func qoderFlushSSELine(rest string) []byte {
	if !strings.HasPrefix(rest, "data:") {
		return nil
	}
	inner, ok := qoderEnvelopeInnerText(strings.TrimSpace(rest[len("data:"):]))
	if !ok {
		return nil
	}
	return []byte("data: " + inner + "\n")
}

// qoderFaithfulErrorFrame converts an inner error JSON into the faithful
// {code?, message, type:'model_error'} frame. ⚠️ code 独立、message 原样
// （不拼后缀 —— 后缀会污染排队 message 里的内层 JSON）。
func qoderFaithfulErrorFrame(inner string) string {
	parsed := struct {
		Code    json.RawMessage `json:"code"`
		Message json.RawMessage `json:"message"`
	}{}
	_ = json.Unmarshal([]byte(inner), &parsed)
	frame := map[string]any{"type": "model_error"}
	if len(parsed.Code) > 0 && string(parsed.Code) != "null" {
		var code any
		if json.Unmarshal(parsed.Code, &code) == nil {
			frame["code"] = code
		}
	}
	if len(parsed.Message) > 0 {
		var msg string
		if json.Unmarshal(parsed.Message, &msg) == nil {
			frame["message"] = msg
		} else {
			frame["message"] = inner // 保持原文（ref: 非字符串 message 用整段）
		}
	} else {
		frame["message"] = inner
	}
	out, _ := json.Marshal(frame)
	return string(out)
}

// qoderPeekFirstDataLine reads src until the first COMPLETE line (or EOF),
// returning the consumed bytes (to be prepended to the forwarded stream) and
// the first line. ⚠️ 排队/计费错误以 200 + 内嵌错误帧下发，只有在内容到达
// 客户端之前截住才能干净重试 —— 错误帧恒在第一帧。
func qoderPeekFirstDataLine(src io.Reader) (peeked []byte, firstLine string, err error) {
	var acc []byte
	buf := make([]byte, 16_384)
	for {
		if idx := bytes.IndexByte(acc, '\n'); idx >= 0 {
			return acc, strings.TrimSuffix(string(acc[:idx]), "\r"), nil
		}
		n, readErr := src.Read(buf)
		if n > 0 {
			acc = append(acc, buf[:n]...)
			// ⚠️ Read 允许同时返回 (n>0, io.EOF) —— 必须先用新数据重查换行，
			// 直接 return 会把「已有完整行」误判成「EOF 无行」。
			continue
		}
		if readErr != nil {
			return acc, "", readErr // EOF before any complete line
		}
		if len(acc) > 1<<20 {
			return acc, "", nil // 防御：超长无换行，停止 peek
		}
	}
}

// qoderClassifyErrorFrame classifies an inner error-frame text (no "choices")
// into the proxy retry semantics. handled=false → 原样转发给客户端（未知错误）。
func qoderClassifyErrorFrame(inner string) (retryAfterMS int64, perr error, handled bool) {
	probe := struct {
		Code    json.RawMessage `json:"code"`
		Type    string          `json:"type"`
		Message string          `json:"message"`
	}{}
	_ = json.Unmarshal([]byte(inner), &probe)
	var code any
	hasCode := false
	if len(probe.Code) > 0 {
		if json.Unmarshal(probe.Code, &code) == nil {
			hasCode = true
		}
	}

	// ① 排队（10605）：ParseQueueError 同时支持整体与内层两种入参；
	//    瞬时排队是 isQueued:false —— 判据不能要求 true。
	if info := ParseQueueError(inner); info != nil {
		ms, ok := QueueDelayMS(info)
		if !ok {
			ms = 1000 // 无合法延迟 → 1s 兜底（ref 惯例）
		}
		return ms, nil, true
	}
	// ② 计费（110 / 文案兜底）→ 当天不可重试，锁到 UTC+8 当日 24:00。
	if (hasCode && IsBillingBusinessCode(code)) || LooksLikeBillingError(inner) {
		return 0, &upstreamerr.BillingLockError{
			Until:  time.UnixMilli(NextUtc8DayStartMs(nowMillis())),
			Reason: "qoder: Billing daily count exceeded (110/model_error)",
		}, true
	}
	// ③ 认证失败（业务码 105 / auth_error）→ 续期凭据（唯一该走 refresh 的情形）。
	if (hasCode && fmtQueueCode(code) == "105") || strings.Contains(inner, "auth_error") {
		return 0, errQoderAuth, true
	}
	// ④ 重复请求 → 直接重发（不续期、不切号）。
	if hasCode && fmtQueueCode(code) == "duplicate_request" || strings.Contains(inner, "duplicate_request") {
		return 100, nil, true
	}
	return 0, nil, false
}
