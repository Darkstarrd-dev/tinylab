package webhub

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

// fakeRegistry is an in-memory BridgeDeps for the end-to-end bridge tests.
type fakeRegistry struct {
	providers map[string]config.Provider
}

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{providers: map[string]config.Provider{}}
}

func (f *fakeRegistry) GetProviderByPrefix(prefix string) (*config.Provider, bool) {
	for _, p := range f.providers {
		if p.Prefix == prefix {
			return &p, true
		}
	}
	return nil, false
}

func (f *fakeRegistry) GetProvider(id string) (*config.Provider, bool) {
	p, ok := f.providers[id]
	return &p, ok
}
func (f *fakeRegistry) AddProvider(p config.Provider) { f.providers[p.ID] = p }
func (f *fakeRegistry) HasProvider(id string) bool    { _, ok := f.providers[id]; return ok }
func (f *fakeRegistry) DeleteProvider(id string) bool {
	_, ok := f.providers[id]
	delete(f.providers, id)
	return ok
}
func (f *fakeRegistry) UpdateProvider(id string, u config.Provider) bool {
	if _, ok := f.providers[id]; !ok {
		return false
	}
	f.providers[id] = u
	return true
}
func (f *fakeRegistry) ListProviders() []config.Provider {
	out := make([]config.Provider, 0, len(f.providers))
	for _, p := range f.providers {
		out = append(out, p)
	}
	return out
}

func newTestManager(t *testing.T) *Manager {
	t.Helper()
	m, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	return m
}

// 端到端：设置前缀 → 注册 provider → {prefix}/{modelID} 可被解析回站点+预设。
func TestSetPrefixBridgesAndRoutesModelID(t *testing.T) {
	m := newTestManager(t)
	reg := newFakeRegistry()
	b := NewBridge(m, reg)

	if err := b.SetPrefix("chat.deepseek.com", "ds"); err != nil {
		t.Fatalf("SetPrefix: %v", err)
	}
	p, ok := reg.GetProvider(ProviderID("chat.deepseek.com"))
	if !ok {
		t.Fatal("provider not registered")
	}
	if p.APIType != APIType {
		t.Fatalf("APIType = %q", p.APIType)
	}
	if p.Prefix != "ds" {
		t.Fatalf("prefix = %q", p.Prefix)
	}
	// ⚠️ BaseURL 必须为空：webhub 没有端点，出站由 Customize 拦截。
	if strings.TrimSpace(p.BaseURL) != "" {
		t.Fatalf("BaseURL = %q, must be empty", p.BaseURL)
	}
	// 单条合成 Key（无凭据语义）。
	if len(p.Keys) != 1 || p.Keys[0].ID != SyntheticKeyID {
		t.Fatalf("keys = %+v, want one synthetic key", p.Keys)
	}
	if !p.IsActive {
		t.Fatal("bridged provider must be active")
	}
	// 模型 ID 空间必须含域名与短别名。
	var hasFull, hasShort bool
	for _, md := range p.Models {
		if md.ID == "chat.deepseek.com" {
			hasFull = true
		}
		if md.ID == "deepseek" {
			hasShort = true
		}
	}
	if !hasFull || !hasShort {
		t.Fatalf("models = %+v, want full + short ids", p.Models)
	}
	if !b.Bridged("chat.deepseek.com") {
		t.Fatal("Bridged must report true")
	}
}

// 前缀冲突 → *ConflictError（API 层映射为 409）。
func TestSetPrefixConflict(t *testing.T) {
	m := newTestManager(t)
	reg := newFakeRegistry()
	reg.AddProvider(config.Provider{ID: "other", Prefix: "taken"})
	b := NewBridge(m, reg)

	if err := b.SetPrefix("chat.deepseek.com", "taken"); err == nil {
		t.Fatal("expected a conflict")
	} else if _, ok := err.(*ConflictError); !ok {
		t.Fatalf("err = %T, want *ConflictError", err)
	}

	// 两个 webhub 站点之间也冲突
	if err := b.SetPrefix("chat.deepseek.com", "ds"); err != nil {
		t.Fatal(err)
	}
	if err := b.SetPrefix("chatgpt.com", "ds"); err == nil {
		t.Fatal("expected a cross-site conflict")
	}
}

// 前缀合法性（与 jethub 同一命名空间、同一规则）。
func TestValidPrefix(t *testing.T) {
	ok := map[string]bool{
		"ds": true, "a": true, "my-site1": true, "123": true,
		"": false, "UPPER": false, "has space": false, "under_score": false,
		strings.Repeat("x", 33): false,
	}
	for in, want := range ok {
		if got := ValidPrefix(in); got != want {
			t.Errorf("ValidPrefix(%q) = %v, want %v", in, got, want)
		}
	}
}

// 清除前缀必须同时注销 provider。
func TestClearPrefixUnbridges(t *testing.T) {
	m := newTestManager(t)
	reg := newFakeRegistry()
	b := NewBridge(m, reg)
	if err := b.SetPrefix("chat.deepseek.com", "ds"); err != nil {
		t.Fatal(err)
	}
	if err := b.ClearPrefix("chat.deepseek.com"); err != nil {
		t.Fatal(err)
	}
	if reg.HasProvider(ProviderID("chat.deepseek.com")) {
		t.Fatal("provider must be removed")
	}
	if m.Prefix("chat.deepseek.com") != "" {
		t.Fatal("prefix must be cleared")
	}
}

// 未知站点 / 空站点必须被拒。
func TestSetPrefixRejectsUnknownSite(t *testing.T) {
	m := newTestManager(t)
	b := NewBridge(m, newFakeRegistry())
	if err := b.SetPrefix("nope.example", "x"); err == nil {
		t.Fatal("expected an error for an unknown site")
	}
	if err := b.SetPrefix("", "x"); err == nil {
		t.Fatal("expected an error for an empty site")
	}
}

// 重启恢复：已存前缀的站点在启动后自动重新注册。
func TestRestoreBridges(t *testing.T) {
	dir := t.TempDir()
	m, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	reg := newFakeRegistry()
	b := NewBridge(m, reg)
	if err := b.SetPrefix("chat.deepseek.com", "ds"); err != nil {
		t.Fatal(err)
	}
	// 模拟重启：新的 Manager 读同一目录，新的 registry 是空的。
	m2, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	reg2 := newFakeRegistry()
	b2 := NewBridge(m2, reg2)
	b2.RestoreBridges()
	if !reg2.HasProvider(ProviderID("chat.deepseek.com")) {
		t.Fatal("restore must re-register the site")
	}
	if m2.Prefix("chat.deepseek.com") != "ds" {
		t.Fatalf("prefix = %q after restart", m2.Prefix("chat.deepseek.com"))
	}
}

// 状态文件必须原子落盘且可重读（登录态不落盘，但前缀与上次探测要持久化）。
func TestStatePersistence(t *testing.T) {
	dir := t.TempDir()
	m, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.SetPrefix("chat.deepseek.com", "ds"); err != nil {
		t.Fatal(err)
	}
	m.MarkOK("chat.deepseek.com")
	m2, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m2.Prefix("chat.deepseek.com") != "ds" {
		t.Fatalf("prefix not persisted: %q", m2.Prefix("chat.deepseek.com"))
	}
	if m2.LastOK("chat.deepseek.com") <= 0 {
		t.Fatal("lastOk not persisted")
	}
	// 明文状态文件里不得出现任何凭据类字段（webhub 零凭据落盘）。
	raw, _ := os.ReadFile(m.path)
	for _, bad := range []string{"cookie", "token", "password", "access_token"} {
		if strings.Contains(strings.ToLower(string(raw)), bad) {
			t.Fatalf("state file must not carry credentials (found %q)", bad)
		}
	}
}

// 站点列表要带上前缀化的模型 ID，供 UI 直接展示/复制。
func TestSitesCarryPrefixedModelIDs(t *testing.T) {
	m := newTestManager(t)
	reg := newFakeRegistry()
	b := NewBridge(m, reg)
	if err := b.SetPrefix("chat.deepseek.com", "ds"); err != nil {
		t.Fatal(err)
	}
	sites := m.Sites(b.Bridged)
	var found *SiteInfo
	for i := range sites {
		if sites[i].Domain == "chat.deepseek.com" {
			found = &sites[i]
		}
	}
	if found == nil {
		t.Fatal("site missing")
	}
	if !found.Bridged {
		t.Fatal("bridged flag must be set")
	}
	if len(found.ModelIDs) == 0 || !strings.HasPrefix(found.ModelIDs[0], "ds/") {
		t.Fatalf("modelIds = %v, want ds/ prefixed", found.ModelIDs)
	}
	if found.DisplayName == "" || found.DisplayName == "chat.deepseek.com" {
		t.Fatalf("displayName = %q, want a short label", found.DisplayName)
	}
}

// 响应包装必须是合法 OpenAI 形状（客户端按此解析）。
func TestResponseShape(t *testing.T) {
	raw, err := BuildChatCompletion("ds/deepseek", "hello", 10)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if parsed["object"] != "chat.completion" {
		t.Fatalf("object = %v", parsed["object"])
	}
	choices, ok := parsed["choices"].([]any)
	if !ok || len(choices) != 1 {
		t.Fatalf("choices = %v", parsed["choices"])
	}
	c0 := choices[0].(map[string]any)
	msg := c0["message"].(map[string]any)
	if msg["role"] != "assistant" || msg["content"] != "hello" {
		t.Fatalf("message = %v", msg)
	}
	if c0["finish_reason"] != "stop" {
		t.Fatalf("finish_reason = %v", c0["finish_reason"])
	}
}

// 流式 chunk：首个带 role，末个带 finish_reason，中间是纯 delta。
func TestChunkShape(t *testing.T) {
	first, err := BuildChunk("id1", "m", "", true, false)
	if err != nil {
		t.Fatal(err)
	}
	var f map[string]any
	_ = json.Unmarshal(first, &f)
	if f["object"] != "chat.completion.chunk" {
		t.Fatalf("object = %v", f["object"])
	}
	fc := f["choices"].([]any)[0].(map[string]any)
	if fc["delta"].(map[string]any)["role"] != "assistant" {
		t.Fatal("first chunk must carry the assistant role")
	}

	mid, _ := BuildChunk("id1", "m", "hi", false, false)
	var m2 map[string]any
	_ = json.Unmarshal(mid, &m2)
	mc := m2["choices"].([]any)[0].(map[string]any)
	if mc["delta"].(map[string]any)["content"] != "hi" {
		t.Fatal("mid chunk must carry the content delta")
	}
	if _, has := mc["finish_reason"]; has && mc["finish_reason"] != nil {
		t.Fatal("mid chunk must not carry a finish_reason")
	}

	last, _ := BuildChunk("id1", "m", "", false, true)
	var l map[string]any
	_ = json.Unmarshal(last, &l)
	lc := l["choices"].([]any)[0].(map[string]any)
	if lc["finish_reason"] != "stop" {
		t.Fatalf("finish_reason = %v", lc["finish_reason"])
	}
}
