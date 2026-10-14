package jethub

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
	"github.com/tinylab/tinylab/internal/urlutil"
)

// 限流标记重测：对 (账号, 模型) 真实发送一条最小消息，正常返回即认为该标记
// 过期（解除）。与原版插件 account.retest 语义一致（ref jet-hub.js RETEST_HELP：
// 「对本账号每个『限额重置』标记的模型真实发送一条最小消息：正常返回则清除
// 该标记，仍被限流则保留。会消耗少量模型额度」）。
//
// 实现路径：复用代理的 augmenter/customizer 管线（Manager.Customize）——
// 与真实推理流量走同一套 URL/签名/请求体改写（codearts SDK-HMAC、qoder WASM
// 加密、trae SOLO 转换都由各自的 augmenter 完成），探针本身不实现任何协议。

// probeMaxRead caps how much of a non-200 response body is captured for the
// error message (rate-limit bodies are small JSON blobs).
const probeMaxRead = 4096

// probeTimeout bounds one minimal-message probe (the shared client is 30s;
// qoder WASM signing adds latency, so the probe budget matches).
const probeTimeout = 60 * time.Second

// probeEntryPath returns the proxy entry path and the minimal request body for
// a provider: minimax is Anthropic Messages native passthrough, everything
// else is OpenAI chat-completions compatible (trae's SOLO conversion and
// qoder's payload build happen inside their augmenters, from this OpenAI body).
func probeEntryPath(provider, model string) (string, []byte) {
	if provider == "minimax" {
		body, _ := json.Marshal(map[string]any{
			"model":      model,
			"max_tokens": 16,
			"messages":   []map[string]string{{"role": "user", "content": "ping"}},
		})
		return "/v1/messages", body
	}
	if provider == "officeace" {
		// ref 只发流式请求（officeace-adapter.ts 恒 stream:true）；探针只看
		// HTTP 状态码并丢弃 body，SSE 响应照常成立。max_tokens 会低于
		// officeaceAdjustBody 的 4096 下限被丢弃（端点默认上限兜底）——探针
		// 语义不变（能路由 + 能出 200 就是通）。
		body, _ := json.Marshal(map[string]any{
			"model":    model,
			"stream":   true,
			"messages": []map[string]string{{"role": "user", "content": "ping"}},
		})
		return "/v1/chat/completions", body
	}
	if provider == "accio" {
		// ref 只发流式请求（accio-adapter.ts 恒 stream:true）；探针只看 HTTP
		// 状态码并丢弃 body。⚠️ 不带 max_tokens：Accio body 无此字段（上限
		// 由服务端配额管），多发的字段虽然不至于报错，但保持与 ref 同形。
		body, _ := json.Marshal(map[string]any{
			"model":    model,
			"stream":   true,
			"messages": []map[string]string{{"role": "user", "content": "ping"}},
		})
		return "/v1/chat/completions", body
	}
	body, _ := json.Marshal(map[string]any{
		"model":      model,
		"max_tokens": 16,
		"stream":     false,
		"messages":   []map[string]string{{"role": "user", "content": "ping"}},
	})
	return "/v1/chat/completions", body
}

// ProbeAccountModel sends one minimal non-streaming message to (account,
// model) through the same augmenter path the proxy uses. nil return = the
// model answered (the rate-limit marker is stale and may be cleared); a
// non-nil error carries the upstream status/snippet (still limited or broken).
func (b *Bridge) ProbeAccountModel(ctx context.Context, provider, accountID, model string) error {
	prod, ok := b.product(provider)
	if !ok {
		return fmt.Errorf("jethub: no product registered for %q", provider)
	}
	entryPath, body := probeEntryPath(provider, model)
	upstreamURL := urlutil.BuildUpstreamURL(prod.BaseURL, entryPath)

	// The augmenter mutates this request's headers in place (codearts signs
	// r.URL — so the default URL must already be final when Customize runs).
	req, err := http.NewRequestWithContext(ctx, "POST", upstreamURL, nil)
	if err != nil {
		return fmt.Errorf("jethub: probe request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	outURL, outBody, err := b.m.Customize(req, body, ProviderID(provider), accountID, model)
	if err != nil {
		return fmt.Errorf("jethub: probe augment: %w", err)
	}
	finalURL := upstreamURL
	if outURL != "" {
		finalURL = outURL // qoder family: encrypted-inference endpoint
	}
	if outBody != nil {
		body = outBody
	}
	// Mirrors the proxy default: when the augmenter did not set an
	// Authorization, fall back to the account's bearer token. ⚠️ accio 例外：
	// 它的 augmenter 用 NoDefaultAuthHeader 明确否决 Bearer（token 走 body，
	// 头上放恒 200+流内 402）—— 探针必须尊重同一否决，否则探出的结论与真实
	// 流量不是同一件事。
	if req.Header.Get("Authorization") == "" && req.Header.Get(upstreamerr.NoDefaultAuthHeader) == "" {
		if acc, ok := b.m.FindAccount(accountID); ok {
			if cred, ok := b.m.Credential(provider, acc.CredentialRef); ok {
				if token, tokErr := accessTokenOf(provider, cred); tokErr == nil && token != "" {
					req.Header.Set("Authorization", "Bearer "+token)
				}
			}
		}
	}

	send, err := http.NewRequestWithContext(ctx, "POST", finalURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("jethub: probe request: %w", err)
	}
	send.Header = req.Header
	// ⚠️ 探针必须走**该账号自己**的出口（`httpClientForAccount`），不是 provider 级
	// 的：per-account 代理的存在意义就是「让这个账号看起来来自另一个 IP」，探针从
	// 别的出口发出去，探测结论与真实流量就不是同一件事（例如匿名通道的额度按出口
	// IP 计，用错出口会得到错误的「仍受限 / 已恢复」判定）。
	client := b.m.httpClientForAccount(provider, accountID)
	if client.Timeout < probeTimeout {
		// The shared 30s client is fine for most probes; qoder WASM signing
		// plus queue delays can exceed it, so give the probe its own budget —
		// keeping the provider's proxy choice via the same transport.
		tr := client.Transport
		if tr == nil {
			tr = http.DefaultTransport
		}
		client = &http.Client{Timeout: probeTimeout, Transport: tr}
	}
	resp, err := client.Do(send)
	if err != nil {
		return fmt.Errorf("jethub: probe send: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil
	}
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, probeMaxRead))
	return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(snippet)))
}

// isBookkeepingRateLimitKey reports whether a modelRateLimits key is internal
// bookkeeping rather than a real model id (trae stores its checkin generation
// counter under "__trae_checkin_gen__"). Those keys are never probed, never
// counted as cleared and never rendered as chips.
func isBookkeepingRateLimitKey(modelID string) bool {
	return strings.HasPrefix(modelID, "__")
}
