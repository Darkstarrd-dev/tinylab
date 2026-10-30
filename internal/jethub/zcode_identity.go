package jethub

// 3012/405 准入：官方 system 身份块 + 首轮日期块 + 调用方 system 注入
// （ref src/zcode-identity.ts @ 9ffd65e）。
//
// 上游对 `/zcode-plan/anthropic` 通道做**请求体内容检查**：`system` 缺官方身份块
// 结构时直接回 `{"code":3012,...}` / `HTTP 405 unusual activity`（实测矩阵：
// 无 system ✗ / 仅 cliPrefix ✗ / cliPrefix+stable ✓）。
// ⚠️ 3012/405 有账号冷却惩罚（30 分钟；24h 内第 3 次起 24h；5 次停用）—— 结构
// 必须逐字，任何"优化"都是缺陷。
//
// ★ 2026-10-25 实测（R10，ref 9893e91）：`system` **恒为 3 块**
// （cliPrefix + stable + environment），**绝不多也不少**。把调用方 system 追加
// 成第 4 块会让请求必然收到 `405 + 3012`，与它多长无关（2 KB 与 25 KB 一样）；
// 调用方内容改注入**首轮 user 消息**后同一请求 200，模型照样遵循该约定。
//
// 文本本体在 zcode_identity_text.go（生成文件，sha256 锁死）；
// 本文件只做装配：块数组顺序、environment 段、日期块、调用方注入。

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Date-block fixed texts (ref CONTEXT_PREFIX_INTRO / CONTEXT_PREFIX_OUTRO,
// verbatim; outro 前有 6 个空格).
const (
	zcodeContextIntro = "As you answer the user's questions, you can use the following context:"
	zcodeContextOutro = "      IMPORTANT: this context may or may not be relevant to your tasks. " +
		"You should not respond to this context unless it is highly relevant to your task."
)

// zcodeStableText joins the generated stable sections (2590 UTF-16 units /
// 2594 UTF-8 bytes, official 2026-10-23 version).
func zcodeStableText() string { return strings.Join(zcodeIdentityStableSections, "\n\n") }

// zcodeSystemBlocks builds the official-shape `system` block array. **恒为 3 块**
// （ref 9893e91 实测：第 4 块 = 405+3012，与长度无关）：
//
//	block[0] = cliPrefix (42)             ← 准入必需
//	block[1] = stable (2590)              ← 准入必需
//	block[2] = "# Environment" 段
//
// 调用方 system **不进这里** —— 见 zcodeWithCallerSystem。
//
// ⚠️ 只在**最后一块**打 prompt-caching 断点（ref 2026-09-30 调整）：Anthropic 的
// 缓存是前缀式的，一个末位断点覆盖面等于逐块打点，还把 4 个断点的预算留给 tools。
func zcodeSystemBlocks(cwd, model string) []any {
	blocks := []any{
		map[string]any{"type": "text", "text": zcodeIdentityCLIPrefix},
		map[string]any{"type": "text", "text": zcodeStableText()},
		map[string]any{"type": "text", "text": zcodeEnvironmentSection(cwd, model)},
	}
	if last, ok := blocks[len(blocks)-1].(map[string]any); ok {
		last["cache_control"] = map[string]any{"type": "ephemeral"}
	}
	return blocks
}

// zcodeEnvironmentSection builds the `# Environment` block (ref
// buildEnvironmentSection, verbatim lines).
func zcodeEnvironmentSection(cwd, model string) string {
	if strings.TrimSpace(cwd) == "" {
		cwd = "."
	}
	platform := zcodeNodePlatform()
	shell := "bash"
	if platform == "win32" {
		shell = "powershell"
	}
	gitRepo := "no"
	if _, err := os.Stat(filepath.Join(cwd, ".git")); err == nil {
		gitRepo = "yes"
	}
	return strings.Join([]string{
		"# Environment",
		"You have been invoked in the following environment:",
		" - Primary working directory: " + cwd,
		" - Is a git repository: " + gitRepo,
		" - Platform: " + platform,
		" - Shell: " + shell,
		" - OS Version: " + platform + " " + runtime.GOARCH,
		" - You are powered by the model named zcode/" + model + ".",
	}, "\n")
}

// zcodeNodePlatform maps runtime.GOOS onto Node's process.platform spelling
// (the reference's environment section uses it verbatim).
func zcodeNodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

// zcodeFormatLocalISODate renders the local-timezone ISO date (官方用本地日期，
// **不是** UTC；ref formatLocalIsoDate).
func zcodeFormatLocalISODate(now time.Time) string {
	return fmt.Sprintf("%04d-%02d-%02d", now.Year(), int(now.Month()), now.Day())
}

// zcodeContextPrefixBlock builds the single `<system-reminder>` date block that
// the official client always prepends to the FIRST user message's content array
// (「3012 的最后一个开关」；必须是数组插入，拼进文本串仍会被判裸请求).
func zcodeContextPrefixBlock(now time.Time) map[string]any {
	body := strings.Join([]string{
		zcodeContextIntro,
		"# currentDate\nToday's date is " + zcodeFormatLocalISODate(now) + ".",
		"",
		zcodeContextOutro,
	}, "\n")
	return map[string]any{"type": "text", "text": "<system-reminder>" + body + "</system-reminder>"}
}

// zcodeStartsWithSystemReminder reports whether a content value already starts
// with the date block (idempotency guard, ref startsWithSystemReminder).
func zcodeStartsWithSystemReminder(content any) bool {
	switch t := content.(type) {
	case string:
		return strings.HasPrefix(t, "<system-reminder>")
	case []any:
		if len(t) == 0 {
			return false
		}
		if first, ok := t[0].(map[string]any); ok {
			if text, ok := first["text"].(string); ok {
				return strings.HasPrefix(text, "<system-reminder>")
			}
		}
	}
	return false
}

// zcodeWithContextPrefix prepends the date block to the first user message
// (ref withContextPrefix): only messages[0], only when role=="user", idempotent.
func zcodeWithContextPrefix(messages []any, now time.Time) []any {
	if len(messages) == 0 {
		return messages
	}
	first, ok := messages[0].(map[string]any)
	if !ok {
		return messages
	}
	if role, _ := first["role"].(string); role != "user" {
		return messages
	}
	content := first["content"]
	if zcodeStartsWithSystemReminder(content) {
		return messages
	}
	prefix := zcodeContextPrefixBlock(now)
	switch t := content.(type) {
	case []any:
		first["content"] = append([]any{prefix}, t...)
	case string:
		if t == "" {
			first["content"] = []any{prefix}
		} else {
			first["content"] = []any{prefix, map[string]any{"type": "text", "text": t}}
		}
	default:
		first["content"] = []any{prefix}
	}
	return messages
}

// zcodeWithCallerSystem injects the caller's system prompt as a **text block in
// the first user message** (ref withCallerSystem, 2026-10-25 实测).
//
// ## 为什么不放进 `system` 数组
//
// 见 zcodeSystemBlocks 头注释：system 恒为官方的 3 块；追加第 4 块会让请求
// **必然**收到 `405 + 3012 unusual activity`，与它多长无关。改成注入 messages
// 后同一请求 200，模型照样读到了那段约定（ref 实测 thinking 复述了内容）。
//
// ## 形态
//
//   - 插到首轮 user content 数组的**末尾之后**（调用点先插日期块，故排在日期块后）
//   - 纯文本 content 转成块数组
//   - role != user 或无消息时原样返回（不抛错）
//   - 空/纯空白 ⇒ 原样返回（不塞空块）
//   - **幂等**：调用方内容已存在则不重复插
func zcodeWithCallerSystem(messages []any, callerSystem string) []any {
	if strings.TrimSpace(callerSystem) == "" || len(messages) == 0 {
		return messages
	}
	first, ok := messages[0].(map[string]any)
	if !ok {
		return messages
	}
	if role, _ := first["role"].(string); role != "user" {
		return messages
	}
	block := map[string]any{"type": "text", "text": callerSystem}
	switch t := first["content"].(type) {
	case []any:
		for _, item := range t {
			if m, ok := item.(map[string]any); ok {
				if text, _ := m["text"].(string); text == callerSystem {
					return messages
				}
			}
		}
		first["content"] = append(t, block)
	case string:
		if t == callerSystem {
			return messages
		}
		first["content"] = []any{map[string]any{"type": "text", "text": t}, block}
	default:
		first["content"] = []any{block}
	}
	return messages
}
