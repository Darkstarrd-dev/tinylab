package jethub

import "github.com/tinylab/tinylab/internal/config"

// traeFallbackModels returns the built-in catalog (ref trae-product.ts:170-201
// TRAE_FALLBACK_MODELS, 2026-08 snapshot; order preserved).
//
// ⚠️ **隐藏模型必须一并剔除**（用户实测「模型显示和插件不一致」的一部分）：
// ref 的 `staticFallbackModels()`（trae-adapter.ts:765-769）**先 filter
// `isHidden !== true` 再出表**，故插件面板里从不出现 `browser_use_subagent` /
// `explore_sub_agent_v13` / `explore_sub_agent_v2` / `summary` 四条 —— 此前我们把
// 它们留在表里（标 Note `internal`），面板就比插件多四条。
//
// ⚠️ 展示名 = ref 的 `name` 字段（**倍率只随远端目录下发**，兜底路径 ref 也只显示
// 名字：`traeDisplayName` 在 `creditsRate === undefined` 时直接返回 name，
// trae-adapter.ts:574-585 ⇒ 不编造 `x1`）。
func traeFallbackModels() ModelTable {
	md := func(id, name string) config.ModelDef {
		return config.ModelDef{ID: id, QuotaType: "limited", Note: "ctx 200000", Alias: name}
	}
	return ModelTable{
		md("DeepSeek-V4-Flash-Official", "DeepSeek V4 Flash Official"),
		md("Doubao-Seed-2.1-Pro", "Doubao Seed 2.1 Pro"),
		md("seed-code-pro-0430", "Seed Code Pro 0430"),
		md("Doubao-Seed-2.1-Turbo", "Doubao Seed 2.1 Turbo"),
		md("Doubao-Seed-2.0-Code", "Doubao Seed 2.0 Code"),
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
	}
}

// clineFallbackModels returns the cline catalog: the 5 verified free models
// (ref cline-product.ts:150-199 CLINE_FALLBACK_MODELS — the free set comes from
// the remote `recommended-models` free array; these are the snapshot values,
// including the gemini-3.8-flash maxTokens=65536 correction: 131072 gets 400'd)
// followed by the 18 `cline-pass/*` subscription models.
//
// ⚠️ **cline-pass 目录来自 models.dev**（ref caf675e：`applyModelsDevCatalog`
// 把 `https://models.dev/api.json` 的 `cline-pass` provider 块并进模型目录）——
// 网关 `recommended-models.clinePass` **只下发 14 条**，缺 `kimi-k2.6` /
// `glm-5.2` / `kimi-k2.7-code` / `deepseek-v4-flash`（用户报障「cline-pass
// 部分模型列表不全」的根因：这 4 条在本端**根本不存在**，既看不到也选不到），
// 且网关给 cline-pass 的 `name` **就是 id 本身**（`name === 'cline-pass/…'`）
// ⇒ 面板里全是裸 id；models.dev 有可读名（`DeepSeek V4.1 Flash`）。
//
// 快照：`https://models.dev/api.json` 的 `cline-pass` 块（18 条），抓取日期
// **2026-10-02**（与 ref 实测的 2026-09-30 同为 18 条）。取值口径 = ref caf675e：
//  1. 只取 `name` 与 `limit.context`；⚠️ **不取 `limit.output`** —— 那是要真的
//     写进请求体 `max_tokens` 的值，ref 明令不碰（本仓库有过据印象填大值 →
//     vertex/google 400 的历史）；
//  2. 图片能力**不落表**：本端 ModelDef 没有该字段，且代理对图片一律透传
//     （ref 用 `modalities.input` 含 `image` 判定，词表只夹取 text/image）；
//  3. 免费集合在前（ref `mergeClineModels` 第 1 步），cline-pass 按 models.dev
//     块内顺序；
//  4. `cline-pass/glm-5.3-flash` 的 `name` 在 models.dev 里**就是裸 id**
//     （上游合并后同样显示裸 id），故照抄，不编造人类可读名。
//
// ⚠️ **免费模型必须拼 ` · 免费`**（ref `clineDisplayName`，
// cline-models.ts:107-109：`model.isFree ? `${name} · 免费` : name`）—— 这 5 条
// 全部 `isFree: true`（cline-product.ts:155/164/173/190/199），故展示名一律带
// 后缀；此前只在 Note 里写了个裸 `free`（`modelDisplayParts` **不认**它，
// 于是面板少了 ` · 免费`）。
//
// ⚠️ cline-pass **不是免费**（ref cline-models.ts:150-153：`clinePass` 是订阅制
// 额度，不是 free 集合）⇒ 展示名**不带** ` · 免费`，也**不编造倍率**（远端两个
// 目录端点都不下发倍率）；QuotaType 用 `limited`（订阅额度，ref 的
// `mergeClineModels` 只把它排在免费之后）。
func clineFallbackModels() ModelTable {
	free := func(id, name, ctx, extra string) config.ModelDef {
		note := "ctx " + ctx
		if extra != "" {
			note += "; " + extra
		}
		return config.ModelDef{ID: id, QuotaType: "unlimited", Note: note, Alias: name + " · 免费"}
	}
	// cline-pass/*：展示名 = models.dev 的 `name`，Note 只记上下文窗口。
	pass := func(id, name, ctx string) config.ModelDef {
		return config.ModelDef{ID: id, QuotaType: "limited", Note: "ctx " + ctx, Alias: name}
	}
	return ModelTable{
		// ── 免费模型（远端 `free` 数组实测 2026-09-25，共 5 个）──
		free("stealth/space-bunny-alpha", "Space Bunny Alpha", "1000000", "max 524288; free"),
		free("cline-free/mimo-v2.6-flash", "MiMo-V2.6-Flash", "1048576", "max 131072; free"),
		free("cline-free/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "1048576", "max 131072; free"),
		// ⚠️ maxTokens 是 65536 不是 131072（实测 400: supported range is
		// [1, 65537)——真实缺陷回归值）。
		free("cline-free/gemini-3.8-flash", "Gemini 3.8 Flash", "1048576", "max 65536; free"),
		free("cline-free/muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", "1048576", "max 943718; free"),
		// ── cline-pass/*（models.dev `cline-pass` 块快照 2026-10-02，18 条，
		//    块内顺序；`← 网关缺` 的四条是 caf675e 补进来的）──
		pass("cline-pass/mimo-v2.6-pro", "MiMo-V2.6-Pro", "1048576"),
		pass("cline-pass/qwen3.7-max", "Qwen3.7 Max", "1000000"),
		pass("cline-pass/mimo-v2.5", "MiMo-V2.5", "1048576"),
		// ⚠️ models.dev 给这条的 `name` 就是裸 id（没有可读名可抄）。
		pass("cline-pass/glm-5.3-flash", "cline-pass/glm-5.3-flash", "1000000"),
		pass("cline-pass/qwen3.8-max", "Qwen3.8 Max", "1000000"),
		pass("cline-pass/kimi-k3", "Kimi K3", "1048576"),
		pass("cline-pass/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "1000000"),
		pass("cline-pass/kimi-k2.6", "Kimi K2.6", "262144"), // ← 网关缺
		pass("cline-pass/mimo-v2.5-pro", "MiMo-V2.5-Pro", "1048576"),
		pass("cline-pass/mimo-v2.6-flash", "MiMo-V2.6-Flash", "1048576"),
		pass("cline-pass/minimax-m3", "MiniMax-M3", "1048576"),
		pass("cline-pass/glm-5.2", "GLM-5.2", "1000000"), // ← 网关缺
		pass("cline-pass/deepseek-v4-pro", "DeepSeek V4 Pro", "1000000"),
		pass("cline-pass/muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", "1048576"),
		pass("cline-pass/glm-5.3", "GLM-5.3", "1000000"),
		pass("cline-pass/kimi-k2.7-code", "Kimi K2.7 Code", "262144"), // ← 网关缺
		pass("cline-pass/qwen3.7-plus", "Qwen3.7 Plus", "1000000"),
		pass("cline-pass/deepseek-v4-flash", "DeepSeek V4 Flash", "1000000"), // ← 网关缺
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

// qoderFallbackModels returns the 17-key international catalog (ref
// qoder-product.ts QODER_FALLBACK_MODELS — decrypted from the local
// catalog-v6; ids are CATALOG KEYS accepted ONLY by the encrypted endpoint).
// contextWindow = the TOP tier of context_config (zX() checks tier-table
// MEMBERSHIP only); priceFactor 0 = free (legal value, not missing).
func qoderFallbackModels() ModelTable {
	md := func(id, name, ctx, extra string) config.ModelDef {
		note := "ctx " + ctx
		if extra != "" {
			note += "; " + extra
		}
		return config.ModelDef{ID: id, QuotaType: "limited", Note: note, Alias: name}
	}
	return ModelTable{
		md("auto", "Auto", "200000", "x0.5; no tier table"),
		md("ultimate", "Ultimate", "1000000", "x2; efforts xhigh/high/low/max/medium; default high; can disable"),
		md("performance", "Performance", "1000000", "x1.1; efforts xhigh/high/low/max/medium; default medium; can disable"),
		md("efficient", "Efficient", "1000000", "x0.3"),
		md("smodel", "Sonus", "1000000", "x8; efforts xhigh/high/low/max/medium; default high; NO disable"),
		md("cmodel", "Cantus", "1000000", "x4; efforts xhigh/high/low/max/medium; default high; NO disable"),
		md("qmodel_38max", "Qwen3.8-Max", "1000000", "x0.5; promo 22:00-08:00 x0.2; efforts xhigh/low/medium; default xhigh (CN=medium); can disable"),
		md("qfmodel", "Qwen3.8-Flash", "1000000", "FREE (x0); efforts xhigh/low/medium; default medium; can disable"),
		md("qmodel_latest", "Qwen3.7-Max", "1000000", "x0.5; promo 22:00-08:00 x0.1; NO efforts — disable-only"),
		md("qmodel", "Qwen3.7-Plus", "1000000", "x0.1; promo 22:00-08:00 x0.04; NO efforts — disable-only"),
		md("kmodel_latest", "Kimi-K3", "1000000", "x1.4; efforts high/low/max; default max"),
		md("kmodel", "Kimi-K2.8-Preview", "1000000", "x0.8; efforts high/low/max; default max"),
		md("gmodel", "GLM-5.3", "1000000", "x0.8; efforts high/low/max; default max"),
		md("gfmodel", "GLM-5.3-Flash", "1000000", "x0.1; efforts high/max; default max"),
		md("dmodel", "DeepSeek-V4-Pro", "1000000", "x0.5; efforts high/max; default max; can disable"),
		md("dfmodel", "DeepSeek-Flash", "1000000", "x0.1; efforts high/max/low; default max; can disable"),
		md("mmodel", "MiniMax-M3", "1000000", "x0.2"),
	}
}

// qoderCNFallbackModels returns the 14-key CN catalog (E6 evidence; CN
// EXCLUDES ultimate/performance/efficient/smodel/cmodel — reusing the intl
// table would offer 5 models the CN endpoint does not know; CN-only
// q37fmodel/gm51model added; mmodel is MiniMax-M2.7 here).
func qoderCNFallbackModels() ModelTable {
	md := func(id, name, ctx, extra string) config.ModelDef {
		note := "ctx " + ctx
		if extra != "" {
			note += "; " + extra
		}
		return config.ModelDef{ID: id, QuotaType: "limited", Note: note, Alias: name}
	}
	return ModelTable{
		md("auto", "Auto", "200000", "x0.5; no thinking_config"),
		md("qmodel_38max", "Qwen3.8-Max", "1000000", "x0.5; promo 22:00-08:00 x0.2; efforts xhigh/low/medium; default medium; can disable"),
		md("qfmodel", "Qwen3.8-Flash", "1000000", "FREE (x0); measured 983,490 / range error [1,983616]; efforts xhigh/low/medium; default medium; can disable"),
		md("qmodel_latest", "Qwen3.7-Max", "1000000", "x0.5; promo 22:00-08:00 x0.1; NO efforts — disable-only"),
		md("qmodel", "Qwen3.7-Plus", "1000000", "x0.1; promo 22:00-08:00 x0.04; NO efforts — disable-only"),
		md("q37fmodel", "Qwen3.7-Flash", "1000000", "x0.1; CN-only; NO thinking_config"),
		md("dmodel", "DeepSeek-V4-Pro", "1000000", "measured 852,951 (tier says 1M — keep 1M); x0.5; efforts high/max; default max; can disable"),
		md("dfmodel", "DeepSeek-Flash", "1000000", "measured 999,991; x0.1; efforts high/max/low; default max; can disable"),
		md("gmodel", "GLM-5.3", "1000000", "x0.8; efforts high/low/max; default max; NO disable"),
		md("gfmodel", "GLM-5.3-Flash", "1000000", "x0.1; efforts high/max; default max; NO disable"),
		md("gm51model", "GLM-5.2", "1000000", "x0.6; CN-only; efforts high/max; default max; can disable"),
		md("kmodel_latest", "Kimi-K3", "1000000", "x1.4; efforts high/low/max; default max; NO disable"),
		md("kmodel", "Kimi-K2.8-Preview", "1000000", "x0.8; efforts high/low/max; default max"),
		md("mmodel", "MiniMax-M2.7", "200000", "x0.2; CN value (intl=M3); only-200K tier; NO thinking_config"),
	}
}
