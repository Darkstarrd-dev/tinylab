package jethub

// ZCode 领取（每日活动）——captcha 载体页。
//
// ## 为什么需要浏览器
//
// `POST /zcode-plan/billing/claim` **始终强制索要**阿里云 captcha（实测：带非法
// param 与不带 param 都回 400/3007，且校验前置于 plan 校验）。param 只能由阿里云
// 前端 SDK 的**无感验证**产出（`startTracelessVerification()`，正常 0.4–0.5 秒、
// 通常无需人工交互）。
//
// 本端没有常驻浏览器，也不引入 Chromium 依赖 ⇒ 用**本地载体页 + 用户自己的浏览器**：
//
//	① 领取时打开 http://127.0.0.1:<port>/api/jethub/zcode/carrier?token=<一次性 id>
//	② 页面加载阿里云 SDK 完成无感验证，把 param POST 回 /carrier/contribute
//	③ 领取流程取用该 param（每个 plan 必须**现产一个新 param**，一次性）
//
// 上游自己的"内部载体"就是同一形态（本地页 + RPC），且实测本地 origin 可用
// （ref tests/unit/zcode-captcha-origin.spec.ts 的探针记录：127.0.0.1 上 4/4 产出）。
// 页面里**不含任何凭据**（region/prefix/sceneId 是阿里云的公开初始化参数）。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// zcodeCaptchaParam is a one-shot Aliyun captcha verification param.
type zcodeCaptchaParam struct {
	Param  string
	Region string
}

// zcodeCaptchaMinParamLen / minSecurityToken mirror ref validateCaptchaParam
// (长度 < 200 或 securityToken < 50 的 param 必得 3007 —— 宁可不发).
const (
	zcodeCaptchaMinParamLen = 200
	zcodeCaptchaMinTokenLen = 50
	zcodeCaptchaWaitTimeout = 90 * time.Second
	zcodeCaptchaRequestTTL  = 3 * time.Minute
)

// zcodeValidateCaptchaParam mirrors ref validateCaptchaParam: length ≥ 200,
// base64-decodable JSON with a non-empty certifyId and securityToken ≥ 50.
func zcodeValidateCaptchaParam(param string) error {
	if len(param) < zcodeCaptchaMinParamLen {
		return fmt.Errorf("param 过短（%d < %d）", len(param), zcodeCaptchaMinParamLen)
	}
	decoded, err := base64.StdEncoding.DecodeString(param)
	if err != nil {
		// Node 的 Buffer.from(x, 'base64') 容忍缺填充；再试无填充形态。
		decoded, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(param, "="))
		if err != nil {
			return fmt.Errorf("param 不是合法 base64：%w", err)
		}
	}
	var parsed struct {
		CertifyID     string `json:"certifyId"`
		SecurityToken string `json:"securityToken"`
	}
	if err := json.Unmarshal(decoded, &parsed); err != nil {
		return fmt.Errorf("param 解出的不是 JSON：%w", err)
	}
	if strings.TrimSpace(parsed.CertifyID) == "" {
		return fmt.Errorf("param 缺 certifyId")
	}
	if len(parsed.SecurityToken) < zcodeCaptchaMinTokenLen {
		return fmt.Errorf("param 的 securityToken 过短（%d < %d）", len(parsed.SecurityToken), zcodeCaptchaMinTokenLen)
	}
	return nil
}

// zcodeCaptchaRequests tracks in-flight carrier-page requests (token → channel).
var zcodeCaptchaRequests = struct {
	sync.Mutex
	m map[string]*zcodeCaptchaRequest
}{m: map[string]*zcodeCaptchaRequest{}}

type zcodeCaptchaRequest struct {
	ch      chan string
	expires time.Time
}

// zcodeRegisterCaptchaRequest creates a pending request and returns its token.
func zcodeRegisterCaptchaRequest() (string, *zcodeCaptchaRequest) {
	token := NewLoginSessionID()
	req := &zcodeCaptchaRequest{ch: make(chan string, 1), expires: time.Now().Add(zcodeCaptchaRequestTTL)}
	zcodeCaptchaRequests.Lock()
	defer zcodeCaptchaRequests.Unlock()
	// 顺手清理过期项（进程内小表，无需后台任务）。
	for key, entry := range zcodeCaptchaRequests.m {
		if entry.expires.Before(time.Now()) {
			delete(zcodeCaptchaRequests.m, key)
		}
	}
	zcodeCaptchaRequests.m[token] = req
	return token, req
}

// ZcodeNewCarrierSession registers a pending carrier request and returns its
// one-time token (the mint entry point; exported so the API-layer tests can
// exercise the public carrier routes without driving a real browser).
func ZcodeNewCarrierSession() string {
	token, _ := zcodeRegisterCaptchaRequest()
	return token
}

// zcodePeekCaptchaRequest reads a request without consuming it.
func zcodePeekCaptchaRequest(token string) (*zcodeCaptchaRequest, bool) {
	zcodeCaptchaRequests.Lock()
	defer zcodeCaptchaRequests.Unlock()
	req, ok := zcodeCaptchaRequests.m[token]
	if !ok {
		return nil, false
	}
	if req.expires.Before(time.Now()) {
		delete(zcodeCaptchaRequests.m, token)
		return nil, false
	}
	return req, true
}

// zcodeConsumeCaptchaRequest removes a request (one-shot).
func zcodeConsumeCaptchaRequest(token string) (*zcodeCaptchaRequest, bool) {
	req, ok := zcodePeekCaptchaRequest(token)
	if !ok {
		return nil, false
	}
	zcodeCaptchaRequests.Lock()
	delete(zcodeCaptchaRequests.m, token)
	zcodeCaptchaRequests.Unlock()
	return req, true
}

// zcodeReleaseCaptchaRequest drops a request without delivering.
func zcodeReleaseCaptchaRequest(token string) {
	zcodeCaptchaRequests.Lock()
	defer zcodeCaptchaRequests.Unlock()
	delete(zcodeCaptchaRequests.m, token)
}

// DeliverZcodeCaptchaParam is called by the public contribute endpoint: it
// validates the param and hands it to the waiting claim flow.
func DeliverZcodeCaptchaParam(token, param string) error {
	if err := zcodeValidateCaptchaParam(param); err != nil {
		return err
	}
	// 校验通过才消费会话（非法 param 不消耗一次性 token，页面可重试）。
	req, ok := zcodeConsumeCaptchaRequest(token)
	if !ok {
		return fmt.Errorf("zcode: 载体会话不存在或已过期")
	}
	select {
	case req.ch <- param:
	default:
		return fmt.Errorf("zcode: 该载体会话已收到 param")
	}
	return nil
}

// ZcodeCarrierPending reports whether the token is still waiting for a param
// (the page uses it to decide whether to retry).
func ZcodeCarrierPending(token string) bool {
	_, ok := zcodePeekCaptchaRequest(token)
	return ok
}

// zcodeCarrierPageHTML renders the one-shot carrier page. Pure function of its
// inputs (the page's own Date.now() is evaluated at runtime).
func zcodeCarrierPageHTML(config zcodeCaptchaConfig, contributeURL, token string) string {
	configJSON, _ := json.Marshal(map[string]any{"region": config.Region, "prefix": config.Prefix})
	contributeJSON, _ := json.Marshal(contributeURL + "?token=" + token)
	sceneJSON, _ := json.Marshal(config.SceneID)
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>ZCode 验证</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:2rem;color:#222}
 #zcode-aliyun-captcha-container{display:none}
 #status{font-size:15px;line-height:1.6}
 .ok{color:#0a7f2e}.err{color:#b00020}
</style></head><body>
<div id="status">正在完成阿里云无感验证…（通常 1 秒内完成，无需操作；若弹出滑块请拖动完成）</div>
<div id="zcode-aliyun-captcha-container" aria-hidden="true"><div id="zcode-aliyun-captcha-element"></div><button id="zcode-aliyun-captcha-button">verify</button></div>
<script>
(function () {
  var statusEl = document.getElementById('status');
  var contributeUrl = ` + string(contributeJSON) + `;
  var done = false;
  function finish(ok, text) {
    if (done) return;
    done = true;
    statusEl.className = ok ? 'ok' : 'err';
    statusEl.textContent = text;
  }
  function post(param) {
    return fetch(contributeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ param: param })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      finish(true, '验证完成，可以关闭本页。');
    }).catch(function (e) {
      finish(false, '回传失败：' + e + '（请刷新本页重试）');
    });
  }
  var script = document.createElement('script');
  script.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
  script.async = true;
  script.onload = function () { start(); };
  script.onerror = function () { finish(false, '阿里云验证脚本加载失败（检查网络后刷新）'); };
  document.head.appendChild(script);
  setTimeout(function () { finish(false, '验证超时（请刷新本页重试）'); }, 60000);

  function start() {
    try {
      window.AliyunCaptchaConfig = ` + string(configJSON) + `;
      initAliyunCaptcha({
        SceneId: ` + string(sceneJSON) + `,
        mode: 'popup',
        element: '#zcode-aliyun-captcha-element',
        button: document.getElementById('zcode-aliyun-captcha-button'),
        getInstance: function (instance) {
          try {
            if (instance && typeof instance.startTracelessVerification === 'function') {
              instance.startTracelessVerification();
            } else if (instance && typeof instance.show === 'function') {
              instance.show();
            }
          } catch (e) {
            finish(false, '触发验证失败：' + e);
          }
        },
        success: function (param) { post(param); },
        fail: function (e) { finish(false, '验证失败：' + e); },
        onError: function (e) { finish(false, '验证出错：' + e); }
      });
    } catch (e) {
      finish(false, '初始化失败：' + e);
    }
  }
})();
</script></body></html>`
}

// zcodeCaptchaConfigCache is the 60s-TTL captcha-config cache (ref
// CAPTCHA_CONFIG_TTL_MS; 服务端会换 sceneId / 灰度切换，故不永久缓存).
var zcodeCaptchaConfigCache = struct {
	sync.Mutex
	cfg     zcodeCaptchaConfig
	expires time.Time
	loaded  bool
}{}

// zcodeCarrierConfigSnapshot returns the captcha init params, preferring a
// live fetch (first enabled account, 5s budget) and falling back to the
// built-in triple — config-fetch failure must never block the claim.
func (m *Manager) zcodeCarrierConfigSnapshot() zcodeCaptchaConfig {
	zcodeCaptchaConfigCache.Lock()
	if zcodeCaptchaConfigCache.loaded && time.Now().Before(zcodeCaptchaConfigCache.expires) {
		cfg := zcodeCaptchaConfigCache.cfg
		zcodeCaptchaConfigCache.Unlock()
		return cfg
	}
	zcodeCaptchaConfigCache.Unlock()
	cfg := zcodeCaptchaFallback
	for _, acc := range m.Accounts("zcode") {
		cred, err := m.zcodeCredentialFor(acc.ID)
		if err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		cfg = m.FetchZcodeCaptchaConfig(ctx, cred)
		cancel()
		break
	}
	zcodeCaptchaConfigCache.Lock()
	zcodeCaptchaConfigCache.cfg = cfg
	zcodeCaptchaConfigCache.expires = time.Now().Add(time.Minute)
	zcodeCaptchaConfigCache.loaded = true
	zcodeCaptchaConfigCache.Unlock()
	return cfg
}

// ZcodeCarrierPage renders the carrier page for a pending token. ok=false
// means the token is unknown/expired (the endpoint answers 404).
func (m *Manager) ZcodeCarrierPage(token, contributeURL string) (string, bool) {
	if !ZcodeCarrierPending(token) {
		return "", false
	}
	return zcodeCarrierPageHTML(m.zcodeCarrierConfigSnapshot(), contributeURL, token), true
}

// zcodeCarrierURLFunc builds the carrier page URL for a token (the API layer
// derives the host from the incoming request).
type zcodeCarrierURLFunc func(token string) string

// ZcodeClaimReport is the outcome of one daily-claim run.
type ZcodeClaimReport struct {
	Plans   []zcodeClaimOutcome
	Message string
}

// ZcodeClaimDaily runs the full claim flow: activity report → preview →
// per-plan claim with a freshly minted captcha param.
func (m *Manager) ZcodeClaimDaily(ctx context.Context, accountID string, carrierURL zcodeCarrierURLFunc) (*ZcodeClaimReport, error) {
	cred, err := m.zcodeCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	m.ReportZcodeActivation(ctx, cred)
	plans, err := m.FetchZcodeClaimablePlans(ctx, cred)
	if err != nil {
		return nil, err
	}
	if len(plans) == 0 {
		return &ZcodeClaimReport{Message: "今日没有可领取的活动（可能已领取或活动未开始）"}, nil
	}
	config := m.FetchZcodeCaptchaConfig(ctx, cred)
	report := &ZcodeClaimReport{}
	for _, plan := range plans {
		outcome, err := m.zcodeClaimOnePlan(ctx, cred, plan, config, carrierURL)
		if err != nil {
			return report, err
		}
		report.Plans = append(report.Plans, *outcome)
	}
	return report, nil
}

// zcodeClaimOnePlan claims one plan, minting a fresh param (a 3007 gets one
// retry with another fresh param — the ref's per-plan re-mint rule).
func (m *Manager) zcodeClaimOnePlan(ctx context.Context, cred *ZcodeCredential, plan zcodeClaimablePlan, config zcodeCaptchaConfig, carrierURL zcodeCarrierURLFunc) (*zcodeClaimOutcome, error) {
	for attempt := 0; attempt < 2; attempt++ {
		param, err := m.zcodeMintCaptchaParam(ctx, config, carrierURL)
		if err != nil {
			return nil, err
		}
		outcome, err := m.ClaimZcodePlan(ctx, cred, plan.PlanID, param)
		if err != nil {
			return nil, err
		}
		if outcome.Code == 3007 && attempt == 0 {
			continue // captcha 一次性：换一个新 param 再试一次。
		}
		if outcome.Message == "" {
			outcome.Message = zcodeDescribeClaimCode(outcome.Code)
		}
		return outcome, nil
	}
	return nil, fmt.Errorf("zcode: captcha 连续两次被拒（3007）")
}

// zcodeMintCaptchaParam opens the carrier page in the user's browser and waits
// for the contributed param.
func (m *Manager) zcodeMintCaptchaParam(ctx context.Context, config zcodeCaptchaConfig, carrierURL zcodeCarrierURLFunc) (zcodeCaptchaParam, error) {
	token, req := zcodeRegisterCaptchaRequest()
	pageURL := carrierURL(token)
	if pageURL == "" {
		zcodeReleaseCaptchaRequest(token)
		return zcodeCaptchaParam{}, fmt.Errorf("zcode: 无法构造载体页地址")
	}
	m.zcodeOpenURL(pageURL)
	select {
	case param := <-req.ch:
		return zcodeCaptchaParam{Param: param, Region: config.Region}, nil
	case <-ctx.Done():
		zcodeReleaseCaptchaRequest(token)
		return zcodeCaptchaParam{}, fmt.Errorf("zcode: 领取已取消")
	case <-time.After(zcodeCaptchaWaitTimeout):
		zcodeReleaseCaptchaRequest(token)
		return zcodeCaptchaParam{}, fmt.Errorf("zcode: 等待验证超时（未在 %.0f 秒内收到 param）——请确认浏览器已打开载体页并完成验证",
			zcodeCaptchaWaitTimeout.Seconds())
	}
}

// zcodeSortedPlans is a small helper for deterministic tests.
func zcodeSortedPlans(plans []zcodeClaimablePlan) []zcodeClaimablePlan {
	out := make([]zcodeClaimablePlan, len(plans))
	copy(out, plans)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Priority > out[j].Priority })
	return out
}
