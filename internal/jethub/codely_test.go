package jethub

// Codely 测试：签名固定向量、设备码解析、目录/积分/签到解析、产品接线。

import (
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestCodelySignaturesMatchVectors 锁住 ref tests/unit/codely-sign.spec.ts 的
// 固定向量 —— 分隔符必须是 LF（`|` / `\r\n` 都 401）。
func TestCodelySignaturesMatchVectors(t *testing.T) {
	const cliKey = "sk-vector-test-key"
	ts := time.Unix(1_700_000_000, 0)
	if got := hex.EncodeToString(codelySigningKey(cliKey)); got != "0ad33fb257995d8181eed266bd43f206457dd25007798666a00e459069d8a5d2" {
		t.Fatalf("signing key = %s", got)
	}
	const target = "https://codely-litellm.tuanjie.cn/v1/chat/completions"
	want := "v1.1700000000.AdWvnekCYLcvPTjG7VFMvQJklJu41L7Bwbvgb7l4kZo"
	if got := codelySignatureHeader(cliKey, target, ts); got != want {
		t.Fatalf("signature = %q, want %q (LF separator)", got, want)
	}
	// 错误分隔符的对照（证明判据有牙；同时记录历史坑）。
	if got := codelySignatureHeader(cliKey, target, ts); got == "v1.1700000000.Ok-Fv7wT84pUaSfkpBGyd25wygsWNoPdCsOp1E1ea_E" {
		t.Fatal("pipe separator must not reproduce the official vector")
	}
	// query 不参与签名。
	if a, b := codelySignatureHeader(cliKey, target, ts), codelySignatureHeader(cliKey, target+"?x=1", ts); a != b {
		t.Fatal("query must not participate in the signature")
	}
	// 完整头集：UA 必须 codely-cli 形态；session 头必填。
	headers := codelySignedHeaders(cliKey, target, "session-abc", ts)
	if headers["User-Agent"] != codelyCLIUserAgent || headers["Authorization"] != "Bearer "+cliKey ||
		headers["x-litellm-session-id"] != "session-abc" || headers["X-Codely-Signature"] != want {
		t.Fatalf("signed headers drifted: %#v", headers)
	}
}

func TestCodelyJWTExpDecode(t *testing.T) {
	// {"exp":1700000000}
	payload := "eyJleHAiOjE3MDAwMDAwMDB9"
	token := "h." + payload + ".s"
	if got := decodeCodelyJWTExpMs(token); got != 1_700_000_000_000 {
		t.Fatalf("exp = %d", got)
	}
	if got := decodeCodelyJWTExpMs("not-a-jwt"); got != 0 {
		t.Fatalf("non-JWT must return 0 (unknown), got %d", got)
	}
	if got := decodeCodelyJWTExpMs("a.eyJleHAiOiJ4In0.c"); got != 0 {
		t.Fatalf("string exp must return 0, got %d", got)
	}
}

func TestCodelyParseDeviceAuthAndExchange(t *testing.T) {
	auth, err := codelyParseDeviceAuth(map[string]any{
		"auth_request_token":        "tok",
		"user_code":                 "ABCD",
		"verification_uri":          "https://codely.tuanjie.cn/device",
		"verification_uri_complete": "https://codely.tuanjie.cn/device?code=ABCD",
		"interval":                  float64(2),
		"expires_in":                float64(900),
	})
	if err != nil {
		t.Fatal(err)
	}
	if auth.LoginURL != "https://codely.tuanjie.cn/device?code=ABCD" || auth.UserCode != "ABCD" {
		t.Fatalf("auth = %#v", auth)
	}
	if auth.Interval != 2*time.Second || auth.Expires != 15*time.Minute {
		t.Fatalf("intervals = %v / %v", auth.Interval, auth.Expires)
	}
	if _, err := codelyParseDeviceAuth(map[string]any{"auth_request_token": "t"}); err == nil {
		t.Fatal("missing verification_uri must error")
	}
	access, refresh, err := codelyParseExchange(map[string]any{"access_token": "a", "refresh_token": "r"})
	if err != nil || access != "a" || refresh != "r" {
		t.Fatalf("exchange = %q %q %v", access, refresh, err)
	}
	if _, _, err := codelyParseExchange(map[string]any{"access_token": "a"}); err == nil {
		t.Fatal("missing refresh_token must error")
	}
}

func TestCodelyParseModelStatus(t *testing.T) {
	fixture := `{"windowStart":"x","models":[{"modelGroup":"codely-core","status":"operational"},` +
		`{"modelGroup":"codely-basic","status":"degraded"},{"modelGroup":"codely-core","status":"outage"},` +
		`{"status":"operational"}]}`
	ids := codelyParseModelStatus([]byte(fixture))
	if len(ids) != 2 || ids[0] != "codely-core" || ids[1] != "codely-basic" {
		t.Fatalf("ids = %v (status must not be part of the id/name)", ids)
	}
	if got := codelyParseModelStatus([]byte("not json")); got != nil {
		t.Fatalf("malformed catalog = %v", got)
	}
}

func TestCodelyParseBalance(t *testing.T) {
	// 实测形态：remaining_points 是**字符串**；details 逐桶。
	fixture := map[string]any{
		"remaining_points": "2400",
		"is_exhausted":     false,
		"details": []any{
			map[string]any{"type": "gift_credit", "remaining_points": "2000", "exhausted": false},
			map[string]any{"type": "recharge", "remaining_points": float64(400), "exhausted": false},
		},
	}
	bal, err := codelyParseBalance(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if bal.Total != 2400 || len(bal.Packages) != 2 || bal.Packages[0].Name != "赠送积分" {
		t.Fatalf("balance = %#v", bal)
	}
	if bal.Packages[1].Name != "recharge" {
		t.Fatalf("unknown type must stay raw, got %q", bal.Packages[1].Name)
	}

	// 顶层汇总兜底（无 details）。
	bal, err = codelyParseBalance(map[string]any{"remaining_points": "7"})
	if err != nil || bal.Total != 7 || len(bal.Packages) != 1 {
		t.Fatalf("top-level fallback = %#v / %v", bal, err)
	}

	// 读不出的桶 ⇒ 报错，不静默显示 0。
	if _, err := codelyParseBalance(map[string]any{"details": []any{
		map[string]any{"type": "gift_credit", "remaining_points": ""},
	}}); err == nil {
		t.Fatal("unreadable bucket must error (not 0)")
	}
	// 空 details 且无顶层 ⇒ 报错。
	if _, err := codelyParseBalance(map[string]any{}); err == nil {
		t.Fatal("missing remaining_points must error")
	}
}

func TestCodelyParseCheckin(t *testing.T) {
	payload := map[string]any{
		"activity_status": "ACTIVE",
		"check_in_status": "READY",
		"check_in_count":  float64(19),
		"max_count":       float64(31),
		"can_check_in":    true,
		"levels": []any{
			map[string]any{"level": float64(1), "status": "COMPLETED"},
			map[string]any{"level": float64(20), "status": "CURRENT", "reward_summary": "+300"},
		},
	}
	state := codelyParseCheckinState(payload)
	if !state.CanCheckIn || state.Count != 19 || state.MaxCount != 31 {
		t.Fatalf("state = %#v", state)
	}
	if !state.HasReward || state.Reward != 300 {
		t.Fatalf("reward = %v (has=%v)", state.Reward, state.HasReward)
	}
	if r, ok := codelyReward("+ 300 积分"); !ok || r != 300 {
		t.Fatalf("reward parse = %v/%v", r, ok)
	}
	if _, ok := codelyReward("神秘奖励"); ok {
		t.Fatal("unparseable reward must not fabricate a number")
	}
	if got := codelyActivityLabel("ENDED"); !strings.Contains(got, "结束") {
		t.Fatalf("activity label = %q", got)
	}
	if got := codelyActivityLabel("WEIRD"); !strings.Contains(got, "WEIRD") {
		t.Fatalf("unknown status must keep the raw value: %q", got)
	}
}

func TestCodelyFallbackModelsAndWiring(t *testing.T) {
	models := CodelyFallbackModels()
	if len(models) != 8 {
		t.Fatalf("fallback models = %d, want 8", len(models))
	}
	want := map[string]bool{"codely-core": true, "codely-basic": true, "codely-flash": true,
		"codely-air": true, "codely-vl": true, "DeepSeek-V4.1-Flash": true,
		"GLM-5.3-FLASH": true, "KIMI-K3": true}
	for _, m := range models {
		if !want[m.ID] {
			t.Fatalf("unexpected model %q", m.ID)
		}
	}
	if !ProviderExists("codely") {
		t.Fatal("codely must be a known provider")
	}
	m, err := NewManager(t.TempDir(), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	b := NewBridge(m, nil)
	RegisterDefaultProducts(b)
	prod, ok := b.Product("codely")
	if !ok {
		t.Fatal("codely product must be registered")
	}
	if prod.InferURL != "https://codely-litellm.tuanjie.cn/v1/chat/completions" {
		t.Fatalf("InferURL = %q", prod.InferURL)
	}
	if prod.ModelsFor == nil {
		t.Fatal("codely product must wire ModelsFor (remote /api/model-status)")
	}
	// 无账号 ⇒ 不发远端请求，回落静态表。
	if got := CodelyModelsFor(m); len(got) != 8 {
		t.Fatalf("offline models = %d", len(got))
	}
}

func TestCodelyCredentialRoundTrip(t *testing.T) {
	cred := &CodelyCredential{AccessToken: "a", RefreshToken: "r", ObtainedAt: 1, ExpiresAt: "2027-01-01T00:00:00Z"}
	raw, err := json.Marshal(cred)
	if err != nil {
		t.Fatal(err)
	}
	var back CodelyCredential
	if err := json.Unmarshal(raw, &back); err != nil || back.AccessToken != "a" || codelyExpiresAtMs(&back) == 0 {
		t.Fatalf("round trip = %#v / %v", back, err)
	}
}
