// web/textreview-dedup-split.test.js
// Contract tests for Text Review Step2 dedup + bare-num split + AI candidate split.
// Loads the REAL modules (split + dedup) in a sandboxed VM — no DOM, no browser.
//
// Run:  node web/textreview-dedup-split.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (err) {
    failures++;
    console.error('FAIL  ' + name + ': ' + (err && err.message));
  }
}

function loadModule(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const sandbox = { window: {} };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: rel });
  return sandbox.window;
}

const splitW = loadModule('static/utility/editor/editor_textreview_split.js');
const dedupW = loadModule('static/utility/editor/editor_textreview_dedup.js');
const TR = splitW.TR;
const TD = dedupW.TRDedup;

// --- helpers ---------------------------------------------------------

function lines(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((prefix || '正文行') + i + '：' + '内容内容内容内容内容');
  return out;
}

// --- bare-num preset -------------------------------------------------

check('bare-num preset exists and compiles', () => {
  const found = TR.DEFAULT_SPLIT_PATTERNS.find((p) => p.key === 'bare-num');
  assert.ok(found, 'bare-num missing');
  assert.strictEqual(found.regex, '^(\\d{1,4})$');
  const compiled = TR.compilePatterns(TR.DEFAULT_SPLIT_PATTERNS);
  const rt = compiled.find((p) => p.key === 'bare-num');
  // NOTE: vm-realm RegExp fails instanceof — duck-type instead.
  assert.ok(rt.regex && typeof rt.regex.test === 'function', 'bare-num regex null');
});

check('bare-num splits pure number lines, ignores N>> refs', () => {
  const text = ['1', '', '正文正文正文', '', '2>>', '', '更多正文', '', '2', '', '尾声'].join('\n');
  const compiled = TR.compilePatterns(TR.DEFAULT_SPLIT_PATTERNS);
  const re = compiled.find((p) => p.key === 'bare-num').regex;
  const chapters = TR.splitChapters(text, re, true);
  assert.strictEqual(chapters.length, 2, JSON.stringify(chapters.map((c) => c.title)));
  assert.strictEqual(chapters[0].title, '1');
  assert.strictEqual(chapters[1].title, '2');
  assert.ok(chapters[0].content.includes('2>>'), 'N>> ref must stay inside chapter');
});

check('bare-num auto-detect hits pure numbers only', () => {
  const text = ['1', '', '正文', '', '3>>', '', '2', '', '17:03 时间正文'].join('\n');
  const res = TR.detectChapterPattern(text, TR.DEFAULT_SPLIT_PATTERNS);
  assert.strictEqual(res.patternKey, 'bare-num', JSON.stringify(res));
  assert.strictEqual(res.hitCount, 2, JSON.stringify(res));
});

// --- dedup scan/apply ------------------------------------------------

function dupText() {
  const block = lines(10, '重复块');
  return [
    '首章正文开始内容内容内容',
    ...block,
    '中间过渡段落内容内容内容内容',
    ...block.slice(), // verbatim re-paste with a gap
    '结尾段落内容内容内容内容内容',
  ].join('\n');
}

check('scan finds verbatim intra-chapter block', () => {
  const r = TD.scanDuplicates(dupText(), {});
  assert.ok(r.blocks.length >= 1, 'no blocks: ' + JSON.stringify(r.blocks.length));
  assert.strictEqual(r.blocks[0].lines, 10, JSON.stringify(r.blocks[0]));
});

check('apply keeps first copy, drops second', () => {
  const text = dupText();
  const before = text.length;
  const r = TD.scanDuplicates(text, {});
  const res = TD.applyDedup(text, r, {});
  assert.ok(res.text.length < before, 'nothing removed');
  assert.strictEqual(res.removedBlocks, r.blocks.length);
  // first copy survives exactly once
  const count = res.text.split('重复块0').length - 1;
  assert.strictEqual(count, 1, 'first copy must survive once, got ' + count);
});

check('far-apart copies (cross-chapter reuse) are reported, not removed', () => {
  const block = lines(8, '面板技能');
  const filler = lines(2100, '填充');
  const text = [...block, ...filler, ...block.slice()].join('\n');
  const r = TD.scanDuplicates(text, {});
  assert.strictEqual(r.blocks.length, 0, 'cross-chapter reuse must not be a block');
  assert.ok(r.singleLineGroups > 0, 'should still count single-line groups');
});

check('ad lines detected and removed', () => {
  const text = ['正文正文正文内容', '将705u.com设为首页，每天第一时间获取更新。', '更多正文内容内容'].join('\n');
  const r = TD.scanDuplicates(text, {});
  assert.strictEqual(r.adLines.length, 1, JSON.stringify(r.adLines));
  const res = TD.applyDedup(text, r, {});
  assert.strictEqual(res.removedAdLines, 1);
  assert.ok(!res.text.includes('705u.com'), 'ad must be gone');
  assert.ok(res.text.includes('更多正文'), 'prose must survive');
});

check('short single-line reuse is never deleted', () => {
  const text = ['把玩了片刻之后，鸫江坐回了王座之上。', '中间正文内容内容内容', '把玩了片刻之后，鸫江坐回了王座之上。'].join('\n');
  const r = TD.scanDuplicates(text, {});
  assert.strictEqual(r.blocks.length, 0, 'single lines must not form blocks');
  const res = TD.applyDedup(text, r, {});
  assert.strictEqual(res.text, text, 'text must be unchanged');
});

// --- AI candidate split ----------------------------------------------

check('extractSplitCandidates keeps short isolated lines, drops prose', () => {
  const longProse = '这是一个超过六十个字符的很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的正文段落，不应成为候选行。';
  assert.ok(longProse.length > 60, 'test prose must exceed cap, got ' + longProse.length);
  const text = ['45', '', longProse, '', '短引用行', '', '46'].join('\n');
  const c = TR.extractSplitCandidates(text, {});
  const nos = c.lines.map((l) => l.no);
  assert.ok(nos.includes(1), 'bare 45 must be candidate: ' + JSON.stringify(nos));
  assert.ok(nos.includes(7), 'bare 46 must be candidate: ' + JSON.stringify(nos));
  assert.ok(!c.lines.some((l) => l.text.includes('超过六十个字符')), 'long prose must be filtered');
});

check('aiSplitChapters splits on model-returned line numbers', () => {
  const text = ['45', '', '正文甲', '', '46', '', '正文乙'].join('\n');
  const c = TR.extractSplitCandidates(text, {});
  const chapters = TR.aiSplitChapters(text, c, '模型判断结果为 [1, 5]，以上。', true);
  assert.ok(chapters && chapters.length === 2, JSON.stringify(chapters && chapters.map((x) => x.title)));
  assert.strictEqual(chapters[0].title, '45');
  assert.strictEqual(chapters[1].title, '46');
});

check('aiSplitChapters returns null on garbage model output', () => {
  const text = ['45', '', '正文甲'].join('\n');
  const c = TR.extractSplitCandidates(text, {});
  assert.strictEqual(TR.aiSplitChapters(text, c, '无法识别', true), null);
  assert.strictEqual(TR.aiSplitChapters(text, c, '[99999]', true), null);
});

check('inline trailing digits (amounts/times) are not chapters', () => {
  const compiled = TR.compilePatterns(TR.DEFAULT_SPLIT_PATTERNS);
  const re = compiled.find((p) => p.key === 'bare-num').regex;
  // regression: $100,043.28 / $100,417.83 trailing digits produced ghost 28/83 chapters
  for (const line of ['$100,043.28', '可用余额：$100,417.83', '第一日·傍晚 17:03', '当前篆刻魔法数量：3', '17:03']) {
    assert.strictEqual(TR.findTitleInLine(line, re), null, 'false chapter: ' + line);
  }
  const text = ['28', '', '正文', '', '　　$43.28', '', '83', '', '尾声'].join('\n');
  const chapters = TR.splitChapters(text, re, true);
  assert.strictEqual(chapters.length, 2, JSON.stringify(chapters.map((c) => c.title)));
});

check('strong title signals survive cap thinning', () => {
  // 100 bare-number chapters + 5000 weak short lines, cap 4000:
  // all 100 numbers must survive.
  const parts = [];
  for (let i = 1; i <= 100; i++) {
    parts.push(String(i), '', '弱候选短行' + i + '号内容填充');
    for (let k = 0; k < 50; k++) parts.push('', '弱弱弱' + i + '-' + k);
  }
  const text = parts.join('\n');
  const c = TR.extractSplitCandidates(text, { cap: 4000 });
  assert.ok(c.lines.length <= 4000, 'over cap: ' + c.lines.length);
  const bareNos = c.lines.filter((l) => /^\d{1,4}$/.test(l.text));
  assert.strictEqual(bareNos.length, 100, 'lost bare titles: ' + bareNos.length);
});

check('apply converges to fixpoint (no residual blocks)', () => {
  // 大块包裹子块：首轮删大块后，子块残留须被次轮清除。
  const inner = [];
  for (let i = 0; i < 40; i++) inner.push('大块行' + i + '：内容内容内容内容');
  const sub = [];
  for (let i = 0; i < 10; i++) sub.push('子块行' + i + '：内容内容内容内容内容');
  const text = [...inner, ...sub, '间隔段落内容内容内容内容', ...inner.slice(), ...sub.slice(), '结尾内容内容'].join('\n');
  const r1 = TD.scanDuplicates(text, {});
  assert.ok(r1.blocks.length >= 1, 'need blocks');
  const res = TD.applyDedup(text, r1, {});
  const r2 = TD.scanDuplicates(res.text, {});
  assert.strictEqual(r2.blocks.length, 0, 'residual blocks: ' + JSON.stringify(r2.blocks.map((b) => b.lines)));
  assert.strictEqual(r2.adLines.length, 0);
});

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
} else {
  console.log('all textreview dedup/split contracts pass');
}
