package jethub

// Raccoon 远端模型目录（`GET {apiBase}/api/web/llm/v2/model_catalog`，
// Bearer 凭据 —— 业务端点，走 `raccoonRequest` 的同一条出站管线）。
//
// ## 为什么必须动态拉取（用户报障：上游有 `DeepSeek-V4.1-Flash-1017`，Free Hub 里没有）
//
// 上游 `raccoon-auth.ts` 的 `fetchModels` + `raccoon-adapter.ts` 的
// `createModelCatalog` 是**远端实时**的：远端会滚动上架同族新版本
// （2026-10-21 起 `sn-deepseek-v4-1-flash-1017`，展示名 `DeepSeek-V4.1-Flash-1017`），
// 目录立刻多一条；静态兜底表（`raccoon-product.ts` 的 6 条，2026-09-26 快照）
// 只在远端失败时顶替。本端此前**只有**兜底表 ⇒ 面板永远停在 6 条，
// 用户看到「上游有的模型我们没有」。这与 loomy 的同名报障同因
// （见 loomy_models.go 头注与 docs/jethub-architecture.md §6.3.1），
// 也即 docs/jethub-upstream-sync.md §6 R1-8 登记的缺口在 raccoon 上的兑现。
//
// 落地形态按 **R1-8 的既定模式**（与 accio / loomy 同型）：
//
//	远端目录（进程内缓存，成功 ~10min / 失败·空结果 ~30s 冷却 / 并发去重）
//	  → 远端优先、兜底表兜底（`ModelsFor`，`SyncKeys` 与 `/models` API 共用）。
//
// ## 判据（逐条对齐 ref `src/raccoon-auth.ts` + `src/raccoon.ts`）
//
// - **信封**：`code == 0` 才算成功（HTTP 200 + 非 0 code 也是失败）；非 0 ⇒ 空目录 ⇒ 兜底。
// - **只取 `categories[].type === 'chat'` 的那一组**；组内按**远端原顺序**，不重排
//   （重排会让「与远端对比」失去可比性；accio 按倍率排序是它自己 ref 的判据，不通用）。
// - **`id` 取远端的 `name` 字段**（raccoon 的反直觉命名），`description` 才是展示名主体。
// - **`visible` 只有显式 `false` 才剔除**（字段缺失按可见，保守：不因缺字段隐藏模型）。
// - **展示名 = `RaccoonDisplayName(description, effective, base)`**，倍率拼进展示名；
//   ⚠️ 倍率**缺失必须传 -1 而不是 0** —— 0 会被渲染成「免费」，用户会当价格读。
// - **图片能力默认支持**（不看 `tags`）：`tags.vision` 是客户端「Raccoon-Auto 选模」
//   的偏好标签，不是服务端能力契约（2026-10-03 实测 6 个可见模型全部能读图，其中
//   `sn-deepseek-v4-1-flash` / `sn-glm-5-3-flash` 的 tags 根本不含 vision）。
//   真正的纯文本模型登记在 `raccoonTextOnlyModels` 里**显式禁掉**，且判据按
//   **基础 id** 命中（同族滚版本 `-1017` 的 tags 原样继承，白名单必然腐坏）。
//   本端代理对图片一律透传，该位只作记录/展示（ModelDef 无模态字段）。
// - **兜底表不写进 `raccoonCatalogCache`**（一次瞬时失败会让它永久固化）。

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/config"
)

const (
	// raccoonCatalogSuccessTTL：远端目录成功落地后的缓存窗口。
	raccoonCatalogSuccessTTL = 10 * time.Minute
	// raccoonCatalogFailureTTL：失败/空结果后的冷却窗口（面板每次列模型都打上游 = 事故）。
	raccoonCatalogFailureTTL = 30 * time.Second
	// raccoonCatalogHTTPTimeout：单次目录请求超时（ref AbortSignal.timeout(20_000)）。
	raccoonCatalogHTTPTimeout = 20 * time.Second
)

// raccoonRemoteModel is one visible chat entry of the remote catalog
// (ref RaccoonRemoteModel，已归一：展示名已含倍率）。
type raccoonRemoteModel struct {
	ID            string
	Name          string // 已规范化 `描述 · x倍率` / `· 免费` / `· x原→x折`
	ContextWindow int
	MaxTokens     int
	SupportsImage bool
}

// --- 图片能力判据（ref raccoon-product.ts RACCOON_TEXT_ONLY_MODELS） ---

// raccoonModelVersionSuffixRe 是同族版本后缀（`sn-deepseek-v4-1-flash-1017` 的
// `-1017`）。⚠️ **只在查纯文本集合时剥离**，不用于展示名或请求 id：请求必须用
// 远端下发的完整 id（剥了会 404），展示名也要保留版本号让用户能区分。
var raccoonModelVersionSuffixRe = regexp.MustCompile(`-\d{4}$`)

// raccoonTextOnlyModels 是**实测确认不能读图**的模型（基础 id 或完整 id）。
// 当前目录（含 3 个 visible:false 内部模型）里没有实测确认的纯文本模型 ⇒ 空集。
// ⚠️ 新增条目必须先有带图实测证据：判据是「带图请求被明确拒绝（4xx / 明确错误码）」，
// 而不是「200 但答非所问」——后者是 provider 侧节点不一致（`sn-glm-5-3` 实测 1/3，
// 登记了会把整条模型禁成 text）。
var raccoonTextOnlyModels = map[string]bool{}

// raccoonSupportsImageWith 是图片判定的**纯函数内核**（入参化集合，便于单测注入；
// 生产集合为空 ⇒ 「禁纯文本」那条分支不注入就测不到）。
func raccoonSupportsImageWith(textOnly map[string]bool, modelID string) bool {
	if textOnly[modelID] {
		return false
	}
	// 同族滚版本：`sn-deepseek-v4-1-flash-1017` → `sn-deepseek-v4-1-flash`；
	// 纯文本模型同样会滚版本，不按基础 id 命中就会漏禁。
	base := raccoonModelVersionSuffixRe.ReplaceAllString(modelID, "")
	if base != modelID && textOnly[base] {
		return false
	}
	return true
}

// raccoonSupportsImage：默认支持识图，只有登记在集合里的才返回 false。
func raccoonSupportsImage(modelID string) bool {
	return raccoonSupportsImageWith(raccoonTextOnlyModels, modelID)
}

// raccoonMultiplier 读倍率并区分「缺失」与「0」：缺失/负数返回 -1（展示名不挂
// 后缀），0 是合法倍率（展示成「免费」）。⚠️ 不能图省事用 `jsonNumberField`：
// 它对缺失字段回 0，会把「没取到倍率」显示成「免费」。
func raccoonMultiplier(entry map[string]any, key string) float64 {
	if entry == nil {
		return -1
	}
	if f, ok := entry[key].(float64); ok && f >= 0 {
		return f
	}
	return -1
}

// raccoonPositiveInt 读正整数（0/负数/非数一律 0）。
func raccoonPositiveInt(entry map[string]any, key string) int {
	if entry == nil {
		return 0
	}
	if f, ok := entry[key].(float64); ok && f > 0 {
		return int(f)
	}
	return 0
}

// raccoonNormalizeModel 归一一条远端目录条目（ref raccoon-auth.ts
// normalizeRemoteModel）。⚠️ id 取 `name`、展示名取 `description`。
// 返回 ok=false 表示该条目不进目录（空 id / 显式 visible:false）。
func raccoonNormalizeModel(entry map[string]any) (raccoonRemoteModel, bool) {
	id := strings.TrimSpace(jsonStringField(entry, "name"))
	if id == "" {
		return raccoonRemoteModel{}, false
	}
	// ⚠️ 只有**显式 false** 才剔除：字段缺失按可见（保守，不因缺字段隐藏模型）。
	if v, ok := entry["visible"].(bool); ok && !v {
		return raccoonRemoteModel{}, false
	}
	params, _ := entry["params"].(map[string]any)
	description := strings.TrimSpace(jsonStringField(entry, "description"))
	if description == "" {
		description = id
	}
	ctxWindow := raccoonPositiveInt(params, "context_window")
	if ctxWindow == 0 {
		ctxWindow = raccoonPositiveInt(entry, "context_window")
	}
	return raccoonRemoteModel{
		ID: id,
		Name: RaccoonDisplayName(description, raccoonMultiplier(entry, "billing_effective_multiplier"),
			raccoonMultiplier(entry, "billing_multiplier")),
		ContextWindow: ctxWindow,
		MaxTokens:     raccoonPositiveInt(params, "max_tokens"),
		SupportsImage: raccoonSupportsImage(id),
	}, true
}

// raccoonModelsFromData 解析信封的 `data` 对象（判据与 ref
// `parseRaccoonModelCatalog` 逐条对应；信封 `code == 0` 那一半由
// `raccoonRequest` + `raccoonFetchCatalog` 负责，即探针与推理共用的同一条出站管线）。
// `categories[]` 里**第一个** `type === 'chat'`
// 的组 → 逐条归一 → 按 id 去重、**保留远端原顺序**（不重排：重排会让「与远端
// 对比」这类排查失去可比性；accio 按倍率排序是它自己 ref 的判据，不通用）。
func raccoonModelsFromData(data map[string]any) []raccoonRemoteModel {
	categories, _ := data["categories"].([]any)
	var chat map[string]any
	for _, item := range categories {
		if entry, ok := item.(map[string]any); ok && jsonStringField(entry, "type") == "chat" {
			chat = entry
			break
		}
	}
	if chat == nil {
		return nil
	}
	entries, _ := chat["models"].([]any)
	seen := make(map[string]bool, len(entries))
	out := make([]raccoonRemoteModel, 0, len(entries))
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		model, ok := raccoonNormalizeModel(entry)
		if !ok || seen[model.ID] {
			continue
		}
		seen[model.ID] = true
		out = append(out, model)
	}
	return out
}

// --- 缓存（进程内，包级：目录与账号无关，与 accio/loomy 同构） ---

var raccoonCatalogCache = struct {
	mu       sync.Mutex
	models   []raccoonRemoteModel
	fetched  time.Time
	failed   bool
	inflight bool
}{}

// raccoonFetchCatalog 发一次目录请求（GET，凭据走 raccoonRequest 的统一头）。
func (m *Manager) raccoonFetchCatalog(ctx context.Context, cred *RaccoonCredential) ([]raccoonRemoteModel, error) {
	tctx, cancel := context.WithTimeout(ctx, raccoonCatalogHTTPTimeout)
	defer cancel()
	env, err := m.raccoonRequest(tctx, cred, http.MethodGet, raccoonAPIBase+raccoonModelCatalog, "")
	if err != nil {
		return nil, err
	}
	if env.Code != 0 {
		return nil, env.err("模型目录查询失败")
	}
	models := raccoonModelsFromData(env.Data)
	if len(models) == 0 {
		return nil, fmt.Errorf("raccoon: 目录响应不含任何可见 chat 模型")
	}
	return models, nil
}

// raccoonRemoteModels returns the cached remote table, refreshing when stale.
// 失败/冷却时返回 nil（调用方回落兜底表）。⚠️ 没有可用凭据时不发请求
// （未登录打上游只会制造噪声）；兜底表**不写缓存**（R1-8 判据：一次瞬时失败
// 会让整条渠道永久只剩兜底模型）。
func (m *Manager) raccoonRemoteModels(ctx context.Context) []raccoonRemoteModel {
	raccoonCatalogCache.mu.Lock()
	now := time.Now()
	if len(raccoonCatalogCache.models) > 0 && now.Sub(raccoonCatalogCache.fetched) < raccoonCatalogSuccessTTL {
		models := raccoonCatalogCache.models
		raccoonCatalogCache.mu.Unlock()
		return models
	}
	if raccoonCatalogCache.failed && now.Sub(raccoonCatalogCache.fetched) < raccoonCatalogFailureTTL {
		raccoonCatalogCache.mu.Unlock()
		return nil
	}
	if raccoonCatalogCache.inflight {
		raccoonCatalogCache.mu.Unlock()
		return nil // 并发去重：等待者直接回落兜底表，不排队
	}
	// 选一个带凭据的启用账号（目录读数与选号无关）。
	var cred *RaccoonCredential
	for _, acc := range m.Accounts("raccoon") {
		if !acc.Enabled {
			continue
		}
		if c, err := m.raccoonCredentialFor(acc.ID); err == nil && c != nil && c.AccessToken != "" {
			cred = c
			break
		}
	}
	if cred == nil {
		raccoonCatalogCache.mu.Unlock()
		return nil
	}
	raccoonCatalogCache.inflight = true
	raccoonCatalogCache.mu.Unlock()

	models, err := m.raccoonFetchCatalog(ctx, cred)

	raccoonCatalogCache.mu.Lock()
	raccoonCatalogCache.inflight = false
	raccoonCatalogCache.fetched = time.Now()
	raccoonCatalogCache.failed = err != nil || len(models) == 0
	if err == nil && len(models) > 0 {
		raccoonCatalogCache.models = models
	}
	raccoonCatalogCache.mu.Unlock()
	if err != nil {
		if m.logger != nil {
			m.logger.Warn("[jethub] raccoon 远端目录拉取失败（回落兜底表）: %v", err)
		}
		return nil
	}
	return models
}

// --- 动态模型表（Product.ModelsFor 的接线点） ---

// raccoonModelTable 把远端目录条目转成桥接模型表：
// ID = 远端 id（含 `-1017` 这类版本后缀，**不得剥**——请求要用完整 id），
// Alias = 已含倍率的展示名，Note = `ctx N; max M`，QuotaType = limited。
func raccoonModelTable(models []raccoonRemoteModel) ModelTable {
	out := make(ModelTable, 0, len(models))
	for _, e := range models {
		note := ""
		if e.ContextWindow > 0 {
			note = fmt.Sprintf("ctx %d", e.ContextWindow)
		}
		if e.MaxTokens > 0 {
			if note != "" {
				note += "; "
			}
			note += fmt.Sprintf("max %d", e.MaxTokens)
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

// RaccoonModelsFor 是 Product.ModelsFor 的动态来源：远端优先（有缓存才用），
// 未落地时回落静态兜底表。SyncKeys 与 /models API 共用这一份。
func RaccoonModelsFor(m *Manager) ModelTable {
	if m != nil {
		if models := m.raccoonRemoteModels(context.Background()); len(models) > 0 {
			return raccoonModelTable(models)
		}
	}
	return raccoonFallbackModels()
}
