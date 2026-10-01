package jethub

import "github.com/tinylab/tinylab/internal/config"

// lobsteraiFallbackModels returns the built-in 19-model catalog (from ref
// lobsterai-product.ts — "2026-08-06 从 GET /api/models/available 实测拉取").
// Order preserves the reference table for comparability; contextWindow notes
// are estimates (the server mostly reports 1M).
func lobsteraiFallbackModels() ModelTable {
	md := func(id string) config.ModelDef {
		return config.ModelDef{ID: id, QuotaType: "limited", Note: "ctx ~1M (est)"}
	}
	return ModelTable{
		md("deepseek-v4-flash"),
		md("deepseek-v4-pro"),
		md("MiniMax-M3"),
		md("MiniMax-M2.7"),
		md("qwen3.7-max"),
		md("qwen3.7-plus"),
		md("qwen3.6-plus"),
		md("qwen3.5-plus-2026-04-20"),
		md("kimi-k2.7-code"),
		md("kimi-k2.7-code-highspeed"),
		md("kimi-k2.6"),
		md("kimi-k2.5"),
		md("doubao-seed-2-1-pro-260628"),
		md("doubao-seed-2-1-turbo-260628"),
		md("doubao-seed-2-0-code-preview-260215"),
		md("glm-5.2"),
		md("glm-5.1"),
		md("glm-5v-turbo"),
		md("glm-5"),
	}
}

// RegisterDefaultProducts doc anchor: the trae table lives in trae_model.go.

// buddyFallbackModels returns the built-in model catalog for a buddy-family
// product (from ref product.ts CODEBUDDY_FALLBACK_MODELS /
// WORKBUDDY_FALLBACK_MODELS — only models verified to actually work are
// listed; the remote /v3/config list overrides at runtime in the plugin and
// can be fetched later via the models API).
func buddyFallbackModels(provider string) ModelTable {
	md := func(id, note string) config.ModelDef {
		return config.ModelDef{ID: id, QuotaType: "limited", Note: note}
	}
	if provider == "workbuddy" {
		return ModelTable{
			md("default-model", "Auto"),
			md("fast-model", "Fast"),
			md("balanced-model", "Balanced"),
			md("primary-model", "Primary"),
			md("deep-model", "Deep"),
			md("hy4-preview-f", "Hy4 preview"),
			md("hy4-preview", "Hy4 preview"),
			md("hy3", "Hy3"),
			md("deepseek-v4.1-flash", "Deepseek-V4.1-Flash"),
			md("deepseek-v4.1-flash-sg", "Deepseek-V4.1-Flash (SG)"),
			md("gpt-6-astra", "GPT-6-Astra"),
			md("gpt-5.6-sol", "GPT-5.6-Sol"),
			md("gpt-5.6-terra", "GPT-5.6-Terra"),
			md("gpt-5.6-luna", "GPT-5.6-Luna"),
			md("gpt-5.5", "GPT-5.5"),
			md("gpt-5.4", "GPT-5.4"),
			md("gpt-5.3-codex", "GPT-5.3-Codex"),
			md("gemini-3.5-flash", "Gemini-3.5-Flash"),
			md("glm-5.3", "GLM-5.3"),
			md("glm-5.2", "GLM-5.2"),
			md("kimi-k3", "Kimi-K3"),
			md("kimi-k2.8-preview", "Kimi-K2.8-Preview"),
			md("kimi-k2.6", "Kimi-K2.6"),
		}
	}
	return ModelTable{
		md("hy4-preview", "Hy4 preview"),
		md("hy3", "Hy3"),
		md("hy3-x", "Hy3"),
		md("deepseek-v4.1-flash", "Deepseek-V4.1-Flash"),
		md("deepseek-v4-pro", "Deepseek-V4-Pro"),
		md("deepseek-v4-flash", "Deepseek-V4-Flash"),
		md("glm-5.3", "GLM-5.3"),
		md("glm-5.3-flash", "GLM-5.3-Flash"),
		md("glm-5.2", "GLM-5.2"),
		md("glm-5.1", "GLM-5.1"),
		md("glm-5v-turbo", "GLM-5V-Turbo"),
		md("kimi-k3-1", "Kimi-K3-1"),
		md("kimi-k2.8-preview", "Kimi-K2.8-Preview"),
		md("kimi-k2.7", "Kimi-K2.7"),
		md("kimi-k2.6", "Kimi-K2.6"),
		md("minimax-m3", "MiniMax-M3"),
	}
}
