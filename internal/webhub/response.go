package webhub

import (
	"encoding/json"
	"fmt"
	"time"
)

// chatCompletion is the non-streaming OpenAI response body a webhub turn is
// wrapped in. Pages produce text only, so usage is estimated (chars/4 — the
// same rough estimate the proxy uses for its live input estimate) and never
// presented as upstream truth.
type chatCompletion struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index        int     `json:"index"`
		Message      message `json:"message"`
		FinishReason string  `json:"finish_reason"`
	} `json:"choices"`
	Usage *usage `json:"usage,omitempty"`
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// chatChunk is one streaming SSE payload.
type chatChunk struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index int     `json:"index"`
		Delta delta   `json:"delta"`
		FR    *string `json:"finish_reason"`
	} `json:"choices"`
}

type delta struct {
	Content string `json:"content,omitempty"`
	Role    string `json:"role,omitempty"`
}

// responseID builds a chatcmpl-style id so clients that correlate by id see a
// familiar shape.
func responseID() string {
	return fmt.Sprintf("chatcmpl-webhub-%d", time.Now().UnixNano())
}

// BuildChatCompletion renders a complete (non-streaming) OpenAI response for a
// page-produced reply.
func BuildChatCompletion(model, text string, promptTokens int) ([]byte, error) {
	var out chatCompletion
	out.ID = responseID()
	out.Object = "chat.completion"
	out.Created = time.Now().Unix()
	out.Model = model
	out.Choices = make([]struct {
		Index        int     `json:"index"`
		Message      message `json:"message"`
		FinishReason string  `json:"finish_reason"`
	}, 1)
	out.Choices[0].Index = 0
	out.Choices[0].Message = message{Role: "assistant", Content: text}
	out.Choices[0].FinishReason = "stop"
	out.Usage = &usage{
		PromptTokens:     promptTokens,
		CompletionTokens: estimateTokens(text),
	}
	out.Usage.TotalTokens = out.Usage.PromptTokens + out.Usage.CompletionTokens
	return json.Marshal(out)
}

// BuildChunk renders one streaming chunk. The first chunk carries the
// assistant role (OpenAI clients expect it), intermediate chunks carry the
// content delta, and done=true emits the terminal finish_reason chunk.
func BuildChunk(id, model, content string, first, done bool) ([]byte, error) {
	var c chatChunk
	c.ID = id
	c.Object = "chat.completion.chunk"
	c.Created = time.Now().Unix()
	c.Model = model
	c.Choices = make([]struct {
		Index int     `json:"index"`
		Delta delta   `json:"delta"`
		FR    *string `json:"finish_reason"`
	}, 1)
	c.Choices[0].Index = 0
	if first {
		c.Choices[0].Delta.Role = "assistant"
	}
	c.Choices[0].Delta.Content = content
	if done {
		stop := "stop"
		c.Choices[0].FR = &stop
		c.Choices[0].Delta.Content = ""
	}
	return json.Marshal(c)
}

// estimateTokens is a deliberately rough char/4 estimate. Pages report no
// token counts, and inventing a precise number would be worse than an
// obviously approximate one.
func estimateTokens(s string) int {
	return len([]rune(s)) / 4
}
