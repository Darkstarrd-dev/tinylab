package jethub

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// TestBuddyStripReasoningEffortWorkbuddyOnly: R6 通用事实 —— workbuddy 的
// `reasoning_effort` 会吞掉工具调用前的正文前言，buddy 无此缺陷 ⇒ 只对
// workbuddy 剥离；无该键时字节级透传。
func TestBuddyStripReasoningEffortWorkbuddyOnly(t *testing.T) {
	workbuddy := []byte(`{"model":"deepseek-v4.1-flash","reasoning_effort":"high","tools":[]}`)
	out, err := buddyStripReasoningEffort("workbuddy", workbuddy)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatal(err)
	}
	if _, ok := parsed["reasoning_effort"]; ok {
		t.Fatalf("workbuddy reasoning_effort must be stripped: %s", out)
	}

	buddy := []byte(`{"model":"glm-5.2","reasoning_effort":"high"}`)
	out, err = buddyStripReasoningEffort("buddy", buddy)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(buddy) {
		t.Fatalf("buddy reasoning_effort must pass through: %s", out)
	}

	// 无键：不得改写 body（避免无谓重排 JSON、破坏签名类 provider 的字节一致性）。
	plain := []byte(`{"model":"glm-5.2"}`)
	out, err = buddyStripReasoningEffort("workbuddy", plain)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(plain) {
		t.Fatalf("body without reasoning_effort must stay byte-identical: %s", out)
	}
}

// TestWorkbuddyAugmentPreservesReasoningEffort: R7（ref e261cd6 / 1361706）
// workbuddy 出站必须保留 reasoning_effort，以保证思考输出（thinking）正常工作。
func TestWorkbuddyAugmentPreservesReasoningEffort(t *testing.T) {
	m := newTestManager(t).m
	id, ref := NewAccountID("workbuddy")
	_ = m.AddAccount(Account{ID: id, Provider: "workbuddy", Enabled: true, CredentialRef: ref})
	data, _ := json.Marshal(&BuddyCredential{AccessToken: "wb-tok", Domain: "copilot.tencent.com"})
	_ = m.SetCredential("workbuddy", ref, data, 1, true)

	p := BuddyProducts()["workbuddy"]
	req, _ := http.NewRequest(http.MethodPost, p.Endpoint+buddyChatPath, nil)
	body := []byte(`{"model":"deepseek-v4.1-flash","reasoning_effort":"high","tools":[{"name":"read"}]}`)
	out, err := m.buddyAugment(p)(req, body, "jethub-workbuddy", id, "deepseek-v4.1-flash")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "reasoning_effort") {
		t.Fatalf("workbuddy augment must PRESERVE reasoning_effort: %s", out)
	}
	if req.Header.Get("Authorization") != "Bearer wb-tok" {
		t.Fatalf("buddy headers lost after augment: %v", req.Header)
	}
}
