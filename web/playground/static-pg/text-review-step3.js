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
  panel.innerHTML =
    '<div class="tr-step-panel">' +

      // node pool (config form when idle, runtime table when session live)
      '<div class="tr-section">' +
        '<h3 class="tr-section-title">' + trEscapeHtml(trT('trNodePool')) + '</h3>' +
        '<p class="tr-section-desc">' + trEscapeHtml(trT('trNodePoolDesc')) + '</p>' +
        '<div class="tr-nodes-wrap" id="tr-s3-nodes">' +
          '<div class="tr-empty">' + trEscapeHtml(trT('trLoading')) + '</div>' +
        '</div>' +
        '<div class="tr-s3-total" id="tr-s3-total"></div>' +
      '</div>' +

      // system prompt + auto-retry
      '<div class="tr-section">' +
        '<h3 class="tr-section-title">' + trEscapeHtml(trT('trSystemPrompt')) + '</h3>' +
        '<textarea class="tr-textarea" id="tr-s3-prompt" placeholder="' +
          trEscapeHtml(trT('trSystemPromptPlaceholder')) + '" oninput="trStep3OnPromptChange()">' +
          trEscapeHtml(state.systemPrompt || '') +
        '</textarea>' +
        '<label class="tr-check"><input type="checkbox" id="tr-s3-autoretry" onchange="trStep3OnAutoRetry()"' +
          (state.autoRetry ? ' checked' : '') + '> ' + trEscapeHtml(trT('trAutoRetry')) + '</label>' +
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
  // Preserve providerId/modelId from the local mirror; patch concurrency/enabled.
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

// ===================== node pool: runtime table (live, during a run) =====================

function trS3RenderRuntimeNodes(nodes) {
  var wrap = document.getElementById('tr-s3-nodes');
  if (!wrap) return;
  if (!nodes || nodes.length === 0) {
    wrap.innerHTML = '<div class="tr-empty">' + trEscapeHtml(trT('trNoNodes')) + '</div>';
    return;
  }
  var html = '<table class="tr-nodes-table tr-s3-runtime"><thead><tr>' +
    '<th>' + trEscapeHtml(trT('trNodeEnabled')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeProvider')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeModel')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeTarget')) + '</th>' +
    '<th>' + trEscapeHtml(trT('trNodeActive')) + '</th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    html += '<tr' + (n.enabled ? '' : ' class="tr-s3-node-disabled"') + '>' +
      '<td>' + (n.enabled ? '✓' : '✗') + '</td>' +
      '<td>' + trEscapeHtml(n.providerId || '') + '</td>' +
      '<td>' + trEscapeHtml(n.modelId || '') + '</td>' +
      '<td>' + (n.target != null ? n.target : 0) + '</td>' +
      '<td>' + (n.active != null ? n.active : 0) + '</td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
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

// ===================== run controls =====================

/**
 * "开始清理": gather chapters (Step2 output), systemPrompt, and the enabled
 * node IDs from the config pool → POST /sessions → persist sessionId →
 * subscribe to the SSE stream. The button is disabled while a run is active.
 */
function trStep3Start() {
  var chapters = trState.chapters || [];
  if (chapters.length === 0) { trToast(trT('trNoChaptersToClean'), 'warn'); return; }
  var enabledIds = trS3EnabledNodeIds();
  if (enabledIds.length === 0) { trToast(trT('trNoNodesEnabled'), 'warn'); return; }
  var startBtn = document.getElementById('tr-s3-start');
  if (startBtn) startBtn.disabled = true;
  var body = {
    fileName: trState.fileName || '',
    rawText: trState.rawText || '',
    chapters: chapters.map(function (c) { return { title: c.title || '', content: c.content || '' }; }),
    systemPrompt: trState.systemPrompt || '',
    nodeIds: enabledIds
  };
  trApiPost('/text-review/sessions', body).then(function (res) {
    if (!res || res.error || !res.sessionId) {
      if (startBtn) startBtn.disabled = false;
      trToast((res && res.error) ? res.error : trT('trStartFailed'), 'error');
      return;
    }
    trState.sessionId = res.sessionId;
    trSave();
    trS3SessionStatus = 'running';
    trS3UpdateControls();
    trSubscribeSession(res.sessionId);
  }, function () {
    if (startBtn) startBtn.disabled = false;
    trToast(trT('trStartFailed'), 'error');
  });
}

function trStep3Pause() {
  if (!trState.sessionId) return;
  trApiPost('/text-review/sessions/' + encodeURIComponent(trState.sessionId) + '/pause', {}).then(function (res) {
    if (res && res.error) trToast(trT('trPauseFailed'), 'error');
    else { trS3SessionStatus = 'paused'; trS3UpdateControls(); }
  }, function () { trToast(trT('trPauseFailed'), 'error'); });
}

function trStep3Resume() {
  if (!trState.sessionId) return;
  trApiPost('/text-review/sessions/' + encodeURIComponent(trState.sessionId) + '/resume', {}).then(function (res) {
    if (res && res.error) trToast(trT('trResumeFailed'), 'error');
    else { trS3SessionStatus = 'running'; trS3UpdateControls(); }
  }, function () { trToast(trT('trResumeFailed'), 'error'); });
}

function trStep3Stop() {
  if (!trState.sessionId) return;
  trApiPost('/text-review/sessions/' + encodeURIComponent(trState.sessionId) + '/stop', {}).then(function (res) {
    if (res && res.error) trToast(trT('trStopFailed'), 'error');
    else { trS3SessionStatus = 'cancelled'; trS3UpdateControls(); }
  }, function () { trToast(trT('trStopFailed'), 'error'); });
}

function trStep3Reprocess(idx) {
  if (!trState.sessionId) return;
  trApiPost('/text-review/sessions/' + encodeURIComponent(trState.sessionId) +
    '/chapters/' + encodeURIComponent(String(idx)) + '/reprocess', {}).then(function (res) {
    if (res && res.error) trToast(trT('trReprocessFailed'), 'error');
    else trToast(trT('trReprocessQueued'), 'info');
  }, function () { trToast(trT('trReprocessFailed'), 'error'); });
}

function trS3EnabledNodeIds() {
  var ids = [];
  var nodes = trState.reviewNodes || [];
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].enabled && (nodes[i].concurrency || 0) > 0) ids.push(nodes[i].id);
  }
  return ids;
}

function trS3UpdateControls() {
  var hasSession = !!trState.sessionId;
  var active = (trS3SessionStatus === 'running' || trS3SessionStatus === 'idle' || trS3SessionStatus === 'paused');
  var startBtn = document.getElementById('tr-s3-start');
  var pauseBtn = document.getElementById('tr-s3-pause');
  var resumeBtn = document.getElementById('tr-s3-resume');
  var stopBtn = document.getElementById('tr-s3-stop');
  var reviewBtn = document.getElementById('tr-s3-toreview');
  if (startBtn) startBtn.disabled = active;
  if (pauseBtn) pauseBtn.style.display = (hasSession && trS3SessionStatus === 'running') ? '' : 'none';
  if (resumeBtn) resumeBtn.style.display = (hasSession && trS3SessionStatus === 'paused') ? '' : 'none';
  if (stopBtn) stopBtn.style.display = (hasSession && active) ? '' : 'none';
  if (reviewBtn) reviewBtn.style.display = (hasSession && trS3SessionStatus === 'completed') ? '' : 'none';
}

// ===================== chapter tabs + list =====================

function trS3TabCounts() {
  var counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (var i = 0; i < trS3Chapters.length; i++) {
    var s = trS3Chapters[i].status;
    if (counts[s] != null) counts[s]++;
  }
  return counts;
}

function trS3UpdateTabCounts() {
  var tabs = document.getElementById('tr-s3-tabs');
  if (!tabs) return;
  var counts = trS3TabCounts();
  var tabDefs = [
    { key: 'pending', label: trT('trTabPending') },
    { key: 'processing', label: trT('trTabProcessing') },
    { key: 'completed', label: trT('trTabCompleted') },
    { key: 'failed', label: trT('trTabFailed') }
  ];
  var html = '';
  for (var i = 0; i < tabDefs.length; i++) {
    var td = tabDefs[i];
    html += '<button type="button" class="tr-s3-tab' +
      (td.key === trS3ActiveTab ? ' active' : '') + '" onclick="trS3SelectTab(\'' + td.key + '\')">' +
      trEscapeHtml(td.label) +
      ' <span class="tr-s3-tab-count">' + (counts[td.key] || 0) + '</span>' +
    '</button>';
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
  var wrap = document.getElementById('tr-s3-chapters');
  if (!wrap) return;
  if (trS3Chapters.length === 0) {
    wrap.innerHTML = '<div class="tr-empty">' + trEscapeHtml(trT('trNoSession')) + '</div>';
    var hint0 = document.getElementById('tr-s3-empty-hint');
    if (hint0) hint0.style.display = 'none';
    return;
  }
  var html = '';
  for (var i = 0; i < trS3Chapters.length; i++) {
    html += trS3CardHtml(trS3Chapters[i]);
  }
  wrap.innerHTML = html;
  trS3ApplyTabFilter();
}

function trS3CardHtml(c) {
  var idx = c.index;
  var badge = '<span class="tr-s3-badge tr-s3-badge-' + trEscapeHtml(c.status) + '">' +
    trEscapeHtml(trT('trStatus_' + c.status)) + '</span>';
  var meta = trS3MetaHtml(c);
  var reproc = '';
  if (c.status === 'completed' || c.status === 'failed') {
    reproc = '<button type="button" class="tr-btn tr-btn-xs" onclick="trStep3Reprocess(' + idx + ')">' +
      trEscapeHtml(trT('trReprocess')) + '</button>';
  }
  // The live pane is always present (empty for pending) so streaming chunks
  // can append to it in place without rebuilding the card.
  var live = '<pre class="tr-s3-live" id="tr-s3-live-' + idx + '">' +
    trEscapeHtml(c.cleaned || '') + '</pre>';
  return '<div class="tr-s3-card" data-idx="' + idx + '" data-status="' + trEscapeHtml(c.status) + '">' +
    '<div class="tr-s3-card-head">' +
      '<span class="tr-s3-card-title">' + (idx + 1) + '. ' + trEscapeHtml(c.title || '') + '</span>' +
      badge +
    '</div>' +
    live +
    '<div class="tr-s3-card-meta">' + meta + '</div>' +
    '<div class="tr-s3-card-foot">' + reproc + '</div>' +
  '</div>';
}

function trS3MetaHtml(c) {
  var m = '';
  if (c.nodeId) m += '<span class="tr-s3-meta-node">' + trEscapeHtml(c.nodeId) + '</span>';
  if (c.retry && c.retry > 0) m += '<span class="tr-s3-meta-retry">' +
    trEscapeHtml(trT('trRetry', [String(c.retry)])) + '</span>';
  if (c.error) m += '<span class="tr-s3-error">' + trEscapeHtml(c.error) + '</span>';
  return m;
}

function trS3ApplyTabFilter() {
  var cards = document.querySelectorAll('#tr-s3-chapters .tr-s3-card');
  var anyVisible = false;
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i];
    var status = card.getAttribute('data-status');
    var show = (status === trS3ActiveTab);
    card.style.display = show ? '' : 'none';
    if (show) anyVisible = true;
  }
  var hint = document.getElementById('tr-s3-empty-hint');
  if (hint) hint.style.display = anyVisible ? 'none' : '';
}

/**
 * Update a single card in place (badge, meta, foot, data-status) and re-apply
 * the tab filter. Does NOT rebuild the list, so other cards' live panes keep
 * their scroll positions.
 */
function trS3UpdateCardStatus(idx) {
  var ch = trS3Chapters[idx];
  if (!ch) return;
  var card = document.querySelector('#tr-s3-chapters .tr-s3-card[data-idx="' + trS3CssSelector(String(idx)) + '"]');
  if (!card) return;
  card.setAttribute('data-status', ch.status);
  var badge = card.querySelector('.tr-s3-badge');
  if (badge) {
    badge.className = 'tr-s3-badge tr-s3-badge-' + trEscapeHtml(ch.status);
    badge.textContent = trT('trStatus_' + ch.status);
  }
  var meta = card.querySelector('.tr-s3-card-meta');
  if (meta) meta.innerHTML = trS3MetaHtml(ch);
  var foot = card.querySelector('.tr-s3-card-foot');
  if (foot) {
    var reproc = '';
    if (ch.status === 'completed' || ch.status === 'failed') {
      reproc = '<button type="button" class="tr-btn tr-btn-xs" onclick="trStep3Reprocess(' + idx + ')">' +
        trEscapeHtml(trT('trReprocess')) + '</button>';
    }
    foot.innerHTML = reproc;
  }
  trS3ApplyTabFilter();
}

// ===================== SSE subscription + 切页重连 =====================

/**
 * Subscribe to a session: FIRST GET /sessions/{id} snapshot → reconcile + render
 * the full chapter list + runtime node pool, THEN open EventSource for live
 * deltas. On reconnect after an error, the snapshot is re-fetched in onopen to
 * reconcile any events missed while disconnected.
 */
function trSubscribeSession(id) {
  trApiGet('/text-review/sessions/' + encodeURIComponent(id)).then(function (res) {
    if (!res || res.error) { trS3OnSessionGone(); return; }
    trS3ReconcileFromSnapshot(res);
    trS3RenderAll();
    trS3OpenEventSource(id);
  }, function () { trS3OnSessionGone(); });
}

function trS3OpenEventSource(id) {
  if (trEventSource) { try { trEventSource.close(); } catch (_) {} trEventSource = null; }
  var url = '/api/text-review/sessions/' + encodeURIComponent(id) + '/events';
  var es = new EventSource(url);
  trEventSource = es;
  es.onopen = function () {
    // On reconnect after an error, re-fetch the snapshot to reconcile missed events.
    if (trS3NeedsReconcile) {
      trS3NeedsReconcile = false;
      trApiGet('/text-review/sessions/' + encodeURIComponent(id)).then(function (res) {
        if (res && !res.error) {
          trS3ReconcileFromSnapshot(res);
          trS3RenderAll();
        }
      });
    }
  };
  es.onmessage = function (e) {
    var evt;
    try { evt = JSON.parse(e.data); } catch (_) { return; }
    if (!evt || typeof evt.type !== 'string') return;
    if (evt.type === 'chunk') trS3OnChunk(evt);
    else if (evt.type === 'status') trS3OnStatus(evt);
    else if (evt.type === 'node') trS3OnNode(evt);
  };
  es.onerror = function () {
    // EventSource auto-reconnects; the backend task continues (切页不丢). Do NOT
    // alert. Mark for snapshot reconcile on the next successful reopen.
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
  var ch = trS3Chapters[idx];
  if (!ch) return;
  var delta = evt.delta || '';
  var wasProcessing = (ch.status === 'processing');
  ch.cleaned = (ch.cleaned || '') + delta;
  if (!wasProcessing) {
    ch.status = 'processing';
    trS3UpdateCardStatus(idx);
    trS3UpdateTabCounts();
    trS3MaybeSessionDone();
  }
  var pre = document.getElementById('tr-s3-live-' + idx);
  if (pre && delta) {
    var atBottom = trS3ScrolledToBottom(pre);
    pre.appendChild(document.createTextNode(delta));
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }
}

/**
 * status: update chapter chapterIdx's status badge (+ error/nodeId if present).
 * Moving a card to its new tab is handled by the in-place card update + filter.
 */
function trS3OnStatus(evt) {
  var idx = evt.chapterIdx;
  var ch = trS3Chapters[idx];
  if (!ch) return;
  var changed = false;
  if (evt.status && ch.status !== evt.status) { ch.status = evt.status; changed = true; }
  if (evt.error) ch.error = evt.error;
  if (evt.nodeId) ch.nodeId = evt.nodeId;
  if (changed) {
    trS3UpdateCardStatus(idx);
    trS3UpdateTabCounts();
    trS3MaybeSessionDone();
  }
}

/**
 * node: replace the runtime node pool display from `nodes[]` (live active/target
 * /enabled; a node ramped down to 0 shows enabled:false here).
 */
function trS3OnNode(evt) {
  if (Array.isArray(evt.nodes)) {
    trS3Nodes = evt.nodes;
    trS3RenderRuntimeNodes(evt.nodes);
  }
}

/**
 * Synthesize the session-completed state when every chapter is resolved
 * (completed or failed), then refresh controls (shows the 进入审校 button).
 */
function trS3MaybeSessionDone() {
  if (trS3Chapters.length === 0) return;
  var allDone = true;
  for (var i = 0; i < trS3Chapters.length; i++) {
    var s = trS3Chapters[i].status;
    if (s !== 'completed' && s !== 'failed') { allDone = false; break; }
  }
  if (allDone) trS3SessionStatus = 'completed';
  trS3UpdateControls();
}

/**
 * Reconcile the in-memory mirror from a GET /sessions/{id} snapshot. The
 * snapshot is authoritative for chapter status/cleaned and node runtime state.
 */
function trS3ReconcileFromSnapshot(snap) {
  if (!snap) return;
  if (typeof snap.status === 'string') trS3SessionStatus = snap.status;
  if (Array.isArray(snap.chapters)) {
    trS3Chapters = snap.chapters.map(function (c) {
      return {
        index: c.index,
        title: c.title,
        status: c.status,
        error: c.error || '',
        nodeId: c.nodeId || '',
        retry: c.retry || 0,
        cleaned: c.cleaned || ''
      };
    });
  }
  if (Array.isArray(snap.nodes)) trS3Nodes = snap.nodes;
}

function trS3RenderAll() {
  if (trState.sessionId) trS3RenderRuntimeNodes(trS3Nodes);
  trS3UpdateTabCounts();
  trS3RenderChapterList();
  trS3UpdateControls();
}

function trS3OnSessionGone() {
  // Session no longer exists on the backend (expired/restart). Close the ES,
  // surface cancelled state. trState.sessionId is kept so the user can re-run.
  if (trEventSource) { try { trEventSource.close(); } catch (_) {} trEventSource = null; }
  trS3SessionStatus = 'cancelled';
  trS3UpdateControls();
}

function trS3ScrolledToBottom(el) {
  // Treat "near bottom" (within 24px) as at-bottom so partial renders don't
  // fight a user who has scrolled up slightly.
  return (el.scrollHeight - el.scrollTop - el.clientHeight) < 24;
}

// ===================== cleanup =====================

/**
 * Close the SSE subscription only. Do NOT stop the backend session
 * (切页不丢: the task continues; re-entering Step3 re-subscribes via snapshot).
 * Called by text-review.js::cleanupTextReview on page leave.
 */
window.trCleanupStep3 = function () {
  if (trEventSource) {
    try { trEventSource.close(); } catch (_) {}
    trEventSource = null;
  }
  trS3NeedsReconcile = false;
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