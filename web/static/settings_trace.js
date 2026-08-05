// ===================== Request Tracing config =====================
// Trace enable/disable toggle + trace settings modal + clear-traces flow.
// Split from endpoint.js (2026-07-31).

async function toggleTrace(enabled) {
  if (enabled) {
    confirmTraceEnable();
    return;
  }
  await doToggleTrace(false);
}

function confirmTraceEnable() {
  var overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = '\
    <div class="modal" style="min-width:420px;max-width:540px">\
      <div class="modal-title">' + escapeHtml(t('requestTracing')) + '</div>\
      <div class="modal-body"><p class="muted">' + escapeHtml(t('traceEnableConfirm')) + '</p></div>\
      <div class="modal-footer">\
        <button type="button" class="btn btn-ghost" onclick="cancelTraceEnable()">' + t('cancel') + '</button>\
        <button type="button" class="btn btn-primary" id="trace-enable-confirm">' + escapeHtml(t('enable')) + '</button>\
      </div>\
    </div>';
  requestAnimationFrame(function() { overlay.classList.add('show'); });
  var btn = document.getElementById('trace-enable-confirm');
  if (btn) btn.onclick = function() { withLoading(this, function() { return doToggleTrace(true); }); };
}

function cancelTraceEnable() {
  closeModalOverlay();
  var toggle = document.getElementById('trace-toggle');
  if (toggle) toggle.checked = false;
}

async function doToggleTrace(enabled) {
  try {
    await apiPatch('/settings', { trace: { enabled: enabled } });
    closeModalOverlay();
    toast(enabled ? t('requestTracingOn') : t('requestTracingOff'), 'success');
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
    var toggle = document.getElementById('trace-toggle');
    if (toggle) toggle.checked = !enabled;
  }
}

function openTraceModal() {
  var s = window.__settings;
  var trace = (s && s.trace) || {};
  var rd = trace.retainDays || 2;
  var md = trace.maxDiskMB || 500;
  openSettingsModal(t('requestTracing'),
    '<p class="muted">' + escapeHtml(t('traceModalDesc')) + '</p>\
    <div class="settings-form-grid" style="margin-top:16px">\
      <div class="form-group">\
        <label>' + escapeHtml(t('traceRetainDays')) + ' (' + escapeHtml(t('traceRetainDaysUnit')) + ')</label>\
        ' + renderStepperHtml('trace-modal-retain', rd, { min: 1, max: 365 }) + '\
      </div>\
      <div class="form-group">\
        <label>' + escapeHtml(t('traceMaxDiskMB')) + ' (' + escapeHtml(t('traceMaxDiskMBUnit')) + ')</label>\
        ' + renderStepperHtml('trace-modal-maxdisk', md, { min: 50, step: 50 }) + '\
      </div>\
    </div>\
    <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">\
      <button type="button" class="btn btn-ghost btn-sm" onclick="traceResetDefaults()">' + escapeHtml(t('resetDefaults')) + '</button>\
      <button type="button" class="btn btn-danger btn-sm" onclick="confirmClearTraces()">' + escapeHtml(t('clearTraceData')) + '</button>\
    </div>'
  );
  var saveBtn = document.getElementById('settings-modal-save');
  if (saveBtn) saveBtn.onclick = function() { withLoading(this, function() { return saveTraceModal(); }); };
}

function traceResetDefaults() {
  var r = document.getElementById('trace-modal-retain'); if (r) r.value = 2;
  var m = document.getElementById('trace-modal-maxdisk'); if (m) m.value = 500;
}

async function saveTraceModal() {
  var r = parseInt(document.getElementById('trace-modal-retain').value, 10);
  var m = parseInt(document.getElementById('trace-modal-maxdisk').value, 10);
  if (!r || r < 1) r = 2;
  if (!m || m < 50) m = 500;
  await apiPatch('/settings', { trace: { retainDays: r, maxDiskMB: m } });
  if (window.__settings && window.__settings.trace) {
    window.__settings.trace.retainDays = r;
    window.__settings.trace.maxDiskMB = m;
  }
  closeModalOverlay();
  toast(t('saved'), 'success');
}

function confirmClearTraces() {
  var overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = '\
    <div class="modal" style="min-width:420px;max-width:500px">\
      <div class="modal-title">' + escapeHtml(t('clearTraceData')) + '</div>\
      <div class="modal-body"><p>' + escapeHtml(t('clearTraceConfirm')) + '</p></div>\
      <div class="modal-footer">\
        <button type="button" class="btn btn-ghost" onclick="closeModalOverlay()">' + t('cancel') + '</button>\
        <button type="button" class="btn btn-danger" id="trace-clear-confirm">' + escapeHtml(t('clearTraceData')) + '</button>\
      </div>\
    </div>';
  requestAnimationFrame(function() { overlay.classList.add('show'); });
  var btn = document.getElementById('trace-clear-confirm');
  if (btn) btn.onclick = function() { withLoading(this, function() { return doClearTraces(); }); };
}

async function doClearTraces() {
  var res = await apiPost('/traces/clear', {});
  closeModalOverlay();
  if (res && res.error) { toast(res.error, 'error'); return; }
  toast(t('clearTraceDone', [(res && res.clearedFiles) || 0]), 'success');
}
