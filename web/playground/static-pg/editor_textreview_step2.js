// editor_textreview_step2.js — Step2 panel: 章节切分 (chapter splitting).
// Exposes window.trRenderStep2(panel, state).
// Uses window.TR.* (P4): pattern selector (dropdown from backend list + TR
// .DEFAULT_SPLIT_PATTERNS, with an "edit patterns" drawer via pg-modal),
// "自动检测" button (TR.detectChapterPattern), live preview table (TR
// .splitChapters + TR.applyTitleTemplate), title-template input, optional
// "AI 拆分" button that POSTs a single chapter's content to /v1/chat/completions
// (stream:false) with a split prompt and reparses results via TR.
// Mirrors editor.js style: 'use strict' + function + var.

'use strict';

// Split prompt for the optional "AI 拆分" feature. Sends a single chunk of
// text and asks the model to emit one chapter-title line per detected break.
var TR_AI_SPLIT_PROMPT =
  '你是章节切分助手。请阅读下面的文本，找出所有章节标题行（即正文中出现的章/回/节/卷等章节边界）。' +
  '只输出你识别出的章节标题，每行一个，按出现顺序排列，不要输出任何解释文字、不要输出正文内容。' +
  '如果无法识别章节标题，输出空行。';

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
  var selKey = state.selectedPatternKey || 'zhang';
  var hasChapters = !!(state.chapters && state.chapters.length);
  var freshEntry = !hasChapters; // auto-detect only on fresh entry

  panel.innerHTML = '';

  var root = document.createElement('div');
  root.className = 'tr-step-panel tr-s2-root';
  root.style.height = '100%';
  root.style.minHeight = '0';
  panel.appendChild(root);

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

  root.appendChild(header);

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

  // Row 2: Inputs (Left: Select | Right: Text Input)
  var i1 = document.createElement('div');
  i1.className = 'tr-s2-col';
  var patSelect = document.createElement('select');
  patSelect.className = 'tr-select';
  patSelect.id = 'tr-s2-pattern';
  for (var i = 0; i < patterns.length; i++) {
    var opt = document.createElement('option');
    opt.value = patterns[i].key;
    opt.textContent = patterns[i].label || patterns[i].key;
    if (patterns[i].key === selKey) opt.selected = true;
    patSelect.appendChild(opt);
  }
  patSelect.addEventListener('change', trStep2OnPatternChange);
  i1.appendChild(patSelect);
  grid.appendChild(i1);

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
  customRow.style.display = selKey === 'custom' ? '' : 'none';

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
  root.appendChild(configPanel);

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

  root.appendChild(c2);

  // --- Detect info hint ---
  var infoEl = document.createElement('div');
  infoEl.className = 'tr-hint';
  infoEl.id = 'tr-s2-detect-info';
  root.appendChild(infoEl);

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

  previewSection.appendChild(previewHead);

  var previewWrap = document.createElement('div');
  previewWrap.className = 'tr-preview-wrap';
  previewWrap.id = 'tr-s2-preview';
  previewSection.appendChild(previewWrap);

  root.appendChild(previewSection);

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
    var sel = document.getElementById('tr-s2-pattern');
    if (sel) sel.value = res.patternKey;
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
    return;
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
  var chapters = trState.chapters || [];
  if (count) count.textContent = String(chapters.length);
  if (next) next.disabled = chapters.length === 0;
  if (!wrap) return;
  if (chapters.length === 0) {
    wrap.innerHTML = '<div class="tr-empty">' + trEscapeHtml(trT('trNoChapters')) + '</div>';
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
}
// trS2SelectChapter shows the chapter's original content in the right pane
// (#ed-review-content) so the user can preview a split chapter before cleaning.
function trS2SelectChapter(idx) {
  var chapters = trState.chapters || [];
  if (idx < 0 || idx >= chapters.length) return;
  var pane = document.getElementById('ed-review-content');
  if (!pane) return;
  pane.textContent = chapters[idx].content || '';
  var rows = document.querySelectorAll('#tr-s2-preview tbody tr');
  for (var i = 0; i < rows.length; i++) rows[i].classList.remove('selected');
  if (rows[idx]) rows[idx].classList.add('selected');
}

// ===================== Step2: AI split (optional) =====================

/**
 * "AI 拆分": send the rawText (or a truncated prefix if very large) to
 * /v1/chat/completions (stream:false) with a split prompt; parse the returned
 * title lines and re-split using a synthesized custom regex OR just refresh
 * the detect info. This is a one-shot, best-effort feature — failures are
 * surfaced as a toast and leave the existing regex split intact.
 */
function trStep2AISplit() {
  if (!trState.rawText) {
    trToast(trT('trImportFirst'), 'warning');
    return;
  }
  var btn = document.getElementById('tr-s2-aisplit');
  if (btn) { btn.disabled = true; btn.textContent = trT('trWorking'); }

  // Find first enabled review node for model routing through the proxy.
  var node = (trState.reviewNodes || []).filter(function (n) { return n.enabled; })[0];
  if (!node) {
    if (btn) { btn.disabled = false; btn.textContent = trT('trAISplit'); }
    trToast(trT('trAISplitNoNode'), 'warning');
    return;
  }
  // Build model string: proxy expects "providerPrefix/modelId" format.
  // modelId may or may not already include the prefix; if not, resolve it.
  var modelStr = node.modelId || '';
  if (modelStr.indexOf('/') === -1) {
    var prefix = (window._trS3ProviderPrefix && window._trS3ProviderPrefix(node.providerId)) || '';
    if (prefix) {
      modelStr = prefix + '/' + modelStr;
    }
  }

  var sample = trState.rawText.length > 20000 ? trState.rawText.slice(0, 20000) : trState.rawText;
  var body = {
    model: modelStr,
    stream: false,
    messages: [
      { role: 'system', content: TR_AI_SPLIT_PROMPT },
      { role: 'user', content: sample }
    ]
  };
  fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function (resp) { return resp.json(); })
    .then(function (data) {
      if (btn) { btn.disabled = false; btn.textContent = trT('trAISplit'); }
      if (!data || data.error) {
        var em = (data && data.error);
        if (em && typeof em !== 'string') em = JSON.stringify(em);
        trToast(em || trT('trAISplitFailed'), 'error');
        return;
      }
      var content = trExtractChatContent(data);
      var info = document.getElementById('tr-s2-detect-info');
      if (info && content) {
        var lines = content.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return !!l; });
        info.textContent = trT('trAISplitResult', [String(lines.length)]) + (lines.length ? '：' + lines.slice(0, 5).join('、') : '');
      } else if (info) {
        info.textContent = trT('trAISplitEmpty');
      }
    })
    .catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = trT('trAISplit'); }
      console.warn('tr AI split failed:', err);
      trToast(trT('trAISplitFailed'), 'error');
    });
}

/**
 * Extract the assistant message text from a /v1/chat/completions response.
 */
function trExtractChatContent(data) {
  try {
    var choices = data && data.choices;
    if (choices && choices.length > 0) {
      var msg = choices[0].message;
      if (msg && typeof msg.content === 'string') return msg.content;
    }
  } catch (e) {}
  return '';
}

// ===================== Step2: pattern editor drawer =====================

/**
 * Open a pg-modal drawer to add/delete custom split patterns. Delegates to
 * pg-modal (pgShowModal/pgCloseModal) for the overlay; calls POST/DELETE
 * /api/text-review/split-patterns (P1) and refreshes trState.splitPatterns.
 */
function trStep2OpenPatternEditor() {
  if (typeof pgShowModal !== 'function') {
    trToast(trT('trPatternEditorUnavailable'), 'warning');
    return;
  }
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
            '<button type="button" class="tr-btn tr-btn-xs tr-btn-danger" onclick="trStep2DeletePattern(\'' +
              trEscapeHtml(p.key) + '\')">' + trEscapeHtml(trT('trDelete')) + '</button>') +
        '</td>' +
      '</tr>';
  }
  var html =
    '<div class="pg-modal-header">' +
      '<span class="pg-modal-title">' + trEscapeHtml(trT('trPatternEditor')) + '</span>' +
      '<button class="pg-modal-close" onclick="pgCloseModal()">\u2715</button>' +
    '</div>' +
    '<div class="pg-modal-body" style="max-height:70vh;overflow-y:auto">' +
      '<table class="tr-pe-table"><thead><tr>' +
        '<th>' + trEscapeHtml(trT('trPatternKey')) + '</th>' +
        '<th>' + trEscapeHtml(trT('trPatternLabel')) + '</th>' +
        '<th>' + trEscapeHtml(trT('trPatternRegex')) + '</th>' +
        '<th>' + trEscapeHtml(trT('trActions')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<hr class="tr-pe-sep">' +
      '<h4>' + trEscapeHtml(trT('trAddPattern')) + '</h4>' +
      '<div class="tr-pe-form">' +
        '<input type="text" id="tr-pe-new-key" class="tr-input" placeholder="' + trEscapeHtml(trT('trPatternKeyPlaceholder')) + '">' +
        '<input type="text" id="tr-pe-new-label" class="tr-input" placeholder="' + trEscapeHtml(trT('trPatternLabelPlaceholder')) + '">' +
        '<input type="text" id="tr-pe-new-regex" class="tr-input" placeholder="' + trEscapeHtml(trT('trPatternRegexPlaceholder')) + '">' +
        '<button type="button" class="tr-btn tr-btn-primary" onclick="trStep2AddPattern()">' + trEscapeHtml(trT('trAdd')) + '</button>' +
      '</div>' +
      '<p class="tr-hint">' + trEscapeHtml(trT('trPatternRegexHint')) + '</p>' +
    '</div>';
  pgShowModal(html);
}

/**
 * Add a custom pattern via POST /api/text-review/split-patterns (P1), then
 * re-merge backend patterns and refresh the drawer.
 */
function trStep2AddPattern() {
  var keyEl = document.getElementById('tr-pe-new-key');
  var labelEl = document.getElementById('tr-pe-new-label');
  var regexEl = document.getElementById('tr-pe-new-regex');
  var key = keyEl ? keyEl.value.trim() : '';
  var label = labelEl ? labelEl.value.trim() : '';
  var regex = regexEl ? regexEl.value.trim() : '';
  if (!key) { trToast(trT('trPatternKeyRequired'), 'warning'); return; }
  trApiPost('/text-review/split-patterns', {
    key: key, label: label || key, regex: regex, builtin: false
  }).then(function (res) {
    if (res && res.error) { trToast(res.error, 'error'); return; }
    return trApiGet('/text-review/split-patterns');
  }).then(function (res) {
    var backendPats = (res && !res.error && Array.isArray(res.patterns)) ? res.patterns : [];
    trMergePatterns(backendPats);
    trSave();
    trStep2RenderPatternEditor();
  }).catch(function (err) {
    console.warn('tr add pattern failed:', err);
    trToast(trT('trPatternSaveFailed'), 'error');
  });
}

/**
 * Delete a pattern via DELETE /api/text-review/split-patterns/{key} (P1).
 * Built-in keys are blocked server-side anyway; we guard the 'custom' row
 * client-side (it has no delete button).
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
