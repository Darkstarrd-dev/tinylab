package jethub

import (
	"net/http"
	"testing"
)

// 推理端点契约：每个 bridged provider 的**真实出站 URL**。
//
// ⚠️ 这里锁死的是「整族真实缺陷」的修复（用户实测 raccoon 405 / minimax 404）：
// 出站 URL 原由 `urlutil.BuildUpstreamURL(BaseURL, 进站路径)` 构造，而多数产品的
// BaseURL 只能填 host 根（目录/积分端点共用），真实推理路径又是 provider 私有的
// —— buddy/workbuddy、lobsterai、trae、cline、raccoon、minimax 六个 provider 因此
// **全部**打到错误路径。现在改由 `Product.InferURL` 显式声明、`Customize` 原样返回。
//
// 每个期望值都有参考实现（ref/deepseek-harness-codearts/src）的端点依据，注释里
// 标出文件；qoder 族不在表内 —— 它们的 URL 由内嵌 WASM 算出。
var expectedInferenceEndpoints = map[string]string{
	"codearts":  codeartsBaseURL + "/chat/completions",         // ref llm-adapter.ts:954
	"buddy":     "https://copilot.tencent.com" + buddyChatPath, // ref buddy-adapter.ts:1621
	"workbuddy": "https://www.workbuddy.ai" + buddyChatPath,    // ref product.ts:384 + buddy-adapter.ts
	"lobsterai": lobsteraiProduct.Endpoint + lobsteraiChatPath, // ref lobsterai-adapter.ts:11
	"trae":      traeAgentHost + traeChatPath,                  // ref trae.ts:44
	"cline":     clineProduct.APIBase + clineChatPath,          // ref cline-product.ts:301
	"raccoon":   raccoonAPIBase + raccoonChatPath,              // ref raccoon-adapter.ts:431
	"loomy":     loomyProduct.APIBase + "/chat/completions",    // ref loomy-adapter.ts:487
	"minimax":   minimaxProduct.APIHost + minimaxInferPath,     // ref minimax-product.ts:192
}

// newInferenceURLManager wires the real product table onto a throwaway bridge.
func newInferenceURLManager(t *testing.T) *Manager {
	t.Helper()
	m := newTestManager(t).m
	b := NewBridge(m, newFakeRegistry())
	RegisterDefaultProducts(b)
	for provider := range expectedInferenceEndpoints {
		// 记一个空操作 augmenter：Customize 对已声明 InferURL 的 provider 会调用
		// Augment（真实实现需要凭据，这里只需要它被调用一次不报错）。
		m.SetAugmenter(provider, func(_ *http.Request, body []byte, _, _, _ string) ([]byte, error) {
			return body, nil
		})
	}
	return m
}

func TestInferenceEndpoints(t *testing.T) {
	m := newInferenceURLManager(t)
	req, _ := http.NewRequest(http.MethodPost, "https://tinylab.local/v1/chat/completions", nil)
	for provider, want := range expectedInferenceEndpoints {
		got, declared := m.inferURLFor(provider)
		if !declared {
			t.Errorf("%s: no InferURL declared (would fall back to BaseURL+进站路径)", provider)
			continue
		}
		if got != want {
			t.Errorf("%s: InferURL = %q, want %q", provider, got, want)
		}
		// Customize 必须把**完整端点**交给代理（而非靠 urlutil 推导）。
		outURL, _, err := m.Customize(req, []byte(`{"model":"x","messages":[]}`), ProviderID(provider), "acct", "x")
		if err != nil {
			t.Errorf("%s: customize: %v", provider, err)
			continue
		}
		if outURL != want {
			t.Errorf("%s: customize URL = %q, want %q", provider, outURL, want)
		}
	}
}

// TestQoderFamilyHasNoDeclaredInferURL: qoder 的完整 URL（含查询串）由 WASM 算出，
// 声明 InferURL 反而会与它冲突。
func TestQoderFamilyHasNoDeclaredInferURL(t *testing.T) {
	m := newInferenceURLManager(t)
	for _, provider := range []string{"qoder", "qodercn"} {
		if url, ok := m.inferURLFor(provider); ok {
			t.Fatalf("%s must not declare InferURL (WASM computes it), got %q", provider, url)
		}
	}
}

// TestCodeartsSignatureSeesUpstreamPath: codearts 的 SDK-HMAC 签的是
// `r.URL.String()`，而代理交给 augmenter 的是**客户端**请求（进站
// `/v1/chat/completions`）⇒ canonical URI 与参考实现（签完整上游 URL）不一致，
// 真机会验签失败。Customize 必须把 URL 临时改写成上游地址再调 augmenter，且
// **用完复原**（clientReq 是活的请求对象，代理后续还要用它）。
func TestCodeartsSignatureSeesUpstreamPath(t *testing.T) {
	m := newTestManager(t).m
	b := NewBridge(m, newFakeRegistry())
	RegisterDefaultProducts(b)

	var seen string
	m.SetAugmenter("codearts", func(r *http.Request, body []byte, _, _, _ string) ([]byte, error) {
		seen = r.URL.String()
		return body, nil
	})
	req, _ := http.NewRequest(http.MethodPost, "https://tinylab.local/v1/chat/completions", nil)
	outURL, _, err := m.Customize(req, []byte(`{"model":"GLM-5.2","messages":[]}`), ProviderID("codearts"), "acct", "GLM-5.2")
	if err != nil {
		t.Fatal(err)
	}
	if want := codeartsBaseURL + "/chat/completions"; seen != want {
		t.Fatalf("signature path = %q, want %q", seen, want)
	}
	if outURL != codeartsBaseURL+"/chat/completions" {
		t.Fatalf("customize URL = %q", outURL)
	}
	// 复原：代理后续仍按客户端路径使用该请求对象。
	if req.URL.String() != "https://tinylab.local/v1/chat/completions" {
		t.Fatalf("client request URL must be restored after Customize, got %q", req.URL.String())
	}
}

// TestProductInferURLSurvivesBridgeRegistration: 产品表登记即声明（唯一真相源）。
func TestProductInferURLSurvivesBridgeRegistration(t *testing.T) {
	m := newTestManager(t).m
	b := NewBridge(m, newFakeRegistry())
	b.RegisterProduct(Product{Provider: "cline", DisplayName: "t", BaseURL: "https://api.cline.bot", InferURL: "https://api.cline.bot/custom/endpoint"})
	got, ok := m.inferURLFor("cline")
	if !ok || got != "https://api.cline.bot/custom/endpoint" {
		t.Fatalf("RegisterProduct must publish InferURL, got %q ok=%v", got, ok)
	}
	// 空 InferURL = 撤销声明。
	b.RegisterProduct(Product{Provider: "cline", DisplayName: "t", BaseURL: "https://api.cline.bot"})
	if _, ok := m.inferURLFor("cline"); ok {
		t.Fatal("empty InferURL must clear the declaration")
	}
}
