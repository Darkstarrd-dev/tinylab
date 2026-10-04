package jethub

// Gemini（Google Cloud Code Assist 免费线）协议层：产品常量、凭据、字母序
// 信封、模型档表与 JSON Schema 清洗。R3-3（ref gemini*.ts @ ff5e37d，
// 上游移植自 cmdc-pak-align-wb 的 gemini 线）。
//
// 实测判据（ref 注释标「实测」的才采信）：
//   - 模型名是准入钥匙：裸 `gemini-3.8-flash` 上游 404，必须带档位后缀。
//   - lite 已移除：`gemini-3.8-flash-lite` 两端点恒 404，暴露即坑。
//   - 思考预算是自由旋钮：`medium` 名 + budget=10000 → 213 token。
//   - 「关闭思考」是假关：`includeThoughts:false` 照样思考计费 ⇒ 恒 true。

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// 端点
// ---------------------------------------------------------------------------

// geminiEndpointDaily / geminiEndpointSandbox are the two upstream endpoints
// (ref GEMINI_ENDPOINT_DAILY / _SANDBOX). Rotation order matches ref
// NewClient. ⚠️ 上游实测：两端点行为完全一致（404/project 两类失败无差异），
// 换端点零成本但不能当 quota 的有效解法——本端不做端点轮换（proxy 的
// 重试链已经管换 key/退避；单账号场景翻端点没有意义，多账号靠换号）。
const (
	geminiEndpointDaily   = "https://daily-cloudcode-pa.googleapis.com"
	geminiEndpointSandbox = "https://daily-cloudcode-pa.sandbox.googleapis.com"
)

// geminiGeneratePath / geminiStreamPath are the inference paths
// (ref GEMINI_GENERATE_PATH / GEMINI_STREAM_PATH). 本端恒走流式
// （与 minimax/zcode 同款：上游流式是唯一实测路径）。
const (
	geminiStreamPath   = "/v1internal:streamGenerateContent?alt=sse"
	geminiQuotaPath    = "/v1internal:retrieveUserQuotaSummary"
	geminiLoadAssistP  = "/v1internal:loadCodeAssist"
	geminiLoadAssistBd = `{"metadata":{"ideType":"ANTIGRAVITY"}}` // 逐字，38 字节，别加字段
)

// ---------------------------------------------------------------------------
// 身份伪装（逐字常量，不许随机；不带 x-goog-api-key / x-goog-api-client）
// ---------------------------------------------------------------------------

const (
	geminiUA          = "antigravity/4.3.0 (cmdc-pak)"
	geminiClientName  = "antigravity"
	geminiClientVer   = "4.3.0"
	geminiMachineID   = "cmdc-pak"
	geminiSessionHdr  = "proxy"
	geminiUpstreamUA  = "antigravity" // 信封 userAgent 字段
	geminiProject     = "aicode-consumers"
	geminiSessionInfr = "3124275334370613369" // 推理用预置 sessionId（非随机）
)

// geminiIdentityHeaders returns the five literal identity headers.
func geminiIdentityHeaders() map[string]string {
	return map[string]string{
		"User-Agent":         geminiUA,
		"x-client-name":      geminiClientName,
		"x-client-version":   geminiClientVer,
		"x-machine-id":       geminiMachineID,
		"x-vscode-sessionid": geminiSessionHdr,
	}
}

// ---------------------------------------------------------------------------
// 超时
// ---------------------------------------------------------------------------

const (
	geminiHTTPTimeout   = 120 * time.Second // 推理请求超时（ref GEMINI_REQUEST_TIMEOUT_MS）
	geminiOAuthTimeout  = 20 * time.Second
	geminiCreditsTTL    = 60 * time.Second // 配额缓存 TTL（ref 同值）
	geminiExpiryLead    = 60 * time.Second // 过期余量（原版 Credentials.Valid()）
	geminiMaxOutTokens  = 64000            // 默认最大输出（用户拍板 64000）
	geminiContextWindow = 1000000          // 上下文窗口（用户拍板）
)

// ---------------------------------------------------------------------------
// 凭据（字段名与 OAuth 响应逐字一致；整份 JSON 原样落盘并在刷新时回写）
// ---------------------------------------------------------------------------

// GeminiCredential mirrors ref GeminiCredential / 原版 oauth.Credentials.
type GeminiCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	TokenType    string `json:"token_type,omitempty"`
	ExpiresIn    int64  `json:"expires_in,omitempty"`
	Scope        string `json:"scope,omitempty"`
	// Expiry is an RFC3339 timestamp (原版字段名 expiry).
	Expiry    string `json:"expiry,omitempty"`
	Sub       string `json:"sub,omitempty"`
	Email     string `json:"email,omitempty"`
	Project   string `json:"cloudaicompanionProject,omitempty"`
	IDToken   string `json:"id_token,omitempty"`
	Nickname  string `json:"nickname,omitempty"`
	AccountID string `json:"account_id,omitempty"`
	APIKey    string `json:"api_key,omitempty"`
}

// geminiCredentialFor resolves + parses one gemini credential.
func (m *Manager) geminiCredentialFor(accountID string) (*GeminiCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "gemini" {
		return nil, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential("gemini", acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(accountID)
	}
	var cred GeminiCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse gemini credential %s: %w", accountID, err)
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(accountID)
	}
	return &cred, nil
}

// GeminiExpiresAtMs parses the RFC3339 expiry; 0 = unknown (不编造).
func GeminiExpiresAtMs(cred *GeminiCredential) int64 {
	if cred == nil || cred.Expiry == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, cred.Expiry)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// GeminiRefreshable reports whether renewal material exists.
func GeminiRefreshable(cred *GeminiCredential) bool {
	return cred != nil && cred.RefreshToken != ""
}

// geminiExpired mirrors 原版 Valid()：60 秒余量；取不到过期时刻 = 不过期
// （ref isGeminiExpired 同口径：undefined ⇒ false）。
func geminiExpired(cred *GeminiCredential, now time.Time) bool {
	ms := GeminiExpiresAtMs(cred)
	if ms == 0 {
		return false
	}
	return now.UnixMilli()+geminiExpiryLead.Milliseconds() >= ms
}

// ---------------------------------------------------------------------------
// 字母序序列化（上游看到的是字节；Go encoding/json 对 map 天然字母序，
// 但嵌套在 any 里的结构必须先归一到 map —— 本端入口是 json.Unmarshal 产出
// 的 map[string]any，Marshal 即已字母序。这里显式递归归一并排序，防调用方
// 手工构造 struct/有序 map 时漂移）
// ---------------------------------------------------------------------------

// geminiSortedValue recursively rebuilds the value with sorted map keys
// (arrays keep order).
func geminiSortedValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = geminiSortedValue(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = geminiSortedValue(val)
		}
		return out
	default:
		return v
	}
}

// geminiMarshalAlphabetical serializes with keys ascending at every level.
func geminiMarshalAlphabetical(v any) ([]byte, error) {
	return json.Marshal(geminiSortedValue(v))
}

// newGeminiRequestId mirrors ref newGeminiRequestId: `agent/<ms>/<8 hex>`.
func newGeminiRequestId(nowMs int64) string {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand 失败属进程级异常（owner/assistant 同款契约）：退化用时间。
		return fmt.Sprintf("agent/%d/%08x", nowMs, nowMs&0xffffffff)
	}
	return fmt.Sprintf("agent/%d/%s", nowMs, hex.EncodeToString(buf))
}

// ---------------------------------------------------------------------------
// 模型档表
// ---------------------------------------------------------------------------

// 思考档位与预算（ref GEMINI_BUDGET_*）。
const (
	geminiBudgetLow    = 1000
	geminiBudgetMedium = 4000
	geminiBudgetHigh   = 10000
	geminiBudgetTiered = -1 // tiered：只发 includeThoughts，不发 thinkingBudget
)

// geminiUpstreamFlash is the sole upstream model (裸名，不带档位后缀).
const geminiUpstreamFlash = "gemini-3.8-flash"

// geminiEffortIDs / geminiDefaultEffort mirror ref.
var geminiEffortIDs = []string{"low", "medium", "high", "tiered"}

const geminiDefaultEffort = "medium"

// geminiEffortLabel 是「档位 id → 中文显示名」（ref geminiEffortLabel）。
func geminiEffortLabel(id string) string {
	switch id {
	case "low":
		return "低"
	case "medium":
		return "中"
	case "high":
		return "高"
	case "tiered":
		return "自适应"
	}
	return id
}

// geminiFallbackModels is the static model table（ref：静态表，不拉远端）。
// ⚠️ 只暴露 1 条；档位走 efforts 下拉，不暴露 4 个带后缀的模型名；不暴露 lite。
func geminiFallbackModels() ModelTable {
	return ModelTable{
		{
			ID:        geminiUpstreamFlash,
			QuotaType: "unlimited",
			Alias:     "Gemini 3.8 Flash",
			Note:      "ctx 1000000; max 64000; 档位 low/medium/high/tiered（默认 medium）",
		},
	}
}

// geminiEffortToTier normalizes an unknown/missing effort to medium
// (ref geminiEffortToTier 默认分支).
func geminiEffortToTier(effort string) string {
	for _, id := range geminiEffortIDs {
		if effort == id {
			return effort
		}
	}
	return geminiDefaultEffort
}

// geminiThinkingBudget maps tier → budget.
func geminiThinkingBudget(tier string) int64 {
	switch tier {
	case "low":
		return geminiBudgetLow
	case "high":
		return geminiBudgetHigh
	case "tiered":
		return geminiBudgetTiered
	}
	return geminiBudgetMedium
}

// geminiCanonicalModelId strips a KNOWN tier suffix (ref 同款)。⚠️ 只剥已知档位：
// 未来加第二个模型且真名以档位词结尾时必须改为「目录全名优先匹配」。
func geminiCanonicalModelId(modelID string) string {
	for _, tier := range geminiEffortIDs {
		if suffix := "-" + tier; strings.HasSuffix(modelID, suffix) {
			return modelID[:len(modelID)-len(suffix)]
		}
	}
	return modelID
}

// geminiValidateModel rejects unknown ids（ref geminiModelSpec 的严格校验）。
// 上游对未知模型名静默接受并落回 3.8（实测假名 200 正常作答）——
// 宽容的代价是用户选错模型时拿到错误模型的答案且无任何征兆。
func geminiValidateModel(modelID string) (canonical string, err error) {
	canonical = geminiCanonicalModelId(modelID)
	if canonical != geminiUpstreamFlash {
		return "", fmt.Errorf(
			"gemini: 模型 %q 不在本 provider 目录中（仅支持 %s）", modelID, geminiUpstreamFlash)
	}
	return canonical, nil
}

// ---------------------------------------------------------------------------
// JSON Schema 清洗（白名单外的键上游硬 400）
// ---------------------------------------------------------------------------

var geminiSchemaKeys = map[string]bool{
	"type": true, "format": true, "description": true, "nullable": true,
	"enum": true, "items": true, "minItems": true, "maxItems": true,
	"properties": true, "required": true, "minProperties": true,
	"maxProperties": true, "minLength": true, "maxLength": true,
	"pattern": true, "anyOf": true, "propertyOrdering": true,
	"minimum": true, "maximum": true,
}

// geminiSanitizeSchema recursively drops non-whitelisted keys（ref
// sanitizeGeminiSchema：白名单外整键删除；type 数组收敛单值 + nullable；
// enum 含任何非字符串值整删）。
func geminiSanitizeSchema(schema map[string]any) map[string]any {
	out := make(map[string]any, len(schema))
	for key, value := range schema {
		if !geminiSchemaKeys[key] {
			continue
		}
		switch key {
		case "properties":
			props, ok := value.(map[string]any)
			if !ok {
				continue
			}
			cleaned := make(map[string]any, len(props))
			for name, child := range props {
				childMap, ok := child.(map[string]any)
				if !ok {
					continue
				}
				cleaned[name] = geminiSanitizeSchema(childMap)
			}
			out[key] = cleaned
		case "items":
			if items, ok := value.([]any); ok {
				outItems := make([]any, 0, len(items))
				for _, item := range items {
					if m, ok := item.(map[string]any); ok {
						outItems = append(outItems, geminiSanitizeSchema(m))
					}
				}
				out[key] = outItems
			} else if m, ok := value.(map[string]any); ok {
				out[key] = geminiSanitizeSchema(m)
			}
		case "anyOf":
			items, ok := value.([]any)
			if !ok {
				continue
			}
			outItems := make([]any, 0, len(items))
			for _, item := range items {
				if m, ok := item.(map[string]any); ok {
					outItems = append(outItems, geminiSanitizeSchema(m))
				}
			}
			out[key] = outItems
		case "type":
			if s, ok := value.(string); ok {
				out[key] = s
			} else if arr, ok := value.([]any); ok {
				var nonNull []string
				hasNull := false
				for _, item := range arr {
					s, ok := item.(string)
					if !ok {
						continue
					}
					if s == "null" {
						hasNull = true
						continue
					}
					nonNull = append(nonNull, s)
				}
				if len(nonNull) > 0 {
					out[key] = nonNull[0]
				}
				if hasNull {
					out["nullable"] = true
				}
			}
		case "enum":
			arr, ok := value.([]any)
			if !ok {
				continue
			}
			allStrings := true
			for _, item := range arr {
				if _, ok := item.(string); !ok {
					allStrings = false
					break
				}
			}
			if allStrings {
				out[key] = append([]any{}, arr...)
			}
		default:
			out[key] = value
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// 签名缓存（thoughtSignature 跨轮回填；键算法逐字对齐 ref geminiSigKey）
// ---------------------------------------------------------------------------

// geminiSigBodyLimit 只取正文前 512 字符（签名绑定前缀内容）。
const geminiSigBodyLimit = 512

// geminiSigKey = sha256(role + NUL + body)[:8] hex（16 字符，ref 逐字一致；
// 换算法会让已有缓存全部失配）。
func geminiSigKey(role, text string) string {
	if len(text) > geminiSigBodyLimit {
		text = text[:geminiSigBodyLimit]
	}
	sum := sha256.Sum256([]byte(role + "\x00" + text))
	return hex.EncodeToString(sum[:])[:16]
}

// geminiToolSigKey builds the functionCall signature key. ⚠️ argsJson 必须与
// 回填侧同一个规范化（两侧不一致 = 每轮都去签重试而不报错）。
func geminiToolSigKey(name, argsJSON string) string {
	return geminiSigKey("tool:"+name, argsJSON)
}

// geminiCanonicalArgs normalizes tool-call args to ascending-key compact JSON
// (ref canonicalArgs —— 排序键的紧凑 JSON)。
func geminiCanonicalArgs(args any) string {
	if args == nil {
		return "{}"
	}
	b, err := json.Marshal(geminiSortedValue(args))
	if err != nil {
		return "{}"
	}
	return string(b)
}

// geminiSigStore is the in-memory thoughtSignature cache（本端不落盘：
// 上游实测低档/不带 tool_choice 时无签名也能成功，签名缺失最多降质不报错；
// 进程内缓存已覆盖单轮工具链的跨轮回填，落盘属过度工程——ref 落盘是因
// DSH 宿主每次请求重建适配器，本端 Manager 常驻）。
type geminiSigStore struct {
	entries map[string]string
}

func newGeminiSigStore() *geminiSigStore {
	return &geminiSigStore{entries: map[string]string{}}
}

func (s *geminiSigStore) put(name, argsJSON, sig string) {
	if s == nil || name == "" || sig == "" {
		return
	}
	if s.entries == nil {
		s.entries = map[string]string{}
	}
	// 上限 2000 条（ref GEMINI_SIG_MAX_ENTRIES）：满时惰性清空（LRU 誊写
	// 的复杂度不值得——签名缓存是尽力而为的优化）。
	if len(s.entries) >= 2000 {
		s.entries = map[string]string{}
	}
	s.entries[geminiToolSigKey(name, argsJSON)] = sig
}

func (s *geminiSigStore) get(name, argsJSON string) string {
	if s == nil {
		return ""
	}
	return s.entries[geminiToolSigKey(name, argsJSON)]
}
