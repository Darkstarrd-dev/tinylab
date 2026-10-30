package jethub

// Codely 远端模型目录（ref src/codely-product.ts / codely-adapter.ts）。
//
// `GET https://codely.tuanjie.cn/api/model-status`（Bearer access_token）返回
// **运行状态**（不是 /v1/models）：每项只有 `modelGroup` / `status` 等字段。
// 只取 `modelGroup` 当模型 id；**不把 status 拼进名字**（状态是分钟级波动的
// 运行态，拼进显示名会让目录漂移）。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/config"
)

const (
	codelyCatalogSuccessTTL = 10 * time.Minute
	codelyCatalogFailureTTL = 30 * time.Second
)

// codelyCatalogCache is the process-level catalog cache (catalog is global, not
// per account). 失败/空结果不写缓存（远端临时故障不得让兜底表成为终点）。
var codelyCatalogCache = struct {
	sync.Mutex
	models   []string
	fetched  time.Time
	failed   bool
	inflight bool
}{}

// codelyParseModelStatus is the pure parse step: models[].modelGroup, deduped
// in remote order. Model ids are kept verbatim (no invented display names).
func codelyParseModelStatus(raw []byte) []string {
	var parsed struct {
		Models []struct {
			ModelGroup string `json:"modelGroup"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, item := range parsed.Models {
		id := item.ModelGroup
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// codelyFetchModels performs one catalog request with the access token.
func (m *Manager) codelyFetchModels(ctx context.Context, accessToken string) ([]string, error) {
	payload, status, err := m.codelyAuthorizedJSON(ctx, http.MethodGet, codelyAPIBase+codelyModelStatusPath, nil, accessToken)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("codely: 模型目录 HTTP %d", status)
	}
	raw, _ := json.Marshal(payload)
	models := codelyParseModelStatus(raw)
	if len(models) == 0 {
		return nil, fmt.Errorf("codely: 模型目录为空（HTTP %d）", status)
	}
	return models, nil
}

// codelyRemoteModels returns the cached remote catalog (nil when cooling down,
// in flight, or no usable credential ⇒ caller falls back to the static table).
func (m *Manager) codelyRemoteModels(ctx context.Context) []string {
	codelyCatalogCache.Lock()
	now := time.Now()
	if len(codelyCatalogCache.models) > 0 && now.Sub(codelyCatalogCache.fetched) < codelyCatalogSuccessTTL {
		models := codelyCatalogCache.models
		codelyCatalogCache.Unlock()
		return models
	}
	if codelyCatalogCache.failed && now.Sub(codelyCatalogCache.fetched) < codelyCatalogFailureTTL {
		codelyCatalogCache.Unlock()
		return nil
	}
	if codelyCatalogCache.inflight {
		codelyCatalogCache.Unlock()
		return nil // 并发去重：后来者直接回落兜底表，不排队
	}
	var token string
	for _, acc := range m.Accounts(codelyProviderID) {
		if !acc.Enabled {
			continue
		}
		if cred, err := m.codelyCredentialFor(acc.ID); err == nil && cred.AccessToken != "" {
			token = cred.AccessToken
			break
		}
	}
	if token == "" {
		codelyCatalogCache.Unlock()
		return nil
	}
	codelyCatalogCache.inflight = true
	codelyCatalogCache.Unlock()

	models, err := m.codelyFetchModels(ctx, token)

	codelyCatalogCache.Lock()
	codelyCatalogCache.inflight = false
	codelyCatalogCache.fetched = time.Now()
	codelyCatalogCache.failed = err != nil || len(models) == 0
	if err == nil && len(models) > 0 {
		codelyCatalogCache.models = models
	}
	codelyCatalogCache.Unlock()
	if err != nil && m.logger != nil {
		m.logger.Warn("[jethub] codely 远端目录拉取失败（回落兜底表）：%v", err)
	}
	return models
}

// codelyModelTable maps remote ids to ModelDef (no invented names/context).
func codelyModelTable(ids []string) ModelTable {
	out := make(ModelTable, 0, len(ids))
	for _, id := range ids {
		out = append(out, codelyModelDef(id))
	}
	return out
}

// codelyModelDef is the one place remote ids become ModelDefs.
func codelyModelDef(id string) config.ModelDef {
	return config.ModelDef{ID: id, Alias: id, QuotaType: "limited"}
}

// CodelyModelsFor is Product.ModelsFor's dynamic source: remote first, static
// fallback otherwise (SyncKeys and the /models API share this one).
func CodelyModelsFor(m *Manager) ModelTable {
	if m != nil {
		if ids := m.codelyRemoteModels(context.Background()); len(ids) > 0 {
			return codelyModelTable(ids)
		}
	}
	return CodelyFallbackModels()
}
