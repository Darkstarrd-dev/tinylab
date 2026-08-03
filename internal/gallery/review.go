package gallery

import (
	"encoding/json"
	"fmt"
)

// ReviewStrategy 审核策略
type ReviewStrategy string

const (
	ReviewStrategyAll      ReviewStrategy = "all"
	ReviewStrategyHeadTail ReviewStrategy = "head-tail"
)

// ReviewStatus 审核任务状态
type ReviewStatus string

const (
	ReviewStatusRunning   ReviewStatus = "running"
	ReviewStatusCompleted ReviewStatus = "completed"
	ReviewStatusCancelled ReviewStatus = "cancelled"
	ReviewStatusError     ReviewStatus = "error"
)

// ReviewResult 单张图片的审核结果。
// 泛化为 match 字段（原 IsAd 字段已废弃）。
type ReviewResult struct {
	Index   int    `json:"index"`
	Path    string `json:"path"`
	IsMatch bool   `json:"isMatch"`
	Reason  string `json:"reason"`
}

// ReviewResponse 是 LLM 返回的 JSON 解析结构。
// 字段名 match 是统一的契约；为兼容旧广告提示词返回 is_ad，ParseReviewResponse
// 会按 matchField 参数动态读取，回退顺序：matchField → match → is_ad。
type ReviewResponse struct {
	Match  bool   `json:"match"`
	Reason string `json:"reason"`
}

// PromptGenSystemPrompt 是「提示词生成器」自身的 system prompt。
// 当用户描述审核目标（如 "识别风景照片"）后，后端用此 prompt 调用一个 LLM，
// 让 LLM 产出一个针对视觉模型的完整 system prompt（要求视觉模型返回 {match, reason}）。
const PromptGenSystemPrompt = `You are a prompt engineer. You help write a system prompt for a vision LLM that will judge images. The user will give you a criterion description (e.g. "identify landscape photos", "identify images containing people"). You must output a complete system prompt that instructs the vision model to judge whether a given image matches that criterion, and to respond ONLY with JSON in the form: {"match": true/false, "reason": string}. Output only the system prompt text itself, no explanations, no markdown code fences. Keep it under 200 words. Be precise about what counts as a match and what does not.`

// PromptGenUserPromptTemplate 是调用提示词生成器时的用户消息模板。
// %s 会被替换为用户的审核目标描述。
const PromptGenUserPromptTemplate = `Criterion description: %s

Write the system prompt that instructs a vision model to judge whether an image matches this criterion and respond with JSON {match, reason}.`

// DefaultUserPrompt 是审核启动时如果用户没传 userPrompt 用的默认值。
const DefaultUserPrompt = `Does this image match the criterion? Return JSON only.`

// ParseReviewResponse 解析 LLM 返回的 JSON。
// matchField 是请求体中约定的字段名（默认 "match"）。
// 回退顺序：解析 message.content，按 matchField 读 bool；读不到则尝试 "match"；再读不到则尝试 "is_ad"。
func ParseReviewResponse(body []byte, matchField string) (*ReviewResponse, error) {
	if matchField == "" {
		matchField = "match"
	}

	// 尝试直接解析最外层（少数 LLM 直接返回 {match, reason}）
	if r, err := parseReviewFromBytes(body, matchField); err == nil {
		return r, nil
	}

	// 从 chat.completions 响应体的 choices[0].message.content 提取
	var chatResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &chatResp); err == nil && len(chatResp.Choices) > 0 {
		content := chatResp.Choices[0].Message.Content
		if r, err := parseReviewFromBytes([]byte(content), matchField); err == nil {
			return r, nil
		}
		// 提取第一个 { 到最后一个 } 之间的内容再尝试
		start := -1
		for i, c := range content {
			if c == '{' {
				start = i
				break
			}
		}
		end := -1
		for i := len(content) - 1; i >= 0; i-- {
			if content[i] == '}' {
				end = i
				break
			}
		}
		if start >= 0 && end > start {
			if r, err := parseReviewFromBytes([]byte(content[start:end+1]), matchField); err == nil {
				return r, nil
			}
		}
	}

	return nil, fmt.Errorf("failed to parse review response: %s", string(body))
}

// parseReviewFromBytes 尝试用 known matchField 顺序解析 JSON body 中的 bool 字段。
func parseReviewFromBytes(b []byte, matchField string) (*ReviewResponse, error) {
	// 按候选字段名顺序尝试匹配
	fields := []string{matchField, "match", "is_ad"}
	for _, f := range fields {
		// 用 map 解析指定字段名
		var m map[string]json.RawMessage
		if err := json.Unmarshal(b, &m); err != nil {
			continue
		}
		raw, ok := m[f]
		if !ok {
			continue
		}
		var v bool
		if err := json.Unmarshal(raw, &v); err != nil {
			continue
		}
		var reason string
		if r, ok := m["reason"]; ok {
			_ = json.Unmarshal(r, &reason)
		}
		return &ReviewResponse{Match: v, Reason: reason}, nil
	}
	return nil, fmt.Errorf("no boolean field found in response")
}
