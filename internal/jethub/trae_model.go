package jethub

import "github.com/tinylab/tinylab/internal/config"

// traeFallbackModels returns the 32-entry built-in catalog (ref
// trae-product.go TRAE_FALLBACK_MODELS, 2026-08 snapshot; order preserved).
// Hidden/internal models are marked in Note (the registry keeps them for
// visibility parity; users can blacklist via the models API).
func traeFallbackModels() ModelTable {
	md := func(id, name string, hidden ...bool) config.ModelDef {
		return config.ModelDef{ID: id, QuotaType: "limited", Note: noteOf("ctx 200000", hidden)}
	}
	return ModelTable{
		md("DeepSeek-V4-Flash-Official", "DeepSeek V4 Flash Official"),
		md("Doubao-Seed-2.1-Pro", "Doubao Seed 2.1 Pro"),
		md("seed-code-pro-0430", "Seed Code Pro 0430"),
		md("Doubao-Seed-2.1-Turbo", "Doubao Seed 2.1 Turbo"),
		md("Doubao-Seed-2.0-Code", "Doubao Seed 2.0 Code"),
		md("browser_use_subagent", "Browser Use Subagent", true),
		md("glm-5.2", "GLM-5.2"),
		md("glm-5-turbo", "GLM-5 Turbo"),
		md("glm-5", "GLM-5"),
		md("DeepSeek-V4-Pro", "DeepSeek V4 Pro"),
		md("DeepSeek-V4-Flash", "DeepSeek V4 Flash"),
		md("kimi-k3", "Kimi K3"),
		md("kimi-k2.7-code", "Kimi K2.7 Code"),
		md("kimi-k2.6", "Kimi K2.6"),
		md("minimax-m3", "MiniMax M3"),
		md("qwen-3.7-plus", "Qwen 3.7 Plus"),
		md("sagitta", "Sagitta"),
		md("aquila", "Aquila"),
		md("custom_model_gemini", "Custom Gemini"),
		md("custom_model_placeholder", "Custom Placeholder"),
		md("custom_model_1M_text", "Custom 1M Text"),
		md("custom_model_1M", "Custom 1M"),
		md("custom_model_kimi", "Custom Kimi"),
		md("custom_model_claude", "Custom Claude"),
		md("custom_model_gpt-5", "Custom GPT-5"),
		md("custom_model_no-fc", "Custom No-FC"),
		md("custom_model_deepseek_chat", "Custom DeepSeek Chat"),
		md("custom_model_deepseek_reasoner", "Custom DeepSeek Reasoner"),
		md("custom_model_deepseek_v4", "Custom DeepSeek V4"),
		md("explore_sub_agent_v13", "Explore Sub Agent V13", true),
		md("explore_sub_agent_v2", "Explore Sub Agent V2", true),
		md("summary", "Summary", true),
	}
}

// noteOf builds the ModelDef note string.
func noteOf(base string, hidden []bool) string {
	if len(hidden) > 0 && hidden[0] {
		return base + "; internal"
	}
	return base
}

// clineFallbackModels returns the 5 verified free models (ref
// cline-product.ts CLINE_FALLBACK_MODELS — the free set comes from the remote
// `recommended-models` free array; these are the snapshot values, including
// the gemini-3.8-flash maxTokens=65536 correction: 131072 gets 400'd).
func clineFallbackModels() ModelTable {
	md := func(id, name, ctx string, extra string) config.ModelDef {
		note := "ctx " + ctx
		if extra != "" {
			note += "; " + extra
		}
		return config.ModelDef{ID: id, QuotaType: "unlimited", Note: note, Alias: name}
	}
	return ModelTable{
		md("stealth/space-bunny-alpha", "Space Bunny Alpha", "1000000", "max 524288; free"),
		md("cline-free/mimo-v2.6-flash", "MiMo-V2.6-Flash", "1048576", "max 131072; free"),
		md("cline-free/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "1048576", "max 131072; free"),
		// ⚠️ maxTokens 是 65536 不是 131072（实测 400: supported range is
		// [1, 65537)——真实缺陷回归值）。
		md("cline-free/gemini-3.8-flash", "Gemini 3.8 Flash", "1048576", "max 65536; free"),
		md("cline-free/muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", "1048576", "max 943718; free"),
	}
}
