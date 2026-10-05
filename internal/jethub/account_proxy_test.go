package jethub

import (
	"net/http/httptest"
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

// TestOpencodeAccountProxyIsPerKey: 账号自己的出口代理必须**落到桥接的 key 上**
// （代理主干按 `sel.Key.Proxy` 选 per-key transport，见 proxy.upstreamClientFor）。
//
// 为什么必须走 key 而不是只存面板状态：opencode 的匿名额度按**出口 IP** 计，
// 「给这个账号单独配一条出口」是唯一能拿到独立额度的办法；面板上设了而流量还走
// 旧出口，用户会以为额度分开了、实际仍在共用同一份（真正的问题在于**看起来生效**）。
//
// 反向验证：把 bridge.SyncKeys 里的 `Proxy: a.OpencodeProxy` 删掉，第一条断言变红。
func TestOpencodeAccountProxyIsPerKey(t *testing.T) {
	b, m, accID, _ := newTestBridge(t)
	// 换成一个 opencode 账号（newTestBridge 建的是 codearts）。
	if err := m.DeleteAccount(accID); err != nil {
		t.Fatal(err)
	}
	b.RegisterProduct(Product{Provider: "opencode", DisplayName: "t", BaseURL: "https://opencode.ai/zen"})
	id, _, err := m.AddOpencodeAccount("sk-proxy-0001", "", false)
	if err != nil {
		t.Fatal(err)
	}

	// ① 默认（未设置）⇒ key 上没有代理，且出站客户端与 provider 级完全一致。
	if err := b.SetPrefix("opencode", "oc"); err != nil {
		t.Fatal(err)
	}
	prov, ok := b.reg.GetProvider(ProviderID("opencode"))
	if !ok || len(prov.Keys) != 1 {
		t.Fatalf("bridged provider missing/keys wrong: %+v", prov)
	}
	if prov.Keys[0].Proxy != "" {
		t.Fatalf("an account without its own proxy must leave Key.Proxy empty, got %q", prov.Keys[0].Proxy)
	}
	if a, c := m.httpClientForAccount(id, id), m.httpClient("opencode"); a != c {
		t.Fatal("未设置 per-account 代理解必须复用同一个 client 实例（默认路径逐字节不变）")
	}

	// ② 设置代理 ⇒ 落盘 + 落到 key 上 + 出站换成独立 client。
	const raw = "http://127.0.0.1:2080"
	if err := m.SetAccountProxy(id, raw); err != nil {
		t.Fatal(err)
	}
	acc, _ := m.FindAccount(id)
	if acc.OpencodeProxy != raw {
		t.Fatalf("proxy must persist on the account, got %q", acc.OpencodeProxy)
	}
	// 重启后仍在（顺序/代理都是持久化事实）。
	m2, err := NewManager(m.dir, m.key, nil)
	if err != nil {
		t.Fatal(err)
	}
	if a, _ := m2.FindAccount(id); a.OpencodeProxy != raw {
		t.Fatalf("proxy must survive a restart, got %q", a.OpencodeProxy)
	}
	if err := b.SyncKeys("opencode"); err != nil {
		t.Fatal(err)
	}
	prov, _ = b.reg.GetProvider(ProviderID("opencode"))
	if prov.Keys[0].Proxy != raw {
		t.Fatalf("Key.Proxy must carry the account proxy, got %q", prov.Keys[0].Proxy)
	}
	if a, c := m.httpClientForAccount(id, id), m.httpClient("opencode"); a == c {
		t.Fatal("设置代理后出站必须换成独立 client")
	}

	// ③ 清除（空串）：是**合法操作**，回到共享本机出口。
	if err := m.SetAccountProxy(id, ""); err != nil {
		t.Fatalf("clearing must be legal: %v", err)
	}
	if acc, _ := m.FindAccount(id); acc.OpencodeProxy != "" {
		t.Fatalf("clearing must empty the field, got %q", acc.OpencodeProxy)
	}
	if a, c := m.httpClientForAccount(id, id), m.httpClient("opencode"); a != c {
		t.Fatal("清除后必须回到 provider 级 client")
	}

	// ④ 非法值拒绝且不改动现状（用户手输的值要当场报错，而不是静默不生效）。
	for _, bad := range []string{"127.0.0.1:2080", "socks5://127.0.0.1:2080", "not a url"} {
		if err := m.SetAccountProxy(id, bad); err == nil {
			t.Fatalf("%q must be rejected (面板会静默不生效，比报错更糟)", bad)
		}
	}
	if acc, _ := m.FindAccount(id); acc.OpencodeProxy != "" {
		t.Fatalf("a rejected value must not change anything: %q", acc.OpencodeProxy)
	}
	// 未知账号 ⇒ 报错。
	if err := m.SetAccountProxy("nope", raw); err == nil {
		t.Fatal("unknown account must error")
	}
	_ = httptest.NewRequest
	_ = config.Key{}
}
