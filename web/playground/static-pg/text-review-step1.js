// text-review-step1.js — Step1 panel: 导入文本 (import text).
// Exposes window.trRenderStep1(panel, state).
// Two import paths: (a) "打开文件" -> POST /api/editor/open (native picker,
// reused); (b) a paste textarea. Shows file info + enables "下一步" when
// rawText non-empty. Mirrors editor.js style: 'use strict' + function + var.

'use strict';

/**
 * Render the Step1 (import) panel.
 * @param {HTMLElement} panel container element
 * @param {object} state trState
 */
window.trRenderStep1 = function (panel, state) {
  var hasText = !!state.rawText;
  var sizeInfo = state.rawText ? trFormatBytes(trByteLength(state.rawText)) : '';
  var fname = state.fileName || (state.rawText ? trT('trPastedText') : '');

  panel.innerHTML =
    '<div class="tr-step-panel">' +
      '<div class="tr-section">' +
        '<h3 class="tr-section-title">' + trEscapeHtml(trT('trStepImport')) + '</h3>' +
        '<p class="tr-section-desc">' + trEscapeHtml(trT('trImportDesc')) + '</p>' +

        '<div class="tr-btn-row">' +
          '<button type="button" class="tr-btn" id="tr-s1-open" onclick="trStep1OpenFile()">' +
            trEscapeHtml(trT('trOpenFile')) +
          '</button>' +
        '</div>' +

        '<div class="tr-paste-block">' +
          '<label class="tr-label" for="tr-s1-paste">' + trEscapeHtml(trT('trPasteHere')) + '</label>' +
          '<textarea class="tr-textarea" id="tr-s1-paste" placeholder="' +
            trEscapeHtml(trT('trPastePlaceholder')) + '" oninput="trStep1OnPaste()">' +
            trEscapeHtml(hasText ? state.rawText : '') +
          '</textarea>' +
        '</div>' +

        '<div class="tr-fileinfo" id="tr-s1-info"' + (hasText ? '' : ' style="display:none"') + '>' +
          '<div class="tr-fileinfo-row"><span class="tr-fileinfo-k">' +
            trEscapeHtml(trT('trFileName')) + ':</span> <span class="tr-fileinfo-v" id="tr-s1-name">' +
            trEscapeHtml(fname) + '</span></div>' +
          '<div class="tr-fileinfo-row"><span class="tr-fileinfo-k">' +
            trEscapeHtml(trT('trFileSize')) + ':</span> <span class="tr-fileinfo-v" id="tr-s1-size">' +
            trEscapeHtml(sizeInfo) + '</span></div>' +
          '<div class="tr-fileinfo-row"><span class="tr-fileinfo-k">' +
            trEscapeHtml(trT('trFileEncoding')) + ':</span> <span class="tr-fileinfo-v">' +
            trEscapeHtml(state.encoding || 'UTF-8') + '</span></div>' +
        '</div>' +
      '</div>' +

      '<div class="tr-step-footer">' +
        '<span class="tr-spacer"></span>' +
        '<button type="button" class="tr-btn tr-btn-primary" id="tr-s1-next" ' +
          (hasText ? '' : 'disabled') +
          ' onclick="trStep1Next()">' + trEscapeHtml(trT('trNext')) + '</button>' +
      '</div>' +
    '</div>';
};

// ===================== Step1 actions =====================

/**
 * Open a file via the backend native picker (POST /api/editor/open, reused).
 * On success: fill trState.rawText + fileName, refresh the panel.
 * On {cancelled}: no-op. On {unsupported}: fall back to a hidden <input
 * type=file> browser picker (matches editor.js edOpenFallback approach).
 */
function trStep1OpenFile() {
  var btn = document.getElementById('tr-s1-open');
  if (btn) { btn.disabled = true; }
  fetch('/api/editor/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
    .then(function (resp) { return resp.json(); })
    .then(function (data) {
      if (btn) { btn.disabled = false; }
      if (!data || data.cancelled) return;
      if (data.unsupported) {
        trStep1FallbackPicker();
        return;
      }
      if (data.path !== undefined && data.content !== undefined) {
        trStep1SetImport(data.name || '', data.content);
      } else if (data.error) {
        trToast(data.error, 'error');
      }
    })
    .catch(function (err) {
      if (btn) { btn.disabled = false; }
      console.warn('tr open file failed:', err);
      trStep1FallbackPicker();
    });
}

/**
 * Browser-side fallback file picker (when the native picker is unsupported).
 * Reads the file as UTF-8 text. Mirrors editor.js edOpenFallback.
 */
function trStep1FallbackPicker() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.md,.markdown,.text,text/plain';
  input.style.display = 'none';
  input.onchange = function () {
    if (!input.files || input.files.length === 0) return;
    var file = input.files[0];
    var reader = new FileReader();
    reader.onload = function () {
      trStep1SetImport(file.name, String(reader.result || ''));
    };
    reader.onerror = function () {
      trToast(trT('trReadFailed'), 'error');
    };
    reader.readAsText(file, 'UTF-8');
  };
  document.body.appendChild(input);
  input.click();
  document.body.removeChild(input);
}

/**
 * Apply an imported (or pasted) text + name into trState and re-render.
 */
function trStep1SetImport(name, content) {
  trState.fileName = name || '';
  trState.rawText = content || '';
  if (!trState.fileName) {
    trState.fileName = trT('trPastedText');
  }
  trState.encoding = 'UTF-8';
  // Reset downstream state — a new import invalidates prior splits/cleanups.
  trState.chapters = [];
  trState.lineDecisions = {};
  trState.sessionId = null;
  trSave();
  trRenderStep();
}

/**
 * oninput handler for the paste textarea: sync rawText live, toggle the
 * "下一步" button + file info block.
 */
function trStep1OnPaste() {
  var ta = document.getElementById('tr-s1-paste');
  if (!ta) return;
  var v = ta.value;
  trState.fileName = trT('trPastedText');
  trState.rawText = v;
  var hasText = !!v;
  var next = document.getElementById('tr-s1-next');
  if (next) next.disabled = !hasText;
  var info = document.getElementById('tr-s1-info');
  var nameEl = document.getElementById('tr-s1-name');
  var sizeEl = document.getElementById('tr-s1-size');
  if (info) info.style.display = hasText ? '' : 'none';
  if (nameEl) nameEl.textContent = trState.fileName;
  if (sizeEl) sizeEl.textContent = hasText ? trFormatBytes(trByteLength(v)) : '';
}

/**
 * "下一步" handler: advance to Step2. Guarded by the button being enabled
 * (rawText non-empty), but double-check defensively.
 */
function trStep1Next() {
  if (!trState.rawText) {
    trToast(trT('trImportFirst'), 'warning');
    return;
  }
  trGotoStep(2);
}

// ===================== size helpers =====================

function trByteLength(s) {
  if (!s) return 0;
  // UTF-8 byte length without allocating a Blob.
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; } // surrogate pair
    else n += 3;
  }
  return n;
}

function trFormatBytes(n) {
  if (n == null || n < 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}
