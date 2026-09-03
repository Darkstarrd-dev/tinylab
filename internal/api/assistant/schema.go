package assistant

import "github.com/tinylab/tinylab/internal/assistant"

// FunctionDef represents OpenAI-compatible tool function definition.
type FunctionDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// ToolSchema represents OpenAI-compatible tool schema.
type ToolSchema struct {
	Type     string      `json:"type"`
	Function FunctionDef `json:"function"`
}

// ToolSchemaFromRule converts a SemRule into an OpenAI ToolSchema.
func ToolSchemaFromRule(r assistant.SemRule) ToolSchema {
	return ToolSchema{
		Type: "function",
		Function: FunctionDef{
			Name:        r.Tool,
			Description: r.Desc,
			Parameters: map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			},
		},
	}
}

// ToolsSchemaFromContract converts all rules in a contract to distinct tool schemas.
func ToolsSchemaFromContract(c *assistant.Contract) []ToolSchema {
	if c == nil {
		return nil
	}
	seen := make(map[string]bool)
	var list []ToolSchema
	for _, r := range c.Rules {
		if !seen[r.Tool] {
			seen[r.Tool] = true
			list = append(list, ToolSchemaFromRule(r))
		}
	}
	return list
}
