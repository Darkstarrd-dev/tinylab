package jethub

// Codely 推理出站：先换发 sk- CLI key，再按官方算法签名（ref
// src/codely-adapter.ts 的 HTTP 自签直连路径）。
//
// ⚠️ 签名 key 与 Bearer 必须**成对同源**：用 A 的 key 签名配 B 的 Bearer 会
// 401（ref 实测）。故每次推理都重新换发，不缓存跨账号。
//
// ⚠️ 换发端点失败要分档（ref 2026-10-22 A1）：401/403 是账号凭据真的坏了
// （重新登录）；网络/5xx/429 只是上游此刻不好 —— 后者**绝不能**记成账号冷却
// （一次 DNS 抖动曾把整池锁到次日 0 点）。

import (
	"fmt"
	"net/http"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// codelyAugment implements RequestAugmenterFunc.
func (m *Manager) codelyAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	cred, err := m.codelyCredentialFor(keyID)
	if err != nil {
		return nil, err
	}
	result := m.FetchCodelyCLIKey(r.Context(), cred.AccessToken)
	switch result.Kind {
	case "ok":
		headers := codelySignedHeaders(result.Key, r.URL.String(), codelySessionID(keyID), time.Now())
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		return body, nil
	case "credential":
		return nil, fmt.Errorf("Codely 凭据失效（HTTP %d）：请在 Free Hub 重新登录该账号", result.Status)
	case "malformed":
		return nil, fmt.Errorf("Codely 换发 CLI key 响应异常：%s（上游协议可能已变更）", result.Reason)
	default:
		return nil, fmt.Errorf("Codely 换发 CLI key 暂时失败：%s（上游/网络问题，请稍后重试；未记为账号冷却）",
			firstNonEmpty(result.Reason, fmt.Sprintf("HTTP %d", result.Status)))
	}
}

// codelySessionID derives a stable per-account LiteLLM session id (required
// header; not part of the signature).
func codelySessionID(keyID string) string {
	return chatSessionID("jethub-codely:" + keyID)
}

// codelyInterceptResponse classifies the inference response.
//
// 402 = points budget exhausted: lock account×model until UTC+8 next-day
// midnight (ref: 按日解冻), not the generic 120s cooldown (which would keep
// hammering a broke account). Everything else falls through to the proxy's
// standard classifier (401 rotate-only, 429 backoff, 5xx backoff).
func (m *Manager) codelyInterceptResponse(resp *http.Response, keyID, upstreamModel string) (int64, error) {
	if resp.StatusCode != http.StatusPaymentRequired {
		return 0, nil
	}
	_ = resp.Body.Close()
	return 0, &upstreamerr.BillingLockError{
		Until:  time.UnixMilli(NextUtc8DayStartMs(nowMillis())),
		Reason: fmt.Sprintf("codely: 积分预算已用尽（402）→ 标记 %s 至 UTC+8 次日 24:00 并切号", upstreamModel),
	}
}
