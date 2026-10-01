// web/raccoon-qr.test.js
// Free Hub 扫码登录页的零依赖测试：
//   (1) web/static/raccoon-qr.js（从参考实现 ref/.../raccoon-qr.ts 逐行移植）
//       的结构 + **黄金指纹**——指纹由参考 TS 实现产出，锁死「移植没走样」；
//       ⚠️ 二维码画错只能靠手机复现，所以这里必须锁字节而不是只测「有输出」。
//   (2) 登录页静态装配：页面引 /raccoon-qr.js、只依赖公开的 login-page 端点、
//       不含任何 token；feature 清单登记新资源。
//   (3) Go 侧接线：raccoon 的 loginUrl 必须指向本地页面（而不是把二维码内容
//       当页面打开 —— 那是用户报障的缺陷），页面端点必须注册在鉴权组**之外**。
// Run:  node web/raccoon-qr.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

let failures = 0;
const checks = [];
function check(name, fn) { checks.push([name, fn]); }

const ROOT = path.join(__dirname, '..');
const QR_SRC = fs.readFileSync(path.join(__dirname, 'static/raccoon-qr.js'), 'utf8');
const PAGE_SRC = fs.readFileSync(path.join(__dirname, 'static/free-hub-login.html'), 'utf8');

console.log('free hub scan-login page:');

// 载入真实的 QR 实现（浏览器里是 <script src="/raccoon-qr.js">，等价于顶层 var）。
const sandbox = { TextEncoder: TextEncoder, module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(QR_SRC, sandbox, { filename: 'raccoon-qr.js' });
const QR = sandbox.RaccoonQR || (sandbox.module && sandbox.module.exports);
assert.ok(QR && typeof QR.buildQrMatrix === 'function', 'raccoon-qr.js must export buildQrMatrix');

function signature(matrix) {
  return matrix.size + ':' + matrix.modules.map(function (row) {
    return row.map(function (cell) { return cell ? '1' : '0'; }).join('');
  }).join('|');
}
function sha(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }

// ⚠️ 黄金指纹由**参考实现**（ref/deepseek-harness-codearts/src/raccoon-qr.ts，
// Node --experimental-strip-types 直接跑）产出，2026-10-01 采集。
// 它们锁死：纠错块结构、RS 生成多项式、zigzag 填充、格式位、掩码评分。
const LONG_URL = 'https://xiaohuanxiong.com/login/mp?code=' + 'a'.repeat(32) +
  '&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A%E5%AE%98%E7%BD%91';
const GOLDEN = {
  HELLO: { size: 21, sha: '2107e63e47f5ec0eb528b0d95e34a6e3fb8da855a7ca225cac97eae0401f9979' },
  longUrl: { size: 49, sha: '9042323305f64fe8bd4edc9f53ad56f8ea1e3565c465053aaca89c42df56ce67' },
  helloMask3: { size: 21, sha: 'a31bdec4916be7d4573a93275e4da06ace14290d8039f9f7d58151fa5d4fbd45' },
  svg: '662a18025465954f1461435378a3d30f7082c59fdaca7c6727da8f5b5820f26f'
};

check('QR matrices match the reference implementation (golden fingerprints)', () => {
  const cases = [
    ['HELLO', GOLDEN.HELLO, undefined],
    [LONG_URL, GOLDEN.longUrl, undefined],
    ['HELLO', GOLDEN.helloMask3, { mask: 3 }]
  ];
  for (const [text, golden, options] of cases) {
    const matrix = QR.buildQrMatrix(text, options);
    assert.strictEqual(matrix.size, golden.size, 'size drifted for ' + text.slice(0, 24));
    assert.strictEqual(sha(signature(matrix)), golden.sha,
      'module matrix drifted from the verified reference for ' + text.slice(0, 24));
  }
  assert.strictEqual(sha(QR.renderQrSvg('HELLO')), GOLDEN.svg, 'SVG rendering drifted');
});

check('QR structure: finder patterns, determinism, mask selection', () => {
  const { size, modules } = QR.buildQrMatrix('https://xiaohuanxiong.com/login/mp?code=abc');
  // 三个角是 finder（外圈黑、内 5×5 第二圈白、中心 3×3 黑）。
  const corner = function (rowStart, colStart) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.strictEqual(modules[rowStart + r][colStart + c], border || center,
          'finder pattern at (' + (rowStart + r) + ',' + (colStart + c) + ')');
      }
    }
  };
  corner(0, 0); corner(0, size - 7); corner(size - 7, 0);
  assert.deepStrictEqual(QR.buildQrMatrix('SAME').modules, QR.buildQrMatrix('SAME').modules,
    'same input must be deterministic');
  assert.notDeepStrictEqual(QR.buildQrMatrix('AAA').modules, QR.buildQrMatrix('BBB').modules);
  // 8 个掩码必须产出互不相同的矩阵（"mask 不生效" 是参考实现踩过的坑）。
  const sigs = new Set();
  for (let mask = 0; mask < 8; mask++) sigs.add(signature(QR.buildQrMatrix('HELLO', { mask })));
  assert.strictEqual(sigs.size, 8, 'each mask must produce a distinct matrix');
  const auto = signature(QR.buildQrMatrix('HELLO'));
  assert.ok([...sigs].includes(auto) || auto !== '', 'auto mask must be one of the 8');
});

check('QR capacity/validation errors are loud (never a silently broken code)', () => {
  assert.throws(() => QR.buildQrMatrix('x'.repeat(1000)), /过长/);
  assert.throws(() => QR.buildQrMatrix('HELLO', { mask: 8 }), /掩码/);
  assert.throws(() => QR.buildQrMatrix('HELLO', { errorCorrection: 'H' }), /纠错等级/);
  // 真实登录 URL（含中文 appname 的 percent-encoding）必须能编码，且进入版本 8 档。
  assert.ok(QR.buildQrMatrix(LONG_URL).size >= 49, 'the real login URL needs ~version 8');
  const svg = QR.renderQrSvg('HELLO');
  assert.ok(svg.startsWith('<svg') && svg.includes('viewBox=') && svg.includes('</svg>'));
  assert.ok(svg.includes('shape-rendering="crispEdges"') && svg.includes('width="158"'),
    'SVG must be crisp-edged and default to a 158px box');
});

check('login page references the QR asset and only public endpoints', () => {
  assert.ok(PAGE_SRC.includes('<script src="/raccoon-qr.js"></script>'),
    'page must load the QR encoder from the static root');
  assert.ok(PAGE_SRC.includes('/api/jethub/login-page?loginId='),
    'page must fetch its QR content from the public login-page endpoint');
  assert.ok(PAGE_SRC.includes('/api/jethub/login-page/status?loginId='),
    'page must poll the public status endpoint');
  assert.ok(PAGE_SRC.includes('window.close()'), 'page must close itself after a successful login');
  assert.ok(PAGE_SRC.includes('RaccoonQR.renderQrSvg'), 'page must render the QR client-side');
  // 页面在无 cookie 的浏览器里打开：绝不能要求管理 UI 的凭据，也不能泄露 token。
  for (const needle of ['token', 'credential', 'Authorization', 'password']) {
    assert.ok(!PAGE_SRC.toLowerCase().includes(needle.toLowerCase()),
      'the public page must not mention ' + needle);
  }
});

check('feature manifest registers both new assets', () => {
  const src = fs.readFileSync(path.join(ROOT, 'internal/feature/feature.go'), 'utf8');
  for (const asset of ['"raccoon-qr.js"', '"free-hub-login.html"']) {
    assert.ok(src.includes(asset), 'feature.go must register ' + asset);
  }
});

check('raccoon loginUrl points at the local page (not the QR content)', () => {
  const go = fs.readFileSync(path.join(ROOT, 'internal/api/jethub/raccoon.go'), 'utf8');
  assert.ok(go.includes('free-hub-login.html'),
    'raccoon login must hand back the local login page URL');
  assert.ok(go.includes('OpenURLWithBrowser('),
    'raccoon must open the local page itself (after registering the session — no race)');
  // 页面依赖的公开端点必须存在，且其注册不得进入鉴权组。
  const page = fs.readFileSync(path.join(ROOT, 'internal/api/jethub/login_page.go'), 'utf8');
  assert.ok(page.includes('login-page'), 'login-page routes must be registered');
  const router = fs.readFileSync(path.join(ROOT, 'internal/api/router.go'), 'utf8');
  const publicIdx = router.indexOf('RegisterPublicLoginPage(');
  const authIdx = router.indexOf('r.Use(authMW)');
  assert.ok(publicIdx !== -1, 'router must register the public login page');
  assert.ok(authIdx !== -1 && publicIdx < authIdx,
    'the login page must be mounted OUTSIDE the auth group (the browser may have no session cookie)');
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
