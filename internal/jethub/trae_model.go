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

// raccoonFallbackModels returns the 6 visible models (ref racoon-product.ts
// RACCOON_FALLBACK_MODELS, 2026-09-26 实测 model_catalog snapshot; order
// preserved). ⚠️ No `Raccoon-Auto` (client i18n entry — chat/completions
// 404s) and no visible:false internal raccoon-* models.
func raccoonFallbackModels() ModelTable {
	md := func(id, name, ctx, extra string) config.ModelDef {
		note := "ctx " + ctx
		if extra != "" {
			note += "; " + extra
		}
		return config.ModelDef{ID: id, QuotaType: "limited", Note: note, Alias: name}
	}
	return ModelTable{
		md("sn-sensenova-6-8-flash", "SenseNova-6.8-Flash · 免费", "256000", "max 63999; free"),
		md("sn-sensenova-6-8-flash-lite", "SenseNova-6.8-Flash-Lite · 免费", "256000", "max 63999; free"),
		md("sn-glm-5-3", "GLM-5-3 · x0.75", "1000000", "max 100000"),
		// ⚠️ 1 倍也要显示（用户报障：ide 是 1 倍，倍率必须可见）。
		md("sn-kimi-k3", "Kimi-K3 · x1", "1000000", "max 100000"),
		md("sn-glm-5-3-flash", "GLM-5-3-Flash · x0.2→x0.1", "1000000", "max 100000"),
		md("sn-deepseek-v4-1-flash", "DeepSeek-V4.1-Flash · x0.25", "1000000", "max 100000"),
	}
}

// loomyFallbackModels returns the 8 chat models (2026-09-26 实测 models
// snapshot; order preserved; names normalized to `name · x{rate}` form).
// spark-x contextWindow divergence noted (server declares 1M; the Loomy
// client forces 262144 locally — server value kept per the reference).
func loomyFallbackModels() ModelTable {
	md := func(id, name, ctx string) config.ModelDef {
		return config.ModelDef{ID: id, QuotaType: "limited", Note: "ctx " + ctx + "; efforts none/low/medium/high/xhigh; default high", Alias: name}
	}
	return ModelTable{
		md("deepseek-v4-flash-0731", "DeepSeek V4 Flash 0731 · x3.0", "1048576"),
		md("MiniMax-M3", "MiniMax M3 · x4.0", "1048576"),
		md("Kimi-k2.6", "Kimi k2.6 · x6.5", "262144"),
		md("qwen-3.8-max", "Qwen 3.8 Max · x12.0", "1000000"),
		md("GLM-5.3-Flash", "GLM 5.3 Flash · x0.8", "1048576"),
		md("qwen3.8-flash", "qwen 3.8 flash · x0.8", "1000000"),
		md("spark-x", "Spark X2.5 · x0.1", "1048576"),
		md("mimo-v2.5", "MiMo V2.5 · x3.3", "1048576"),
	}
}

// minimaxFallbackModels returns the 4 verified models (ref
// minimax-product.ts; order = remote model_order). ⚠️ MUST include
// M3.1-Flash-Preview (absent from the client's built-in static table — a
// fallback-table omission would hide the user's active model on remote
// failure). Only M3.1-Flash-Preview has effortOptions — inventing efforts
// for the others is a guess (the Qoder qmodel lesson). contextWindow = the
// TOP tier of context_window_options (not limit.context — 512K would trigger
// compaction far earlier than the official capability).
func minimaxFallbackModels() ModelTable {
	md := func(id, name, ctx, extra string) config.ModelDef {
		note := "ctx " + ctx
		if extra != "" {
			note += "; " + extra
		}
		return config.ModelDef{ID: id, QuotaType: "unlimited", Note: note, Alias: name}
	}
	return ModelTable{
		md("MiniMax-M3.1-Flash-Preview", "M3.1-Flash-Preview", "1000000", "max 128000; img; efforts default/low/medium/high/xhigh/max; thinking forced_on"),
		md("MiniMax-M3", "M3", "1000000", "max 128000; img; thinking switchable (no efforts — on/off only)"),
		md("MiniMax-M2.7-highspeed", "M2.7-highspeed", "200000", "max 128000; thinking forced_on (disabled silently ignored)"),
		md("MiniMax-M2.7", "M2.7", "200000", "max 128000; thinking forced_on"),
	}
}
