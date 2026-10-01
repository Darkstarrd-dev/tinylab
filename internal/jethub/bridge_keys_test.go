package jethub

import (
	"encoding/json"
	"testing"
)

// 桥接可用性契约：**每个 provider 的真实凭据形状都必须能取出一个非空 Key**。
//
// ⚠️ 这个守卫来自一个真实缺陷（用户实测「codearts agent 可添加，但按 prefix 取不到
// 模型、无法调用」）：`Bridge.SyncKeys` 对每个启用账号调 `accessTokenOf`，取不到
// 令牌就跳过；可用 Key 为 0 时**桥接 provider 被整个移除** —— 前缀还在，但 registry
// 里没有 provider，于是模型列表看不到、`{prefix}/{model}` 也无从路由。codearts 的
// 凭据是 SDK-HMAC（ak/sk/security_token），**没有 access_token**，通用提取器返回空
// ⇒ 症状完全吻合。其它 provider 都自带 access_token 或已注册专属提取器。
//
// 注意：这里刻意用**真实凭据结构体**（而非 `{"access_token":"x"}` 这种通用假体），
// 因为假体恰好能通过通用提取器 —— 那正是本缺陷逃过既有测试的原因。
func TestEveryProviderYieldsNonEmptyKey(t *testing.T) {
	cases := []struct {
		provider string
		cred     any
	}{
		{"codearts", CodeArtsCredential{AccessKeyID: "ak", SecretAccessKey: "sk", SecurityToken: "st", RefreshToken: "rt"}},
		{"buddy", BuddyCredential{AccessToken: "at"}},
		{"workbuddy", BuddyCredential{AccessToken: "at"}},
		{"lobsterai", LobsteraiCredential{AccessToken: "at"}},
		{"trae", TraeCredential{AccessToken: "at"}},
		{"cline", ClineCredential{AccessToken: "workos:jwt"}},
		{"raccoon", RaccoonCredential{AccessToken: "at"}},
		{"loomy", LoomyCredential{AccessToken: "at"}},
		{"minimax", MinimaxCredential{AccessToken: "mmoat_x"}},
		{"qoder", QoderCredential{AccessToken: "at"}},
		{"qodercn", QoderCredential{AccessToken: "at"}},
	}
	for _, tc := range cases {
		raw, err := json.Marshal(tc.cred)
		if err != nil {
			t.Fatalf("%s: marshal credential: %v", tc.provider, err)
		}
		token, err := accessTokenOf(tc.provider, raw)
		if err != nil {
			t.Errorf("%s: accessTokenOf error: %v", tc.provider, err)
			continue
		}
		if token == "" {
			t.Errorf("%s: real credential shape yields an EMPTY key — SyncKeys would drop the account and remove the bridged provider (models invisible, {prefix}/{model} unroutable)", tc.provider)
		}
	}
}

// TestCodeartsKeyComesFromSecurityToken: codearts 没有 access_token，Key 必须来自
// 签名凭据本身（security_token 优先，退一步 access_key_id）。
func TestCodeartsKeyComesFromSecurityToken(t *testing.T) {
	raw, _ := json.Marshal(CodeArtsCredential{AccessKeyID: "ak", SecretAccessKey: "sk", SecurityToken: "st"})
	if got, _ := accessTokenOf("codearts", raw); got != "st" {
		t.Fatalf("codearts key = %q, want the security_token", got)
	}
	raw2, _ := json.Marshal(CodeArtsCredential{AccessKeyID: "ak", SecretAccessKey: "sk"})
	if got, _ := accessTokenOf("codearts", raw2); got != "ak" {
		t.Fatalf("codearts key fallback = %q, want the access_key_id", got)
	}
}

// TestUnknownProviderFallsBackToGenericToken: 未注册提取器的 provider 仍走通用
// `access_token` 字段（trae 等依赖这条）。
func TestUnknownProviderFallsBackToGenericToken(t *testing.T) {
	if got, err := accessTokenOf("trae", jsonRaw(`{"access_token":"tok"}`)); err != nil || got != "tok" {
		t.Fatalf("generic fallback broken: %q %v", got, err)
	}
}
