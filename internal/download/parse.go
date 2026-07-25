package download

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// --- 错误分类 ---

var classifyPatterns = []struct {
	re     *regexp.Regexp
	reason string
}{
	{regexp.MustCompile(`(?i)http error 429|too many requests|rate.?limit`), "rate limited (HTTP 429)"},
	{regexp.MustCompile(`(?i)login required|requires (?:cookies|authentication)|sign in to confirm`), "authentication required"},
	{regexp.MustCompile(`(?i)not available in your country|geo.?restricted|geographic`), "geo-blocked"},
	{regexp.MustCompile(`(?i)video unavailable|not found|404`), "video not found"},
	{regexp.MustCompile(`(?i)no space left|disk full|enospc`), "disk full"},
	{regexp.MustCompile(`(?i)permission denied|eacces`), "permission denied"},
	{regexp.MustCompile(`(?i)ffmpeg|ffprobe`), "ffmpeg error"},
	{regexp.MustCompile(`(?i)network|timeout|econnreset|enotfound|ehostunreach`), "network error"},
}

// classifyExitError 根据 stderr 内容分类 yt-dlp 退出错误。
func classifyExitError(stderr string) error {
	txt := strings.ToLower(stderr)
	for _, p := range classifyPatterns {
		if p.re.MatchString(txt) {
			return fmt.Errorf("yt-dlp: %s", p.reason)
		}
	}
	return fmt.Errorf("yt-dlp exited with error: %s", strings.TrimSpace(stderr))
}

// wrapInfoError 包装信息查询阶段的错误。
func wrapInfoError(err error, stderr string) error {
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		return fmt.Errorf("query failed: %w", err)
	}
	return fmt.Errorf("query failed: %s", msg)
}

// --- JSON 解析辅助 ---

func parseVideoInfoJSON(data []byte) (*VideoInfo, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse video info: %w", err)
	}
	info := &VideoInfo{}
	if v, ok := raw["title"]; ok {
		json.Unmarshal(v, &info.Title)
	}
	if v, ok := raw["thumbnail"]; ok {
		json.Unmarshal(v, &info.Thumbnail)
	}
	if v, ok := raw["duration"]; ok {
		json.Unmarshal(v, &info.Duration)
	}
	if v, ok := raw["uploader"]; ok {
		json.Unmarshal(v, &info.Uploader)
	}
	if v, ok := raw["description"]; ok {
		json.Unmarshal(v, &info.Description)
	}
	if v, ok := raw["extractor_key"]; ok {
		json.Unmarshal(v, &info.Extractor)
	}
	if v, ok := raw["webpage_url"]; ok {
		json.Unmarshal(v, &info.WebpageURL)
	}
	return info, nil
}

func parsePlaylistInfoJSON(data []byte) (*PlaylistInfo, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse playlist info: %w", err)
	}
	info := &PlaylistInfo{}
	if v, ok := raw["id"]; ok {
		json.Unmarshal(v, &info.ID)
	}
	if v, ok := raw["title"]; ok {
		json.Unmarshal(v, &info.Title)
	}
	var entries []map[string]json.RawMessage
	if v, ok := raw["entries"]; ok {
		if err := json.Unmarshal(v, &entries); err != nil {
			// 某些情况下 entries 可能是 null
			entries = nil
		}
	}
	for i, e := range entries {
		entry := PlaylistEntry{Index: i + 1}
		if v, ok := e["id"]; ok {
			json.Unmarshal(v, &entry.ID)
		}
		if v, ok := e["title"]; ok {
			json.Unmarshal(v, &entry.Title)
		}
		if v, ok := e["url"]; ok {
			json.Unmarshal(v, &entry.URL)
		}
		if v, ok := e["thumbnail"]; ok {
			json.Unmarshal(v, &entry.Thumbnail)
		}
		info.Entries = append(info.Entries, entry)
	}
	return info, nil
}
