package download

import (
	"fmt"
	"strings"
)

// resolveVideoFormatSelector 根据质量预设生成视频格式选择器。
// 移植自 VidBee buildVideoFormatPreference()。
//
// 质量映射：
//
//	best:   bestvideo+bestaudio/best (不限制)
//	good:   bestvideo[height<=1080]+bestaudio[abr<=256]/bestvideo+bestaudio/best
//	normal: bestvideo[height<=720]+bestaudio[abr<=192]/bestvideo+bestaudio/best
//	bad:    bestvideo[height<=480]+bestaudio[abr<=128]/bestvideo+bestaudio/best
//	worst:  worstvideo+worstaudio/worst/best
func resolveVideoFormatSelector(quality QualityPreset) string {
	switch quality {
	case QualityBest:
		return "bestvideo+bestaudio/best"
	case QualityWorst:
		return "worstvideo+worstaudio/worst/best"
	}
	videoCandidates := []string{}
	if maxHeight := qualityToVideoHeight(quality); maxHeight > 0 {
		videoCandidates = append(videoCandidates, fmt.Sprintf("bestvideo[height<=%d]", maxHeight))
	}
	videoCandidates = append(videoCandidates, "bestvideo")

	audioSelectors := []string{}
	if abr := qualityToAudioAbr(quality); abr > 0 {
		audioSelectors = append(audioSelectors, fmt.Sprintf("bestaudio[abr<=%d]", abr))
	}
	audioSelectors = append(audioSelectors, "bestaudio")

	combinations := []string{}
	for _, video := range videoCandidates {
		for _, audio := range audioSelectors {
			combinations = append(combinations, video+"+"+audio)
		}
	}
	combinations = append(combinations, "bestvideo+bestaudio", "best")
	return strings.Join(dedupe(combinations), "/")
}

// resolveAudioFormatSelector 根据质量预设生成音频格式选择器。
// 移植自 VidBee buildAudioFormatPreference()。
func resolveAudioFormatSelector(quality QualityPreset) string {
	if quality == QualityWorst {
		return "worstaudio/bestaudio/best"
	}
	selectors := []string{}
	if abr := qualityToAudioAbr(quality); abr > 0 {
		selectors = append(selectors, fmt.Sprintf("bestaudio[abr<=%d]", abr))
	}
	selectors = append(selectors, "bestaudio")
	selectors = append(selectors, "best")
	return strings.Join(dedupe(selectors), "/")
}

// qualityToVideoHeight 返回质量预设对应的视频高度上限（0 表示无限制）。
func qualityToVideoHeight(quality QualityPreset) int {
	switch quality {
	case QualityGood:
		return 1080
	case QualityNormal:
		return 720
	case QualityBad:
		return 480
	case QualityWorst:
		return 360
	default:
		return 0
	}
}

// qualityToAudioAbr 返回质量预设对应的音频码率上限（0 表示无限制，将回退到 bestaudio）。
func qualityToAudioAbr(quality QualityPreset) int {
	switch quality {
	case QualityBest:
		return 320
	case QualityGood:
		return 256
	case QualityNormal:
		return 192
	case QualityBad:
		return 128
	case QualityWorst:
		return 96
	default:
		return 0
	}
}

// dedupe 去除切片中的重复元素（保持顺序）。
func dedupe(items []string) []string {
	seen := make(map[string]struct{}, len(items))
	result := make([]string, 0, len(items))
	for _, it := range items {
		if it == "" {
			continue
		}
		if _, ok := seen[it]; ok {
			continue
		}
		seen[it] = struct{}{}
		result = append(result, it)
	}
	return result
}
