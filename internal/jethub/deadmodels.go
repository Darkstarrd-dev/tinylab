package jethub

// 已失效模型的**运行时实证**记录与剔除（R5，ref f8748fa）。
//
// ## 解决什么（上游真实报障）
//
// 用户在 Free Hub 选中 cline 的 `cline-free/deepseek-v4.1-flash`，每轮都失败：
// `cline: model not found HTTP_404` —— 账号、余额、网络都正常。该模型**已被上游
// 从 `free` 数组移除**，但模型列表里仍显示它、并且仍标着「免费」：用户拿到的是
// 一个**看着可用、一点就 404** 的条目。
//
// 根因：各 provider 的兜底模型表是**编译期快照**，上游下架模型时它不会自己变。
//
// ## ⚠️ 为什么不能用「远端目录里没有 ⇒ 已下架」来剔除
//
// 那个判据只在**远端完整权威**的 provider 上成立。本端的实际情况分三类：
//
//	| provider            | 远端目录              | 目录比对可用 |
//	|---------------------|-----------------------|--------------|
//	| cline               | free 数组完整权威      | ✅（已在 R3-2 手工同步） |
//	| buddy/workbuddy     | **已知残缺**           | ❌ 会删掉可用模型 |
//	| qoder/qodercn       | 无（需 WASM 签名）     | ❌ 无数据可比对 |
//
// ⇒ 唯一**跨 provider 安全**的判据是**阳性证据**：这个模型**真的**请求失败并
// 返回「模型不存在」时才记。**不从残缺目录反推**（本端远端目录本就未实现，
// 见架构 §6.3）。
//
// ## 行为
//
//  1. **记录**：代理/探针看到明确的「模型不存在」错误时，按 `provider + modelID`
//     落盘到 `{jethubDir}/dead-models.json`。
//  2. **剔除**：此后该 provider 的模型列表不再播报它。
//  3. **过期**：记录带 TTL（默认 30 天，`TINYLAB_DEAD_MODEL_TTL_DAYS` 可覆盖，
//     `0` = 永不过期）。⚠️ **TTL 是必需的**：已被剔除的模型用户**选不到**，
//     不可能靠「再成功一次」自愈，只能靠过期回收。
//
// ## 判据为什么必须保守（误判代价不对称）
//
// 误判（把可用模型记成失效）会把一个好模型从列表里藏起来，且**用户无法自行恢复**。
// 故只认明确的「模型不存在」文案，出现限流/额度/认证类关键词时**一律不记**。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/fsutil"
)

// deadModelFile is the on-disk record file (same dir as accounts.json).
const deadModelFile = "dead-models.json"

// deadModelDefaultTTLDays is the default retention (ref DEFAULT_TTL_DAYS).
const deadModelDefaultTTLDays = 30

// deadModelTTLEnv overrides the retention in days (0 = never expire).
const deadModelTTLEnv = "TINYLAB_DEAD_MODEL_TTL_DAYS"

// deadModelGonePatterns are the **positive-evidence** text criteria.
//
// ⚠️ 全部要求「model」与「不存在」语义**同现**，不接受泛词：
// `unsupported` / `invalid` 单独出现**不算**（可能是参数错而非模型下架）。
var deadModelGonePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)model\s+not\s+found`),
	regexp.MustCompile(`(?i)model\b[^.!?]{0,24}\bnot\s+(?:found|exist|available|supported)`),
	regexp.MustCompile(`(?i)(?:unknown|no\s+such|nonexistent)\s+model`),
	regexp.MustCompile(`(?i)model[^.!?]{0,16}(?:does\s*not|doesn'?t)\s+exist`),
	// ⚠️ 窗口要够宽：`模型 deepseek-v4.1-flash-x 不存在` 里，「模型」与「不存在」
	// 之间隔着一整个 id（实测 12+ 字符）。
	// ⚠️ **不收 `不可用`**：账号/额度类报错也这么说（「所有账号均不可用」），
	// 收它会把账号问题误记成模型下架。
	regexp.MustCompile(`模型[^，。；;!?]{0,32}(?:不存在|未找到|未上线|已下线|已下架)`),
	regexp.MustCompile(`(?i)model[^.!?]{0,24}(?:不存在|未找到|已下线|已下架)`),
}

// deadModelNotGonePatterns are the exclusion criteria: 命中则**不记**。
//
// 限流 / 额度 / 认证失败都可能带 `model` 字样（例如「该模型额度已用尽」），
// 但它们说明的是**账号**状态，不是模型下架 —— 记错了会把可用模型藏起来。
var deadModelNotGonePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)rate\s*-?\s*limit`),
	regexp.MustCompile(`(?i)too\s+many\s+requests`),
	regexp.MustCompile(`(?i)quota`),
	regexp.MustCompile(`(?i)insufficient`),
	regexp.MustCompile(`(?i)unauthor|forbidden|expired|invalid\s+(?:token|api\s*key|credential)`),
	regexp.MustCompile(`限流|限速|额度|余额|积分|排队|繁忙|未登录|认证|鉴权|凭据`),
}

// deadModelRecord is one entry: when and why the model was marked gone.
type deadModelRecord struct {
	At     string `json:"at"`
	Reason string `json:"reason,omitempty"`
}

// deadModelRecords is `provider → modelID → record`.
type deadModelRecords map[string]map[string]deadModelRecord

// deadModelStore is the process-wide store (lazily loaded from disk).
type deadModelStore struct {
	mu      sync.RWMutex
	dir     string
	records deadModelRecords
	loaded  bool
}

// deadModels is the singleton store; dir is resolved on first use.
var deadModels = &deadModelStore{}

// isModelGoneError reports whether an error message is **positive evidence** that
// the model itself no longer exists (rather than an account/network/param issue).
func isModelGoneError(message string) bool {
	if strings.TrimSpace(message) == "" {
		return false
	}
	for _, p := range deadModelNotGonePatterns {
		if p.MatchString(message) {
			return false
		}
	}
	for _, p := range deadModelGonePatterns {
		if p.MatchString(message) {
			return true
		}
	}
	return false
}

// deadModelTTL returns the retention; 0 means never expire.
func deadModelTTL() time.Duration {
	raw := strings.TrimSpace(os.Getenv(deadModelTTLEnv))
	if raw != "" {
		if days, err := strconv.ParseFloat(raw, 64); err == nil && days >= 0 {
			return time.Duration(days * float64(24*time.Hour))
		}
	}
	return deadModelDefaultTTLDays * 24 * time.Hour
}

// load reads (once) and returns a copy of the records, pruning expired entries.
func (s *deadModelStore) load(dir string) deadModelRecords {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.loaded {
		s.dir = dir
		s.records = s.readLocked()
		s.loaded = true
	}
	out := deadModelRecords{}
	ttl := deadModelTTL()
	now := time.Now()
	for provider, entries := range s.records {
		for id, rec := range entries {
			if ttl > 0 {
				at, err := time.Parse(time.RFC3339, rec.At)
				// ⚠️ 解析失败**不**剔除：宁可多显示一个失效模型，也不要因为一条
				// 记录格式异常就把整张表当成「全部有效」而把它放回来。
				if err == nil && now.Sub(at) > ttl {
					continue
				}
			}
			if out[provider] == nil {
				out[provider] = map[string]deadModelRecord{}
			}
			out[provider][id] = rec
		}
	}
	return out
}

// readLocked parses the on-disk file (caller holds the lock).
func (s *deadModelStore) readLocked() deadModelRecords {
	path := filepath.Join(s.dir, deadModelFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		return deadModelRecords{}
	}
	var doc struct {
		Providers map[string]map[string]deadModelRecord `json:"providers"`
	}
	// 损坏时按**空表**处理：宁可多显示一个失效模型，也不要因为解析失败把整张表
	// 当成「全部失效」而藏掉可用模型。
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Providers == nil {
		return deadModelRecords{}
	}
	return doc.Providers
}

// mark records one (provider, model) as gone and persists atomically.
func (s *deadModelStore) mark(dir, provider, model, reason string) {
	if provider == "" || model == "" {
		return
	}
	s.mu.Lock()
	if !s.loaded {
		s.dir = dir
		s.records = s.readLocked()
		s.loaded = true
	}
	if s.records == nil {
		s.records = deadModelRecords{}
	}
	if s.records[provider] == nil {
		s.records[provider] = map[string]deadModelRecord{}
	}
	s.records[provider][model] = deadModelRecord{
		At:     time.Now().UTC().Format(time.RFC3339),
		Reason: deadModelTruncate(reason, 200),
	}
	payload, err := json.MarshalIndent(struct {
		Schema    string                                `json:"schema"`
		Providers map[string]map[string]deadModelRecord `json:"providers"`
	}{Schema: "tinylab/jethub/dead-models/v1", Providers: s.records}, "", "  ")
	dirNow := s.dir
	s.mu.Unlock()
	if err != nil || dirNow == "" {
		return
	}
	writeDeadModelsAtomic(dirNow, payload)
}

// DeadModels returns the set of models currently marked gone for a provider
// (exported for the API layer's model list).
func (m *Manager) DeadModels(provider string) map[string]bool {
	return m.deadModelsFor(provider)
}

// deadModelsFor returns the set of models currently marked gone for a provider.
func (m *Manager) deadModelsFor(provider string) map[string]bool {
	dir := m.dir
	recs := deadModels.load(dir)
	out := map[string]bool{}
	for id := range recs[provider] {
		out[id] = true
	}
	return out
}

// MarkModelGone records positive evidence that (provider, model) no longer
// exists upstream, so the model list stops offering it. Exported for the proxy
// error path and the probe (both see real upstream 404s).
//
// ⚠️ 只应在 `isModelGoneError(message)` 为真时调用（误判代价不对称）。
func (m *Manager) MarkModelGone(provider, model, reason string) {
	if !isModelGoneError(reason) {
		return
	}
	if !ProviderExists(provider) {
		return
	}
	deadModels.mark(m.dir, provider, model, reason)
}

// ForgetModelGone clears a record (used when a request for the model succeeds:
// the model is demonstrably alive, so the record must not keep hiding it).
func (m *Manager) ForgetModelGone(provider, model string) {
	if provider == "" || model == "" {
		return
	}
	deadModels.mu.Lock()
	if !deadModels.loaded {
		deadModels.dir = m.dir
		deadModels.records = deadModels.readLocked()
		deadModels.loaded = true
	}
	changed := false
	if entries, ok := deadModels.records[provider]; ok {
		if _, had := entries[model]; had {
			delete(entries, model)
			changed = true
		}
	}
	dirNow := deadModels.dir
	var payload []byte
	if changed {
		payload, _ = json.MarshalIndent(struct {
			Schema    string                                `json:"schema"`
			Providers map[string]map[string]deadModelRecord `json:"providers"`
		}{Schema: "tinylab/jethub/dead-models/v1", Providers: deadModels.records}, "", "  ")
	}
	deadModels.mu.Unlock()
	if changed && len(payload) > 0 {
		writeDeadModelsAtomic(dirNow, payload)
	}
}

// deadModelTruncate caps the stored reason (diagnostics only).
func deadModelTruncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

// writeDeadModelsAtomic persists the records via the shared atomic-write helper
// (tmp + rename; 0600 like the other jethub state files).
func writeDeadModelsAtomic(dir string, payload []byte) {
	if dir == "" || len(payload) == 0 {
		return
	}
	_ = fsutil.AtomicWrite(filepath.Join(dir, deadModelFile), payload, 0600)
}

// ReportModelGone implements proxy.ModelGoneReporter: the proxy calls it with
// the raw upstream error message on every non-2xx bridged response.
//
// ⚠️ 本方法**必须**自己守好判据（proxy 侧无条件调用）：只有
// `isModelGoneError` 为真才落记录 —— 误判会把可用模型藏起来且用户无法自行恢复。
func (m *Manager) ReportModelGone(providerID, model, message string) {
	provider, ok := ProviderNameFromID(providerID)
	if !ok {
		return
	}
	m.MarkModelGone(provider, model, message)
}

// ForgetModelGoneByProviderID implements the proxy's success-path hook (the
// model answered 2xx, so it is demonstrably alive).
func (m *Manager) ForgetModelGoneByProviderID(providerID, model string) {
	provider, ok := ProviderNameFromID(providerID)
	if !ok {
		return
	}
	m.ForgetModelGone(provider, model)
}
