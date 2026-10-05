package proxy

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/util"
)

type Handler struct {
	// Registry-side capabilities (split from the former single reg ModelResolver
	// field). reg is retained as the full ModelResolver solely so existing test
	// helpers can read key runtime state via h.reg.GetKeyState; all non-test
	// call sites go through the narrow fields below.
	reg        ModelResolver
	quickSlots QuickSlotResolver
	providers  ProviderResolver
	keyState   KeyStateAccessor
	aliases    AliasResolver
	comboList  ComboLister
	// Selector-side capabilities (split from the former single selector
	// KeyProvider field).
	keySel                KeySelector
	nim                   NIMProvider
	cooldown              CooldownManager
	quotaLock             QuotaLocker
	rotSet                RotationSettings
	comboRes              ComboResolver // 原 *combo.Resolver：combo 解析
	usage                 UsageRecorder // 原 *usage.RingBuffer：Recent Requests usage 记录（不含 playground 来源）
	pgUsage               UsageRecorder // Playground 来源请求专用 ring（始终捕获详情）
	quotaTracker          QuotaTracker  // 原 *usage.QuotaTracker：quota 展示
	logger                Logger        // 原 *console.Logger：日志输出
	client                *http.Client  // 非流式：300s 超时
	streamClient          *http.Client  // 流式：无超时，由 r.Context() 控制
	proxyClient           *http.Client  // 经配置代理转发（非流式，300s 超时）
	proxyStream           *http.Client  // 经配置代理转发（流式，无超时）
	mgmtClient            *http.Client  // 管理类探测（模型导入/连通性/探测），直连，15s 超时
	mgmtProxyClient       *http.Client  // 同上，但经配置代理转发
	proxyURL              atomic.Value  // 当前代理 *url.URL，nil 表示不走代理
	UsageUpdates          *Broadcaster
	InflightUpdates       *Broadcaster
	RequestUpdates        *Broadcaster
	Inflight              *InflightTracker
	EntryTracker          *EntryTracker
	hardLimit             *HardLimiter
	sigCache              SignatureCacheProvider
	debugModeProvider     func() bool
	quickSlotOnlyProvider func() bool
	logRequestsProvider   func() bool
	requestLogDir         atomic.Value // string; settable at runtime via SetRequestLogDir
	// upstreamTimeoutSec holds the current non-streaming upstream timeout in
	// seconds. It is atomic because SetUpstreamTimeout (settings PATCH) can
	// run concurrently with in-flight requests; the pre-built clients' Timeout
	// fields are immutable after construction (see clientFor).
	upstreamTimeoutSec atomic.Int64
	// maxPassThroughBody caps a non-streaming upstream response buffered for
	// pass-through. Zero means the default (maxPassThroughBodyBytes); tests
	// shrink it to verify the controlled over-budget error without a huge
	// allocation.
	maxPassThroughBody int64
	// augmenter is the optional RequestAugmenter injected by the app layer.
	// When non-nil it rewrites outbound requests for providers marked
	// APIType=="jethub" just before they are sent (see forwardUpstream).
	augmenter RequestAugmenter
	// keyProxyMu guards keyProxyClients (per-key egress proxy clients, built on
	// first use — see keyProxyClientsFor).
	keyProxyMu      sync.Mutex
	keyProxyClients map[string]*keyProxyClientSet
}

// New constructs a proxy Handler from capability interfaces rather than concrete
// types. The caller (composition root) supplies implementations — typically
// *registry.Registry, *rotation.Selector, *combo.Resolver, *usage.RingBuffer,
// *usage.QuotaTracker and *console.Logger, all of which satisfy these interfaces
// structurally.
func New(reg ModelResolver, selector KeyProvider, comboRes ComboResolver, usageBuf UsageRecorder, quotaTracker QuotaTracker, logger Logger, upstreamTimeoutSec int) *Handler {
	if upstreamTimeoutSec <= 0 {
		upstreamTimeoutSec = 300
	}
	upstreamTimeout := time.Duration(upstreamTimeoutSec) * time.Second
	h := &Handler{
		reg:             reg,
		quickSlots:      reg,
		providers:       reg,
		keyState:        reg,
		aliases:         reg,
		comboList:       reg,
		keySel:          selector,
		nim:             selector,
		cooldown:        selector,
		quotaLock:       selector,
		rotSet:          selector,
		comboRes:        comboRes,
		usage:           usageBuf,
		quotaTracker:    quotaTracker,
		logger:          logger,
		UsageUpdates:    NewBroadcaster(32),
		InflightUpdates: NewBroadcaster(32),
		RequestUpdates:  NewBroadcaster(256),
		Inflight:        NewInflightTracker(),
		EntryTracker:    NewEntryTracker(),
		hardLimit:       NewHardLimiter(),
		sigCache:        NewSignatureCache(),
	}
	h.upstreamTimeoutSec.Store(int64(upstreamTimeoutSec))
	h.proxyURL.Store((*url.URL)(nil))
	// F-03：代理主干用专属 Transport，不再共享/回退 http.DefaultTransport。
	// directTransport.Proxy=nil —— UseProxy=false 的"直连"是真直连，不响应
	// 进程继承的 HTTP(S)_PROXY 环境变量；proxyTransport 只认设置里的显式代理。
	directTransport := newUpstreamTransport(nil)
	proxyTransport := newUpstreamTransport(func(*http.Request) (*url.URL, error) {
		u, _ := h.proxyURL.Load().(*url.URL)
		return u, nil
	})
	h.client = &http.Client{Transport: directTransport, Timeout: upstreamTimeout}
	// 流式请求由 r.Context() 控制连接生命周期（1.5 已传播 context），
	// 不设 Timeout 以避免 300s 后强制中断长 SSE 流（P3.13）。
	h.streamClient = &http.Client{Transport: directTransport}
	h.proxyClient = &http.Client{Transport: proxyTransport, Timeout: upstreamTimeout}
	h.proxyStream = &http.Client{Transport: proxyTransport}
	h.mgmtClient = &http.Client{Transport: directTransport, Timeout: 15 * time.Second}
	h.mgmtProxyClient = &http.Client{Transport: proxyTransport, Timeout: 15 * time.Second}
	return h
}

// 主干上游连接池调参（F-03）：默认值 2 的 MaxIdleConnsPerHost 在同一上游并发
// >2（Playground 群聊/图片批量/Assistant 回环叠加）时让多余连接用完即关、下次
// 重新 TCP+TLS 握手，直接抬高 TTFT。
const (
	upstreamMaxIdleConns        = 256
	upstreamMaxIdleConnsPerHost = 32
)

// newUpstreamTransport builds a dedicated Transport for the proxy main line by
// cloning http.DefaultTransport (inheriting its dial/TLS-handshake/idle timeouts
// and HTTP/2 support) and overriding the proxy policy and idle-pool sizing.
// proxy == nil means truly direct: environment HTTP(S)_PROXY variables are NOT
// honored. Unlike the former zero-value proxyTransport, the result always has a
// dial timeout (30s), TLS handshake timeout (10s) and idle-conn timeout (90s).
func newUpstreamTransport(proxy func(*http.Request) (*url.URL, error)) *http.Transport {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = proxy
	tr.MaxIdleConns = upstreamMaxIdleConns
	tr.MaxIdleConnsPerHost = upstreamMaxIdleConnsPerHost
	return tr
}

// ManagementClient returns the HTTP client for management probes (model import,
// connectivity check, model test) for provider p. It routes through the configured
// upstream proxy when p.UseProxy is enabled.
func (h *Handler) ManagementClient(p config.Provider) *http.Client {
	if p.UseProxy {
		if pu, _ := h.proxyURL.Load().(*url.URL); pu != nil {
			return h.mgmtProxyClient
		}
	}
	return h.mgmtClient
}

// SetProxy updates the upstream proxy URL used by providers with UseProxy enabled.
// Call with enabled=false or empty host/port to disable proxying.
//
// The host may be supplied with or without an http:// or https:// scheme prefix;
// only the hostname is used and the proxy URL is always built as http://host:port.
// The port must be a numeric value in the range [1,65535]. An error is returned
// when proxying is enabled but the address is invalid, so callers can surface it
// instead of silently disabling proxying.
func (h *Handler) SetProxy(enabled bool, host, port string) error {
	host = strings.TrimSpace(host)
	port = strings.TrimSpace(port)
	if !enabled || host == "" || port == "" {
		h.proxyURL.Store((*url.URL)(nil))
		return nil
	}

	// Normalize scheme prefixes (case-insensitive) so users can paste URLs like
	// "http://127.0.0.1" or "https://host" without breaking the proxy URL.
	host = strings.ToLower(host)
	host = strings.TrimPrefix(host, "http://")
	host = strings.TrimPrefix(host, "https://")
	host = strings.TrimSpace(host)

	// If the user pasted a combined host:port into the host field, extract the
	// port when the dedicated port field is empty.
	if idx := strings.LastIndex(host, ":"); idx > 0 {
		candidate := host[idx+1:]
		if _, err := strconv.Atoi(candidate); err == nil {
			if port == "" || port == candidate {
				port = candidate
				host = host[:idx]
			}
		}
	}

	portNum, err := strconv.Atoi(port)
	if err != nil || portNum < 1 || portNum > 65535 {
		h.proxyURL.Store((*url.URL)(nil))
		return fmt.Errorf("invalid proxy port %q", port)
	}

	u, err := url.Parse(fmt.Sprintf("http://%s:%d", host, portNum))
	if err != nil {
		h.proxyURL.Store((*url.URL)(nil))
		return fmt.Errorf("invalid proxy address: %v", err)
	}
	h.proxyURL.Store(u)
	return nil
}

// keyProxyClientSet is the cached client pair for one per-key egress proxy.
type keyProxyClientSet struct {
	plain  *http.Client // non-streaming（Timeout 由 clientFor 按当前设置套用）
	stream *http.Client // streaming（无 Timeout，连接生命周期跟随请求 context）
}

// keyProxyClientsFor returns (and lazily builds) the client pair for a key's
// own egress proxy. ok=false means the raw value is unusable ⇒ 调用方按「没有
// per-key 代理」处理（回落 provider 级开关 → 直连）。
//
// ⚠️ 只有**显式设置过** per-key 代理的 key 才会走到这里；绝大多数请求
// （`sel.Key.Proxy == ""`）连一次 map 查找都不做 —— 这是本次改动的安全边界：
// 默认路径与加这个能力之前逐字节相同。
//
// ⚠️ 非法值**不报错、只忽略**：代理串是用户手输的（Free Hub 的输入框），一个拼错
// 的地址不该让整个 key 变成不可用 —— 回落直连至少还能用，且面板上的「额度按出口
// IP 计」提示会让用户发现没生效。解析失败时不缓存（下次仍会重试解析）。
func (h *Handler) keyProxyClientsFor(raw string) (*keyProxyClientSet, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, false
	}
	h.keyProxyMu.Lock()
	defer h.keyProxyMu.Unlock()
	if set, ok := h.keyProxyClients[raw]; ok {
		return set, true
	}
	pu, err := url.Parse(raw)
	if err != nil || pu.Host == "" || (pu.Scheme != "http" && pu.Scheme != "https") {
		return nil, false
	}
	// 每个代理串一份独立 Transport：连接池按出口隔离（复用 provider 级的直连
	// transport 会把两种出口的连接混在同一个池里，等于没换出口）。
	tr := newUpstreamTransport(func(*http.Request) (*url.URL, error) { return pu, nil })
	set := &keyProxyClientSet{
		plain:  &http.Client{Transport: tr, Timeout: time.Duration(h.upstreamTimeoutSec.Load()) * time.Second},
		stream: &http.Client{Transport: tr},
	}
	if h.keyProxyClients == nil {
		h.keyProxyClients = map[string]*keyProxyClientSet{}
	}
	h.keyProxyClients[raw] = set
	return set, true
}

// clientFor returns the non-streaming upstream client honoring the current
// atomic upstream timeout. The base clients' Timeout fields are never mutated
// after construction — http.Client.Do reads Timeout, so writing it from a
// settings update while requests are in flight is a data race. When the
// current timeout differs from the base client's, a shallow clone (same
// Transport, current Timeout) is returned instead.
func (h *Handler) clientFor(base *http.Client) *http.Client {
	want := time.Duration(h.upstreamTimeoutSec.Load()) * time.Second
	if base.Timeout == want {
		return base
	}
	c := *base
	c.Timeout = want
	return &c
}

// SetUpstreamTimeout updates the timeout on the non-streaming upstream HTTP
// clients. Streaming clients remain unbounded. Safe to call at any time:
// the value is stored atomically and applied per request by clientFor, so a
// settings change never races with http.Client.Do.
func (h *Handler) SetUpstreamTimeout(sec int) {
	if sec <= 0 {
		sec = 300
	}
	h.upstreamTimeoutSec.Store(int64(sec))
}

func (h *Handler) ChatCompletions(w http.ResponseWriter, r *http.Request) {
	h.handleProxy(w, r, "/v1/chat/completions", combo.EntryFormatOpenAI)
}

func (h *Handler) Completions(w http.ResponseWriter, r *http.Request) {
	h.handleProxy(w, r, "/v1/completions", combo.EntryFormatOpenAI)
}

func (h *Handler) ImagesGenerations(w http.ResponseWriter, r *http.Request) {
	h.handleProxy(w, r, "/v1/images/generations", combo.EntryFormatOpenAI)
}

// ImagesEdits handles image-edit requests through the same provider/key/retry
// pipeline as image generations. The request body remains protocol-native.
func (h *Handler) ImagesEdits(w http.ResponseWriter, r *http.Request) {
	h.handleProxy(w, r, "/v1/images/edits", combo.EntryFormatOpenAI)
}

func (h *Handler) Embeddings(w http.ResponseWriter, r *http.Request) {
	h.handleProxy(w, r, "/v1/embeddings", combo.EntryFormatOpenAI)
}

func (h *Handler) PollTask(w http.ResponseWriter, r *http.Request) {
	h.handleProxy(w, r, r.URL.Path, combo.EntryFormatOpenAI)
}

// Messages handles Anthropic-format requests at the /v1/messages entry.
// It transparently proxies to an apiType=anthropic upstream provider, switching
// the auth header (x-api-key + anthropic-version) and upstream URL construction
// accordingly. No OpenAI<->Anthropic format translation is performed.
func (h *Handler) Messages(w http.ResponseWriter, r *http.Request) {
	h.handleProxy(w, r, "/v1/messages", combo.EntryFormatAnthropic)
}

// Responses handles OpenAI Responses API requests at the /v1/responses entry.
// It is transparently proxied to the upstream (BaseURL + /v1/responses) using the
// standard Authorization: Bearer header — no x-api-key is used. The request body
// is forwarded unchanged; no OpenAI Chat <-> Responses format translation is
// performed.
func (h *Handler) Responses(w http.ResponseWriter, r *http.Request) {
	h.handleProxy(w, r, "/v1/responses", combo.EntryFormatOpenAIResponses)
}

// GenerateContent handles Google native generateContent requests at the /v1/generateContent entry.
// It transparently proxies to the upstream Google endpoint ({baseURL}/v1beta/models/{model}:generateContent)
// using the x-goog-api-key header and model-in-path URL. The model field in the request body is stripped.
func (h *Handler) GenerateContent(w http.ResponseWriter, r *http.Request) {
	h.handleProxy(w, r, "/v1/generateContent", combo.EntryFormatGoogle)
}

func (h *Handler) TaskGet(w http.ResponseWriter, r *http.Request, taskID, modelStr string) {
	providerID, upstreamModel := util.SplitModel(modelStr)
	if providerID == "" {
		writeError(w, http.StatusBadRequest, "invalid model format: "+modelStr)
		return
	}
	provider, ok := h.providers.GetProviderByPrefix(providerID)
	if !ok {
		writeError(w, http.StatusBadRequest, "unknown provider prefix: "+providerID)
		return
	}
	sel, err := h.keySel.SelectKey(provider.ID, upstreamModel, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, "no available keys")
		return
	}
	path := "/v1/tasks/" + taskID
	resp, err := h.forwardGetUpstream(r.Context(), sel, path, r.Header)
	if err != nil {
		writeError(w, http.StatusBadGateway, "upstream request failed")
		return
	}
	defer resp.Body.Close()
	for key, vals := range resp.Header {
		for _, v := range vals {
			w.Header().Add(key, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// ImageTask supports async image-task polling (e.g. ModelScope) for callers
// that only know the task id and model string. The request URL is
// /v1/tasks/{taskID}?model={provider/model}; the handler parses both and
// delegates to TaskGet, which resolves the provider, selects a key, and
// forwards the GET upstream with the request headers (so X-Modelscope-Task-Type
// is transparently passed through). This satisfies imagebatch.ImageTaskCaller.
func (h *Handler) ImageTask(w http.ResponseWriter, r *http.Request) {
	taskID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/tasks/"), "/")
	if taskID == "" || strings.ContainsAny(taskID, "/\\?#") {
		writeError(w, http.StatusBadRequest, "invalid task id")
		return
	}
	h.TaskGet(w, r, taskID, r.URL.Query().Get("model"))
}

func (h *Handler) SetDebugModeProvider(fn func() bool) {
	h.debugModeProvider = fn
}

func (h *Handler) debugMode() bool {
	if h.debugModeProvider != nil {
		return h.debugModeProvider()
	}
	return false
}

func (h *Handler) SetQuickSlotOnlyProvider(fn func() bool) {
	h.quickSlotOnlyProvider = fn
}

func (h *Handler) quickSlotOnly() bool {
	if h.quickSlotOnlyProvider != nil {
		return h.quickSlotOnlyProvider()
	}
	return false
}

func (h *Handler) SetLogRequestsProvider(fn func() bool) {
	h.logRequestsProvider = fn
}

func (h *Handler) logRequests() bool {
	if h.logRequestsProvider != nil {
		return h.logRequestsProvider()
	}
	return false
}

func (h *Handler) SetRequestLogDir(dir string) {
	h.requestLogDir.Store(dir)
}

// TracesDir returns the directory where two-tier JSONL trace files are
// written, or "" if tracing is not configured. Read-only access for the
// trace reader API. Safe for concurrent use; the value may be repointed
// at runtime via SetRequestLogDir from the settings API.
func (h *Handler) TracesDir() string {
	v := h.requestLogDir.Load()
	if v == nil {
		return ""
	}
	return v.(string)
}

// SetPgUsage 注入 Playground 来源请求专用的 usage ring。注入后，source ==
// "playground" 的请求将写入该 ring 而非 Recent Requests 的 ring，实现两个
// 列表物理隔离。未注入时 playground 请求回落到 h.usage。
func (h *Handler) SetPgUsage(r UsageRecorder) {
	h.pgUsage = r
}

// SetRequestAugmenter injects the optional RequestAugmenter used by bridged
// providers (APIType=="jethub"). Follows the SetLLMClassifier setter-injection
// pattern: the proxy holds the narrow interface only, never the owner package.
func (h *Handler) SetRequestAugmenter(a RequestAugmenter) {
	h.augmenter = a
}

// SweepStaleEntries removes orphan in-flight processing entries older than maxAge,
// decrements their in-flight counters, records a timeout usage entry, and broadcasts
// request-done.
func (h *Handler) SweepStaleEntries(maxAge time.Duration) int {
	if h.EntryTracker == nil {
		return 0
	}
	stale := h.EntryTracker.SweepStale(maxAge)
	for _, e := range stale {
		if e.KeyID != "" && h.keyState != nil && h.providers != nil {
			for _, p := range h.providers.ListProviders() {
				if ks := h.keyState.GetKeyState(p.ID, e.KeyID); ks != nil {
					ks.DecInFlight()
					break
				}
			}
		}
		e.Status = "error"
		e.Error = "timeout"
		e.LatencyMs = time.Since(e.Timestamp).Milliseconds()
		if e.Source == "playground" && h.pgUsage != nil {
			h.pgUsage.Add(e)
		} else if h.usage != nil {
			h.usage.Add(e)
		}
		raw := MarshalEntryJSONLight(e)
		if raw != nil {
			h.RequestUpdates.Broadcast(RequestEvent{
				Type:   "request-done",
				ID:     e.ID,
				Status: "error",
				Entry:  raw,
			})
		}
		h.UsageUpdates.Signal()
	}
	if len(stale) > 0 {
		h.InflightUpdates.Signal()
	}
	return len(stale)
}

// StartEntryTrackerSweeper runs a periodic background sweeper that cleans stale
// in-flight entries until ctx is cancelled.
func (h *Handler) StartEntryTrackerSweeper(ctx context.Context, interval, maxAge time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	if maxAge <= 0 {
		maxAge = 5 * time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.SweepStaleEntries(maxAge)
		}
	}
}
