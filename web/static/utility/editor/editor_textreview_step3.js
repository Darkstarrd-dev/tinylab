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
var trS3UserSelected = false; // true after user manually clicked a card; auto-follow disabled until reset
var trS3ModalModel = null;      // {providerId, modelId, label} selected in the local model prompt
var trS3RightTab = 'preview';  // 当前右侧面板视图: 'preview' | 'debug'
var trS3DebugRaw = {};         // chapterIdx -> 累积的原始响应文本
var trS3DebugThinking = {};    // chapterIdx -> 累积的 thinking 思考文本
var trS3DebugContent = {};     // chapterIdx -> 累积的 content 原始输出文本
var trS3DebugCollapsed = { request: false, thinking: false, output: false }; // 各 section 折叠状态
// --- 高频渲染节流: 每 chapter 用 rAF 合批，避免 100+ tok/s 时每 delta 都同步 textContent + 强制重排 ---
var trS3PendingFlush = {};      // chapterIdx -> true (has pending render)
var trS3FlushScheduled = false; // rAF already queued
var trS3PendingDebugFlush = {}; // chapterIdx -> true (debug pane pending)
var trS3SubscribeAttempts = 0; // snapshot fetch retry counter
// --- timer + processing-speed state ---
var trTimerStart = 0;      // epoch-ms when the current running stretch began (0 when not running)
var trTimerAccum = 0;      // accumulated elapsed ms across finished running stretches
var trTimerRunning = false;
var trTimerInterval = null; // 1s clock
var trSpeedSamples = [];    // [{t: epoch-ms, total: chars}] rolling window
var trLastCleanedTotal = 0;
var trS3NodesLoadToken = 0; // coalesce concurrent pool reloads; only latest renders
var trS3PoolEditing = false;  // true while user focuses an input in the pool section (suppress clobbering re-renders)
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
    } else if (m.type === 'combo') {
      trS3ProviderNames['combo'] = 'Combo';
      trS3ModelNames['combo/' + m.id] = (m.provider ? m.provider + ' / ' : '') + m.id;
      trS3ModelNames[m.id] = (m.provider ? m.provider + ' / ' : '') + m.id;
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

  // Ensure system prompt is seeded from backend default if unset
  if (!state.systemPrompt) {
    if (window.TR_DEFAULT_PROMPT) {
      state.systemPrompt = window.TR_DEFAULT_PROMPT;
    } else {
      trApiGet('/text-review/prompt-default').then(function (res) {
        if (res && res.systemPrompt) {
          window.TR_DEFAULT_PROMPT = res.systemPrompt;
          if (res.builtinPrompt) window.TR_BUILTIN_PROMPT = res.builtinPrompt;
          if (!trState.systemPrompt) {
            trState.systemPrompt = res.systemPrompt;
            var ta = document.getElementById('tr-s3-prompt');
            if (ta && !ta.value) ta.value = res.systemPrompt;
            trSave();
          }
        }
      });
    }
  }

  panel.innerHTML =
    '<div class="tr-step-panel">' +
      '<div class="tr-split-view">' +
        // Left pane: node-pool + controls + tabs + card list
        '<div class="tr-left-pane">' +
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
              '<div class="tr-s3-prompt-footer" style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:8px;flex-wrap:wrap;">' +
                '<label class="tr-check" style="margin:0"><input type="checkbox" id="tr-s3-autoretry" onchange="trStep3OnAutoRetry()"' +
                  (state.autoRetry ? ' checked' : '') + '> ' + trEscapeHtml(trT('trAutoRetry')) + '</label>' +
                '<div style="display:flex;gap:6px;">' +
                  '<button type="button" class="tr-btn tr-btn-xs" id="tr-s3-prompt-save" onclick="trStep3SaveDefaultPrompt()">' +
                    trEscapeHtml(trT('trSavePromptDefault')) + '</button>' +
                  '<button type="button" class="tr-btn tr-btn-xs tr-btn-ghost" id="tr-s3-prompt-reset" onclick="trStep3ResetDefaultPrompt()">' +
                    trEscapeHtml(trT('trResetPromptDefault')) + '</button>' +
                '</div>' +
              '</div>' +
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
            '<div class="tr-s3-stats"><span class="tr-s3-timer" id="tr-s3-timer"></span></div>' +
            '<div class="tr-s3-tabs" id="tr-s3-tabs"></div>' +
            '<div class="tr-s3-chapters" id="tr-s3-chapters"></div>' +
            '<div class="tr-empty tr-s3-empty-hint" id="tr-s3-empty-hint" style="display:none">' +
              trEscapeHtml(trT('trTabEmpty')) + '</div>' +
          '</div>' +
        '</div>' +

        // Right pane: live streaming and preview content
        '<div class="tr-right-pane">' +
          '<div class="tr-right-pane-head">' +
            '<span class="tr-right-pane-title" id="tr-s3-detail-title">' + trEscapeHtml(trT('trPreview') || '正文清洗实时预览') + '</span>' +
            '<div class="tr-s3-right-tabs">' +
              '<button class="tr-s3-rtab' + (trS3RightTab === 'preview' ? ' active' : '') + '" data-tab="preview" onclick="trS3SwitchRightTab(\'preview\')">' +
                trEscapeHtml(trT('trPreview') || 'Preview') + '</button>' +
              '<button class="tr-s3-rtab' + (trS3RightTab === 'debug' ? ' active' : '') + '" data-tab="debug" onclick="trS3SwitchRightTab(\'debug\')">' +
                trEscapeHtml(trT('trDebug') || 'Debug') + '</button>' +
            '</div>' +
            '<span class="tr-count" id="tr-s3-detail-prog">0 ' + trEscapeHtml(trT('trCharCount') || '字') + '</span>' +
          '</div>' +
          '<div id="tr-s3-preview-wrap" class="tr-s3-view-wrap"' + (trS3RightTab !== 'preview' ? ' style="display:none"' : '') + '>' +
            '<pre class="tr-review-content" id="tr-review-content"></pre>' +
          '</div>' +
          '<div id="tr-s3-debug-wrap" class="tr-s3-view-wrap"' + (trS3RightTab !== 'debug' ? ' style="display:none"' : '') + '>' +
            '<div class="tr-debug-panel" id="tr-debug-panel"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Focus guard: while the user is editing a node-pool input, background
  // refreshes must not clobber the table (innerHTML rebuild drops focus).
  var trPoolSec = document.getElementById('tr-s3-pool-section');
  if (trPoolSec) {
    trPoolSec.addEventListener('focusin', function () { trS3PoolEditing = true; });
    trPoolSec.addEventListener('focusout', function () { trS3PoolEditing = false; });
  }

  // Wire dynamic content. 切页重连: if a session is already known, re-fetch
  // snapshot + re-subscribe (no Start button needed). If already subscribed
  // (re-render within Step3), just repaint from the in-memory mirror.
  if (trState.sessionId) {
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
 * POST /api/text-review/review-nodes (upsert).
 */
function trStep3LoadNodes() {
  var wrap = document.getElementById('tr-s3-nodes');
  if (!wrap) return;
  var token = ++trS3NodesLoadToken;
  trApiGet('/models').then(function (res) {
    var models = (res && !res.error && Array.isArray(res.models)) ? res.models : [];
    trS3PopulateProviders(models);
    return trApiGet('/text-review/review-nodes');
  }).then(function (res) {
    if (token !== trS3NodesLoadToken) return; // superseded by a newer load
    var nodes = (res && !res.error && Array.isArray(res.nodes)) ? res.nodes : [];
    trState.reviewNodes = nodes;
    trS3RenderConfigNodes(nodes);
  }, function () {
    if (token !== trS3NodesLoadToken) return;
    if (wrap) wrap.innerHTML = '<div class="tr-empty">' + trEscapeHtml(trT('trNodesLoadFailed')) + '</div>';
    trS3RenderTotal(0);
  });
}

function trS3RenderConfigNodes(nodes) {
  var wrap = document.getElementById('tr-s3-nodes');
  if (!wrap) return;
  if (trS3PoolEditing) return; // user editing an input: don't rebuild and drop focus
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
    '<th>' + trEscapeHtml(trT('trNodeReasoning')) + '</th>' +
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
      '<td><input type="checkbox" class="tr-node-reasoning" data-id="' + trEscapeHtml(n.id || '') + '"' +
        (n.reasoning ? ' checked' : '') + ' onchange="trS3OnNodeReasoning(' + idAttr + ')"></td>' +
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

function trS3OnNodeReasoning(id) {
  var row = trS3FindNodeRow(id);
  if (!row || !row.reasoning) return;
  var node = null;
  for (var i = 0; i < trState.reviewNodes.length; i++) { if (trState.reviewNodes[i].id === id) { node = trState.reviewNodes[i]; break; } }
  if (!node) return;
  node.reasoning = !!row.reasoning.checked;
  trS3UpsertNode(id, !!row.en.checked, Math.max(0, parseInt(row.conc.value, 10) || 0));
}

function trS3FindNodeRow(id) {
  var sel = trS3CssSelector(nid(id));
  var en = document.querySelector('.tr-node-en[data-id="' + sel + '"]');
  var conc = document.querySelector('.tr-node-conc[data-id="' + sel + '"]');
  if (!en || !conc) return null;
  var interval = document.querySelector('.tr-node-interval[data-id="' + sel + '"]');
  var batch = document.querySelector('.tr-node-batch[data-id="' + sel + '"]');
  var reasoning = document.querySelector('.tr-node-reasoning[data-id="' + sel + '"]');
  return { en: en, conc: conc, interval: interval, batch: batch, reasoning: reasoning };
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
    batchChars: node.batchChars || 0,
    reasoning: !!node.reasoning
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
    node.reasoning = patch.reasoning;
    var total = 0;
    for (var j = 0; j < trState.reviewNodes.length; j++) {
      if (trState.reviewNodes[j].enabled) total += (trState.reviewNodes[j].concurrency || 0);
    }
    trS3RenderTotal(total);
  }, function () { trToast(trT('trNodeSaveFailed'), 'error'); });
}

// ===================== node pool: Settings modal (universal modal) =====================

/**
 * Open the node pool Settings modal.
 */
function trStep3OpenSettings() {
  trS3ModalModel = null; // Reset selection only when opening settings freshly
  trStep3RenderSettingsModal();
}

function trStep3RenderSettingsModal() {
  // Fetch models for provider/model dropdowns
  trApiGet('/models').then(function (res) {
    var allModels = (res && !res.error && Array.isArray(res.models)) ? res.models : [];
    trS3PopulateProviders(allModels);
    window._trS3ModalModels = allModels;

    // Node list rows
    var nodes = trState.reviewNodes || [];
    var nodeRows = '';
    for (var ni = 0; ni < nodes.length; ni++) {
      var n = nodes[ni];
      nodeRows += '<tr>' +
        '<td style="color:var(--text-muted);">' + (ni + 1) + '</td>' +
        '<td>' + trEscapeHtml(trS3ProviderName(n.providerId)) + '</td>' +
        '<td><strong style="color:var(--text);">' + trEscapeHtml(trS3ModelName(n.providerId, n.modelId)) + '</strong></td>' +
        '<td style="text-align:center;">' + (n.concurrency != null ? n.concurrency : 1) + '</td>' +
        '<td style="text-align:center;">' + (n.intervalSec ? n.intervalSec + 's' : '-') + '</td>' +
        '<td style="text-align:center;">' + (n.batchChars ? n.batchChars : '-') + '</td>' +
        '<td style="text-align:center;">' + (n.reasoning ? '<span style="color:var(--accent,#4fc3f7);font-weight:bold;">✓</span>' : '<span style="color:var(--text-muted);">—</span>') + '</td>' +
        '<td style="text-align:center;">' + (n.enabled ? '<span style="color:var(--success,#10b981);font-weight:bold;">✓</span>' : '<span style="color:var(--text-muted);">✗</span>') + '</td>' +
        '<td style="text-align:right;"><button type="button" class="tr-btn tr-btn-xs tr-btn-danger" onclick="trStep3DeleteNode(\'' +
          trEscapeHtml(n.id || '') + '\')">' + trEscapeHtml(trT('trDelete') || '删除') + '</button></td>' +
      '</tr>';
    }

    var hasModel = trS3ModalModel && trS3ModalModel.label;
    var modelBtnHtml =
      '<div class="tr-form-row">' +
        '<label class="tr-form-label">' + trEscapeHtml(trT('trNodeModel') || '模型') + '</label>' +
        '<button type="button" class="tr-model-select-btn' + (hasModel ? ' has-value' : '') + '" id="tr-s3-modal-model-btn" onclick="trStep3PickModel()">' +
          '<span id="tr-s3-modal-model-txt" class="' + (hasModel ? 'tr-model-name' : 'tr-model-placeholder') + '">' +
            trEscapeHtml(hasModel ? trS3ModalModel.label : (trT('trSelectModel') || '点击选择模型 (Click to select model)...')) +
          '</span>' +
          '<span style="opacity:0.6; font-size:11px;">▼</span>' +
        '</button>' +
      '</div>';
    var body =
      '<div class="tr-node-card">' +
        '<div class="tr-node-card-title">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>' +
          '<span>' + trEscapeHtml(trT('trAddNode') || '添加处理节点') + '</span>' +
        '</div>' +
        modelBtnHtml +
        '<div class="tr-form-grid">' +
          '<div class="tr-form-field">' +
            '<label class="tr-form-label">' + trEscapeHtml(trT('trNodeConcurrency') || '并发数') + '</label>' +
            '<input type="number" class="tr-input" id="tr-s3-modal-conc" min="1" value="1">' +
          '</div>' +
          '<div class="tr-form-field">' +
            '<label class="tr-form-label">' + trEscapeHtml(trT('trIntervalSec') || '请求间隔(秒)') + '</label>' +
            '<input type="number" class="tr-input" id="tr-s3-modal-interval" min="0" value="0">' +
          '</div>' +
          '<div class="tr-form-field">' +
            '<label class="tr-form-label">' + trEscapeHtml(trT('trBatchChars') || '批次大小(字符)') + '</label>' +
            '<input type="number" class="tr-input" id="tr-s3-modal-batch" min="0" value="0">' +
          '</div>' +
          '<div class="tr-form-field-actions" style="gap:12px;">' +
            '<label class="tr-check">' +
              '<input type="checkbox" id="tr-s3-modal-reasoning">' +
              '<span>' + trEscapeHtml(trT('trNodeReasoning') || '思考') + '</span>' +
            '</label>' +
            '<label class="tr-check">' +
              '<input type="checkbox" id="tr-s3-modal-enabled" checked>' +
              '<span>' + trEscapeHtml(trT('trNodeEnabled') || '启用') + '</span>' +
            '</label>' +
            '<button type="button" class="tr-btn tr-btn-primary" onclick="trStep3AddNode()">' +
              trEscapeHtml(trT('trAdd') || '添加') +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    if (nodes.length > 0) {
      body +=
        '<div class="tr-node-table-section">' +
          '<div class="tr-node-table-title">' + trEscapeHtml(trT('trConfiguredNodes') || '已配置节点列表') + ' (' + nodes.length + ')</div>' +
          '<table class="tr-pe-table" style="width:100%"><thead><tr>' +
            '<th style="width:36px;">#</th>' +
            '<th>' + trEscapeHtml(trT('trNodeProvider') || '服务商') + '</th>' +
            '<th>' + trEscapeHtml(trT('trNodeModel') || '模型') + '</th>' +
            '<th style="text-align:center;width:70px;">' + trEscapeHtml(trT('trNodeConcurrency') || '并发数') + '</th>' +
            '<th style="text-align:center;width:85px;">' + trEscapeHtml(trT('trIntervalSec') || '请求间隔') + '</th>' +
            '<th style="text-align:center;width:85px;">' + trEscapeHtml(trT('trBatchChars') || '批次大小') + '</th>' +
            '<th style="text-align:center;width:60px;">' + trEscapeHtml(trT('trNodeReasoning') || '思考') + '</th>' +
            '<th style="text-align:center;width:60px;">' + trEscapeHtml(trT('trNodeEnabled') || '启用') + '</th>' +
            '<th style="text-align:right;width:65px;">' + trEscapeHtml(trT('trActions') || '操作') + '</th>' +
          '</tr></thead><tbody>' + nodeRows + '</tbody></table>' +
        '</div>';
    }

    var html =
      '<div class="modal" style="max-width:760px; width:92%; max-height:85vh; display:flex; flex-direction:column;">' +
        '<div class="modal-title" style="display:flex; justify-content:space-between; align-items:center;">' +
          '<span>' + trEscapeHtml(trT('trSettings') || '设置') + ' — ' + trEscapeHtml(trT('trNodePool') || '节点池') + '</span>' +
          '<button type="button" class="btn btn-ghost btn-sm" onclick="trCloseModal();trStep3OnSettingsClosed()" style="padding:2px 8px;">✕</button>' +
        '</div>' +
        '<div class="modal-body" style="flex:1; overflow-y:auto; padding:12px 0;">' + body + '</div>' +
        '<div class="modal-footer" style="margin-top:10px;">' +
          '<button type="button" class="btn btn-ghost" onclick="trCloseModal();trStep3OnSettingsClosed()">' + trEscapeHtml(trT('cancel') || '关闭') + '</button>' +
        '</div>' +
      '</div>';

    if (typeof window.trShowModal === 'function') {
      window.trShowModal(html);
    } else if (typeof pgShowModal === 'function') {
      pgShowModal(html);
    }
  }, function () {
    trToast(trT('trNodesLoadFailed'), 'error');
  });
}

/**
 * Select an AI model using the system Model Picker modal.
 */
function trStep3PickModel() {
  var cur = trS3ModalModel ? (trS3ModalModel.providerId ? (trS3ModalModel.providerId + '/' + trS3ModalModel.modelId) : trS3ModalModel.modelId) : '';
  
  var onModelSelected = function (val) {
    if (!val) return;
    var all = window._trS3ModalModels || [];
    var providerId = '';
    var modelId = '';
    var label = val;
    var matched = null;

    // Direct match by ID first
    for (var i = 0; i < all.length; i++) {
      var m = all[i];
      if (m.id === val) {
        matched = m;
        break;
      }
    }

    if (matched) {
      if (matched.type === 'combo') {
        providerId = 'combo';
        modelId = matched.id;
        label = (matched.provider ? matched.provider + ' / ' : 'Combo / ') + matched.id;
      } else {
        providerId = matched.providerId || '';
        modelId = matched.realModelId || matched.id;
        label = (matched.provider ? matched.provider + ' / ' : '') + (matched.alias || matched.name || matched.realModelId || matched.id);
      }
    } else {
      var slash = val.indexOf('/');
      if (slash > 0) {
        providerId = val.slice(0, slash);
        modelId = val.slice(slash + 1);
        for (var pid in trS3ProviderPrefixes) {
          if (trS3ProviderPrefixes[pid] === providerId) {
            providerId = pid;
            break;
          }
        }
      } else {
        providerId = 'combo';
        modelId = val;
      }
      label = val;
    }

    if (!providerId) {
      providerId = 'combo';
    }

    trS3ModalModel = {
      providerId: providerId,
      modelId: modelId,
      label: label
    };

    // Re-render settings modal with the selected model preserved
    trStep3RenderSettingsModal();
  };

  if (typeof window.openModelPickerModal === 'function') {
    window.openModelPickerModal(cur, onModelSelected);
  } else if (typeof pgOpenModelPicker === 'function') {
    pgOpenModelPicker(cur, onModelSelected);
  } else {
    trToast('Model picker unavailable', 'warning');
  }
}

function trStep3AddNode() {
  if (!trS3ModalModel || !trS3ModalModel.modelId) {
    trToast(trT('trModelRequired') || '请先选择模型', 'warning');
    return;
  }
  var concEl = document.getElementById('tr-s3-modal-conc');
  var enEl = document.getElementById('tr-s3-modal-enabled');
  var reasoningEl = document.getElementById('tr-s3-modal-reasoning');
  var intervalEl = document.getElementById('tr-s3-modal-interval');
  var batchEl = document.getElementById('tr-s3-modal-batch');
  var body = {
    providerId: trS3ModalModel.providerId || 'combo',
    modelId: trS3ModalModel.modelId,
    concurrency: concEl ? Math.max(1, parseInt(concEl.value, 10) || 1) : 1,
    enabled: enEl ? enEl.checked : true,
    reasoning: reasoningEl ? reasoningEl.checked : false,
    intervalSec: intervalEl ? Math.max(0, parseInt(intervalEl.value, 10) || 0) : 0,
    batchChars: batchEl ? Math.max(0, parseInt(batchEl.value, 10) || 0) : 0
  };
  trApiPost('/text-review/review-nodes', body).then(function (res) {
    if (res && res.error) { trToast(res.error, 'error'); return; }
    trToast(trT('trNodeAddSuccess') || '节点添加成功', 'success');
    trS3ModalModel = null;
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
  if (trS3PoolEditing) return; // never clobber a table the user is editing

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

/**
 * Save current system prompt in textarea as the backend default (persisted to config.yaml).
 */
function trStep3SaveDefaultPrompt() {
  var ta = document.getElementById('tr-s3-prompt');
  var val = ta ? ta.value : (trState.systemPrompt || '');
  trApiPost('/text-review/prompt-default', { systemPrompt: val }).then(function (res) {
    if (res && res.systemPrompt !== undefined) {
      window.TR_DEFAULT_PROMPT = res.systemPrompt;
      trState.systemPrompt = val;
      trSave();
      trToast(trT('trPromptSaved'), 'success');
    } else {
      trToast(trT('trPromptSaveFailed'), 'error');
    }
  }, function () {
    trToast(trT('trPromptSaveFailed'), 'error');
  });
}

/**
 * Restore textarea and state to built-in system default prompt.
 */
function trStep3ResetDefaultPrompt() {
  var target = window.TR_BUILTIN_PROMPT;
  if (!target) {
    trApiGet('/text-review/prompt-default').then(function (res) {
      if (res && res.builtinPrompt) {
        window.TR_BUILTIN_PROMPT = res.builtinPrompt;
        trS3ApplyResetPrompt(res.builtinPrompt);
      }
    });
    return;
  }
  trS3ApplyResetPrompt(target);
}

function trS3ApplyResetPrompt(promptText) {
  var ta = document.getElementById('tr-s3-prompt');
  if (ta) ta.value = promptText;
  trState.systemPrompt = promptText;
  trSave();
  trToast(trT('trPromptReset'), 'success');
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
  // If there's an existing terminal session (cancelled/completed), restart it
  // to preserve already-completed chapters instead of creating a fresh session.
  var terminal = (trS3SessionStatus === 'cancelled' || trS3SessionStatus === 'completed' || trS3SessionStatus === 'failed');
  if (trState.sessionId && terminal) {
    trS3SessionStatus = 'running';
    trS3UpdateControls();
    trApiPost('/text-review/sessions/' + trState.sessionId + '/restart', { nodeIds: nodeIds }).then(function (res) {
      if (res && res.error) {
        trToast(res.error, 'error');
        // No pending to restart means everything was already completed; just mark completed
        if (String(res.error).indexOf('no pending') !== -1) {
          trS3SessionStatus = 'completed';
          trS3UpdateControls();
        } else {
          trS3SessionStatus = 'cancelled';
          trS3UpdateControls();
        }
        return;
      }
      trS3UserSelected = false;
      trTimerReset();
      trTimerStartRun();
      trTimerTick();
      trTimerEnsureClock();
      trSubscribeSession(trState.sessionId);
    }).catch(function (err) {
      console.warn('tr restart failed:', err);
      trToast(trT('trStartFailed'), 'error');
      trS3SessionStatus = 'cancelled';
      trS3UpdateControls();
    });
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
    trS3UserSelected = false;
    trTimerReset();
    trTimerStartRun();
    trTimerTick();
    trTimerEnsureClock();
    // Surface an instantly-terminated session (no usable node) instead of silent no-op
    if (res && res.status && res.status !== 'running' && res.status !== 'paused') {
      trToast((typeof trT === 'function' ? trT('trSessionNoWork') : '') || ('会话未开始处理（' + res.status + '）：请检查节点是否启用且并发数>0'), 'warning');
    }
    trSubscribeSession(trState.sessionId);
  }).catch(function (err) {
    console.warn('tr start failed:', err);
    trToast(trT('trStartFailed'), 'error');
    trS3SessionStatus = 'idle';
    trS3UpdateControls();
  });
}

function trStep3Pause() {
  if (!trState.sessionId) return;
  trS3SessionStatus = 'paused';
  trS3UpdateControls();
  trApiPost('/text-review/sessions/' + trState.sessionId + '/pause', {}).then(function (res) {
    if (res && res.error) {
      trToast(res.error, 'error');
      // revert via snapshot
      if (trState.sessionId) trSubscribeSession(trState.sessionId);
    }
  }, function () {
    trToast(trT('trPauseFailed'), 'error');
    if (trState.sessionId) trSubscribeSession(trState.sessionId);
  });
}

function trStep3Resume() {
  if (!trState.sessionId) return;
  trS3SessionStatus = 'running';
  trS3UpdateControls();
  trApiPost('/text-review/sessions/' + trState.sessionId + '/resume', {}).then(function (res) {
    if (res && res.error) {
      trToast(res.error, 'error');
      if (trState.sessionId) trSubscribeSession(trState.sessionId);
    }
  }, function () {
    trToast(trT('trResumeFailed'), 'error');
    if (trState.sessionId) trSubscribeSession(trState.sessionId);
  });
}

function trStep3Stop() {
  if (!trState.sessionId) return;
  trTimerFreeze();
  trTimerTick();
  trApiPost('/text-review/sessions/' + trState.sessionId + '/stop', {}).then(function () {
    trS3SessionStatus = 'cancelled';
    trS3UpdateControls();
    trS3RefreshPoolAfterStop();
  }, function () {
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
  if (pool) pool.style.display = active ? 'none' : '';
  if (promptSec) promptSec.style.display = active ? 'none' : '';
  // Range inputs are fixed at session creation; lock them while a session is live.
  var rs = document.getElementById('tr-s3-range-start');
  var re = document.getElementById('tr-s3-range-end');
  if (rs) rs.disabled = active;
  if (re) re.disabled = active;

  var toReview = document.getElementById('tr-s3-toreview');
  if (toReview) {
    var hasDone = (typeof window.trS3HasCompleted === 'function') ? window.trS3HasCompleted() : false;
    // 只要有任何一章完成了，审校按钮就高亮可用，无需等待全量或当前 batch 完成
    toReview.className = hasDone ? 'tr-btn tr-btn-primary' : 'tr-btn';
  }
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
// content (or cleaned stream) in the right content pane.
function trS3SelectChapter(idx) {
  if (idx < 0 || idx >= trS3Chapters.length) return;
  trS3SelectedIdx = idx;
  trS3UserSelected = true;
  var cards = document.querySelectorAll('#tr-s3-chapters .tr-s3-card');
  for (var i = 0; i < cards.length; i++) cards[i].classList.remove('selected');
  var card = document.querySelector('#tr-s3-chapters .tr-s3-card[data-idx="' + idx + '"]');
  if (card) card.classList.add('selected');
  var pane = document.getElementById('tr-review-content') || document.getElementById('ed-review-content');
  if (!pane) return;
  var c = trS3Chapters[idx];
  var text;
  if (c.status === 'processing') {
    text = c.cleaned || c.content || '';
  } else if (c.status === 'completed' || c.status === 'failed') {
    text = c.cleaned || c.content || '';
  } else {
    text = c.content || '';
  }
  if (c.status === 'failed' && c.error) text += (text ? '\n\n' : '') + '[' + c.error + ']';
  pane.textContent = text;
  var titleEl = document.getElementById('tr-s3-detail-title');
  if (titleEl) titleEl.textContent = (c.title || ('#' + (idx + 1))) + ' (' + trT('trStatus_' + (c.status || 'pending')) + ')';
  var progEl = document.getElementById('tr-s3-detail-prog');
  if (progEl) progEl.textContent = trS3CardProgress(c) + ' ' + (trT('trCharCount') || '字');

  if (trS3ScrolledToBottom(pane)) pane.scrollTop = pane.scrollHeight;

  // 同步刷新 debug 面板
  if (trS3RightTab === 'debug') trS3RenderDebugPanel(idx);
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
  trS3SubscribeAttempts = 0;
  trS3FetchSnapshot(id);
  trS3OpenEventSource(id);
}

function trS3FetchSnapshot(id) {
  trApiGet('/text-review/sessions/' + id).then(function (res) {
    if (res && !res.error) {
      trS3SubscribeAttempts = 0;
      trS3ReconcileFromSnapshot(res);
      trS3RenderAll();
    } else {
      trS3SubscribeAttempts++;
      if (trS3SubscribeAttempts <= 3) {
        setTimeout(function () { if (trState.sessionId === id) trS3FetchSnapshot(id); }, 400);
      } else {
        trS3OnSessionGone();
        trToast((typeof trT === 'function' ? trT('trSessionUnavailable') : '') || '会话暂时不可用（' + (res && res.error || '网络错误') + '）', 'error');
      }
    }
  }).catch(function () {
    trS3SubscribeAttempts++;
    if (trS3SubscribeAttempts <= 3) {
      setTimeout(function () { if (trState.sessionId === id) trS3FetchSnapshot(id); }, 400);
    } else {
      trS3OnSessionGone();
      trToast('会话暂时不可用（网络错误）', 'error');
    }
  });
}

function trS3OpenEventSource(id) {
  if (trEventSource) { trEventSource.close(); trEventSource = null; }
  trEventSource = new EventSource('/api/text-review/sessions/' + id + '/events');
  trEventSource.addEventListener('chunk', function (e) {
    try { var d = JSON.parse(e.data); trS3OnChunk(d); } catch (_) {}
  });
  trEventSource.addEventListener('raw', function (e) {
    try { var d = JSON.parse(e.data); trS3OnRaw(d); } catch (_) {}
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
 * rAF 合批调度: 将本帧内所有 pending 的 chunk/raw 合并为一次 DOM 写。
 * 只刷新当前选中章节的可见面板，避免为非选中章节做无用重排。
 * 状态/计数类更新仍即时执行，重量级 textContent 写走 rAF。
 */
function trS3ScheduleFlush() {
  if (trS3FlushScheduled) return;
  trS3FlushScheduled = true;
  var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (cb) { return setTimeout(cb, 16); };
  raf(function () {
    trS3FlushScheduled = false;
    // snapshot + clear pending before render (new deltas arriving during render go to next frame)
    var pending = trS3PendingFlush;
    var pendingDebug = trS3PendingDebugFlush;
    trS3PendingFlush = {};
    trS3PendingDebugFlush = {};
    // 只刷新当前选中章节; 大量并发时非选中章节仅累积状态，不做 DOM
    if (pending[trS3SelectedIdx]) {
      trS3FlushChunkDom(trS3SelectedIdx);
    }
    if (pendingDebug[trS3SelectedIdx] && trS3RightTab === 'debug') {
      trS3UpdateLiveDebugElements(trS3SelectedIdx);
    }
  });
}

function trS3FlushChunkDom(idx) {
  if (idx == null || idx < 0 || idx >= trS3Chapters.length) return;
  var c = trS3Chapters[idx];
  if (idx !== trS3SelectedIdx) return;
  var pane = document.getElementById('tr-review-content') || document.getElementById('ed-review-content');
  if (pane) {
    // 增量追加优于全量重赋: 仅当 pane 内容与 cleaned 不一致时做一次全量同步，其余走追加
    var cur = pane.textContent || '';
    var next = c.cleaned || '';
    if (next.length >= cur.length && next.indexOf(cur) === 0) {
      if (next.length > cur.length) pane.appendChild(document.createTextNode(next.slice(cur.length)));
    } else {
      pane.textContent = next;
    }
    if (trS3ScrolledToBottom(pane)) pane.scrollTop = pane.scrollHeight;
  }
  var progEl = document.getElementById('tr-s3-detail-prog');
  if (progEl) progEl.textContent = trS3CardProgress(c) + ' ' + (trT('trCharCount') || '字');
}

/**
 * raw: append raw unparsed streaming delta (separating thinking from content)
 * to debug buffers for live visualization.
 */
function trS3OnRaw(evt) {
  var idx = evt.chapterIdx;
  if (idx == null || idx < 0 || idx >= trS3Chapters.length) return;
  if (!trS3DebugRaw[idx]) trS3DebugRaw[idx] = '';
  trS3DebugRaw[idx] += evt.delta || '';

  if (evt.section === 'thinking') {
    if (!trS3DebugThinking[idx]) trS3DebugThinking[idx] = '';
    trS3DebugThinking[idx] += evt.delta || '';
  } else {
    if (!trS3DebugContent[idx]) trS3DebugContent[idx] = '';
    trS3DebugContent[idx] += evt.delta || '';
  }

  // 数据先累积，DOM 走 rAF 合批，避免每 token 一次 textContent + 强制重排
  if (trS3RightTab === 'debug' && idx === trS3SelectedIdx) {
    trS3PendingDebugFlush[idx] = true;
    trS3ScheduleFlush();
  }
}

/**
 * 实时局部刷新 debug 面板中的 Thinking 和 Output 区域，避免全量重新渲染带来的卡顿。
 * 内部做增量追加: 若新文本是旧文本的前缀扩展则只 append 增量。
 */
function trS3UpdateLiveDebugElements(idx) {
  var c = trS3Chapters[idx];
  if (!c) return;

  var thinkText = trS3DebugThinking[idx] || '';
  var thinkEl = document.getElementById('tr-debug-thinking');
  var thinkCountEl = document.getElementById('tr-debug-thinking-count');
  var thinkSec = document.getElementById('tr-debug-section-thinking');

  if (thinkText) {
    if (thinkSec) thinkSec.style.display = '';
    if (thinkEl) {
      var curThink = thinkEl.textContent || '';
      if (thinkText.length >= curThink.length && thinkText.indexOf(curThink) === 0) {
        if (thinkText.length > curThink.length) thinkEl.appendChild(document.createTextNode(thinkText.slice(curThink.length)));
      } else {
        thinkEl.textContent = thinkText;
      }
      if (trS3ScrolledToBottom(thinkEl)) thinkEl.scrollTop = thinkEl.scrollHeight;
    }
    if (thinkCountEl) {
      thinkCountEl.textContent = (trT('trDebugChars', [thinkText.length]) || (thinkText.length + ' 字'));
    }
  }

  var outText = trS3DebugContent[idx] || c.cleaned || trS3DebugRaw[idx] || '';
  var outEl = document.getElementById('tr-debug-output');
  var outCountEl = document.getElementById('tr-debug-output-count');

  if (outEl && outText) {
    var curOut = outEl.textContent || '';
    if (outText.length >= curOut.length && outText.indexOf(curOut) === 0) {
      if (outText.length > curOut.length) outEl.appendChild(document.createTextNode(outText.slice(curOut.length)));
    } else {
      outEl.textContent = outText;
    }
    if (trS3ScrolledToBottom(outEl)) outEl.scrollTop = outEl.scrollHeight;
  }
  if (outCountEl && outText) {
    outCountEl.textContent = (trT('trDebugChars', [outText.length]) || (outText.length + ' 字'));
  }
}

/**
 * chunk: append `delta` to chapter chapterIdx's accumulating cleaned text and
 * auto-scroll the live pane to bottom while the user hasn't scrolled up. The
 * first chunk for a chapter also flips its status to `processing`.
 * 轻量状态走即时更新，重量级 textContent 写走 rAF 合批。
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
  // 重量级 pane 写合批到下一帧
  if (idx === trS3SelectedIdx) {
    trS3PendingFlush[idx] = true;
    trS3ScheduleFlush();
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
    if (evt.status) {
      trS3SessionStatus = evt.status;
      trS3UpdateControls();
      if (evt.status === 'cancelled' || evt.status === 'completed') {
        trS3RefreshPoolAfterStop();
      }
      if (evt.status === 'running' || evt.status === 'paused') {
        trS3UserSelected = false;
      }
      trTimerSync(evt.status);
    }
    trS3MaybeSessionDone();
    return;
  }
  if (idx < 0 || idx >= trS3Chapters.length) return;
  var prevStatus = trS3Chapters[idx].status;
  trS3Chapters[idx].status = evt.status || 'pending';
  if (evt.error) trS3Chapters[idx].error = evt.error;
  if (evt.nodeId) trS3Chapters[idx].nodeId = evt.nodeId;
  // Mirror backend ReprocessChapter reset: when a chapter is reset to pending,
  // clear the accumulated cleaned text + error + raw debug buffers so new chunks don't append to stale text.
  if (evt.status === 'pending' && prevStatus !== 'pending') {
    trS3Chapters[idx].cleaned = '';
    trS3Chapters[idx].error = '';
    trS3DebugRaw[idx] = '';
    trS3DebugThinking[idx] = '';
    trS3DebugContent[idx] = '';
  }
  // 完成的章节同步清洗文本到 trState.chapters，保持数据一致性并持久化
  if (evt.status === 'completed' && trState.chapters && trState.chapters[idx]) {
    trState.chapters[idx].cleaned = trS3Chapters[idx].cleaned || '';
    trState.chapters[idx].status = 'completed';
    trSave();
  }
  trS3UpdateCardStatus(idx);
  trS3UpdateTabCounts();
  trS3UpdateControls();

  if (trS3RightTab === 'debug' && idx === trS3SelectedIdx) {
    trS3RenderDebugPanel(idx);
  }

  // 完成一章后自动切到 processing 队列首位（除非用户手动点过卡片）
  if (evt.status === 'completed') {
    // If the currently selected chapter just completed, auto-follow to next processing
    if (idx === trS3SelectedIdx) trS3UserSelected = false;
    trS3AutoFollow();
  }

  trS3MaybeSessionDone();
  // If session just became terminal, refresh pool so inputs are editable
  if (evt.status === 'cancelled' || evt.status === 'completed') {
    // session-level status handles pool too, but chapter-level terminal may also imply done
  }
}

/**
 * node: replace the runtime node pool display from `nodes[]` (live active/target
 * /enabled; a node ramped down to 0 shows enabled:false here).
 */
function trS3OnNode(evt) {
  trS3Nodes = evt.nodes || [];
  // Only update the live runtime table while actively cleaning. After
  // stop/complete the trailing in-flight node events must NOT overwrite the
  // now-editable config table (would drop input focus / show read-only rows).
  if (trS3SessionStatus === 'running' || trS3SessionStatus === 'paused') {
    trS3RenderRuntimeNodes(trS3Nodes);
  }
}

/**
 * Synthesize the session-completed state when every chapter is resolved
 * (completed or failed), then refresh controls (shows the 进入审校 button).
 */
function trS3MaybeSessionDone() {
  // Don't let a client-side "all chapters resolved" synthesis override a backend
  // running/paused state (e.g. after a reprocess or an SSE-drop leaving a stale mirror).
  if (trS3SessionStatus === 'running' || trS3SessionStatus === 'paused' || trS3SessionStatus === 'cancelled') return;
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
  trS3DebugRaw = {};
  trS3DebugThinking = {};
  trS3DebugContent = {};
  trTimerSync(trS3SessionStatus);
  if (trS3SessionStatus === 'running' || trS3SessionStatus === 'paused') {
    trS3UserSelected = false;
  }
}

function trS3RenderAll() {
  if (trS3SessionStatus === 'running' || trS3SessionStatus === 'paused') {
    trS3RenderRuntimeNodes(trS3Nodes);
  } else {
    // Terminal/idle: show editable config pool (inputs), not read-only runtime view
    trStep3LoadNodes();
  }
  trS3RenderChapterList();
  trS3UpdateTabCounts();
  trS3UpdateControls();
  trS3AutoFollow();
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

// ===================== timer + processing speed =====================

function trTimerFmt(ms) {
  ms = Math.max(0, Math.floor(ms / 1000));
  var h = Math.floor(ms / 3600);
  var m = Math.floor((ms % 3600) / 60);
  var s2 = ms % 60;
  function pad(n){ return (n < 10 ? '0' : '') + n; }
  return (h > 0 ? pad(h) + ':' : '') + pad(m) + ':' + pad(s2);
}
function trCleanedTotal() {
  var t = 0;
  for (var i = 0; i < trS3Chapters.length; i++) {
    t += (trS3Chapters[i].cleaned || '').length;
  }
  return t;
}
function trTimerElapsed() {
  return trTimerAccum + (trTimerRunning ? (Date.now() - trTimerStart) : 0);
}
function trTimerStartRun() {
  if (!trTimerRunning) {
    trTimerRunning = true;
    trTimerStart = Date.now();
    trSpeedSamples = [];
  }
}
function trTimerFreeze() {
  if (trTimerRunning) {
    trTimerAccum += (Date.now() - trTimerStart);
    trTimerRunning = false;
    trTimerStart = 0;
  }
}
function trTimerReset() {
  trTimerAccum = 0;
  trTimerStart = 0;
  trTimerRunning = false;
  trSpeedSamples = [];
}
function trTimerTick() {
  var el = document.getElementById('tr-s3-timer');
  if (!el) return;
  var now = Date.now();
  // rolling speed: chars/second over the last ~4s
  if (trTimerRunning) {
    trSpeedSamples.push({ t: now, total: trCleanedTotal() });
    while (trSpeedSamples.length > 2 && (now - trSpeedSamples[0].t) > 4000) trSpeedSamples.shift();
  }
  var speed = 0;
  if (trTimerRunning && trSpeedSamples.length >= 2) {
    var first = trSpeedSamples[0];
    var last = trSpeedSamples[trSpeedSamples.length - 1];
    if (last.t > first.t) speed = Math.round((last.total - first.total) * 1000 / (last.t - first.t));
  }
  el.textContent = '⏱ ' + trTimerFmt(trTimerElapsed()) + ' · ' + speed + ' ' + (trT('trCharsPerSec') || '字/秒');
}
function trTimerEnsureClock() {
  if (trTimerInterval) return;
  trTimerInterval = setInterval(trTimerTick, 1000);
}
function trTimerStopClock() {
  if (trTimerInterval) { clearInterval(trTimerInterval); trTimerInterval = null; }
}
function trTimerSync(status) {
  if (status === 'running') { trTimerStartRun(); trTimerTick(); trTimerEnsureClock(); }
  else if (status === 'paused' || status === 'cancelled' || status === 'completed') { trTimerFreeze(); trTimerTick(); }
  else { trTimerStopClock(); }
}

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
  trTimerStopClock();
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

// ===================== right pane: debug view =====================

/**
 * 切换右侧面板的 Preview / Debug 子标签。
 */
function trS3SwitchRightTab(tab) {
  trS3RightTab = tab;
  var btns = document.querySelectorAll('.tr-s3-rtab');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('active', btns[i].getAttribute('data-tab') === tab);
  }
  var pw = document.getElementById('tr-s3-preview-wrap');
  var dw = document.getElementById('tr-s3-debug-wrap');
  if (pw) pw.style.display = tab === 'preview' ? '' : 'none';
  if (dw) dw.style.display = tab === 'debug' ? '' : 'none';
  if (tab === 'debug') trS3RenderDebugPanel(trS3SelectedIdx);
}

/**
 * 构建选中章节的备选请求体 JSON（在后端 DebugRequest 尚未到达时展示）。
 */
function trS3BuildPreviewRequest(idx) {
  if (idx < 0 || idx >= trS3Chapters.length) return '';
  var c = trS3Chapters[idx];
  var modelName = 'default';
  for (var i = 0; i < trS3Nodes.length; i++) {
    if (trS3Nodes[i].enabled) {
      modelName = trS3Nodes[i].modelId || trS3Nodes[i].id;
      break;
    }
  }
  var sys = trState.systemPrompt || '';
  var req = {
    model: modelName,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: c.content || '' }
    ],
    stream: true
  };
  return JSON.stringify(req, null, 2);
}

/**
 * 切换指定调试区域（request / thinking / output）的折叠/展开状态。
 */
function trS3ToggleDebugSection(section) {
  trS3DebugCollapsed[section] = !trS3DebugCollapsed[section];
  var secEl = document.getElementById('tr-debug-section-' + section);
  var btnEl = document.getElementById('tr-debug-toggle-' + section);
  if (secEl) secEl.classList.toggle('collapsed', !!trS3DebugCollapsed[section]);
  if (btnEl) {
    btnEl.textContent = trS3DebugCollapsed[section]
      ? (trT('trDebugThinkingExpand') || '展开')
      : (trT('trDebugThinkingFold') || '折叠');
  }
}

/**
 * 渲染选中章节的调试信息面板：状态行 + 请求体 + 思考过程(Thinking) + 清洗输出(Output)。
 */
function trS3RenderDebugPanel(idx) {
  var panel = document.getElementById('tr-debug-panel');
  if (!panel || idx < 0 || idx >= trS3Chapters.length) return;
  var c = trS3Chapters[idx];
  var statusText = c.debugStatusCode ? ('HTTP ' + c.debugStatusCode) : (c.status === 'processing' ? 'PROCESSING' : '—');
  var statusClass = '';
  if (c.debugStatusCode >= 200 && c.debugStatusCode < 300) statusClass = ' tr-debug-ok';
  else if (c.debugStatusCode >= 400) statusClass = ' tr-debug-err';
  else if (c.status === 'processing') statusClass = ' tr-debug-ok';

  var reqText = c.debugRequest || trS3BuildPreviewRequest(idx);
  var thinkText = trS3DebugThinking[idx] || '';
  var outText = trS3DebugContent[idx] || c.cleaned || c.debugRawBody || '';

  // 是否处于思考阶段（正在 processing 且正文尚无输出）
  var isThinkingActive = (c.status === 'processing' && !outText && thinkText);
  var isOutputActive = (c.status === 'processing' && outText);

  var outPlaceholder = (c.status === 'processing')
    ? (thinkText ? '(' + trEscapeHtml(trT('trDebugThinkingActive') || '思考中，等待正文输出...') + ')' : '(' + trEscapeHtml(trT('trDebugWaiting') || '等待模型输出流...') + ')')
    : (c.status === 'pending')
      ? '(' + trEscapeHtml(trT('trDebugAwaitReq') || '等待请求...') + ')'
      : '(' + trEscapeHtml(trT('trDebugNoData') || '无数据') + ')';

  // 如果没有独立 thinking 数据但处于 completed 状态，且 rawBody 包含 <think> 标签，做一次智能抽取
  if (!thinkText && c.debugRawBody && c.debugRawBody.indexOf('<think>') >= 0) {
    var m = c.debugRawBody.match(/<think>([\s\S]*?)<\/think>/);
    if (m && m[1]) {
      thinkText = m[1].trim();
      if (!outText) outText = c.debugRawBody.replace(/<think>[\s\S]*?<\/think>/, '').trim();
    }
  }

  var showThinkingSection = !!thinkText || (c.status === 'processing');

  var reqCollapsed = !!trS3DebugCollapsed.request;
  var thinkCollapsed = !!trS3DebugCollapsed.thinking;
  var outCollapsed = !!trS3DebugCollapsed.output;

  panel.innerHTML =
    // 状态行
    '<div class="tr-debug-status' + statusClass + '">' +
      '<span class="tr-debug-status-code">' + trEscapeHtml(statusText) + '</span>' +
      '<span class="tr-debug-status-label">' + trEscapeHtml(c.status || 'pending') + '</span>' +
      (c.error ? '<span class="tr-debug-status-err" title="' + trEscapeHtml(c.error) + '">' + trEscapeHtml(c.error) + '</span>' : '') +
    '</div>' +

    // 请求体 (Request)
    '<div class="tr-debug-section' + (reqCollapsed ? ' collapsed' : '') + '" id="tr-debug-section-request">' +
      '<div class="tr-debug-section-head">' +
        '<div class="tr-debug-head-title">' +
          '<span>\ud83d\udce4 Request</span>' +
        '</div>' +
        '<div class="tr-debug-head-actions">' +
          '<button class="tr-btn tr-btn-xs" id="tr-debug-toggle-request" onclick="trS3ToggleDebugSection(\'request\')">' +
            trEscapeHtml(reqCollapsed ? (trT('trDebugThinkingExpand') || '展开') : (trT('trDebugThinkingFold') || '折叠')) +
          '</button>' +
          '<button class="tr-btn tr-btn-xs" onclick="trS3CopyDebug(\'request\')">' +
            trEscapeHtml(trT('trCopy') || 'Copy') + '</button>' +
        '</div>' +
      '</div>' +
      '<pre class="tr-debug-body" id="tr-debug-request">' +
        trEscapeHtml(trS3FormatJson(reqText) || '(No data)') +
      '</pre>' +
    '</div>' +

    // 思考过程 (Thinking Process)
    (showThinkingSection ? (
      '<div class="tr-debug-section' + (thinkCollapsed ? ' collapsed' : '') + '" id="tr-debug-section-thinking">' +
        '<div class="tr-debug-section-head">' +
          '<div class="tr-debug-head-title">' +
            '<span>\ud83e\udde0 ' + trEscapeHtml(trT('trDebugThinking') || '思考过程') + '</span>' +
            '<span class="tr-debug-badge tr-debug-thinking-badge" id="tr-debug-thinking-count">' +
              trEscapeHtml(trT('trDebugChars', [thinkText.length]) || (thinkText.length + ' 字')) +
            '</span>' +
            (isThinkingActive ? ' <span class="tr-debug-live-think">\u25cf THINKING</span>' : '') +
          '</div>' +
          '<div class="tr-debug-head-actions">' +
            '<button class="tr-btn tr-btn-xs" id="tr-debug-toggle-thinking" onclick="trS3ToggleDebugSection(\'thinking\')">' +
              trEscapeHtml(thinkCollapsed ? (trT('trDebugThinkingExpand') || '展开') : (trT('trDebugThinkingFold') || '折叠')) +
            '</button>' +
            '<button class="tr-btn tr-btn-xs" onclick="trS3CopyDebug(\'thinking\')">' +
              trEscapeHtml(trT('trCopy') || 'Copy') + '</button>' +
          '</div>' +
        '</div>' +
        '<pre class="tr-debug-body tr-debug-thinking-body" id="tr-debug-thinking">' +
          trEscapeHtml(thinkText || '(' + trEscapeHtml(trT('trDebugThinkingActive') || '思考中...') + ')') +
        '</pre>' +
      '</div>'
    ) : '') +

    // 清洗输出 (Cleaned Output)
    '<div class="tr-debug-section' + (outCollapsed ? ' collapsed' : '') + '" id="tr-debug-section-output">' +
      '<div class="tr-debug-section-head">' +
        '<div class="tr-debug-head-title">' +
          '<span>\ud83d\udcdd ' + trEscapeHtml(trT('trDebugOutput') || '清洗输出') + '</span>' +
          (outText ? (
            '<span class="tr-debug-badge" id="tr-debug-output-count">' +
              trEscapeHtml(trT('trDebugChars', [outText.length]) || (outText.length + ' 字')) +
            '</span>'
          ) : '') +
          (isOutputActive ? ' <span class="tr-debug-live-stream">\u25cf STREAMING</span>' : '') +
        '</div>' +
        '<div class="tr-debug-head-actions">' +
          '<button class="tr-btn tr-btn-xs" id="tr-debug-toggle-output" onclick="trS3ToggleDebugSection(\'output\')">' +
            trEscapeHtml(outCollapsed ? (trT('trDebugThinkingExpand') || '展开') : (trT('trDebugThinkingFold') || '折叠')) +
          '</button>' +
          '<button class="tr-btn tr-btn-xs" onclick="trS3CopyDebug(\'output\')">' +
            trEscapeHtml(trT('trCopy') || 'Copy') + '</button>' +
        '</div>' +
      '</div>' +
      '<pre class="tr-debug-body tr-debug-output-body" id="tr-debug-output">' +
        trEscapeHtml(outText || outPlaceholder) +
      '</pre>' +
    '</div>';
}

/**
 * 尝试格式化 JSON 字符串，失败则原样返回。
 */
function trS3FormatJson(s) {
  if (!s) return '';
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch (_) { return s; }
}

/**
 * 复制调试面板中指定区域的内容到剪贴板。
 */
function trS3CopyDebug(section) {
  var el = document.getElementById('tr-debug-' + section);
  if (!el) return;
  var text = el.textContent || '';
  if (typeof window.copyToClipboard === 'function') {
    window.copyToClipboard(text, section);
  } else {
    navigator.clipboard.writeText(text).then(function () {
      trToast(trT('trCopied') || 'Copied', 'success');
    });
  }
}
