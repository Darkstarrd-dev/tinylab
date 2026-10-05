// web/monitor-quota-balance.test.js
// Zero-dependency Node test for the QuotaMonitor "Provider · 余额" reading
// (aligns the TinyLab Monitor page with the DSH usage badge:
// `ZCode (智谱) • 94.54MToken` → Provider 列追加小两号读数，如 `30.09M` / `3000`).
//
// Loads the REAL web/static/monitor/monitor_quota.js in a VM sandbox and feeds it
// the REAL formatters extracted from web/static/jethub.js — so the numeric
// wording ("30.09M" for token quotas, "3000" for credits, no unit word) is
// asserted end-to-end rather than against a re-implementation.
// Run:  node web/monitor-quota-balance.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const checks = [];
function check(name, fn) { checks.push([name, fn]); }

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const STATIC = 'static/';
const ROOT = path.join(__dirname, '..');

console.log('monitor quota balance reading:');

// --- 1. static wiring (no VM) ---

check('backend exposes GET /api/jethub/balances', () => {
  const register = fs.readFileSync(path.join(ROOT, 'internal/api/jethub/register.go'), 'utf8');
  assert.ok(register.includes('r.Get("/balances", h.providerBalances)'),
    'register.go must mount the aggregate endpoint');
  const handler = fs.readFileSync(path.join(ROOT, 'internal/api/jethub/balances.go'), 'utf8');
  assert.ok(handler.includes('func (h *Handler) providerBalances'),
    'balances.go must define the handler');
  // ⚠️ 路径不得叫 `/balance`：那个形状被 balance_capability_test.go 当作
  // 「逐账号额度端点」枚举，混进去会把合计端点误读成一个渠道。
  assert.ok(!/r\.Get\("\/balance"/.test(register),
    'the aggregate endpoint must NOT be registered as /balance (capability guard walks that shape)');
  const summary = fs.readFileSync(path.join(ROOT, 'internal/jethub/balance_summary.go'), 'utf8');
  assert.ok(summary.includes('func (m *Manager) BalanceSummaryOf'),
    'balance_summary.go must define the aggregation entry point');
});

check('monitor_quota.js renders the reading slot and reuses the shared formatter', () => {
  const src = read(STATIC + 'monitor/monitor_quota.js');
  assert.ok(src.includes('class="quota-provider-balance"'), 'provider cell must carry the reading slot');
  assert.ok(src.includes('quota-td-provider'), 'provider cell must be addressable for patching');
  assert.ok(src.includes("apiGet('/jethub/balances')"), 'must fetch the aggregate endpoint');
  assert.ok(src.includes('__jethubFormatUnits'),
    'must reuse jethub.js formatters (single source of the token/credit wording)');
  // 反向：不得在 Monitor 里另写一份 M/K 口径（两份实现必然漂移）。
  assert.ok(!/toFixed\(2\)\s*\+\s*'M'/.test(src),
    'must not re-implement the M-suffix formatting in monitor_quota.js');
  // 60s 节流 + 搭既有 1s 节奏（不为它单开定时器）。
  assert.ok(src.includes('PROVIDER_BALANCE_TTL'), 'refresh must be throttled');
  assert.ok(src.includes('providerBalanceTick();'), 'the tick must be driven by the existing cadence');
});

check('style-monitor.css sizes the reading two notches smaller and hides empty slots', () => {
  const css = read(STATIC + 'style-monitor.css');
  const rule = css.match(/\.quota-table \.quota-provider-balance\{[^}]*\}/);
  assert.ok(rule, 'missing .quota-provider-balance rule');
  assert.ok(rule[0].includes('font-size:var(--font-badge)'),
    'font must be --font-badge (2.5px below --font-base, scales with the font-size setting)');
  assert.ok(css.includes('.quota-table .quota-provider-balance:empty{display:none}'),
    'an empty slot must not leave a 6px gap');
});

check('i18n defines both new keys in BOTH en and cn dictionaries', () => {
  const src = read(STATIC + 'i18n.js');
  for (const key of ['quotaProviderBalanceTitle', 'quotaProviderBalancePartial']) {
    const count = (src.match(new RegExp(key + ':', 'g')) || []).length;
    assert.strictEqual(count, 2, key + ' must exist exactly twice (en + cn), got ' + count);
  }
});

check('both index variants load jethub.js BEFORE monitor_quota.js', () => {
  // 依赖关系：Monitor 用的是 jethub.js 里的格式化函数，顺序颠倒会静默不显示。
  for (const f of ['static/index.html', 'static/index-nopg.html']) {
    const html = read(f);
    const jethub = html.indexOf('<script src="/jethub.js"></script>');
    const quota = html.indexOf('<script src="/monitor/monitor_quota.js"></script>');
    assert.ok(jethub !== -1 && quota !== -1, f + ': missing script tags');
    assert.ok(jethub < quota, f + ': jethub.js must load before monitor_quota.js');
  }
});

// --- 2. behavior (real monitor_quota.js + real formatters from jethub.js) ---

// extractFunction pulls a top-level function verbatim out of a source file by
// brace matching (⚠️ 只对这些无花括号字面量的小函数用).
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function not found: ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

function makeSpan() {
  return {
    textContent: '', title: '',
    removeAttribute(attr) { if (attr === 'title') this.title = ''; },
  };
}

function makeSandbox(providers, balances, cells) {
  const sandbox = {
    console,
    // i18n stub keeps the placeholder visible in assertions.
    t: (key, args) => key + (args ? ':' + args.join(',') : ''),
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    providersCache: providers,
    providerBalances: balances,
    currentPage: 'monitor',
    document: { visibilityState: 'visible', querySelectorAll: () => cells },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const jethubSrc = read(STATIC + 'jethub.js');
  const formatters = ['__jethubFormatTokens', '__jethubFormatNumber', '__jethubFormatUnits']
    .map((name) => extractFunction(jethubSrc, name)).join('\n');
  vm.runInContext(formatters, sandbox, { filename: 'jethub-formatters.js' });
  vm.runInContext(read(STATIC + 'monitor/monitor_quota.js'), sandbox, { filename: 'monitor_quota.js' });
  return sandbox;
}

const ZCODE_PROVIDERS = [
  { id: 'jethub-zcode', name: 'ZCode (智谱)', apiType: 'jethub' },
  { id: 'p1', name: 'MyOpenAI', apiType: 'openai-compatible' },
];

check('token quota renders as M with two decimals and NO unit word', () => {
  const sb = makeSandbox(ZCODE_PROVIDERS, {
    zcode: { groups: [{ unit: 'token', total: 30095000 }], okCount: 2, failedCount: 0 },
  }, []);
  const reading = sb.providerBalanceReading('ZCode (智谱)');
  assert.ok(reading, 'a token reading must be produced');
  assert.strictEqual(reading.text, '30.09M');
  assert.ok(!/token/i.test(reading.text), 'the word "Token" must not appear');
});

check('credit balance renders as a plain number (no decimals when integral)', () => {
  const sb = makeSandbox(
    [{ id: 'jethub-lobsterai', name: 'LobsterAI (有道)', apiType: 'jethub' }],
    { lobsterai: { groups: [{ unit: 'credit', total: 3000 }], okCount: 1, failedCount: 0 } },
    []);
  assert.strictEqual(sb.providerBalanceReading('LobsterAI (有道)').text, '3000');
  sb.providerBalances.lobsterai.groups[0].total = 2066.84;
  assert.strictEqual(sb.providerBalanceReading('LobsterAI (有道)').text, '2066.84');
});

check('resolution is by provider DTO, never by name alone', () => {
  const sb = makeSandbox(ZCODE_PROVIDERS, {
    zcode: { groups: [{ unit: 'token', total: 1000000 }], okCount: 1, failedCount: 0 },
  }, []);
  // 普通 API Key 渠道即使名字撞上也不显示（它没有 Free Hub 账号池）。
  assert.strictEqual(sb.providerBalanceReading('MyOpenAI'), null);
  assert.strictEqual(sb.jethubProviderIdOf('MyOpenAI'), '');
  assert.strictEqual(sb.jethubProviderIdOf('ZCode (智谱)'), 'zcode');
  // 未知 provider（已被删除/重命名）⇒ 无读数，而不是猜。
  assert.strictEqual(sb.providerBalanceReading('Nope'), null);
  // 没有该渠道的读数（未拉到 / 全部账号失败 / groups 为空）⇒ 无读数。
  assert.strictEqual(sb.providerBalanceReading('ZCode (智谱)') !== null, true);
  sb.providerBalances = {};
  assert.strictEqual(sb.providerBalanceReading('ZCode (智谱)'), null);
});

check('failed accounts are surfaced in the tooltip, never folded into the number', () => {
  const sb = makeSandbox(ZCODE_PROVIDERS, {
    zcode: { groups: [{ unit: 'token', total: 1000000 }], okCount: 1, failedCount: 2 },
  }, []);
  const reading = sb.providerBalanceReading('ZCode (智谱)');
  assert.strictEqual(reading.text, '1.00M', 'the number must stay the sum of READ accounts only');
  assert.ok(reading.title.includes('quotaProviderBalancePartial:2'),
    'the incomplete sum must be stated in the tooltip: ' + reading.title);
});

check('mixed units show the first group and keep all groups in the tooltip', () => {
  // 极罕见（同一渠道的账号分属两种量纲）：单元格不并排堆数字，但 title 里全都有。
  const sb = makeSandbox(ZCODE_PROVIDERS, {
    zcode: { groups: [{ unit: 'token', total: 30000000 }, { unit: 'credit', total: 3000 }], okCount: 2, failedCount: 0 },
  }, []);
  const reading = sb.providerBalanceReading('ZCode (智谱)');
  assert.strictEqual(reading.text, '30.00M');
  assert.ok(reading.title.includes('30.00M · 3000'), 'both groups must appear in the tooltip: ' + reading.title);
});

check('updateProviderBalanceCells fills live rows and clears stale ones', () => {
  const providers = [
    { id: 'jethub-zcode', name: 'ZCode (智谱)', apiType: 'jethub' },
    { id: 'jethub-cline', name: 'Cline (Free Hub)', apiType: 'jethub' },
  ];
  const balances = { zcode: { groups: [{ unit: 'token', total: 94539275 }], okCount: 1, failedCount: 0 } };
  const cells = [['ZCode (智谱)'], ['Cline (Free Hub)']].map(([p]) => {
    const span = makeSpan();
    return { getAttribute: () => p, querySelector: () => span, _span: span };
  });
  const sb = makeSandbox(providers, balances, cells);
  sb.updateProviderBalanceCells();
  assert.strictEqual(cells[0]._span.textContent, '94.54M');
  assert.ok(cells[0]._span.title.includes('quotaProviderBalanceTitle:94.54M'));
  // 第二个渠道没有读数（例如账号全被停用）⇒ 空槽（CSS 的 :empty 会隐藏它）。
  assert.strictEqual(cells[1]._span.textContent, '');

  // 读数消失后必须**清空**旧数字：残留的旧值比空白更误导（渠道被删/停用时）。
  cells[0]._span.textContent = '94.54M';
  cells[0]._span.title = 'stale';
  sb.providerBalances = {};
  sb.updateProviderBalanceCells();
  assert.strictEqual(cells[0]._span.textContent, '');
  assert.strictEqual(cells[0]._span.title, '');
});

// --- run ---

for (const [name, fn] of checks) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (e) {
    failures++;
    console.log('  FAIL ' + name + '\n       ' + (e && e.message));
  }
}
console.log(failures === 0
  ? '\nall ' + checks.length + ' checks passed'
  : '\n' + failures + '/' + checks.length + ' checks FAILED');
process.exit(failures === 0 ? 0 : 1);
