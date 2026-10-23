package jethub

// Loomy 远端模型目录（`GET {apiBase}/models`，token 头 —— 业务端点）。
//
// ## 为什么必须动态拉取（用户报障：上游 Loomy 渠道的模型在 Free Hub 里没有）
//
// 上游 `loomy-adapter.ts` 的目录是**远端实时**的：`parseLoomyRemoteModels`
// 过滤 `type === 'chat'` 后，**远端新增的模型（2026-10-08 起 `DeepSeek-V4.1-Flash`）
// 会立刻出现**，静态兜底表（`loomy-product.ts` 的 8 条）只在远端失败时顶替。
// 本端此前只搬了兜底表 ⇒ 面板永远停在 8 条，用户看到「模型列表缺项」。
//
// 故本文件按 **R1-8 的既定形态**（与 accio 同型）落地：
//
//	远端目录（进程内缓存，成功 ~10min / 失败 ~30s 冷却 / 并发去重）
//	  → 远端优先、兜底表兜底（`ModelsFor`，`SyncKeys` 与 `/models` API 共用）。
//
// ## 判据（逐条对齐 ref `src/loomy-adapter.ts` + `src/loomy.ts`）
//
// - 过滤判据是 `type === 'chat'`，**不能**看 `input_modalities`（实测多个 chat
//   模型的输入模态含 image，那是输入多模态不是生图模型）。
// - 展示名经 `loomyDisplayName` 规范化（远端原值三种括号风格混用）。
// - 上下文窗口与图片能力都过覆盖表（与兜底表两条路径同一判据，不得分叉）。
// - 兜底表**不得**写进 `remoteModels` 缓存（一次瞬时失败会让它永久固化）。

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/config"
)

const (
	// loomyCatalogSuccessTTL：远端目录成功落地后的缓存窗口。
	loomyCatalogSuccessTTL = 10 * time.Minute
	// loomyCatalogFailureTTL：失败/空结果后的冷却窗口（避免面板每次列模型都打上游）。
	loomyCatalogFailureTTL = 30 * time.Second
	// loomyCatalogHTTPTimeout：单次目录请求超时。
	loomyCatalogHTTPTimeout = 30 * time.Second
)

// loomyRemoteModel is one upstream `/models` chat entry (ref LoomyRemoteModel).
type loomyRemoteModel struct {
	ID               string
	Name             string // 已规范化 `Name · xN`
	ContextWindow    int
	SupportsImage    bool
	SupportsThinking bool
	Efforts          []string
	DefaultEffort    string
}

// --- 名称规范化（ref loomy.ts splitLoomyRate / loomyDisplayName） ---

var (
	loomyBracketRateRe = regexp.MustCompile(`^(.*?)\s*[（(]\s*(x\s*[\d.]+)\s*[)）]\s*$`)
	loomyNormalRateRe  = regexp.MustCompile(`^(.*?)\s*·\s*(x\s*[\d.]+)\s*$`)
)

// loomySplitRate 抽出末尾倍率，认两种形态：远端原值的末尾括号
// （`MiniMax M3 （x4.0）` / `Qwen 3.8 Max (x12.0)` / `GLM 5.3 Flash(x0.8)`）
// 与已规范化的 `{name} · x{n}`。**幂等**（ref 单测锁死）。
func loomySplitRate(raw string) (name, rate string) {
	original := strings.TrimSpace(raw)
	if original == "" {
		return "", ""
	}
	if m := loomyBracketRateRe.FindStringSubmatch(original); m != nil {
		name = strings.TrimSpace(m[1])
		rate = strings.ToLower(strings.Join(strings.Fields(m[2]), ""))
		if name != "" {
			return name, rate
		}
		return original, "" // 整个 name 就是括号（畸形数据）：原样保留
	}
	if m := loomyNormalRateRe.FindStringSubmatch(original); m != nil {
		name = strings.TrimSpace(m[1])
		rate = strings.ToLower(strings.Join(strings.Fields(m[2]), ""))
		if name != "" {
			return name, rate
		}
	}
	return original, ""
}

// loomyDisplayName 产出最终展示名 `Name · xN`；无倍率时不追加分隔符。
func loomyDisplayName(raw string) string {
	name, rate := loomySplitRate(raw)
	if rate != "" {
		return name + " · " + rate
	}
	return name
}

// --- 覆盖表（ref loomy-product.ts：远端与兜底表两条路径同一判据） ---

// loomyContextWindowOverrides 是逐模型的上下文窗口硬覆盖。
// ⚠️ spark-x：远端虚报 1048576，官方客户端本地表与上游墙位都是 262144
// （Gitee IKJW31）。查表键必须小写（loomyCatalogKey 归一）。
var loomyContextWindowOverrides = map[string]int{"spark-x": 262_144}

// loomyImageCapabilityOverrides 是「远端漏报但实测能读图」的补报表。
// ⚠️ 只放实测确认的个案；qwen-3.8-max 远端只下发 text 却实测读得出图
// （2026-10-14 用户报障）。
var loomyImageCapabilityOverrides = map[string]bool{"qwen-3.8-max": true}

// loomyCatalogKey 归一化查表键（小写 + 去首尾空白）。
// ⚠️ 归一只能发生在查表那一刻，绝不改对外 model.id。
func loomyCatalogKey(modelID string) string {
	return strings.TrimSpace(strings.ToLower(modelID))
}

// loomyContextWindow 返回模型的真实上下文窗口（覆盖优先）。
func loomyContextWindow(modelID string, declared int) int {
	if v, ok := loomyContextWindowOverrides[loomyCatalogKey(modelID)]; ok {
		return v
	}
	return declared
}

// loomySupportsImage 返回模型的真实图片能力（覆盖表只做「补报」不做「降级」）。
func loomySupportsImage(modelID string, declared bool) bool {
	return loomyImageCapabilityOverrides[loomyCatalogKey(modelID)] || declared
}

// --- 远端目录解析（ref parseLoomyRemoteModels） ---

// loomyParseRemoteModels 解析 `/models` 响应（裸数组或 `{data:[...]}`），
// 只保留 `type === 'chat'` 的条目，并做名称规范化 + 覆盖表校正。
func loomyParseRemoteModels(payload []byte) []loomyRemoteModel {
	var entries []map[string]any
	var root json.RawMessage
	if err := json.Unmarshal(payload, &root); err != nil {
		return nil
	}
	if err := json.Unmarshal(root, &entries); err == nil {
		// 裸数组形态。
	} else {
		var wrapped struct {
			Data []map[string]any `json:"data"`
		}
		if err := json.Unmarshal(root, &wrapped); err != nil {
			return nil
		}
		entries = wrapped.Data
	}

	var out []loomyRemoteModel
	for _, item := range entries {
		if !loomyIsChatModel(item) {
			continue
		}
		id := strings.TrimSpace(jsonStringField(item, "id"))
		rawName := jsonStringField(item, "name")
		if rawName == "" {
			rawName = id
		}
		ctx := 0
		if v := jsonNumberField(item, "context_length"); v > 0 {
			ctx = int(v)
		}
		thinking := false
		modalities := loomyInputModalities(item)
		if caps, ok := item["capabilities"].(map[string]any); ok {
			if b, ok := caps["reasoning"].(bool); ok {
				thinking = b
			}
		}
		m := loomyRemoteModel{
			ID:               id,
			Name:             loomyDisplayName(rawName),
			ContextWindow:    loomyContextWindow(id, ctx),
			SupportsImage:    loomySupportsImage(id, containsString(modalities, "image")),
			SupportsThinking: thinking,
		}
		if raw, ok := item["reasoning_efforts"].([]any); ok {
			for _, e := range raw {
				if s, ok := e.(string); ok && strings.TrimSpace(s) != "" {
					m.Efforts = append(m.Efforts, strings.TrimSpace(s))
				}
			}
		}
		if s := strings.TrimSpace(jsonStringField(item, "default_reasoning_effort")); s != "" {
			m.DefaultEffort = s
		}
		out = append(out, m)
	}
	return out
}

// loomyIsChatModel 判 chat 模型：`type === 'chat'` 且 id 非空。
func loomyIsChatModel(entry map[string]any) bool {
	id := strings.TrimSpace(jsonStringField(entry, "id"))
	return id != "" && jsonStringField(entry, "type") == "chat"
}

// loomyInputModalities 读出 `capabilities.input_modalities`（小写字符串数组）。
func loomyInputModalities(entry map[string]any) []string {
	caps, ok := entry["capabilities"].(map[string]any)
	if !ok {
		return nil
	}
	raw, ok := caps["input_modalities"].([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, strings.ToLower(s))
		}
	}
	return out
}

func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// --- 远端目录拉取 + 进程内缓存（ref RemoteCatalogGate 的闸门语义） ---

// loomyCatalogCache 是进程级远端目录缓存（nil entries = 无缓存；状态承载成功/失败新鲜度）。
var loomyCatalogCache = struct {
	mu       sync.Mutex
	models   []loomyRemoteModel
	fetched  time.Time
	failed   bool
	inflight bool
}{}

// loomyFetchModels 拉取一次远端目录（token 头 —— 业务端点；Bearer 会 100002）。
func (m *Manager) loomyFetchModels(ctx context.Context, token string) ([]loomyRemoteModel, error) {
	tctx, cancel := context.WithTimeout(ctx, loomyCatalogHTTPTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(tctx, http.MethodGet, loomyProduct.APIBase+"/models", nil)
	if err != nil {
		return nil, err
	}
	for k, v := range loomyBusinessHeaders(token) {
		req.Header.Set(k, v)
	}
	resp, err := m.httpClient("loomy").Do(req)
	if err != nil {
		return nil, fmt.Errorf("loomy: 模型目录请求失败：%w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("loomy: 模型目录 HTTP %d", resp.StatusCode)
	}
	models := loomyParseRemoteModels(raw)
	if len(models) == 0 {
		return nil, fmt.Errorf("loomy: 模型目录不含任何 chat 模型（HTTP %d）", resp.StatusCode)
	}
	return models, nil
}

// loomyRemoteModels 返回缓存的远端目录（过期则刷新）。失败/冷却/并发时返回 nil
// （调用方回落兜底表）。目录与账号无关：进程级缓存 + 并发去重；无可用凭据时
// 不发请求（ref fetchModels 的同款取舍）。
func (m *Manager) loomyRemoteModels(ctx context.Context) []loomyRemoteModel {
	loomyCatalogCache.mu.Lock()
	now := time.Now()
	if len(loomyCatalogCache.models) > 0 && now.Sub(loomyCatalogCache.fetched) < loomyCatalogSuccessTTL {
		models := loomyCatalogCache.models
		loomyCatalogCache.mu.Unlock()
		return models
	}
	if loomyCatalogCache.failed && now.Sub(loomyCatalogCache.fetched) < loomyCatalogFailureTTL {
		loomyCatalogCache.mu.Unlock()
		return nil
	}
	if loomyCatalogCache.inflight {
		loomyCatalogCache.mu.Unlock()
		return nil // 并发去重：等待者直接回落兜底表，不排队
	}
	var token string
	for _, acc := range m.Accounts("loomy") {
		if !acc.Enabled {
			continue
		}
		if cred, err := m.loomyCredentialFor(acc.ID); err == nil && cred.AccessToken != "" {
			token = cred.AccessToken
			break
		}
	}
	if token == "" {
		loomyCatalogCache.mu.Unlock()
		return nil
	}
	loomyCatalogCache.inflight = true
	loomyCatalogCache.mu.Unlock()

	models, err := m.loomyFetchModels(ctx, token)

	loomyCatalogCache.mu.Lock()
	loomyCatalogCache.inflight = false
	loomyCatalogCache.fetched = time.Now()
	loomyCatalogCache.failed = err != nil || len(models) == 0
	if err == nil && len(models) > 0 {
		loomyCatalogCache.models = models
	}
	loomyCatalogCache.mu.Unlock()
	if err != nil {
		if m.logger != nil {
			m.logger.Warn("[jethub] loomy 远端目录拉取失败（回落兜底表）：%v", err)
		}
		return nil
	}
	return models
}

// --- 动态模型表（Product.ModelsFor 的接线点） ---

// loomyModelTable 把远端目录条目转成桥接模型表：
// ID = 上游 id，Alias = 已规范化 `Name · xN`，Note = "ctx N"，QuotaType = limited。
func loomyModelTable(models []loomyRemoteModel) ModelTable {
	out := make(ModelTable, 0, len(models))
	for _, e := range models {
		note := ""
		if e.ContextWindow > 0 {
			note = fmt.Sprintf("ctx %d", e.ContextWindow)
		}
		out = append(out, config.ModelDef{
			ID:        e.ID,
			Alias:     e.Name,
			Note:      note,
			QuotaType: "limited",
		})
	}
	return out
}

// LoomyModelsFor 是 Product.ModelsFor 的动态来源：远端优先（有缓存才用），
// 未落地时回落静态兜底表。SyncKeys 与 /models API 共用这一份。
func LoomyModelsFor(m *Manager) ModelTable {
	if m != nil {
		if models := m.loomyRemoteModels(context.Background()); len(models) > 0 {
			return loomyModelTable(models)
		}
	}
	return loomyFallbackModels()
}
