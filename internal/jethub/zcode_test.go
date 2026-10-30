package jethub

// ZCode 核心层测试：3012 身份块逐字锁定、device_mid、模型表与档位门禁、头族。
//
// ⚠️ 「官方客户端凭据文件导入」相关的用例已随该能力整体删除（2026-10-05，对齐上游
// 2e8bb86）—— 取而代之的是 `zcode_local_read_test.go` 的**源码字面量扫描**守卫
// （断言函数不存在对新写的读取函数无效）。

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"testing"
	"time"
)

// --- 3012 身份块：逐字锁定 ---

// 上游对 system 做内容检查，缺身份块直接 3012，且 3012 有账号冷却惩罚
// （30min → 24h → 停用）。故文本必须与参考实现逐字一致：字符数 + sha256 双锁。
func TestZcodeIdentityTextMatchesReference(t *testing.T) {
	if len(zcodeIdentityCLIPrefix) != 42 {
		t.Fatalf("cliPrefix len = %d, want 42", len(zcodeIdentityCLIPrefix))
	}
	if zcodeIdentityCLIPrefix != "You are ZCode, an interactive coding agent" {
		t.Fatalf("cliPrefix text drifted: %q", zcodeIdentityCLIPrefix)
	}
	if got := len(zcodeIdentityStableSections); got != 2 {
		t.Fatalf("stable sections = %d, want 2 (官方 2026-10-23 起不再有 # Working style)", got)
	}
	stable := zcodeStableText()
	// ⚠️ 参考实现的 2590 是 JS 的 UTF-16 码元数；Go 的 len() 是 UTF-8 字节数
	// （文本含 em-dash 等非 ASCII）⇒ 2594 字节才是同一份文本。
	if len(stable) != 2594 {
		t.Fatalf("stable len = %d bytes, want 2594 (2590 UTF-16 units)", len(stable))
	}
	sum := sha256.Sum256([]byte(stable))
	if hex.EncodeToString(sum[:]) != "135a288c4616306ef3c084312f0568be7e20997b9261626c85309d75fa00144c" {
		t.Fatalf("stable sha256 drifted — the identity text no longer matches ref zcode-identity.ts @ 9ffd65e")
	}
	cliSum := sha256.Sum256([]byte(zcodeIdentityCLIPrefix))
	if hex.EncodeToString(cliSum[:]) != "46dd360a22c87a92dfdf29ae2c3011b0f9a014209a7b607f8fcd17a920e5eafa" {
		t.Fatalf("cliPrefix sha256 drifted")
	}
}

func TestZcodeSystemBlocksShape(t *testing.T) {
	// ★ 恒为 3 块（ref 9893e91 实测：第 4 块 = 405+3012，与长度无关）。
	blocks := zcodeSystemBlocks(t.TempDir(), "GLM-5.3")
	if len(blocks) != 3 {
		t.Fatalf("blocks = %d, want 3 (cli + stable + env)", len(blocks))
	}
	first := blocks[0].(map[string]any)
	if first["text"] != zcodeIdentityCLIPrefix {
		t.Fatalf("block[0] must be the cli prefix")
	}
	second := blocks[1].(map[string]any)
	if second["text"] != zcodeStableText() {
		t.Fatalf("block[1] must be the stable sections")
	}
	if _, hasCache := first["cache_control"]; hasCache {
		t.Fatal("only the LAST block may carry a cache breakpoint")
	}
	env := blocks[2].(map[string]any)["text"].(string)
	if !strings.Contains(env, "# Environment") || !strings.Contains(env, "powered by the model named zcode/GLM-5.3") {
		t.Fatalf("environment block malformed: %q", env)
	}
	if cc, ok := blocks[2].(map[string]any)["cache_control"].(map[string]any); !ok || cc["type"] != "ephemeral" {
		t.Fatalf("env block must carry the ephemeral cache breakpoint")
	}
}

// TestZcodeCallerSystemGoesToMessages: 调用方 system 绝不进 system 数组，
// 而是首轮 user 的最后一个 text 块（排在日期块之后、幂等）。
func TestZcodeCallerSystemGoesToMessages(t *testing.T) {
	messages := []any{map[string]any{"role": "user", "content": "你好"}}
	out := zcodeWithCallerSystem(zcodeWithContextPrefix(messages, fixedZcodeDate()), "caller rules")
	first := out[0].(map[string]any)
	if role, _ := first["role"].(string); role != "user" {
		t.Fatalf("first message role = %q", role)
	}
	content := first["content"].([]any)
	if len(content) != 3 {
		t.Fatalf("content blocks = %d, want 3 (date + text + caller)", len(content))
	}
	if text := content[0].(map[string]any)["text"].(string); !strings.HasPrefix(text, "<system-reminder>") {
		t.Fatalf("date block must stay first, got %q", text)
	}
	if text := content[2].(map[string]any)["text"].(string); text != "caller rules" {
		t.Fatalf("caller system must be the LAST block, got %q", text)
	}
	// 幂等
	again := zcodeWithCallerSystem(out, "caller rules")
	if got := len(again[0].(map[string]any)["content"].([]any)); got != 3 {
		t.Fatalf("caller injection must be idempotent, got %d blocks", got)
	}
	// 空值 / 首条非 user ⇒ 原样
	fresh := []any{map[string]any{"role": "user", "content": "你好"}}
	if got := zcodeWithCallerSystem(zcodeWithContextPrefix(fresh, fixedZcodeDate()), "   "); len(got[0].(map[string]any)["content"].([]any)) != 2 {
		t.Fatal("blank caller must not add a block")
	}
	sysFirst := []any{map[string]any{"role": "assistant", "content": "hi"}}
	if got := zcodeWithCallerSystem(sysFirst, "rules"); got[0].(map[string]any)["content"] != "hi" {
		t.Fatal("non-user first message must be left untouched")
	}
}

func TestZcodeWithContextPrefix(t *testing.T) {
	messages := []any{map[string]any{"role": "user", "content": "你好"}}
	out := zcodeWithContextPrefix(messages, fixedZcodeDate())
	first := out[0].(map[string]any)
	content, ok := first["content"].([]any)
	if !ok || len(content) != 2 {
		t.Fatalf("date block must be inserted as content[0], got %#v", first["content"])
	}
	text := content[0].(map[string]any)["text"].(string)
	if !strings.HasPrefix(text, "<system-reminder>") || !strings.HasSuffix(text, "</system-reminder>") {
		t.Fatalf("date block malformed: %q", text)
	}
	if !strings.Contains(text, "Today's date is 2026-10-02.") {
		t.Fatalf("date block missing the local ISO date: %q", text)
	}
	if !strings.Contains(text, "      IMPORTANT:") {
		t.Fatalf("outro must keep its 6 leading spaces: %q", text)
	}
	// 幂等：再跑一次不重复插。
	out2 := zcodeWithContextPrefix(out, fixedZcodeDate())
	if got := len(out2[0].(map[string]any)["content"].([]any)); got != 2 {
		t.Fatalf("withContextPrefix must be idempotent, got %d blocks", got)
	}
	// 首条不是 user → 原样（content 仍是字符串，不被改写）。
	sys := []any{map[string]any{"role": "assistant", "content": "hi"}}
	got := zcodeWithContextPrefix(sys, fixedZcodeDate())
	if content, isStr := got[0].(map[string]any)["content"].(string); !isStr || content != "hi" {
		t.Fatal("non-user first message must be left untouched")
	}
}

// fixedZcodeDate pins the date block's clock (local timezone, like the
// reference's formatLocalIsoDate).
func fixedZcodeDate() time.Time {
	return time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)
}

// --- device_mid ---

func TestZcodeDeviceMidShape(t *testing.T) {
	pattern := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	seen := map[string]bool{}
	for i := 0; i < 8; i++ {
		mid := zcodeNewDeviceMid()
		if !pattern.MatchString(mid) {
			t.Fatalf("device_mid %q is not a v4 UUID", mid)
		}
		if seen[mid] {
			t.Fatalf("device_mid collision: %q", mid)
		}
		seen[mid] = true
	}
}

// --- 模型表与档位门禁 ---

func TestZcodeFallbackModelsAndEffortGate(t *testing.T) {
	models := zcodeFallbackModels()
	if len(models) != 2 {
		t.Fatalf("fallback models = %d, want 2 (GLM-5-Turbo/GLM-5.2 实测空响应，不列出)", len(models))
	}
	if models[0].ID != "GLM-5.3-Flash" || models[1].ID != "GLM-5.3" {
		t.Fatalf("unexpected model ids: %q %q", models[0].ID, models[1].ID)
	}
	if !strings.Contains(models[0].Note, "vision") || strings.Contains(models[1].Note, "vision") {
		t.Fatalf("vision capability must be declared on Flash only: %q / %q", models[0].Note, models[1].Note)
	}
	for _, level := range []string{"low", "high", "max"} {
		if !zcodeModelDeclaresEffort("GLM-5.3", level) {
			t.Fatalf("level %q must be declared", level)
		}
	}
	if zcodeModelDeclaresEffort("GLM-5.3", "xhigh") {
		t.Fatal("undeclared level must be dropped (下发未知档位可能被上游拒)")
	}
	if zcodeModelDeclaresEffort("GLM-5-Turbo", "low") {
		t.Fatal("models outside the catalog declare nothing")
	}
	if !zcodeModelSupportsImage["GLM-5.3-Flash"] || zcodeModelSupportsImage["GLM-5.3"] {
		t.Fatal("image capability table drifted")
	}
}

func TestZcodeUsableCredential(t *testing.T) {
	if (&ZcodeCredential{ZcodeJWT: "j"}).usable() {
		t.Fatal("missing device_mid must be unusable")
	}
	if (&ZcodeCredential{DeviceMid: "d"}).usable() {
		t.Fatal("missing jwt must be unusable")
	}
	if !(&ZcodeCredential{ZcodeJWT: "j", DeviceMid: "d"}).usable() {
		t.Fatal("jwt + device_mid must be usable")
	}
}

// --- 头族 ---

func TestZcodeHeaders(t *testing.T) {
	cred := &ZcodeCredential{ZcodeJWT: "jwt-1", DeviceMid: "mid-1", AppVersion: "3.14.9"}
	headers := zcodeHeaders(cred, true, nil)
	checks := map[string]string{
		// 官方 3.16.3 抓包：版本门控到 3.16.3；release-channel/platform 逐字对齐。
		"User-Agent":           "ZCode/3.16.3",
		"HTTP-Referer":         "https://zcode.z.ai",
		"X-Title":              "Z Code@electron",
		"X-ZCode-App-Version":  "3.16.3",
		"X-Release-Channel":    "production",
		"X-Client-Language":    "zh-CN",
		"X-Client-Timezone":    "Asia/Shanghai",
		"X-Device-Mid":         "mid-1",
		"X-Platform":           "win32-x64",
		"X-Os-Category":        "windows",
		"X-ZCode-Agent":        "glm",
		"X-ZCode-Session-Type": "other",
		"anthropic-version":    "2023-06-01",
		"Content-Type":         "application/json",
		"Authorization":        "Bearer jwt-1",
	}
	for key, want := range checks {
		if got := headers[key]; got != want {
			t.Fatalf("header %s = %q, want %q", key, got, want)
		}
	}
	if headers["X-Os-Version"] == "" {
		t.Fatal("X-Os-Version must be present (platform triple is self-consistent)")
	}
	if headers["X-Session-Id"] == "" || headers["X-Request-Id"] == "" || headers["X-ZCode-Trace-Id"] == "" {
		t.Fatalf("missing fingerprint headers: %#v", headers)
	}
	// session id 进程级稳定；request/trace id 每请求新。
	second := zcodeHeaders(cred, true, nil)
	if second["X-Session-Id"] != headers["X-Session-Id"] {
		t.Fatal("X-Session-Id must be stable within the process")
	}
	if second["X-Request-Id"] == headers["X-Request-Id"] || second["X-ZCode-Trace-Id"] == headers["X-ZCode-Trace-Id"] {
		t.Fatal("request/trace ids must be fresh per request")
	}
	// 缺省版本 ⇒ 门控到 3.16.3；json=false 不带 Content-Type；captcha 头成对出现。
	fallback := zcodeHeaders(&ZcodeCredential{ZcodeJWT: "j", DeviceMid: "m"}, false, nil)
	if fallback["User-Agent"] != "ZCode/"+zcodeVersionGatedMinAppVersion {
		t.Fatalf("fallback UA = %q", fallback["User-Agent"])
	}
	if _, ok := fallback["Content-Type"]; ok {
		t.Fatal("json=false must omit Content-Type")
	}
	withCaptcha := zcodeHeaders(cred, true, &zcodeCaptchaParam{Param: "p", Region: "cn"})
	if withCaptcha["x-aliyun-captcha-verify-param"] != "p" || withCaptcha["x-aliyun-captcha-verify-region"] != "cn" {
		t.Fatalf("captcha headers missing: %#v", withCaptcha)
	}
}

// TestZcodeAppVersionGate: 版本门控只抬不降；脏值不得进头 / URL。
func TestZcodeAppVersionGate(t *testing.T) {
	cases := []struct {
		stored, clean, gated string
	}{
		{"", "3.14.3", "3.16.3"},
		{"3.14.9", "3.14.9", "3.16.3"},
		{"3.16.2", "3.16.2", "3.16.3"},
		{"3.16.3", "3.16.3", "3.16.3"},
		{"3.17.0", "3.17.0", "3.17.0"},
		{"3.016.3", "3.14.3", "3.16.3"},                 // 前导零 = 脏值，且不得绕过门控
		{"3.16.3-beta.1", "3.14.3", "3.16.3"},           // 非纯数字
		{"3.16.3\r\nX-Injected: 1", "3.14.3", "3.16.3"}, // 头注入
		{" 3.16.4 ", "3.16.4", "3.16.4"},                // 仅首尾空白
	}
	for _, tc := range cases {
		cred := &ZcodeCredential{AppVersion: tc.stored}
		if got := cred.zcodeAppVersion(); got != tc.clean {
			t.Fatalf("stored %q clean version = %q, want %q", tc.stored, got, tc.clean)
		}
		if got := cred.zcodeGatedAppVersion(); got != tc.gated {
			t.Fatalf("stored %q gated version = %q, want %q", tc.stored, got, tc.gated)
		}
	}
	if zcodeCompareAppVersion("3.16.3", "3.16.3") != 0 || zcodeCompareAppVersion("3.9.0", "3.16.3") >= 0 {
		t.Fatal("semver comparison drifted")
	}
}

// --- 领取载体页的浏览器选择（2026-10-07 报障回归） ---

// TestZcodeOpenURLPinsDefaultBrowser: zcodeOpenURL 是领取载体页（后台动作）的
// 唯一开页入口，它必须**显式固定**「系统默认浏览器 + 共享会话」，而**不是**传
// 零值。零值会被 normalizeOpenOptions 用「记住的 +新建账号 偏好」补齐——那是为
// 登录流设计的（登录才需要登录态）；载体页跑的是阿里云无感验证、页面不含任何
// 凭据（领取 JWT 在服务端），根本不需要登录态。真实故障链（2026-10-07）：
// 用户给某渠道登录时选了 Edge → login-open.json 记住 edge → zcode 领取的载体页
// 跟着落到 Edge（系统默认其实是 Chrome）→ 无感验证在 Edge 里失败。回归锁两件事：
// ① 开页选项恒为 default+shared（不随偏好漂移）；② 即便记住的偏好是别的浏览器，
// 该路径也不继承它。
func TestZcodeOpenURLPinsDefaultBrowser(t *testing.T) {
	env := newTestManager(t)
	type opened struct {
		url string
		opt OpenOptions
	}
	got := make(chan opened, 1)
	env.m.SetBrowserOpener(func(url string, opt OpenOptions) { got <- opened{url, opt} })
	// 模拟报障现场：登录偏好记住的是 Edge（继承它就是复现缺陷）。
	if err := env.m.SetLoginOpenPrefs(OpenOptions{Browser: "edge", Session: SessionShared}); err != nil {
		t.Fatal(err)
	}

	env.m.zcodeOpenURL("http://127.0.0.1:20102/api/jethub/zcode/carrier?token=t")

	select {
	case o := <-got:
		if o.url != "http://127.0.0.1:20102/api/jethub/zcode/carrier?token=t" {
			t.Fatalf("opener got %q", o.url)
		}
		// ⚠ 必须是显式的 default+shared，而不是零值（零值=继承偏好）。
		if o.opt.Browser != BrowserDefault || o.opt.Session != SessionShared {
			t.Fatalf("carrier page must pin default+shared (edge preference leaked), got %+v", o.opt)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("browser opener was not invoked")
	}
}
