package jethub

// OfficeAce 推理增强：Basic 鉴权 + 两条必要的 body 微调，其余近透传。
//
// 协议（ref officeace-product.ts / officeace-adapter.ts）：
//
//	POST {maasBaseUrl}/v2/chat/completions
//	Authorization: Basic base64(model_app_key:model_app_secret)
//	Content-Type: application/json；Accept: text/event-stream
//
// 响应是**标准 OpenAI SSE**（含 reasoning_content 思考链字段，消费侧已兼容）——
// 不需要新协议转换器，SSE 不做任何改动。
//
// ## 两条 body 微调（ref 实测，唯一允许的改动）
//
//  1. **max_tokens 下限 4096（低于下限直接丢弃字段）**：OfficeAce 全系模型带思考
//     链，且思考 token 计入 max_tokens 预算 —— 实测 max_tokens=32/512 时思考链
//     把预算烧光、正文 0 字、finish_reason=length，外部表现就是「回复是空的 /
//     渠道停了」。低于下限的预算**丢弃**（交给端点默认上限兜底），只有够大的
//     预算才透传（ref MAX_TOKENS_FLOOR）。
//  2. **不下发 `reasoning_effort`**：ref payload 刻意不含该字段 —— 实测不下发时
//     思考照跑（该字段关不掉思考），而服务端对档位有白名单校验（`off`/垃圾值
//     → 400 ModelArts.81001）。本端把客户端带来的该字段剥掉，保证出站体与
//     ref 线协议同形；**绝不**注入。
//
// ⚠️ 除这两条外 body 逐字节透传；不引入 DSML（ref 默认也关闭 DSML，§5.6）。

import (
	"encoding/json"
	"net/http"
	"net/url"
)

// officeaceMaxTokensFloor mirrors ref MAX_TOKENS_FLOOR: budgets below it are
// dropped entirely (thinking burns small budgets, leaving zero prose).
const officeaceMaxTokensFloor = 4096

// officeaceAdjustBody applies the two allowed tweaks. Returns the original
// slice when nothing changes (byte-for-byte passthrough on the common path).
func officeaceAdjustBody(body []byte) []byte {
	if len(body) == 0 {
		return body
	}
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err != nil {
		return body
	}
	changed := false
	if v, ok := obj["max_tokens"].(float64); ok && v < officeaceMaxTokensFloor {
		delete(obj, "max_tokens")
		changed = true
	}
	if _, ok := obj["reasoning_effort"]; ok {
		delete(obj, "reasoning_effort")
		changed = true
	}
	if !changed {
		return body
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return body
	}
	return out
}

// officeaceAugment implements the provider augment hook: Basic auth from the
// account credential + the two body tweaks + the MaaS content headers.
func (m *Manager) officeaceAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	cred, err := m.officeaceCredentialFor(keyID)
	if err != nil {
		return nil, err
	}
	body = officeaceAdjustBody(body)
	r.Header.Set("Authorization", "Basic "+officeaceBasicToken(cred))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "text/event-stream")
	return body, nil
}

// officeaceInferURL resolves the outbound inference endpoint for one account:
// the per-account `maasBaseUrl` wins (华为按账号下发专属网关，打错 host 是
// 401 APIG.1009 — ref §5.7 的阻断级缺陷), else the declared InferURL, else
// the default gateway.
//
// ⚠️ 凭据读不到时**回落默认端点**而不是直接报错：真正的错误由 augmenter 报出
// （「凭据不完整，请重新登录」），URL 选择不该抢在它前面把病因换成 404。
func (m *Manager) officeaceInferURL(keyID string) string {
	if cred, err := m.officeaceCredentialFor(keyID); err == nil {
		return officeaceMaasBase(cred.MaasBaseUrl) + officeaceChatPath
	}
	if full, ok := m.inferURLFor("officeace"); ok && full != "" {
		return full
	}
	return officeaceDefaultBaseURL + officeaceChatPath
}

// officeaceCustomize is the Customize branch for officeace: like the qoder
// family, the outbound URL is NOT the product's static InferURL — it is
// computed per account (maasBaseUrl). The augmenter still runs (Basic auth +
// body tweaks) on a shallow copy whose URL points at the upstream host.
func (m *Manager) officeaceCustomize(r *http.Request, body []byte, provider, keyID, upstreamModel string) (string, []byte, error) {
	full := m.officeaceInferURL(keyID)
	augReq := r
	if r.URL != nil {
		if parsed, perr := url.Parse(full); perr == nil {
			// 浅拷贝（Header map 共享 → augmenter 的头改写仍落到代理读的
			// clientReq.Header 上）；原始进站路径随 context 传下去。
			augReq = r.WithContext(withClientEntryPath(r.Context(), r.URL.Path))
			augReq.URL = parsed
		}
	}
	out, err := m.Augment(augReq, body, ProviderID(provider), keyID, upstreamModel)
	if err != nil {
		return "", nil, err
	}
	return full, out, nil
}

// OfficeaceAugmentHook exposes the augmenter for wiring (RegisterProviderAugmenters).
func (m *Manager) OfficeaceAugmentHook() RequestAugmenterFunc {
	return m.officeaceAugment
}

// officeaceModelTable is the static model table (ref OFFICEACE_MODELS — the
// curated 8 of the gateway's 11; the two `test`-tier entries are not exposed).
//
// ⚠️ 网关 /v2/models 返回平台目录但不返回能力元数据 —— multimodal 是**逐模型
// 实测**结论（2026-10-13，1×1 PNG 实测：deepseek-v4.1-flash 与 kimi-k2.6 接受
// 图片输入，其余 400）：只登记实测通过的，未测的宁可漏报（ref multimodal 注）。
// ctx/out 记进 Note（本端 ModelDef 无独立字段的既有口径，同 codearts 表）。
var officeaceModelTable = ModelTable{
	{ID: "glm-5.3", Alias: "GLM-5.3", QuotaType: "limited", Note: "ctx 202752; out 131072"},
	{ID: "glm-5.2", Alias: "GLM-5.2", QuotaType: "limited", Note: "ctx 202752; out 131072"},
	{ID: "glm-5.1", Alias: "GLM-5.1", QuotaType: "limited", Note: "ctx 202752; out 131072"},
	{ID: "deepseek-v4.1-flash", Alias: "DeepSeek-V4.1-Flash", QuotaType: "limited", Note: "ctx 196608; out 131072; image in"},
	{ID: "deepseek-v4-flash", Alias: "DeepSeek-V4-Flash", QuotaType: "limited", Note: "ctx 196608; out 131072"},
	{ID: "kimi-k2.6", Alias: "Kimi-K2.6", QuotaType: "limited", Note: "ctx 196608; out 131072; image in"},
	{ID: "qwen3-32b", Alias: "Qwen3-32B", QuotaType: "limited", Note: "ctx 131072; out 65536"},
	{ID: "qwen3-30b-a3b", Alias: "Qwen3-30B-A3B", QuotaType: "limited", Note: "ctx 131072; out 65536"},
}

// officeaceDisplayNames exposes id → display name for tests (the alias table
// doubles as the multimodal evidence record).
func officeaceDisplayNames() map[string]string {
	out := make(map[string]string, len(officeaceModelTable))
	for _, md := range officeaceModelTable {
		out[md.ID] = md.Alias
	}
	return out
}
