package jethub

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestReorderAccountsIsTheRotationPriority: 池内顺序**就是**选号优先级。
//
// 三件事必须同时成立，否则「拖到第一位」只是视觉变化：
//  1. `Accounts()` 按池内顺序返回，并给出**生效的** rotationOrder；
//  2. 重新排序把顺序写进 accounts.json（重启后仍在）；
//  3. 桥接时按位置分配 key 的 Priority（fill-first 取 priority ASC 的第一个）。
//
// 反向验证：把 bridge.SyncKeys 里那句 `sort.Slice(keys, …ID < …ID)` 加回去，
// 第 ③ 条立刻变红 —— 那正是本次修掉的缺陷（拖拽排序对路由层完全无效）。
func TestReorderAccountsIsTheRotationPriority(t *testing.T) {
	b, m, firstID, _ := newTestBridge(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	b.RegisterProduct(Product{Provider: "codearts", DisplayName: "t", BaseURL: upstream.URL})

	// 再建两个账号（newTestBridge 已经建了第一个）。
	var rest []string
	for i := 0; i < 2; i++ {
		id, ref := NewAccountID("codearts")
		if err := m.AddAccount(Account{ID: id, Provider: "codearts", Nickname: id,
			Enabled: true, CredentialRef: ref, CreatedAt: 1}); err != nil {
			t.Fatal(err)
		}
		if err := m.SetCredential("codearts", ref, []byte(`{"access_token":"tok-`+id+`"}`), 0, false); err != nil {
			t.Fatal(err)
		}
		rest = append(rest, id)
	}
	ids := []string{firstID, rest[0], rest[1]}

	// ① 初始顺序 = 创建顺序，rotationOrder = 下标。
	got := m.Accounts("codearts")
	if len(got) != 3 {
		t.Fatalf("accounts = %d", len(got))
	}
	for i, a := range got {
		if a.ID != ids[i] || a.RotationOrder != i {
			t.Fatalf("account[%d] = %s / order %d, want %s / %d", i, a.ID, a.RotationOrder, ids[i], i)
		}
	}

	// ② 把最后一个挪到最前。
	reordered := []string{ids[2], ids[0], ids[1]}
	if err := m.ReorderAccounts("codearts", reordered); err != nil {
		t.Fatal(err)
	}
	got = m.Accounts("codearts")
	for i, a := range got {
		if a.ID != reordered[i] {
			t.Fatalf("after reorder account[%d] = %s, want %s", i, a.ID, reordered[i])
		}
	}
	// 落盘后重开一个 Manager 仍是新顺序（顺序是持久化事实，不是内存态）。
	m2, err := NewManager(m.dir, m.key, nil)
	if err != nil {
		t.Fatal(err)
	}
	after := m2.Accounts("codearts")
	for i, a := range after {
		if a.ID != reordered[i] {
			t.Fatalf("after restart account[%d] = %s, want %s", i, a.ID, reordered[i])
		}
	}

	// ③ 桥接的 key Priority 跟随池内位置。
	if err := b.SetPrefix("codearts", "ca"); err != nil {
		t.Fatal(err)
	}
	prov, ok := b.reg.GetProvider(ProviderID("codearts"))
	if !ok {
		t.Fatal("bridged provider missing")
	}
	prio := map[string]int{}
	for _, k := range prov.Keys {
		prio[k.ID] = k.Priority
	}
	for i, id := range reordered {
		if prio[id] != i {
			t.Fatalf("key %s priority = %d, want %d (order IS the selection priority) — the ID sort must not come back", id, prio[id], i)
		}
	}
}

// TestReorderAccountsRejectsPartialLists: 顺序表必须**不重不漏**。
//
// 宽松处理（只搬给定的那几个、其余追加在后）会让一次不完整的拖拽把用户排好的
// 顺序**部分**打乱，而且无法察觉 —— 宁可明确报错。
func TestReorderAccountsRejectsPartialLists(t *testing.T) {
	_, m, firstID, _ := newTestBridge(t)
	secondID, ref2 := NewAccountID("codearts")
	if err := m.AddAccount(Account{ID: secondID, Provider: "codearts", Enabled: true, CredentialRef: ref2}); err != nil {
		t.Fatal(err)
	}
	for name, ids := range map[string][]string{
		"少一个":  {firstID},
		"多一个":  {firstID, secondID, "ghost"},
		"重复":   {firstID, firstID},
		"含陌生人": {firstID, "ghost"},
	} {
		if err := m.ReorderAccounts("codearts", ids); err == nil {
			t.Fatalf("%s: 必须报错（否则会静默打乱顺序）: %v", name, ids)
		}
	}
	// 原顺序未被动过。
	got := m.Accounts("codearts")
	if got[0].ID != firstID || got[1].ID != secondID {
		t.Fatalf("a rejected reorder must not change anything: %v", got)
	}
	// 合法调用：交换。
	if err := m.ReorderAccounts("codearts", []string{secondID, firstID}); err != nil {
		t.Fatal(err)
	}
	got = m.Accounts("codearts")
	if got[0].ID != secondID {
		t.Fatalf("valid reorder rejected: %v", got)
	}
}

// TestAnonymousAccountSortsLast: 匿名通道恒殿后 —— 位置而非特权降级。
//
// 理由（ref opencode）：匿名槽只能服务免费模型，而 fill-first 按 priority ASC
// 取第一个可用 key ⇒ 排前面会让收费模型先撞一次必然 401 的匿名尝试。
// 同时它**仍可被拖动/停用/删除**（顺序表里照样有它）。
//
// 反向验证：去掉 withRotationOrder 里的 anonymous 分支，本用例第一条断言变红。
func TestAnonymousAccountSortsLast(t *testing.T) {
	m := newTestManager(t).m
	// 先加匿名通道（池内第一个），再加一个带 key 的账号 —— 顺序与优先级**不同**，
	// 这正是「面板序号必须用 rotationOrder 而不是下标」的原因。
	anonID, _, err := m.AddOpencodeAccount("", "", true)
	if err != nil {
		t.Fatal(err)
	}
	keyID, _, err := m.AddOpencodeAccount("sk-order-0001", "", false)
	if err != nil {
		t.Fatal(err)
	}
	got := m.Accounts("opencode")
	if len(got) != 2 {
		t.Fatalf("accounts = %d", len(got))
	}
	// 池内顺序保持用户所见（匿名在前）。
	if got[0].ID != anonID || got[1].ID != keyID {
		t.Fatalf("pool order must stay untouched: %v", got)
	}
	// 但生效的选号序号：带 key 的账号是 0，匿名是 100。
	if got[0].RotationOrder != anonymousKeyPriorityBase {
		t.Fatalf("anonymous must sort last: order = %d, want %d", got[0].RotationOrder, anonymousKeyPriorityBase)
	}
	if got[1].RotationOrder != 0 {
		t.Fatalf("keyed account must be first: order = %d", got[1].RotationOrder)
	}
	// 匿名账号照样在顺序表里（可以被拖动）。
	if err := m.ReorderAccounts("opencode", []string{keyID, anonID}); err != nil {
		t.Fatal(err)
	}
	got = m.Accounts("opencode")
	if got[0].ID != keyID {
		t.Fatalf("anonymous account must remain reorderable: %v", got)
	}
	if got[0].RotationOrder != 0 || got[1].RotationOrder != anonymousKeyPriorityBase {
		t.Fatalf("rotation orders after reorder: %d / %d", got[0].RotationOrder, got[1].RotationOrder)
	}
}
