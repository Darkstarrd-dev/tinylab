package jethub

// Accio 推理增强：OpenAI/Anthropic 进站体 → Gemini 风格 Accio body + 自定义
// 头 + sg_k 查询串（ref accio-adapter.ts stream() + accio.ts buildAccioBody）。
//
// ## 为什么走 Customize 分支而不是静态 InferURL + Augment
//
// `sg_k` 查询参数 = md5(requestId)，而 requestId 同时写进 body（request_id /
// user_request_id）—— URL 与 body **必须共享同一次随机**，静态 InferURL 表达
// 不了这个耦合（qoder 族由 Customize 算 URL 的同款理由）。
//
// ## 两条进站协议
//
//	/v1/chat/completions（OpenAI）→ accioOpenAIToContents
//	/v1/messages（Anthropic）     → accioAnthropicToContents
//
// 两条进站共用同一份 contents 信封；响应侧按进站协议决定输出形状
// （accio_response.go）。
//
// ## 上行模型名
//
// 客户端给的是 slug（`qwen-3-8-flash`），上游要的是 modelCode
// （`1Drift-F8hS3mK7pL2n`）—— accioModelCodeOf 映射（未知 id 原样透传，
// 手写 modelCode 也能直接用）。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// accioCustomize builds the full outbound request for one inference call
// (Customize branch; see the file header for why this is not the static
// InferURL path).
func (m *Manager) accioCustomize(r *http.Request, body []byte, provider, keyID, upstreamModel string) (string, []byte, error) {
	cred, err := m.accioCredentialFor(keyID)
	if err != nil {
		return "", nil, err
	}
	entries := m.accioEntriesFor()
	modelCode := accioModelCodeOf(entries, upstreamModel)

	anthropicEntry := accioIsAnthropicEntry(clientEntryPathOf(r))
	requestID := accioRequestID()
	outBody, err := accioBuildRequest(anthropicEntry, body, modelCode, cred, requestID)
	if err != nil {
		return "", nil, err
	}
	for k, v := range accioHeaders(accioUtdid, cred.Sgcookie) {
		r.Header.Set(k, v)
	}
	// ⚠️ 绝不发 Authorization：token 走 body，头上放了恒 HTTP 200 + 流内 402
	// （ref 实测）。代理对「augmenter 没设 Authorization」的桥接请求会兜底填
	// `Bearer <key>` —— 该兜底对 accio 是**错误**形状，用 loopback 标记关掉
	// （upstreamerr.NoDefaultAuthHeader；探针路径另有同款豁免）。
	r.Header.Set(upstreamerr.NoDefaultAuthHeader, "1")
	return accioInferURLOf(requestID), outBody, nil
}

// accioInferURLOf returns the full inference endpoint with the sg_k query
// (requestID must be the SAME one written into the body).
func accioInferURLOf(requestID string) string {
	return accioGatewayBase + accioLLMPath + "?sg_k=" + url.QueryEscape(accioSgK(requestID))
}

// accioIsAnthropicEntry reports whether the client request went through the
// Anthropic /v1/messages entry rather than the OpenAI chat-completions family
// (minimaxIsAnthropicEntry 同款判据).
func accioIsAnthropicEntry(path string) bool {
	return strings.HasSuffix(strings.TrimSuffix(path, "/"), "/v1/messages")
}

// accioBuildRequest converts the client body and assembles the Accio envelope.
func accioBuildRequest(anthropicEntry bool, body []byte, modelCode string, cred *AccioCredential, requestID string) ([]byte, error) {
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("jethub: accio body not JSON: %w", err)
	}
	if parsed == nil {
		return nil, fmt.Errorf("jethub: accio body is not an object")
	}
	var (
		contents    []any
		system      string
		tools       []any
		temperature any
		maxTokens   any
		err         error
	)
	if anthropicEntry {
		contents, system, tools, temperature, maxTokens, err = accioAnthropicToContents(parsed)
	} else {
		contents, system, tools, temperature, maxTokens, err = accioOpenAIToContents(parsed)
	}
	if err != nil {
		return nil, err
	}
	if len(contents) == 0 {
		return nil, fmt.Errorf("jethub: accio 请求没有可转换的消息")
	}
	envelope := buildAccioBody(accioBodyOptions{
		model:             modelCode,
		accessToken:       cred.AccessToken,
		contents:          contents,
		systemInstruction: system,
		tools:             tools,
		temperature:       temperature,
		maxOutputTokens:   maxTokens,
		utdid:             accioUtdid,
		requestID:         requestID,
	})
	if system != "" {
		envelope["system_instruction"] = system
	}
	out, err := json.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("jethub: accio body marshal: %w", err)
	}
	return out, nil
}

// accioTextOf extracts plain text from an OpenAI content value (string or
// array of text parts; minimaxTextOf 同款).
func accioTextOf(content any) string {
	switch t := content.(type) {
	case string:
		return t
	case []any:
		var sb strings.Builder
		for _, part := range t {
			pm, ok := part.(map[string]any)
			if !ok {
				continue
			}
			if s, ok := pm["text"].(string); ok {
				sb.WriteString(s)
			}
		}
		return sb.String()
	}
	return ""
}

// accioImagePart converts an OpenAI image part into the Gemini-style inline
// part（camel 形态 {inlineData:{mimeType,data}}，accioToSnake 转成上游认的
// inline_data —— ⚠️ 不要改走 properties 子树，那棵子树不参与 snake 转换）。
// 只接受 data: URL；远程地址显式报错（不静默丢图 —— 静默丢弃会让用户以为
// 模型看到了图，ref minimaxImageBlock 的同款纪律）。
func accioImagePart(part map[string]any) (map[string]any, error) {
	imageURL := ""
	if s, ok := part["image_url"].(string); ok {
		imageURL = s
	} else if obj, ok := part["image_url"].(map[string]any); ok {
		imageURL, _ = obj["url"].(string)
	}
	if imageURL == "" {
		return nil, fmt.Errorf("jethub: accio 图片块缺少 image_url")
	}
	mediaType, data, ok := minimaxParseDataURL(imageURL)
	if !ok {
		return nil, fmt.Errorf("jethub: accio 只支持 base64 内联图片（data: URL），收到远程地址；请先把图片转成 data URL")
	}
	return map[string]any{
		"inlineData": map[string]any{"mimeType": mediaType, "data": data},
	}, nil
}

// accioOpenAIToContents converts an OpenAI chat-completions body into
// (contents, systemInstruction, tools, temperature, maxOutputTokens).
//
// ⚠️ 孤儿工具块必须剔除（ref toAccioWireMessages 的 resolveToolPairing）：
// 没有 tool_result 的 tool_use、指向不存在 tool_use 的 tool_result 都会被上游
// 拒（400）。配对按 id 逐个判定（minimaxConvertMessages 的同款口径 —— 逐个
// 剔除能多保留可用的那半上下文）。
func accioOpenAIToContents(parsed map[string]any) (contents []any, system string, tools []any, temperature, maxTokens any, err error) {
	// system / developer 消息 → 顶层字符串（多条按序空行拼接）。
	if list, ok := parsed["messages"].([]any); ok {
		var systemParts []string
		for _, item := range list {
			msg, ok := item.(map[string]any)
			if !ok {
				continue
			}
			role, _ := msg["role"].(string)
			if role == "system" || role == "developer" {
				if text := accioTextOf(msg["content"]); text != "" {
					systemParts = append(systemParts, text)
				}
			}
		}
		system = strings.Join(systemParts, "\n\n")
	}

	// 先建 tool_call id → name 映射：上游的 functionResponse **按 name 配对**，
	// 空 name 的响应等于把工具结果丢掉（ref toAccioWireMessages 的同款防线）。
	callNames := map[string]string{}
	if list, ok := parsed["messages"].([]any); ok {
		for _, item := range list {
			msg, _ := item.(map[string]any)
			calls, _ := msg["tool_calls"].([]any)
			for _, rawCall := range calls {
				call, ok := rawCall.(map[string]any)
				if !ok {
					continue
				}
				fn, _ := call["function"].(map[string]any)
				id, _ := call["id"].(string)
				name, _ := fn["name"].(string)
				if id != "" && name != "" {
					callNames[id] = name
				}
			}
		}
	}

	// 配对集合：id 在 tool_use 与 tool_result 两侧都出现过才保留。
	keepUse, keepResult := accioToolPairing(parsed["messages"])

	if list, ok := parsed["messages"].([]any); ok {
		for _, item := range list {
			msg, ok := item.(map[string]any)
			if !ok {
				continue
			}
			role, _ := msg["role"].(string)
			switch role {
			case "system", "developer":
				continue // 已提到顶层 system
			case "tool":
				id, _ := msg["tool_call_id"].(string)
				if !keepResult[id] {
					continue // 孤儿结果：丢弃（上游 400）
				}
				responseJSON := ""
				switch c := msg["content"].(type) {
				case string:
					responseJSON = c
				default:
					b, merr := json.Marshal(msg["content"])
					if merr != nil {
						return nil, "", nil, nil, nil, fmt.Errorf("jethub: accio 工具结果序列化失败: %w", merr)
					}
					responseJSON = string(b)
				}
				name := msg["name"].(string)
				if name == "" {
					name = callNames[id]
				}
				contents = append(contents, map[string]any{
					"role": "user",
					"parts": []any{map[string]any{
						"functionResponse": map[string]any{
							"id":           id,
							"name":         name,
							"responseJson": responseJSON,
						},
					}},
				})
				continue
			case "assistant":
				var parts []any
				if text := accioTextOf(msg["content"]); text != "" {
					parts = append(parts, map[string]any{"text": text})
				}
				if calls, ok := msg["tool_calls"].([]any); ok {
					for i, rawCall := range calls {
						call, ok := rawCall.(map[string]any)
						if !ok {
							continue
						}
						fn, _ := call["function"].(map[string]any)
						id, _ := call["id"].(string)
						if id == "" {
							id = fmt.Sprintf("call_%d", i)
						}
						if !keepUse[id] {
							continue // 孤儿调用：丢弃
						}
						name, _ := fn["name"].(string)
						argsJSON, _ := fn["arguments"].(string)
						if argsJSON == "" {
							// 对象形态的 arguments（部分客户端）：序列化回字符串。
							if obj, ok := fn["arguments"].(map[string]any); ok {
								b, merr := json.Marshal(obj)
								if merr == nil {
									argsJSON = string(b)
								}
							}
						}
						if argsJSON == "" {
							argsJSON = "{}"
						}
						// ⚠️ argsJson 必须是**原始参数串**，不是解析后的对象
						// （ref serializeAccioMessages 的注释）。
						parts = append(parts, map[string]any{
							"functionCall": map[string]any{"id": id, "name": name, "argsJson": argsJSON},
						})
					}
				}
				if len(parts) > 0 {
					contents = append(contents, map[string]any{"role": "model", "parts": parts})
				}
				continue
			default:
				// user（以及未识别角色，按最安全的 user 处理）。
				var parts []any
				if arr, ok := msg["content"].([]any); ok {
					for _, item := range arr {
						pm, ok := item.(map[string]any)
						if !ok {
							continue
						}
						ptype, _ := pm["type"].(string)
						switch ptype {
						case "text", "input_text":
							if s, _ := pm["text"].(string); s != "" {
								parts = append(parts, map[string]any{"text": s})
							}
						case "image_url", "input_image":
							block, ierr := accioImagePart(pm)
							if ierr != nil {
								return nil, "", nil, nil, nil, ierr
							}
							parts = append(parts, block)
						}
					}
				} else if text := accioTextOf(msg["content"]); text != "" {
					parts = append(parts, map[string]any{"text": text})
				}
				if len(parts) > 0 {
					contents = append(contents, map[string]any{"role": "user", "parts": parts})
				}
			}
		}
	}

	// tools：OpenAI function 定义 → 扁平 {name, description, parametersJson}
	//（camel 形态，accioToSnake 落成 parameters_json 字符串 —— 详见 buildAccioBody
	// 的 tools 警告）。
	if list, ok := parsed["tools"].([]any); ok {
		for _, item := range list {
			tool, ok := item.(map[string]any)
			if !ok {
				continue
			}
			fn, ok := tool["function"].(map[string]any)
			if !ok {
				continue
			}
			name, _ := fn["name"].(string)
			if name == "" {
				continue
			}
			desc, _ := fn["description"].(string)
			params, ok := fn["parameters"].(map[string]any)
			if !ok {
				params = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			b, merr := json.Marshal(params)
			if merr != nil {
				return nil, "", nil, nil, nil, fmt.Errorf("jethub: accio 工具参数序列化失败: %w", merr)
			}
			tools = append(tools, map[string]any{
				"name": name, "description": desc, "parametersJson": string(b),
			})
		}
	}

	if v, ok := parsed["temperature"].(float64); ok {
		temperature = v
	}
	if v, ok := accioPositiveNumber(parsed["max_tokens"]); ok {
		maxTokens = v
	} else if v, ok := accioPositiveNumber(parsed["max_completion_tokens"]); ok {
		maxTokens = v
	}
	// ⚠️ reasoning_effort 刻意不透传（ref 实测：includeThoughts / thinkingBudget /
	// reasoningEffort=off 全部无效，思考关不掉；目录里的档位是展示信息）。
	return contents, system, tools, temperature, maxTokens, nil
}

// accioToolPairing computes the kept tool_use/tool_result id sets（ref
// resolveToolPairing 的口径：只有两侧都出现的 id 才保留）.
func accioToolPairing(messagesRaw any) (keepUse, keepResult map[string]bool) {
	useIDs := map[string]bool{}
	resultIDs := map[string]bool{}
	list, _ := messagesRaw.([]any)
	for _, item := range list {
		msg, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		if role == "tool" {
			if id, _ := msg["tool_call_id"].(string); id != "" {
				resultIDs[id] = true
			}
			continue
		}
		if calls, ok := msg["tool_calls"].([]any); ok {
			for _, rawCall := range calls {
				call, _ := rawCall.(map[string]any)
				if id, _ := call["id"].(string); id != "" {
					useIDs[id] = true
				}
			}
		}
	}
	keepUse = map[string]bool{}
	keepResult = map[string]bool{}
	for id := range useIDs {
		if resultIDs[id] {
			keepUse[id] = true
		}
	}
	for id := range resultIDs {
		if useIDs[id] {
			keepResult[id] = true
		}
	}
	return keepUse, keepResult
}

// accioPositiveNumber accepts a positive JSON number.
func accioPositiveNumber(v any) (float64, bool) {
	if f, ok := v.(float64); ok && f > 0 {
		return f, true
	}
	return 0, false
}

// accioAnthropicToContents converts an Anthropic /v1/messages body into the
// same contents envelope（ref accioUserParts / serializeAccioMessages 的
// Anthropic 等价物）.
func accioAnthropicToContents(parsed map[string]any) (contents []any, system string, tools []any, temperature, maxTokens any, err error) {
	switch s := parsed["system"].(type) {
	case string:
		system = s
	case []any:
		var parts []string
		for _, block := range s {
			if bm, ok := block.(map[string]any); ok {
				if text, _ := bm["text"].(string); text != "" {
					parts = append(parts, text)
				}
			}
		}
		system = strings.Join(parts, "\n\n")
	}

	// tool_use id → name（tool_result 的 functionResponse 按 name 配对）。
	callNames := map[string]string{}
	for _, item := range toAnySlice(parsed["messages"]) {
		msg, _ := item.(map[string]any)
		for _, block := range toAnySlice(msg["content"]) {
			bm, ok := block.(map[string]any)
			if !ok || bm["type"] != "tool_use" {
				continue
			}
			id, _ := bm["id"].(string)
			name, _ := bm["name"].(string)
			if id != "" && name != "" {
				callNames[id] = name
			}
		}
	}

	for _, item := range toAnySlice(parsed["messages"]) {
		msg, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		parts := []any{}
		for _, block := range toAnySlice(msg["content"]) {
			bm, ok := block.(map[string]any)
			if !ok {
				continue
			}
			switch bm["type"] {
			case "text":
				if s, _ := bm["text"].(string); s != "" {
					parts = append(parts, map[string]any{"text": s})
				}
			case "image":
				src, _ := bm["source"].(map[string]any)
				stype, _ := src["type"].(string)
				if stype != "base64" {
					return nil, "", nil, nil, nil, fmt.Errorf("jethub: accio 只支持 base64 内联图片（Anthropic source.type=base64）")
				}
				mediaType, _ := src["media_type"].(string)
				data, _ := src["data"].(string)
				parts = append(parts, map[string]any{
					"inlineData": map[string]any{"mimeType": mediaType, "data": data},
				})
			case "tool_use":
				id, _ := bm["id"].(string)
				name, _ := bm["name"].(string)
				input := bm["input"]
				argsJSON := "{}"
				if input != nil {
					b, merr := json.Marshal(input)
					if merr == nil {
						argsJSON = string(b)
					}
				}
				parts = append(parts, map[string]any{
					"functionCall": map[string]any{"id": id, "name": name, "argsJson": argsJSON},
				})
			case "tool_result":
				id, _ := bm["tool_use_id"].(string)
				responseJSON := ""
				switch c := bm["content"].(type) {
				case string:
					responseJSON = c
				case []any:
					// Anthropic 的 content 块数组：拼 text 块（ref 只发 responseJson 字符串）。
					var texts []string
					for _, inner := range c {
						if im, ok := inner.(map[string]any); ok {
							if t, ok := im["text"].(string); ok {
								texts = append(texts, t)
							}
						}
					}
					responseJSON = strings.Join(texts, "\n")
				default:
					if bm["content"] != nil {
						b, merr := json.Marshal(bm["content"])
						if merr == nil {
							responseJSON = string(b)
						}
					}
				}
				parts = append(parts, map[string]any{
					"functionResponse": map[string]any{
						"id":           id,
						"name":         callNames[id],
						"responseJson": responseJSON,
					},
				})
			}
		}
		if len(parts) == 0 {
			continue
		}
		outRole := "user"
		if role == "assistant" {
			outRole = "model"
		}
		contents = append(contents, map[string]any{"role": outRole, "parts": parts})
	}

	// tools：Anthropic 扁平 {name, description, input_schema}。
	for _, item := range toAnySlice(parsed["tools"]) {
		tool, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := tool["name"].(string)
		if name == "" {
			continue
		}
		desc, _ := tool["description"].(string)
		schema, ok := tool["input_schema"].(map[string]any)
		if !ok {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		b, merr := json.Marshal(schema)
		if merr != nil {
			return nil, "", nil, nil, nil, fmt.Errorf("jethub: accio 工具参数序列化失败: %w", merr)
		}
		tools = append(tools, map[string]any{
			"name": name, "description": desc, "parametersJson": string(b),
		})
	}

	if v, ok := parsed["temperature"].(float64); ok {
		temperature = v
	}
	// ⚠️ Anthropic 的 max_tokens 必填 —— 缺省补一个保守值（unknown 默认，
	// 太大会被网关拒、太小只截断）。
	if v, ok := accioPositiveNumber(parsed["max_tokens"]); ok {
		maxTokens = v
	} else {
		maxTokens = float64(minimaxUnknownMaxTokens)
	}
	return contents, system, tools, temperature, maxTokens, nil
}

// toAnySlice coerces a JSON array value (nil-safe).
func toAnySlice(v any) []any {
	list, _ := v.([]any)
	return list
}
