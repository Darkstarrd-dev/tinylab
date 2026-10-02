package webhub

import (
	"strings"
	"testing"
)

// 域名匹配：站点 tab 的 URL 必须按主机名判定，绝不按子串。
func TestDomainMatches(t *testing.T) {
	cases := []struct {
		site, url string
		want      bool
	}{
		{"chat.deepseek.com", "https://chat.deepseek.com/", true},
		{"chat.deepseek.com", "https://chat.deepseek.com/a/b?x=1", true},
		{"chat.deepseek.com", "http://127.0.0.1:20199/", false},            // P0 事故形状
		{"chat.deepseek.com", "https://chat.deepseek.com.evil.io/", false}, // 后缀陷阱
		{"chat.deepseek.com", "https://chatgpt.com/", false},
		{"www.kimi.com", "https://www.kimi.com/", true},
		{"www.kimi.com", "https://kimi.com/", true}, // www 别名
		{"kimi.com", "https://www.kimi.com/", true}, // 反向别名
		{"chat.deepseek.com", "not a url", false},   // 无法解析 ≠ 匹配
		{"chat.deepseek.com", "", false},            // 空 tab URL 绝不复用
		{"gemini.google.com", "https://gemini.google.com/app", true},
	}
	for _, c := range cases {
		if got := domainMatches(c.site, c.url); got != c.want {
			t.Errorf("domainMatches(%q, %q) = %v, want %v", c.site, c.url, got, c.want)
		}
	}
}

// route alias（上游 site_rules.json 的 route_aliases）必须生效。
func TestRouteAliases(t *testing.T) {
	// gemini.google.com ↔ gemini.com 是上游声明的别名组。
	if !domainMatches("gemini.google.com", "https://gemini.com/") {
		t.Fatal("gemini.com must route to gemini.google.com")
	}
	if got := preferredRouteDomain("gemini.com"); got != "gemini.google.com" {
		t.Fatalf("preferred = %q", got)
	}
	if got := preferredRouteDomain("www.doubao.com"); got != "doubao.com" {
		t.Fatalf("preferred = %q", got)
	}
}

// 归一化：端口、尾点、大小写、裸域名都要处理。
func TestNormalizeDomain(t *testing.T) {
	cases := map[string]string{
		"https://Chat.DeepSeek.com:443/": "chat.deepseek.com",
		"chat.deepseek.com":              "chat.deepseek.com",
		"chat.deepseek.com.":             "chat.deepseek.com",
		"http://127.0.0.1:20199":         "127.0.0.1",
		"":                               "",
		"   ":                            "",
	}
	for in, want := range cases {
		if got := normalizeDomain(in); got != want {
			t.Errorf("normalizeDomain(%q) = %q, want %q", in, got, want)
		}
	}
}

// 模型 ID 派生（UWA _build_model_id_candidates 同款）。
//
// 注意：派生结果还包含 www. 变体 —— 上游 build_route_domain_aliases 把
// www./非 www. 视作同一站点的别名，所以 www.chat.deepseek.com 也是合法路由
// id。这不是噪声，是与上游对齐的语义。
func TestModelIDCandidates(t *testing.T) {
	got := ModelIDCandidates("chat.deepseek.com")
	for _, w := range []string{"chat.deepseek.com", "deepseek"} {
		found := false
		for _, g := range got {
			if g == w {
				found = true
			}
		}
		if !found {
			t.Fatalf("deepseek ids %v missing %q", got, w)
		}
	}

	// gemini: 域名全名 + 别名 + 短 id
	got = ModelIDCandidates("gemini.google.com")
	for _, w := range []string{"gemini.google.com", "gemini.com", "gemini"} {
		found := false
		for _, g := range got {
			if g == w {
				found = true
			}
		}
		if !found {
			t.Fatalf("gemini ids %v missing %q", got, w)
		}
	}

	// 无重复
	seen := map[string]bool{}
	for _, g := range got {
		if seen[g] {
			t.Fatalf("duplicate id %q in %v", g, got)
		}
		seen[g] = true
	}
}

// 短 id 派生规则（忽略 www/chat/app 等通用标签）。
func TestSiteCardID(t *testing.T) {
	cases := map[string]string{
		"chat.deepseek.com": "deepseek",
		"gemini.google.com": "gemini",
		"www.doubao.com":    "doubao",
		"chat.qwen.ai":      "qwen",
		"arena.ai":          "arena",
		"":                  "",
	}
	for in, want := range cases {
		if got := SiteCardID(in); got != want {
			t.Errorf("SiteCardID(%q) = %q, want %q", in, got, want)
		}
	}
}

// 多预设站点必须展开为 <domain>/<preset>。
func TestModelIDsForSiteExpandsPresets(t *testing.T) {
	ids := ModelIDsForSite("gemini.google.com", []string{"3.7flash", "3.1 pro"})
	var presetForms []string
	for _, id := range ids {
		if strings.Contains(id, "/") {
			presetForms = append(presetForms, id)
		}
	}
	if len(presetForms) != 2 {
		t.Fatalf("preset ids = %v, want 2", presetForms)
	}
	if presetForms[0] != "gemini.google.com/3.7flash" {
		t.Fatalf("preset id = %q", presetForms[0])
	}
	// 预设名含空格也必须原样保留（可调用串由 UI 直接复制）。
	if presetForms[1] != "gemini.google.com/3.1 pro" {
		t.Fatalf("preset id = %q", presetForms[1])
	}
}

// 模型 ID 路由：全名 / 短别名 / 带分隔符前缀 / <domain>/<preset>。
func TestResolveModelID(t *testing.T) {
	presets := []string{"3.7flash", "3.1 pro"}
	cases := []struct {
		modelID, domain string
		wantPreset      string
		wantOK          bool
	}{
		{"", "gemini.google.com", "3.7flash", true},                         // 缺省预设
		{"gemini.google.com", "gemini.google.com", "3.7flash", true},        // 全名
		{"gemini", "gemini.google.com", "3.7flash", true},                   // 短别名
		{"gemini-chat", "gemini.google.com", "3.7flash", true},              // 别名+分隔符
		{"gemini.google.com/3.1 pro", "gemini.google.com", "3.1 pro", true}, // 指定预设
		{"gemini.google.com/nope", "gemini.google.com", "", false},          // 未知预设
		{"claude.ai", "gemini.google.com", "", false},                       // 别的站点
		{"nonsense", "gemini.google.com", "", false},                        // 无法路由
	}
	for _, c := range cases {
		got, ok := ResolveModelID(c.modelID, c.domain, presets)
		if ok != c.wantOK || got != c.wantPreset {
			t.Errorf("ResolveModelID(%q) = (%q,%v), want (%q,%v)", c.modelID, got, ok, c.wantPreset, c.wantOK)
		}
	}
}

// 无预设站点（规则表里没有预设名）仍可路由到空预设。
func TestResolveModelIDNoPresets(t *testing.T) {
	got, ok := ResolveModelID("deepseek", "chat.deepseek.com", nil)
	if !ok {
		t.Fatal("must resolve")
	}
	if got != "" {
		t.Fatalf("preset = %q, want empty (site declares none)", got)
	}
}

// 别名分隔符判定（UWA: - _ / : .）。
func TestMatchesModelAlias(t *testing.T) {
	if !matchesModelAlias("deepseek-chat", "deepseek") {
		t.Fatal("hyphen delimiter must match")
	}
	if !matchesModelAlias("deepseek.chatgpt", "deepseek") {
		t.Fatal("dot delimiter must match")
	}
	if matchesModelAlias("deepseekchat", "deepseek") {
		t.Fatal("no delimiter must not match")
	}
	if matchesModelAlias("dee", "deepseek") {
		t.Fatal("shorter id must not match")
	}
	if !matchesModelAlias("deepseek", "deepseek") {
		t.Fatal("identity must match")
	}
}
