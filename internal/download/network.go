package download

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// appendNetworkArgs 追加网络相关参数（代理/cookies/超时/YouTube 安全参数）。
func appendNetworkArgs(args []string, settings RuntimeSettings, rawURL string) []string {
	if settings.Proxy != "" {
		args = append(args, "--proxy", settings.Proxy)
	}
	args = append(args, "--socket-timeout", defaultSocketTimeout)
	if settings.BrowserCookies != "" && settings.BrowserCookies != "none" {
		args = append(args, "--cookies-from-browser", settings.BrowserCookies)
	}
	if settings.CookiesPath != "" {
		args = append(args, "--cookies", settings.CookiesPath)
	}
	if isYouTubeURL(rawURL) {
		args = append(args, "--extractor-args", "youtube:player_client="+youtubeSafePlayerClients)
	}
	return args
}

// isYouTubeURL 判断 URL 是否为 YouTube。
// 匹配 youtube.com, youtu.be, youtube-nocookie.com 及其子域名。
func isYouTubeURL(rawURL string) bool {
	host := hostOf(rawURL)
	if host == "" {
		return false
	}
	suffixes := []string{"youtube.com", "youtu.be", "youtube-nocookie.com"}
	for _, s := range suffixes {
		if host == s || strings.HasSuffix(host, "."+s) {
			return true
		}
	}
	return false
}

// isBilibiliURL 判断 URL 是否为 Bilibili。
// 匹配 bilibili.com, b23.tv, bili.tv。
func isBilibiliURL(rawURL string) bool {
	host := hostOf(rawURL)
	if host == "" {
		return false
	}
	return strings.Contains(host, "bilibili.com") ||
		strings.Contains(host, "b23.tv") ||
		strings.Contains(host, "bili.tv")
}

// hostOf 从 URL 中提取小写主机名（解析失败返回空串）。
func hostOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// resolveFfmpegDir 从文件路径或目录路径获取 ffmpeg 目录。
// 如果是文件，返回 filepath.Dir；如果是目录，直接返回。
func resolveFfmpegDir(path string) string {
	if path == "" {
		return ""
	}
	ext := strings.ToLower(filepath.Ext(path))
	if ext != "" && !isDir(path) {
		return filepath.Dir(path)
	}
	return path
}

// isDir 判断路径是否为目录。
func isDir(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.IsDir()
}
