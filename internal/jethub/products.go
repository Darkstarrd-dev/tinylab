package jethub

import (
	"context"
	"net/http"
	"strings"
)

// CHAT_API_BASE is the CodeArts inference endpoint (P2 uses the same base for
// its product registration; the value lives here so P1 can already register
// the product table for bridge smoke tests).
const codeartsBaseURL = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2"

// codeartsModels is the static model table (P2.5, populated already so the
// P1 bridge verification can register a bridged provider whose models appear
// in /v1/models). Context windows are recorded in Note for the UI.
//
// ⚠️ 2026-10-21（R10，上游 5aca46a）订正：两个目录端点都**不下发**窗口，
// 权威值是 IDE 内核日志的 `inferhub-provider.models[*].limit.context`：
//   - GLM-5.2 由 202752 改为 **1048576**（10-21 起上游改 1M）；
//   - glm-5.3 新增 **1048576**；
//   - glm-5.2-sft-harmony **202752**；
//   - openpangu-2.0-flash/-pro **524288**；
//   - deepseek-v4.1-flash 由 1000000 改为 **1048576**。
//
// ⚠️ 2026-10-30（R11，上游 master `3f0f48c`/`d1386ef` 的 2026-10-27 全表实测校准）：
//   - **新增 `deepseek-v4.1-flash-1017`**（与 `deepseek-v4.1-flash` 是后端两个
//     **独立注册**的模型，`/v1/model/builtin` 同时下发；窗口同为 1048576）；
//   - 新增 `kimi-k3`；
//   - 删除实测 404 的 `GLM-5`（InferHub.002002009）、`glm-5.3-flash`
//     （002002009，仅按 benefit 通道注册）、`deepseek-v4-pro`（ModelArts.81009）；
//   - `GLM-5.1` / `deepseek-v4-flash` 虽不在 builtin 目录里，但实测 200 ⇒ 保留
//     （「不在残缺目录里」≠「不可用」）。
//
// 旧值 202752 会让上下文占用比封顶 100%、自动压缩阈值降到 ~162K（静默后果）。
// ⚠️ 上游还有 4 个 VL 模型（kimi-k2.6-vl / Qwen3-VL-235B）**刻意不列**：上下文小、
// 不支持工具调用，IDE 只把它们用于 analyzeImage 工具；列出来会给出一个不能当
// agent 主模型的条目。
var codeartsModels = ModelTable{
	{ID: "GLM-5.2", QuotaType: "limited", Note: "ctx 1048576"},
	{ID: "GLM-5.1", QuotaType: "limited"},
	{ID: "glm-5.3", QuotaType: "limited", Note: "ctx 1048576"},
	{ID: "glm-5.2-sft-harmony", QuotaType: "limited", Note: "ctx 202752"},
	{ID: "openpangu-2.0-flash", QuotaType: "limited", Note: "ctx 524288"},
	{ID: "openpangu-2.0-pro", QuotaType: "limited", Note: "ctx 524288"},
	{ID: "deepseek-v4-flash", QuotaType: "unlimited", Note: "ctx 1048576"},
	{ID: "deepseek-v4.1-flash", QuotaType: "unlimited", Note: "ctx 1048576; benefit"},
	{ID: "deepseek-v4.1-flash-1017", QuotaType: "limited", Note: "ctx 1048576"},
	{ID: "kimi-k3", QuotaType: "limited"},
}

// RegisterDefaultProducts installs every provider's static product config.
// P3 batches extend this list; unregistered products simply cannot be bridged
// yet (SetPrefix rejects them with "no product registered").
//
// ⚠️ **InferURL 是出站推理端点的唯一真相**（`Product.InferURL` 的注释解释了
// 为什么不能用 BaseURL + 进站路径）：BaseURL 只用于 registry 展示与探针的
// 兜底构造，真实推理一律走 InferURL。每个值都有参考实现的端点依据（逐条注释），
// 并由 `inference_url_test.go` 的 `TestInferenceEndpoints` 锁死。
// qoder/qodercn 不在此列 —— 它们的 URL 由内嵌 WASM 算出（`qoderCustomize`）。
func RegisterDefaultProducts(b *Bridge) {
	b.RegisterProduct(Product{
		Provider:    "codearts",
		DisplayName: "CodeArts Agent (Free Hub)",
		BaseURL:     codeartsBaseURL,
		// ref llm-adapter.ts：`${CHAT_API_BASE}/chat/completions`。
		// ⚠️ 必须显式声明：codearts 的 augmenter 用 `r.URL.String()` 做
		// SDK-HMAC 签名，而代理交给 augmenter 的是**客户端**请求（进站路径
		// `/v1/chat/completions`）—— 声明 InferURL 后 Customize 会把 URL 改写为
		// 上游地址再调 augmenter，签名才算的是上游路径（ref 签的是上游 URL）。
		InferURL: codeartsBaseURL + "/chat/completions",
		Models:   codeartsModels,
	})
	for _, provider := range []string{"buddy", "workbuddy"} {
		p := BuddyProducts()[provider]
		b.RegisterProduct(Product{
			Provider:    provider,
			DisplayName: p.DisplayName + " (Free Hub)",
			BaseURL:     p.Endpoint,
			// ref buddy-adapter.ts：`${endpoint}/v2/chat/completions`
			// （buddyChatPath；此前该常量零调用，出站 URL 被拼成 /v1/… → 404）。
			InferURL: p.Endpoint + buddyChatPath,
			Models:   buddyFallbackModels(provider),
		})
	}
	// P3.2: lobsterai (chat base = apiBase + /api/proxy/v1).
	b.RegisterProduct(Product{
		Provider:    "lobsterai",
		DisplayName: "LobsterAI (有道)",
		BaseURL:     lobsteraiProduct.Endpoint,
		// ref lobsterai-adapter.ts：`${apiBase}/api/proxy/v1/chat/completions`。
		InferURL: lobsteraiProduct.Endpoint + lobsteraiChatPath,
		Models:   lobsteraiFallbackModels(),
	})
	// P3.3: trae (agent host for chat, ug host for credits; three-host split).
	b.RegisterProduct(Product{
		Provider:    "trae",
		DisplayName: traeProduct.DisplayName + " (Free Hub)",
		BaseURL:     traeAgentHost,
		// ref trae.ts：`POST /api/agent/v3/llm_utils_chat`（SOLO 私有协议，
		// traeChatPath）。⚠️ 该路径末尾不是 chat/completions，任何 BaseURL 都
		// 表达不了（必被拼成 …/v3/chat/completions）。
		// ⚠️ 响应仍是 SOLO 自定义 SSE，本端**尚未**实现 SOLO→OpenAI 转换
		// （见 docs/jethub-architecture.md §6.2）：URL 修好后 trae 仍不可用于
		// OpenAI 客户端，需要时再补响应桥。
		InferURL: traeAgentHost + traeChatPath,
		Models:   traeFallbackModels(),
	})
	// P3.3.2: cline (OpenAI-compatible, no conversion).
	b.RegisterProduct(Product{
		Provider:    "cline",
		DisplayName: "Cline (Free Hub)",
		BaseURL:     clineProduct.APIBase,
		// ref cline-product.ts：CLINE_CHAT_PATH = `/api/v1/chat/completions`。
		InferURL: clineProduct.APIBase + clineChatPath,
		Models:   clineFallbackModels(),
	})
	// P3.3.3: raccoon (chat base = xiaohuanxiong.com, OpenAI-compatible SSE
	// + extra_body.thinking dialect).
	b.RegisterProduct(Product{
		Provider:    "raccoon",
		DisplayName: "Raccoon (商汤)",
		BaseURL:     raccoonAPIBase,
		// ref raccoon-adapter.ts：`${apiBase}/api/web/llm/v2/chat/completions`
		// （raccoonChatPath）。用户实测 trace r28I5FsAVgWK-2：拼成
		// {host}/v1/chat/completions 被 nginx 回 405 Not Allowed。
		InferURL: raccoonInferURL(),
		Models:   raccoonFallbackModels(),
		// 远端目录（`GET /api/web/llm/v2/model_catalog`）动态拉取：上游会滚动上架
		// 同族新版本（2026-10-21 起 `sn-deepseek-v4-1-flash-1017`，展示名
		// `DeepSeek-V4.1-Flash-1017`），静态 6 条兜底表（2026-09-26 快照）只在
		// 远端失败时顶替。用户报障「上游有 DeepSeek-V4.1-Flash-1017，Free Hub 里没有」
		// 的根因就是此前只搬了兜底表。⚠️ 与 loomy/accio 同型（R1-8 既定形态）；
		// `RaccoonModelsFor` 内部有 10min/30s 缓存与并发去重。
		ModelsFor: RaccoonModelsFor,
	})
	// P3.3.4: loomy (standard OpenAI chat; no renewal — SMS re-login only).
	b.RegisterProduct(Product{
		Provider:    "loomy",
		DisplayName: "Loomy (讯飞)",
		BaseURL:     loomyProduct.APIBase,
		// ref loomy-adapter.ts：`${apiBase}/chat/completions`（apiBase 自带
		// /api/v1，故这里只需追加 /chat/completions）。显式声明而非依赖
		// urlutil 的版本段启发式 —— 后者一旦被改就会静默拼错。
		InferURL: loomyProduct.APIBase + "/chat/completions",
		Models:   loomyFallbackModels(),
		// 远端目录（`GET /api/v1/models`）动态拉取：上游新增的 chat 模型
		// （如 DeepSeek-V4.1-Flash）必须即时出现在面板，静态兜底表只在离线时顶替。
		// ⚠️ 与 accio 同型（R1-8 的既定形态）；`LoomyModelsFor` 内部有 10min/30s
		// 缓存与并发去重。
		ModelsFor: LoomyModelsFor,
	})
	// P3.3.5: minimax (Anthropic Messages native passthrough — no conversion).
	b.RegisterProduct(Product{
		Provider:    "minimax",
		DisplayName: "MiniMax Code",
		BaseURL:     minimaxProduct.APIHost,
		// ref minimax-product.ts：MINIMAX_INFER_PATH =
		// `/mavis/api/v1/llm/v1/messages`。⚠️ 必须显式声明：该 base 以
		// `/v1/messages` 结尾，urlutil 会把它当端点后缀**剥掉**，拼出
		// `…/mavis/api/v1/llm/chat/completions`（用户实测 404）。
		InferURL: minimaxInferURL(),
		Models:   minimaxFallbackModels(),
	})
	// R7-1: minimaxintl (MiniMax Code 国际版; Anthropic Messages protocol).
	b.RegisterProduct(Product{
		Provider:    "minimaxintl",
		DisplayName: "MiniMax Code (国际版)",
		BaseURL:     minimaxIntlProduct.APIHost,
		InferURL:    MinimaxInferURLFor("minimaxintl"),
		Models:      minimaxFallbackModels(),
	})
	// R7-2: modelscope (ModelScope 魔搭; OpenAI compatible chat).
	b.RegisterProduct(Product{
		Provider:    "modelscope",
		DisplayName: "ModelScope (魔搭)",
		BaseURL:     modelscopeBaseURL,
		InferURL:    modelscopeBaseURL + modelscopeChatPath,
		Models:      modelscopeFallbackModels(),
	})
	// R7-3: autoclaw (AutoClaw 智谱清言桌面端; OpenAI compatible chat with dynamic sign).
	b.RegisterProduct(Product{
		Provider:    "autoclaw",
		DisplayName: "AutoClaw (智谱)",
		BaseURL:     autoclawAPIBase,
		InferURL:    autoclawAPIBase + autoclawChatPath,
		Models:      autoclawFallbackModels(),
	})
	// P3.4: qoder + qodercn (encrypted inference via the embedded WASM;
	// BaseURL = the encrypted-infer host — a DIFFERENT host from the public
	// api2-v2 endpoint). ⚠️ 不设 InferURL：完整 URL（含查询串）由 WASM 算出。
	for _, provider := range []string{"qoder", "qodercn"} {
		p := qoderProducts[provider]
		models := qoderFallbackModels()
		if provider == "qodercn" {
			models = qoderCNFallbackModels()
		}
		b.RegisterProduct(Product{
			Provider:    provider,
			DisplayName: p.DisplayName + " (Free Hub)",
			BaseURL:     p.EncryptedInferBase,
			Models:      models,
		})
	}
	// R1-7: opencode (OpenCode Zen; ref branch feat/opencode-provider @ 7dd3422).
	// Anonymous channel = the literal `public` key; paid models are hidden until
	// a keyed account exists (ModelFilter).
	b.RegisterProduct(Product{
		Provider:    "opencode",
		DisplayName: "OpenCode Zen (Free Hub)",
		BaseURL:     opencodeBaseURL,
		// ref opencode-product.ts：chatPath = `/v1/chat/completions`。
		InferURL:     opencodeBaseURL + opencodeChatPath,
		Models:       opencodeModels,
		AnonymousKey: opencodeAnonymousKey,
		ModelFilter:  opencodeVisibleModels,
	})
	// R2: zcode (智谱 z.ai 免费额度通道；Anthropic Messages 协议).
	// ⚠️ InferURL 必须显式声明：路径不是 "BaseURL + 进站路径"，且带路径的
	// BaseURL 会被 urlutil 剥后缀（minimax 踩过同款 404）。
	b.RegisterProduct(Product{
		Provider:    "zcode",
		DisplayName: "ZCode (智谱)",
		BaseURL:     zcodeOrigin,
		InferURL:    zcodePlanMessagesURL,
		Models:      zcodeFallbackModels(),
	})
	// R6: OfficeAce — the outbound URL is per-account (`maasBaseUrl` from the
	// credential, 华为按账号下发专属网关), so the Customize branch
	// (officeaceCustomize) computes it; the static InferURL below is the
	// display/fallback value only (still declared: probe 构造兜底 URL 与
	// inference_url_test 锁值都需要它).
	b.RegisterProduct(Product{
		Provider:    "officeace",
		DisplayName: "OfficeAce (Free Hub)",
		BaseURL:     officeaceDefaultBaseURL,
		InferURL:    officeaceDefaultBaseURL + officeaceChatPath,
		Models:      officeaceModelTable,
	})
	// R6: Accio（阿里 Accio Work）— the outbound URL carries the per-request
	// `sg_k=md5(requestId)` query that ALSO rides in the body, so the URL is
	// computed by the accioCustomize branch (qoder-family rationale); the
	// static InferURL below is the display/fallback value only. Models come
	// from the remote catalog (ModelsFor) with the offline fallback table as
	// the static snapshot.
	b.RegisterProduct(Product{
		Provider:    "accio",
		DisplayName: "Accio (阿里) (Free Hub)",
		BaseURL:     accioGatewayBase,
		// ⚠️ accioGatewayBase 是 var（测试可指向 mock）；产品表登记发生在
		// 启动期，运行期不再变 —— 与探针兜底构造共用同一份真相。
		InferURL:  accioGatewayBase + accioLLMPath,
		Models:    accioFallbackModelTable,
		ModelsFor: AccioModelsFor,
	})
	// R10: Codely（Unity 团结引擎）— 推理是 OpenAI 兼容网关，但每个请求都要
	// 先换发 sk- CLI key 再 HMAC 签名（见 codelyAugment）。目录走远端
	// `/api/model-status`（ModelsFor），静态 8 条兜底。
	b.RegisterProduct(Product{
		Provider:    "codely",
		DisplayName: "Codely (Unity) (Free Hub)",
		BaseURL:     codelyAPIBase,
		InferURL:    codelyChatHost + "/chat/completions",
		Models:      CodelyFallbackModels(),
		ModelsFor:   CodelyModelsFor,
	})
}

// RegisterProviderAugmenters wires the provider-specific augment hooks into
// the manager (called at app startup after SetAugmenter("codearts", ...)).
func (m *Manager) RegisterProviderAugmenters() {
	for id, p := range BuddyProducts() {
		m.SetAugmenter(id, m.buddyAugment(p))
	}
	m.SetAugmenter("lobsterai", m.lobsteraiAugment)
	m.SetAugmenter("trae", m.traeAugment)
	m.SetAugmenter("cline", m.clineAugment)
	m.SetAugmenter("raccoon", m.raccoonAugment)
	m.SetAugmenter("loomy", m.loomyAugment)
	m.SetAugmenter("minimax", m.minimaxAugment)
	m.SetAugmenter("minimaxintl", m.minimaxAugment)
	m.SetAugmenter("opencode", m.opencodeAugment)
	m.SetAugmenter("modelscope", m.modelscopeAugment)
	m.SetAugmenter("autoclaw", m.autoclawAugment)
	m.SetAugmenter("zcode", m.zcodeAugment)
	m.SetAugmenter("officeace", m.OfficeaceAugmentHook())
	m.SetAugmenter("codely", m.codelyAugment)
}

// RestoreBridges re-registers every stored prefix found in accounts.json.
// Called at app startup so a restart after bridging keeps {prefix}/{model}
// callable without touching the Free Hub UI.
func (b *Bridge) RestoreBridges() {
	for provider := range b.m.prefixSnapshot() {
		if b.m.Prefix(provider) == "" {
			continue
		}
		if err := b.SyncKeys(provider); err != nil {
			continue
		}
	}
}

// prefixSnapshot returns a copy of the stored prefix map.
func (m *Manager) prefixSnapshot() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]string, len(m.accounts.Prefixes))
	for k, v := range m.accounts.Prefixes {
		out[k] = v
	}
	return out
}

// Augment implements proxy.RequestAugmenter for bridged providers. P2 wires
// the codearts adapter (SDK-HMAC signing); other providers forward the body
// unchanged until their P3 adapters register a RequestAugmenterFunc.
func (m *Manager) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	provider, ok := ProviderNameFromID(providerID)
	if !ok {
		return body, nil
	}
	m.mu.RLock()
	fn := m.augmenters[provider]
	m.mu.RUnlock()
	if fn == nil {
		return body, nil
	}
	return fn(r, body, providerID, keyID, upstreamModel)
}

// RequestAugmenterFunc is a provider-specific augment hook.
type RequestAugmenterFunc func(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error)

// SetAugmenter registers a provider-specific augment implementation (called
// by P2/P3 adapter wiring at app startup).
func (m *Manager) SetAugmenter(provider string, fn RequestAugmenterFunc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.augmenters == nil {
		m.augmenters = map[string]RequestAugmenterFunc{}
	}
	m.augmenters[provider] = fn
}

// SetInferURL declares the FULL outbound inference endpoint for a provider
// (called by Bridge.RegisterProduct with Product.InferURL).
//
// ⚠️ 为什么需要一张表而不是「BaseURL + 进站路径」：见 `Product.InferURL` 的
// 注释（整族 404/405 缺陷）。空 URL = 撤销声明（回到 urlutil 推导）。
func (m *Manager) SetInferURL(provider, url string) {
	url = strings.TrimSpace(url)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.inferURLs == nil {
		m.inferURLs = map[string]string{}
	}
	if url == "" {
		delete(m.inferURLs, provider)
		return
	}
	m.inferURLs[provider] = url
}

// inferURLFor reports the declared full inference endpoint for a provider.
func (m *Manager) inferURLFor(provider string) (string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	url, ok := m.inferURLs[provider]
	return url, ok && url != ""
}

// clientEntryPathKey carries the ORIGINAL client entry path through the
// augmenter call.
//
// ⚠️ 为什么需要它：Customize 为了让**签名类** augmenter（codearts 的 SDK-HMAC
// 签的是 `r.URL.String()`）看到上游地址，会把交给 augmenter 的请求对象换成
// 上游 URL（浅拷贝，原请求对象不动）。但同一个对象也是「进站协议」的唯一线索
// （minimax 靠它区分 OpenAI / Anthropic 两条转换路径）—— 覆盖后会把它误判成
// Anthropic 进站、跳过协议转换。故把原始路径随 context 一起带过去。
type clientEntryPathKey struct{}

// withClientEntryPath attaches the client's original entry path.
func withClientEntryPath(ctx context.Context, path string) context.Context {
	return context.WithValue(ctx, clientEntryPathKey{}, path)
}

// clientEntryPathOf returns the client's original entry path: the context value
// set by Customize when it rewrote the URL, else r.URL.Path (direct calls in
// tests / flows that never rewrote it).
func clientEntryPathOf(r *http.Request) string {
	if r == nil {
		return ""
	}
	if p, ok := r.Context().Value(clientEntryPathKey{}).(string); ok && p != "" {
		return p
	}
	if r.URL != nil {
		return r.URL.Path
	}
	return ""
}
