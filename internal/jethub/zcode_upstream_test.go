package jethub

// ZCode 上游解析 / 登录轮询 / captcha 载体测试（全部纯函数，无网络）。

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// 实测样本（ref src/zcode-upstream.ts:104-110 的原始桶）。
const zcodeBalanceFixture = `{"code":0,"data":{"displayMode":"standard","balances":[` +
	`{"plan_id":"p1","show_name":"GLM-5.3-Flash","meter":"model_usage","unit_type":"token",` +
	`"total_units":100000000,"used_units":5460725,"remaining_units":94539275,"expires_at":1790000000},` +
	`{"plan_id":"p2","show_name":"GLM-5.3","meter":"model_usage","unit_type":"token",` +
	`"total_units":50000000,"used_units":1000000,"available_units":49000000,"expires_at":1780000000}]}}`

func TestZcodeParseBalance(t *testing.T) {
	result, err := zcodeParseBalance([]byte(zcodeBalanceFixture))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Buckets) != 2 {
		t.Fatalf("buckets = %d", len(result.Buckets))
	}
	if result.Buckets[0].UnitType != "token" {
		t.Fatalf("unit type must be preserved (界面按 M 量级显示): %#v", result.Buckets[0])
	}
	// available 优先于 remaining（ref 聚合口径）。
	want := float64(94539275 + 49000000)
	if result.Remaining != want {
		t.Fatalf("remaining = %v, want %v", result.Remaining, want)
	}
	if result.Total != float64(150000000) {
		t.Fatalf("total = %v", result.Total)
	}
	if result.ExpiresAt != 1780000000 {
		t.Fatalf("expiresAt must be the MIN across buckets, got %d", result.ExpiresAt)
	}
	if result.PlanName != "GLM-5.3-Flash" {
		t.Fatalf("planName = %q (first bucket's show_name)", result.PlanName)
	}
	// 企业版：不下发数字，不得显示成 0。
	enterprise, err := zcodeParseBalance([]byte(`{"code":0,"data":{"displayMode":"enterprise"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if !enterprise.Enterprise || len(enterprise.Buckets) != 0 {
		t.Fatalf("enterprise mode mishandled: %#v", enterprise)
	}
	if _, err := zcodeParseBalance([]byte(`{"code":0}`)); err == nil {
		t.Fatal("missing data must error")
	}
}

func TestZcodeParseModels(t *testing.T) {
	// builtinModels 是**对象**（键为序号）—— 用 Array.isArray 判定会得到假"0 条"。
	fixture := `{"code":0,"data":{"builtinModels":{` +
		`"0":{"modelId":"GLM-5.3","name":"GLM-5.3","contextWindow":1000000,"maxCompletionTokens":128000,` +
		`"capabilities":{},"reasoning":{"levels":{"low":{},"max":{},"high":{}},"defaultLevel":"max"}},` +
		`"1":{"modelId":"GLM-5.3-Flash","contextWindow":1000000,"maxCompletionTokens":128000,` +
		`"capabilities":{"vision":true},"reasoning":{"levels":{"low":{}},"defaultLevel":"low"}}}}}`
	models := zcodeParseModels([]byte(fixture))
	if len(models) != 2 {
		t.Fatalf("models = %d, want 2 (object-keyed builtinModels)", len(models))
	}
	var flash, base *zcodeRemoteModel
	for i := range models {
		switch models[i].ID {
		case "GLM-5.3-Flash":
			flash = &models[i]
		case "GLM-5.3":
			base = &models[i]
		}
	}
	if flash == nil || base == nil {
		t.Fatalf("missing models: %#v", models)
	}
	if !flash.SupportsImage || base.SupportsImage {
		t.Fatalf("vision must come from capabilities.vision (Flash only): %#v %#v", flash, base)
	}
	if flash.Name != "GLM-5.3-Flash" {
		t.Fatalf("name fallback = %q", flash.Name)
	}
	// 档位按 IDE 展示序重排（上游插入序是 low,max,high）。
	if strings.Join(base.Levels, ",") != "low,high,max" {
		t.Fatalf("level order = %v, want low,high,max", base.Levels)
	}
	if base.DefaultLevel != "max" {
		t.Fatalf("defaultLevel = %q", base.DefaultLevel)
	}
	// 空目录 ⇒ nil（不是空数组：空数组会被当成"拿到目录了"）。
	if got := zcodeParseModels([]byte(`{"code":0,"data":{"builtinModels":{}}}`)); got != nil {
		t.Fatalf("empty catalog must be nil, got %#v", got)
	}
	if got := zcodeParseModels([]byte(`{"code":0,"data":{}}`)); got != nil {
		t.Fatalf("missing catalog must be nil, got %#v", got)
	}
	// 缺字段时的保守默认（0 会让上层认为无窗口）。
	defaults := zcodeParseModels([]byte(`{"code":0,"data":{"builtinModels":{"0":{"modelId":"X"}}}}`))
	if len(defaults) != 1 || defaults[0].ContextWindow != 200_000 || defaults[0].MaxTokens != 32_768 {
		t.Fatalf("defaults wrong: %#v", defaults)
	}
}

func TestZcodeOrderReasoningLevels(t *testing.T) {
	got := zcodeOrderReasoningLevels([]string{"low", "max", "high"})
	if strings.Join(got, ",") != "low,high,max" {
		t.Fatalf("order = %v", got)
	}
	got = zcodeOrderReasoningLevels([]string{"weird", "max"})
	if strings.Join(got, ",") != "max,weird" {
		t.Fatalf("unknown levels must be appended in original order: %v", got)
	}
}

// 2026-10-02 真机抓到的形状：builtinModels 是**数组**（参考实现记录的是对象）
// —— 只认一种会得到"0 个模型"的假阴性。
func TestZcodeParseModelsArrayShape(t *testing.T) {
	fixture := `{"code":0,"data":{"builtinModels":[` +
		`{"capabilities":{},"contextWindow":1000000,"maxCompletionTokens":128000,` +
		`"modelId":"GLM-5.3","name":"GLM-5.3","reasoning":{"defaultLevel":"max",` +
		`"levels":{"high":{"anthropic":{"set":[{"path":["output_config","effort"],"value":"high"}]}},` +
		`"low":{"anthropic":{"set":[{"path":["output_config","effort"],"value":"low"}]}},` +
		`"max":{"anthropic":{"set":[{"path":["output_config","effort"],"value":"max"}]}}}}},` +
		`{"capabilities":{"vision":true},"contextWindow":1000000,"maxCompletionTokens":128000,` +
		`"modelId":"GLM-5.3-Flash","name":"GLM-5.3-Flash","reasoning":{"defaultLevel":"max",` +
		`"levels":{"low":{},"high":{},"max":{}}}}]}}`
	models := zcodeParseModels([]byte(fixture))
	if len(models) != 2 {
		t.Fatalf("array-shaped catalog must parse, got %d models", len(models))
	}
	for _, mdl := range models {
		if mdl.ID == "GLM-5.3" {
			if strings.Join(mdl.Levels, ",") != "low,high,max" {
				t.Fatalf("levels = %v", mdl.Levels)
			}
			if mdl.DefaultLevel != "max" {
				t.Fatalf("defaultLevel = %q", mdl.DefaultLevel)
			}
		}
	}
}

func TestZcodeParseClaimablePlans(t *testing.T) {
	fixture := `{"code":0,"data":{"plans":[` +
		`{"plan_id":"low","priority":1,"name":"A"},` +
		`{"plan_id":"high","priority":9},` +
		`{"plan_id":"","priority":99}]}}`
	plans := zcodeParseClaimablePlans([]byte(fixture))
	if len(plans) != 2 {
		t.Fatalf("plans = %d, want 2 (empty plan_id dropped)", len(plans))
	}
	if plans[0].PlanID != "high" || plans[1].PlanID != "low" {
		t.Fatalf("plans must be sorted by priority desc: %#v", plans)
	}
	if got := zcodeParseClaimablePlans([]byte(`{"code":0,"data":{"plans":[]}}`)); len(got) != 0 {
		t.Fatalf("empty preview = %#v", got)
	}
}

func TestZcodeParsePollResponse(t *testing.T) {
	ready := `{"code":0,"data":{"status":"ready","token":"jwt-1",` +
		`"user":{"user_id":"15951790100986814","name":"小明"},` +
		`"bigmodel":{"access_token":"bm-1","refresh_token":"rt-1"}}}`
	outcome := zcodeParsePollResponse([]byte(ready))
	if outcome.Result == nil {
		t.Fatalf("ready poll must yield a result, got %#v", outcome)
	}
	if outcome.Result.ZcodeJWT != "jwt-1" || outcome.Result.BigmodelAccessToken != "bm-1" ||
		outcome.Result.UserID != "15951790100986814" || outcome.Result.DisplayName != "小明" {
		t.Fatalf("result wrong: %#v", outcome.Result)
	}
	// camelCase 回退 + email 兜底展示名。
	camel := `{"code":0,"data":{"status":"ready","token":"j","user":{"id":"u1","email":"a@b.c"},` +
		`"bigmodel":{"accessToken":"bm"}}}`
	outcome = zcodeParsePollResponse([]byte(camel))
	if outcome.Result == nil || outcome.Result.BigmodelAccessToken != "bm" || outcome.Result.DisplayName != "a@b.c" {
		t.Fatalf("camelCase fallbacks wrong: %#v", outcome)
	}
	// pending / failed / 缺字段。
	if got := zcodeParsePollResponse([]byte(`{"code":0,"data":{"status":"pending"}}`)); !got.Pending || got.Result != nil || got.Err != nil {
		t.Fatalf("pending mishandled: %#v", got)
	}
	if got := zcodeParsePollResponse([]byte(`{"code":0,"data":{"status":"failed"}}`)); got.Err == nil {
		t.Fatal("failed must be terminal")
	}
	if got := zcodeParsePollResponse([]byte(`{"code":0,"data":{"status":"ready","token":"j"}}`)); got.Err == nil {
		t.Fatal("missing access_token/user_id must be terminal (ref 三个字段都必需)")
	}
	if got := zcodeParsePollResponse([]byte(`not json`)); !got.Pending {
		t.Fatal("unparsable body keeps polling (网络抖动不算失败)")
	}
}

// --- captcha 载体 ---

func zcodeValidParamForTest(t *testing.T) string {
	t.Helper()
	payload := map[string]any{
		"certifyId":     "c1",
		"securityToken": strings.Repeat("s", 60),
		"padding":       strings.Repeat("p", 160),
	}
	raw, _ := json.Marshal(payload)
	return base64.StdEncoding.EncodeToString(raw)
}

func TestZcodeValidateCaptchaParam(t *testing.T) {
	if err := zcodeValidateCaptchaParam(zcodeValidParamForTest(t)); err != nil {
		t.Fatalf("valid param rejected: %v", err)
	}
	if err := zcodeValidateCaptchaParam("short"); err == nil {
		t.Fatal("short param must be rejected (长度 < 200 必得 3007)")
	}
	long := strings.Repeat("x", 250)
	if err := zcodeValidateCaptchaParam(long); err == nil {
		t.Fatal("non-base64 param must be rejected")
	}
	weakToken, _ := json.Marshal(map[string]any{"certifyId": "c", "securityToken": "short"})
	encoded := base64.StdEncoding.EncodeToString(append(weakToken, []byte(strings.Repeat(" ", 160))...))
	if err := zcodeValidateCaptchaParam(encoded); err == nil {
		t.Fatal("securityToken < 50 must be rejected")
	}
}

func TestZcodeCarrierRequestLifecycle(t *testing.T) {
	token, req := zcodeRegisterCaptchaRequest()
	if !ZcodeCarrierPending(token) {
		t.Fatal("a fresh request must be pending")
	}
	// 非法 param 不投递、会话保持 pending。
	if err := DeliverZcodeCaptchaParam(token, "too-short"); err == nil {
		t.Fatal("invalid param must be rejected")
	}
	if !ZcodeCarrierPending(token) {
		t.Fatal("a rejected param must not consume the session")
	}
	valid := zcodeValidParamForTest(t)
	if err := DeliverZcodeCaptchaParam(token, valid); err != nil {
		t.Fatalf("valid param must be delivered: %v", err)
	}
	select {
	case got := <-req.ch:
		if got != valid {
			t.Fatalf("delivered param mismatch")
		}
	case <-time.After(time.Second):
		t.Fatal("param never reached the waiting flow")
	}
	// 一次性：投递后会话消失。
	if ZcodeCarrierPending(token) {
		t.Fatal("delivered session must be consumed")
	}
	if err := DeliverZcodeCaptchaParam(token, valid); err == nil {
		t.Fatal("a consumed token must reject further deliveries")
	}
	if err := DeliverZcodeCaptchaParam("bogus-token", valid); err == nil {
		t.Fatal("unknown token must be rejected")
	}
}

func TestZcodeCarrierPageHasNoCredentials(t *testing.T) {
	config := zcodeCaptchaConfig{Region: "cn", Prefix: "no8xfe", SceneID: "11xygtvd"}
	page := zcodeCarrierPageHTML(config, "http://127.0.0.1:8080/api/jethub/zcode/carrier/contribute", "tok-1")
	for _, want := range []string{"11xygtvd", "no8xfe", "startTracelessVerification", "AliyunCaptcha.js", "tok-1"} {
		if !strings.Contains(page, want) {
			t.Fatalf("carrier page missing %q", want)
		}
	}
	// 页面会被写进浏览器文档 ⇒ 绝不允许出现凭据字段名。
	for _, forbidden := range []string{"zcode_jwt", "Authorization", "device_mid", "Bearer"} {
		if strings.Contains(page, forbidden) {
			t.Fatalf("carrier page must not contain credentials (%q)", forbidden)
		}
	}
}

func TestZcodeClaimCodeDescriptions(t *testing.T) {
	if got := zcodeDescribeClaimCode(1003); !strings.Contains(got, "已领取") {
		t.Fatalf("1003 = %q", got)
	}
	if got := zcodeDescribeClaimCode(3007); !strings.Contains(got, "captcha") {
		t.Fatalf("3007 = %q", got)
	}
	if got := zcodeDescribeClaimCode(4242); !strings.Contains(got, "4242") {
		t.Fatalf("unknown code must be echoed: %q", got)
	}
}

func TestZcodeNodePlatformMapping(t *testing.T) {
	platform := zcodeNodePlatform()
	if platform == "windows" {
		t.Fatal("must map to Node's spelling (win32), not Go's")
	}
	env := zcodeEnvironmentSection(t.TempDir(), "GLM-5.3")
	if platform == "win32" && !strings.Contains(env, "- Shell: powershell") {
		t.Fatalf("Windows shell must be powershell: %q", env)
	}
}
