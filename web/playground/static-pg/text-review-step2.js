// text-review-step2.js — Step2 panel: 章节切分 (chapter splitting).
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

  // Pattern dropdown options
  var opts = '';
  for (var i = 0; i < patterns.length; i++) {
    var p = patterns[i];
    opts += '<option value="' + trEscapeHtml(p.key) + '"' +
      (p.key === selKey ? ' selected' : '') + '>' +
      trEscapeHtml(p.label || p.key) + '</option>';
  }

  panel.innerHTML =
    '<div class="tr-step-panel">' +
      '<div class="tr-section">' +
        '<h3 class="tr-section-title">' + trEscapeHtml(trT('trStepSplit')) + '</h3>' +
        '<p class="tr-section-desc">' + trEscapeHtml(trT('trSplitDesc')) + '</p>' +

        '<div class="tr-row">' +
          '<label class="tr-label" for="tr-s2-pattern">' + trEscapeHtml(trT('trPattern')) + '</label>' +
          '<select class="tr-select" id="tr-s2-pattern" onchange="trStep2OnPatternChange()">' + opts + '</select>' +
          '<button type="button" class="tr-btn" onclick="trStep2OpenPatternEditor()">' +
            trEscapeHtml(trT('trPatternEditor')) + '</button>' +
        '</div>' +

        '<div class="tr-row" id="tr-s2-custom-row"' +
          (selKey === 'custom' ? '' : ' style="display:none"') + '>' +
          '<label class="tr-label" for="tr-s2-custom-regex">' + trEscapeHtml(trT('trCustomRegex')) + '</label>' +
          '<input type="text" class="tr-input" id="tr-s2-custom-regex" placeholder="' +
            trEscapeHtml(trT('trCustomRegexPlaceholder')) + '" value="' +
            trEscapeHtml(state.customRegex || '') + '" oninput="trStep2OnCustomChange()">' +
        '</div>' +

        '<div class="tr-btn-row">' +
          '<button type="button" class="tr-btn" onclick="trStep2AutoDetect()">' +
            trEscapeHtml(trT('trAutoDetect')) + '</button>' +
          '<button type="button" class="tr-btn" onclick="trStep2ReSplit()">' +
            trEscapeHtml(trT('trResplit')) + '</button>' +
          '<button type="button" class="tr-btn tr-btn-ghost" id="tr-s2-aisplit" onclick="trStep2AISplit()">' +
            trEscapeHtml(trT('trAISplit')) + '</button>' +
        '</div>' +
        '<div class="tr-hint" id="tr-s2-detect-info"></div>' +

        '<div class="tr-row">' +
          '<label class="tr-label" for="tr-s2-template">' + trEscapeHtml(trT('trTitleTemplate')) + '</label>' +
          '<input type="text" class="tr-input" id="tr-s2-template" placeholder="' +
            trEscapeHtml(trT('trTitleTemplatePlaceholder')) + '" value="' +
            trEscapeHtml(state.titleTemplate || '') + '" oninput="trStep2OnTemplateChange()">' +
          '<label class="tr-check"><input type="checkbox" id="tr-s2-keeppro" onchange="trStep2OnKeepPrologue()"' +
            (state.keepPrologue ? ' checked' : '') + '> ' + trEscapeHtml(trT('trKeepPrologue')) + '</label>' +
        '</div>' +
      '</div>' +

      '<div class="tr-section">' +
        '<h3 class="tr-section-title">' + trEscapeHtml(trT('trPreview')) +
          ' <span class="tr-count" id="tr-s2-count">0</span></h3>' +
        '<div class="tr-preview-wrap" id="tr-s2-preview"></div>' +
      '</div>' +

      '<div class="tr-step-footer">' +
        '<button type="button" class="tr-btn tr-btn-ghost" onclick="trGotoStep(1)">' +
          trEscapeHtml(trT('trPrev')) + '</button>' +
        '<span class="tr-spacer"></span>' +
        '<button type="button" class="tr-btn tr-btn-primary" id="tr-s2-next" ' +
          (hasChapters ? '' : 'disabled') +
          ' onclick="trStep2Next()">' + trEscapeHtml(trT('trNext')) + '</button>' +
      '</div>' +
    '</div>';

  // Render an initial preview (uses persisted chapters if present and pattern
  // matches; otherwise re-splits from rawText).
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
  trStep2ReSplit();
}

function trStep2OnCustomChange() {
  var inp = document.getElementById('tr-s2-custom-regex');
  if (!inp) return;
  trState.customRegex = inp.value;
  trSave();
  if (trState.selectedPatternKey === 'custom') {
    trStep2ReSplit();
  }
}

function trStep2OnTemplateChange() {
  var inp = document.getElementById('tr-s2-template');
  if (!inp) return;
  trState.titleTemplate = inp.value;
  trSave();
  trStep2RenderPreview();
}

function trStep2OnKeepPrologue() {
  var cb = document.getElementById('tr-s2-keeppro');
  if (!cb) return;
  trState.keepPrologue = cb.checked;
  trSave();
  trStep2ReSplit();
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
function trStep2AutoDetect() {
  if (!window.TR || !window.TR.detectChapterPattern || !trState.rawText) {
    trToast(trT('trImportFirst'), 'warning');
    return;
  }
  // detectChapterPattern expects the stored (regex-string) form; pass the
  // trState.splitPatterns de-compiled back to strings is unnecessary because
  // compilePatterns is idempotent on stored form — but detectChapterPattern
  // calls TR.compilePatterns internally, so pass the stored form. We keep a
  // stored-form copy by mapping runtime -> stored (regex back to source).
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
    trStep2ReSplit();
    if (info) info.textContent = (res.reason || '') + (res.hitCount != null ? ' (' + res.hitCount + ')' : '');
  } else {
    if (info) info.textContent = (res && res.reason) ? res.reason : trT('trDetectNoMatch');
  }
}

/**
 * Re-split trState.rawText with the current pattern/template/prologue settings
 * and store the result in trState.chapters; refresh the preview + next button.
 */
function trStep2ReSplit() {
  if (!window.TR || !window.TR.splitChapters || !trState.rawText) {
    trState.chapters = [];
    trStep2RenderPreview();
    return;
  }
  var resolved = trStep2ResolveRegex();
  // No usable regex → TR.splitChapters returns a single "全文（未匹配）" chapter
  // when given a null regex is NOT supported; guard by passing a never-matching
  // regex so the whole text becomes one prologue chapter instead.
  var regex = resolved.regex;
  if (!regex) {
    // Use a regex that matches nothing (zero-width at an impossible position).
    regex = /(?!)/;
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
    html += '<tr' + (c.isVolume ? ' class="tr-row-volume"' : '') + '>' +
      '<td class="tr-col-idx">' + (i + 1) + '</td>' +
      '<td class="tr-col-title">' + trEscapeHtml(c.title || '') + '</td>' +
      '<td class="tr-col-len">' + len + '</td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
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
  // Truncate to a reasonable prefix to keep the request small — we only need
  // the model to identify title lines, not process the whole body.
  var sample = trState.rawText.length > 20000 ? trState.rawText.slice(0, 20000) : trState.rawText;
  var body = {
    model: '', // empty model → proxy picks the default / first model
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
        trToast((data && data.error) || trT('trAISplitFailed'), 'error');
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
      '<button class="pg-modal-close" onclick="pgCloseModal()">✕</button>' +
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
    // Re-fetch merged patterns then refresh the drawer.
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
