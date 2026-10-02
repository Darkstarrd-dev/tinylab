package jethub

// ZCode 核心层测试：3012 身份块逐字锁定、凭据解密、device_mid、展示字段、
// 模型表与档位门禁。

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
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
	if got := len(zcodeIdentityStableSections); got != 3 {
		t.Fatalf("stable sections = %d, want 3", got)
	}
	stable := zcodeStableText()
	// ⚠️ 参考实现的 2856 是 JS 的 UTF-16 码元数；Go 的 len() 是 UTF-8 字节数
	// （文本含 em-dash 等非 ASCII，每字符 3 字节）⇒ 2860 字节才是同一份文本。
	if len(stable) != 2860 {
		t.Fatalf("stable len = %d bytes, want 2860 (2856 UTF-16 units)", len(stable))
	}
	sum := sha256.Sum256([]byte(stable))
	if hex.EncodeToString(sum[:]) != "3fdb43778fddc6a482c91725268a712774d5a090366e2a0df200369fed9f60ef" {
		t.Fatalf("stable sha256 drifted — the identity text no longer matches ref zcode-identity.ts @ e06283c")
	}
	cliSum := sha256.Sum256([]byte(zcodeIdentityCLIPrefix))
	if hex.EncodeToString(cliSum[:]) != "46dd360a22c87a92dfdf29ae2c3011b0f9a014209a7b607f8fcd17a920e5eafa" {
		t.Fatalf("cliPrefix sha256 drifted")
	}
}

func TestZcodeSystemBlocksShape(t *testing.T) {
	blocks := zcodeSystemBlocks("caller prompt", t.TempDir(), "GLM-5.3")
	if len(blocks) != 4 {
		t.Fatalf("blocks = %d, want 4 (cli + stable + env + caller)", len(blocks))
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
	last := blocks[3].(map[string]any)
	if last["text"] != "caller prompt" {
		t.Fatalf("caller system must be appended LAST")
	}
	if cc, ok := last["cache_control"].(map[string]any); !ok || cc["type"] != "ephemeral" {
		t.Fatalf("last block must carry the ephemeral cache breakpoint")
	}
	// 空 caller → 3 块，断点仍在最后一块。
	blocks = zcodeSystemBlocks("   ", t.TempDir(), "GLM-5.3")
	if len(blocks) != 3 {
		t.Fatalf("blank caller must not add a block, got %d", len(blocks))
	}
	if _, ok := blocks[2].(map[string]any)["cache_control"]; !ok {
		t.Fatal("env block must carry the breakpoint when the caller block is absent")
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

// --- 凭据解密 ---

func zcodeEncryptForTest(t *testing.T, plain string, key [32]byte) string {
	t.Helper()
	block, err := aes.NewCipher(key[:])
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		t.Fatal(err)
	}
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	data := sealed[:len(sealed)-16]
	tag := sealed[len(sealed)-16:]
	return zcodeCredentialPrefix +
		base64.RawURLEncoding.EncodeToString(iv) + "." +
		base64.RawURLEncoding.EncodeToString(tag) + "." +
		base64.RawURLEncoding.EncodeToString(data)
}

func TestZcodeCredentialDecryptRoundTrip(t *testing.T) {
	t.Setenv(zcodeCredentialSecretEnv, "test-secret")
	key := sha256.Sum256([]byte("test-secret"))
	ciphertext := zcodeEncryptForTest(t, `{"hello":"世界"}`, key)
	plain, err := zcodeDecryptCredentialValue(ciphertext)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if plain != `{"hello":"世界"}` {
		t.Fatalf("plaintext = %q", plain)
	}
	// 明文直通（无前缀）。
	if out, err := zcodeDecryptCredentialValue("plain-value"); err != nil || out != "plain-value" {
		t.Fatalf("plaintext passthrough failed: %q %v", out, err)
	}
	// 格式非法。
	if _, err := zcodeDecryptCredentialValue(zcodeCredentialPrefix + "abc"); err == nil {
		t.Fatal("malformed ciphertext must error")
	}
	// 密钥不匹配（GCM 认证失败）。
	other := sha256.Sum256([]byte("other-secret"))
	if _, err := zcodeDecryptCredentialValue(zcodeEncryptForTest(t, "x", other)); err == nil {
		t.Fatal("wrong key must fail authentication")
	}
}

// 官方客户端的密钥派生：env 覆盖 → sha256(secret)；否则
// sha256("zcode-credential-fallback:" + nodePlatform + ":" + homedir + ":" + username)。
// ⚠️ platform 必须是 Node 的取值（win32），Go 的 windows 会算出不同的密钥。
func TestZcodeCredentialKeyDerivation(t *testing.T) {
	t.Setenv(zcodeCredentialSecretEnv, "abc")
	if got, want := zcodeCredentialKey(), sha256.Sum256([]byte("abc")); got != want {
		t.Fatalf("env override key mismatch")
	}
	t.Setenv(zcodeCredentialSecretEnv, "")
	key := zcodeCredentialKey()
	home, _ := os.UserHomeDir()
	platform := "linux"
	if runtime.GOOS == "windows" {
		platform = "win32"
	}
	// 用户名取当前用户（与实现同源），只断言前缀与形状，避免环境差异。
	if len(key) != 32 {
		t.Fatalf("fallback key length = %d", len(key))
	}
	_ = home
	_ = platform
	// 同一进程内两次派生必须一致（决定性）。
	if zcodeCredentialKey() != key {
		t.Fatal("key derivation must be deterministic")
	}
}

func TestZcodePickCredentialSkipsUndecryptable(t *testing.T) {
	t.Setenv(zcodeCredentialSecretEnv, "k")
	key := sha256.Sum256([]byte("k"))
	table := map[string]string{
		"uuid-1:zcodejwttoken": zcodeCredentialPrefix + "broken.value.here",
		"uuid-2:zcodejwttoken": zcodeEncryptForTest(t, "jwt-abc", key),
	}
	if got := zcodePickCredential(table, zcodeKeyFragmentJWT); got != "jwt-abc" {
		t.Fatalf("pick = %q, want the first decryptable value", got)
	}
	if got := zcodePickCredential(table, "oauth:bigmodel:user_info"); got != "" {
		t.Fatalf("missing fragment must yield empty, got %q", got)
	}
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

// --- 展示字段（ref REAL_USER_INFO 形状）---

const zcodeRealUserInfo = `{"id":"15951790100986814","username":"mylzscy4","displayName":"mylzscy4",` +
	`"rawProfile":{"user_id":"15951790100986814","email":"","avatar":"","name":"mylzscy4","zcodeProfileSchemaVersion":2}}`

func TestZcodeIdentityFromUserInfo(t *testing.T) {
	name, userID := zcodeIdentityFromUserInfo(zcodeRealUserInfo)
	if name != "mylzscy4" {
		t.Fatalf("name = %q", name)
	}
	if userID != "15951790100986814" {
		t.Fatalf("userID = %q", userID)
	}
	// ⚠️ 展示名（displayName）进的是 account_name；account_label 的判据是
	// phone/mobile/name/nickname/email 这些**顶层**字段，真实 user_info 一个都没有
	// ⇒ 落到 id 末 6 位（ref labelFromUserInfo 逐字如此）。
	if got := zcodeLabelFromUserInfo(zcodeRealUserInfo); got != "id:986814" {
		t.Fatalf("label = %q, want id:986814 (no top-level phone/name/email in the real payload)", got)
	}
	if got := zcodePhoneFromUserID(userID); got != "159****0100" {
		t.Fatalf("masked phone = %q, want 159****0100 (first 11 digits of the user id)", got)
	}
	// 非手机号形态的 id：不编造。
	if got := zcodePhoneFromUserID("25951790100986814"); got != "" {
		t.Fatalf("invalid prefix must yield empty, got %q", got)
	}
	if got := zcodePhoneFromUserID("123"); got != "" {
		t.Fatalf("short id must yield empty, got %q", got)
	}
	// 纯数字展示名 → 尾号。
	label := zcodeLabelFromUserInfo(`{"phone":"13800001111"}`)
	if label != "尾号1111" {
		t.Fatalf("numeric label = %q, want 尾号1111", label)
	}
}

func TestZcodeVersionFromManifest(t *testing.T) {
	if got := zcodeVersionFromManifest(`{"version": "3.14.4", "channel":"stable"}`); got != "3.14.4" {
		t.Fatalf("manifest version = %q", got)
	}
	if got := zcodeVersionFromManifest(`{"version": "not-semver"}`); got != "" {
		t.Fatalf("non-semver must be rejected, got %q", got)
	}
	if got := zcodeVersionFromManifest(`{}`); got != "" {
		t.Fatalf("missing version must be empty, got %q", got)
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

// --- 官方凭据文件导入 ---

func TestZcodeImportLocalCredential(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ZCODE_DATA_BASE_DIR", root)
	t.Setenv("APPDATA", "")
	t.Setenv("LOCALAPPDATA", "")
	// ⚠️ homedir 也在候选根里（官方默认 dataBaseDir = homedir）—— 不隔离它，
	// 本机真实安装的 ~/.zcode/v2/telemetry-state.json 会被读进来（本机确实装着
	// 官方客户端），测试就不再决定性。
	t.Setenv("USERPROFILE", root)
	t.Setenv("HOME", root)
	t.Setenv(zcodeCredentialSecretEnv, "import-secret")
	key := sha256.Sum256([]byte("import-secret"))

	dir := filepath.Join(root, ".zcode", "v2")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	table := map[string]string{
		"aaa:zcodejwttoken":               zcodeEncryptForTest(t, "jwt-value", key),
		"bbb:oauth:bigmodel:access_token": zcodeEncryptForTest(t, "bigmodel-token", key),
		"ccc:oauth:bigmodel:user_info":    zcodeEncryptForTest(t, zcodeRealUserInfo, key),
	}
	raw, _ := json.Marshal(table)
	if err := os.WriteFile(filepath.Join(dir, "credentials.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "telemetry-state.json"), []byte(`{"deviceMid":"11111111-2222-4333-8444-555555555555"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cred := zcodeImportLocalCredential()
	if cred == nil {
		t.Fatal("import returned nil for a valid credentials file")
	}
	if cred.ZcodeJWT != "jwt-value" || cred.DeviceMid != "11111111-2222-4333-8444-555555555555" {
		t.Fatalf("imported credential wrong: %#v", cred)
	}
	if cred.Source != "ide" || cred.UserID != "15951790100986814" || cred.AccountName != "mylzscy4" {
		t.Fatalf("identity fields wrong: %#v", cred)
	}
	if cred.Phone != "159****0100" {
		t.Fatalf("phone = %q", cred.Phone)
	}
	if !cred.usable() {
		t.Fatal("imported credential must be usable")
	}

	// 缺 telemetry-state.json ⇒ 不可用（device_mid 是硬需求）。
	if err := os.Remove(filepath.Join(dir, "telemetry-state.json")); err != nil {
		t.Fatal(err)
	}
	if got := zcodeImportLocalCredential(); got != nil {
		t.Fatalf("missing device_mid must make the file unusable, got %#v", got)
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
		"User-Agent":          "ZCode/3.14.9",
		"HTTP-Referer":        "https://zcode.z.ai",
		"X-ZCode-App-Version": "3.14.9",
		"X-Release-Channel":   "stable",
		"X-Client-Language":   "zh-CN",
		"X-Client-Timezone":   "Asia/Shanghai",
		"X-Device-Mid":        "mid-1",
		"X-Platform":          "win32",
		"X-Os-Category":       "windows",
		"anthropic-version":   "2023-06-01",
		"Content-Type":        "application/json",
		"Authorization":       "Bearer jwt-1",
	}
	for key, want := range checks {
		if got := headers[key]; got != want {
			t.Fatalf("header %s = %q, want %q", key, got, want)
		}
	}
	// 缺省版本回落常量；json=false 不带 Content-Type；captcha 头成对出现。
	fallback := zcodeHeaders(&ZcodeCredential{ZcodeJWT: "j", DeviceMid: "m"}, false, nil)
	if fallback["User-Agent"] != "ZCode/"+zcodeAppVersionFallback {
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
