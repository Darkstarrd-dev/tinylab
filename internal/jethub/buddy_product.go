package jethub

import "github.com/tinylab/tinylab/internal/config"

// 本文件的两个静态模型表都遵循同一条展示契约（用户实测「模型显示和插件中不一致」）：
//
//	**展示名写进 `Alias`**，形如 `模型名称 · 倍率`；面板与 Settings 都渲染
//	`Alias`（`modelDisplayParts` 从 Alias 的 `·` 尾巴或 Note 的倍率段取倍率）。
//
// ⚠️ 曾经的缺陷：buddy / workbuddy 的静态表**只把名字塞进 Note、Alias 留空**，
// 于是 Free Hub 面板显示裸 id（`deepseek-v4.1-flash`），而插件显示
// `Deepseek-V4.1-Flash` —— 这是「个别 provider 模型显示与插件不一致」的主因。
//
// ⚠️ 兜底路径**没有倍率**（不编造）：ref 的 `staticFallbackModels()`
// （buddy-adapter.ts:1064-1070）把兜底表映射成 `{id, name}`，`creditsRate` 恒为
// undefined，故 `displayNameFor` 只输出名字 + 同名消歧标记；倍率只随运行时
// `POST {endpoint}/v3/config` 的 `creditsRate`/`discountedCreditsRate` 下发
// （本端尚未实现远端目录拉取，见 docs/jethub-architecture.md §6.3）。

// buddyFallbackModels returns the built-in model catalog for a buddy-family
// product (ref product.ts CODEBUDDY_FALLBACK_MODELS:180-266 /
// WORKBUDDY_FALLBACK_MODELS:295-367). Only models verified to actually work
// are listed; the remote /v3/config list overrides at runtime in the plugin.
//
// ⚠️ 同名撞车必须消歧，且**变体标记前也要有 ` · `**：ref 的
// `displayNameFor(model, all)` 把 `displaySuffix` 整条用 ` · ` 接到 name 上
// （buddy-adapter.ts:2176-2178），而 suffix = `[倍率, 变体].join(' ')`
// （:2182-2191）—— **兜底路径没有倍率时 suffix 就是变体本身，` · ` 依然保留**，
// 故插件显示的是 `Hy3 · X` 而不是 `Hy3 X`（ref 自己的文档样例
// `Deepseek-V4.1-Flash · x0.03 SG` 同形）。变体文本由 `variantLabelFor`
// （:2204-2210）取撞车组 id 的**公共前缀**、剩余部分转大写得出。
// 撞车组随服务端上新变化，但静态兜底表里只有三组（buddy: hy3/hy3-x；
// workbuddy: hy4-preview-f/hy4-preview 与 deepseek-v4.1-flash/-sg），故直接把
// 算好的结果固化成 Alias —— 表内自洽，两个 UI（Free Hub 面板 / Settings
// provider detail）读同一份。
//
// ⚠️ `modelDisplayParts` 只在 `·` 之后是**倍率文本**时才切分，`X`/`F`/`SG` 不是
// 倍率 ⇒ 整串原样作为展示名、倍率仍为空（正是 ref 兜底路径的形态）。
func buddyFallbackModels(provider string) ModelTable {
	md := func(id, name string) config.ModelDef {
		return config.ModelDef{ID: id, QuotaType: "limited", Alias: name}
	}
	if provider == "workbuddy" {
		return ModelTable{
			md("default-model", "Auto"),
			md("fast-model", "Fast"),
			md("balanced-model", "Balanced"),
			md("primary-model", "Primary"),
			md("deep-model", "Deep"),
			// 公共前缀 hy4-preview + 变体 f ⇒ `Hy4 preview · F`（variantLabelFor）。
			md("hy4-preview-f", "Hy4 preview · F"),
			md("hy4-preview", "Hy4 preview"),
			md("hy3", "Hy3"),
			md("deepseek-v4.1-flash", "Deepseek-V4.1-Flash"),
			// 公共前缀 deepseek-v4.1-flash + 变体 sg ⇒ `Deepseek-V4.1-Flash · SG`
			// （**不是** ref 兜底表里没有的 `(SG)` 写法）。
			md("deepseek-v4.1-flash-sg", "Deepseek-V4.1-Flash · SG"),
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
		// 公共前缀 hy3 + 变体 x ⇒ `Hy3 · X`（ref 的同名撞车消歧；两者兜底 name
		// 都是 `Hy3`，注意 ` · ` 不可省）。
		md("hy3-x", "Hy3 · X"),
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

// lobsteraiFallbackModels returns the built-in 19-model catalog (from ref
// lobsterai-product.ts:183-203 — "2026-08-06 从 GET /api/models/available
// 实测拉取"). Order preserves the reference table for comparability.
//
// ⚠️ **没有展示名与倍率可抄**：ref 兜底表的 `name` **逐条等于 id**
// （lobsterai-product.ts:184-202 的 `{ id: 'deepseek-v4-flash', name:
// 'deepseek-v4-flash' }`），倍率 `costMultiplier` 只随远端目录下发
// （`displayNameFor` 拼 ` · x{n}`，lobsterai-adapter.ts:1696-1698）。故兜底路径
// 下插件与我们都显示裸 id —— 这一条**不是**缺陷，差的是远端目录（本端尚未实现，
// 见 docs/jethub-architecture.md §6.3）。
//
// ⚠️ 与插件面板的**已知差距**：插件面板走远端目录 `GET {apiBase}/api/models/available`
// （远端 26 条，带 `costMultiplier`；且必须带 `X-LobsterAI-Client-Capabilities` 头
// 才会下发 `kimi-k3`）。本端尚未实现该拉取，故这里只补上远端已确认存在、兜底表
// 原本缺失的三条。
func lobsteraiFallbackModels() ModelTable {
	md := func(id string) config.ModelDef {
		return config.ModelDef{ID: id, QuotaType: "limited", Note: "ctx ~1M (est)"}
	}
	return ModelTable{
		md("kimi-k3"),        // 需 capability 头才下发（ref lobsterai.ts:535-539）
		md("deepseek-flash"), // 远端 id 与 deepseek-v4-flash 不同，两者并存
		md("glm-5.3-flash"),
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
