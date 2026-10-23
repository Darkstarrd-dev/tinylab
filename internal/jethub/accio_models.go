package jethub

// Accio 远端模型目录（POST /api/llm/config/v2，token 在 **body**：`{token}`，
// ref AccioAuth.fetchModels —— 不是 accessToken 键，三个只读积分端点的键名才
// 是 accessToken）。
//
// ## 为什么必须动态拉取
//
// 上游 `modelCode` 形如 `1Drift-N8kP2Q7wR5mX`（非人类可读），兜底表只作离线
// 回退、无法凭名字手写维护。对外 id 用展示名归一后的 slug（accioModelIDOf），
// 上行由 accioModelCodeOf 映射回 modelCode —— 未知 id 原样透传。
//
// ## 缓存（进程内，包级 —— 目录与账号无关）
//
//	成功 ⇒ 缓存 ~10 分钟；失败/空结果 ⇒ ~30 秒冷却（ref RemoteCatalogGate 的
//	闸门语义：并发去重 + 失败冷却，避免面板每秒列模型都打一整天上游）。
//
// `visible !== true` 一律剔除；modelCode 空的剔除；按 effectiveMultiple 升序
// （便宜在前），缺倍率的排最后（ref parseAccioCatalog 的排序判据：两边都缺时
// 保持相对顺序，不产 NaN）。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	accioCatalogSuccessTTL  = 10 * time.Minute
	accioCatalogFailureTTL  = 30 * time.Second
	accioCatalogHTTPTimeout = 15 * time.Second
)

// accioCatalogCache is the process-wide remote-catalog cache (nil entries =
// no cached table; state carries success/failure freshness).
var accioCatalogCache = struct {
	mu       sync.Mutex
	models   []accioModelEntry
	fetched  time.Time
	failed   bool
	inflight bool
}{}

// InvalidateAccioCatalogCache 清空 Accio 远端目录缓存（账号登录/变动或手动刷新时调用）。
func InvalidateAccioCatalogCache() {
	accioCatalogCache.mu.Lock()
	defer accioCatalogCache.mu.Unlock()
	accioCatalogCache.models = nil
	accioCatalogCache.fetched = time.Time{}
	accioCatalogCache.failed = false
}

// accioParseCatalog parses `data[].modelList[]`（ref parseAccioCatalog +
// normalizeAccioModel —— 本包唯一一份目录解析）。
func accioParseCatalog(raw []byte) []accioModelEntry {
	var parsed struct {
		Data []struct {
			ModelList []struct {
				Visible           bool     `json:"visible"`
				ModelCode         string   `json:"modelCode"`
				ModelDisplayName  string   `json:"modelDisplayName"`
				ContextWindow     float64  `json:"contextWindow"`
				MaxTokens         float64  `json:"maxTokens"`
				Multimodal        bool     `json:"multimodal"`
				EffectiveMultiple *float64 `json:"effectiveMultiple"`
				ReasoningEfforts  []string `json:"reasoningEfforts"`
				DefaultEffort     string   `json:"defaultReasoningEffort"`
			} `json:"modelList"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	var out []accioModelEntry
	for _, group := range parsed.Data {
		for _, row := range group.ModelList {
			// ⚠️ visible !== true 一律剔除；modelCode 空的剔除（ref 判据）。
			if !row.Visible || row.ModelCode == "" {
				continue
			}
			e := accioModelEntry{
				ID:            row.ModelCode,
				Name:          row.ModelDisplayName,
				ContextWindow: int(row.ContextWindow),
				MaxTokens:     int(row.MaxTokens),
				SupportsImage: row.Multimodal,
			}
			if e.Name == "" {
				e.Name = e.ID
			}
			if row.EffectiveMultiple != nil {
				e.Multiple = *row.EffectiveMultiple
				e.HasMultiple = true
			}
			// ⚠️ 档位如实处理三种形态（ref normalizeAccioModel）：null/[] 都算
			// 「无档位」；元素必须是非空字符串（脏值丢弃）；default-only 也算
			// 单档（实测服务端接受）。
			for _, eff := range row.ReasoningEfforts {
				if s := strings.TrimSpace(eff); s != "" {
					e.Efforts = append(e.Efforts, s)
				}
			}
			e.DefaultEffort = strings.TrimSpace(row.DefaultEffort)
			out = append(out, e)
		}
	}
	// 倍率升序，缺倍率的排最后；两边都缺保持相对顺序（稳定排序）。
	// ⚠️ 「缺倍率」用 HasMultiple 标记而不是拿 0 当哨兵：0 在数学上是合法倍率。
	sort.SliceStable(out, func(i, j int) bool {
		left, right := out[i].HasMultiple, out[j].HasMultiple
		switch {
		case left == right:
			return left && out[i].Multiple < out[j].Multiple
		default:
			return left // 有倍率的在前
		}
	})
	return out
}

// accioFetchCatalog performs the remote catalog call (POST, token in body).
func accioFetchCatalog(ctx context.Context, accessToken string) ([]accioModelEntry, error) {
	payload, err := json.Marshal(map[string]any{"token": accessToken})
	if err != nil {
		return nil, err
	}
	tctx, cancel := context.WithTimeout(ctx, accioCatalogHTTPTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(tctx, http.MethodPost, accioGatewayBase+accioCatalogPath, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := callbackClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("accio: 目录请求失败：%w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &HTTPError{Status: resp.StatusCode, Body: string(raw)}
	}
	models := accioParseCatalog(raw)
	if len(models) == 0 {
		return nil, fmt.Errorf("accio: 目录响应不含任何可见模型（HTTP %d）", resp.StatusCode)
	}
	return models, nil
}

// accioRemoteModels returns the cached remote table, refreshing it when stale.
// 失败/冷却时返回 nil（调用方回落兜底表）。⚠️ 目录与账号无关：进程级缓存 +
// 并发去重，没有可用凭据时（未登录）不发请求 —— 打日志只会制造噪声
// （ref fetchModels 的同款取舍）。
func (m *Manager) accioRemoteModels(ctx context.Context) []accioModelEntry {
	accioCatalogCache.mu.Lock()
	now := time.Now()
	if len(accioCatalogCache.models) > 0 && now.Sub(accioCatalogCache.fetched) < accioCatalogSuccessTTL {
		models := accioCatalogCache.models
		accioCatalogCache.mu.Unlock()
		return models
	}
	if accioCatalogCache.failed && now.Sub(accioCatalogCache.fetched) < accioCatalogFailureTTL {
		accioCatalogCache.mu.Unlock()
		return nil
	}
	if accioCatalogCache.inflight {
		accioCatalogCache.mu.Unlock()
		return nil // 并发去重：等待者直接回落兜底表，不排队
	}
	// 选一个带凭据的账号（任一启用账号；目录读数与选号无关）。
	var token string
	for _, acc := range m.Accounts("accio") {
		if !acc.Enabled {
			continue
		}
		if cred, err := m.accioCredential(&acc); err == nil && cred != nil && cred.AccessToken != "" {
			token = cred.AccessToken
			break
		}
	}
	if token == "" {
		accioCatalogCache.mu.Unlock()
		return nil
	}
	accioCatalogCache.inflight = true
	accioCatalogCache.mu.Unlock()

	models, err := accioFetchCatalog(ctx, token)

	accioCatalogCache.mu.Lock()
	accioCatalogCache.inflight = false
	accioCatalogCache.fetched = time.Now()
	accioCatalogCache.failed = err != nil || len(models) == 0
	if err == nil && len(models) > 0 {
		accioCatalogCache.models = models
	}
	accioCatalogCache.mu.Unlock()
	if err != nil {
		if m.logger != nil {
			m.logger.Warn("[jethub] accio 远端目录拉取失败（回落兜底表）: %v", err)
		}
		return nil
	}
	return models
}

// AccioModelsFor is the dynamic ModelTable source wired into Product.ModelsFor:
// 远端优先，未落地时回落静态兜底表（SyncKeys 与 /models API 共用这一份）。
func AccioModelsFor(m *Manager) ModelTable {
	if m != nil {
		if models := m.accioRemoteModels(context.Background()); len(models) > 0 {
			return accioModelTable(models)
		}
	}
	return accioFallbackModelTable
}

// accioEntriesFor resolves the model-entry list backing slug↔modelCode mapping:
// 远端优先（有缓存才用 —— 未拉到时用兜底表，两边的 slug 都由展示名归一得出，
// 上行映射永远一致），并保证「请求里的 slug」能映射。
func (m *Manager) accioEntriesFor() []accioModelEntry {
	if models := m.accioRemoteModels(context.Background()); len(models) > 0 {
		return models
	}
	return accioFallbackModels
}
