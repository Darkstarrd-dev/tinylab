package download

import (
	"regexp"
	"strconv"
	"strings"
)

// --- 进度解析 ---

var progressRe = regexp.MustCompile(
	`\[download\]\s+([\d.]+)%\s+of\s+([\d.]+)(KiB|MiB|GiB|TiB|B)\s+at\s+([\d.]+)(KiB|MiB|GiB|TiB|B)/s\s+ETA\s+(\d{2}:\d{2}(?::\d{2})?)`,
)

// parseProgressLine 解析 yt-dlp 的 [download] 进度行。
// 返回解析出的 Progress 和是否匹配到进度行。
func parseProgressLine(line string) (Progress, bool) {
	m := progressRe.FindStringSubmatch(line)
	if m == nil {
		return Progress{}, false
	}
	pct, _ := strconv.ParseFloat(m[1], 64)
	totalBytes := parseSize(parseFloat(m[2]), m[3])
	speed := parseSpeed(parseFloat(m[4]), m[5])
	eta := parseETA(m[6])
	percent := pct / 100.0
	var downloaded int64
	if totalBytes > 0 && percent > 0 {
		downloaded = int64(float64(totalBytes) * percent)
	}
	return Progress{
		Percent:    percent,
		Downloaded: downloaded,
		TotalBytes: totalBytes,
		SpeedBytes: speed,
		ETASeconds: eta,
	}, true
}

func parseFloat(s string) float64 {
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

// parseSize 将数值 + 单位转换为字节数。
func parseSize(value float64, unit string) int64 {
	var factor float64 = 1
	switch strings.ToLower(unit) {
	case "kib":
		factor = 1024
	case "mib":
		factor = 1024 * 1024
	case "gib":
		factor = 1024 * 1024 * 1024
	case "tib":
		factor = 1024 * 1024 * 1024 * 1024
	case "b":
		factor = 1
	}
	return int64(value * factor)
}

// parseSpeed 解析速度（单位带 /s）。
func parseSpeed(value float64, unit string) int64 {
	// unit 形如 "MiB"，与 parseSize 同单位换算
	return parseSize(value, unit)
}

// parseETA 解析 ETA 时间字符串（MM:SS 或 HH:MM:SS）为秒数。
func parseETA(s string) int {
	parts := strings.Split(s, ":")
	nums := make([]int, len(parts))
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return 0
		}
		nums[i] = n
	}
	seconds := 0
	for _, n := range nums {
		seconds = seconds*60 + n
	}
	return seconds
}

// --- 后处理检测 ---

var processingPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bMerging formats?\b`),
	regexp.MustCompile(`(?i)^\[Postprocess\]`),
	regexp.MustCompile(`(?i)\b(?:Embedding|Adding|Fixing|Converting)\b`),
	regexp.MustCompile(`(?i)\b(?:ExtractAudio|VideoConvertor|FFmpeg)\b`),
}

// hasPostprocessSignal 判断文本是否包含 ffmpeg 后处理信号。
func hasPostprocessSignal(text string) bool {
	for _, re := range processingPatterns {
		if re.MatchString(text) {
			return true
		}
	}
	return false
}

// --- 尾部缓冲 ---

// tailBuffer 是一个定长环形文本缓冲，保留最后 N 字节。
type tailBuffer struct {
	buf      []byte
	maxBytes int
}

func newTailBuffer(maxBytes int) *tailBuffer {
	if maxBytes <= 0 {
		maxBytes = 8 * 1024
	}
	return &tailBuffer{maxBytes: maxBytes}
}

// Append 追加文本到尾部缓冲（超出 maxBytes 时丢弃最旧的内容）。
func (t *tailBuffer) Append(s string) {
	t.buf = append(t.buf, s...)
	if len(t.buf) > t.maxBytes {
		t.buf = t.buf[len(t.buf)-t.maxBytes:]
	}
}

// Read 返回当前缓冲内容的拷贝。
func (t *tailBuffer) Read() string {
	return string(t.buf)
}
