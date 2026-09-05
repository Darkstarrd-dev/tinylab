// editor_textreview_step2.js — Step2 panel: 章节切分 (chapter splitting).
// Exposes window.trRenderStep2(panel, state).
// Uses window.TR.* (P4): pattern selector (dropdown from backend list + TR
// .DEFAULT_SPLIT_PATTERNS, with an "edit patterns" modal),
// "自动检测" button (TR.detectChapterPattern), live preview table (TR
// .splitChapters + TR.applyTitleTemplate), title-template input,
// "AI 拆分" button (TR.aiSplitChapters: candidate-line extraction + single
// LLM classification pass), dedup section (window.TRDedup.*: scan + preview
// + apply, rewrites trState.rawText and re-splits).
// Mirrors editor.js style: 'use strict' + function + var.

'use strict';

/**
 * Render the Step2 (split) panel.
 * @param {HTMLElement} panel container element
 * @param {object} state trState
 */
window.trRenderStep2 = function (panel, state) {
  // Ensure patterns are merged (bootstrap may not have finished on a direct
  // nav to step 2 from persisted state).
  if (!state.splitPatterns || state.splitPatterns.length === 0) {
    trMergePatterns([]);
  }
  var patterns = state.splitPatterns || [];
  var hasChapters = !!(state.chapters && state.chapters.length);
  var freshEntry = !hasChapters; // auto-detect only on fresh entry

  panel.innerHTML = '';

  var root = document.createElement('div');
  root.className = 'tr-step-panel tr-s2-root';
  root.style.height = '100%';
  root.style.minHeight = '0';
  panel.appendChild(root);

  var splitView = document.createElement('div');
  splitView.className = 'tr-split-view';
  root.appendChild(splitView);

  // --- Left Pane: controls + table ---
  var leftPane = document.createElement('div');
  leftPane.className = 'tr-left-pane';
  splitView.appendChild(leftPane);

  // --- Header row: Back left | centered Title | Next right ---
  var header = document.createElement('div');
  header.className = 'tr-s2-header';

  var headerLeft = document.createElement('div');
  headerLeft.className = 'tr-s2-header-left';

  var backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'tr-btn tr-btn-ghost';
  backBtn.textContent = trT('trPrev');
  backBtn.addEventListener('click', function () { trGotoStep(1); });
  headerLeft.appendChild(backBtn);
  header.appendChild(headerLeft);

  var headerTitle = document.createElement('span');
  headerTitle.className = 'tr-s2-title';
  headerTitle.textContent = trT('trStepSplit');
  header.appendChild(headerTitle);

  var headerRight = document.createElement('div');
  headerRight.className = 'tr-s2-header-right';

  var nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'tr-btn tr-btn-primary';
  nextBtn.id = 'tr-s2-next';
  nextBtn.textContent = trT('trNext');
  nextBtn.disabled = !hasChapters;
  nextBtn.addEventListener('click', trStep2Next);
  headerRight.appendChild(nextBtn);
  header.appendChild(headerRight);

  leftPane.appendChild(header);

  // --- Config Panel (collapsible 2-column grid, hidden by default on step entry) ---
  var configPanel = document.createElement('div');
  configPanel.className = 'tr-s2-config-panel';
  configPanel.id = 'tr-s2-config-panel';
  configPanel.style.display = state.configPanelExpanded === true ? '' : 'none';

  var grid = document.createElement('div');
  grid.className = 'tr-s2-form-grid';

  // Row 1: Labels (Left: Pattern | Right: Title Template)
  var l1 = document.createElement('div');
  l1.className = 'tr-s2-col';
  var patLabel = document.createElement('label');
  patLabel.className = 'tr-label';
  patLabel.htmlFor = 'tr-s2-pattern';
  patLabel.textContent = trT('trPattern');
  l1.appendChild(patLabel);
  grid.appendChild(l1);

  var l2 = document.createElement('div');
  l2.className = 'tr-s2-col';
  var tmplLabel = document.createElement('label');
  tmplLabel.className = 'tr-label';
  tmplLabel.htmlFor = 'tr-s2-template';
  tmplLabel.textContent = trT('trTitleTemplate');
  l2.appendChild(tmplLabel);
  grid.appendChild(l2);

  // Row 2: Inputs (Left: custom dropdown | Right: Text Input)
  // 项目统一样式:renderCustomSelectHtml (app.js);底层隐藏 select#tr-s2-pattern
  // 保持 change 事件契约,选项重建统一走 trStep2RenderPatternSelect()。
  var i1 = document.createElement('div');
  i1.className = 'tr-s2-col';
  i1.id = 'tr-s2-pattern-col';
  grid.appendChild(i1);
  trStep2RenderPatternSelect();

  var i2 = document.createElement('div');
  i2.className = 'tr-s2-col';
  var tmplInput = document.createElement('input');
  tmplInput.type = 'text';
  tmplInput.className = 'tr-input';
  tmplInput.id = 'tr-s2-template';
  tmplInput.placeholder = trT('trTitleTemplatePlaceholder');
  tmplInput.value = state.titleTemplate || '';
  tmplInput.addEventListener('input', trStep2OnTemplateChange);
  i2.appendChild(tmplInput);
  grid.appendChild(i2);

  // Custom regex row (when pattern === 'custom')
  var customRow = document.createElement('div');
  customRow.className = 'tr-s2-col tr-s2-col-full';
  customRow.id = 'tr-s2-custom-row';
  customRow.style.display = (state.selectedPatternKey || 'zhang') === 'custom' ? '' : 'none';

  var crLabel = document.createElement('label');
  crLabel.className = 'tr-label';
  crLabel.htmlFor = 'tr-s2-custom-regex';
  crLabel.textContent = trT('trCustomRegex') + ': ';
  customRow.appendChild(crLabel);

  var crInput = document.createElement('input');
  crInput.type = 'text';
  crInput.className = 'tr-input';
  crInput.id = 'tr-s2-custom-regex';
  crInput.placeholder = trT('trCustomRegexPlaceholder');
  crInput.value = state.customRegex || '';
  crInput.addEventListener('input', trStep2OnCustomChange);
  customRow.appendChild(crInput);
  grid.appendChild(customRow);

  configPanel.appendChild(grid);
  leftPane.appendChild(configPanel);

  // --- Controls2: four buttons ---
  var c2 = document.createElement('div');
  c2.className = 'tr-s2-controls2';

  var editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'tr-btn';
  editBtn.textContent = trT('trPatternEditor');
  editBtn.addEventListener('click', trStep2OpenPatternEditor);
  c2.appendChild(editBtn);

  var autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.className = 'tr-btn';
  autoBtn.textContent = trT('trAutoDetect');
  autoBtn.addEventListener('click', trStep2AutoDetect);
  c2.appendChild(autoBtn);

  var resplitBtn = document.createElement('button');
  resplitBtn.type = 'button';
  resplitBtn.className = 'tr-btn';
  resplitBtn.textContent = trT('trResplit');
  resplitBtn.addEventListener('click', trStep2ReSplit);
  c2.appendChild(resplitBtn);

  var aiBtn = document.createElement('button');
  aiBtn.type = 'button';
  aiBtn.className = 'tr-btn tr-btn-ghost';
  aiBtn.id = 'tr-s2-aisplit';
  aiBtn.textContent = trT('trAISplit');
  aiBtn.addEventListener('click', trStep2AISplit);
  c2.appendChild(aiBtn);

  leftPane.appendChild(c2);

  // --- Detect info hint ---
  var infoEl = document.createElement('div');
  infoEl.className = 'tr-hint';
  infoEl.id = 'tr-s2-detect-info';
  leftPane.appendChild(infoEl);

  // --- Dedup section: scan + apply (window.TRDedup) ---
  var dedupBox = document.createElement('div');
  dedupBox.className = 'tr-s2-dedup';
  dedupBox.id = 'tr-s2-dedup';
  leftPane.appendChild(dedupBox);
  trStep2RenderDedup();

  // --- Preview section: fills remaining height ---
  var previewSection = document.createElement('div');
  previewSection.className = 'tr-s2-preview-section';

  var previewHead = document.createElement('div');
  previewHead.className = 'tr-s2-preview-head';

  var previewTitle = document.createElement('span');
  previewTitle.className = 'tr-section-title';
  previewTitle.textContent = trT('trPreview');
  previewHead.appendChild(previewTitle);

  var previewCount = document.createElement('span');
  previewCount.className = 'tr-count';
  previewCount.id = 'tr-s2-count';
  previewCount.textContent = '0';
  previewHead.appendChild(previewCount);

  // Keep prologue checkbox placed on the right side of Preview count badge
  var kpLabel = document.createElement('label');
  kpLabel.className = 'tr-check tr-s2-preview-kp';
  var kpCheck = document.createElement('input');
  kpCheck.type = 'checkbox';
  kpCheck.id = 'tr-s2-keeppro';
  kpCheck.checked = !!state.keepPrologue;
  kpCheck.addEventListener('change', trStep2OnKeepPrologue);
  kpLabel.appendChild(kpCheck);
  kpLabel.appendChild(document.createTextNode(' ' + trT('trKeepPrologue')));
  previewHead.appendChild(kpLabel);

  // Export button placed on the right side of Preview head
  var expBtn = document.createElement('button');
  expBtn.type = 'button';
  expBtn.className = 'tr-btn tr-s2-export-btn';
  expBtn.id = 'tr-s2-export';
  expBtn.textContent = trT('trExport') || '导出';
  expBtn.disabled = !hasChapters;
  expBtn.addEventListener('click', trStep2Export);
  previewHead.appendChild(expBtn);

  previewSection.appendChild(previewHead);

  var previewWrap = document.createElement('div');
  previewWrap.className = 'tr-preview-wrap';
  previewWrap.id = 'tr-s2-preview';
  previewSection.appendChild(previewWrap);

  leftPane.appendChild(previewSection);

  // --- Right Pane: Chapter Content Preview ---
  var rightPane = document.createElement('div');
  rightPane.className = 'tr-right-pane';
  rightPane.innerHTML =
    '<div class="tr-right-pane-head">' +
      '<span class="tr-right-pane-title" id="tr-s2-detail-title">' + trEscapeHtml(trT('trChapterTitle') || '章节正文预览') + '</span>' +
      '<span class="tr-count" id="tr-s2-detail-len">0 ' + trEscapeHtml(trT('trCharCount') || '字') + '</span>' +
    '</div>' +
    '<pre class="tr-review-content" id="tr-review-content"></pre>';
  splitView.appendChild(rightPane);

  // --- Auto-detect on fresh entry (no existing chapters) ---
  if (freshEntry) {
    trStep2AutoDetect(true);
  }
  trStep2RenderPreview();
};

// ===================== Step2: pattern selection =====================

function trStep2OnPatternChange() {
  var sel = document.getElementById('tr-s2-pattern');
  if (!sel) return;
  trState.selectedPatternKey = sel.value;
  var customRow = document.getElementById('tr-s2-custom-row');
  if (customRow) customRow.style.display = (sel.value === 'custom') ? '' : 'none';
  trSave();
  trStep2DoSplit();
}

function trStep2OnCustomChange() {
  var inp = document.getElementById('tr-s2-custom-regex');
  if (!inp) return;
  trState.customRegex = inp.value;
  trSave();
  if (trState.selectedPatternKey === 'custom') {
    trStep2DoSplit();
  }
}

function trStep2OnTemplateChange() {
  var inp = document.getElementById('tr-s2-template');
  if (!inp) return;
  trState.titleTemplate = inp.value;
  trSave();
  trStep2DoSplit();
}

function trStep2OnKeepPrologue() {
  var cb = document.getElementById('tr-s2-keeppro');
  if (!cb) return;
  trState.keepPrologue = cb.checked;
  trSave();
  trStep2DoSplit();
}

/**
 * Render/rebuild the Step2 pattern custom dropdown from trState.splitPatterns.
 * 底层隐藏 <select id="tr-s2-pattern"> + change 事件契约不变,auto-detect 与
 * Pattern Editor 的增删都经此统一刷新,无需刷新页面。
 * renderCustomSelectHtml 不可用时回退原生 select。
 */
function trStep2RenderPatternSelect() {
  var col = document.getElementById('tr-s2-pattern-col');
  if (!col) return;
  var patterns = trState.splitPatterns || [];
  var selKey = trState.selectedPatternKey || 'zhang';
  var found = false;
  for (var i = 0; i < patterns.length; i++) {
    if (patterns[i].key === selKey) { found = true; break; }
  }
  if (!found) {
    selKey = patterns.length ? patterns[0].key : 'zhang';
    trState.selectedPatternKey = selKey;
  }
  col.innerHTML = '';
  if (typeof renderCustomSelectHtml === 'function') {
    var opts = patterns.map(function (p) { return { value: p.key, label: p.label || p.key }; });
    col.innerHTML = renderCustomSelectHtml('tr-s2-pattern-wrap', 'tr-s2-pattern', opts, selKey, 'trStep2OnPatternChangeV(this.value)', 'width:100%');
  } else {
    var sel = document.createElement('select');
    sel.className = 'tr-select';
    sel.id = 'tr-s2-pattern';
    for (var j = 0; j < patterns.length; j++) {
      var opt = document.createElement('option');
      opt.value = patterns[j].key;
      opt.textContent = patterns[j].label || patterns[j].key;
      if (patterns[j].key === selKey) opt.selected = true;
      sel.appendChild(opt);
    }
    col.appendChild(sel);
  }
  var hidden = document.getElementById('tr-s2-pattern');
  // 注意:custom 分支出身已挂 onchange 内联 (trStep2OnPatternChangeV),原生回退
  // 分支才需要显式监听;同时挂会导致 custom 侧同一切换触发两次 DoSplit。
  if (hidden && typeof renderCustomSelectHtml !== 'function') {
    hidden.addEventListener('change', trStep2OnPatternChange);
  }
}

/**
 * Custom dropdown 的 change 入口 (hidden select onchange 透出):
 * 与 trStep2OnPatternChange 同语义,供 renderCustomSelectHtml 内联调用。
 */
function trStep2OnPatternChangeV(value) {
  if (value == null) return;
  trState.selectedPatternKey = value;
  var customRow = document.getElementById('tr-s2-custom-row');
  if (customRow) customRow.style.display = (value === 'custom') ? '' : 'none';
  trSave();
  trStep2DoSplit();
}
window.trStep2OnPatternChangeV = trStep2OnPatternChangeV;

// ===================== Step2: the runtime regex =====================

/**
 * Resolve the runtime regex for the currently selected pattern.
 * For non-custom patterns: find the compiled search regex in trState
 * .splitPatterns (TR.compilePatterns produced RegExp|null).
 * For custom: compile trState.customRegex via TR.toSearchRegex.
 * Returns {regex, ok}. ok=false means no usable regex (preview shows the
 * "no match" fallback chapter).
 */
function trStep2ResolveRegex() {
  var key = trState.selectedPatternKey || 'zhang';
  var patterns = trState.splitPatterns || [];
  if (key === 'custom') {
    var re = (window.TR && window.TR.toSearchRegex) ? window.TR.toSearchRegex(trState.customRegex || '') : null;
    return { regex: re, ok: !!(re && trState.customRegex) };
  }
  for (var i = 0; i < patterns.length; i++) {
    if (patterns[i].key === key) {
      return { regex: patterns[i].regex, ok: !!(patterns[i].regex) };
    }
  }
  return { regex: null, ok: false };
}

// ===================== Step2: detect + split =====================

/**
 * "自动检测": run TR.detectChapterPattern over rawText, pick the best pattern
 * key, update the dropdown + state, then re-split and show the reason.
 */
function trStep2AutoDetect(silent) {
  if (!window.TR || !window.TR.detectChapterPattern || !trState.rawText) {
    if (!silent) trToast(trT('trImportFirst'), 'warning');
    return;
  }
  var stored = trState.splitPatterns.map(function (p) {
    return { key: p.key, label: p.label, regex: (p.regex ? p.regex.source : ''), flags: p.flags, builtin: p.builtin };
  });
  var res = window.TR.detectChapterPattern(trState.rawText, stored);
  var info = document.getElementById('tr-s2-detect-info');
  if (res && res.patternKey && res.patternKey !== 'custom') {
    trState.selectedPatternKey = res.patternKey;
    trStep2RenderPatternSelect();
    var customRow = document.getElementById('tr-s2-custom-row');
    if (customRow) customRow.style.display = 'none';
    trSave();
    trStep2DoSplit();
    if (info) info.textContent = (res.reason || '') + (res.hitCount != null ? ' (' + res.hitCount + ')' : '');
  } else {
    if (info) info.textContent = (res && res.reason) ? res.reason : trT('trDetectNoMatch');
    trStep2DoSplit();
  }
}

/**
 * Re-split trState.rawText with the current pattern/template/prologue settings
 * and store the result in trState.chapters; refresh the preview + next button.
 */
function trStep2ReSplit() {
  var panel = document.getElementById('tr-s2-config-panel');
  if (panel && panel.style.display === 'none') {
    panel.style.display = '';
    trState.configPanelExpanded = true;
  }
  trStep2DoSplit();
}

function trStep2DoSplit() {
  if (!window.TR || !window.TR.splitChapters || !trState.rawText) {
    trState.chapters = [];
    trStep2RenderPreview();
    return;
  }
  var resolved = trStep2ResolveRegex();
  var regex = resolved.regex;
  if (!regex) {
    regex = /(?!)/; // never-matching
  }
  var chapters = window.TR.splitChapters(trState.rawText, regex, trState.keepPrologue);
  if (trState.titleTemplate) {
    chapters = window.TR.applyTitleTemplate(chapters, trState.titleTemplate);
  }
  trState.chapters = chapters;
  trSave();
  trStep2RenderPreview();
}

// ===================== Step2: preview table =====================

function trStep2RenderPreview() {
  var wrap = document.getElementById('tr-s2-preview');
  var count = document.getElementById('tr-s2-count');
  var next = document.getElementById('tr-s2-next');
  var expBtn = document.getElementById('tr-s2-export');
  var chapters = trState.chapters || [];
  if (count) count.textContent = String(chapters.length);
  if (next) next.disabled = chapters.length === 0;
  if (expBtn) expBtn.disabled = chapters.length === 0;
  if (!wrap) return;
  if (chapters.length === 0) {
    wrap.innerHTML = '<div class="tr-empty">' + trEscapeHtml(trT('trNoChapters')) + '</div>';
    var paneEmpty = document.getElementById('tr-review-content') || document.getElementById('ed-review-content');
    if (paneEmpty) paneEmpty.textContent = '';
    return;
  }
  var html = '<table class="tr-preview-table"><thead><tr>' +
    '<th class="tr-col-idx">#</th>' +
    '<th class="tr-col-title">' + trEscapeHtml(trT('trChapterTitle')) + '</th>' +
    '<th class="tr-col-len">' + trEscapeHtml(trT('trCharCount')) + '</th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < chapters.length; i++) {
    var c = chapters[i];
    var len = (typeof c.content === 'string' ? c.content.length : 0);
    html += '<tr' + (c.isVolume ? ' class="tr-row-volume"' : '') + ' style="cursor:pointer" onclick="trS2SelectChapter(' + i + ')">' +
      '<td class="tr-col-idx">' + (i + 1) + '</td>' +
      '<td class="tr-col-title">' + trEscapeHtml(c.title || '') + '</td>' +
      '<td class="tr-col-len">' + len + '</td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
  // Auto-select first chapter for immediate preview
  trS2SelectChapter(0);
}

// trS2SelectChapter shows the chapter's original content in the right pane
// so the user can preview a split chapter before cleaning.
function trS2SelectChapter(idx) {
  var chapters = trState.chapters || [];
  if (idx < 0 || idx >= chapters.length) return;
  var c = chapters[idx];
  var pane = document.getElementById('tr-review-content') || document.getElementById('ed-review-content');
  if (pane) {
    pane.textContent = c.content || '';
  }
  var titleEl = document.getElementById('tr-s2-detail-title');
  if (titleEl) {
    titleEl.textContent = (c.title || ('#' + (idx + 1))) + (c.isVolume ? ' (卷)' : '');
  }
  var lenEl = document.getElementById('tr-s2-detail-len');
  if (lenEl) {
    lenEl.textContent = ((c.content || '').length) + ' ' + (trT('trCharCount') || '字');
  }
  var rows = document.querySelectorAll('#tr-s2-preview tbody tr');
  for (var i = 0; i < rows.length; i++) rows[i].classList.remove('selected');
  if (rows[idx]) rows[idx].classList.add('selected');
}

// ===================== Step2: AI split (optional) =====================

// AI Split modal 选中的模型 {value, label};确认后走候选行提取 + 单次 LLM 行号分类切分。
var trS2AIModel = null;

/**
 * "AI 拆分": 弹出模型选择 Modal (Step3 Node Pool Setting 同款模型选择器) +
 * 确定/取消;确认后按候选行 + 模型返回行号切分 (TR.aiSplitChapters)。
 */
function trStep2AISplit() {
  if (!trState.rawText) {
    trToast(trT('trImportFirst'), 'warning');
    return;
  }
  trStep2RenderAISplitModal();
}

function trStep2RenderAISplitModal() {
  var hasModel = !!(trS2AIModel && trS2AIModel.label);
  var body =
    '<div class="tr-form-row">' +
      '<label class="tr-form-label">' + trEscapeHtml(trT('trNodeModel') || '模型') + '</label>' +
      '<button type="button" class="tr-model-select-btn' + (hasModel ? ' has-value' : '') + '" onclick="trStep2PickAISplitModel()">' +
        '<span class="' + (hasModel ? 'tr-model-name' : 'tr-model-placeholder') + '">' +
          trEscapeHtml(hasModel ? trS2AIModel.label : (trT('trSelectModel') || '点击选择模型...')) +
        '</span>' +
        '<span style="opacity:0.6; font-size:11px;">▼</span>' +
      '</button>' +
      '<p class="tr-hint" style="margin:8px 0 0 0;">' + trEscapeHtml(trT('trAISplitHint')) + '</p>' +
    '</div>';
  var html =
    '<div class="modal" style="max-width:480px; width:92%;">' +
      '<div class="modal-title" style="display:flex; justify-content:space-between; align-items:center;">' +
        '<span>' + trEscapeHtml(trT('trAISplit')) + '</span>' +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="trCloseModal()" style="padding:2px 8px;">✕</button>' +
      '</div>' +
      '<div class="modal-body" style="padding:12px 0;">' + body + '</div>' +
      '<div class="modal-footer" style="margin-top:10px;">' +
        '<button type="button" class="btn btn-ghost" onclick="trCloseModal()">' + trEscapeHtml(trT('cancel')) + '</button>' +
        '<button type="button" class="btn btn-primary" onclick="trStep2ConfirmAISplit()">' + trEscapeHtml(trT('confirm')) + '</button>' +
      '</div>' +
    '</div>';
  if (typeof window.trShowModal === 'function') {
    window.trShowModal(html);
  } else if (typeof pgShowModal === 'function') {
    pgShowModal(html);
  }
}

/**
 * AI Split 模型选择:复用系统 Model Picker (Step3 trStep3PickModel 同款),
 * 选中后回填按钮标签并重绘 Modal。
 */
function trStep2PickAISplitModel() {
  var cur = trS2AIModel ? trS2AIModel.value : '';
  var onModelSelected = function (val) {
    if (!val) return;
    trS2AIModel = { value: val, label: val };
    trApiGet('/models').then(function (res) {
      var models = (res && !res.error && Array.isArray(res.models)) ? res.models : [];
      for (var i = 0; i < models.length; i++) {
        var m = models[i];
        if (m && m.id === val) {
          trS2AIModel.label = (m.provider ? m.provider + ' / ' : '') + (m.alias || m.name || m.realModelId || m.id);
          break;
        }
      }
      trStep2RenderAISplitModal();
    }, function () { trStep2RenderAISplitModal(); });
  };
  if (typeof window.openModelPickerModal === 'function') {
    window.openModelPickerModal(cur, onModelSelected);
  } else if (typeof pgOpenModelPicker === 'function') {
    pgOpenModelPicker(cur, onModelSelected);
  } else {
    trToast('Model picker unavailable', 'warning');
  }
}

/**
 * AI Split 确认:候选行提取 + 单次 LLM 分类,按返回行号切分。
 * 候选行 = 空行分隔的短行(默认 ≤60 字符,≤4000 行封顶);prompt 要求模型
 * 只输出章节标题行号(JSON 数组),逐行 fetch 无流式,失败回退提示不改切分。
 */
function trStep2ConfirmAISplit() {
  if (!trS2AIModel || !trS2AIModel.value) {
    trToast(trT('trModelRequired') || '请先选择模型', 'warning');
    return;
  }
  if (!window.TR || !window.TR.extractSplitCandidates || !window.TR.aiSplitChapters) {
    trToast('AI split unavailable', 'error');
    return;
  }
  if (!trState.rawText) {
    trToast(trT('trImportFirst'), 'warning');
    return;
  }
  trCloseModal();
  var info = document.getElementById('tr-s2-detect-info');
  if (info) info.textContent = trT('trWorking');
  var cands = window.TR.extractSplitCandidates(trState.rawText, {});
  if (!cands.lines.length) {
    if (info) info.textContent = trT('trAISplitEmpty');
    return;
  }
  var modelStr = trS2AIModel.value;
  if (modelStr.indexOf('/') === -1 && typeof window._trS3ProviderPrefix === 'function') {
    var pid = (trS2AIModel.providerId || '');
    var prefix = pid ? window._trS3ProviderPrefix(pid) : '';
    if (prefix) modelStr = prefix + '/' + modelStr;
  }
  var prompt = '你是章节切分助手。下面是按行号列出的候选标题行（每行格式为"行号: 内容"，只包含短行，正文长段落已过滤）。' +
    '请判断其中哪些是真正的章节标题（章/回/节/卷/纯数字编号等章节边界），只输出 JSON 数组，如 [12, 45, 78]，按出现顺序排列，不要输出任何解释文字。' +
    '如果没有章节标题，输出 []。\n\n' +
    cands.lines.map(function (l) { return l.no + ': ' + l.text; }).join('\n');
  fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelStr, stream: false, messages: [{ role: 'user', content: prompt }] }),
  }).then(function (resp) { return resp.json(); }).then(function (data) {
    if (!data || data.error) {
      var em = (data && data.error);
      if (em && typeof em !== 'string') em = JSON.stringify(em);
      trToast(em || trT('trAISplitFailed'), 'error');
      if (info) info.textContent = trT('trAISplitFailed');
      return;
    }
    var content = trExtractChatContent(data);
    var chapters = window.TR.aiSplitChapters(trState.rawText, cands, content, trState.keepPrologue);
    if (!chapters || !chapters.length) {
      if (info) info.textContent = trT('trAISplitEmpty');
      return;
    }
    if (trState.titleTemplate && window.TR.applyTitleTemplate) {
      chapters = window.TR.applyTitleTemplate(chapters, trState.titleTemplate);
    }
    trState.chapters = chapters;
    trSave();
    trStep2RenderPreview();
    if (info) info.textContent = trT('trAISplitResult', [String(chapters.length)]);
  }).catch(function (err) {
    console.warn('tr AI split failed:', err);
    trToast(trT('trAISplitFailed'), 'error');
    if (info) info.textContent = trT('trAISplitFailed');
  });
}
window.trStep2PickAISplitModel = trStep2PickAISplitModel;
window.trStep2ConfirmAISplit = trStep2ConfirmAISplit;

// ===================== Step2: pattern editor drawer (universal modal) =====================

/**
 * Open a universal modal to add/delete custom split patterns.
 */
function trStep2OpenPatternEditor() {
  trStep2RenderPatternEditor();
}

function trStep2RenderPatternEditor() {
  var patterns = trState.splitPatterns || [];
  var rows = '';
  for (var i = 0; i < patterns.length; i++) {
    var p = patterns[i];
    var isCustom = (p.key === 'custom');
    var src = isCustom ? (trState.customRegex || '') : (p.regex ? p.regex.source : '');
    rows +=
      '<tr>' +
        '<td class="tr-pe-key">' + trEscapeHtml(p.key) + '</td>' +
        '<td>' + trEscapeHtml(p.label || '') + '</td>' +
        '<td class="tr-pe-regex">' + trEscapeHtml(src) + '</td>' +
        '<td class="tr-pe-actions">' +
          (isCustom ? '' :
            '<button type="button" class="tr-btn tr-btn-xs tr-btn-danger" data-key="' +
              trEscapeHtml(p.key) + '" onclick="trStep2DeletePattern(this.getAttribute(\'data-key\'))">' + trEscapeHtml(trT('trDelete')) + '</button>') +
        '</td>' +
      '</tr>';
  }
  var html =
    '<div class="modal" style="max-width:740px; width:92%; max-height:85vh; display:flex; flex-direction:column;">' +
      '<div class="modal-title" style="display:flex; justify-content:space-between; align-items:center;">' +
        '<span>' + trEscapeHtml(trT('trPatternEditor') || '模式管理') + '</span>' +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="trCloseModal()" style="padding:2px 8px;">✕</button>' +
      '</div>' +
      '<div class="modal-body" style="flex:1; overflow-y:auto; padding:12px 0;">' +
        '<div class="tr-node-card">' +
          '<div class="tr-node-card-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>' +
            '<span>' + trEscapeHtml(trT('trAddPattern') || '添加模式') + '</span>' +
          '</div>' +
          '<div class="tr-pe-form">' +
            '<input type="text" id="tr-pe-new-key" class="tr-input" placeholder="' + trEscapeHtml(trT('trPatternKeyPlaceholder') || '键名') + '" style="flex:1;min-width:110px;">' +
            '<input type="text" id="tr-pe-new-label" class="tr-input" placeholder="' + trEscapeHtml(trT('trPatternLabelPlaceholder') || '显示标签') + '" style="flex:1;min-width:130px;">' +
            '<input type="text" id="tr-pe-new-regex" class="tr-input" placeholder="' + trEscapeHtml(trT('trPatternRegexPlaceholder') || '正则表达式') + '" style="flex:2;min-width:180px;">' +
            '<button type="button" class="tr-btn tr-btn-primary" onclick="trStep2AddPattern()">' + trEscapeHtml(trT('trAdd') || '添加') + '</button>' +
          '</div>' +
          '<p class="tr-hint" style="margin:8px 0 0 0;">' + trEscapeHtml(trT('trPatternRegexHint') || '正则匹配章节标题行。开头的 ^ 锚定行首。') + '</p>' +
        '</div>' +
        '<div class="tr-node-table-section">' +
          '<div class="tr-node-table-title">' + trEscapeHtml(trT('trConfiguredPatterns') || '已配置模式列表') + ' (' + patterns.length + ')</div>' +
          '<table class="tr-pe-table" style="width:100%"><thead><tr>' +
            '<th style="width:120px;">' + trEscapeHtml(trT('trPatternKey') || '键') + '</th>' +
            '<th style="width:140px;">' + trEscapeHtml(trT('trPatternLabel') || '标签') + '</th>' +
            '<th>' + trEscapeHtml(trT('trPatternRegex') || '正则') + '</th>' +
            '<th style="text-align:right;width:70px;">' + trEscapeHtml(trT('trActions') || '操作') + '</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>' +
        '</div>' +
      '</div>' +
      '<div class="modal-footer" style="margin-top:10px;">' +
        '<button type="button" class="btn btn-ghost" onclick="trCloseModal()">' + trEscapeHtml(trT('cancel') || '关闭') + '</button>' +
      '</div>' +
    '</div>';

  if (typeof window.trShowModal === 'function') {
    window.trShowModal(html);
  } else if (typeof pgShowModal === 'function') {
    pgShowModal(html);
  }
}

/**
 * Add a custom pattern via POST /api/text-review/split-patterns (P1).
 */
function trStep2AddPattern() {
  var keyEl = document.getElementById('tr-pe-new-key');
  var labelEl = document.getElementById('tr-pe-new-label');
  var regexEl = document.getElementById('tr-pe-new-regex');
  var key = keyEl ? keyEl.value.trim() : '';
  var label = labelEl ? labelEl.value.trim() : '';
  var regex = regexEl ? regexEl.value.trim() : '';
  if (!key) { trToast(trT('trPatternKeyRequired'), 'warning'); return; }
  if (regex) {
    try {
      new RegExp(regex);
    } catch (e) {
      trToast('正则表达式语法错误: ' + e.message, 'warning');
      return;
    }
  }
  trApiPost('/text-review/split-patterns', {
    key: key, label: label || key, regex: regex, builtin: false
  }).then(function (res) {
    if (res && res.error) { trToast(res.error, 'error'); return; }
    return trApiGet('/text-review/split-patterns');
  }).then(function (res) {
    var backendPats = (res && !res.error && Array.isArray(res.patterns)) ? res.patterns : [];
    trMergePatterns(backendPats);
    trState.selectedPatternKey = key;
    trSave();
    trStep2RenderPatternSelect();
    trStep2RenderPatternEditor();
    trStep2DoSplit();
  }).catch(function (err) {
    console.warn('tr add pattern failed:', err);
    trToast(trT('trPatternSaveFailed'), 'error');
  });
}

/**
 * Delete a pattern via DELETE /api/text-review/split-patterns/{key} (P1).
 */
function trStep2DeletePattern(key) {
  if (!key || key === 'custom') return;
  trApiDelete('/text-review/split-patterns/' + encodeURIComponent(key)).then(function (res) {
    if (res && res.error) { trToast(res.error, 'error'); return; }
    return trApiGet('/text-review/split-patterns');
  }).then(function (res) {
    var backendPats = (res && !res.error && Array.isArray(res.patterns)) ? res.patterns : [];
    trMergePatterns(backendPats);
    if (trState.selectedPatternKey === key) {
      trState.selectedPatternKey = 'zhang';
    }
    trSave();
    trStep2RenderPatternSelect();
    trStep2RenderPatternEditor();
    trStep2ReSplit();
  }).catch(function (err) {
    console.warn('tr delete pattern failed:', err);
    trToast(trT('trPatternDeleteFailed'), 'error');
  });
}

// ===================== Step2: next =====================

/**
 * "下一步": store chapters (already in trState.chapters from re-split) and
 * advance to Step3. Guarded by chapters.length > 0.
 */
function trStep2Next() {
  if (!trState.chapters || trState.chapters.length === 0) {
    trToast(trT('trSplitFirst'), 'warning');
    return;
  }
  trSave();
  trGotoStep(3);
}

// ===================== Step2: export split chapters =====================

/**
 * "导出": prompt user to pick a target directory via native file manager (/api/browse),
 * then package split chapters into individual .txt files inside a .zip file and save to target directory.
 */
function trStep2Export() {
  var chapters = trState.chapters || [];
  if (!chapters.length) {
    trToast(trT('trSplitFirst') || '请先切分章节', 'warning');
    return;
  }
  var btn = document.getElementById('tr-s2-export');
  if (btn) btn.disabled = true;

  // Open native directory picker
  trApiPost('/browse', { mode: 'directory', initialPath: '' }).then(function (res) {
    if (!res || !res.path) {
      if (btn) btn.disabled = false;
      return; // user cancelled dialog
    }
    var targetDir = res.path;
    var baseName = (trState.fileName ? trState.fileName.replace(/\.[^/.]+$/, '') : 'novel');
    var zipName = baseName + '_chapters.zip';

    var payload = {
      targetDir: targetDir,
      zipName: zipName,
      chapters: chapters.map(function (c, idx) {
        return {
          title: c.title || ('Chapter ' + (idx + 1)),
          content: c.content || ''
        };
      })
    };

    return trApiPost('/text-review/export-split', payload).then(function (expRes) {
      if (btn) btn.disabled = false;
      if (expRes && expRes.error) {
        trToast(expRes.error, 'error');
        return;
      }
      var outPath = (expRes && expRes.path) || zipName;
      var count = (expRes && expRes.count) || chapters.length;
      trToast((typeof trT === 'function' ? trT('trExportZipSuccess', [count, outPath]) : '') || ('已导出 ' + count + ' 个章节至: ' + outPath), 'success');
    });
  }).catch(function (err) {
    if (btn) btn.disabled = false;
    trToast((typeof trT === 'function' ? trT('trExportFailed') : '') || ('导出失败: ' + (err && err.message || err)), 'error');
  });
}

// ===================== Step2: dedup（重复块扫描 + 清除） =====================

var trS2DedupReport = null;

/**
 * 去重区渲染：扫描按钮常驻；有报告时展示块列表（起点行号+行数+预览）与
 * 广告行数，应用/丢弃按钮。扫描耗时 <100ms，同步执行。
 */
function trStep2RenderDedup() {
  var box = document.getElementById('tr-s2-dedup');
  if (!box) return;
  if (!window.TRDedup) {
    box.innerHTML = '';
    return;
  }
  if (!trS2DedupReport) {
    box.innerHTML =
      '<button type="button" class="tr-btn" id="tr-s2-dedup-scan">' +
        trEscapeHtml(trT('trDedupScan') || '去重扫描') + '</button>';
    var scanBtn = document.getElementById('tr-s2-dedup-scan');
    if (scanBtn) scanBtn.addEventListener('click', trStep2DedupScan);
    return;
  }
  var r = trS2DedupReport;
  var html = '<div class="tr-hint">RAW_TEXT_PLACEHOLDER</div>';
  html = html.replace('RAW_TEXT_PLACEHOLDER', trEscapeHtml(
    (trT('trDedupFound', [String(r.blocks.length), String(r.adLines.length)]) ||
      ('发现重复块 ' + r.blocks.length + ' 处，广告行 ' + r.adLines.length + ' 行')) +
    (r.singleLineGroups ? ('（另有 ' + r.singleLineGroups + ' 组单行复用，仅提示不删除）') : '')));
  if (r.blocks.length) {
    html += '<table class="tr-preview-table"><thead><tr>' +
      '<th class="tr-col-idx">#</th>' +
      '<th class="tr-col-title">' + trEscapeHtml(trT('trDedupBlock') || '重复块') + '</th>' +
      '<th class="tr-col-len">' + trEscapeHtml(trT('trCharCount') || '字') + '</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < r.blocks.length; i++) {
      var b = r.blocks[i];
      html += '<tr><td class="tr-col-idx">' + (i + 1) + '</td>' +
        '<td class="tr-col-title">' + trEscapeHtml('行' + (b.aStart + 1) + ' ⇄ 行' + (b.bStart + 1) + ' · ' + b.lines + '行 · ' + (b.preview || '')) + '</td>' +
        '<td class="tr-col-len">' + b.chars + '</td></tr>';
    }
    html += '</tbody></table>';
  }
  html += '<div class="tr-s2-controls2" style="margin-top:8px">' +
    '<button type="button" class="tr-btn tr-btn-primary" id="tr-s2-dedup-apply">' +
      trEscapeHtml(trT('trDedupApply') || '应用去重') + '</button>' +
    '<button type="button" class="tr-btn tr-btn-ghost" id="tr-s2-dedup-drop">' +
      trEscapeHtml(trT('trDedupDrop') || '丢弃') + '</button>' +
    '<button type="button" class="tr-btn" id="tr-s2-dedup-rescan">' +
      trEscapeHtml(trT('trDedupScan') || '去重扫描') + '</button>' +
    '</div>';
  box.innerHTML = html;
  var applyBtn = document.getElementById('tr-s2-dedup-apply');
  if (applyBtn) applyBtn.addEventListener('click', trStep2DedupApply);
  var dropBtn = document.getElementById('tr-s2-dedup-drop');
  if (dropBtn) dropBtn.addEventListener('click', function () { trS2DedupReport = null; trStep2RenderDedup(); });
  var rescanBtn = document.getElementById('tr-s2-dedup-rescan');
  if (rescanBtn) rescanBtn.addEventListener('click', trStep2DedupScan);
}

/**
 * 去重扫描：对 trState.rawText 跑 TRDedup.scanDuplicates，存报告并渲染。
 */
function trStep2DedupScan() {
  if (!trState.rawText) {
    trToast(trT('trImportFirst'), 'warning');
    return;
  }
  if (!window.TRDedup) {
    trToast('Dedup unavailable', 'error');
    return;
  }
  trS2DedupReport = window.TRDedup.scanDuplicates(trState.rawText, {});
  trStep2RenderDedup();
}

/**
 * 应用去重：TRDedup.applyDedup 重写 trState.rawText，清空报告，重新切分。
 */
function trStep2DedupApply() {
  if (!trS2DedupReport || !trState.rawText) return;
  var res = window.TRDedup.applyDedup(trState.rawText, trS2DedupReport, {});
  trState.rawText = res.text;
  trS2DedupReport = null;
  trSave();
  trStep2RenderDedup();
  trStep2DoSplit();
  trToast(trT('trDedupApplied', [String(res.removedBlocks), String(res.removedAdLines)]) ||
    ('已清除重复块 ' + res.removedBlocks + ' 处，广告行 ' + res.removedAdLines + ' 行'), 'success');
}



