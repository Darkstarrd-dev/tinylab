// editor_textreview_step4.js — Step4 panel: 审校 (review) — P7.
// Exposes window.trRenderStep4(panel, state).
//
// Per-chapter two-column diff (window.editorAlignedDiff) with per-row
// ✓(accept) / ✗(reject) / ✎(edit) decisions, batch accept/reject/reset,
// decisions persisted in trState.lineDecisions + trSave (切页不丢), final
// text via window.TR.applyLineDecisions, Blob-download export, and a
// per-chapter reprocess link. Mirrors editor.js style: 'use strict' +
// function + var, browser globals only.

'use strict';

// ===================== module state =====================

var trS4Snapshot = null;     // last fetched session snapshot {chapters, fileName, status, ...}
var trS4Completed = [];      // completed chapters (status==='completed'), with content+cleaned
var trS4Selected = -1;       // selected chapter's backend `index` (-1 = none)
var trS4Rows = [];            // DiffRow[] for the selected chapter (window.editorAlignedDiff output)
var trS4Decisions = null;    // ref to trState.lineDecisions[selectedIdx] (object or null)

// ===================== main render =====================

/**
 * Render the Step4 (review) panel.
 * @param {HTMLElement} panel container element
 * @param {object} state trState
 */
window.trRenderStep4 = function (panel, state) {
  panel.innerHTML =
    '<div class="tr-step-panel tr-s4-panel">' +
      '<div class="tr-s4-layout" id="tr-s4-layout">' +
        '<div class="tr-empty">' + trEscapeHtml(trT('trLoading')) + '</div>' +
      '</div>' +
      '<div class="tr-step-footer">' +
        '<button type="button" class="tr-btn tr-btn-ghost" onclick="trGotoStep(3)">' +
          trEscapeHtml(trT('trPrev')) + '</button>' +
        '<span class="tr-spacer"></span>' +
        '<button type="button" class="tr-btn" id="tr-s4-exportall" onclick="trS4ExportAll()" disabled>' +
          trEscapeHtml(trT('trS4ExportAll')) + '</button>' +
      '</div>' +
    '</div>';

  if (!trState.sessionId) {
    trS4RenderEmpty(trT('trS4NoSession'));
    return;
  }
  trS4Load();
};

// ===================== snapshot fetch =====================

/**
 * Fetch GET /sessions/{id}, keep completed chapters, and render the chapter
 * list + default diff. Re-fetched on every render so the latest cleaned text
 * is shown (e.g. after a Step3 reprocess). Decisions restore from
 * trState.lineDecisions (persisted) — 切页不丢.
 */
function trS4Load() {
  var layout = document.getElementById('tr-s4-layout');
  if (!layout) return;
  trApiGet('/text-review/sessions/' + encodeURIComponent(trState.sessionId)).then(function (res) {
    if (!res || res.error || !Array.isArray(res.chapters)) {
      trS4Snapshot = null;
      trS4Completed = [];
      trS4RenderEmpty(trT('trS4NoSession'));
      return;
    }
    trS4Snapshot = res;
    trS4Completed = res.chapters.filter(function (c) {
      return c.status === 'completed' && typeof c.cleaned === 'string' && typeof c.content === 'string';
    });
    if (trS4Completed.length === 0) {
      trS4RenderLayout();
      var diff = document.getElementById('tr-s4-diff');
      if (diff) diff.innerHTML = '<div class="tr-empty">' + trEscapeHtml(trT('trS4NoCompleted')) + '</div>';
      var allBtn0 = document.getElementById('tr-s4-exportall');
      if (allBtn0) allBtn0.disabled = true;
      return;
    }
    // Keep the previous selection if still valid, else pick the first.
    var stillValid = false;
    for (var i = 0; i < trS4Completed.length; i++) {
      if (trS4Completed[i].index === trS4Selected) { stillValid = true; break; }
    }
    if (!stillValid) trS4Selected = trS4Completed[0].index;
    trS4RenderLayout();
    trS4SelectChapter(trS4Selected);
    var allBtn = document.getElementById('tr-s4-exportall');
    if (allBtn) allBtn.disabled = false;
  }, function () {
    trS4Snapshot = null;
    trS4Completed = [];
    trS4RenderEmpty(trT('trS4NoSession'));
  });
}

// ===================== layout + empty state =====================

function trS4RenderEmpty(msg) {
  trS4RenderLayout();
  var diff = document.getElementById('tr-s4-diff');
  if (diff) diff.innerHTML = '<div class="tr-empty">' + trEscapeHtml(msg) + '</div>';
  var allBtn = document.getElementById('tr-s4-exportall');
  if (allBtn) allBtn.disabled = true;
}

function trS4RenderLayout() {
  var layout = document.getElementById('tr-s4-layout');
  if (!layout) return;
  layout.innerHTML =
    '<div class="tr-s4-sidebar" id="tr-s4-sidebar"></div>' +
    '<div class="tr-s4-main" id="tr-s4-main">' +
      '<div class="tr-s4-toolbar" id="tr-s4-toolbar"></div>' +
      '<div class="tr-s4-diff" id="tr-s4-diff"></div>' +
      '<div class="tr-s4-preview-slot" id="tr-s4-preview-slot"></div>' +
    '</div>';
  trS4RenderChapterList();
}

// ===================== chapter selector =====================

function trS4RenderChapterList() {
  var side = document.getElementById('tr-s4-sidebar');
  if (!side) return;
  var html = '<div class="tr-s4-sidebar-head">' + trEscapeHtml(trT('trS4Chapters')) + '</div>';
  for (var i = 0; i < trS4Completed.length; i++) {
    var c = trS4Completed[i];
    var active = (c.index === trS4Selected) ? ' active' : '';
    html +=
      '<button type="button" class="tr-s4-chapter' + active + '"' +
        ' onclick="trS4SelectChapter(' + c.index + ')" data-idx="' + c.index + '">' +
        '<span class="tr-s4-chapter-num">#' + (c.index + 1) + '</span>' +
        '<span class="tr-s4-chapter-title">' + trEscapeHtml(c.title || ('#' + (c.index + 1))) + '</span>' +
        (c.nodeId && window.trS3NodeNumbers && window.trS3NodeNumbers[c.nodeId] ? '<span class="tr-node-badge">' + window.trS3NodeNumbers[c.nodeId] + '</span>' : '') +
      '</button>';
  }
  side.innerHTML = html;
}

/**
 * Select a chapter by backend index: compute its diff rows, bind the live
 * decisions ref from trState.lineDecisions[index], then render toolbar + diff.
 */
function trS4SelectChapter(idx) {
  var ch = trS4FindChapter(idx);
  if (!ch) return;
  trS4Selected = idx;
  trS4Rows = window.editorAlignedDiff(ch.content || '', ch.cleaned || '');
  if (!trState.lineDecisions[idx]) trState.lineDecisions[idx] = {};
  trS4Decisions = trState.lineDecisions[idx];
  trS4ClosePreview();
  trS4RenderChapterList();
  trS4RenderToolbar();
  trS4RenderDiff();
}

function trS4FindChapter(idx) {
  for (var i = 0; i < trS4Completed.length; i++) {
    if (trS4Completed[i].index === idx) return trS4Completed[i];
  }
  return null;
}

// ===================== toolbar (stats + batch + export) =====================

function trS4RenderToolbar() {
  var bar = document.getElementById('tr-s4-toolbar');
  if (!bar) return;
  var stats = (typeof window.edDiffStats === 'function') ? window.edDiffStats(trS4Rows) : trS4ComputeStats(trS4Rows);
  var ch = trS4FindChapter(trS4Selected);
  var title = ch ? (ch.title || ('#' + (trS4Selected + 1))) : '';
  bar.innerHTML =
    '<div class="tr-s4-toolbar-row">' +
      '<div class="tr-s4-toolbar-title">' + trEscapeHtml(title) + '</div>' +
      '<div class="tr-s4-stats">' + trEscapeHtml(trT('trS4Stats', [String(stats.mod), String(stats.add), String(stats.del)])) + '</div>' +
    '</div>' +
    '<div class="tr-s4-toolbar-row">' +
      '<button type="button" class="tr-btn tr-btn-xs" onclick="trS4BatchAll(\'accept\')">' + trEscapeHtml(trT('trS4AcceptAll')) + '</button>' +
      '<button type="button" class="tr-btn tr-btn-xs" onclick="trS4BatchAll(\'reject\')">' + trEscapeHtml(trT('trS4RejectAll')) + '</button>' +
      '<button type="button" class="tr-btn tr-btn-xs tr-btn-ghost" onclick="trS4ResetChapter()">' + trEscapeHtml(trT('trS4Reset')) + '</button>' +
      '<span class="tr-spacer"></span>' +
      '<button type="button" class="tr-btn tr-btn-xs" onclick="trS4PreviewFinal()">' + trEscapeHtml(trT('trS4Preview')) + '</button>' +
      '<button type="button" class="tr-btn tr-btn-xs tr-btn-primary" onclick="trS4ExportChapter()">' + trEscapeHtml(trT('trS4ExportChapter')) + '</button>' +
      '<button type="button" class="tr-btn tr-btn-xs tr-btn-ghost" onclick="trS4Reprocess(' + trS4Selected + ')">' + trEscapeHtml(trT('trS4ReprocessChapter')) + '</button>' +
    '</div>';
}

function trS4ComputeStats(rows) {
  var s = { del: 0, add: 0, mod: 0 };
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].type === 'del') s.del++;
    else if (rows[i].type === 'add') s.add++;
    else if (rows[i].type === 'mod') s.mod++;
  }
  return s;
}

// ===================== diff render =====================

/**
 * Render the two-column diff for the selected chapter. Each decisional row
 * (mod/add/del) gets ✓/✗/✎ controls; the right cell reflects the current
 * decision (accept→cleaned, reject→original/removed, edit→content) so the
 * column doubles as a per-row "final" preview. Decisions restore from
 * trS4Decisions (persisted) on every render — 切页不丢.
 */
function trS4RenderDiff() {
  var diff = document.getElementById('tr-s4-diff');
  if (!diff) return;
  var html = '';
  for (var i = 0; i < trS4Rows.length; i++) {
    html += trS4RowHtml(trS4Rows[i], i);
  }
  diff.innerHTML = html;
}

/**
 * Build one diff row. The left cell always shows the original (left) text;
 * the right cell shows the per-row "final" text given the current decision.
 */
function trS4RowHtml(row, idx) {
  var d = trS4Decisions ? trS4Decisions[idx] : null;
  var type = row.type;
  var cls = 'tr-s4-row tr-s4-row-' + type;
  var leftText = trS4LeftHtml(row, d);
  var rightText = trS4RightHtml(row, d);
  var ctrl = (type === 'context') ? '' : trS4CtrlHtml(idx, d);
  return (
    '<div class="' + cls + '" id="tr-s4-row-' + idx + '">' +
      '<div class="tr-s4-cell tr-s4-left">' + leftText + '</div>' +
      '<div class="tr-s4-cell tr-s4-right">' + rightText +
        '<div class="tr-s4-ctrl" id="tr-s4-ctrl-' + idx + '">' + ctrl + '</div>' +
      '</div>' +
    '</div>'
  );
}

// Left cell: original left text with char-level parts for mod rows.
function trS4LeftHtml(row, d) {
  if (!row.left) return trS4NumHtml('');
  if (row.type === 'mod' && row.leftParts && (!d || d.action === 'accept')) {
    return trS4NumHtml(row.left.num) + trS4PartsHtml(row.leftParts, 'del');
  }
  return trS4NumHtml(row.left.num) + '<span class="tr-s4-text">' + trEscapeHtml(row.left.text) + '</span>';
}

// Right cell: the per-row "final" text given the current decision.
function trS4RightHtml(row, d) {
  if (!row.right) return trS4NumHtml('');
  // Default/accept: show the cleaned text (with char-level highlight for mod).
  if (!d || d.action === 'accept') {
    if (row.type === 'mod' && row.rightParts) {
      return trS4NumHtml(row.right.num) + trS4PartsHtml(row.rightParts, 'add');
    }
    return trS4NumHtml(row.right.num) + '<span class="tr-s4-text">' + trEscapeHtml(row.right.text) + '</span>';
  }
  if (d.action === 'reject') {
    // reject: mod/add → original left text (add → removed: blank right); del → restored left text.
    if (row.type === 'add') return trS4NumHtml('');
    var src = row.left || row.right;
    return trS4NumHtml(row.right ? row.right.num : (src ? src.num : '')) +
      '<span class="tr-s4-text tr-s4-final">' + trEscapeHtml(src ? src.text : '') + '</span>';
  }
  // edit: show the edited content as the final text.
  var content = (d.content != null) ? d.content : row.right.text;
  return trS4NumHtml(row.right.num) +
    '<span class="tr-s4-text tr-s4-final tr-s4-edited">' + trEscapeHtml(content) + '</span>';
}

function trS4NumHtml(num) {
  return '<span class="tr-s4-num">' + (num == null ? '' : num) + '</span>';
}

// Char-level parts: kind='add' highlights added chars, kind='del' highlights removed.
function trS4PartsHtml(parts, kind) {
  if (!parts || !parts.length) return '<span class="tr-s4-text"></span>';
  var html = '<span class="tr-s4-text">';
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    var hl = (kind === 'add' && p.added) ? ' tr-s4-char-add' : (kind === 'del' && p.removed ? ' tr-s4-char-del' : '');
    html += '<span class="tr-s4-char' + hl + '">' + trEscapeHtml(p.text) + '</span>';
  }
  html += '</span>';
  return html;
}

function trS4CtrlHtml(idx, d) {
  var a = (d && d.action === 'accept') ? ' active' : '';
  var r = (d && d.action === 'reject') ? ' active' : '';
  var e = (d && d.action === 'edit') ? ' active' : '';
  return (
    '<button type="button" class="tr-s4-btn tr-s4-accept' + a + '"' +
      ' title="' + trEscapeHtml(trT('trS4Accept')) + '"' +
      ' onclick="trS4Decision(' + idx + ',\'accept\')">✓</button>' +
    '<button type="button" class="tr-s4-btn tr-s4-reject' + r + '"' +
      ' title="' + trEscapeHtml(trT('trS4Reject')) + '"' +
      ' onclick="trS4Decision(' + idx + ',\'reject\')">✗</button>' +
    '<button type="button" class="tr-s4-btn tr-s4-edit' + e + '"' +
      ' title="' + trEscapeHtml(trT('trS4Edit')) + '"' +
      ' onclick="trS4BeginEdit(' + idx + ')">✎</button>'
  );
}

// Re-render a single row in place (used after a decision/edit change).
function trS4RenderRow(idx) {
  var el = document.getElementById('tr-s4-row-' + idx);
  if (!el) return;
  var row = trS4Rows[idx];
  if (!row) return;
  var d = trS4Decisions ? trS4Decisions[idx] : null;
  el.className = 'tr-s4-row tr-s4-row-' + row.type;
  el.innerHTML =
    '<div class="tr-s4-cell tr-s4-left">' + trS4LeftHtml(row, d) + '</div>' +
    '<div class="tr-s4-cell tr-s4-right">' + trS4RightHtml(row, d) + '</div>' +
    '<div class="tr-s4-ctrl" id="tr-s4-ctrl-' + idx + '">' + (row.type === 'context' ? '' : trS4CtrlHtml(idx, d)) + '</div>';
}

// ===================== per-row decision handler =====================

/**
 * Set the decision for a diff row, persist it, and re-render the row so the
 * right cell + button highlight reflect the new choice.
 */
function trS4Decision(idx, action, content) {
  if (!trS4Decisions) return;
  if (action === 'edit') {
    trS4Decisions[idx] = { action: 'edit', content: content };
  } else {
    trS4Decisions[idx] = { action: action };
  }
  trSave();
  trS4RenderRow(idx);
}

// ===================== inline edit =====================

/**
 * Open an inline edit textarea in the right cell. Pre-filled with the row's
 * current "final" text (cleaned for mod/add, original for del).
 */
function trS4BeginEdit(idx) {
  var row = trS4Rows[idx];
  if (!row) return;
  var d = trS4Decisions ? trS4Decisions[idx] : null;
  var prefill = '';
  if (d && d.action === 'edit' && d.content != null) prefill = d.content;
  else if (d && d.action === 'reject') prefill = row.left ? row.left.text : '';
  else prefill = row.right ? row.right.text : (row.left ? row.left.text : '');
  var right = document.querySelector('#tr-s4-row-' + idx + ' .tr-s4-right');
  if (!right) return;
  right.innerHTML =
    trS4NumHtml(row.right ? row.right.num : '') +
    '<textarea class="tr-s4-editarea" id="tr-s4-editarea-' + idx + '">' + trEscapeHtml(prefill) + '</textarea>' +
    '<span class="tr-s4-edit-actions">' +
      '<button type="button" class="tr-btn tr-btn-xs tr-btn-primary" onclick="trS4CommitEdit(' + idx + ')">' + trEscapeHtml(trT('trS4Save')) + '</button>' +
      '<button type="button" class="tr-btn tr-btn-xs tr-btn-ghost" onclick="trS4CancelEdit(' + idx + ')">' + trEscapeHtml(trT('trS4Cancel')) + '</button>' +
    '</span>';
  var ta = document.getElementById('tr-s4-editarea-' + idx);
  if (ta) { ta.focus(); ta.select(); }
}

function trS4CommitEdit(idx) {
  var ta = document.getElementById('tr-s4-editarea-' + idx);
  if (!ta) return;
  trS4Decision(idx, 'edit', ta.value);
}

function trS4CancelEdit(idx) {
  trS4RenderRow(idx);
}

// ===================== batch operations =====================

/**
 * Batch set every decisional row (mod/add/del) in the current chapter to the
 * given action, then re-render the diff.
 */
function trS4BatchAll(action) {
  if (!trS4Decisions) return;
  for (var i = 0; i < trS4Rows.length; i++) {
    var t = trS4Rows[i].type;
    if (t === 'mod' || t === 'add' || t === 'del') {
      trS4Decisions[i] = { action: action };
    }
  }
  trSave();
  trS4RenderDiff();
}

/**
 * Clear all decisions for the current chapter (back to accept-everywhere
 * defaults), persist, and re-render.
 */
function trS4ResetChapter() {
  if (trS4Selected < 0) return;
  if (trState.lineDecisions[trS4Selected]) {
    trState.lineDecisions[trS4Selected] = {};
  }
  trS4Decisions = trState.lineDecisions[trS4Selected] || {};
  trSave();
  trS4RenderDiff();
}

// ===================== final text + export =====================

/**
 * Compute the final text for the current chapter via TR.applyLineDecisions.
 */
function trS4FinalText() {
  if (!trS4Rows.length) return '';
  return window.TR.applyLineDecisions(trS4Rows, trS4Decisions || {});
}

/**
 * Compute the final text for an arbitrary completed chapter (used by export
 * all, which walks every chapter).
 */
function trS4ChapterFinalText(ch) {
  var rows = window.editorAlignedDiff(ch.content || '', ch.cleaned || '');
  var decs = trState.lineDecisions[ch.index] || {};
  return window.TR.applyLineDecisions(rows, decs);
}

/**
 * "预览最终文本": show the current chapter's final text in an inline pane
 * (toggles closed on a second click / close button).
 */
function trS4PreviewFinal() {
  var slot = document.getElementById('tr-s4-preview-slot');
  if (!slot) return;
  if (slot.innerHTML.trim()) { trS4ClosePreview(); return; }
  var text = trS4FinalText();
  var ch = trS4FindChapter(trS4Selected);
  var title = ch ? (ch.title || ('#' + (trS4Selected + 1))) : '';
  slot.innerHTML =
    '<div class="tr-s4-preview">' +
      '<div class="tr-s4-preview-head">' +
        '<span class="tr-s4-preview-title">' + trEscapeHtml(trT('trS4PreviewTitle')) + ' — ' + trEscapeHtml(title) + '</span>' +
        '<button type="button" class="tr-s4-preview-close" onclick="trS4ClosePreview()" title="' + trEscapeHtml(trT('trS4Close')) + '">×</button>' +
      '</div>' +
      '<pre class="tr-s4-preview-body">' + trEscapeHtml(text) + '</pre>' +
    '</div>';
}

function trS4ClosePreview() {
  var slot = document.getElementById('tr-s4-preview-slot');
  if (slot) slot.innerHTML = '';
}

/**
 * "导出本章": download the current chapter's final text as a .txt Blob.
 */
function trS4ExportChapter() {
  var ch = trS4FindChapter(trS4Selected);
  if (!ch) return;
  var text = trS4FinalText();
  var name = trS4SafeName(ch.title || ('chapter-' + (ch.index + 1))) + '.txt';
  trS4Download(name, text);
  trToast(trT('trS4ExportDone') + ': ' + name, 'info');
}

/**
 * "导出全部": concatenate every completed chapter's final text (each
 * preceded by a `## 标题` header) into one Blob download `{fileName}-cleaned.txt`.
 */
function trS4ExportAll() {
  if (!trS4Completed.length) return;
  var parts = [];
  for (var i = 0; i < trS4Completed.length; i++) {
    var c = trS4Completed[i];
    var title = c.title || ('#' + (c.index + 1));
    parts.push('\n## ' + title + '\n\n' + trS4ChapterFinalText(c));
  }
  var base = (trS4Snapshot && trS4Snapshot.fileName) ? trS4SafeName(trS4Snapshot.fileName) : 'text-review';
  var name = base + '-cleaned.txt';
  trS4Download(name, parts.join('\n\n').replace(/^\n+/, ''));
  trToast(trT('trS4ExportDone') + ': ' + name, 'info');
}

function trS4SafeName(s) {
  return String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').trim() || 'chapter';
}

function trS4Download(name, text) {
  var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

// ===================== reprocess =====================

/**
 * "重处理本章": re-queue the chapter for cleaning on the backend, then toast.
 * The chapter's cleaned text will update via SSE in Step3; the user is told to
 * go back to Step3 to watch (Step4 is not SSE-subscribed).
 */
function trS4Reprocess(idx) {
  if (!trState.sessionId) return;
  trApiPost('/text-review/sessions/' + encodeURIComponent(trState.sessionId) +
    '/chapters/' + encodeURIComponent(String(idx)) + '/reprocess', {}).then(function (res) {
    if (res && res.error) trToast(trT('trReprocessFailed'), 'error');
    else trToast(trT('trReprocessQueued') + ' ' + trT('trS4ReprocessHint'), 'info');
  }, function () { trToast(trT('trReprocessFailed'), 'error'); });
}