package jethub

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// Qoder 适配层：把代理转发的 OpenAI 请求体改造成加密端点请求（WASM 签名），
// 并在响应侧分类排队/计费/认证信号。
//
// ⚠️ 与 ref qoder-adapter.ts 的语义差异（架构性，勿「对齐」回去）：
//   - ref 的适配器自己发请求；TinyRouter 里请求由代理发出，适配层只在
//     Customize（改 URL/体/头）与 InterceptResponse（改读/分类）两个钩子里
//     介入 —— 代理对 jethub 保持零 import（窄接口注入）。
//   - 排队等待的重发走代理重试循环（同一 Key，不排除不冷却）；
//     计费锁定走 rotation 的 per-model 锁（until = UTC+8 当日 24:00）。

// errQoderAuth marks an authentication failure after a refresh attempt (the
// ONLY case that may refresh credentials — never on queue/billing).
var errQoderAuth = errors.New("qoder: authentication failed (credential refreshed)")

// qoderSessionKey / session cache: one WASM context per account, reused
// across requests (ref: 实例不线程安全，一个账号一个实例即可). The entry is
// rebuilt whenever the bearer token changes (refresh → new auth fields).
type qoderSessionKey struct {
	provider string
	account  string
}

type qoderSessionEntry struct {
	tokenFP string
	infer   *qoderEncryptedInfer
}

var qoderInferSessions = struct {
	mu sync.Mutex
	m  map[qoderSessionKey]*qoderSessionEntry
}{m: map[qoderSessionKey]*qoderSessionEntry{}}

func qoderTokenFingerprint(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:8])
}

// qoderInferSessionFor returns the cached context for an account, rebuilding
// it when the credential changed.
func qoderInferSessionFor(provider, accountID string, cred *QoderCredential, host string) (*qoderEncryptedInfer, error) {
	token := QoderBearerToken(cred)
	fp := qoderTokenFingerprint(token)
	key := qoderSessionKey{provider, accountID}
	qoderInferSessions.mu.Lock()
	defer qoderInferSessions.mu.Unlock()
	if e, ok := qoderInferSessions.m[key]; ok && e.tokenFP == fp {
		return e.infer, nil
	}
	inf, err := newQoderEncryptedInfer(QoderWasmUserInfo{
		UID:                cred.UID,
		SecurityOauthToken: token,
	}, cred.MachineID, host)
	if err != nil {
		return nil, err
	}
	qoderInferSessions.m[key] = &qoderSessionEntry{tokenFP: fp, infer: inf}
	return inf, nil
}

// Customize implements proxy.RequestCustomizer. Only qoder/qodercn customize
// (outURL != ""); every other bridged provider falls through to its Augment
// hook with outURL == "" (the proxy then builds the default URL).
//
// ⚠️ 出站 URL 的真相有**三个来源**，优先级如下：
//  1. qoder 族 —— WASM 算出的加密推理端点（下面第一支）；
//  2. `Manager.inferURLFor(provider)` —— 产品表 `Product.InferURL` 显式声明的
//     完整端点（buddy/workbuddy、lobsterai、trae、cline、raccoon、minimax 都
//     属于这一类：BaseURL 是 host 根，真实路径是 provider 私有的，靠
//     `urlutil.BuildUpstreamURL` 拼必错）；
//  3. 默认 —— `BaseURL + 进站路径`（codearts / loomy：它们的 BaseURL 自带
//     版本路径段，拼出来正好对）。
func (m *Manager) Customize(r *http.Request, body []byte, providerID, keyID, upstreamModel string) (string, []byte, error) {
	provider, ok := ProviderNameFromID(providerID)
	if !ok {
		out, err := m.Augment(r, body, providerID, keyID, upstreamModel)
		return "", out, err
	}
	if provider == "qoder" || provider == "qodercn" {
		return m.qoderCustomize(r, body, provider, keyID, upstreamModel)
	}
	// 显式声明的完整推理端点（见 Product.InferURL 的注释：整族 404/405 缺陷）。
	if full, declared := m.inferURLFor(provider); declared {
		// ⚠️ 让**签名类** augmenter 看到上游 URL：代理交给 augmenter 的是客户端
		// 请求对象，其 URL 是进站路径（`/v1/chat/completions`），而 codearts 的
		// SDK-HMAC 签的是 `r.URL.String()`，参考实现签的是完整上游 URL
		// （canonical URI 不一致 ⇒ 真机验签会失败，而探针因为自建上游 URL 反而
		// 签对 —— 「重测通过但正常调用 401」就是它）。
		//
		// 用**浅拷贝**（r.WithContext：Header map 共享 → augmenter 的头改写仍然
		// 落到代理读的 clientReq.Header 上）+ 只改拷贝的 URL：原请求对象不被
		// 污染，而原始进站路径随 context 一起传下去（minimax 靠它判进站协议）。
		augReq := r
		if r.URL != nil {
			if parsed, perr := url.Parse(full); perr == nil {
				augReq = r.WithContext(withClientEntryPath(r.Context(), r.URL.Path))
				augReq.URL = parsed
			}
		}
		out, err := m.Augment(augReq, body, providerID, keyID, upstreamModel)
		if err != nil {
			return "", nil, err
		}
		return full, out, nil
	}
	out, err := m.Augment(r, body, providerID, keyID, upstreamModel)
	return "", out, err
}

// qoderCustomize builds the encrypted request: client OpenAI body → payload
// (pure builder) → WASM prepareInfer → url/headers/body. ⚠️ The WASM-signed
// headers REPLACE all client headers (Authorization is `Bearer COSY.<载荷>.<签名>`
// — letting a plain Bearer win means 403 Signature invalid).
func (m *Manager) qoderCustomize(r *http.Request, body []byte, provider, accountID, upstreamModel string) (string, []byte, error) {
	cred, err := m.qoderCredentialFor(provider, accountID)
	if err != nil {
		return "", nil, err
	}
	if cred.UID == "" {
		return "", nil, fmt.Errorf("jethub: qoder account %s 缺少 uid（无法生成加密推理请求，请重新登录）", accountID)
	}
	p := qoderProduct(provider)
	if p == nil {
		return "", nil, fmt.Errorf("jethub: unknown qoder product %q", provider)
	}
	inf, err := qoderInferSessionFor(provider, accountID, cred, p.EncryptedInferBase)
	if err != nil {
		return "", nil, err
	}
	inputs := qoderExtractInferInputs(body)
	meta := qoderModelMetaFor(provider, upstreamModel)
	// ⚠️ business 必填（缺了路由到故障节点）；model key 是目录 key。
	ask := &qoderInferAsk{
		ModelKey:        upstreamModel,
		UserText:        inputs.UserText,
		SystemText:      inputs.SystemText,
		IsReasoning:     meta.Reasoning,
		History:         inputs.History,
		MaxTokens:       inputs.MaxTokens,
		ReasoningEffort: inputs.ReasoningEffort,
		IsVl:            meta.Vl,
		ContextWindow:   meta.Ctx,
		MaxInputTokens:  meta.Ctx,
		DisplayName:     qoderModelDisplayName(provider, upstreamModel),
		Business:        map[string]any{"type": "agent"},
		Tools:           inputs.Tools,
		RequestID:       qoderRandomID(),
		SessionID:       qoderRandomID(),
	}
	payload, err := json.Marshal(buildQoderInferPayload(ask))
	if err != nil {
		return "", nil, fmt.Errorf("jethub: qoder payload marshal: %w", err)
	}
	prepared, err := inf.prepareInfer(string(payload), upstreamModel, "system")
	if err != nil {
		return "", nil, err
	}
	for k, v := range prepared.Headers {
		r.Header.Set(k, v)
	}
	if r.Header.Get("Content-Type") == "" {
		r.Header.Set("Content-Type", "application/json")
	}
	return prepared.URL, []byte(prepared.Body), nil
}

// qoderModelDisplayName resolves the display name for model_config
// (官方 Uyc() 的 10 字段之一 —— 必须含模型名与版本，不能只写厂商).
func qoderModelDisplayName(provider, modelID string) string {
	table := qoderFallbackModels()
	if provider == "qodercn" {
		table = qoderCNFallbackModels()
	}
	for _, md := range table {
		if md.ID == modelID && md.Alias != "" {
			return md.Alias
		}
	}
	return modelID
}

// InterceptResponse implements proxy.ResponseInterceptor for the bridged
// providers that need a response-side hook: the qoder family (HTTP 403
// channel + SSE in-stream channel — ONE implementation, both call sites;
// forking them is how the SSE channel got missed the first time) and minimax
// (Anthropic SSE → OpenAI chunk conversion).
func (m *Manager) InterceptResponse(clientReq *http.Request, resp *http.Response, providerID, keyID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	provider, ok := ProviderNameFromID(providerID)
	if !ok {
		return nil, 0, nil
	}
	if provider == "minimax" {
		return m.minimaxInterceptResponse(clientReq, resp, upstreamModel, isStream)
	}
	if provider == "codearts" {
		// CodeArts 用 HTTP 200 + 流内 `error_code` 表达限流/排队/权益错误
		// （用户实测：客户端只看到空回复）。见 codearts_response.go。
		return m.codeartsInterceptResponse(clientReq, resp, upstreamModel, isStream)
	}
	if provider == "opencode" {
		// opencode：额度错误带 401/403 也必须按**响应体语义**分类（状态码会
		// 把「额度用尽」误报成「key 失效」）；非流式客户端由本端聚合 SSE。
		return m.opencodeInterceptResponse(clientReq, resp, upstreamModel, isStream)
	}
	if provider == "zcode" {
		// zcode：Anthropic SSE → OpenAI 转换 + 业务码分类（3009/1005/1113/
		// 3007/3012/1002，判据全在正文——状态码会把并发限流与额度耗尽混为一谈）。
		return m.zcodeInterceptResponse(clientReq, resp, keyID, upstreamModel, isStream)
	}
	if provider == "gemini" {
		// gemini（R3-3）：Cloud Code SSE → OpenAI chunk 转换（上游帧是
		// {"response":{candidates,usageMetadata}} 双层信封；错误帧恒在首帧）。
		return m.geminiInterceptResponse(clientReq, resp, upstreamModel, isStream)
	}
	if provider != "qoder" && provider != "qodercn" {
		return nil, 0, nil
	}
	return m.qoderInterceptResponse(resp, provider, keyID, upstreamModel, isStream)
}

func (m *Manager) qoderInterceptResponse(resp *http.Response, provider, accountID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	// ① HTTP 状态层：401/403 的语义互不相同（排队/计费/认证/重复），绝不能合并。
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		text := string(raw)
		if info := ParseQueueError(text); info != nil {
			ms, ok := QueueDelayMS(info)
			if !ok {
				ms = 1000
			}
			return nil, ms, nil // 排队 → 等待后同一 Key 重发
		}
		var probe struct {
			Code json.RawMessage `json:"code"`
		}
		_ = json.Unmarshal(raw, &probe)
		var code any
		hasCode := len(probe.Code) > 0 && json.Unmarshal(probe.Code, &code) == nil
		if (hasCode && IsBillingBusinessCode(code)) || LooksLikeBillingError(text) {
			return nil, 0, &upstreamerr.BillingLockError{
				Until:  time.UnixMilli(NextUtc8DayStartMs(nowMillis())),
				Reason: fmt.Sprintf("qoder: Billing daily count exceeded (%s)", fmtQueueCode(code)),
			}
		}
		if resp.StatusCode == http.StatusUnauthorized || (hasCode && fmtQueueCode(code) == "105") {
			// 认证失败：续期凭据（唯一该走 refresh 的情形）后报错换路。
			if err := m.RefreshQoderAccount(context.Background(), provider, accountID); err != nil {
				return nil, 0, fmt.Errorf("qoder: 认证失败且续期失败（HTTP %d）：%v", resp.StatusCode, err)
			}
			return nil, 0, errQoderAuth
		}
		if strings.Contains(text, "duplicate_request") {
			return nil, 100, nil // 重复请求 → 直接重发（不续期）
		}
		return nil, 0, fmt.Errorf("qoder: HTTP %d: %.300s", resp.StatusCode, text)
	}
	if resp.StatusCode >= 400 {
		return nil, 0, nil // 其他错误原样透传（代理统一处理）
	}
	// ② 200 + SSE：peek 首帧分类（错误帧恒在第一帧；内容开始后再重试会重复输出）。
	if !isStream {
		return nil, 0, nil // 非流式：原样透传
	}
	peeked, firstLine, perr := qoderPeekFirstDataLine(resp.Body)
	first := strings.TrimSpace(firstLine)
	if first != "" && strings.HasPrefix(first, "data:") {
		payload := strings.TrimSpace(strings.TrimPrefix(first, "data:"))
		if payload != "[DONE]" {
			if inner, ok := qoderEnvelopeInnerText(payload); ok && !strings.Contains(inner, `"choices"`) && !strings.Contains(inner, "[DONE]") {
				ms, perr, handled := qoderClassifyErrorFrame(inner)
				if handled {
					if perr == errQoderAuth {
						if err := m.RefreshQoderAccount(context.Background(), provider, accountID); err != nil {
							return nil, 0, fmt.Errorf("qoder: 认证失败且续期失败：%v", err)
						}
					}
					return nil, ms, perr
				}
				// 未知错误：照样转发（信封已剥、code 保真）。
			}
		}
	}
	_ = perr // peek 中断（EOF/超长）不影响转发 —— 已读字节随 reader 一起走
	return newQoderEnvelopeReader(resp.Body, peeked), 0, nil
}
