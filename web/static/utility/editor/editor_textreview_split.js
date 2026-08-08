// editor_textreview_split.js — 章节切分算法（移植自 novelhelper/frontend/src/utils/split.ts）。
// 纯 JS、无依赖、无构建。所有公共 API 挂到 window.TR.*。
// 与 editor.js 同风格：顶层 'use strict' + function 声明 + 末尾 window.X = ... 赋值。

'use strict';

/**
 * window.TR API（本文件提供）：
 *   TR.compilePatterns(stored)        // 存储形 SplitPattern[] -> 运行时 SplitPattern[]（regex 编译为行内搜索形 RegExp|null）
 *   TR.detectChapterPattern(text, stored)  // 自动检测最匹配的章节模式 -> DetectResult
 *   TR.detectLeadingChapterTitle(content, stored) // 检测文本开头是否章节标题行 -> {title,content}|null
 *   TR.splitChapters(text, regex, keepPrologue, options?) // 按行扫描切分 -> SplitResult[]
 *   TR.toSearchRegex(source, flags?)  // 存储形正则（带 ^）-> 行内搜索形 RegExp|null
 *   TR.applyTitleTemplate(results, template, opts?) // 批量应用章节标题模板
 *   TR.retentionRate(before, after)  // 字符保留率
 *   TR.stripChapterMarker(title)      // 剥除章号标记 -> 纯章名
 *   TR.normalizeParagraphs(content)   // 段落格式化
 *   TR.findTitleInLine(line, searchRegex) // 行内查找章节标题 -> TitleHit|null
 *   TR.DEFAULT_SPLIT_PATTERNS         // 内置默认模式池（存储形，regex 为字符串）
 *   TR.PRESET_PATTERNS                // 编译后的预设列表（regex 为 RegExp|null）
 *
 * @typedef {Object} StoredSplitPattern
 *   @property {string} key
 *   @property {string} label
 *   @property {string} regex
 *   @property {string} [flags]
 *   @property {boolean} [builtin]
 *
 * @typedef {Object} SplitPattern 运行时形态：regex 已编译为行内搜索形 RegExp（custom 为 null）
 *   @property {string} key
 *   @property {string} label
 *   @property {RegExp|null} regex
 *   @property {string} [flags]
 *   @property {boolean} [builtin]
 *
 * @typedef {Object} SplitResult
 *   @property {string} title
 *   @property {string} content
 *   @property {boolean} [isVolume] 卷标题行单独成章标记（Step3 跳过 LLM 清理）
 *
 * @typedef {Object} TitleHit
 *   @property {number} index 标题在行内的起始偏移（stripDecor 后的坐标系）
 *   @property {string} prefix 标题前文字（归入上一章）
 *   @property {string} title 标题文本（已截断 TITLE_MAX）
 *
 * @typedef {Object} DetectResult
 *   @property {string} patternKey 推荐模式 key（无命中时返回 'custom'）
 *   @property {number} hitCount 命中行数
 *   @property {number} confidence 0~1
 *   @property {string} reason 给 UI 的说明
 *   @property {string[]} sampledTitles 抽样命中标题（前 5 个，已剥前缀）
 *
 * @typedef {Object} SplitOptions
 *   @property {boolean} [stripDecorPrefix] 保留旧签名占位；装饰前缀剥除是核心行为不可关闭
 *   @property {boolean} [normalize] 是否对每章 content 跑 normalizeParagraphs，默认 true
 */

// ===================== 内置默认模式池（存储形） =====================

var DEFAULT_SPLIT_PATTERNS = [
  { key: 'zhang',   label: '第X章（中文/阿拉伯数字）', regex: '^(第[0-9零一二三四五六七八九十百千万]+章.*)', builtin: true },
  { key: 'hui',     label: '第X回',   regex: '^(第[0-9零一二三四五六七八九十百千万]+回.*)', builtin: true },
  { key: 'juan',    label: '第X卷',   regex: '^(第[0-9零一二三四五六七八九十百千万]+卷.*)', builtin: true },
  { key: 'jie',     label: '第X节',   regex: '^(第[0-9零一二三四五六七八九十百千万]+节.*)', builtin: true },
  { key: 'x-zhang', label: 'X章（无「第」字）', regex: '^([0-9零一二三四五六七八九十百千万]+章.*)', builtin: true },
  { key: 'chapter', label: 'Chapter N（英文）', regex: '^(chapter\\s+[0-9ivxlc]+.*)', flags: 'i', builtin: true },
  { key: 'dunhao',  label: '数字+顿号（3、标题）', regex: '^(\\d{1,4}、.*)', builtin: true },
  { key: 'maohao',  label: '数字+冒号（001：标题）', regex: '^(\\d{1,4}[:：].*)', builtin: true },
  { key: 'custom',  label: '自定义正则', regex: '', builtin: true },
];

// ===================== 常量 =====================

/** 内置卷正则（旁路识别卷行，独立于用户当前选的模式）—— 存储形（带 ^），转搜索形时用 */
var VOLUME_SOURCE = '^(第[0-9零一二三四五六七八九十百千万]+卷.*)';

/**
 * 散落装饰符号（爱心/星号/方框/序号圈/书名号/括号 + 空白），均为 BMP 范围。
 * 含全角空格（\u3000）、连续星号/方块等排版干扰符。
 */
var DECOR_SYMBOLS = /^[\s☆★◆●○■□※▪♦♥♠♣①-⑳Ⅰ-Ⅻ【】\u005B\u005D「」『』《》（）()\u2600-\u27BF\u2B00-\u2BFF]+/;

/** 行首图形 emoji（astral plane，如 👍🎉）—— 属性转义，避开代理对范围 */
var DECOR_EMOJI = /^\p{Extended_Pictographic}+/u;

/** 行首变体选择符（U+FE00–FE0F，不可见格式字符）—— 属性转义，避开 combining mark 字符类 */
var DECOR_VS = /^\p{Variation_Selector}+/u;

/**
 * 剥除标题行前的装饰前缀。成对包裹块（【】（）等）整体剥除，
 * 散落符号/emoji/变体选择符逐类剥除。反复迭代至稳定。
 */
var DECOR_BLOCK = /^(\[[^\]]*\]|【[^】]*】|（[^）]*）|\([^)]*\)|「[^」]*」|『[^』]*』|《[^》]*》)/;

function stripDecor(s) {
  var out = s;
  // 反复剥：每轮先剥成对包裹块、emoji、变体选择符、散落符号；都不再变化时停止
  for (var i = 0; i < 10; i++) {
    var before = out;
    out = out.replace(DECOR_BLOCK, '');
    out = out.replace(DECOR_EMOJI, '');
    out = out.replace(DECOR_VS, '');
    out = out.replace(DECOR_SYMBOLS, '');
    if (out === before) break;
  }
  return out;
}

// ===================== 正则编译 =====================

/**
 * 把存储形正则（带 ^）转成「行内搜索形」编译。
 * 剥掉开头的 `^` 锚（若有），其余原样。`flags` 透传。
 * 编译失败返回 null。
 */
function toSearchRegex(source, flags) {
  if (!source) return null;
  // 去掉开头的 ^ 锚（可能前后有空白/分组起点的细微差异，统一处理行首锚）
  var stripped = source.replace(/^\s*\^/, '');
  try {
    return new RegExp(stripped, flags);
  } catch (e) {
    return null;
  }
}

/**
 * 把存储形态（regex 字符串）编译为运行时形态（regex 为行内搜索形 RegExp）。
 * custom 模式或编译失败 → regex 为 null。
 */
function compilePatterns(stored) {
  return stored.map(function (p) {
    if (p.key === 'custom' || !p.regex) return Object.assign({}, p, { regex: null });
    return Object.assign({}, p, { regex: toSearchRegex(p.regex, p.flags) });
  });
}

/** 兼容旧 import：从默认池编译出含 RegExp 的预设列表（custom 在末尾，regex 为 null） */
var PRESET_PATTERNS = compilePatterns(DEFAULT_SPLIT_PATTERNS);

// ===================== 切分结果类型 =====================

var TITLE_MAX = 50;

/**
 * 句末标点（标题前若是这些字符之一，则视为上一章正文自然结束、标题可在此截断开新章）。
 * 用于区分「正文自然结束 + 标题粘连」与「正文引用第N章」（如「他翻到第三章」）。
 * 前一字符非句末标点时，命中判为正文引用、不切分。
 *
 * 含中文成对引号的**闭引号**（U+201D ” / U+2019 ’）：中文小说对话常以「～"」「。"」收尾后
 * 紧跟下一章标题（如 `…幸运观众～"第2章 名为日常的崩坏`），闭引号等同于句末标点。
 * 开引号（U+201C “ / U+2018 ‘）不加入——开引号后接标题意味着对话刚开头，非章节边界。
 */
var SENTENCE_END = new Set('。！？!?…」』)）"』】》>.;\u201D\u2019');

/**
 * 在一行内查找章节标题。返回 {index, prefix, title} 或 null。
 *
 * 边界护栏：命中若在行内非开头位置（index > 0），要求前一字符是句末标点
 * （见 SENTENCE_END），否则判为正文引用（如「他翻到第三章」）、返回 null。
 * 命中在 index 0 = 干净标题行（stripDecor 后），直接通过。
 *
 * 标题捕获组：优先 m[1]（首个捕获组，预设正则均含），否则 m[0]。
 */
function findTitleInLine(line, searchRegex) {
  var m = line.match(searchRegex);
  if (!m || typeof m.index !== 'number') return null;
  var idx = m.index;
  // 行内非开头位置：必须有句末标点背书，否则判正文引用
  if (idx > 0) {
    var prev = line[idx - 1];
    if (!SENTENCE_END.has(prev)) return null;
  }
  var rawTitle = (m[1] != null ? m[1] : m[0]).replace(/\s+/g, ' ').trim();
  if (!rawTitle) return null;
  return {
    index: idx,
    prefix: line.slice(0, idx).trim(),
    title: rawTitle.slice(0, TITLE_MAX),
  };
}

/**
 * 检测文本开头是否为章节标题行（用于人工拆分后自动命名新章）。
 */
function detectLeadingChapterTitle(content, stored) {
  if (!content) return null;
  var patterns = compilePatterns(stored).filter(function (p) { return p.key !== 'custom' && p.regex; });
  // 取首条非空行（跳过拆分点附近可能残留的空白）
  var lines = content.split(/\r?\n/);
  var firstIdx = -1;
  var firstLine = '';
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstIdx = i;
      firstLine = lines[i];
      break;
    }
  }
  if (firstIdx < 0) return null;

  var stripped = stripDecor(firstLine.trim());
  for (var j = 0; j < patterns.length; j++) {
    var hit = findTitleInLine(stripped, patterns[j].regex);
    if (hit) {
      // 命中标题在首行 index 0（stripDecor 后），整首行就是标题行 → 剥离该行作为新章 content
      // 若 index > 0 但有句末标点背书，prefix 归入上一章，此处首行仍当标题行处理
      var restLines = lines.slice(firstIdx + 1);
      var restContent = restLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
      return { title: hit.title, content: restContent };
    }
  }
  return null;
}

var MIN_HITS = 2;

/**
 * 自动检测最匹配的章节模式。
 * 逐行扫描，每行先 trim、剥装饰前缀，再用 findTitleInLine（行内查找 + 句末标点护栏）
 * 对每个非 custom 模式测试命中。取 hitCount >= MIN_HITS 的最大者；卷模式仅在无章类
 * 命中时作为兜底推荐。
 */
function detectChapterPattern(text, stored) {
  var patterns = compilePatterns(stored).filter(function (p) { return p.key !== 'custom' && p.regex; });
  var lines = text.split(/\r?\n/);

  var stats = patterns.map(function (p) {
    var hit = 0;
    var titles = [];
    for (var li = 0; li < lines.length; li++) {
      var stripped = stripDecor(lines[li].trim());
      var hitInfo = findTitleInLine(stripped, p.regex);
      if (hitInfo) {
        hit++;
        if (titles.length < 5) titles.push(hitInfo.title);
      }
    }
    return { pattern: p, hit: hit, titles: titles };
  });

  var valid = stats.filter(function (s) { return s.hit >= MIN_HITS; });
  if (valid.length === 0) {
    return {
      patternKey: 'custom',
      hitCount: 0,
      confidence: 0,
      reason: '未检测到明显章节模式，可手动选择模式或输入自定义正则',
      sampledTitles: [],
    };
  }

  // 卷模式仅在无其他章类命中时作为兜底
  var nonVolume = valid.filter(function (s) { return s.pattern.key !== 'juan'; });
  var pool = nonVolume.length > 0 ? nonVolume : valid;

  pool.sort(function (a, b) { return b.hit - a.hit; });
  var best = pool[0];
  var second = pool[1];
  var confidence = second ? best.hit / (best.hit + second.hit) : 1;

  var high = confidence >= 0.5;
  var reason = high
    ? '检测到「' + best.pattern.label + '」模式，命中 ' + best.hit + ' 处'
    : '多种模式部分匹配（' + pool.map(function (s) { return s.pattern.label + '×' + s.hit; }).join('、') + '），建议核对预览';

  return {
    patternKey: best.pattern.key,
    hitCount: best.hit,
    confidence: confidence,
    reason: reason,
    sampledTitles: best.titles,
  };
}

/**
 * 段落格式化（切分时即格式化）：
 * 全角/半角空行统一压成恰好 1 个；原本无空行分隔的相邻非空行补 1 个空行作段落分隔。
 * 末尾连续空行裁掉。
 */
function normalizeParagraphs(content) {
  if (!content) return content;
  var lines = content.split(/\r?\n/);
  var out = [];
  var blankRun = 0;
  var sawAnyBlank = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.trim() === '') {
      blankRun++;
      sawAnyBlank = true;
    } else {
      // 处理累积的空行
      if (blankRun > 0) {
        // 有空行（原文已有段落分隔）→ 压成恰好 1 个
        out.push('');
        blankRun = 0;
      } else if (out.length > 0) {
        // 前一行是非空、且原本无空行分隔 → 补 1 个空行作段落分隔
        out.push('');
      }
      out.push(line);
    }
  }
  // 全文无任何空行且只有一行时，无需补；多行已在循环里补过
  void sawAnyBlank;
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * 按行扫描切分。匹配行（含行内标题，经 findTitleInLine + 句末标点护栏）视为新章标题；
 * 标题前文字归入上一章。卷行旁路识别。开头无标题的正文按 keepPrologue 处理。
 */
function splitChapters(text, regex, keepPrologue, options) {
  var opts = options || {};
  var normalizeEnabled = opts.normalize !== false;
  void opts.stripDecorPrefix; // 装饰前缀剥除是核心行为，保留签名兼容
  var lines = text.split(/\r?\n/);
  var chapters = [];
  var curTitle = null;
  var curIsVolume = false;
  var buf = [];

  // 卷正则编译为行内搜索形（当用户模式本身是卷模式时不旁路）
  var isVolumeMode = regex.source.indexOf('卷') >= 0;
  var volumeSearch = toSearchRegex(VOLUME_SOURCE);

  function finalizeContent(raw) {
    var trimmed = raw.trim();
    return normalizeEnabled ? normalizeParagraphs(trimmed) : trimmed;
  }

  function flush() {
    var content = finalizeContent(buf.join('\n'));
    if (curTitle !== null) {
      chapters.push({ title: curTitle, content: content, isVolume: curIsVolume });
    } else if (content) {
      if (keepPrologue) {
        chapters.push({ title: '序章', content: content });
      }
      // keepPrologue=false：开头正文并入第一章，不在此 push，由 pending 暂存
    }
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var stripped = stripDecor(line.trim());

    // 卷行旁路识别（用户模式本身不是卷模式时）
    var volHit = null;
    if (!isVolumeMode && volumeSearch) {
      volHit = findTitleInLine(stripped, volumeSearch);
    }
    var hit = findTitleInLine(stripped, regex);

    if (volHit) {
      // 标题前文字归上一章
      if (volHit.prefix) buf.push(volHit.prefix);
      // keepPrologue=false：开头正文并入首个卷章
      var pendingV = (curTitle === null && !keepPrologue && buf.join('\n').trim()) ? buf.join('\n').trim() : null;
      flush();
      curTitle = volHit.title;
      curIsVolume = true;
      buf = pendingV ? [pendingV] : [];
    } else if (hit) {
      if (hit.prefix) buf.push(hit.prefix);
      var pending = (curTitle === null && !keepPrologue && buf.join('\n').trim()) ? buf.join('\n').trim() : null;
      flush();
      curTitle = hit.title;
      curIsVolume = false;
      buf = pending ? [pending] : [];
    } else {
      buf.push(line);
    }
  }
  flush();

  if (chapters.length === 0) {
    return [{ title: '全文（未匹配到章节标题）', content: finalizeContent(text) }];
  }
  return chapters;
}

/** 字符保留率：清理前后去空白字符数对比（M1 §3.8 护栏） */
function retentionRate(before, after) {
  var a = before.replace(/\s/g, '').length;
  var b = after.replace(/\s/g, '').length;
  if (a === 0) return 1;
  return b / a;
}

/**
 * 章节标记前缀剥离正则（按优先级依次尝试）。
 * 每个正则的捕获组 1 为前缀（章号标记），剥离后余下为纯章名。
 */
var MARKER_PATTERNS = [
  /^(第[0-9零一二三四五六七八九十百千万]+[章节回卷]\s*)/,
  /^(\d{1,4}[:：]\s*)/,
  /^(\d{1,4}、\s*)/,
  /^([0-9零一二三四五六七八九十百千万]+章\s*)/,
  /^(chapter\s+\d+[ivxlc]*\s*)/i,
];

/**
 * 从章节标题中剥除章号标记，返回纯章名。
 * 如 "第3章 接受现实" → "接受现实"、"001：开端" → "开端"、"3、旧案重提" → "旧案重提"。
 * 未命中任何模式则返回原标题。
 */
function stripChapterMarker(title) {
  if (!title) return title;
  for (var i = 0; i < MARKER_PATTERNS.length; i++) {
    var re = MARKER_PATTERNS[i];
    var m = title.match(re);
    if (m) {
      var rest = title.slice(m[0].length).trim();
      return rest || title;
    }
  }
  return title;
}

/**
 * 对切分结果批量应用章节标题模板。
 *
 * 模板变量：
 * - `{n}`    — 递增序号（从 opts.start 开始，默认 1；卷章和序章跳过时不计入）
 * - `{0n}`   — 补零序号（按总章数位数自动补零，如 120 章 → 001）
 * - `{title}`— 剥除章号标记后的纯章名
 * - `{raw}`  — 原始完整标题
 *
 * @param results  切分结果（预览阶段 SplitResult[] 或 ImportChapter[] 均可）
 * @param template 模板字符串，如 "第{0n}章 {title}"
 * @param opts.start        起始序号，默认 1
 * @param opts.skipVolume   卷章跳过替换，默认 true
 * @param opts.skipPrologue 序章跳过计数（标题含"序章"字样的章节保持原标题，不参与编号），默认 true
 */
function applyTitleTemplate(results, template, opts) {
  var o = opts || {};
  var start = o.start != null ? o.start : 1;
  var skipVolume = o.skipVolume != null ? o.skipVolume : true;
  var skipPrologue = o.skipPrologue != null ? o.skipPrologue : true;
  if (!template) return results;

  // 判定是否为序章（标题包含"序章"字样，不区分大小写）
  function isPrologue(title) { return /序章/i.test(title); }

  // 计算参与编号的章节总数（排除卷章和序章）
  var countableCount = results.filter(function (r) {
    if (skipVolume && r.isVolume) return false;
    if (skipPrologue && isPrologue(r.title)) return false;
    return true;
  }).length;

  var padLen = Math.max(String(countableCount).length, 2);
  var seqIdx = start - 1;

  return results.map(function (r) {
    // 卷章跳过替换
    if (skipVolume && r.isVolume) return r;
    // 序章跳过计数和替换（保持原标题）
    if (skipPrologue && isPrologue(r.title)) return r;

    seqIdx++;
    var pureTitle = stripChapterMarker(r.title);
    var n = String(seqIdx);
    var n0 = n.padStart(padLen, '0');

    var newTitle = template
      .replace(/\{0n\}/g, n0)
      .replace(/\{n\}/g, n)
      .replace(/\{title\}/g, pureTitle)
      .replace(/\{raw\}/g, r.title);

    return Object.assign({}, r, { title: newTitle });
  });
}

// ===================== exported API =====================

window.TR = window.TR || {};
window.TR.DEFAULT_SPLIT_PATTERNS = DEFAULT_SPLIT_PATTERNS;
window.TR.PRESET_PATTERNS = PRESET_PATTERNS;
window.TR.compilePatterns = compilePatterns;
window.TR.detectChapterPattern = detectChapterPattern;
window.TR.detectLeadingChapterTitle = detectLeadingChapterTitle;
window.TR.splitChapters = splitChapters;
window.TR.toSearchRegex = toSearchRegex;
window.TR.applyTitleTemplate = applyTitleTemplate;
window.TR.retentionRate = retentionRate;
window.TR.stripChapterMarker = stripChapterMarker;
window.TR.normalizeParagraphs = normalizeParagraphs;
window.TR.findTitleInLine = findTitleInLine;