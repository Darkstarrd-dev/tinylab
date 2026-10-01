// web/loomy-login.test.js
// Loomy 微信扫码登录页的零依赖契约测试。
//
// ⚠️ 背景（用户实测报障）：「loomy 新建账号」在插件里是**弹出浏览器窗口的微信扫码页**，
// 而此前 TinyLab 用的是项目内 modal 让大家手输手机号 + 验证码 —— 与插件行为不符。
// 插件面板**从不**渲染短信表单（短信只是无 UI 的备用 RPC）；本地页里的手机号表单只在
// 「微信已扫码、但讯飞侧未绑手机」时出现。
//
// 这个文件锁三件事：
//   1. 页面只用**公开**端点（`/api/jethub/login-page*`，鉴权组之外）、不含任何秘密；
//   2. 页面结构与插件一致：二维码**图片**（不是文本二维码）+ 隐藏的绑手机表单 + 轮询中间态；
//   3. Go 侧接线：loomy 的登录模式是 url（走弹窗页），本地页 URL 指向 loomy 页，
//      公开端点齐备且响应不含 rcode/msgid/session。
// Run:  node web/loomy-login.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
const checks = [];
function check(name, fn) { checks.push([name, fn]); }

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(__dirname, 'static/free-hub-loomy-login.html'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'internal/api/jethub/login_page.go'), 'utf8');
const LOOMY_API = fs.readFileSync(path.join(ROOT, 'internal/api/jethub/loomy.go'), 'utf8');
const FLOW = fs.readFileSync(path.join(ROOT, 'internal/jethub/loomy_wechat_flow.go'), 'utf8');
const WECHAT = fs.readFileSync(path.join(ROOT, 'internal/jethub/loomy_wechat.go'), 'utf8');
const MANAGER = fs.readFileSync(path.join(ROOT, 'internal/jethub/manager.go'), 'utf8');

console.log('free hub loomy (wechat) login page:');

check('page uses only the public login-page endpoints', () => {
  for (const needle of [
    '/api/jethub/login-page?loginId=',
    '/api/jethub/login-page/poll?loginId=',
    '/api/jethub/login-page/complete',
  ]) {
    assert.ok(PAGE.includes(needle), 'page must call ' + needle);
  }
  // 面板的受保护端点（/jethub/... 无 /api 前缀的那些）绝不能出现在公开页里。
  assert.ok(!/['"]\/jethub\//.test(PAGE), 'the public page must not call management endpoints');
});

check('page structure matches the plugin (image QR + hidden bind-phone form)', () => {
  assert.ok(PAGE.includes('createElement(\'img\')') || PAGE.includes('<img'), 'QR must be an <img> (WeChat serves a JPEG — it cannot be re-encoded client-side)');
  assert.ok(PAGE.includes('img.src = data.qrImage'), 'the image src must come from the payload (uuid stays host-side)');
  assert.ok(PAGE.includes('#phoneForm') && PAGE.includes('data-show'), 'bind-phone form must exist and start hidden');
  // G2 i18n: the label text moved into the FH_I18N dict; the page references
  // it via data-fh="fhLoginBindPhoneLabel" (the dict still carries the
  // 中文 explanation of why the phone is needed).
  assert.ok(PAGE.includes('data-fh="fhLoginBindPhoneLabel"') && PAGE.includes('首次使用需绑定手机号'),
    'form label must explain why the phone is needed');
  assert.ok(PAGE.includes('need_phone'), 'page must handle the need_phone stage');
  assert.ok(PAGE.includes("action: 'send_sms'") && PAGE.includes("action: 'verify_sms'"), 'both bind actions must be sent');
  assert.ok(PAGE.includes('window.close()'), 'page must close itself after success');
  assert.ok(PAGE.includes('允许重试') || PAGE.includes('请重试'), 'a failing bind step must be retryable in place');
  // 不许出现「扫码登录 Tab / 短信登录 Tab」这类插件里没有的形态。
  assert.ok(!PAGE.includes('短信登录'), 'the plugin page has NO sms-login tab');
});

check('page never mentions secrets (public asset, no session cookie)', () => {
  // ⚠️ 只在**去掉注释后的正文**里查：文件头注释是给维护者看的说明（会提到这些名字），
  // 不是页面内容。
  const body = PAGE.replace(/<!--[\s\S]*?-->/g, '');
  for (const needle of ['rcode', 'msgid', 'access_token', 'credential', 'accountId']) {
    assert.ok(!body.includes(needle), 'public page must not contain ' + needle);
  }
  assert.ok(!/\bsession\b/.test(body), 'public page must not mention session');
});

check('Go: loomy login open the LOCAL page (not the QR content)', () => {
  assert.ok(LOOMY_API.includes('h.loomyLogin'), 'loomy must expose POST /loomy/login (the panel path)');
  assert.ok(LOOMY_API.includes('StartLoomyWechatLogin'), 'the WeChat flow must be started by the handler');
  assert.ok(LOOMY_API.includes('loomyLoginPageURL'), 'loginUrl must be the local page');
  assert.ok(LOOMY_API.includes('OpenURLWithBrowser(pageURL)'), 'the browser must be opened (after session registration)');
  assert.ok(LOOMY_API.includes('context.Background()'), 'the flow must NOT hang off r.Context()');
  assert.ok(API.includes('/free-hub-loomy-login.html'), 'the page URL must point at the loomy page');
  // 顺序契约：先注册会话，再开浏览器。
  const reg = LOOMY_API.indexOf('RegisterLoginSession(loginID, sess)');
  const open = LOOMY_API.indexOf('OpenURLWithBrowser(pageURL)');
  assert.ok(reg !== -1 && open !== -1 && reg < open, 'register the session BEFORE opening the browser');
});

check('Go: the public endpoints exist and leak nothing', () => {
  for (const route of [
    'r.Get("/jethub/login-page"',
    'r.Get("/jethub/login-page/qr-image"',
    'r.Get("/jethub/login-page/poll"',
    'r.Post("/jethub/login-page/complete"',
  ]) {
    assert.ok(API.includes(route), 'missing public route: ' + route);
  }
  // poll/complete 的响应体里只允许出现 ok/stage/message/done（不许有任何凭据字段）。
  const pollFn = API.slice(API.indexOf('func (h *Handler) loginPagePoll'), API.indexOf('func (h *Handler) loginPageComplete'));
  for (const leaked of ['"rcode"', '"msgid"', '"session"', '"userid"', '"accountId"', '"access_token"']) {
    assert.ok(!pollFn.includes(leaked), 'poll response must not expose ' + leaked);
  }
  const completeFn = API.slice(API.indexOf('func (h *Handler) loginPageComplete'));
  for (const leaked of ['"rcode"', '"msgid"', '"session"', '"userid"', '"accountId"', '"access_token"']) {
    assert.ok(!completeFn.includes(leaked), 'complete response must not expose ' + leaked);
  }
  assert.ok(pollFn.includes('"stage"'), 'poll must return the page-visible stage');
  assert.ok(completeFn.includes('"done"'), 'complete must report done on success');
  assert.ok(API.includes('case "loomy":'), 'the page labels must cover loomy');
});

check('Go: the WeChat protocol mirrors the reference implementation', () => {
  // ⚠️ 404/405 语义必须照抄（参考实现曾读反 → 扫码后永远等不到 code）。
  assert.ok(WECHAT.includes('405') && WECHAT.includes('404'), 'errcode 404/405 handling missing');
  assert.ok(/case "405":/.test(WECHAT) && /case "404":/.test(WECHAT), 'errcode switch missing');
  assert.ok(WECHAT.includes('wx18d60be432287cf8'), 'WeChat appid must be the official one');
  assert.ok(WECHAT.includes('https://loomy.xunfei.cn/oauth/wechat/callback'), 'redirect_uri must be the whitelisted official URL');
  // 二维码图片按魔数判类型（实测是 JPEG）。
  assert.ok(WECHAT.includes('0xFF') && WECHAT.includes('image/jpeg'), 'QR image mime detection missing');
  // 流程状态、超时、结算都在宿主侧。
  assert.ok(FLOW.includes('loomyStageNeedPhone'), 'need_phone stage missing');
  assert.ok(FLOW.includes('loomyWechatLoginTimeout'), 'the 5-minute total timeout must exist');
  assert.ok(FLOW.includes('CompleteLoomyWechatLogin'), 'credential persistence missing');
});

check('provider meta: loomy uses the url (browser page) login mode', () => {
  const line = MANAGER.split('\n').find((l) => l.includes('{ID: "loomy"'));
  assert.ok(line, 'loomy provider row missing');
  assert.ok(line.includes('LoginModes: []string{"url"}'), 'loomy must declare url (page) login, got: ' + line.trim());
  assert.ok(!line.includes('"sms"'), 'loomy must NOT declare the sms mode (the panel would render the old in-app modal)');
});

check('feature manifest registers the loomy page', () => {
  const feats = fs.readFileSync(path.join(ROOT, 'internal/feature/feature.go'), 'utf8');
  assert.ok(feats.includes('"free-hub-loomy-login.html"'), 'feature.go must register the loomy page');
});

for (const [name, fn] of checks) {
  try {
    fn();
    console.log('  \u2713 ' + name);
  } catch (error) {
    failures++;
    console.log('  \u2717 ' + name);
    console.log('      ' + (error && error.message ? error.message : error));
  }
}

console.log(failures === 0 ? '\nall ' + checks.length + ' checks passed' : '\n' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
