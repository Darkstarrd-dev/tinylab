// editor_textreview_dedup.js — 章节内重复块扫描与清除（纯 JS、无依赖、无构建）。
// 所有公共 API 挂到 window.TRDedup.*。与 editor_textreview_split.js 同风格：
// 顶层 'use strict' + function 声明 + 末尾 window.X = ... 赋值。
//
// 背景：盗版小说文本常把同一章节内的整段正文粘贴两遍（实测目标文本最长 148 行、
// 间隔 100~150 行），并混入站内广告行（sxsy.org / 705u.com / 书名安利）。
// 单行去重不可用：技能面板、固定台词等合法复用遍布全书（目标文本 762 组）。
//
// 机制：归一化行（去全部空白）滚动哈希、窗口 K=8 行找候选 → 双向扩展成最大块 →
// 按长度降序贪心取互不重叠块；只删后现副本（整行删除），保留首现。
// 跨章保护：两副本起点间距超过 maxGap 行（默认 2000）视为合法复用（技能面板、
// 前情提要），只报不删。广告行走独立正则整行删除。

'use strict';

/**
 * window.TRDedup API（本文件提供）：
 *   TRDedup.scanDuplicates(text, opts?) // 扫描 -> DedupReport
 *   TRDedup.applyDedup(text, report, opts?) // 应用清除 -> {text, removedBlocks, removedAdLines, removedChars}
 *   TRDedup.AD_PATTERNS // 站内广告行正则（任一命中即整行删除）
 *
 * @typedef {Object} DupBlock
 *   @property {number} aStart 首现起点行号（0-based，保留）
 *   @property {number} aEnd   首现终点行号（exclusive）
 *   @property {number} bStart 后现起点行号（0-based，删除）
 *   @property {number} bEnd   后现终点行号（exclusive）
 *   @property {number} lines  块行数（aEnd - aStart）
 *   @property {number} chars  块字符数（后现副本，用于统计）
 *   @property {string} preview 首行预览（前 60 字）
 *
 * @typedef {Object} DedupReport
 *   @property {DupBlock[]} blocks   待删重复块（按长度降序）
 *   @property {number[]} adLines    广告行号（0-based）
 *   @property {number} singleLineGroups 仅单行重复的组数（信息展示，不删除）
 *   @property {number} totalLines   全文行数
 *
 * @typedef {Object} ScanOptions
 *   @property {number} [minLines] 最小块行数，默认 8（低于此只计 singleLineGroups）
 *   @property {number} [maxGap]   两副本起点最大间距行数，默认 2000（超出视为跨章合法复用）
 *   @property {number} [minChars] 窗口最小有效字符数（去空白后），默认 40（过滤空行窗）
 */

// ===================== 广告行 =====================

/** 任一命中即整行删除。均为站内引流/安利特征串，无正文误伤（正文不会出现域名/设为首页）。 */
var AD_PATTERNS = [
  /sxsy\.org/,
  /705u\.com/,
  /设为首页/,
  /强力安利《/,
  /票选最佳/,
  /名列前茅/,
  /入驻读/,
  /第一时间获取《/,
  /文笔惊艳，情节跌宕/,
];

/**
 * 归一化一行：去全部空白后比较。容忍盗版站首行缩进/全半角空格差异，
 * 不做简繁/标点归一（避免误伤近似正文）。
 */
function dedupNormLine(s) {
  return s.replace(/\s+/g, '');
}

function isAdLine(line) {
  for (var i = 0; i < AD_PATTERNS.length; i++) {
    if (AD_PATTERNS[i].test(line)) return true;
  }
  return false;
}

// ===================== 扫描 =====================

/**
 * 扫描文本中的章节内重复块 + 广告行。
 * 时间复杂度 O(n·K)，目标文本 1.7 万行 < 100ms。
 */
function scanDuplicates(text, opts) {
  var o = opts || {};
  var K = o.minLines != null ? o.minLines : 8;
  var MAX_GAP = o.maxGap != null ? o.maxGap : 2000;
  var MIN_CHARS = o.minChars != null ? o.minChars : 40;
  if (K < 2) K = 2;

  var lines = String(text || '').split(/\r?\n/);
  var n = lines.length;
  var norm = new Array(n);
  for (var i = 0; i < n; i++) norm[i] = dedupNormLine(lines[i]);

  // 广告行：独立收集（不参与块匹配，避免广告行把两个块连成超大块）
  var adFlags = new Array(n);
  var adLines = [];
  for (var ai = 0; ai < n; ai++) {
    var ad = isAdLine(lines[ai]);
    adFlags[ai] = ad;
    if (ad) adLines.push(ai);
  }

  // K 行滑动窗口 → 候选对。含广告行的窗口跳过；有效字符不足的窗口跳过。
  var winMap = Object.create(null);
  for (var s = 0; s + K <= n; s++) {
    var chars = 0;
    var hasAd = false;
    for (var j = 0; j < K; j++) {
      if (adFlags[s + j]) { hasAd = true; break; }
      chars += norm[s + j].length;
    }
    if (hasAd || chars < MIN_CHARS) continue;
    var key = norm.slice(s, s + K).join('\n');
    if (key.length < MIN_CHARS) continue;
    if (!winMap[key]) winMap[key] = [];
    winMap[key].push(s);
  }

  // 双向扩展成最大块
  function extend(a, b) {
    var f = K;
    while (a + f < n && b + f < n && !adFlags[a + f] && !adFlags[b + f] && norm[a + f] === norm[b + f]) f++;
    var w = 0;
    while (a - w - 1 >= 0 && b - w - 1 >= 0 && !adFlags[a - w - 1] && !adFlags[b - w - 1] && norm[a - w - 1] === norm[b - w - 1]) w++;
    return [a - w, b - w, f + w];
  }

  var cands = [];
  for (var k in winMap) {
    var v = winMap[k];
    if (v.length < 2) continue;
    for (var x = 0; x < v.length; x++) {
      for (var y = x + 1; y < v.length; y++) {
        // 同一窗口自配对必 gap=0；跨副本 gap 过大直接丢（跨章复用）
        if (v[y] - v[x] > MAX_GAP) continue;
        var e = extend(v[x], v[y]);
        if (e[2] >= K) cands.push(e);
      }
    }
  }

  // 按长度降序贪心取互不重叠块（a/b 任一端重叠即跳过）
  cands.sort(function (p, q) { return q[2] - p[2]; });
  var takenA = [];
  var takenB = [];
  function overlaps(list, s, e) {
    for (var i = 0; i < list.length; i++) {
      if (s < list[i][1] && list[i][0] < e) return true;
    }
    return false;
  }
  var blocks = [];
  for (var c = 0; c < cands.length; c++) {
    var s1 = cands[c][0], s2 = cands[c][1], len = cands[c][2];
    var e1 = s1 + len, e2 = s2 + len;
    if (overlaps(takenA, s1, e1) || overlaps(takenB, s2, e2)) continue;
    // 后现副本若与任一已选首现重叠，同样跳过（防止删掉别人的保留副本）
    if (overlaps(takenA, s2, e2) || overlaps(takenB, s1, e1)) continue;
    takenA.push([s1, e1]);
    takenB.push([s2, e2]);
    var bChars = 0;
    for (var li = s2; li < e2; li++) bChars += lines[li].length;
    blocks.push({
      aStart: s1, aEnd: e1, bStart: s2, bEnd: e2,
      lines: len, chars: bChars,
      preview: (lines[s1] || '').trim().slice(0, 60),
    });
  }

  // 单行重复组数（信息展示）：非空归一化行出现 ≥2 次且未被块覆盖
  var lineCount = Object.create(null);
  for (var li2 = 0; li2 < n; li2++) {
    var t = norm[li2];
    if (t.length < 10) continue;
    lineCount[t] = (lineCount[t] || 0) + 1;
  }
  var singleGroups = 0;
  for (var kk in lineCount) {
    if (lineCount[kk] >= 2) singleGroups++;
  }

  return { blocks: blocks, adLines: adLines, singleLineGroups: singleGroups, totalLines: n };
}

// ===================== 应用 =====================

/**
 * 应用清除：删除后现副本行 + 广告行，返回新文本与统计。
 * 删除按行号降序标记，一次遍历完成；空行不单独计数。
 * 迭代至不动点：首轮贪心选大块后可能留下可删子块残留（如目标文本
 * 12884/12928 残留 9 行），复扫至无新块为止（通常 2 轮；设 5 轮上限）。
 */
function applyDedup(text, report, opts) {
  var o = opts || {};
  var removeAds = o.removeAds !== false;
  var scanOpts = { minLines: o.minLines, maxGap: o.maxGap, minChars: o.minChars };
  var cur = String(text || '');
  var r = report;
  var totalBlocks = 0;
  var totalAds = 0;
  var removedChars = 0;
  for (var round = 0; round < 5; round++) {
    if (!r) r = scanDuplicates(cur, scanOpts);
    var lines = cur.split(/\r?\n/);
    var drop = new Array(lines.length);
    for (var i = 0; i < drop.length; i++) drop[i] = false;
    var blocks = r.blocks || [];
    for (var b = 0; b < blocks.length; b++) {
      for (var li = blocks[b].bStart; li < blocks[b].bEnd && li < drop.length; li++) {
        drop[li] = true;
      }
    }
    var adDropped = 0;
    if (removeAds) {
      var ads = r.adLines || [];
      for (var a = 0; a < ads.length; a++) {
        if (ads[a] >= 0 && ads[a] < drop.length && !drop[ads[a]]) {
          drop[ads[a]] = true;
          adDropped++;
        }
      }
    }
    if (!blocks.length && !adDropped) break;
    totalBlocks += blocks.length;
    totalAds += adDropped;
    var out = [];
    for (var k = 0; k < lines.length; k++) {
      if (drop[k]) removedChars += lines[k].length;
      else out.push(lines[k]);
    }
    cur = out.join('\n');
    r = null; // 复扫本轮产物
    if (!blocks.length) break;
  }
  return {
    text: cur,
    removedBlocks: totalBlocks,
    removedAdLines: totalAds,
    removedChars: removedChars,
  };
}

// ===================== exported API =====================

window.TRDedup = window.TRDedup || {};
window.TRDedup.AD_PATTERNS = AD_PATTERNS;
window.TRDedup.scanDuplicates = scanDuplicates;
window.TRDedup.applyDedup = applyDedup;
window.TRDedup.isAdLine = isAdLine;
