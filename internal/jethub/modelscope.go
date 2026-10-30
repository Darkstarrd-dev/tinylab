package jethub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/config"
)

// ModelScope (魔搭) 阿里达摩院产品配置、凭据与模型表。
// 参考：ref/deepseek-harness-codearts/src/modelscope-product.ts / modelscope.ts / modelscope-credits.ts / modelscope-messages.ts

const (
	modelscopeBaseURL    = "https://api-inference.modelscope.cn/v1"
	modelscopeChatPath   = "/chat/completions"
	modelscopeBalanceURL = "https://www.modelscope.cn/openapi/v1/magicubes/balance"
)

// ModelscopeCredential 持久化凭据结构。
// ⚠️ 字段名必须是 access_token（与上游 AccountPool 身份反查要求同源）。
type ModelscopeCredential struct {
	AccessToken string `json:"access_token"`
	Nickname    string `json:"nickname,omitempty"`
	ExpiresAt   int64  `json:"expires_at,omitempty"`
	UserID      string `json:"user_id,omitempty"`
}

func init() {
	RegisterTokenExtractor("modelscope", func(cred jsonRaw) (string, error) {
		var c ModelscopeCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", fmt.Errorf("jethub: parse modelscope credential: %w", err)
		}
		return c.AccessToken, nil
	})
}

// modelscopeCredentialFor 读出并解析 modelscope 凭据。
func (m *Manager) modelscopeCredentialFor(accountID string) (*ModelscopeCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "modelscope" {
		return nil, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential("modelscope", acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(accountID)
	}
	var cred ModelscopeCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse modelscope credential %s: %w", accountID, err)
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(accountID)
	}
	return &cred, nil
}

// AddModelscopeAccount 添加或复用一个魔搭 API Key 账号。
func (m *Manager) AddModelscopeAccount(apiKey, nickname string) (string, bool, error) {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		return "", false, errors.New("jethub: API key 不能为空")
	}
	if !strings.HasPrefix(apiKey, "ms-") || len(apiKey) < 16 {
		return "", false, errors.New("jethub: ModelScope API key 格式无效（形如 ms-…，至少 16 位）")
	}
	// 按 access_token 去重：同一 Key 重复添加则复用
	for _, a := range m.Accounts("modelscope") {
		cred, err := m.modelscopeCredentialFor(a.ID)
		if err != nil || cred == nil {
			continue
		}
		if cred.AccessToken == apiKey {
			return a.ID, true, nil
		}
	}
	nick := strings.TrimSpace(nickname)
	if nick == "" {
		tail := apiKey
		if len(tail) > 4 {
			tail = tail[len(tail)-4:]
		}
		nick = "ModelScope " + tail
	}
	id, ref := NewAccountID("modelscope")
	if err := m.AddAccount(Account{
		ID:            id,
		Provider:      "modelscope",
		Nickname:      nick,
		Enabled:       true,
		CredentialRef: ref,
		CreatedAt:     time.Now().UnixMilli(),
	}); err != nil {
		return "", false, err
	}
	cred := ModelscopeCredential{AccessToken: apiKey, Nickname: nick}
	raw, err := json.Marshal(cred)
	if err != nil {
		return "", false, err
	}
	// 长期 API Key 无自动续期端点：expiresAt 0，refreshable false
	if err := m.SetCredential("modelscope", ref, raw, 0, false); err != nil {
		return "", false, err
	}
	return id, false, nil
}

// modelscopeAugment 注入鉴权头并规范化工具定义（避免上游 400 校验拦截）。
// ⚠️ 工具必须是 {type: "function", function: {...}} 结构。
func (m *Manager) modelscopeAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	cred, err := m.modelscopeCredentialFor(keyID)
	if err != nil {
		return nil, err
	}
	r.Header.Set("Authorization", "Bearer "+cred.AccessToken)
	r.Header.Set("Content-Type", "application/json")
	if r.Header.Get("Accept") == "" {
		r.Header.Set("Accept", "text/event-stream")
	}

	// 扁平工具包装处理
	if len(body) > 0 {
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err == nil {
			if tools, ok := payload["tools"].([]any); ok && len(tools) > 0 {
				modified := false
				for i, t := range tools {
					tm, ok := t.(map[string]any)
					if !ok {
						continue
					}
					if _, hasType := tm["type"]; !hasType {
						tools[i] = map[string]any{
							"type":     "function",
							"function": tm,
						}
						modified = true
					}
				}
				if modified {
					payload["tools"] = tools
					if updated, err := json.Marshal(payload); err == nil {
						body = updated
					}
				}
			}
		}
	}
	return body, nil
}

// ModelscopeBalance 查询魔搭魔粒余额。
// ⚠️ 端点位于 https://www.modelscope.cn/openapi/v1/magicubes/balance，
// 不在 api-inference.modelscope.cn 主机上。
func (m *Manager) ModelscopeBalance(ctx context.Context, accountID string) (*CreditBalance, error) {
	cred, err := m.modelscopeCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, modelscopeBalanceURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cred.AccessToken)
	req.Header.Set("Referer", "https://www.modelscope.cn/my/overview")
	req.Header.Set("Accept", "application/json")

	tctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req = req.WithContext(tctx)

	resp, err := m.httpClient("modelscope").Do(req)
	if err != nil {
		return nil, fmt.Errorf("modelscope: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return nil, errors.New("API Key 无效或已失效（魔搭返回 401），请到 modelscope.cn 重新生成访问令牌")
	}

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload struct {
		Success bool `json:"success"`
		Data    *struct {
			TotalBalance     *float64 `json:"total_balance"`
			AvailableBalance *float64 `json:"available_balance"`
		} `json:"data"`
		Message string `json:"message"`
		Code    any    `json:"code"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("魔粒余额响应不是 JSON（HTTP %d）：%.120s", resp.StatusCode, string(raw))
	}
	if !payload.Success {
		msg := payload.Message
		if msg == "" && payload.Code != nil {
			msg = fmt.Sprintf("code=%v", payload.Code)
		}
		if msg != "" {
			msg = "（" + msg + "）"
		}
		return nil, fmt.Errorf("魔搭未返回魔粒余额%s。若该账号刚注册，可能需要先在 modelscope.cn 完善个人信息并实名认证", msg)
	}
	if payload.Data == nil || payload.Data.TotalBalance == nil {
		return nil, errors.New("魔搭响应里没有 total_balance 字段，无法显示余额")
	}
	total := *payload.Data.TotalBalance
	avail := total
	if payload.Data.AvailableBalance != nil {
		avail = *payload.Data.AvailableBalance
	}
	return &CreditBalance{
		Total: roundCredits(total),
		Packages: []CreditPackage{
			{
				Name:      "魔粒",
				Total:     roundCredits(total),
				Used:      roundCredits(total - avail),
				Remaining: roundCredits(avail),
				Unit:      "credit",
				Active:    true,
			},
		},
		IsCredit: true,
	}, nil
}

// modelscopeFallbackModels 返回魔搭 36 个兜底模型表（ref modelscope-product.ts MODELSCOPE_FALLBACK_MODELS）。
func modelscopeFallbackModels() ModelTable {
	md := func(id, name, ctx string, img bool, efforts string) config.ModelDef {
		note := "ctx " + ctx
		if img {
			note += "; image"
		}
		if efforts != "" {
			note += "; efforts " + efforts
		}
		return config.ModelDef{ID: id, QuotaType: "limited", Note: note, Alias: name}
	}
	return ModelTable{
		// DeepSeek 系
		// ⚠️ 2026-10-26（R10，upstream 9ffd65e / issue #12）：无后缀的
		// `deepseek-ai/DeepSeek-V4.1-Flash` 在魔搭侧已下线（报障者取证：HTTP 400
		// `has no provider supported`），当前在服务的是日期快照 `-1017`。
		// 静态兜底表在远端目录失败时就是「可调用清单」，登记已下线 id 会让用户
		// 选中后必然 400 ⇒ 只登记在服务的快照。
		md("deepseek-ai/DeepSeek-V4.1-Flash-1017", "DeepSeek-V4.1-Flash (魔搭)", "1048576", true, "none"),
		md("deepseek-ai/DeepSeek-V4-Pro", "DeepSeek-V4-Pro (魔搭)", "1048576", false, ""),
		md("deepseek-ai/DeepSeek-V4-Flash-0731", "DeepSeek-V4-Flash-0731 (魔搭)", "1048576", false, ""),
		md("deepseek-ai/DeepSeek-V4-Pro-0813", "DeepSeek-V4-Pro-0813 (魔搭)", "1048576", false, ""),

		// GLM / 智谱 系
		md("ZhipuAI/GLM-5.2", "GLM-5.2 (魔搭)", "1048576", false, ""),
		md("ZhipuAI/GLM-4.7-Flash", "GLM-4.7-Flash (魔搭)", "1048576", false, ""),

		// MiniMax 系
		md("MiniMax/MiniMax-M3", "MiniMax-M3 (魔搭)", "1000000", false, ""),
		md("MiniMax/MiniMax-M1-80k", "MiniMax-M1-80k (魔搭)", "512000", false, ""),

		// Qwen 系
		md("Qwen/Qwen3.8-Flash-Next", "Qwen3.8-Flash-Next (魔搭)", "1048576", false, ""),
		md("Qwen/Qwen3.8-27B", "Qwen3.8-27B (魔搭)", "1048576", false, ""),
		md("Qwen/Qwen3.5-27B", "Qwen3.5-27B (魔搭)", "1048576", false, ""),
		md("Qwen/Qwen3.5-35B-A3B", "Qwen3.5-35B-A3B (魔搭)", "1048576", false, ""),
		md("Qwen/Qwen3.5-122B-A10B", "Qwen3.5-122B-A10B (魔搭)", "1048576", false, ""),
		md("Qwen/Qwen3.5-397B-A17B", "Qwen3.5-397B-A17B (魔搭)", "1048576", false, ""),
		md("Qwen/Qwen-Image-Edit", "Qwen-Image-Edit (魔搭)", "1048576", false, ""),
		md("MusePublic/Qwen-Image-Edit", "Qwen-Image-Edit (魔搭·镜像)", "1048576", false, ""),
		md("XGenerationLab/XiYanSQL-QwenCoder-32B-2412", "XiYanSQL-QwenCoder-32B-2412 (魔搭)", "1048576", false, ""),
		md("XGenerationLab/XiYanSQL-QwenCoder-32B-2504", "XiYanSQL-QwenCoder-32B-2504 (魔搭)", "1048576", false, ""),

		// InternVL 系
		md("OpenGVLab/InternVL3_5-241B-A28B", "InternVL3.5-241B-A28B (魔搭)", "1048576", false, ""),

		// 无先例保守占位 512_000
		md("Shanghai_AI_Laboratory/Intern-S1", "Intern-S1 (魔搭)", "512000", false, ""),
		md("Shanghai_AI_Laboratory/Intern-S1-mini", "Intern-S1-mini (魔搭)", "512000", false, ""),
		md("Shanghai_AI_Laboratory/Intern-S2-Preview", "Intern-S2-Preview (魔搭)", "512000", false, ""),
		md("stepfun-ai/Step-3.7-Flash", "Step-3.7-Flash (魔搭)", "512000", false, ""),
		md("stepfun-ai/Step-3.5-Flash", "Step-3.5-Flash (魔搭)", "512000", false, ""),
		md("nex-agi/Nex-N2.5-Pro", "Nex-N2.5-Pro (魔搭)", "512000", false, ""),
		md("nex-agi/Nex-N2.5-mini", "Nex-N2.5-mini (魔搭)", "512000", false, ""),
		md("mistralai/Mistral-Large-Instruct-2407", "Mistral-Large-Instruct-2407 (魔搭)", "512000", false, ""),
		md("PaddlePaddle/ERNIE-4.5-300B-A47B-PT", "ERNIE-4.5-300B-A47B (魔搭)", "512000", false, ""),
		md("PaddlePaddle/ERNIE-4.5-21B-A3B-PT", "ERNIE-4.5-21B-A3B (魔搭)", "512000", false, ""),
		md("PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT", "ERNIE-4.5-VL-28B (魔搭)", "512000", false, ""),
		md("PaddlePaddle/ERNIE-4.5-0.3B-PT", "ERNIE-4.5-0.3B (魔搭)", "512000", false, ""),
		md("MedAIBase/AntAngelMed", "AntAngelMed (魔搭)", "512000", false, ""),
		md("opencompass/CompassJudger-1-32B-Instruct", "CompassJudger-1-32B (魔搭)", "512000", false, ""),
		md("early-access/EA-29B-A4B", "EA-29B-A4B (魔搭·早期体验)", "512000", false, ""),
		md("meituan-longcat/LongCat-Flash-Lite", "LongCat-Flash-Lite (魔搭)", "512000", false, ""),
		md("ACE-Step/acestep-v15-xl-sft", "ACE-Step-v15-xl (魔搭)", "512000", false, ""),
	}
}
