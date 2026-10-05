package jethub

// Gemini 协议桥（R3-3）：进站 OpenAI chat → 上游 Cloud Code 双层信封；上游
// SSE → OpenAI chunk。与 zcode/minimax 同款架构：augmenter 改写出站请求，
// InterceptResponse 转换回客户端协议。
//
// 三条上游对齐细节（ref gemini.ts / gemini-messages.ts，实测基准）：
//  1. 身份五头逐字写死；流式刻意**不带 Accept** 头。
//  2. 信封逐层字母序序列化（geminiMarshalAlphabetical）。
//  3. role 只有 user/model；历史 thinking 块不回传；functionResponse 以
//     **name** 配对（上游没有 id 字段）。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// geminiDefaultMaxTokens 是客户端未指定时的输出预算（ref generationConfig
// 的 maxOutputTokens ?? 64000）。
const geminiDefaultMaxTokens = 64000

// geminiAugment implements RequestAugmenterFunc for gemini: swap the header
// family and rewrite the OpenAI body into the two-layer envelope.
func (m *Manager) geminiAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	cred, err := m.geminiCredentialFor(keyID)
	if err != nil {
		return nil, err
	}
	// 过期则续期一次（401 先续期的上游口径在出站前就消化掉大半：凭据 60s
	// 余量内直接换新，省一次注定失败的请求）。
	if geminiExpired(cred, time.Now()) {
		if refreshed, rerr := m.refreshGeminiAccountCredential(context.Background(), keyID); rerr == nil {
			cred = refreshed
		}
		// 续期失败不阻塞：让请求发出去，401 由响应侧分类（ref 同口径）。
	}
	for k, v := range geminiIdentityHeaders() {
		r.Header.Set(k, v)
	}
	r.Header.Set("Authorization", "Bearer "+cred.AccessToken)
	r.Header.Set("Content-Type", "application/json")
	// ⚠️ 流式刻意不带 Accept（抓包一致）。

	envelope, err := m.geminiBuildEnvelope(r, body, upstreamModel, cred)
	if err != nil {
		return nil, err
	}
	return geminiMarshalAlphabetical(envelope)
}

// geminiBuildEnvelope converts the inbound OpenAI body to the Cloud Code
// envelope（返回值已是字母序归一的 map；序列化走 geminiMarshalAlphabetical）。
func (m *Manager) geminiBuildEnvelope(r *http.Request, body []byte, upstreamModel string, cred *GeminiCredential) (map[string]any, error) {
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("jethub: gemini body not JSON: %w", err)
	}
	if parsed == nil {
		return nil, fmt.Errorf("jethub: gemini body is not an object")
	}
	canonical, err := geminiValidateModel(upstreamModel)
	if err != nil {
		return nil, err
	}
	// 档位：客户端经 {prefix}/{model}-{tier} 选档（ModelDef 表只暴露裸名，
	// 档位后缀是本端约定的「带档位的模型名」，与 ref 的 efforts 下拉等价——
	// 限流标记/探测链路传带档位名时 geminiCanonicalModelId 已归一）。
	tier := geminiDefaultEffort
	upstream := canonical
	for _, t := range geminiEffortIDs {
		if strings.HasSuffix(upstreamModel, "-"+t) {
			tier = t
			upstream = canonical + "-" + t
			break
		}
	}
	if tier == geminiDefaultEffort && !strings.HasSuffix(upstreamModel, "-"+geminiDefaultEffort) {
		// 无显式档位后缀：默认 medium。
		upstream = canonical + "-" + geminiDefaultEffort
	}

	contents, systemText, toolDecls, err := geminiConvertMessages(parsed["messages"])
	if err != nil {
		return nil, err
	}
	if len(contents) == 0 {
		return nil, fmt.Errorf("jethub: gemini 请求没有可用内容")
	}

	request := map[string]any{
		"contents":  contents,
		"sessionId": geminiSessionInfr,
		"generationConfig": map[string]any{
			"maxOutputTokens": geminiMaxOutputOf(parsed),
			"thinkingConfig":  geminiThinkingConfig(tier),
		},
	}
	if systemText != "" {
		request["systemInstruction"] = map[string]any{
			"role":  "system",
			"parts": []any{map[string]any{"text": systemText}},
		}
	}
	if toolDecls != nil {
		request["tools"] = []any{map[string]any{"functionDeclarations": toolDecls}}
	}
	if cfg := geminiToolConfig(parsed["tool_choice"], parsed["tools"]); cfg != nil {
		request["toolConfig"] = cfg
	}
	if temp, ok := parsed["temperature"].(float64); ok {
		request["generationConfig"].(map[string]any)["temperature"] = temp
	}

	return map[string]any{
		"model":     upstream,
		"project":   geminiProjectOf(cred),
		"request":   request,
		"requestId": newGeminiRequestId(time.Now().UnixMilli()),
		"userAgent": geminiUpstreamUA,
	}, nil
}

// geminiMaxOutputOf reads max_tokens / max_completion_tokens（缺省 64000）。
func geminiMaxOutputOf(parsed map[string]any) int64 {
	for _, key := range []string{"max_tokens", "max_completion_tokens"} {
		if v, ok := parsed[key].(float64); ok && v > 0 {
			return int64(v)
		}
	}
	return geminiDefaultMaxTokens
}

// geminiThinkingConfig builds thinkingConfig：includeThoughts 恒 true（假关）；
// tiered 不发 thinkingBudget。
func geminiThinkingConfig(tier string) map[string]any {
	cfg := map[string]any{"includeThoughts": true}
	if budget := geminiThinkingBudget(tier); budget >= 0 {
		cfg["thinkingBudget"] = budget
	}
	return cfg
}

// geminiProjectOf: upstream project（凭据记录优先，缺省 aicode-consumers）。
func geminiProjectOf(cred *GeminiCredential) string {
	if cred != nil && cred.Project != "" {
		return cred.Project
	}
	return geminiProject
}

// geminiConvertMessages converts OpenAI messages → upstream contents.
// 返回 (contents, systemText, toolDeclarations, error)。
func geminiConvertMessages(raw any) ([]any, string, []any, error) {
	list, _ := raw.([]any)
	// 先扫全消息建 tool_call_id → name 映射（functionResponse 以 name 配对）。
	callNames := map[string]string{}
	for _, msg := range list {
		m, ok := msg.(map[string]any)
		if !ok {
			continue
		}
		if calls, ok := m["tool_calls"].([]any); ok {
			for _, call := range calls {
				c, ok := call.(map[string]any)
				if !ok {
					continue
				}
				id, _ := c["id"].(string)
				fn, _ := c["function"].(map[string]any)
				name, _ := fn["name"].(string)
				if id != "" && name != "" {
					callNames[id] = name
				}
			}
		}
	}

	var contents []any
	systemText := ""
	for _, msg := range list {
		m, ok := msg.(map[string]any)
		if !ok {
			continue
		}
		role, _ := m["role"].(string)
		if role == "system" || role == "developer" {
			if systemText == "" {
				systemText = systemTextOf(m["content"])
			}
			continue
		}
		upRole := "user"
		if role == "assistant" {
			upRole = "model"
		}
		parts, err := geminiConvertParts(m, callNames)
		if err != nil {
			return nil, "", nil, err
		}
		if len(parts) == 0 {
			continue
		}
		contents = append(contents, map[string]any{"role": upRole, "parts": parts})
	}

	// tools：OpenAI [{type:function,function:{name,description,parameters}}]
	return contents, systemText, nil, nil
}

// geminiConvertTools converts OpenAI tools → functionDeclarations
// （schema 白名单清洗：白名单外的键上游硬 400）。
func geminiConvertTools(raw any) []any {
	tools, ok := raw.([]any)
	if !ok || len(tools) == 0 {
		return nil
	}
	out := make([]any, 0, len(tools))
	for _, tool := range tools {
		t, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		fn, _ := t["function"].(map[string]any)
		name, _ := fn["name"].(string)
		if name == "" {
			continue
		}
		decl := map[string]any{"name": name}
		if desc, ok := fn["description"].(string); ok {
			decl["description"] = desc
		}
		if params, ok := fn["parameters"].(map[string]any); ok {
			decl["parameters"] = geminiSanitizeSchema(params)
		}
		out = append(out, decl)
	}
	return out
}

// systemTextOf flattens a system/developer content to text.
func systemTextOf(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var out []string
		for _, block := range t {
			if b, ok := block.(map[string]any); ok {
				if typ, _ := b["type"].(string); typ == "text" {
					if s, ok := b["text"].(string); ok {
						out = append(out, s)
					}
				}
			}
		}
		return strings.Join(out, "\n")
	}
	return ""
}

// intOf converts a float64 JSON number to int (missing/invalid → 0).
func intOf(v any) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return 0
}

// geminiConvertParts converts one message's content to upstream parts.
func geminiConvertParts(m map[string]any, callNames map[string]string) ([]any, error) {
	var parts []any
	appendPart := func(p map[string]any) { parts = append(parts, p) }

	// assistant 的 tool_calls → functionCall parts。
	if calls, ok := m["tool_calls"].([]any); ok {
		for _, call := range calls {
			c, ok := call.(map[string]any)
			if !ok {
				continue
			}
			fn, _ := c["function"].(map[string]any)
			name, _ := fn["name"].(string)
			if name == "" {
				continue // 无名 tool_call 丢弃（上游按 name 配对）
			}
			args := map[string]any{}
			if raw, ok := fn["arguments"].(string); ok && strings.TrimSpace(raw) != "" {
				_ = json.Unmarshal([]byte(raw), &args)
			}
			appendPart(map[string]any{"functionCall": map[string]any{"name": name, "args": args}})
		}
	}

	// role:tool → functionResponse（name 来自配对的 tool_use；空 name 整块丢）。
	if role, _ := m["role"].(string); role == "tool" {
		id, _ := m["tool_call_id"].(string)
		name := callNames[id]
		if name == "" {
			return parts, nil
		}
		text := toolContentText(m["content"])
		response := map[string]any{"content": text}
		appendPart(map[string]any{"functionResponse": map[string]any{"name": name, "response": response}})
		return parts, nil
	}

	// 文本 / 图片 / reasoning。
	switch content := m["content"].(type) {
	case string:
		if content != "" {
			appendPart(map[string]any{"text": content})
		}
	case []any:
		for _, block := range content {
			b, ok := block.(map[string]any)
			if !ok {
				continue
			}
			typ, _ := b["type"].(string)
			switch typ {
			case "text":
				text, _ := b["text"].(string)
				if text != "" {
					appendPart(map[string]any{"text": text})
				}
			case "image_url":
				dataURL, mediaType, ok := imageDataURL(b["image_url"])
				if !ok {
					return nil, fmt.Errorf("gemini: 图片未能内联（仅支持 data:URL，拒绝发出缺少图片的请求）")
				}
				appendPart(map[string]any{"inlineData": map[string]any{"mimeType": mediaType, "data": dataURL}})
			case "reasoning":
				// 历史 reasoning 不回传正文（ref 同款）。
			}
		}
	}
	return parts, nil
}

// imageDataURL extracts bare base64 + mime from an OpenAI image_url block.
func imageDataURL(v any) (data, mediaType string, ok bool) {
	obj, ok := v.(map[string]any)
	if !ok {
		return "", "", false
	}
	u, ok := obj["url"].(string)
	if !ok || !strings.HasPrefix(u, "data:") {
		return "", "", false
	}
	comma := strings.Index(u, ",")
	if comma < 0 {
		return "", "", false
	}
	meta := u[5:comma]
	payload := u[comma+1:]
	if i := strings.Index(meta, ";"); i >= 0 {
		mediaType = meta[:i]
	} else {
		mediaType = meta
	}
	if mediaType == "" {
		mediaType = "image/png"
	}
	if payload == "" {
		return "", "", false
	}
	return payload, mediaType, true
}

// toolContentText flattens tool result content to text（response.content 只吃文本）。
func toolContentText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var out []string
		for _, block := range t {
			if b, ok := block.(map[string]any); ok {
				if typ, _ := b["type"].(string); typ == "text" {
					if s, ok := b["text"].(string); ok {
						out = append(out, s)
					}
				}
			} else if s, ok := block.(string); ok {
				out = append(out, s)
			}
		}
		return strings.Join(out, "\n")
	}
	return ""
}

// geminiToolConfig converts OpenAI tool_choice → upstream toolConfig.
// 默认 AUTO（ref buildToolConfig；OpenAI body 里 tools 在 body["tools"]）。
func geminiToolConfig(toolChoice, toolsRaw any) map[string]any {
	tools, ok := toolsRaw.([]any)
	if !ok || len(tools) == 0 {
		return nil
	}
	mode := "AUTO"
	var allowed []string
	switch tc := toolChoice.(type) {
	case string:
		switch tc {
		case "none":
			mode = "NONE"
		case "required", "any":
			mode = "ANY"
		}
	case map[string]any:
		typ, _ := tc["type"].(string)
		switch typ {
		case "none":
			mode = "NONE"
		case "any", "required":
			mode = "ANY"
		case "tool", "function":
			mode = "ANY"
			fn, _ := tc["function"].(map[string]any)
			name, _ := fn["name"].(string)
			if name != "" {
				allowed = []string{name}
			}
		}
	}
	cfg := map[string]any{"functionCallingConfig": map[string]any{"mode": mode}}
	if allowed != nil {
		cfg["functionCallingConfig"].(map[string]any)["allowedFunctionNames"] = allowed
	}
	return cfg
}

// ---------------------------------------------------------------------------
// 响应侧：上游 SSE → OpenAI chunk
// ---------------------------------------------------------------------------

// geminiInterceptResponse implements the response-side hook: convert Gemini
// SSE to OpenAI chat chunks (stream) or an aggregated chat.completion object
// (non-stream). Anthropic 进站不存在（gemini 只服务 OpenAI 客户端）。
func (m *Manager) geminiInterceptResponse(clientReq *http.Request, resp *http.Response, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	if resp.StatusCode >= 400 {
		return geminiRewriteErrorBody(resp, upstreamModel)
	}
	peeked, firstLine, _ := peekFirstSSEDataLine(resp.Body)
	src := io.MultiReader(bytes.NewReader(peeked), resp.Body)
	if msg, ok := geminiFirstErrorFrame(firstLine); ok {
		_ = resp.Body.Close()
		return nil, 0, fmt.Errorf("gemini: 流内错误：%s", msg)
	}
	model := upstreamModel
	if model == "" {
		model = geminiUpstreamFlash
	}
	if isStream {
		return newGeminiSSEReader(src, model), 0, nil
	}
	body, err := geminiAggregateSSE(src, model)
	if err != nil {
		return nil, 0, err
	}
	resp.Header.Set("Content-Type", "application/json; charset=utf-8")
	resp.Header.Del("Content-Length")
	resp.ContentLength = -1
	return bytes.NewReader(body), 0, nil
}

// geminiFirstErrorFrame inspects the first SSE frame for an upstream error
// ({"error":{code,message}}；内容帧恒无 error 字段)。
func geminiFirstErrorFrame(firstLine string) (string, bool) {
	payload := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(firstLine), "data:"))
	if payload == "" || payload == "[DONE]" || !strings.HasPrefix(payload, "{") {
		return "", false
	}
	var frame struct {
		Error *struct {
			Code    any    `json:"code"`
			Message string `json:"message"`
			Status  string `json:"status"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(payload), &frame) != nil || frame.Error == nil {
		return "", false
	}
	msg := frame.Error.Message
	if msg == "" {
		msg = frame.Error.Status
	}
	if msg == "" {
		msg = "unknown error"
	}
	return msg, true
}

// geminiRewriteErrorBody wraps upstream 4xx/5xx into the proxy's error shape
// （透传状态码；签名被拒的错误文案留给响应侧重试判据识别——本端对签名被拒
// 的重试在 augmenter 出站前已消化大半，残余透传给代理统一分类）。
func geminiRewriteErrorBody(resp *http.Response, upstreamModel string) (io.Reader, int64, error) {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()
	return bytes.NewReader(raw), 0, nil
}

// geminiFrameState tracks the open frame while converting SSE.
type geminiFrameState struct {
	model   string
	created int64
	toolIdx int
}

// geminiPartToOpenAI converts one upstream part → OpenAI delta pieces.
// 返回 (content, reasoning, toolCallJSON, ok)。
type geminiDelta struct {
	content   string
	reasoning string
	toolCall  *map[string]any
}

func geminiPartToDelta(state *geminiFrameState, part map[string]any) geminiDelta {
	out := geminiDelta{}
	if fc, ok := part["functionCall"].(map[string]any); ok {
		name, _ := fc["name"].(string)
		args := fc["args"]
		argsJSON := geminiCanonicalArgs(args)
		state.toolIdx++
		call := map[string]any{
			"index": state.toolIdx - 1,
			"id":    fmt.Sprintf("call_gemini_%d_%d", state.created, state.toolIdx),
			"type":  "function",
			"function": map[string]any{
				"name":      name,
				"arguments": argsJSON,
			},
		}
		out.toolCall = &call
		return out
	}
	text, _ := part["text"].(string)
	if text == "" {
		return out
	}
	if thought, _ := part["thought"].(bool); thought {
		out.reasoning = text
	} else {
		out.content = text
	}
	return out
}

// geminiSSEConverter turns Gemini frames into OpenAI chunk frames.
type geminiSSEConverter struct {
	state      geminiFrameState
	sigs       *geminiSigStore
	finish     string
	usage      map[string]any
	usageTotal float64
}

func newGeminiSSEConverter(model string, sigs *geminiSigStore) *geminiSSEConverter {
	return &geminiSSEConverter{
		state: geminiFrameState{model: model, created: time.Now().Unix()},
		sigs:  sigs,
	}
}

// convert consumes one upstream SSE frame, returns 0..n OpenAI frames.
func (c *geminiSSEConverter) convert(payload string) []string {
	payload = strings.TrimSpace(payload)
	if payload == "" || payload == "[DONE]" {
		return nil
	}
	var frame map[string]any
	if json.Unmarshal([]byte(payload), &frame) != nil {
		return nil
	}
	// 信封形态 {"response":{…}} 或裸 Response（ref 同序）。
	inner, ok := frame["response"].(map[string]any)
	if !ok {
		inner = frame
	}
	if errObj, ok := frame["error"].(map[string]any); ok {
		msg, _ := errObj["message"].(string)
		return []string{openAIErrorFrame(msg, c.state.model)}
	}
	candidates, _ := inner["candidates"].([]any)
	if len(candidates) == 0 {
		// 纯 usageMetadata 帧：记用量不算内容（ref 口径）。
		c.noteUsage(inner["usageMetadata"])
		return nil
	}
	c.noteUsage(inner["usageMetadata"])

	var frames []string
	candidate, _ := candidates[0].(map[string]any)
	if fr, ok := candidate["finishReason"].(string); ok && fr != "" {
		c.finish = fr
	}
	content, _ := candidate["content"].(map[string]any)
	parts, _ := content["parts"].([]any)
	for _, p := range parts {
		part, ok := p.(map[string]any)
		if !ok {
			continue
		}
		// functionCall 签名收集（只存 functionCall 上的，ref 口径）。
		if fc, ok := part["functionCall"].(map[string]any); ok {
			if sig, ok := part["thoughtSignature"].(string); ok && sig != "" {
				name, _ := fc["name"].(string)
				c.sigs.put(name, geminiCanonicalArgs(fc["args"]), sig)
			}
		}
		delta := geminiPartToDelta(&c.state, part)
		frames = append(frames, c.openAIDeltaFrame(delta)...)
	}
	return frames
}

// noteUsage keeps the copy with the LARGEST totalTokenCount（上游多帧重复
// 播报 usage，早期帧偏小）。
func (c *geminiSSEConverter) noteUsage(raw any) {
	m, ok := raw.(map[string]any)
	if !ok {
		return
	}
	total, _ := m["totalTokenCount"].(float64)
	if total <= c.usageTotal {
		return
	}
	c.usageTotal = total
	c.usage = map[string]any{
		"prompt_tokens":     intOf(m["promptTokenCount"]),
		"completion_tokens": intOf(m["candidatesTokenCount"]),
		"total_tokens":      intOf(m["totalTokenCount"]),
	}
}

// openAIDeltaFrame renders one delta as an OpenAI chat chunk frame.
func (c *geminiSSEConverter) openAIDeltaFrame(delta geminiDelta) []string {
	if delta.content == "" && delta.reasoning == "" && delta.toolCall == nil {
		return nil
	}
	chunkDelta := map[string]any{}
	if delta.content != "" {
		chunkDelta["content"] = delta.content
	}
	if delta.reasoning != "" {
		chunkDelta["reasoning_content"] = delta.reasoning
	}
	if delta.toolCall != nil {
		chunkDelta["tool_calls"] = []any{*delta.toolCall}
	}
	frame := map[string]any{
		"id":      fmt.Sprintf("chatcmpl-gemini-%d", c.state.created),
		"object":  "chat.completion.chunk",
		"created": c.state.created,
		"model":   c.state.model,
		"choices": []any{map[string]any{"index": 0, "delta": chunkDelta}},
	}
	b, _ := json.Marshal(frame)
	return []string{string(b)}
}

// finishFrames emits the final usage frame + [DONE]（与 minimax 聚合器同款）。
func (c *geminiSSEConverter) finishFrames() []string {
	finish := "stop"
	switch c.finish {
	case "MAX_TOKENS":
		finish = "length"
	case "STOP", "STOP_SEQUENCE", "FINISH_REASON_UNSPECIFIED", "":
		finish = "stop"
	default:
		finish = "stop"
	}
	final := map[string]any{
		"id":      fmt.Sprintf("chatcmpl-gemini-%d", c.state.created),
		"object":  "chat.completion.chunk",
		"created": c.state.created,
		"model":   c.state.model,
		"choices": []any{map[string]any{
			"index":         0,
			"delta":         map[string]any{},
			"finish_reason": finish,
		}},
	}
	if c.usage != nil {
		final["usage"] = c.usage
	}
	b, _ := json.Marshal(final)
	return []string{string(b), "[DONE]"}
}

// openAIErrorFrame renders an upstream error as an OpenAI error chunk.
func openAIErrorFrame(msg, model string) string {
	frame := map[string]any{
		"error": map[string]any{
			"message": msg,
			"type":    "upstream_error",
			"code":    "gemini_error",
		},
	}
	b, _ := json.Marshal(frame)
	return string(b)
}

// geminiSSEReader streams converted OpenAI frames（与 minimaxSSEReader 同款：
// 尾部余量按整行再走一遍，否则被截断流的末帧静默丢失）。
type geminiSSEReader struct {
	src       io.Reader
	buffer    bytes.Buffer
	out       bytes.Buffer
	converter *geminiSSEConverter
	done      bool
	tailErr   error
}

func newGeminiSSEReader(src io.Reader, model string) *geminiSSEReader {
	return &geminiSSEReader{
		src:       src,
		converter: newGeminiSSEConverter(model, managerSigs),
	}
}

// managerSigs is the process-wide signature store (Manager 常驻，签名缓存
// 不落盘——见 geminiSigStore 注释)。
var managerSigs = newGeminiSigStore()

func (r *geminiSSEReader) Read(p []byte) (int, error) {
	for r.out.Len() == 0 && !r.done {
		if r.tailErr != nil {
			return 0, r.tailErr
		}
		buf := make([]byte, 8192)
		n, err := r.src.Read(buf)
		if n > 0 {
			r.buffer.Write(buf[:n])
			r.emitCompleteLines()
		}
		if err != nil {
			// 收尾：余量按整行再走一遍（真实缺陷：不处理则末帧静默丢弃），
			// 然后补 finish + [DONE]。
			if rest := r.buffer.String(); rest != "" {
				r.processEvent(rest)
				r.buffer.Reset()
			}
			for _, frame := range r.converter.finishFrames() {
				r.out.WriteString("data: " + frame + "\n\n")
			}
			r.done = true
			r.tailErr = err
			if r.out.Len() == 0 {
				return 0, err
			}
			break
		}
	}
	if r.out.Len() == 0 {
		return 0, io.EOF
	}
	return r.out.Read(p)
}

// emitCompleteLines processes every complete SSE event in the buffer.
func (r *geminiSSEReader) emitCompleteLines() {
	data := r.buffer.String()
	for {
		idx := strings.Index(data, "\n")
		if idx < 0 {
			break
		}
		line := strings.TrimRight(data[:idx], "\r")
		data = data[idx+1:]
		r.processLine(line)
	}
	r.buffer.Reset()
	r.buffer.WriteString(data)
}

// processLine handles one SSE line（"data: …" 事件）。
func (r *geminiSSEReader) processLine(line string) {
	if !strings.HasPrefix(line, "data:") {
		return
	}
	payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
	if payload == "" {
		return
	}
	if payload == "[DONE]" {
		for _, frame := range r.converter.finishFrames() {
			r.out.WriteString("data: " + frame + "\n\n")
		}
		r.done = true
		return
	}
	for _, frame := range r.converter.convert(payload) {
		r.out.WriteString("data: " + frame + "\n\n")
	}
}

// processEvent consumes a possibly multi-line leftover chunk at EOF.
func (r *geminiSSEReader) processEvent(chunk string) {
	for _, line := range strings.Split(chunk, "\n") {
		r.processLine(strings.TrimRight(line, "\r"))
	}
}

// geminiAggregateSSE buffers the whole stream into one chat.completion object.
func geminiAggregateSSE(src io.Reader, model string) ([]byte, error) {
	reader := newGeminiSSEReader(src, model)
	var out bytes.Buffer
	buf := make([]byte, 8192)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			out.Write(buf[:n])
		}
		if err != nil {
			break
		}
	}
	// out 现在是 SSE 文本；把 data: 帧聚合回一个对象。
	content := strings.Builder{}
	reasoning := strings.Builder{}
	var toolCalls []any
	var usage map[string]any
	finish := "stop"
	var frames []string
	for _, line := range strings.Split(out.String(), "\n") {
		line = strings.TrimRight(line, "\r")
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data: "))
		if payload == "[DONE]" {
			continue
		}
		frames = append(frames, payload)
	}
	for _, payload := range frames {
		var frame struct {
			Choices []struct {
				Delta struct {
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
					ToolCalls        []any  `json:"tool_calls"`
				} `json:"delta"`
				FinishReason any `json:"finish_reason"`
				Index        int `json:"index"`
			} `json:"choices"`
			Usage map[string]any `json:"usage"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(payload), &frame) != nil {
			continue
		}
		if frame.Error != nil {
			return nil, fmt.Errorf("gemini: %s", frame.Error.Message)
		}
		if frame.Usage != nil {
			usage = frame.Usage
		}
		for _, choice := range frame.Choices {
			content.WriteString(choice.Delta.Content)
			reasoning.WriteString(choice.Delta.ReasoningContent)
			toolCalls = append(toolCalls, choice.Delta.ToolCalls...)
			if choice.FinishReason != nil {
				if s, ok := choice.FinishReason.(string); ok && s != "" {
					finish = s
				}
			}
		}
	}
	message := map[string]any{"role": "assistant", "content": content.String()}
	if reasoning.Len() > 0 {
		message["reasoning_content"] = reasoning.String()
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}
	resp := map[string]any{
		"id":      fmt.Sprintf("chatcmpl-gemini-%d", time.Now().Unix()),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{map[string]any{
			"index": 0, "message": message, "finish_reason": finish,
		}},
	}
	if usage != nil {
		resp["usage"] = usage
	}
	return json.Marshal(resp)
}

// ---------------------------------------------------------------------------
// Manager 接线
// ---------------------------------------------------------------------------

// geminiSyncMutex serializes concurrent refreshes for the same credential
// （并发消费同一 refresh_token 会「1 成功 N invalid_grant」——codearts R1-2
// 同款教训；本端 per-credentialRef 串行）。
var geminiRefreshLocks sync.Map

// refreshGeminiAccountCredential renews the credential stored under keyID
// （keyID 即 account id）并回写。
func (m *Manager) refreshGeminiAccountCredential(ctx context.Context, accountID string) (*GeminiCredential, error) {
	lockAny, _ := geminiRefreshLocks.LoadOrStore(accountID, &sync.Mutex{})
	lock := lockAny.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()

	acc, ok := m.FindAccount(accountID)
	if !ok {
		return nil, ErrNotFound
	}
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		return nil, fmt.Errorf("jethub: credential missing for %s", accountID)
	}
	var cred GeminiCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse gemini credential %s: %w", accountID, err)
	}
	// 锁内重读：有效期内直接跳过（他处刚续期过）。
	if !geminiExpired(&cred, time.Now()) && cred.AccessToken != "" {
		return &cred, nil
	}
	if cred.RefreshToken == "" {
		return nil, fmt.Errorf("gemini: 没有 refresh_token，需要重新授权")
	}
	grant, err := m.RefreshGeminiCredential(ctx, cred.RefreshToken)
	if err != nil {
		return nil, err
	}
	refreshed := geminiApplyGrant(&cred, grant, time.Now())
	credJSON, err := json.Marshal(refreshed)
	if err != nil {
		return nil, err
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, GeminiExpiresAtMs(refreshed), GeminiRefreshable(refreshed)); err != nil {
		return nil, err
	}
	return refreshed, nil
}

// RefreshGeminiAccount renews one stored credential（API 手动续期入口）。
func (m *Manager) RefreshGeminiAccount(ctx context.Context, accountID string) error {
	_, err := m.refreshGeminiAccountCredential(ctx, accountID)
	return err
}

// CompleteGeminiLogin persists the credential（占位账号落凭据）。
func (m *Manager) CompleteGeminiLogin(accountID string, cred *GeminiCredential) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	credJSON, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	return m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, GeminiExpiresAtMs(cred), GeminiRefreshable(cred))
}
