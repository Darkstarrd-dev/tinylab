// Package monitor provides HTTP handlers for the monitor management API
// (usage ring, quotas, model-keys, reset-quota).
package monitor

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
	internalusage "github.com/tinyrouter/tinyrouter/internal/usage"
)

// Handler exposes the monitor API endpoints.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers monitor routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/monitor", h.getUsage)
	r.Get("/monitor/playground", h.getPlaygroundUsage)
	r.Get("/monitor/summary", h.getUsageSummary)
	r.Get("/monitor/quotas", h.getQuotas)
	r.Get("/monitor/model-keys", h.getModelKeys)
	r.Delete("/monitor", h.clearUsage)
	r.Post("/monitor/reset-quota", h.resetQuota)
}

// getIntQuery reads an integer query parameter with a default fallback.
func getIntQuery(r *http.Request, key string, defaultVal int) int {
	valStr := r.URL.Query().Get(key)
	if valStr == "" {
		return defaultVal
	}
	val, err := strconv.Atoi(valStr)
	if err != nil || val < 0 {
		return defaultVal
	}
	return val
}

// --- Usage ---

func (h *Handler) getUsage(w http.ResponseWriter, r *http.Request) {
	limit := getIntQuery(r, "limit", 500)
	offset := getIntQuery(r, "offset", 0)

	// 兜底清理：将超过 10 分钟仍未完成的 processing 条目标记为 error
	if h.d.ProxyHandler != nil && h.d.ProxyHandler.EntryTracker != nil {
		staleEntries := h.d.ProxyHandler.EntryTracker.SweepStale(10 * time.Minute)
		for _, e := range staleEntries {
			e.Status = "error"
			e.Error = "timeout"
			e.LatencyMs = time.Since(e.Timestamp).Milliseconds()
			h.d.Usage.Add(e)
			raw := proxy.MarshalEntryJSON(e)
			if raw != nil {
				h.d.ProxyHandler.RequestUpdates.Broadcast(proxy.RequestEvent{
					Type:   "request-done",
					ID:     e.ID,
					Status: "error",
					Entry:  raw,
				})
			}
			h.d.ProxyHandler.UsageUpdates.Signal()
		}
	}

	ringEntries := h.d.Usage.All()

	// Merge inflight (processing) entries from the entry tracker so the REST
	// response shows both completed and currently processing requests in a
	// single time-sorted list. The frontend uses each entry's ID for dedup.
	// 排除 playground 来源：那些归 /usage/playground，避免串入 Recent Requests。
	var inflightEntries []internalusage.Entry
	if h.d.ProxyHandler != nil && h.d.ProxyHandler.EntryTracker != nil {
		for _, e := range h.d.ProxyHandler.EntryTracker.All() {
			if e.Source != "playground" {
				inflightEntries = append(inflightEntries, e)
			}
		}
	}

	total := len(ringEntries) + len(inflightEntries)
	if offset >= total {
		offset = 0
	}
	end := offset + limit
	if end > total {
		end = total
	}

	combined := make([]internalusage.Entry, 0, total)
	combined = append(combined, ringEntries...)
	combined = append(combined, inflightEntries...)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{
		"total":   total,
		"entries": combined[offset:end],
	})
}

// getPlaygroundUsage 返回 Playground 来源的请求列表（独立 ring + playground
// 来源的在途条目），供 Playground 页面左侧列表消费。与 /api/monitor 物理隔离。
func (h *Handler) getPlaygroundUsage(w http.ResponseWriter, r *http.Request) {
	limit := getIntQuery(r, "limit", 50)
	offset := getIntQuery(r, "offset", 0)

	var ringEntries []internalusage.Entry
	if h.d.PgUsage != nil {
		ringEntries = h.d.PgUsage.All()
	}

	var inflightEntries []internalusage.Entry
	if h.d.ProxyHandler != nil && h.d.ProxyHandler.EntryTracker != nil {
		for _, e := range h.d.ProxyHandler.EntryTracker.All() {
			if e.Source == "playground" {
				inflightEntries = append(inflightEntries, e)
			}
		}
	}

	total := len(ringEntries) + len(inflightEntries)
	if offset >= total {
		offset = 0
	}
	end := offset + limit
	if end > total {
		end = total
	}

	combined := make([]internalusage.Entry, 0, total)
	combined = append(combined, ringEntries...)
	combined = append(combined, inflightEntries...)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{
		"total":   total,
		"entries": combined[offset:end],
	})
}

func (h *Handler) getUsageSummary(w http.ResponseWriter, r *http.Request) {
	summary := h.d.Usage.Summary()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(summary)
}

// clearUsage wipes the in-memory usage ring. Kept alongside the other usage
// endpoints rather than in a separate file because it shares the usage domain.
func (h *Handler) clearUsage(w http.ResponseWriter, r *http.Request) {
	h.d.Usage.Clear()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// --- Quota ---

func (h *Handler) getQuotas(w http.ResponseWriter, r *http.Request) {
	bars := h.d.QuotaTracker.All()
	modelStats := h.d.Usage.ModelStats()

	// Build a map of quota bars by "provider/model"
	barMap := make(map[string]int)
	for i := range bars {
		bars[i].HasQuota = true
		barMap[bars[i].Provider+"/"+bars[i].Model] = i
	}

	// Merge usage stats into quota bars; add non-quota models
	for _, ms := range modelStats {
		key := ms.Provider + "/" + ms.Model
		if idx, ok := barMap[key]; ok {
			bars[idx].SuccessCount = ms.SuccessCount
			bars[idx].ErrorCount = ms.ErrorCount
			bars[idx].InputTokens = ms.InputTokens
			bars[idx].OutputTokens = ms.OutputTokens
		} else {
			newBar := internalusage.QuotaBar{
				Provider:     ms.Provider,
				Model:        ms.Model,
				HasQuota:     false,
				SuccessCount: ms.SuccessCount,
				ErrorCount:   ms.ErrorCount,
				InputTokens:  ms.InputTokens,
				OutputTokens: ms.OutputTokens,
			}
			bars = append(bars, newBar)
			barMap[key] = len(bars) - 1
		}
	}

	// Fill currentKeyName for each bar (the key the effective rotation strategy
	// would pick next), so the UI can show "in-use" next to the quota progress
	// without requiring an expand.
	for i := range bars {
		// Resolve model alias for display
		bars[i].Alias = h.d.Reg.ResolveModelAliasByID(bars[i].Provider, bars[i].Model)

		ck := h.currentKey(bars[i].Provider, bars[i].Model)
		bars[i].CurrentKeyName = ck.Name
		bars[i].CurrentKeyID = ck.ID

		// Collect key names+IDs that have in-flight requests for this provider/model.
		names := make([]string, 0)
		ids := make([]string, 0)
		for _, p := range h.d.Reg.ListProviders() {
			if p.Name != bars[i].Provider {
				continue
			}
			for _, k := range p.Keys {
				if !k.IsActive {
					continue
				}
				state := h.d.Reg.GetKeyState(p.ID, k.ID)
				if state != nil && state.GetInFlight() > 0 {
					names = append(names, k.Name)
					ids = append(ids, k.ID)
				}
			}
			break
		}
		bars[i].InFlightKeyNames = names
		bars[i].InFlightKeyIDs = ids
	}

	// Recompute TotalUsed/TotalCapacity from per-key runtime states so that
	// exhausted keys (persisted via ExhaustedModelLimits and restored with
	// ModelRemaining==0) are counted even after a restart when QuotaTracker is
	// empty. This overwrites QuotaTracker's in-session aggregates with the
	// authoritative key-state view.
	for i := range bars {
		totalCapacity := 0
		totalUsed := 0
		for _, p := range h.d.Reg.ListProviders() {
			if p.Name != bars[i].Provider && p.ID != bars[i].Provider {
				continue
			}
			for _, k := range p.Keys {
				if !k.IsActive {
					continue
				}
				st := h.d.Reg.GetKeyState(p.ID, k.ID)
				if st == nil {
					continue
				}
				q := st.GetQuota(bars[i].Model)
				if q != nil && q.ModelLimit > 0 {
					totalCapacity += q.ModelLimit
					totalUsed += q.ModelLimit - q.ModelRemaining
				}
			}
			break
		}
		if totalCapacity > 0 {
			bars[i].TotalCapacity = totalCapacity
			bars[i].TotalUsed = totalUsed
			bars[i].HasQuota = true
		}
	}

	// Sort by provider + model for stable ordering
	sort.Slice(bars, func(i, j int) bool {
		ki := bars[i].Provider + "/" + bars[i].Model
		kj := bars[j].Provider + "/" + bars[j].Model
		return ki < kj
	})

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{
		"quotas": bars,
	})
}

// currentKey holds the ID+Name of the key selected by the rotation strategy.
type currentKey struct {
	ID   string
	Name string
}

// currentKey returns the ID and Name of the key that the provider's effective
// rotation strategy would pick right now for the given model. Mirrors the
// ordering logic of getModelKeys so the value shown on the unexpanded quota
// bar matches the top row after expand. Returns zero value when no usable key exists.
func (h *Handler) currentKey(providerName, model string) currentKey {
	var provider *config.Provider
	for _, p := range h.d.Reg.ListProviders() {
		if p.Name == providerName || p.ID == providerName {
			pp := p
			provider = &pp
			break
		}
	}
	if provider == nil {
		return currentKey{}
	}
	strategy := provider.RotationStrategy
	if strategy == "" {
		strategy = h.d.Selector.Settings().Strategy
	}
	type sk struct {
		id        string
		name      string
		usable    bool
		priority  int
		configIdx int
		rotatedAt time.Time
		lastUsed  time.Time
	}
	cands := make([]sk, 0, len(provider.Keys))
	for idx, k := range provider.Keys {
		entry := sk{id: k.ID, name: k.Name, priority: k.Priority, configIdx: idx}
		state := h.d.Reg.GetKeyState(provider.ID, k.ID)
		if state != nil {
			func() {
				state.Lock()
				defer state.Unlock()
				entry.usable = k.IsActive
				if unlock, ok := state.ModelLocks[model]; ok && time.Now().Before(unlock) {
					entry.usable = false
				}
				entry.rotatedAt = state.RotatedAt
				entry.lastUsed = state.LastUsedAt
			}()
		} else {
			entry.usable = k.IsActive
		}
		if entry.usable {
			cands = append(cands, entry)
		}
	}
	if len(cands) == 0 {
		return currentKey{}
	}
	sort.SliceStable(cands, func(i, j int) bool {
		switch strategy {
		case "round-robin":
			if !cands[i].lastUsed.Equal(cands[j].lastUsed) {
				return cands[i].lastUsed.After(cands[j].lastUsed)
			}
		case "failover":
			if !cands[i].rotatedAt.Equal(cands[j].rotatedAt) {
				return cands[i].rotatedAt.Before(cands[j].rotatedAt)
			}
		}
		if cands[i].priority != cands[j].priority {
			return cands[i].priority < cands[j].priority
		}
		return cands[i].configIdx < cands[j].configIdx
	})
	return currentKey{ID: cands[0].id, Name: cands[0].name}
}

// --- Model-Key detail / ordering ---

func (h *Handler) getModelKeys(w http.ResponseWriter, r *http.Request) {
	providerName := r.URL.Query().Get("provider")
	model := r.URL.Query().Get("model")
	if providerName == "" || model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "provider and model are required")
		return
	}

	var provider *config.Provider
	for _, p := range h.d.Reg.ListProviders() {
		if p.Name == providerName || p.ID == providerName {
			pp := p
			provider = &pp
			break
		}
	}
	if provider == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "provider not found")
		return
	}

	type keyDetail struct {
		KeyID        string  `json:"keyId"`
		KeyName      string  `json:"keyName"`
		IsActive     bool    `json:"isActive"`
		Status       string  `json:"status"`
		HasQuota     bool    `json:"hasQuota"`
		ModelLimit   int     `json:"modelLimit"`
		ModelRemain  int     `json:"modelRemaining"`
		ModelLock    *string `json:"modelLock"`
		LastError    string  `json:"lastError"`
		LastUsedAt   string  `json:"lastUsedAt"`
		RotatedAt    string  `json:"rotatedAt"`
		Priority     int     `json:"priority"`
		ConfigIdx    int     `json:"configIdx"`
		SuccessCount int     `json:"successCount"`
		ErrorCount   int     `json:"errorCount"`
		AvgTTFTMs    int64   `json:"avgTtftMs"`
		AvgSpeed     float64 `json:"avgSpeed"`
		InFlight     int     `json:"inFlight"`
		LiveSpeed    float64 `json:"liveSpeed"`
	}

	hasQuota := false
	details := make([]keyDetail, 0, len(provider.Keys))

	// Fetch per-key usage stats
	keyStatEntries := h.d.Usage.Accumulator().KeyStatsFor(provider.Name, model)
	keyStatByID := make(map[string]internalusage.KeyStatEntry, len(keyStatEntries))
	for _, kse := range keyStatEntries {
		keyStatByID[kse.KeyID] = kse
	}

	// Fetch live speeds from inflight tracker
	liveSpeeds := make(map[string]float64)
	if h.d.ProxyHandler != nil && h.d.ProxyHandler.Inflight != nil {
		liveSpeeds = h.d.ProxyHandler.Inflight.LiveSpeedForKeys()
	}

	for idx, k := range provider.Keys {
		kd := keyDetail{
			KeyID:     k.ID,
			KeyName:   k.Name,
			IsActive:  k.IsActive,
			Status:    "active",
			Priority:  k.Priority,
			ConfigIdx: idx,
		}
		state := h.d.Reg.GetKeyState(provider.ID, k.ID)
		if state != nil {
			func() {
				state.Lock()
				defer state.Unlock()
				kd.InFlight = state.InFlight
				if unlock, ok := state.ModelLocks[model]; ok {
					if time.Now().Before(unlock) {
						s := unlock.Format("2006-01-02T15:04:05Z07:00")
						kd.ModelLock = &s
						kd.Status = state.ModelStatus[model]
						if kd.Status == "" {
							kd.Status = "cooldown"
						}
					}
				}
				if kd.Status == "" {
					kd.Status = "active"
				}
				kd.LastError = state.ModelErrors[model]
				if !state.LastUsedAt.IsZero() {
					kd.LastUsedAt = state.LastUsedAt.Format("2006-01-02T15:04:05Z07:00")
				}
				if !state.RotatedAt.IsZero() {
					kd.RotatedAt = state.RotatedAt.Format("2006-01-02T15:04:05Z07:00")
				}
				if q := state.ModelQuotas[model]; q != nil {
					kd.HasQuota = true
					kd.ModelLimit = q.ModelLimit
					kd.ModelRemain = q.ModelRemaining
					hasQuota = true
				}
			}()
		}
		if kse, ok := keyStatByID[k.ID]; ok {
			kd.SuccessCount = kse.SuccessCount
			kd.ErrorCount = kse.ErrorCount
			kd.AvgTTFTMs = kse.AvgTTFTMs
			kd.AvgSpeed = kse.AvgSpeed
		}
		if liveSpeed, ok := liveSpeeds[provider.ID+"/"+k.ID]; ok {
			kd.LiveSpeed = liveSpeed
		}
		details = append(details, kd)
	}

	// Sort details by the provider's effective rotation strategy so the "currently
	// in-use" key lands at the top. Unavailable keys (inactive / cooldown / locked
	// for this model) always sink to the bottom.
	strategy := provider.RotationStrategy
	if strategy == "" {
		strategy = h.d.Selector.Settings().Strategy
	}

	type sortKey struct {
		usable    bool
		t1        time.Time // primary compare, interpretation depends on strategy
		priority  int
		configIdx int
		lastUsed  time.Time
		idx       int // position in details, for stable reassembly
	}
	keys := make([]sortKey, len(details))
	for i, d := range details {
		var lu, rot time.Time
		if d.LastUsedAt != "" {
			var parseErr error
			lu, parseErr = time.Parse(time.RFC3339, d.LastUsedAt)
			if parseErr != nil {
				h.d.Logger.Debug("parse LastUsedAt failed for %s: %v", d.KeyID, parseErr)
			}
		}
		if d.RotatedAt != "" {
			rot, _ = time.Parse(time.RFC3339, d.RotatedAt)
		}
		usable := d.IsActive && d.ModelLock == nil
		keys[i] = sortKey{
			usable:    usable,
			t1:        rot, // failover: RotatedAt asc; never-rotated = zero = front
			priority:  d.Priority,
			configIdx: d.ConfigIdx,
			lastUsed:  lu,
			idx:       i,
		}
	}

	sort.SliceStable(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.usable != b.usable {
			return a.usable
		}
		switch strategy {
		case "round-robin":
			// Most-recently-used usable key first; never-used sinks to bottom.
			if !a.lastUsed.Equal(b.lastUsed) {
				return a.lastUsed.After(b.lastUsed)
			}
			return a.configIdx < b.configIdx
		case "failover":
			// Never-rotated (zero RotatedAt) first, then RotatedAt asc.
			if !a.t1.Equal(b.t1) {
				return a.t1.Before(b.t1)
			}
			if a.priority != b.priority {
				return a.priority < b.priority
			}
			return a.configIdx < b.configIdx
		default: // fill-first
			if a.priority != b.priority {
				return a.priority < b.priority
			}
			return a.configIdx < b.configIdx
		}
	})

	sorted := make([]keyDetail, len(details))
	for i, k := range keys {
		sorted[i] = details[k.idx]
	}

	// Identify the in-use key (top usable entry) so the frontend can badge it.
	inUseKeyName := ""
	inUseKeyID := ""
	for _, d := range sorted {
		if d.IsActive && d.ModelLock == nil {
			inUseKeyName = d.KeyName
			inUseKeyID = d.KeyID
			break
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{
		"provider":         providerName,
		"model":            model,
		"hasQuota":         hasQuota,
		"keys":             sorted,
		"inUseKeyName":     inUseKeyName,
		"inUseKeyID":       inUseKeyID,
		"rotationStrategy": strategy,
	})
}

// --- Reset Quota ---

func (h *Handler) resetQuota(w http.ResponseWriter, r *http.Request) {
	h.d.Reg.ResetAllCooldowns()
	if h.d.StateSaveFn != nil {
		h.d.StateSaveFn()
	}
	if h.d.Logger != nil {
		h.d.Logger.Info("all cooldowns and quota locks reset via API")
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}