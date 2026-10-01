// Package storymaker: prompts.go — extracted user-prompt builders from
// internal/api/storymaker/register.go (G4). Pure string construction only;
// the HTTP/SSE handlers assemble requests themselves.
package storymaker

import (
	"fmt"
	"strings"
)

// BuildDirectionInputPrompt renders the M0 "architecture input" brainstorm
// user prompt. All fields optional; falls back to a free-creation nudge.
func BuildDirectionInputPrompt(topic, genre, guidance string, chapters int) string {
	userParts := []string{}
	if topic != "" {
		userParts = append(userParts, "灵感/主题："+topic)
	}
	if genre != "" {
		userParts = append(userParts, "偏好类型："+genre)
	}
	if chapters > 0 {
		userParts = append(userParts, fmt.Sprintf("预估总章节数：%d", chapters))
	}
	if guidance != "" {
		userParts = append(userParts, "已有思路/梗概："+guidance)
	}
	userPrompt := strings.Join(userParts, "\n")
	if userPrompt == "" {
		userPrompt = "请自由发挥创意，生成一个有趣的小说创作方向。"
	}
	return userPrompt
}

// BuildArchitecturePrompt renders the M0 overall-architecture user prompt.
func BuildArchitecturePrompt(topic, genre, guidance string, chapters int) string {
	userParts := []string{"主题：" + strings.TrimSpace(topic)}
	if genre != "" {
		userParts = append(userParts, "类型："+genre)
	}
	if chapters > 0 {
		userParts = append(userParts, fmt.Sprintf("预估总章节数：%d", chapters))
	}
	if guidance != "" {
		userParts = append(userParts, "核心梗概 / 指导："+guidance)
	}
	userParts = append(userParts, "", "请按工作方法与输出格式，生成这部小说的总体架构。")
	return strings.Join(userParts, "\n")
}

// BuildBlueprintPrompt renders the chapter-blueprint user prompt.
func BuildBlueprintPrompt(architecture string, total, begin, end int, existingDirectory string) string {
	userParts := []string{
		"【已确认的小说架构】",
		strings.TrimSpace(architecture),
		"",
	}
	if strings.TrimSpace(existingDirectory) != "" {
		userParts = append(userParts, fmt.Sprintf("【已有章节目录（请保持连贯，从第 %d 章续写）】\n%s", begin, strings.TrimSpace(existingDirectory)))
	} else {
		userParts = append(userParts, fmt.Sprintf("本次从第 %d 章开始生成。", begin))
	}
	userParts = append(userParts, "", fmt.Sprintf("全书共约 %d 章，本次生成第 %d–%d 章的蓝图（不超过 20 章）。", total, begin, end), "请按输出格式逐章生成。")
	return strings.Join(userParts, "\n")
}

// BuildCardSinglePrompt renders the M2 single-card generation prompt.
func BuildCardSinglePrompt(cardType, instruction, existingCard string) string {
	isEnrich := existingCard != ""
	userParts := []string{
		fmt.Sprintf("实体类型（type）：%s", strings.TrimSpace(cardType)),
	}
	if isEnrich {
		userParts = append(userParts, "模式：enrich（在已有卡片基础上丰富扩写）", "\n【已有卡片内容】\n"+existingCard)
	} else {
		userParts = append(userParts, "模式：create（从零创作）")
	}
	if strings.TrimSpace(instruction) != "" {
		userParts = append(userParts, "\n【用户描述/指令】\n"+strings.TrimSpace(instruction))
	} else {
		userParts = append(userParts, "\n【用户描述/指令】\n（用户未提供具体描述）请自由随机创作一个该类型的设定：自行决定全部细节（姓名/外貌/性格/能力/背景等），追求新颖、有记忆点、避免俗套与雷同。")
	}
	userParts = append(userParts, "\n请按输出格式生成单个 JSON 对象。")
	return strings.Join(userParts, "\n")
}

// BuildCardProfilesPrompt renders the M2 multi-profile prompt.
func BuildCardProfilesPrompt(cardType string, count int, instruction string) string {
	return fmt.Sprintf("实体类型：%s\n需要的侧写数量：%d\n整体要求/主题：%s\n\n请按输出格式输出单个 JSON 对象。",
		cardType, count, instruction)
}

// BuildFinalizePrompt renders the M5 chapter-finalization prompt.
func BuildFinalizePrompt(chapterText, existingGlobalSummary, existingStates string) string {
	userParts := []string{
		"【本章正文】",
		chapterText,
		"",
	}
	if existingGlobalSummary != "" {
		userParts = append(userParts, "【现有全局摘要】\n"+existingGlobalSummary, "")
	}
	if existingStates != "" {
		userParts = append(userParts, "【现有角色状态】\n"+existingStates, "")
	}
	userParts = append(userParts, "请按输出格式生成定稿 JSON 对象。")
	return strings.Join(userParts, "\n")
}

// BuildConsistencyPrompt renders the M5 three-dimension consistency prompt.
func BuildConsistencyPrompt(chapterText, architecture, characterStates, previousSummary string) string {
	userParts := []string{
		"【待审校章节正文】",
		chapterText,
		"",
	}
	if architecture != "" {
		userParts = append(userParts, "【小说架构】\n"+architecture, "")
	}
	if characterStates != "" {
		userParts = append(userParts, "【角色状态】\n"+characterStates, "")
	}
	if previousSummary != "" {
		userParts = append(userParts, "【前文摘要】\n"+previousSummary, "")
	}
	userParts = append(userParts, "请进行三维度审校，按输出格式生成 JSON。")
	return strings.Join(userParts, "\n")
}

// SimulateContext carries the assembled role-play context for the M3
// simulate prompt (mirrors the fields of AssembledContext the template uses).
type SimulateContext struct {
	SceneDesc                    string
	SceneGoal                    string
	ScenePrevSummary             string
	TargetCharacterName          string
	TargetCharacterDescription   string
	TargetCharacterStyleNote     string
	TargetCharacterStyleExamples []string
	PresentCharacterNames        []string
	AdoptedFragments             []string
}

// BuildSimulatePrompt renders the M3 role-play simulation user prompt.
func BuildSimulatePrompt(ctx SimulateContext) string {
	userParts := []string{}
	if ctx.SceneDesc != "" || ctx.SceneGoal != "" || ctx.ScenePrevSummary != "" {
		userParts = append(userParts, "# 当前场景", "环境："+ctx.SceneDesc, "目标："+ctx.SceneGoal, "前情："+ctx.ScenePrevSummary, "")
	}
	if ctx.TargetCharacterName != "" {
		userParts = append(userParts, "# 目标角色", "姓名："+ctx.TargetCharacterName, "设定："+ctx.TargetCharacterDescription, "语言风格："+ctx.TargetCharacterStyleNote, "")
		if len(ctx.TargetCharacterStyleExamples) > 0 {
			userParts = append(userParts, "台词示例："+strings.Join(ctx.TargetCharacterStyleExamples, " / "))
		}
	}
	if len(ctx.PresentCharacterNames) > 0 {
		userParts = append(userParts, "# 在场其他角色："+strings.Join(ctx.PresentCharacterNames, "、"), "")
	}
	if len(ctx.AdoptedFragments) > 0 {
		userParts = append(userParts, "# 本场景已有片段：", strings.Join(ctx.AdoptedFragments, "\n"), "")
	}
	userParts = append(userParts, "请直接输出该角色的自然反应片段（200-400字）。")
	return strings.Join(userParts, "\n")
}
