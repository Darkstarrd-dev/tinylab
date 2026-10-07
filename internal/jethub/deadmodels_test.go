package jethub

// 已失效模型的运行时实证剔除（R5，ref f8748fa）回归。
//
// ⚠️ 误判代价**不对称**：把可用模型记成失效会把它从列表里藏起来，且用户
// **无法自行恢复**（选不到 ⇒ 不可能再成功 ⇒ 记录不会自清）。故本文件的
// 反例组必须多于正例组，且每条正例都要求「model」与「不存在」语义同现。

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestIsModelGoneErrorPositiveEvidence 锁**正例**：只有明确的「模型不存在」才算。
func TestIsModelGoneErrorPositiveEvidence(t *testing.T) {
	positives := []string{
		`{"error":{"message":"model not found"}}`,
		`cline: model not found HTTP_404`,
		`{"error":"Model not found: cline-free/deepseek-v4.1-flash"}`,
		`unknown model: foo/bar`,
		`no such model`,
		`nonexistent model`,
		`model does not exist`,
		`model doesn't exist`,
		`模型 deepseek-v4.1-flash-x 不存在`,
		`模型 foo 未找到`,
		`该模型已下线`,
		`model 已下架`,
	}
	for _, msg := range positives {
		if !isModelGoneError(msg) {
			t.Errorf("must be positive evidence: %q", msg)
		}
	}
}

// TestIsModelGoneErrorRejectsNonModelFailures 锁**反例**（组数多于正例组）：
// 账号/额度/认证/网络类一律不记 —— 记错会把可用模型藏起来。
func TestIsModelGoneErrorRejectsNonModelFailures(t *testing.T) {
	negatives := []string{
		"",
		"   ",
		// 额度 / 限流：都带 model 字样但说的是账号状态。
		`该模型额度已用尽`,
		`{"error":"rate limit reached for model gpt-4o-mini"}`,
		`too many requests for model foo`,
		`quota exceeded for model foo`,
		`insufficient balance for model foo`,
		`模型繁忙，请换模型或稍后重试`,
		`所有账号均不可用`, // ⚠️ 刻意收窄：不收「不可用」
		// 认证类。
		`unauthorized: model foo`,
		`forbidden for model foo`,
		`invalid api key`,
		`expired token`,
		`凭据失效`,
		`未登录`,
		`鉴权失败`,
		// 排队 / 积分 / 余额 / 限速 / 认证（中文）。
		`排队中`,
		`积分不足`,
		`余额不足`,
		`限速中`,
		// 泛词：`unsupported` / `invalid` 单独出现不算（可能是参数错）。
		`unsupported parameter`,
		`invalid request body`,
		// 参数 / 服务端错误。
		`500 internal server error`,
		`context deadline exceeded`,
	}
	for _, msg := range negatives {
		if isModelGoneError(msg) {
			t.Errorf("must NOT be treated as model-gone: %q", msg)
		}
	}
}

// TestDeadModelStoreMarkAndFilter 锁记录 → 模型列表剔除 → 过期回收的完整链路。
func TestDeadModelStoreMarkAndFilter(t *testing.T) {
	env := newTestManager(t)
	dir := env.m.dir
	if dir == "" {
		t.Fatal("test manager must have a dir")
	}
	// 每个用例独立存储：重置进程级单例。
	deadModels = &deadModelStore{}
	t.Cleanup(func() { deadModels = &deadModelStore{} })

	// ① 非阳性证据 ⇒ 不记。
	env.m.ReportModelGone("jethub-cline", "cline-free/mimo-v2.6-flash", `该模型额度已用尽`)
	if got := env.m.DeadModels("cline"); len(got) != 0 {
		t.Fatalf("a quota failure must not mark the model gone, got %v", got)
	}

	// ② 阳性证据 ⇒ 记录 + 落盘。
	env.m.ReportModelGone("jethub-cline", "cline-free/deepseek-v4.1-flash", `cline: model not found HTTP_404`)
	got := env.m.DeadModels("cline")
	if !got["cline-free/deepseek-v4.1-flash"] {
		t.Fatalf("model-not-found must be recorded, got %v", got)
	}
	path := filepath.Join(dir, deadModelFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("record must be persisted to %s: %v", path, err)
	}
	if len(raw) == 0 {
		t.Fatal("persisted record must not be empty")
	}

	// ③ 其它 provider 不受影响（按 provider 隔离）。
	if got := env.m.DeadModels("zcode"); len(got) != 0 {
		t.Fatalf("records must be per-provider, zcode got %v", got)
	}

	// ④ 未知 provider 拒收（防止拼错的 id 写进表）。
	env.m.ReportModelGone("jethub-nope", "x", `model not found`)
	if got := env.m.DeadModels("nope"); len(got) != 0 {
		t.Fatalf("unknown provider must be rejected, got %v", got)
	}

	// ⑤ 成功即忘（模型回来了就不该继续藏）。
	env.m.ForgetModelGone("cline", "cline-free/deepseek-v4.1-flash")
	if got := env.m.DeadModels("cline"); len(got) != 0 {
		t.Fatalf("forget must clear the record, got %v", got)
	}
}

// TestDeadModelTTLExpiry 锁 TTL 回收：⚠️ **必须有 TTL** —— 被剔除的模型用户
// 选不到，无法靠「再成功一次」自愈，只能靠过期放回来。
func TestDeadModelTTLExpiry(t *testing.T) {
	env := newTestManager(t)
	deadModels = &deadModelStore{}
	t.Cleanup(func() { deadModels = &deadModelStore{} })

	// 写入一条**已过期**的记录（TTL=1 天，时间戳 10 天前）。
	t.Setenv(deadModelTTLEnv, "1")
	stale := `{"schema":"tinylab/jethub/dead-models/v1","providers":{"cline":{"old/model":{"at":"` +
		time.Now().UTC().Add(-10*24*time.Hour).Format(time.RFC3339) + `"}}}}`
	if err := os.WriteFile(filepath.Join(env.m.dir, deadModelFile), []byte(stale), 0600); err != nil {
		t.Fatal(err)
	}
	deadModels.loaded = false // force a fresh read
	if got := env.m.DeadModels("cline"); len(got) != 0 {
		t.Fatalf("an expired record must be recycled (else a relisted model stays hidden forever), got %v", got)
	}

	// TTL=0 ⇒ 永不过期（显式选择）。
	t.Setenv(deadModelTTLEnv, "0")
	deadModels = &deadModelStore{}
	if err := os.WriteFile(filepath.Join(env.m.dir, deadModelFile), []byte(stale), 0600); err != nil {
		t.Fatal(err)
	}
	if got := env.m.DeadModels("cline"); !got["old/model"] {
		t.Fatalf("TTL=0 must keep the record forever, got %v", got)
	}
}

// TestDeadModelCorruptFileIsEmpty 锁「损坏 ⇒ 空表」：解析失败时宁可多显示一个
// 失效模型，也**不能**把整张表当成「全部失效」而藏掉可用模型。
func TestDeadModelCorruptFileIsEmpty(t *testing.T) {
	env := newTestManager(t)
	deadModels = &deadModelStore{}
	t.Cleanup(func() { deadModels = &deadModelStore{} })

	if err := os.WriteFile(filepath.Join(env.m.dir, deadModelFile), []byte(`{not json`), 0600); err != nil {
		t.Fatal(err)
	}
	if got := env.m.DeadModels("cline"); len(got) != 0 {
		t.Fatalf("a corrupt file must degrade to an EMPTY table, got %v", got)
	}
}

// TestSyncKeysFiltersDeadModels 锁模型列表出口：记录过的模型不再进入桥接
// provider 的 Models（否则面板照旧显示、照旧 404）。
func TestSyncKeysFiltersDeadModels(t *testing.T) {
	env := newTestManager(t)
	deadModels = &deadModelStore{}
	t.Cleanup(func() { deadModels = &deadModelStore{} })

	reg := newFakeRegistry()
	b := NewBridge(env.m, reg)
	RegisterDefaultProducts(b)
	id, ref := NewAccountID("cline")
	if err := env.m.AddAccount(Account{ID: id, Provider: "cline", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	if err := env.m.SetCredential("cline", ref, []byte(`{"access_token":"workos:tok"}`), 0, false); err != nil {
		t.Fatal(err)
	}
	if err := b.SetPrefix("cline", "cline"); err != nil {
		t.Fatal(err)
	}

	before := modelIDs(t, reg, "jethub-cline")
	if !hasModel(before, "cline-free/mimo-v2.6-flash") {
		t.Fatalf("precondition: the model must be listed first, got %v", before)
	}

	env.m.ReportModelGone("jethub-cline", "cline-free/mimo-v2.6-flash", `cline: model not found HTTP_404`)
	if err := b.SyncKeys("cline"); err != nil {
		t.Fatal(err)
	}
	after := modelIDs(t, reg, "jethub-cline")
	if hasModel(after, "cline-free/mimo-v2.6-flash") {
		t.Fatalf("a runtime-verified dead model must not be offered, got %v", after)
	}
	// 其它模型必须原样保留（过滤不能误伤）。
	if !hasModel(after, "cline-free/muse-spark-1.3-contributor") {
		t.Fatalf("the filter must not drop healthy models, got %v", after)
	}
}

func modelIDs(t *testing.T, reg *fakeRegistry, providerID string) []string {
	t.Helper()
	p, ok := reg.GetProvider(providerID)
	if !ok {
		t.Fatalf("provider %s not registered", providerID)
	}
	out := make([]string, 0, len(p.Models))
	for _, md := range p.Models {
		out = append(out, md.ID)
	}
	return out
}

func hasModel(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
