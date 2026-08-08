// editor_textreview_step3.js — Step3 panel: AI 清理 (AI cleanup) — P6.
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
var trS3ReconnectTimer = null;    // reconnect timer for SSE recovery (Bug #2)
var trS3ProviderNames = {};     // providerId -> human name (from /api/models)
var trS3ProviderPrefixes = {};  // providerId -> prefix (from /api/models id field)
var trS3ModelNames = {};        // "providerId/modelId" -> alias (from /api/models); keyed by providerId to avoid collision when multiple providers carry the same realModelId
var trS3NodeNumbers = {};       // nodeId -> 1-based display number
var trS3SelectedIdx = 0;       // currently selected chapter card (shown in the right content pane)
var trS3ModalModel = null;      // {providerId, modelId, label} selected in the local model prompt
window.trS3NodeNumbers = trS3NodeNumbers;

function trS3NodeBadge(nodeId) {
  var n = trS3NodeNumbers[nodeId];
  return n ? '<span class="tr-node-badge">' + n + '</span>' : '';
}

function trS3ProviderName(id) { return trS3ProviderNames[id] || id || ''; }
function trS3ProviderPrefix(id) { return trS3ProviderPrefixes[id] || ''; }
function trS3ModelName(providerId, modelId) { return trS3ModelNames[providerId + '/' + modelId] || trS3ModelNames[modelId] || modelId || ''; }
window._trS3ProviderPrefix = trS3ProviderPrefix;

function trS3PopulateProviders(models) {
  if (!models || !models.length) return;
  for (var i = 0; i < models.length; i++) {
    var m = models[i];
    if (m.type === 'provider' && m.providerId) {
      trS3ProviderNames[m.providerId] = m.provider || m.providerId;
      var slash = m.id.indexOf('/');
      if (slash > 0) {
        trS3ProviderPrefixes[m.providerId] = m.id.slice(0, slash);
      }
      // Build modelId -> alias map (modelId = realModelId||id, the form stored on review nodes)
      var mid = m.realModelId || m.id;
      if (mid) {
        trS3ModelNames[m.providerId + '/' + mid] = m.alias || m.name || m.id || mid;
      }
    }
  }
}



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
      '<div class="tr-section" id="tr-s3-pool-section">' +
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
      '<div class="tr-section" id="tr-s3-prompt-section">' +
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
          '<span class="tr-s3-range">' +
            '<label class="tr-s3-range-lbl">' + trEscapeHtml(trT('trRangeStart')) + '</label>' +
            '<input type="number" class="tr-input tr-s3-range-in" id="tr-s3-range-start" min="1" placeholder="' +
              trEscapeHtml(trT('trRangeAll')) + '" value="' + (state.rangeStart ? state.rangeStart : '') +
              '" onchange="trS3OnRangeChange()">' +
            '<label class="tr-s3-range-lbl">' + trEscapeHtml(trT('trRangeEnd')) + '</label>' +
            '<input type="number" class="tr-input tr-s3-range-in" id="tr-s3-range-end" min="1" placeholder="' +
              trEscapeHtml(trT('trRangeAll')) + '" value="' + (state.rangeEnd ? state.rangeEnd : '') +
              '" onchange="trS3OnRangeChange()">' +
          '</span>' +
          '<span class="tr-spacer"></span>' +
          '<button type="button" class="tr-btn tr-btn-primary" id="tr-s3-startpause" onclick="trStep3StartPause()">' +
            trEscapeHtml(trT('trStartClean')) + '</button>' +
          '<button type="button" class="tr-btn tr-btn-danger" id="tr-s3-stop" onclick="trStep3Stop()" disabled>' +
            trEscapeHtml(trT('trStop')) + '</button>' +
          '<button type="button" class="tr-btn tr-btn-primary" id="tr-s3-toreview" onclick="trGotoStep(4)">' +
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
    // Optimistic sync: immediately show controls + in-memory chapter mirror so
    // the UI is correct on re-entry (e.g. returning from Step4) before the async
    // snapshot reconciles. trS3SessionStatus persists across page switches.
    trS3UpdateControls();
    trS3RenderChapterList();
    trS3UpdateTabCounts();
    if (trEventSource && trEventSource.readyState !== 2 /* CLOSED */) {
      trS3RenderRuntimeNodes(trS3Nodes);
    } else {
      trSubscribeSession(trState.sessionId);
    }
  } else {
    trS3Chapters = (trState.chapters || []).map(function (c) { return { title: c.title, content: c.content, status: 'pending' }; });
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
  trApiGet('/models').then(function (res) {
    var models = (res && !res.error && Array.isArray(res.models)) ? res.models : [];
    trS3PopulateProviders(models);
    return trApiGet('/text-review/review-nodes');
  }).then(function (res) {
    var nodes = (res && !res.error && Array.isArray(res.nodes)) ? res.nodes : [];
    trState.reviewNodes = nodes;
    trS3RenderConfigNodes(nodes);
  }, function () {
    if (wrap) wrap.innerHTML = '<div class="tr-empty">' + trEscapeHtml(trT('trNodesLoadFailed')) + '</div>';
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
    '<th>#</th>' +
    '<th>' + trEscapeHtml(trT('trNodeEnabled')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeProvider')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeModel')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeConcurrency')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trIntervalSec')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trBatchChars')) + '</th>' +
    '</tr></thead><tbody>';
  trS3NodeNumbers = {};
  for (var k = 0; k < nodes.length; k++) { trS3NodeNumbers[nodes[k].id] = k + 1; }
  window.trS3NodeNumbers = trS3NodeNumbers;
  var totalConc = 0;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.enabled) totalConc += (n.concurrency || 0);
    var idAttr = trS3JsString(n.id);
    html += '<tr>' +
      '<td class="tr-node-num">' + (i + 1) + '</td>' +
      '<td><input type="checkbox" class="tr-node-en" data-id="' + trEscapeHtml(n.id || '') + '"' +
        (n.enabled ? ' checked' : '') + ' onchange="trS3OnNodeToggle(' + idAttr + ')"></td>' +
      '<td>' + trEscapeHtml(trS3ProviderName(n.providerId)) + '</td>' +
      '<td>' + trEscapeHtml(trS3ModelName(n.providerId, n.modelId)) + '</td>' +
      '<td><input type="number" class="tr-node-conc" min="0" value="' +
        (n.concurrency != null ? n.concurrency : 1) + '" data-id="' + trEscapeHtml(n.id || '') +
        '" onchange="trS3OnNodeConcurrency(' + idAttr + ')"></td>' +
      '<td><input type="number" class="tr-node-interval" min="0" value="' + (n.intervalSec != null ? n.intervalSec : 0) + '" data-id="' + trEscapeHtml(n.id || '') + '" onchange="trS3OnNodeInterval(' + idAttr + ')"></td>' +
      '<td><input type="number" class="tr-node-batch" min="0" value="' + (n.batchChars != null ? n.batchChars : 0) + '" data-id="' + trEscapeHtml(n.id || '') + '" onchange="trS3OnNodeBatch(' + idAttr + ')"></td>' +
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

function trS3OnNodeInterval(id) {
  var row = trS3FindNodeRow(id);
  if (!row) return;
  var node = null;
  for (var i = 0; i < trState.reviewNodes.length; i++) { if (trState.reviewNodes[i].id === id) { node = trState.reviewNodes[i]; break; } }
  if (!node) return;
  node.intervalSec = Math.max(0, parseInt(row.interval.value, 10) || 0);
  trS3UpsertNode(id, !!row.en.checked, Math.max(0, parseInt(row.conc.value, 10) || 0));
}

function trS3OnNodeBatch(id) {
  var row = trS3FindNodeRow(id);
  if (!row) return;
  var node = null;
  for (var i = 0; i < trState.reviewNodes.length; i++) { if (trState.reviewNodes[i].id === id) { node = trState.reviewNodes[i]; break; } }
  if (!node) return;
  node.batchChars = Math.max(0, parseInt(row.batch.value, 10) || 0);
  trS3UpsertNode(id, !!row.en.checked, Math.max(0, parseInt(row.conc.value, 10) || 0));
}

function trS3FindNodeRow(id) {
  var sel = trS3CssSelector(nid(id));
  var en = document.querySelector('.tr-node-en[data-id="' + sel + '"]');
  var conc = document.querySelector('.tr-node-conc[data-id="' + sel + '"]');
  if (!en || !conc) return null;
  var interval = document.querySelector('.tr-node-interval[data-id="' + sel + '"]');
  var batch = document.querySelector('.tr-node-batch[data-id="' + sel + '"]');
  return { en: en, conc: conc, interval: interval, batch: batch };
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
    enabled: enabled,
    intervalSec: node.intervalSec || 0,
    batchChars: node.batchChars || 0
  };
  trApiPost('/text-review/review-nodes', patch).then(function (res) {
    if (res && res.error) {
      trToast(trT('trNodeSaveFailed'), 'error');
      return;
    }
    node.concurrency = concurrency;
    node.enabled = enabled;
    node.intervalSec = patch.intervalSec;
    node.batchChars = patch.batchChars;
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
  trS3ModalModel = null; // reset previous selection
  // Fetch models for provider/model dropdowns
  trApiGet('/models').then(function (res) {
    var allModels = (res && !res.error && Array.isArray(res.models)) ? res.models : [];
    trS3PopulateProviders(allModels);

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
        '<td>' + trEscapeHtml(trS3ProviderName(n.providerId)) + '</td>' +
        '<td>' + trEscapeHtml(trS3ModelName(n.providerId, n.modelId)) + '</td>' +
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
          '<label class="tr-label">' + trEscapeHtml(trT('trNodeModel')) + '</label>' +
          '<button type="button" class="pg-btn pg-model-btn" id="tr-s3-modal-model-btn" onclick="trStep3PickModel()" style="width:100%;text-align:left;justify-content:flex-start">' +
            trEscapeHtml(trT('trSelectModel')) + ' <span style="float:right;opacity:0.5">▼</span></button>' +
          '<label class="tr-label">' + trEscapeHtml(trT('trNodeConcurrency')) + '</label>' +
          '<input type="number" class="tr-input" id="tr-s3-modal-conc" min="1" value="1" style="width:80px">' +
          '<label class="tr-label">' + trEscapeHtml(trT('trIntervalSec')) + '</label>' +
          '<input type="number" class="tr-input" id="tr-s3-modal-interval" min="0" value="0" style="width:80px">' +
          '<label class="tr-label">' + trEscapeHtml(trT('trBatchChars')) + '</label>' +
          '<input type="number" class="tr-input" id="tr-s3-modal-batch" min="0" value="0" style="width:80px">' +
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

/** Select a text model without requiring Playground globals. */
function trStep3PickModel() {
  var current = trS3ModalModel ? trS3ModalModel.modelId : '';
  trApiGet('/models').then(function (res) {
    var all = res && Array.isArray(res.models) ? res.models : (Array.isArray(res) ? res : []);
    var choices = [];
    for (var i = 0; i < all.length; i++) {
      var m = all[i];
      if (m && (m.type === 'provider' || m.providerId || m.realModelId || m.id)) choices.push(m);
    }
    var labels = choices.map(function (m, n) { return (n + 1) + ': ' + (m.alias || m.name || m.realModelId || m.id); });
    var answer = window.prompt(labels.length ? labels.join('\n') + '\n\n' + trT('trSelectModel') : trT('trSelectModel'), current || '');
    if (answer === null) return;
    var selected = choices[parseInt(answer, 10) - 1] || null;
    var id = selected ? (selected.realModelId || selected.id) : answer.trim();
    if (!id) return;
    trS3ModalModel = {
      providerId: selected ? (selected.providerId || '') : '',
      modelId: id,
      label: selected ? (selected.alias || selected.name || id) : id
    };
    var btn = document.getElementById('tr-s3-modal-model-btn');
    if (btn) btn.textContent = trS3ModalModel.label;
  }, function () { trToast(trT('trNodesLoadFailed'), 'warning'); });
}
function trStep3AddNode() {
  if (!trS3ModalModel || !trS3ModalModel.providerId) {
    trToast(trT('trSelectModel'), 'warning');
    return;
  }
  var concEl = document.getElementById('tr-s3-modal-conc');
  var enEl = document.getElementById('tr-s3-modal-enabled');
  var intervalEl = document.getElementById('tr-s3-modal-interval');
  var batchEl = document.getElementById('tr-s3-modal-batch');
  var body = {
    providerId: trS3ModalModel.providerId,
    modelId: trS3ModalModel.modelId,
    concurrency: concEl ? Math.max(1, parseInt(concEl.value, 10) || 1) : 1,
    enabled: enEl ? enEl.checked : true,
    intervalSec: intervalEl ? Math.max(0, parseInt(intervalEl.value, 10) || 0) : 0,
    batchChars: batchEl ? Math.max(0, parseInt(batchEl.value, 10) || 0) : 0
  };
  trApiPost('/text-review/review-nodes', body).then(function (res) {
    if (res && res.error) { trToast(res.error, 'error'); return; }
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
      '<td>' + trEscapeHtml(trS3ProviderName(n.providerId)) + '</td>' +
      '<td>' + trEscapeHtml(trS3ModelName(n.providerId, n.modelId)) + '</td>' +
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

// trS3OnRangeChange persists the (1-based) chapter range inputs to trState.
function trS3OnRangeChange() {
  var rs = document.getElementById('tr-s3-range-start');
  var re = document.getElementById('tr-s3-range-end');
  if (rs) trState.rangeStart = parseInt(rs.value, 10) || 0;
  if (re) trState.rangeEnd = parseInt(re.value, 10) || 0;
  trSave();
}

// trS3RangeBounds converts the 1-based chapter range inputs into the backend's
// 0-based half-open [rangeStart, rangeEnd) bounds. Empty/0 means "no bound".
function trS3RangeBounds() {
  var rs = trState.rangeStart || 0;
  var re = trState.rangeEnd || 0;
  var rangeStart = rs > 0 ? rs - 1 : 0;
  var rangeEnd = 0;
  if (rs > 0 || re > 0) {
    var total = trState.chapters ? trState.chapters.length : 0;
    rangeEnd = re > 0 ? re : total;
  }
  return { rangeStart: rangeStart, rangeEnd: rangeEnd };
}

// ===================== run controls =====================

/**
 * Single-button toggle for Start / Pause / Resume.
 * Dispatches to the appropriate action based on trS3SessionStatus.
 */
function trStep3StartPause() {
  if (trS3SessionStatus === 'running') trStep3Pause();
  else if (trS3SessionStatus === 'paused') trStep3Resume();
  else trStep3Start();
}

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
  var range = trS3RangeBounds();
  trApiPost('/text-review/sessions', {
    chapters: trState.chapters.map(function (c) { return { title: c.title, content: c.content }; }),
    systemPrompt: trState.systemPrompt || '',
    autoRetry: !!trState.autoRetry,
    nodeIds: nodeIds,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd
  }).then(function (res) {
    if (res && res.error) { trToast(res.error, 'error'); trS3SessionStatus = 'idle'; trS3UpdateControls(); return; }
    trState.sessionId = res && res.sessionId;
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
  trApiPost('/text-review/sessions/' + trState.sessionId + '/pause', {}).then(function () {}, function () {
    trToast(trT('trPauseFailed'), 'error');
  });
}

function trStep3Resume() {
  trApiPost('/text-review/sessions/' + trState.sessionId + '/resume', {}).then(function () {}, function () {
    trToast(trT('trResumeFailed'), 'error');
  });
}

function trStep3Stop() {
  trApiPost('/text-review/sessions/' + trState.sessionId + '/stop', {}).then(function () {}, function () {
    trToast(trT('trStopFailed'), 'error');
  });
}

function trStep3Reprocess(idx) {
  trApiPost('/text-review/sessions/' + trState.sessionId + '/chapters/' + idx + '/reprocess', {}).then(function () {
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
  var sp = document.getElementById('tr-s3-startpause');
  var stop = document.getElementById('tr-s3-stop');
  var s = trS3SessionStatus;
  var running = (s === 'running');
  var paused = (s === 'paused');
  var active = running || paused;
  if (sp) {
    sp.disabled = false;
    if (running) { sp.textContent = trT('trPause'); sp.className = 'tr-btn'; }
    else if (paused) { sp.textContent = trT('trResume'); sp.className = 'tr-btn tr-btn-primary'; }
    else { sp.textContent = trT('trStartClean'); sp.className = 'tr-btn tr-btn-primary'; }
  }
  if (stop) stop.disabled = !active;
  // Hide node-pool and system-prompt config sections while a run is active.
  var pool = document.getElementById('tr-s3-pool-section');
  var promptSec = document.getElementById('tr-s3-prompt-section');
  if (pool) pool.style.display = running ? 'none' : '';
  if (promptSec) promptSec.style.display = running ? 'none' : '';
  // Range inputs are fixed at session creation; lock them while a session is live.
  var rs = document.getElementById('tr-s3-range-start');
  var re = document.getElementById('tr-s3-range-end');
  if (rs) rs.disabled = active;
  if (re) re.disabled = active;
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
 * Render every chapter card once. Tab membership is applied via display:none
 * toggles, not innerHTML rebuilds, so in-place status updates keep working.
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
  // Highlight the selected card and render its content in the right pane.
  if (trS3SelectedIdx >= trS3Chapters.length) trS3SelectedIdx = 0;
  trS3SelectChapter(trS3SelectedIdx);
}

function trS3CardHtml(c, idx) {
  var status = c.status || 'pending';
  var badge = trT('trStatus_' + status);
  var badgeClass = 'tr-s3-badge tr-s3-badge-' + status;
  var sel = (idx === trS3SelectedIdx) ? ' selected' : '';
  var title = c.title || ('#' + (idx + 1));
  var tip = c.error ? ('[' + c.error + ']') : (c.nodeId ? c.nodeId : '');
  var passBtn = (status === 'processing' || status === 'failed')
    ? '<button class="tr-btn tr-btn-xs tr-s3-pass" onclick="event.stopPropagation();trS3PassChapter(' + idx + ')">' + trEscapeHtml(trT('trPass')) + '</button>'
    : '';
  return '<div class="tr-s3-card' + sel + '" data-status="' + status + '" data-idx="' + idx +
    '" title="' + trEscapeHtml(tip) + '" onclick="trS3SelectChapter(' + idx + ')">' +
    '<span class="tr-s3-card-title">' + trEscapeHtml(title) + '</span>' +
    '<span class="tr-s3-card-progress">' + trEscapeHtml(trS3CardProgress(c)) + '</span>' +
    (c.error ? '<span class="tr-s3-card-error">' + trEscapeHtml(c.error) + '</span>' : '') +
    '<span class="' + badgeClass + '">' + trEscapeHtml(badge) + '</span>' +
    (c.nodeId ? trS3NodeBadge(c.nodeId) : '') +
    '<button class="tr-btn tr-btn-xs tr-s3-reproc" onclick="event.stopPropagation();trStep3Reprocess(' + idx + ')">' +
      trEscapeHtml(trT('trReprocess')) + '</button>' +
    passBtn +
  '</div>';
}

// trS3CardProgress renders the compact card's progress cell: the cleaned-char
// count when there is cleaned text, "streaming" while processing with no text
// yet, otherwise empty.
function trS3CardProgress(c) {
  var total = (c.content || '').length;
  var done = (c.cleaned || '').length;
  if (c.status === 'processing' || c.cleaned) return done + '/' + total;
  return String(total);
}

// trS3SelectChapter selects a chapter card: highlights it and renders its
// content (or cleaned stream) in the right content pane (#ed-review-content).
function trS3SelectChapter(idx) {
  if (idx < 0 || idx >= trS3Chapters.length) return;
  trS3SelectedIdx = idx;
  var cards = document.querySelectorAll('#tr-s3-chapters .tr-s3-card');
  for (var i = 0; i < cards.length; i++) cards[i].classList.remove('selected');
  var card = document.querySelector('#tr-s3-chapters .tr-s3-card[data-idx="' + idx + '"]');
  if (card) card.classList.add('selected');
  var pane = document.getElementById('ed-review-content');
  if (!pane) return;
  var c = trS3Chapters[idx];
  var text;
  if (c.status === 'processing') {
    text = c.cleaned || '';
  } else if (c.status === 'completed' || c.status === 'failed') {
    text = c.cleaned || c.content || '';
  } else {
    text = c.content || '';
  }
  if (c.status === 'failed' && c.error) text += (text ? '\n\n' : '') + '[' + c.error + ']';
  pane.textContent = text;
  if (trS3ScrolledToBottom(pane)) pane.scrollTop = pane.scrollHeight;
}
// trS3PassChapter manually passes a processing/failed chapter: moves it to
// completed (preserving any cleaned text, falling back to content) and syncs
// to persisted state so Step4's review list includes it.
function trS3PassChapter(idx) {
  if (idx < 0 || idx >= trS3Chapters.length) return;
  var c = trS3Chapters[idx];
  if (c.status !== 'processing' && c.status !== 'failed') return;
  c.status = 'completed';
  c.error = '';
  if (!c.cleaned) c.cleaned = c.content || '';
  if (trState.chapters && trState.chapters[idx]) {
    trState.chapters[idx].status = 'completed';
    trState.chapters[idx].cleaned = c.cleaned;
    trState.chapters[idx].error = '';
  }
  trSave();
  trS3RenderChapterList();
  trS3UpdateTabCounts();
  trS3UpdateControls();
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
 * Update a single card in place (badge, progress, data-status) and re-apply
 * the tab filter. Does NOT rebuild the list, so other cards keep their state.
 */
function trS3UpdateCardStatus(idx) {
  var card = document.querySelector('#tr-s3-chapters .tr-s3-card[data-idx="' + idx + '"]');
  if (!card || idx < 0 || idx >= trS3Chapters.length) return;
  var c = trS3Chapters[idx];
  var status = c.status || 'pending';
  card.setAttribute('data-status', status);
  var tip = c.error ? ('[' + c.error + ']') : (c.nodeId ? c.nodeId : '');
  card.setAttribute('title', tip);
  var badge = card.querySelector('.tr-s3-badge');
  if (badge) {
    badge.textContent = trT('trStatus_' + status);
    badge.className = 'tr-s3-badge tr-s3-badge-' + status;
  }
  var prog = card.querySelector('.tr-s3-card-progress');
  if (prog) prog.textContent = trS3CardProgress(c);
  trS3ApplyTabFilter();
}

// ===================== SSE subscription + 切页重连 =====================

/**
 * Subscribe to a session: FIRST GET /sessions/{id} snapshot → reconcile + render
 * the full state → THEN open EventSource for live deltas. The snapshot is
 * authoritative; events overwrite the in-memory mirror post-snapshot.
 */
function trSubscribeSession(id) {
  trApiGet('/text-review/sessions/' + id).then(function (res) {
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
  if (trEventSource) { trEventSource.close(); trEventSource = null; }
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
    trEventSource = null;
    trS3NeedsReconcile = true;
    // Delayed reconnect: re-fetch the snapshot (recovers events lost while the
    // forward-only SSE was down) then reopen ES. Skip if the session is gone or terminal.
    if (trS3ReconnectTimer) clearTimeout(trS3ReconnectTimer);
    trS3ReconnectTimer = setTimeout(function () {
      trS3ReconnectTimer = null;
      if (!trState.sessionId) return;
      if (trS3SessionStatus === 'completed' || trS3SessionStatus === 'cancelled' || trS3SessionStatus === 'idle') return;
      trSubscribeSession(trState.sessionId);
    }, 3000);
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
  // Only accept chunks while the chapter is pending/processing; a residual or
  // out-of-order chunk must not resurrect a completed/failed chapter.
  if (c.status !== 'pending' && c.status !== 'processing') return;
  if (!c.cleaned) c.cleaned = '';
  c.cleaned += evt.delta || '';
  var old = c.status;
  c.status = 'processing';
  trS3UpdateCardStatus(idx);
  // Mirror the stream into the right content pane when this chapter is selected.
  if (idx === trS3SelectedIdx) {
    var pane = document.getElementById('ed-review-content');
    if (pane) {
      pane.textContent = c.cleaned;
      if (trS3ScrolledToBottom(pane)) pane.scrollTop = pane.scrollHeight;
    }
  }
  if (old !== 'processing') trS3UpdateTabCounts();
}

/**
 * status: update chapter chapterIdx's status badge (+ error/nodeId if present).
 * Moving a card to its new tab is handled by the in-place card update + filter.
 */
function trS3OnStatus(evt) {
  var idx = evt.chapterIdx;
  if (idx == null) {
    // Session-level status (running/paused/resumed/cancelled/completed).
    if (evt.status) { trS3SessionStatus = evt.status; trS3UpdateControls(); }
    trS3MaybeSessionDone();
    return;
  }
  if (idx < 0 || idx >= trS3Chapters.length) return;
  var prevStatus = trS3Chapters[idx].status;
  trS3Chapters[idx].status = evt.status || 'pending';
  if (evt.error) trS3Chapters[idx].error = evt.error;
  if (evt.nodeId) trS3Chapters[idx].nodeId = evt.nodeId;
  // Mirror backend ReprocessChapter reset: when a chapter is reset to pending,
  // clear the accumulated cleaned text + error so new chunks don't append to stale text.
  if (evt.status === 'pending' && prevStatus !== 'pending') {
    trS3Chapters[idx].cleaned = '';
    trS3Chapters[idx].error = '';
  }
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
  // Don't let a client-side "all chapters resolved" synthesis override a backend
  // running/paused state (e.g. after a reprocess or an SSE-drop leaving a stale mirror).
  if (trS3SessionStatus === 'running' || trS3SessionStatus === 'paused') return;
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
  // Session is gone — its old chapter statuses are meaningless; reset to pending.
  for (var i = 0; i < trS3Chapters.length; i++) {
    trS3Chapters[i].status = 'pending';
    trS3Chapters[i].error = '';
    trS3Chapters[i].nodeId = '';
  }
  trS3UpdateControls();
  trS3RenderChapterList();
  trS3UpdateTabCounts();
}

function trS3ScrolledToBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 30;
}

window.trS3HasCompleted = function () {
  for (var i = 0; i < trS3Chapters.length; i++) {
    if (trS3Chapters[i].status === 'completed') return true;
  }
  return false;
};

// ===================== cleanup =====================

/**
 * Close the SSE subscription only. Do NOT stop the backend session
 * (切页不丢: the task continues; re-entering Step3 re-subscribes via snapshot).
 * Called by editor_textreview.js::cleanupTextReview on page leave.
 */
window.trCleanupStep3 = function () {
  if (trS3ReconnectTimer) { clearTimeout(trS3ReconnectTimer); trS3ReconnectTimer = null; }
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
