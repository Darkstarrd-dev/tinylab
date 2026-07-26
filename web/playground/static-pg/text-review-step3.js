// text-review-step3.js — Step3 panel: AI 清理 (AI cleanup) — P6.
// Exposes window.trRenderStep3(panel, state) + window.trCleanupStep3().
//
// Wires the processing-node pool selector (config form pre-run, live runtime
// table during a run), the cleanup system prompt, the run controls
// (Start/Pause/Resume/Stop), the chapter tabs + per-card live window, and the
// SSE subscription with 切页重连: on every render with a sessionId, first
// GET /sessions/{id} snapshot → render → open EventSource for live deltas.
// Leaving the page closes the EventSource only — the backend task continues.
// Mirrors editor.js style: 'use strict' + function + var.

'use strict';

// ===================== module state =====================

var trEventSource = null;        // current EventSource (closed on cleanup)
var trS3SessionStatus = 'idle';  // idle|running|paused|completed|cancelled
var trS3Chapters = [];           // live mirror of session chapters (snapshot + events)
var trS3Nodes = [];              // live mirror of session runtime nodes
var trS3ActiveTab = 'pending';   // active chapter tab: pending|processing|completed|failed
var trS3NeedsReconcile = false;  // re-fetch snapshot on ES reopen after an error

// ===================== main render =====================

/**
 * Render the Step3 (cleanup) panel.
 * @param {HTMLElement} panel container element
 * @param {object} state trState
 */
window.trRenderStep3 = function (panel, state) {
  var collapsed = state.promptCollapsed !== false; // default true

  panel.innerHTML =
    '<div class="tr-step-panel">' +

      // node pool (config form when idle, runtime table when session live)
      '<div class="tr-section">' +
        '<div class="tr-s3-node-head">' +
          '<h3 class="tr-section-title" style="margin:0">' + trEscapeHtml(trT('trNodePool')) + '</h3>' +
          '<button type="button" class="tr-btn tr-btn-xs" id="tr-s3-settings" onclick="trStep3OpenSettings()">' +
            trEscapeHtml(trT('trSettings')) + '</button>' +
        '</div>' +
        '<p class="tr-section-desc">' + trEscapeHtml(trT('trNodePoolDesc')) + '</p>' +
        '<div class="tr-nodes-wrap" id="tr-s3-nodes">' +
          '<div class="tr-empty">' + trEscapeHtml(trT('trLoading')) + '</div>' +
        '</div>' +
        '<div class="tr-s3-total" id="tr-s3-total"></div>' +
      '</div>' +

      // system prompt + auto-retry (collapsible)
      '<div class="tr-section">' +
        '<h3 class="tr-section-title tr-s3-prompt-head" id="tr-s3-prompt-head" onclick="trStep3TogglePrompt()"' +
          ' style="cursor:pointer;user-select:none">' +
          '<span class="tr-s3-chev' + (collapsed ? ' tr-s3-chev-collapsed' : '') + '" id="tr-s3-chev">&#9660;</span> ' +
          trEscapeHtml(trT('trSystemPrompt')) +
        '</h3>' +
        '<div class="tr-s3-prompt-body" id="tr-s3-prompt-body"' +
          (collapsed ? ' style="display:none"' : '') + '>' +
          '<textarea class="tr-textarea" id="tr-s3-prompt" placeholder="' +
            trEscapeHtml(trT('trSystemPromptPlaceholder')) + '" oninput="trStep3OnPromptChange()">' +
            trEscapeHtml(state.systemPrompt || '') +
          '</textarea>' +
          '<label class="tr-check"><input type="checkbox" id="tr-s3-autoretry" onchange="trStep3OnAutoRetry()"' +
            (state.autoRetry ? ' checked' : '') + '> ' + trEscapeHtml(trT('trAutoRetry')) + '</label>' +
        '</div>' +
      '</div>' +

      // run controls
      '<div class="tr-section">' +
        '<div class="tr-s3-controls">' +
          '<button type="button" class="tr-btn tr-btn-ghost" onclick="trGotoStep(2)">' +
            trEscapeHtml(trT('trPrev')) + '</button>' +
          '<span class="tr-spacer"></span>' +
          '<button type="button" class="tr-btn tr-btn-primary" id="tr-s3-start" onclick="trStep3Start()">' +
            trEscapeHtml(trT('trStartClean')) + '</button>' +
          '<button type="button" class="tr-btn" id="tr-s3-pause" onclick="trStep3Pause()" style="display:none">' +
            trEscapeHtml(trT('trPause')) + '</button>' +
          '<button type="button" class="tr-btn" id="tr-s3-resume" onclick="trStep3Resume()" style="display:none">' +
            trEscapeHtml(trT('trResume')) + '</button>' +
          '<button type="button" class="tr-btn tr-btn-danger" id="tr-s3-stop" onclick="trStep3Stop()" style="display:none">' +
            trEscapeHtml(trT('trStop')) + '</button>' +
          '<button type="button" class="tr-btn tr-btn-primary" id="tr-s3-toreview" onclick="trGotoStep(4)" style="display:none">' +
            trEscapeHtml(trT('trToReview')) + '</button>' +
        '</div>' +
      '</div>' +

      // chapter tabs + list
      '<div class="tr-section">' +
        '<div class="tr-s3-tabs" id="tr-s3-tabs"></div>' +
        '<div class="tr-s3-chapters" id="tr-s3-chapters"></div>' +
        '<div class="tr-empty tr-s3-empty-hint" id="tr-s3-empty-hint" style="display:none">' +
          trEscapeHtml(trT('trTabEmpty')) + '</div>' +
      '</div>' +
    '</div>';

  // Wire dynamic content. 切页重连: if a session is already known, re-fetch
  // snapshot + re-subscribe (no Start button needed). If already subscribed
  // (re-render within Step3), just repaint from the in-memory mirror.
  if (trState.sessionId) {
    if (trEventSource && trEventSource.readyState !== 2 /* CLOSED */) {
      trS3RenderAll();
    } else {
      trSubscribeSession(trState.sessionId);
    }
  } else {
    trStep3LoadNodes();
    trS3UpdateTabCounts();
    trS3RenderChapterList();
    trS3UpdateControls();
  }
};

// ===================== node pool: config form (pre-run) =====================

/**
 * Fetch /api/text-review/review-nodes and render the editable node table:
 * enable checkbox + concurrency number input. Edits are persisted via
 * POST /api/text-review/review-nodes (upsert). The total concurrency of all
 * enabled nodes is shown read-only beneath the table.
 */
function trStep3LoadNodes() {
  var wrap = document.getElementById('tr-s3-nodes');
  if (!wrap) return;
  trApiGet('/text-review/review-nodes').then(function (res) {
    var nodes = (res && !res.error && Array.isArray(res.nodes)) ? res.nodes : [];
    trState.reviewNodes = nodes;
    trS3RenderConfigNodes(nodes);
  }, function () {
    wrap.innerHTML = '<div class="tr-empty">' + trEscapeHtml(trT('trNodesLoadFailed')) + '</div>';
    trS3RenderTotal(0);
  });
}

function trS3RenderConfigNodes(nodes) {
  var wrap = document.getElementById('tr-s3-nodes');
  if (!wrap) return;
  if (!nodes || nodes.length === 0) {
    wrap.innerHTML = '<div class="tr-empty">' + trEscapeHtml(trT('trNoNodes')) + '</div>';
    trS3RenderTotal(0);
    return;
  }
  var html = '<table class="tr-nodes-table"><thead><tr>' +
    '<th>' + trEscapeHtml(trT('trNodeEnabled')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeProvider')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeModel')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeConcurrency')) + '</th>' +
    '</tr></thead><tbody>';
  var totalConc = 0;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.enabled) totalConc += (n.concurrency || 0);
    var idAttr = trS3JsString(n.id);
    html += '<tr>' +
      '<td><input type="checkbox" class="tr-node-en" data-id="' + trEscapeHtml(n.id || '') + '"' +
        (n.enabled ? ' checked' : '') + ' onchange="trS3OnNodeToggle(' + idAttr + ')"></td>' +
      '<td>' + trEscapeHtml(n.providerId || '') + '</td>' +
      '<td>' + trEscapeHtml(n.modelId || '') + '</td>' +
      '<td><input type="number" class="tr-node-conc" min="0" value="' +
        (n.concurrency != null ? n.concurrency : 1) + '" data-id="' + trEscapeHtml(n.id || '') +
        '" onchange="trS3OnNodeConcurrency(' + idAttr + ')"></td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
  trS3RenderTotal(totalConc);
}

function trS3RenderTotal(total) {
  var el = document.getElementById('tr-s3-total');
  if (el) el.textContent = trT('trNodeTotalConcurrency', [String(total)]);
}

function trS3OnNodeToggle(id) {
  var row = trS3FindNodeRow(id);
  if (!row) return;
  trS3UpsertNode(id, !!row.en.checked, Math.max(0, parseInt(row.conc.value, 10) || 0));
}

function trS3OnNodeConcurrency(id) {
  var row = trS3FindNodeRow(id);
  if (!row) return;
  trS3UpsertNode(id, !!row.en.checked, Math.max(0, parseInt(row.conc.value, 10) || 0));
}

function trS3FindNodeRow(id) {
  var en = document.querySelector('.tr-node-en[data-id="' + trS3CssSelector(nid(id)) + '"]');
  var conc = document.querySelector('.tr-node-conc[data-id="' + trS3CssSelector(nid(id)) + '"]');
  if (!en || !conc) return null;
  return { en: en, conc: conc };
}

function trS3UpsertNode(id, enabled, concurrency) {
  var node = null;
  for (var i = 0; i < trState.reviewNodes.length; i++) {
    if (trState.reviewNodes[i].id === id) { node = trState.reviewNodes[i]; break; }
  }
  if (!node) return;
  var patch = {
    id: node.id,
    providerId: node.providerId,
    modelId: node.modelId,
    concurrency: concurrency,
    enabled: enabled
  };
  trApiPost('/text-review/review-nodes', patch).then(function (res) {
    if (res && res.error) {
      trToast(trT('trNodeSaveFailed'), 'error');
      return;
    }
    node.concurrency = concurrency;
    node.enabled = enabled;
    var total = 0;
    for (var j = 0; j < trState.reviewNodes.length; j++) {
      if (trState.reviewNodes[j].enabled) total += (trState.reviewNodes[j].concurrency || 0);
    }
    trS3RenderTotal(total);
  }, function () { trToast(trT('trNodeSaveFailed'), 'error'); });
}

// ===================== node pool: Settings modal =====================

/**
 * Open the node pool Settings modal (pg-modal). Shows an add-node form
 * (provider select + model select + concurrency + enabled + Add) plus
 * the existing node list with Delete buttons.
 */
function trStep3OpenSettings() {
  if (typeof pgShowModal !== 'function') {
    trToast(trT('trPatternEditorUnavailable'), 'warning');
    return;
  }
  trStep3RenderSettingsModal();
}

function trStep3RenderSettingsModal() {
  // Fetch models for provider/model dropdowns
  trApiGet('/models').then(function (res) {
    var allModels = (res && !res.error && Array.isArray(res.models)) ? res.models : [];

    // Extract unique providers from models
    var providerMap = {};
    for (var i = 0; i < allModels.length; i++) {
      var m = allModels[i];
      if (m.type === 'provider' && m.providerId) {
        if (!providerMap[m.providerId]) {
          providerMap[m.providerId] = { id: m.providerId, name: m.provider || m.providerId };
        }
      }
    }
    var providers = [];
    for (var k in providerMap) {
      if (Object.prototype.hasOwnProperty.call(providerMap, k)) providers.push(providerMap[k]);
    }

    var providerOpts = '';
    for (var pi = 0; pi < providers.length; pi++) {
      providerOpts += '<option value="' + trEscapeHtml(providers[pi].id) + '">' +
        trEscapeHtml(providers[pi].name) + '</option>';
    }

    // Node list rows
    var nodes = trState.reviewNodes || [];
    var nodeRows = '';
    for (var ni = 0; ni < nodes.length; ni++) {
      var n = nodes[ni];
      nodeRows += '<tr>' +
        '<td>' + trEscapeHtml(n.providerId || '') + '</td>' +
        '<td>' + trEscapeHtml(n.modelId || '') + '</td>' +
        '<td>' + (n.concurrency != null ? n.concurrency : 1) + '</td>' +
        '<td>' + (n.enabled ? '&#10003;' : '&#10007;') + '</td>' +
        '<td><button type="button" class="tr-btn tr-btn-xs tr-btn-danger" onclick="trStep3DeleteNode(\'' +
          trEscapeHtml(n.id || '') + '\')">' + trEscapeHtml(trT('trDelete')) + '</button></td>' +
      '</tr>';
    }

    var body =
      '<div class="tr-s3-settings-section">' +
        '<h4>' + trEscapeHtml(trT('trAddNode')) + '</h4>' +
        '<div class="tr-s3-settings-form">' +
          '<label class="tr-label">' + trEscapeHtml(trT('trNodeProvider')) + '</label>' +
          '<select class="tr-select" id="tr-s3-modal-provider" onchange="trStep3OnModalProviderChange()">' +
            '<option value="">--</option>' + providerOpts +
          '</select>' +
          '<label class="tr-label">' + trEscapeHtml(trT('trNodeModel')) + '</label>' +
          '<select class="tr-select" id="tr-s3-modal-model"><option value="">--</option></select>' +
          '<label class="tr-label">' + trEscapeHtml(trT('trNodeConcurrency')) + '</label>' +
          '<input type="number" class="tr-input" id="tr-s3-modal-conc" min="1" value="1" style="width:80px">' +
          '<label class="tr-check">' +
            '<input type="checkbox" id="tr-s3-modal-enabled" checked> ' +
            trEscapeHtml(trT('trNodeEnabled')) +
          '</label>' +
          '<button type="button" class="tr-btn tr-btn-primary" onclick="trStep3AddNode()">' +
            trEscapeHtml(trT('trAdd')) + '</button>' +
        '</div>' +
      '</div>';

    if (nodes.length > 0) {
      body +=
        '<hr class="tr-pe-sep">' +
        '<div class="tr-s3-settings-section">' +
          '<h4>' + trEscapeHtml(trT('trNodePool')) + '</h4>' +
          '<table class="tr-pe-table" style="width:100%"><thead><tr>' +
            '<th>' + trEscapeHtml(trT('trNodeProvider')) + '</th>' +
            '<th>' + trEscapeHtml(trT('trNodeModel')) + '</th>' +
            '<th>' + trEscapeHtml(trT('trNodeConcurrency')) + '</th>' +
            '<th>' + trEscapeHtml(trT('trNodeEnabled')) + '</th>' +
            '<th></th>' +
          '</tr></thead><tbody>' + nodeRows + '</tbody></table>' +
        '</div>';
    }

    var html =
      '<div class="pg-modal-header">' +
        '<span class="pg-modal-title">' + trEscapeHtml(trT('trSettings')) + ' — ' +
          trEscapeHtml(trT('trNodePool')) + '</span>' +
        '<button class="pg-modal-close" onclick="pgCloseModal();trStep3OnSettingsClosed()">&#10005;</button>' +
      '</div>' +
      '<div class="pg-modal-body" style="max-height:70vh;overflow-y:auto">' + body + '</div>';

    pgShowModal(html);

    // Store model data for filtering
    window._trS3ModalModels = allModels;
  }, function () {
    trToast(trT('trNodesLoadFailed'), 'error');
  });
}

/**
 * Provider changed in the settings modal: reload model dropdown.
 */
function trStep3OnModalProviderChange() {
  var sel = document.getElementById('tr-s3-modal-provider');
  var modelSel = document.getElementById('tr-s3-modal-model');
  if (!sel || !modelSel) return;
  var providerId = sel.value;
  modelSel.innerHTML = '<option value="">--</option>';
  if (!providerId) return;
  var all = window._trS3ModalModels || [];
  for (var i = 0; i < all.length; i++) {
    var m = all[i];
    if (m.type === 'provider' && m.providerId === providerId) {
      var opt = document.createElement('option');
      opt.value = m.realModelId || m.id;
      opt.textContent = m.id;
      modelSel.appendChild(opt);
    }
  }
}

/**
 * Add a new node via POST (no id → create).
 */
function trStep3AddNode() {
  var providerSel = document.getElementById('tr-s3-modal-provider');
  var modelSel = document.getElementById('tr-s3-modal-model');
  var concEl = document.getElementById('tr-s3-modal-conc');
  var enEl = document.getElementById('tr-s3-modal-enabled');
  if (!providerSel || !modelSel) return;
  var providerId = providerSel.value;
  var modelId = modelSel.value;
  if (!providerId || !modelId) { trToast(trT('trImportFirst'), 'warning'); return; }
  var body = {
    providerId: providerId,
    modelId: modelId,
    concurrency: concEl ? Math.max(1, parseInt(concEl.value, 10) || 1) : 1,
    enabled: enEl ? enEl.checked : true
  };
  trApiPost('/text-review/review-nodes', body).then(function (res) {
    if (res && res.error) { trToast(res.error, 'error'); return; }
    // Re-fetch nodes and refresh both inline table and modal
    return trApiGet('/text-review/review-nodes');
  }).then(function (res) {
    var nodes = (res && !res.error && Array.isArray(res.nodes)) ? res.nodes : [];
    trState.reviewNodes = nodes;
    trS3RenderConfigNodes(nodes);
    trStep3RenderSettingsModal();
  }).catch(function (err) {
    console.warn('tr add node failed:', err);
    trToast(trT('trNodeAddFailed'), 'error');
  });
}

/**
 * Delete a node via DELETE.
 */
function trStep3DeleteNode(id) {
  if (!id) return;
  trApiDelete('/text-review/review-nodes/' + encodeURIComponent(id)).then(function (res) {
    if (res && res.error) { trToast(res.error, 'error'); return; }
    return trApiGet('/text-review/review-nodes');
  }).then(function (res) {
    var nodes = (res && !res.error && Array.isArray(res.nodes)) ? res.nodes : [];
    trState.reviewNodes = nodes;
    trS3RenderConfigNodes(nodes);
    trStep3RenderSettingsModal();
  }).catch(function (err) {
    console.warn('tr delete node failed:', err);
    trToast(trT('trNodeDeleteFailed'), 'error');
  });
}

/**
 * Called when the settings modal is closed (via X or backdrop).
 */
function trStep3OnSettingsClosed() {
  // Re-fetch to keep inline table in sync
  trApiGet('/text-review/review-nodes').then(function (res) {
    var nodes = (res && !res.error && Array.isArray(res.nodes)) ? res.nodes : [];
    trState.reviewNodes = nodes;
    trS3RenderConfigNodes(nodes);
  }, function () { /* ignore */ });
}

// ===================== node pool: runtime table (live, during a run) =====================

function trS3RenderRuntimeNodes(nodes) {
  var wrap = document.getElementById('tr-s3-nodes');
  if (!wrap) return;
  if (!nodes || nodes.length === 0) {
    wrap.innerHTML = '';
    trS3RenderTotal(0);
    return;
  }
  var html = '<table class="tr-nodes-table tr-s3-runtime"><thead><tr>' +
    '<th>' + trEscapeHtml(trT('trNodeProvider')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeModel')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeTarget')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeActive')) + '</th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var rowClass = n.enabled ? '' : ' tr-s3-node-disabled';
    html += '<tr class="' + rowClass + '">' +
      '<td>' + trEscapeHtml(n.providerId || '') + '</td>' +
      '<td>' + trEscapeHtml(n.modelId || '') + '</td>' +
      '<td>' + (n.target || 0) + '</td>' +
      '<td>' + (n.active || 0) + '</td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
  trS3RenderTotal(0);
}

// ===================== system prompt + auto-retry =====================

function trStep3OnPromptChange() {
  var ta = document.getElementById('tr-s3-prompt');
  if (!ta) return;
  trState.systemPrompt = ta.value;
  trSave();
}

function trStep3OnAutoRetry() {
  var cb = document.getElementById('tr-s3-autoretry');
  if (!cb) return;
  trState.autoRetry = cb.checked;
  trSave();
}

/**
 * Toggle the system prompt section collapsed/expanded.
 */
function trStep3TogglePrompt() {
  trState.promptCollapsed = !trState.promptCollapsed;
  var body = document.getElementById('tr-s3-prompt-body');
  var chev = document.getElementById('tr-s3-chev');
  if (body) body.style.display = trState.promptCollapsed ? 'none' : '';
  if (chev) {
    if (trState.promptCollapsed) chev.classList.add('tr-s3-chev-collapsed');
    else chev.classList.remove('tr-s3-chev-collapsed');
  }
  trSave();
}

// ===================== run controls =====================

/**
 * "开始清理": gather chapters (Step2 output), systemPrompt, and the enabled
 * node IDs from the config pool → POST /sessions → persist sessionId →
 * subscribe to the SSE stream. The button is disabled while a run is active.
 */
function trStep3Start() {
  if (!trState.chapters || trState.chapters.length === 0) {
    trToast(trT('trNoChaptersToClean'), 'warning');
    return;
  }
  var nodeIds = trS3EnabledNodeIds();
  if (nodeIds.length === 0) {
    trToast(trT('trNoNodesEnabled'), 'warning');
    return;
  }
  trS3SessionStatus = 'running';
  trS3UpdateControls();
  trApiPost('/sessions', {
    chapters: trState.chapters.map(function (c) { return { title: c.title, content: c.content }; }),
    systemPrompt: trState.systemPrompt || '',
    autoRetry: !!trState.autoRetry,
    nodeIds: nodeIds
  }).then(function (res) {
    if (res && res.error) { trToast(res.error, 'error'); trS3SessionStatus = 'idle'; trS3UpdateControls(); return; }
    trState.sessionId = res && res.id;
    trSave();
    trSubscribeSession(trState.sessionId);
  }).catch(function (err) {
    console.warn('tr start failed:', err);
    trToast(trT('trStartFailed'), 'error');
    trS3SessionStatus = 'idle';
    trS3UpdateControls();
  });
}

function trStep3Pause() {
  trApiPost('/sessions/' + trState.sessionId + '/pause', {}).then(function () {}, function () {
    trToast(trT('trPauseFailed'), 'error');
  });
}

function trStep3Resume() {
  trApiPost('/sessions/' + trState.sessionId + '/resume', {}).then(function () {}, function () {
    trToast(trT('trResumeFailed'), 'error');
  });
}

function trStep3Stop() {
  trApiPost('/sessions/' + trState.sessionId + '/stop', {}).then(function () {}, function () {
    trToast(trT('trStopFailed'), 'error');
  });
}

function trStep3Reprocess(idx) {
  trApiPost('/sessions/' + trState.sessionId + '/reprocess', { chapterIdx: idx }).then(function () {
    trToast(trT('trReprocessQueued'), 'success');
  }, function () {
    trToast(trT('trReprocessFailed'), 'error');
  });
}

function trS3EnabledNodeIds() {
  var ids = [];
  for (var i = 0; i < trState.reviewNodes.length; i++) {
    if (trState.reviewNodes[i].enabled) ids.push(trState.reviewNodes[i].id);
  }
  return ids;
}

function trS3UpdateControls() {
  var start = document.getElementById('tr-s3-start');
  var pause = document.getElementById('tr-s3-pause');
  var resume = document.getElementById('tr-s3-resume');
  var stop = document.getElementById('tr-s3-stop');
  var toreview = document.getElementById('tr-s3-toreview');
  var s = trS3SessionStatus;
  var idle = (s === 'idle');
  var running = (s === 'running');
  var paused = (s === 'paused');
  var done = (s === 'completed' || s === 'cancelled');
  if (start) start.style.display = idle ? '' : 'none';
  if (pause) pause.style.display = running ? '' : 'none';
  if (resume) resume.style.display = paused ? '' : 'none';
  if (stop) stop.style.display = (running || paused) ? '' : 'none';
  if (toreview) toreview.style.display = done ? '' : 'none';
}

// ===================== chapter tabs + list =====================

function trS3TabCounts() {
  var counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (var i = 0; i < trS3Chapters.length; i++) {
    var s = trS3Chapters[i].status || 'pending';
    if (counts[s] != null) counts[s]++;
  }
  return counts;
}

function trS3UpdateTabCounts() {
  var tabs = document.getElementById('tr-s3-tabs');
  if (!tabs) return;
  var counts = trS3TabCounts();
  var keys = ['pending', 'processing', 'completed', 'failed'];
  var html = '';
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    html += '<button class="tr-s3-tab' + (trS3ActiveTab === k ? ' active' : '') +
      '" onclick="trS3SelectTab(\'' + k + '\')">' +
      trEscapeHtml(trT('trTab' + k.charAt(0).toUpperCase() + k.slice(1))) +
      ' <span class="tr-s3-tab-count">' + (counts[k] || 0) + '</span></button>';
  }
  tabs.innerHTML = html;
}

function trS3SelectTab(key) {
  trS3ActiveTab = key;
  trS3UpdateTabCounts();
  trS3ApplyTabFilter();
}

/**
 * Render every chapter card once (preserving DOM identity so live-pane scroll
 * positions survive tab switches and status transitions). Tab membership is
 * applied via display:none toggles, not innerHTML rebuilds.
 */
function trS3RenderChapterList() {
  var list = document.getElementById('tr-s3-chapters');
  var empty = document.getElementById('tr-s3-empty-hint');
  if (!list) return;
  if (trS3Chapters.length === 0) {
    list.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  var html = '';
  for (var i = 0; i < trS3Chapters.length; i++) {
    html += trS3CardHtml(trS3Chapters[i], i);
  }
  list.innerHTML = html;
  trS3ApplyTabFilter();
}

function trS3CardHtml(c, idx) {
  var status = c.status || 'pending';
  var badge = trT('trStatus_' + status);
  var badgeClass = 'tr-s3-badge tr-s3-badge-' + status;
  var meta = trS3MetaHtml(c);
  return '<div class="tr-s3-card" data-status="' + status + '" data-idx="' + idx + '">' +
    '<div class="tr-s3-card-head">' +
      '<span class="tr-s3-card-title">' + trEscapeHtml(c.title || ('#' + (idx + 1))) + '</span>' +
      '<span class="' + badgeClass + '">' + trEscapeHtml(badge) + '</span>' +
    '</div>' +
    (meta ? '<div class="tr-s3-card-meta">' + meta + '</div>' : '') +
    '<div class="tr-s3-live" id="tr-s3-live-' + idx + '"></div>' +
    '<div class="tr-s3-card-foot">' +
      '<button class="tr-btn tr-btn-xs" onclick="trStep3Reprocess(' + idx + ')">' +
        trEscapeHtml(trT('trReprocess')) + '</button>' +
    '</div>' +
  '</div>';
}

function trS3MetaHtml(c) {
  var parts = [];
  if (c.nodeId) parts.push('<span class="tr-s3-meta-node">' + trEscapeHtml(c.nodeId) + '</span>');
  if (c.retryCount) parts.push('<span class="tr-s3-meta-retry">' + trEscapeHtml(trT('trRetry', [String(c.retryCount)])) + '</span>');
  if (c.error) parts.push('<span class="tr-s3-error">' + trEscapeHtml(c.error) + '</span>');
  return parts.join(' ');
}

function trS3ApplyTabFilter() {
  var cards = document.querySelectorAll('#tr-s3-chapters .tr-s3-card');
  var visible = 0;
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i];
    var status = card.getAttribute('data-status') || 'pending';
    if (status === trS3ActiveTab || (trS3ActiveTab === 'pending' && !status)) {
      card.style.display = '';
      visible++;
    } else {
      card.style.display = 'none';
    }
  }
  var empty = document.getElementById('tr-s3-empty-hint');
  if (empty) empty.style.display = visible === 0 ? '' : 'none';
}

/**
 * Update a single card in place (badge, meta, foot, data-status) and re-apply
 * the tab filter. Does NOT rebuild the list, so other cards' live panes keep
 * their scroll positions.
 */
function trS3UpdateCardStatus(idx) {
  var card = document.querySelector('#tr-s3-chapters .tr-s3-card[data-idx="' + idx + '"]');
  if (!card || idx < 0 || idx >= trS3Chapters.length) return;
  var c = trS3Chapters[idx];
  var status = c.status || 'pending';
  card.setAttribute('data-status', status);
  var badge = card.querySelector('.tr-s3-badge');
  if (badge) {
    badge.textContent = trT('trStatus_' + status);
    badge.className = 'tr-s3-badge tr-s3-badge-' + status;
  }
  var meta = card.querySelector('.tr-s3-card-meta');
  if (meta) meta.innerHTML = trS3MetaHtml(c);
  trS3ApplyTabFilter();
}

// ===================== SSE subscription + 切页重连 =====================

/**
 * Subscribe to a session: FIRST GET /sessions/{id} snapshot → reconcile + render
 * the full state → THEN open EventSource for live deltas. The snapshot is
 * authoritative; events overwrite the in-memory mirror post-snapshot.
 */
function trSubscribeSession(id) {
  trApiGet('/sessions/' + id).then(function (res) {
    if (res && !res.error) {
      trS3ReconcileFromSnapshot(res);
      trS3RenderAll();
    } else {
      trS3OnSessionGone();
    }
  }).catch(function () {
    trS3OnSessionGone();
  });
  trS3OpenEventSource(id);
}

function trS3OpenEventSource(id) {
  trEventSource = new EventSource('/api/text-review/sessions/' + id + '/events');
  trEventSource.addEventListener('chunk', function (e) {
    try { var d = JSON.parse(e.data); trS3OnChunk(d); } catch (_) {}
  });
  trEventSource.addEventListener('status', function (e) {
    try { var d = JSON.parse(e.data); trS3OnStatus(d); } catch (_) {}
  });
  trEventSource.addEventListener('node', function (e) {
    try { var d = JSON.parse(e.data); trS3OnNode(d); } catch (_) {}
  });
  trEventSource.onerror = function () {
    trEventSource.close();
    trS3NeedsReconcile = true;
  };
}

/**
 * chunk: append `delta` to chapter chapterIdx's accumulating cleaned text and
 * auto-scroll the live pane to bottom while the user hasn't scrolled up. The
 * first chunk for a chapter also flips its status to `processing`.
 */
function trS3OnChunk(evt) {
  var idx = evt.chapterIdx;
  if (idx == null || idx < 0 || idx >= trS3Chapters.length) return;
  var c = trS3Chapters[idx];
  if (!c.cleaned) c.cleaned = '';
  c.cleaned += evt.delta || '';
  var old = c.status;
  c.status = 'processing';
  var live = document.getElementById('tr-s3-live-' + idx);
  if (live) {
    live.textContent = c.cleaned;
    if (trS3ScrolledToBottom(live)) live.scrollTop = live.scrollHeight;
  }
  if (old !== 'processing') trS3UpdateCardStatus(idx);
  trS3UpdateTabCounts();
}

/**
 * status: update chapter chapterIdx's status badge (+ error/nodeId if present).
 * Moving a card to its new tab is handled by the in-place card update + filter.
 */
function trS3OnStatus(evt) {
  var idx = evt.chapterIdx;
  if (idx == null || idx < 0 || idx >= trS3Chapters.length) return;
  trS3Chapters[idx].status = evt.status || 'pending';
  if (evt.error) trS3Chapters[idx].error = evt.error;
  if (evt.nodeId) trS3Chapters[idx].nodeId = evt.nodeId;
  trS3UpdateCardStatus(idx);
  trS3UpdateTabCounts();
  trS3MaybeSessionDone();
}

/**
 * node: replace the runtime node pool display from `nodes[]` (live active/target
 * /enabled; a node ramped down to 0 shows enabled:false here).
 */
function trS3OnNode(evt) {
  trS3Nodes = evt.nodes || [];
  trS3RenderRuntimeNodes(trS3Nodes);
}

/**
 * Synthesize the session-completed state when every chapter is resolved
 * (completed or failed), then refresh controls (shows the 进入审校 button).
 */
function trS3MaybeSessionDone() {
  for (var i = 0; i < trS3Chapters.length; i++) {
    var s = trS3Chapters[i].status;
    if (s !== 'completed' && s !== 'failed') return;
  }
  trS3SessionStatus = 'completed';
  trS3UpdateControls();
}

/**
 * Reconcile the in-memory mirror from a GET /sessions/{id} snapshot. The
 * snapshot is authoritative for chapter status/cleaned and node runtime state.
 */
function trS3ReconcileFromSnapshot(snap) {
  if (snap.status) trS3SessionStatus = snap.status;
  if (Array.isArray(snap.chapters)) {
    trS3Chapters = snap.chapters;
  }
  if (Array.isArray(snap.nodes)) {
    trS3Nodes = snap.nodes;
  }
}

function trS3RenderAll() {
  trS3RenderRuntimeNodes(trS3Nodes);
  trS3RenderChapterList();
  trS3UpdateTabCounts();
  trS3UpdateControls();
}

function trS3OnSessionGone() {
  trS3SessionStatus = 'idle';
  trState.sessionId = null;
  trSave();
  if (trEventSource) { trEventSource.close(); trEventSource = null; }
  trS3UpdateControls();
  trS3RenderChapterList();
}

function trS3ScrolledToBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 30;
}

// ===================== cleanup =====================

/**
 * Close the SSE subscription only. Do NOT stop the backend session
 * (切页不丢: the task continues; re-entering Step3 re-subscribes via snapshot).
 * Called by text-review.js::cleanupTextReview on page leave.
 */
window.trCleanupStep3 = function () {
  if (trEventSource) {
    trEventSource.close();
    trEventSource = null;
  }
};

// ===================== small helpers =====================

function nid(s) { return String(s == null ? '' : s); }

// Escape a string for safe embedding inside a single-quoted JS string in an
// inline onclick handler.
function trS3JsString(s) {
  return "'" + nid(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// Escape a string for use inside a CSS attribute selector [data-id="..."].
function trS3CssSelector(s) {
  return nid(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
