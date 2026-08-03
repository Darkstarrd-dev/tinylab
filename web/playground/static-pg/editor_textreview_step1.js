// editor_textreview_step1.js — Step1 panel: 导入文本 (import text).
// Exposes window.trRenderStep1(panel, state).
// Two import paths: (a) "打开文件" -> POST /api/editor/open (native picker,
// reused); (b) a paste-capable <textarea> with paste interception.
// Mirrors editor.js style: 'use strict' + function + var.
// Large-text strategy: only a small chunk of rawText is ever rendered into the
// DOM preview; the full rawText stays in memory (trState.rawText). A "Load
// more" button appends the next chunk without re-rendering the whole page.

'use strict';

// ---------- preview chunking --------------------------------------
var trS1PreviewLines = 2000;   // max lines per chunk
var trS1PreviewChars = 65536;  // max chars per chunk
var trS1LinesShown = 0;        // how many lines currently in the DOM preview
var trS1RawBytes = null;        // raw ArrayBuffer from file import (null for paste)

// ---------- render ------------------------------------------------
/**
 * Render the Step1 (import) panel.
 * @param {HTMLElement} panel container element
 * @param {object} state trState
 */
window.trRenderStep1 = function (panel, state) {
  var hasText = !!state.rawText;
  if (!hasText) trS1LinesShown = 0; // reset on fresh import

  panel.innerHTML = '';

  // --- .tr-step-panel wrapper ---
  var root = document.createElement('div');
  root.className = 'tr-step-panel tr-s1-root';
  root.style.height = '100%';
  root.style.minHeight = '0';
  panel.appendChild(root);

  // --- title row: left actions | centered title | right actions ---
  var titleRow = document.createElement('div');
  titleRow.className = 'tr-s1-title-row';
  root.appendChild(titleRow);

  var leftActions = document.createElement('div');
  leftActions.className = 'tr-s1-left-actions';
  titleRow.appendChild(leftActions);

  var openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'tr-btn';
  openBtn.id = 'tr-s1-open';
  openBtn.textContent = trT('trOpenFile');
  openBtn.addEventListener('click', trStep1OpenFile);
  leftActions.appendChild(openBtn);

  if (hasText) {
    var totalLines = trCountLines(state.rawText);
    trS1LinesShown = Math.min(trS1PreviewLines, totalLines);
    if (trS1LinesShown < totalLines) {
      var loadMoreBtn = document.createElement('button');
      loadMoreBtn.type = 'button';
      loadMoreBtn.className = 'tr-btn';
      loadMoreBtn.id = 'tr-s1-loadmore';
      loadMoreBtn.textContent = trT('trLoadMore');
      loadMoreBtn.addEventListener('click', trStep1LoadMore);
      leftActions.appendChild(loadMoreBtn);
    }
  }

  var titleEl = document.createElement('span');
  titleEl.className = 'tr-s1-title';
  titleEl.textContent = trT('trStepImport');
  titleRow.appendChild(titleEl);

  var rightActions = document.createElement('div');
  rightActions.className = 'tr-s1-actions';
  titleRow.appendChild(rightActions);

  var nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'tr-btn tr-btn-primary';
  nextBtn.id = 'tr-s1-next';
  nextBtn.textContent = trT('trNext');
  nextBtn.disabled = !hasText;
  nextBtn.addEventListener('click', trStep1Next);
  rightActions.appendChild(nextBtn);

  if (hasText) {
    var abandonBtn = document.createElement('button');
    abandonBtn.type = 'button';
    abandonBtn.className = 'tr-btn tr-btn-danger';
    abandonBtn.id = 'tr-s1-abandon';
    abandonBtn.textContent = trT('trAbandon');
    abandonBtn.addEventListener('click', trStep1Abandon);
    rightActions.appendChild(abandonBtn);
  }

  // --- info row (shown after import) ---
  if (hasText) {
    var fname = state.fileName || trT('trPastedText');
    var sizeInfo = trFormatBytes(trByteLength(state.rawText));

    var infoEl = document.createElement('div');
    infoEl.className = 'tr-s1-info';
    infoEl.id = 'tr-s1-info';

    var nameRow = document.createElement('div');
    nameRow.className = 'tr-fileinfo-row';
    nameRow.innerHTML = '<span class="tr-fileinfo-k">' + trEscapeHtml(trT('trFileName')) + ':</span> <span class="tr-fileinfo-v" id="tr-s1-name">' + trEscapeHtml(fname) + '</span>';
    infoEl.appendChild(nameRow);

    var sizeRow = document.createElement('div');
    sizeRow.className = 'tr-fileinfo-row';
    sizeRow.innerHTML = '<span class="tr-fileinfo-k">' + trEscapeHtml(trT('trFileSize')) + ':</span> <span class="tr-fileinfo-v" id="tr-s1-size">' + trEscapeHtml(sizeInfo) + '</span>';
    infoEl.appendChild(sizeRow);

    var encRow = document.createElement('div');
    encRow.className = 'tr-fileinfo-row';
    var encOptions = ['UTF-8','GBK','GB18030','Big5','Shift_JIS','EUC-KR','ISO-8859-1'];
    var encHtml = '<span class="tr-fileinfo-k">' + trEscapeHtml(trT('trFileEncoding')) + ':</span> <span class="tr-fileinfo-v">';
    if (trS1RawBytes) {
      encHtml += '<select id="tr-s1-encoding" onchange="trStep1OnEncodingChange(this)">';
      for (var ei = 0; ei < encOptions.length; ei++) {
        encHtml += '<option value="' + encOptions[ei] + '"' + ((state.encoding || 'UTF-8') === encOptions[ei] ? ' selected' : '') + '>' + encOptions[ei] + '</option>';
      }
      encHtml += '</select>';
    } else {
      encHtml += trEscapeHtml(state.encoding || 'UTF-8');
    }
    encHtml += '</span>';
    encRow.innerHTML = encHtml;
    infoEl.appendChild(encRow);

    root.appendChild(infoEl);
  }

  // --- body (fills remaining height) ---
  var body = document.createElement('div');
  body.className = 'tr-s1-body';
  body.id = 'tr-s1-body';
  root.appendChild(body);

  if (hasText) {
    // --- after-import view: preview pane ---
    var previewWrap = document.createElement('div');
    previewWrap.className = 'tr-s1-preview-wrap';

    var preview = document.createElement('pre');
    preview.className = 'tr-s1-preview';
    preview.id = 'tr-s1-preview';
    preview.readOnly = true;
    previewWrap.appendChild(preview);

    var totalLines = trCountLines(state.rawText);
    trS1LinesShown = Math.min(trS1PreviewLines, totalLines);
    preview.textContent = trGetChunk(state.rawText, 0, trS1LinesShown);

    body.appendChild(previewWrap);
  } else {
    // --- before-import view: clean textarea with placeholder ---
    var intro = document.createElement('div');
    intro.className = 'tr-s1-intro';
    intro.id = 'tr-s1-intro';

    var pasteTa = document.createElement('textarea');
    pasteTa.className = 'tr-textarea';
    pasteTa.id = 'tr-s1-paste';
    pasteTa.placeholder = trT('trImportDesc');
    pasteTa.addEventListener('paste', trStep1PasteHandler);
    pasteTa.addEventListener('input', trStep1OnInput);
    intro.appendChild(pasteTa);

    body.appendChild(intro);
  }
};

// ---------- preview helpers ---------------------------------------
function trCountLines(text) {
  if (!text) return 0;
  // Count \n occurrences + 1 for the last line (even if empty)
  var n = 1;
  for (var i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

/**
 * Return lines [start, end) from text, joined.
 */
function trGetChunk(text, startLine, endLine) {
  if (!text) return '';
  var lines = 0;
  var begin = 0;
  // Seek to line `startLine`
  while (lines < startLine && begin < text.length) {
    if (text.charCodeAt(begin) === 10) lines++;
    begin++;
  }
  var end = begin;
  // Collect lines startLine..endLine
  while (lines < endLine && end < text.length) {
    if (text.charCodeAt(end) === 10) lines++;
    end++;
  }
  return text.substring(begin, end);
}

// ---------- Step1 actions -----------------------------------------

/**
 * Open a file via the browser FileReader (ArrayBuffer) so re-decoding on
 * encoding change is possible without re-reading the file.
 */
function trStep1OpenFile() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.md,.markdown,.text,text/plain';
  input.style.display = 'none';
  input.onchange = function () {
    if (!input.files || !input.files.length) return;
    var file = input.files[0];
    var reader = new FileReader();
    reader.onload = function () {
      trS1RawBytes = reader.result;
      trStep1DecodeAndImport(file.name, trS1RawBytes, 'UTF-8');
    };
    reader.onerror = function () { trToast(trT('trReadFailed'), 'error'); };
    reader.readAsArrayBuffer(file);
  };
  document.body.appendChild(input);
  input.click();
  document.body.removeChild(input);
}


function trStep1DecodeAndImport(name, bytes, encoding) {
  var dec = new TextDecoder(encoding || 'UTF-8', { fatal: false });
  var text = dec.decode(bytes);
  trState.fileName = name || '';
  trState.rawText = text;
  trState.encoding = encoding || 'UTF-8';
  trS1LinesShown = 0;
  trState.chapters = [];
  trState.lineDecisions = {};
  trState.sessionId = null;
  trSave();
  trRenderStep();
}

function trStep1OnEncodingChange(sel) {
  if (!trS1RawBytes) return;
  trStep1DecodeAndImport(trState.fileName, trS1RawBytes, sel.value);
}

/**
 * Apply an imported (or pasted) text + name into trState and re-render.
 * Stores the FULL text in trState.rawText; only a chunk is rendered in the
 * preview. Resets the preview offset so the next render starts fresh.
 */
function trStep1SetImport(name, content) {
  trS1RawBytes = null;  // paste has no bytes buffer
  trState.fileName = name || '';
  trState.rawText = content || '';
  if (!trState.fileName) {
    trState.fileName = trT('trPastedText');
  }
  trState.encoding = 'UTF-8';
  trS1LinesShown = 0;
  // Reset downstream state — a new import invalidates prior splits/cleanups.
  trState.chapters = [];
  trState.lineDecisions = {};
  trState.sessionId = null;
  trSave();
  trRenderStep();
}

/**
 * Paste handler: intercepts large pastes so the textarea never holds the
 * full 10 MB text. Reads clipboard data → sets trState.rawText → re-renders.
 */
function trStep1PasteHandler(e) {
  var text = (e.clipboardData || window.clipboardData || {}).getData('text');
  if (text) {
    e.preventDefault();
    trStep1SetImport('', text);
  }
  // For small/empty pastes, let the browser handle it (trStep1OnInput will
  // pick up via the textarea value change).
}

/**
 * oninput handler for the paste textarea: sync small text live.
 */
function trStep1OnInput() {
  var el = document.getElementById('tr-s1-paste');
  if (!el) return;
  var v = el.value;
  if (v === trState.rawText) return; // already synced
  trState.fileName = trT('trPastedText');
  trState.rawText = v;
}

/**
 * Abandon the current import: clear rawText/fileName/encoding, reset offset,
 * re-render to the before-import state. No confirm dialog — one-click revert.
 */
function trStep1Abandon() {
  trState.rawText = '';
  trState.fileName = '';
  trState.encoding = 'UTF-8';
  trS1LinesShown = 0;
  trState.chapters = [];
  trState.lineDecisions = {};
  trState.sessionId = null;
  trSave();
  trRenderStep();
}

/**
 * "下一步" handler: advance to Step2.
 */
function trStep1Next() {
  if (!trState.rawText) {
    trToast(trT('trImportFirst'), 'warning');
    return;
  }
  trGotoStep(2);
}

/**
 * Load more: append the next chunk of lines to the preview without
 * re-rendering the whole page.
 */
function trStep1LoadMore() {
  var preview = document.getElementById('tr-s1-preview');
  if (!preview) return;
  var totalLines = trCountLines(trState.rawText);
  var nextEnd = Math.min(trS1LinesShown + trS1PreviewLines, totalLines);
  if (nextEnd <= trS1LinesShown) return; // already at end

  var chunk = trGetChunk(trState.rawText, trS1LinesShown, nextEnd);
  preview.textContent += chunk;
  trS1LinesShown = nextEnd;

  // Hide load-more button when done
  if (trS1LinesShown >= totalLines) {
    var btn = document.getElementById('tr-s1-loadmore');
    if (btn) btn.style.display = 'none';
  }
}

// ===================== size helpers =====================

function trByteLength(s) {
  if (!s) return 0;
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function trFormatBytes(n) {
  if (n == null || n < 0) return '\u2014';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}
