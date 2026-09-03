// pg-image-batch.js — Image Batch Project workflow.
// This module deliberately keeps batch state in memory. The backend owns the
// task and manifest; leaving the page only closes EventSource.
(function (root) {
  'use strict';

  var STATUS = ['draft','planning','converting','review','queued','running','paused','stopping','completed','completed_with_errors','failed','canceled'];
  var VARIANT_STATUS = ['pending','running','retry_wait','succeeded','failed','interrupted','canceled'];
  var FORMAT = ['natural','tag','json'];
  function createDraft() {
    return { displayName: '', helperModel: '', imageModel: '', protocol: '', endpoint: '', requirements: '', format: 'natural', negativePrompt: '', quantity: 4, intervalMs: 0, maxRetries: 1, retryDelayMs: 1000, retryBackoff: 'fixed', onError: 'continue', seedMode: 'provider-controlled', baseSeed: 0, params: {}, customSystemPrompt: '', customUserPrompt: '', error: '', starting: false };
  }

  var DRAFT_KEY = 'tinylab.playground.imageBatchDraft.v1';
  // Executing-project reference: persisted so a refresh/re-entry can recover
  // the running batch. Only the project id is stored — never snapshot, trace
  // or credentials. Close/mode-switch preserves it; a genuinely new project
  // clears it.
  var ACTIVE_KEY = 'tinylab.playground.imageBatchActiveProject.v1';

  function saveActiveProject() {
    try {
      if (!state.projectId) return;
      localStorage.setItem(ACTIVE_KEY, JSON.stringify({ schemaVersion: 1, projectId: String(state.projectId), savedAt: Date.now() }));
    } catch (e) {}
  }

  function loadActiveProject() {
    try {
      var raw = localStorage.getItem(ACTIVE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || data.schemaVersion !== 1 || !data.projectId) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  function clearActiveProject() {
    try { localStorage.removeItem(ACTIVE_KEY); } catch (e) {}
  }

  var state = {
    uiMode: 'idle', // 'idle' | 'planning' | 'conversion' | 'review' | 'executing'
    stage: 1,
    projectId: null,
    snapshot: null,
    source: null,
    reconnectTimer: null,
    reconnecting: false,
    modal: false,
    draft: createDraft(),
    reconcileTimer: null,
    plan: null,
    transform: null,
    traces: { plan: null, transform: null, create: null },
    viewer: { prompt: 0, variant: 0 },
    previousLayout: null,
    draftRestored: false,
    events: [],
    error: ''
  };
  if (root.pgState && typeof root.pgState === 'object') root.pgState.imageBatch = state;
  root.pgImageBatch = state;

  function saveBatchDraft() {
    try {
      if (state.uiMode === 'idle' || state.uiMode === 'executing') return;
      var payload = {
        schemaVersion: 1,
        savedAt: Date.now(),
        stage: state.stage,
        uiMode: state.uiMode,
        draft: state.draft,
        plan: state.plan,
        transform: state.transform
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
    } catch (e) {}
  }

  function loadBatchDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || data.schemaVersion !== 1) {
        clearBatchDraft();
        return null;
      }
      return data;
    } catch (e) {
      clearBatchDraft();
      return null;
    }
  }

  function clearBatchDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  }

  function pgImageBatchSetLayout(n) {
    n = n === 2 ? 2 : 1;
    if (typeof root.pgState !== 'undefined') {
      root.pgState.splitCount = n;
      while (root.pgState.windows && root.pgState.windows.length < n) {
        if (typeof root.makeWin === 'function') {
          root.pgState.windows.push(root.makeWin());
        } else {
          break;
        }
      }
      root.pgState.activeWin = Math.min(root.pgState.activeWin || 0, n - 1);
    }
    if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
    if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar();
    if (typeof root.pgRenderInputBar === 'function') root.pgRenderInputBar();
  }

  function pgImageBatchExitUI(options) {
    options = options || {};
    state.uiMode = 'idle';
    if (!options.preserveProject && state.stage < 4) {
      clearBatchDraft();
    }
    if (state.previousLayout) {
      // Restore the captured Image layout only while still in Image mode;
      // restoring it into another mode would pollute that mode's layout.
      if (root.pgState && root.pgState.mode === 'image') {
        root.pgState.splitCount = state.previousLayout.splitCount;
        root.pgState.activeWin = state.previousLayout.activeWin;
        if (state.previousLayout.windows) root.pgState.windows = state.previousLayout.windows;
        if (state.previousLayout.modeWindowsImage && root.pgState.modeWindows) {
          root.pgState.modeWindows.image = state.previousLayout.modeWindowsImage;
        }
        if (state.previousLayout.modeSplitCountImage && root.pgState.modeSplitCounts) {
          root.pgState.modeSplitCounts.image = state.previousLayout.modeSplitCountImage;
        }
        if (state.previousLayout.inputMaximized != null) {
          root.pgState.inputMaximized = state.previousLayout.inputMaximized;
        }
      }
      state.previousLayout = null;
    }
    if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
    if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar();
    if (typeof root.pgRenderInputBar === 'function') root.pgRenderInputBar();
  }

  function pgImageBatchCancelDraft() {
    state.stage = 1;
    state.plan = null;
    state.transform = null;
    state.traces = { plan: null, transform: null, create: null };
    clearBatchDraft();
    pgImageBatchExitUI();
  }


  function esc(v) {
    if (typeof pgEscapeHtml === 'function') return pgEscapeHtml(v == null ? '' : String(v));
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); });
  }
  function tr(en, cn) {
    var lang = (document.documentElement && document.documentElement.getAttribute('data-lang')) || 'en';
    try { lang = localStorage.getItem('lang') || lang; } catch (e) {}
    return lang === 'cn' || lang === 'zh' ? cn : en;
  }
  function text(key) {
    var m = {
      title: ['Batch Project','批量项目'], planning: ['Planning','规划'], conversion: ['Format Conversion','格式转换'], review: ['Review & Start','检查并开始'], batchSingleWindow: ['Batch Project is available only with one Image window.','多窗口 Image 模式不支持批量项目。'],
      name: ['Project name','项目名称'], helper: ['Prompt helper model','提示词辅助模型'], imageModel: ['Image model','图片模型'], requirements: ['Image requirements','批量创作要求'], format: ['Output format','输出格式'], negative: ['Default negative prompt','默认负面提示词'], quantity: ['Default quantity','默认数量'],
      plan: ['Generate plan','生成规划'], transform: ['Transform','转换'], back: ['Back','返回'], next: ['Next','下一步'], start: ['Start','开始'], cancel: ['Cancel','取消'], close: ['Close','关闭'], add: ['Add item','添加项目'], remove: ['Delete','删除'], up: ['Up','上移'], down: ['Down','下移'], natural: ['Natural','自然语言'], tag: ['Tag','标签'], json: ['JSON','JSON'],
      status: ['Status','状态'], progress: ['Progress','进度'], directory: ['Project directory','项目目录'], interval: ['Interval (ms)','间隔（毫秒）'], retries: ['Max retries','最大重试'], retryDelay: ['Retry delay (ms)','重试延迟（毫秒）'], seedMode: ['Seed mode','Seed 策略'], baseSeed: ['Base seed','基础 Seed'], pause: ['Pause','暂停'], resume: ['Resume','继续'], stop: ['Stop','停止'], stopImmediate: ['Stop immediate','立即停止'], retry: ['Retry','重试'], previous: ['Previous','上一个'], nextImage: ['Next','下一个'], prevPrompt: ['Prev Prompt','上一 Prompt'], nextPrompt: ['Next Prompt','下一 Prompt'], noImage: ['No image yet','暂无图片'], projects: ['Projects','项目列表'], refresh: ['Refresh','刷新'], planningError: ['Planning returned an invalid item list.','规划返回的项目列表无效。'], invalid: ['Invalid response','响应格式无效'], helperRequired: ['Select a prompt helper model first.','请先选择提示词辅助模型。'], imageRequired: ['Select an image model first.','请先选择图片模型。'], requirementsRequired: ['Enter image requirements first.','请先输入批量创作要求。'], nameRequired: ['Project name is required.','项目名称不能为空。'], jsonInvalid: ['JSON prompt is invalid.','JSON 提示词无效。']
    };
    return m[key] ? tr(m[key][0], m[key][1]) : key;
  }
  function apiGet(path) { return (typeof pgApiGet === 'function' ? pgApiGet(path) : Promise.reject(new Error('API unavailable'))); }
  function apiPost(path, body) { return (typeof pgApiPost === 'function' ? pgApiPost(path, body) : Promise.reject(new Error('API unavailable'))); }
  function notify(msg, type) { if (typeof pgToast === 'function') pgToast(msg, type || 'error'); else if (typeof toast === 'function') toast(msg, type || 'error'); }
  function apiError(res) { return res && typeof res.error === 'string' ? res.error : text('invalid'); }
  function safeNum(v, fallback, min, max) { var n = Number(v); if (!isFinite(n)) n = fallback; if (min != null) n = Math.max(min, n); if (max != null) n = Math.min(max, n); return n; }
  function modelId(m) { return String((m && (m.id || m.model || m.name)) || ''); }
  function modelLabel(m) { return String((m && (m.label || m.alias || m.name || m.id || m.model)) || ''); }
  function models(kind) {
    var all = Array.isArray(root.pgState && pgState.models) ? pgState.models : [];
    return all.filter(function (m) {
      if (kind === 'text') {
        var k = String(m.kind || '').toLowerCase();
        return k !== 'image' && k !== 'embedding';
      }
      if (kind === 'image') return String(m.kind || '').toLowerCase() === 'image' || !!m.imgProtocol || String(m.protocol || '').toLowerCase() === 'comfyui';
      return true;
    });
  }
  function options(kind, selected) {
    var list = models(kind), html = '<option value="">—</option>';
    list.forEach(function (m) { var id = modelId(m); html += '<option value="' + esc(id) + '"' + (id === selected ? ' selected' : '') + '>' + esc(modelLabel(m)) + '</option>'; });
    return html;
  }
  function formatOptions(selected) { return FORMAT.map(function (f) { return '<option value="' + f + '"' + (f === selected ? ' selected' : '') + '>' + esc(text(f)) + '</option>'; }).join(''); }
  function field(label, id, value, type, attrs) { return '<label class="pg-batch-field"><span>' + esc(label) + '</span><input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(value) + '" ' + (attrs || '') + ' class="pg-input pg-batch-text-input"></label>'; }
  function area(label, id, value) { return '<label class="pg-batch-field pg-batch-area-field"><span>' + esc(label) + '</span><textarea id="' + id + '" rows="3" class="pg-input pg-batch-area-input">' + esc(value) + '</textarea></label>'; }
  function button(label, fn, disabled, cls) { return '<button type="button" class="pg-btn pg-batch-action-btn ' + (cls || '') + '" onclick="' + fn + '()"' + (disabled ? ' disabled' : '') + '>' + esc(label) + '</button>'; }
  function modal(html) { if (typeof pgShowModal === 'function') pgShowModal(html); else { var o = document.getElementById('pg-modal-overlay'); if (o) { o.innerHTML = '<div class="pg-modal">' + html + '</div>'; o.classList.add('show'); } } }
  function closeModal() { state.modal = false; if (typeof pgCloseModal === 'function') pgCloseModal(); }
  function restoreCreateModal() { state.modal = true; renderCreate(); }
  function readDraft() {
    var g = function (id) { return document.getElementById(id); }, v = function (id, fallback) { var e = g(id); return e ? e.value : fallback; };
    state.draft.displayName = String(v('pg-img-batch-name', state.draft.displayName)).trim();
    var w = typeof pgWin === 'function' ? pgWin() : null;
    if (w && w.config) {
      state.draft.helperModel = w.config.imgPromptModel || state.draft.helperModel || '';
      var effectiveProtocol = typeof pgEffectiveProtocol === 'function' ? pgEffectiveProtocol(w.config) : '';
      state.draft.protocol = effectiveProtocol || (typeof pgGetImgProtocol === 'function' ? (pgGetImgProtocol(w.config.model) || '') : (state.draft.protocol || ''));
      state.draft.imageModel = w.config.model || (state.draft.protocol === 'comfyui' ? 'comfyui' : state.draft.imageModel || '');
      state.draft.endpoint = state.draft.protocol === 'comfyui' ? 'comfyui' : (w.config.imgEndpoint || state.draft.endpoint || '');
      state.draft.params = {};
      var paramMap = { imgSize: 'size', imgQuality: 'quality', imgBackground: 'background', imgModeration: 'moderation', imgAspectRatio: 'aspect_ratio', imgResolution: 'resolution', imgN: 'n', imgResponseFormat: 'response_format', imgOutputFormat: 'output_format', imgOutputCompression: 'output_compression', imgUser: 'user', imgNegativePrompt: 'negative_prompt', imgSteps: 'steps', imgGuidance: 'guidance', imgSeed: 'seed' };
      Object.keys(paramMap).forEach(function (key) {
        if (w.config[key] !== '' && w.config[key] !== 0 && w.config[key] != null) state.draft.params[paramMap[key]] = w.config[key];
      });
      if (state.draft.protocol === 'comfyui') {
        state.draft.params.port = parseInt(w.config.imgComfyPort, 10) || 8188;
        if (w.config.imgComfyWorkflow && typeof w.config.imgComfyWorkflow === 'object') state.draft.params.workflow = w.config.imgComfyWorkflow;
      }
    }
    state.draft.requirements = String(v('pg-img-batch-requirements', state.draft.requirements)).trim();
    state.draft.format = String(v('pg-img-batch-format', state.draft.format));
    state.draft.negativePrompt = String(v('pg-img-batch-negative', state.draft.negativePrompt));
    state.draft.quantity = safeNum(v('pg-img-batch-quantity', state.draft.quantity), 4, 1, 100);
    state.draft.intervalMs = safeNum(v('pg-img-batch-interval', state.draft.intervalMs), 0, 0, 86400000);
    state.draft.maxRetries = safeNum(v('pg-img-batch-retries', state.draft.maxRetries), 1, 0, 20);
    state.draft.retryDelayMs = safeNum(v('pg-img-batch-retry-delay', state.draft.retryDelayMs), 1000, 0, 86400000);
    state.draft.retryBackoff = String(v('pg-img-batch-backoff', state.draft.retryBackoff || 'fixed'));
    state.draft.seedMode = String(v('pg-img-batch-seed-mode', state.draft.seedMode));
    state.draft.baseSeed = safeNum(v('pg-img-batch-base-seed', state.draft.baseSeed), 0, 0, 2147483647);
  }
  root.pgStepBatchInput = function (id, delta, min, max) {
    var el = document.getElementById(id);
    if (!el) return;
    var val = Number(el.value) || 0;
    val += delta;
    if (min != null) val = Math.max(min, val);
    if (max != null) val = Math.min(max, val);
    el.value = val;
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
  };

  function renderBatchCustomSelect(wrapId, selId, optsList, value) {
    if (typeof pgRenderCustomSelect === 'function') {
      return pgRenderCustomSelect(wrapId, selId, optsList, value, '', 'width:100%;height:36px');
    }
    var options = optsList.map(function(o) { return '<option value="' + esc(o.value) + '"' + (o.value === value ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('');
    return '<select id="' + selId + '" class="pg-select" style="width:100%;height:36px">' + options + '</select>';
  }

  function renderBatchStepper(id, value, min, max, step, onchange) {
    step = step || 1;
    var v = safeNum(value, 0, min, max);
    var changeAttr = onchange ? ' onchange="' + onchange + '"' : '';
    return '<div class="number-stepper pg-batch-stepper" style="width:100%;height:36px;box-sizing:border-box">' +
      '<button type="button" class="stepper-btn stepper-minus" onclick="pgStepBatchInput(\'' + id + '\', -' + step + ', ' + (min != null ? min : 'null') + ', ' + (max != null ? max : 'null') + ')">-</button>' +
      '<input type="number" id="' + id + '" class="stepper-input" min="' + (min != null ? min : '') + '" max="' + (max != null ? max : '') + '" value="' + v + '"' + changeAttr + ' style="height:100%">' +
      '<button type="button" class="stepper-btn stepper-plus" onclick="pgStepBatchInput(\'' + id + '\', ' + step + ', ' + (min != null ? min : 'null') + ', ' + (max != null ? max : 'null') + ')">+</button>' +
    '</div>';
  }

  function renderTraceBox(trace, title) {
    if (!trace) {
      return '<div class="pg-batch-inline-pane"><div class="pg-batch-debug-box" style="padding:16px;color:var(--text-secondary);font-size:12px"><em>' + esc(title || 'Request Trace') + ' — ' + esc(tr('Waiting for request...','等待请求...')) + '</em></div></div>';
    }
    var statusCls = trace.loading ? 'loading' : (trace.error || (trace.responseStatus && trace.responseStatus >= 400) ? 'error' : 'success');
    var statusText = trace.loading ? tr('Sending request...','请求中...') : (trace.responseStatus ? ('HTTP ' + trace.responseStatus + ' (' + trace.durationMs + 'ms)') : (trace.error || 'Done'));
    var reqBodyStr = typeof trace.requestBody === 'string' ? trace.requestBody : JSON.stringify(trace.requestBody || {}, null, 2);
    var respBodyStr = trace.responseRawBody || (typeof trace.responseBody === 'string' ? trace.responseBody : JSON.stringify(trace.responseBody || {}, null, 2));

    return '<div class="pg-batch-inline-pane">' +
      '<div class="pg-batch-debug-box">' +
        '<div class="pg-batch-debug-head">' +
          '<span>' + esc(title || 'Request Trace') + '</span>' +
          '<span class="pg-batch-trace-status ' + statusCls + '">' + esc(statusText) + '</span>' +
        '</div>' +
        '<div class="pg-batch-debug-body">' +
          '<details open><summary style="font-weight:600;cursor:pointer;margin-bottom:4px">Request Details (' + esc(trace.method) + ' ' + esc(trace.url) + ')</summary>' +
            '<div style="margin-left:8px;margin-bottom:8px"><strong>Request Headers:</strong><pre>' + esc(JSON.stringify(trace.requestHeaders || {}, null, 2)) + '</pre></div>' +
            '<div style="margin-left:8px"><strong>Request Body:</strong><pre>' + esc(reqBodyStr) + '</pre></div>' +
          '</details>' +
          '<details open style="margin-top:8px"><summary style="font-weight:600;cursor:pointer;margin-bottom:4px">Response Details</summary>' +
            (trace.responseHeaders ? '<div style="margin-left:8px;margin-bottom:8px"><strong>Response Headers:</strong><pre>' + esc(JSON.stringify(trace.responseHeaders, null, 2)) + '</pre></div>' : '') +
            '<div style="margin-left:8px"><strong>Response Body:</strong><pre>' + esc(respBodyStr || '(no body)') + '</pre></div>' +
          '</details>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  root.pgImageBatchInspectPrompts = function () {
    readDraft();
    var d = state.draft;
    var defaultSys = "Return raw JSON only. No code blocks, no backticks, no explanations. Start with { and end with }. Preserve the user's subject and intent.";
    var sysPrompt = d.customSystemPrompt || defaultSys;
    var defaultUser = "Create a JSON image plan for these requirements: " + (d.requirements || '[批量创作要求]') + "\nUse this as the default negative prompt unless an item specifies otherwise: " + (d.negativePrompt || '[默认负面提示词]') + "\nDefault quantity: " + d.quantity + "\nReturn {\"title\":string,\"items\":[{\"id\":unique alphanumeric string (max 128 chars)\",\"title\":string,\"naturalPrompt\":string,\"negativePrompt\":string,\"quantity\":integer 1-100}]}";
    var reqPrompt = d.customUserPrompt || defaultUser;

    var html = '<div class="pg-modal-header"><span class="pg-modal-title">🔍 Prompt 模版与透明度（可查看并修改）</span><button type="button" class="pg-modal-close" onclick="closeModal()">✕</button></div>' +
      '<div class="pg-modal-body" style="max-height:72vh;overflow:auto;font-size:12px;line-height:1.6;position:relative">' +
        '<label style="font-weight:600;display:block;margin-bottom:4px;color:var(--text)">Helper Model System Prompt（系统指令，可编辑修改）</label>' +
        '<textarea id="pg-inspect-sys-prompt" class="pg-input" style="width:100%;height:70px;font-family:monospace;font-size:12px;margin-bottom:12px;box-sizing:border-box">' + esc(sysPrompt) + '</textarea>' +
        '<label style="font-weight:600;display:block;margin-bottom:4px;color:var(--text)">Prompt Helper 实际发出的 User Prompt 组合内容（可编辑修改）</label>' +
        '<textarea id="pg-inspect-user-prompt" class="pg-input" style="width:100%;height:110px;font-family:monospace;font-size:12px;margin-bottom:14px;box-sizing:border-box">' + esc(reqPrompt) + '</textarea>' +
        '<div style="display:flex;justify-content:flex-end;gap:10px">' +
          '<button type="button" class="pg-btn pg-btn-primary" onclick="pgImageBatchSavePrompts()" style="height:38px;padding:0 22px;font-size:13px;font-weight:600">保存并应用</button>' +
        '</div>' +
      '</div>';
    modal(html);
  };

  root.pgImageBatchSavePrompts = function () {
    var sysEl = document.getElementById('pg-inspect-sys-prompt');
    var userEl = document.getElementById('pg-inspect-user-prompt');
    if (sysEl) state.draft.customSystemPrompt = sysEl.value;
    if (userEl) state.draft.customUserPrompt = userEl.value;
    notify('Prompt 模版自定义已更新', 'info');
    closeModal();
    saveBatchDraft();
    if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
  };

  function planningPaneHtml() {
    var d = state.draft;
    var formatOpts = [
      { value: 'natural', label: text('natural') },
      { value: 'tag', label: text('tag') },
      { value: 'json', label: text('json') }
    ];
    var backoffOpts = [
      { value: 'fixed', label: 'fixed' },
      { value: 'exponential', label: 'exponential' },
      { value: 'exponential-jitter', label: 'exponential-jitter' }
    ];
    var seedOpts = [
      { value: 'random', label: 'random' },
      { value: 'increment', label: 'increment' },
      { value: 'fixed-base-plus-offset', label: 'fixed-base-plus-offset' },
      { value: 'provider-controlled', label: 'provider-controlled' }
    ];

    return '<div class="pg-batch-inline-pane">' +
      '<div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">' +
        '<h3 style="margin:0;font-size:15px;color:var(--text)">' + esc(text('planning')) + '</h3>' +
        '<button type="button" class="pg-btn" onclick="pgImageBatchInspectPrompts()" style="font-size:11px;padding:3px 8px">🔍 ' + esc(tr('Inspect Prompt Template','查看/修改 Prompt 模版')) + '</button>' +
      '</div>' +
      field(text('name'), 'pg-img-batch-name', d.displayName) +
      area(text('requirements'), 'pg-img-batch-requirements', d.requirements) +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 10px;margin:8px 0;align-items:end">' +
        '<label style="font-size:12px;display:flex;flex-direction:column;gap:6px;color:var(--text-secondary)">' + esc(text('format')) + renderBatchCustomSelect('pg-img-batch-format-wrap', 'pg-img-batch-format', formatOpts, d.format) + '</label>' +
        '<label style="font-size:12px;display:flex;flex-direction:column;gap:6px;color:var(--text-secondary)">' + esc(text('quantity')) + renderBatchStepper('pg-img-batch-quantity', d.quantity, 1, 100, 1) + '</label>' +
      '</div>' +
      area(text('negative'), 'pg-img-batch-negative', d.negativePrompt) +
      '<details class="pg-img-batch-scheduler" style="margin-top:12px"><summary style="font-size:12px;font-weight:600;color:var(--text-secondary);cursor:pointer;user-select:none;margin-bottom:8px">▼ ' + esc(tr('Scheduler settings','调度设置')) + '</summary>' +
        '<div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px 10px;margin-top:8px;align-items:end">' +
          '<label style="font-size:12px;display:flex;flex-direction:column;gap:6px;color:var(--text-secondary)">' + esc(text('interval')) + renderBatchStepper('pg-img-batch-interval', d.intervalMs, 0, 86400000, 100) + '</label>' +
          '<label style="font-size:12px;display:flex;flex-direction:column;gap:6px;color:var(--text-secondary)">' + esc(text('retries')) + renderBatchStepper('pg-img-batch-retries', d.maxRetries, 0, 20, 1) + '</label>' +
          '<label style="font-size:12px;display:flex;flex-direction:column;gap:6px;color:var(--text-secondary)">' + esc(text('retryDelay')) + renderBatchStepper('pg-img-batch-retry-delay', d.retryDelayMs, 0, 86400000, 500) + '</label>' +
          '<label style="font-size:12px;display:flex;flex-direction:column;gap:6px;color:var(--text-secondary)">Backoff' + renderBatchCustomSelect('pg-img-batch-backoff-wrap', 'pg-img-batch-backoff', backoffOpts, d.retryBackoff || 'fixed') + '</label>' +
          '<label style="font-size:12px;display:flex;flex-direction:column;gap:6px;color:var(--text-secondary)">' + esc(text('seedMode')) + renderBatchCustomSelect('pg-img-batch-seed-mode-wrap', 'pg-img-batch-seed-mode', seedOpts, d.seedMode) + '</label>' +
          '<label style="font-size:12px;display:flex;flex-direction:column;gap:6px;color:var(--text-secondary)">' + esc(text('baseSeed')) + renderBatchStepper('pg-img-batch-base-seed', d.baseSeed, 0, 2147483647, 1) + '</label>' +
        '</div>' +
      '</details>' +
      '<div id="pg-img-batch-error" style="color:var(--danger);min-height:18px;margin-top:6px">' + esc(state.draft.error || '') + '</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">' +
        button(text('cancel'), 'pgImageBatchCancelDraft') +
        button(text('plan'), 'pgImageBatchPlan', false, 'pg-btn-primary') +
      '</div>' +
    '</div>';
  }

  function setError(msg) {
    state.draft.error = msg || '';
    var e = document.getElementById('pg-img-batch-error');
    if (e) e.textContent = msg || '';
    else if (msg) notify(msg, 'error');
  }

  function validatePlan(raw) {
    var p = raw && raw.plan ? raw.plan : raw;
    if (!p || !Array.isArray(p.items) || !p.items.length) throw new Error(text('planningError'));
    var ids = {};
    p.items = p.items.map(function (item, i) {
      if (!item || typeof item !== 'object') throw new Error(text('planningError'));
      var id = String(item.id || ('p' + String(i + 1).padStart(4, '0')));
      var natural = String(item.naturalPrompt || '').trim();
      var qty = safeNum(item.quantity, state.draft.quantity, 1, 100);
      if (ids[id] || !natural || Math.floor(qty) !== qty) throw new Error(text('planningError'));
      ids[id] = true;
      return { id: id, index: i, title: String(item.title || id), naturalPrompt: natural, negativePrompt: String(item.negativePrompt != null ? item.negativePrompt : state.draft.negativePrompt), finalFormat: state.draft.format, finalPrompt: natural, finalPromptObject: null, quantity: qty, variants: Array.isArray(item.variants) ? item.variants : [] };
    });
    return { title: String(p.title || state.draft.displayName), items: p.items };
  }

  function pgImageBatchPlan() {
    readDraft(); setError('');
    if (!state.draft.displayName) return setError(text('nameRequired'));
    if (!state.draft.helperModel) return setError(text('helperRequired'));
    if (!state.draft.imageModel) return setError(text('imageRequired'));
    if (!state.draft.requirements) return setError(text('requirementsRequired'));
    saveBatchDraft();

    var payload = {
      helperModel: state.draft.helperModel,
      requirements: state.draft.requirements,
      defaultNegativePrompt: state.draft.negativePrompt,
      defaultQuantity: state.draft.quantity,
      customSystemPrompt: state.draft.customSystemPrompt,
      customUserPrompt: state.draft.customUserPrompt
    };

    var postFn = typeof apiPostTrace === 'function' ? apiPostTrace : function (path, body, signal, hooks) {
      if (hooks && hooks.onRequest) hooks.onRequest({ method: 'POST', url: path, requestHeaders: {}, requestBody: body, loading: true });
      return apiPost(path, body).then(function (res) {
        if (hooks && hooks.onResponse) hooks.onResponse({ method: 'POST', url: path, requestHeaders: {}, requestBody: body, responseStatus: 200, responseBody: res, loading: false });
        return res;
      });
    };

    postFn('/image-batches/plan', payload, null, {
      onRequest: function (trace) {
        state.traces.plan = trace;
        if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
      },
      onResponse: function (trace) {
        state.traces.plan = trace;
        if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
      }
    }).then(function (res) {
      if (!res || res.error) throw new Error(apiError(res));
      state.plan = validatePlan(res);
      state.uiMode = 'conversion';
      state.stage = 2;
      saveBatchDraft();
      pgImageBatchSetLayout(2);
    }).catch(function (e) {
      setError(e.message || text('planningError'));
      if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
    });
  }

  function editPlan(index, prop, value) {
    if (!state.plan || !state.plan.items[index]) return;
    var it = state.plan.items[index];
    if (prop === 'quantity') it.quantity = safeNum(value, it.quantity, 1, 100);
    else it[prop] = String(value);
    saveBatchDraft();
  }

  function renderPlanItems() {
    return state.plan.items.map(function (it, i) {
      var itemStepper = renderBatchStepper('pg-item-qty-' + i, it.quantity, 1, 100, 1, 'pgImageBatchEditItem(' + i + ',\'quantity\',this.value)');
      return '<div class="pg-batch-plan-item" data-plan-index="' + i + '">' +
        '<div class="pg-batch-plan-head">' +
          '<span class="pg-batch-plan-id">' + esc(it.id) + '</span>' +
          '<input class="pg-input pg-batch-title-input" value="' + esc(it.title) + '" onchange="pgImageBatchEditItem(' + i + ',\'title\',this.value)">' +
          '<button type="button" class="pg-btn pg-batch-icon-btn" onclick="pgImageBatchMove(' + i + ',-1)" data-tooltip="上移">↑</button>' +
          '<button type="button" class="pg-btn pg-batch-icon-btn" onclick="pgImageBatchMove(' + i + ',1)" data-tooltip="下移">↓</button>' +
          '<button type="button" class="pg-btn danger pg-batch-icon-btn" onclick="pgImageBatchDelete(' + i + ')" data-tooltip="删除">✕</button>' +
        '</div>' +
        '<textarea class="pg-input pg-batch-prompt-input" rows="3" onchange="pgImageBatchEditItem(' + i + ',\'naturalPrompt\',this.value)">' + esc(it.naturalPrompt) + '</textarea>' +
        '<div class="pg-batch-plan-foot">' +
          '<div class="pg-batch-quantity-field"><span>' + esc(text('quantity')) + '</span><div class="pg-batch-quantity-stepper">' + itemStepper + '</div></div>' +
          '<input class="pg-input pg-batch-negative-input" placeholder="' + esc(text('negative')) + '" value="' + esc(it.negativePrompt) + '" onchange="pgImageBatchEditItem(' + i + ',\'negativePrompt\',this.value)">' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function conversionPaneHtml() {
    return '<div class="pg-batch-inline-pane">' +
      '<div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">' +
        '<h3 style="margin:0;font-size:15px;color:var(--text)">' + esc(text('conversion')) + '</h3>' +
      '</div>' +
      '<p style="font-size:12px;color:var(--text-secondary);margin-bottom:10px">' + esc(text('planning')) + ': <strong style="color:var(--text)">' + esc(state.plan ? state.plan.title : '') + '</strong></p>' +
      '<div id="pg-img-batch-items">' + (state.plan ? renderPlanItems() : '') + '</div>' +
      '<div style="display:flex;justify-content:space-between;gap:10px;margin-top:16px">' +
        button(text('add'), 'pgImageBatchAddItem') +
        '<div style="display:flex;gap:10px">' +
          '<button type="button" class="pg-btn" onclick="pgImageBatchStage(1)" style="height:38px;padding:0 20px;font-size:13px;font-weight:600">' + esc(text('back')) + '</button>' +
          '<button type="button" class="pg-btn pg-btn-primary" onclick="pgImageBatchTransform()" style="height:38px;padding:0 20px;font-size:13px;font-weight:600">' + esc(text('transform')) + '</button>' +
        '</div>' +
      '</div>' +
      '<div id="pg-img-batch-error" style="color:var(--danger);min-height:18px;margin-top:6px">' + esc(state.draft.error || '') + '</div>' +
      (state.traces.transform ? renderTraceBox(state.traces.transform, '2. Transform Request Log') : '') +
    '</div>';
  }

  function conversionPreviewPaneHtml() {
    return '<div class="pg-batch-inline-pane">' +
      '<h3 style="margin:0 0 12px 0;font-size:15px;color:var(--text)">' + esc(tr('Conversion Items Preview','转换项目预览')) + '</h3>' +
      '<div id="pg-img-batch-items">' + (state.plan ? renderPlanItems() : '') + '</div>' +
    '</div>';
  }

  function transformItems(raw) {
    var source = raw && Array.isArray(raw.items) ? raw.items : (Array.isArray(raw) ? raw : null);
    if (!source || source.length !== state.plan.items.length) throw new Error(text('invalid'));
    return state.plan.items.map(function (it, i) {
      var x = source[i] || {};
      var out = Object.assign({}, it);
      out.index = i + 1;
      out.finalFormat = state.draft.format;
      out.finalPrompt = String(x.finalPrompt != null ? x.finalPrompt : it.naturalPrompt);
      out.finalPromptObject = x.finalPromptObject != null ? x.finalPromptObject : null;
      if (!String(out.finalPrompt).trim()) {
        out._invalid = true;
      } else if (out.finalFormat === 'json') {
        try {
          var o = out.finalPromptObject;
          if (!o || typeof o === 'string') o = JSON.parse(out.finalPrompt);
          out.finalPromptObject = o;
          if (!o || typeof o !== 'object' || !o.subject) out._invalid = true;
        } catch (e) {
          out._invalid = true;
        }
      } else if (out.finalFormat === 'tag') {
        var fp = String(out.finalPrompt);
        if (/^[\s]*[[{]/.test(fp) || /[\r\n]/.test(fp)) out._invalid = true;
      }
      return out;
    });
  }

  function pgImageBatchTransform() {
    readDraft();
    var items = state.plan.items.map(function (x, i) {
      return { id: x.id, index: i + 1, title: x.title, naturalPrompt: x.naturalPrompt, finalFormat: state.draft.format, finalPrompt: x.naturalPrompt, negativePrompt: x.negativePrompt, quantity: x.quantity, variants: [] };
    });
    setError('');
    if (state.draft.format === 'natural') {
      state.transform = items;
      state.uiMode = 'review';
      state.stage = 3;
      saveBatchDraft();
      pgImageBatchSetLayout(2);
      return;
    }
    var payload = { helperModel: state.draft.helperModel, format: state.draft.format, items: items };

    var postFn = typeof apiPostTrace === 'function' ? apiPostTrace : function (path, body, signal, hooks) {
      if (hooks && hooks.onRequest) hooks.onRequest({ method: 'POST', url: path, requestHeaders: {}, requestBody: body, loading: true });
      return apiPost(path, body).then(function (res) {
        if (hooks && hooks.onResponse) hooks.onResponse({ method: 'POST', url: path, requestHeaders: {}, requestBody: body, responseStatus: 200, responseBody: res, loading: false });
        return res;
      });
    };

    postFn('/image-batches/transform', payload, null, {
      onRequest: function (trace) {
        state.traces.transform = trace;
        if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
      },
      onResponse: function (trace) {
        state.traces.transform = trace;
        if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
      }
    }).then(function (res) {
      if (!res || res.error) throw new Error(apiError(res));
      state.transform = transformItems(res);
      state.draft.error = '';
      state.uiMode = 'review';
      state.stage = 3;
      saveBatchDraft();
      pgImageBatchSetLayout(2);
    }).catch(function (e) {
      setError(e.message || text('invalid'));
      if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
    });
  }

  function reviewPaneHtml() {
    var items = state.transform || (state.plan ? state.plan.items : []);
    var total = items.reduce(function (n, x) { return n + safeNum(x.quantity, 0, 0, 100); }, 0);
    var invalid = items.some(function (x) { return x._invalid || !x.finalPrompt || (x.finalFormat === 'json' && !x.finalPromptObject); });
    var err = state.draft.error || '';
    return '<div class="pg-batch-inline-pane">' +
      '<h3 style="margin:0 0 12px 0;font-size:15px;color:var(--text)">' + esc(text('review')) + '</h3>' +
      '<div class="pg-batch-summary"><div>' + esc(text('name')) + ': <strong>' + esc(state.draft.displayName) + '</strong></div><div>Prompt count: ' + items.length + ' · Total variants: ' + total + ' · Maximum attempts: ' + (total * (1 + state.draft.maxRetries)) + '</div><div>' + esc(text('imageModel')) + ': ' + esc(state.draft.imageModel) + ' · ' + esc(text('helper')) + ': ' + esc(state.draft.helperModel) + '</div><div>' + esc(text('interval')) + ': ' + state.draft.intervalMs + ' · ' + esc(text('retries')) + ': ' + state.draft.maxRetries + ' · ' + esc(text('seedMode')) + ': ' + esc(state.draft.seedMode) + '</div></div>' +
      '<div class="pg-batch-review-items">' + items.map(function (it) { return '<div class="pg-batch-review-item"><strong>' + esc(it.title) + '</strong> × ' + esc(it.quantity) + '<div>' + esc(it.finalPrompt) + '</div>' + (it._invalid ? '<div class="pg-batch-error">' + esc(text('jsonInvalid')) + '</div>' : '') + '</div>'; }).join('') + '</div>' +
      (err ? '<div class="pg-batch-error pg-batch-error-box">' + esc(err) + '</div>' : '<div class="pg-batch-error-box"></div>') +
      '<div class="pg-batch-footer"><button type="button" class="pg-btn pg-batch-action-btn" onclick="pgImageBatchStage(2)">' + esc(text('back')) + '</button><button type="button" class="pg-btn pg-btn-primary pg-batch-action-btn" onclick="pgImageBatchStart()"' + (invalid || state.draft.starting ? ' disabled' : '') + '>' + esc(state.draft.starting ? 'Starting…' : text('start')) + '</button></div>' +
      (state.traces.create ? renderTraceBox(state.traces.create, '3. Create Request Log') : '') +
    '</div>';
  }

  function pgImageBatchStage(n) {
    if (n === 1) readDraft();
    state.stage = n;
    state.uiMode = n === 1 ? 'planning' : (n === 2 ? 'conversion' : (n === 3 ? 'review' : 'executing'));
    saveBatchDraft();
    pgImageBatchSetLayout(n === 4 ? 1 : 2);
  }

  function pgImageBatchEditItem(i, prop, value) { editPlan(i, prop, value); }
  function pgImageBatchMove(i, delta) { if (!state.plan || i + delta < 0 || i + delta >= state.plan.items.length) return; var a = state.plan.items; var x = a.splice(i, 1)[0]; a.splice(i + delta, 0, x); a.forEach(function (v, n) { v.index = n; }); saveBatchDraft(); if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes(); }
  function pgImageBatchDelete(i) { if (!state.plan || state.plan.items.length <= 1) return; state.plan.items.splice(i, 1); saveBatchDraft(); if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes(); }
  function pgImageBatchAddItem() { if (!state.plan) return; state.plan.items.push({ id: 'p' + String(state.plan.items.length + 1).padStart(4, '0'), index: state.plan.items.length, title: 'New item', naturalPrompt: '', negativePrompt: state.draft.negativePrompt, finalFormat: state.draft.format, finalPrompt: '', finalPromptObject: null, quantity: state.draft.quantity, variants: [] }); saveBatchDraft(); if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes(); }

  function pgImageBatchStart() {
    if (state.draft.starting) return;
    readDraft();
    state.draft.error = '';
    var source = state.transform || (state.plan ? state.plan.items : []);
    var items = source.map(function (it, i) {
      var x = Object.assign({}, it);
      delete x._invalid;
      x.index = i + 1;
      x.finalFormat = x.finalFormat || state.draft.format;
      x.finalPrompt = x.finalPrompt || x.naturalPrompt;
      x.variants = [];
      return x;
    });
    if (!items.length || items.some(function (x) { return !String(x.finalPrompt || '').trim(); })) {
      state.draft.error = 'Every prompt must contain a final prompt.';
      if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
      return;
    }
    var slugBase = state.draft.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'image-batch';
    var slug = slugBase + '-' + Date.now().toString(36);
    var body = {
      schemaVersion: 1,
      displayName: state.draft.displayName,
      slug: slug,
      promptPlan: { helperModel: state.draft.helperModel, sourceRequirement: state.draft.requirements, outputFormat: state.draft.format, planVersion: 1, transformVersion: 1 },
      prompts: items,
      imageConfig: { model: state.draft.imageModel, protocol: state.draft.protocol || 'gpt', endpoint: state.draft.endpoint, params: state.draft.params },
      batchConfig: { intervalMs: state.draft.intervalMs, maxRetries: state.draft.maxRetries, retryDelayMs: state.draft.retryDelayMs, retryBackoff: state.draft.retryBackoff, onError: state.draft.onError, seedMode: state.draft.seedMode, baseSeed: state.draft.baseSeed }
    };
    state.draft.starting = true;
    if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();

    var postFn = typeof apiPostTrace === 'function' ? apiPostTrace : function (path, body, signal, hooks) {
      if (hooks && hooks.onRequest) hooks.onRequest({ method: 'POST', url: path, requestHeaders: {}, requestBody: body, loading: true });
      return apiPost(path, body).then(function (res) {
        if (hooks && hooks.onResponse) hooks.onResponse({ method: 'POST', url: path, requestHeaders: {}, requestBody: body, responseStatus: 200, responseBody: res, loading: false });
        return res;
      });
    };

    postFn('/image-batches', body, null, {
      onRequest: function (trace) {
        state.traces.create = trace;
        if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
      },
      onResponse: function (trace) {
        state.traces.create = trace;
        if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
      }
    }).then(function (res) {
      if (!res || res.error || !res.projectId) throw new Error(apiError(res));
      state.projectId = String(res.projectId);
      // Create succeeded: persist the executing-project reference right away,
      // before the snapshot fetch, so a refresh can recover even if that GET
      // fails transiently. Only the project id is stored.
      saveActiveProject();
      state.snapshot = res.snapshot || null;
      return state.snapshot ? Promise.resolve(state.snapshot) : pgImageBatchSnapshot(state.projectId);
    }).then(function (snap) {
      if (!snap) throw new Error(text('invalid'));
      applySnapshot(snap);
      state.draft.starting = false;
      state.uiMode = 'executing';
      state.stage = 4;
      clearBatchDraft();
      pgImageBatchSetLayout(1);
      openEvents();
    }).catch(function (e) {
      state.draft.starting = false;
      state.draft.error = e.message || text('invalid');
      if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
    });
  }

  function normalizeSnapshot(raw) { var s = raw && raw.snapshot ? raw.snapshot : raw; if (!s || typeof s !== 'object' || !Array.isArray(s.prompts || s.items || [])) throw new Error(text('invalid')); if (!s.prompts) s.prompts = s.items; s.prompts = s.prompts.map(function (p, i) { p = Object.assign({}, p); p.id = String(p.id || ('p' + String(i + 1).padStart(4, '0'))); p.variants = Array.isArray(p.variants) ? p.variants : []; p.quantity = safeNum(p.quantity, p.variants.length || 1, 1, 100); p.variants = p.variants.map(function (v, n) { v = Object.assign({}, v); v.id = String(v.id || ('v' + String(n + 1).padStart(4, '0'))); v.status = VARIANT_STATUS.indexOf(v.status) >= 0 ? v.status : 'pending'; return v; }); return p; }); s.status = STATUS.indexOf(s.status) >= 0 ? s.status : String(s.status || 'draft'); s.stats = s.stats && typeof s.stats === 'object' ? s.stats : {}; s.schedulerCursor = s.schedulerCursor || null; return s; }
  function applySnapshot(raw) { try { state.snapshot = normalizeSnapshot(raw); if (state.snapshot.projectId) state.projectId = String(state.snapshot.projectId); } catch (e) { notify(e.message || text('invalid'), 'error'); } }
  function pgImageBatchSnapshot(id) { return apiGet('/image-batches/' + encodeURIComponent(id)).then(function (res) { if (!res || res.error) throw new Error(apiError(res)); var s = normalizeSnapshot(res); applySnapshot(s); return s; }); }
  function control(path, body) {
    if (!state.projectId) return;
    apiPost('/image-batches/' + encodeURIComponent(state.projectId) + '/' + path, body || {}).then(function (res) {
      if (!res || res.error) throw new Error(apiError(res));
      applySnapshot(res);
      if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
      if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar();
    }).catch(function (e) { notify(e.message || text('invalid'), 'error'); });
  }

  function pgImageBatchRefresh() {
    if (!state.projectId) return Promise.resolve(null);
    return pgImageBatchSnapshot(state.projectId).then(function (snap) {
      if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
      if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar();
      openEvents();
      return snap;
    }).catch(function (e) { notify(e.message || text('invalid'), 'error'); return null; });
  }

  function projectStatus(s) { return s && s.status ? s.status : 'draft'; }
  function progress(s) { var st = s && s.stats || {}, done = Number(st.completed != null ? st.completed : st.succeeded != null ? st.succeeded : 0), total = Number(st.total != null ? st.total : 0); if (!total && s && s.prompts) total = s.prompts.reduce(function (n, p) { return n + Number(p.quantity || (p.variants || []).length || 0); }, 0); return { done: isFinite(done) ? done : 0, total: isFinite(total) ? total : 0 }; }
  function assetUrl(p, v) { var a = v && (v.asset || v.assets && v.assets[0]); var id = v && (v.assetId || v.id && a && a.id); if (id && state.projectId) return '/api/image-batches/' + encodeURIComponent(state.projectId) + '/assets/' + encodeURIComponent(id); var u = a && (a.url || a.path); if (typeof u === 'string' && (/^\/api\//.test(u) || /^https?:\/\//.test(u))) return u; return ''; }
  function rememberEvent(d) {
    if (!d || !d.type) return;
    state.events.push({ type: String(d.type), at: d.at || new Date().toISOString(), promptId: d.promptId || '', variantId: d.variantId || '', data: d.data == null ? '' : String(typeof d.data === 'string' ? d.data : JSON.stringify(d.data)) });
    if (state.events.length > 100) state.events.shift();
  }

  function viewerItem(s) {
    var ps = s && s.prompts || [];
    if (!ps.length) return null;
    state.viewer.prompt = Math.max(0, Math.min(state.viewer.prompt, ps.length - 1));
    var p = ps[state.viewer.prompt];
    var vs = p.variants || [];
    state.viewer.variant = Math.max(0, Math.min(state.viewer.variant, Math.max(0, vs.length - 1)));
    return { p: p, v: vs[state.viewer.variant] || null, pi: state.viewer.prompt, vi: state.viewer.variant, pn: ps.length, vn: vs.length };
  }

  function pgImageBatchRenderPane(i) {
    if (state.uiMode === 'planning') {
      if (i === 0) return planningPaneHtml();
      if (i === 1) return renderTraceBox(state.traces.plan, '1. Plan Request & Response Log');
    } else if (state.uiMode === 'conversion') {
      if (i === 0) return renderTraceBox(state.traces.plan, '1. Plan Request & Response Log');
      if (i === 1) return conversionPaneHtml();
    } else if (state.uiMode === 'review') {
      if (i === 0) return conversionPreviewPaneHtml();
      if (i === 1) return reviewPaneHtml();
    }
    return '<div class="pg-batch-inline-pane"></div>';
  }

  function pgImageBatchRenderSidebar() {
    var s = state.snapshot;
    if (!s) return '<div class="pg-side-inner"><div style="padding:16px;color:var(--text-secondary)">No active project.</div></div>';
    var pr = progress(s);
    var status = projectStatus(s);

    var controls = status === 'paused'
      ? button(text('resume'), 'pgImageBatchResume')
      : ((status === 'running' || status === 'queued') ? button(text('pause'), 'pgImageBatchPause') : '');
    if (status === 'running' || status === 'queued' || status === 'paused') {
      controls += button(text('stop'), 'pgImageBatchStop');
      controls += button(text('stopImmediate'), 'pgImageBatchStopImmediate');
    }

    var treeHtml = (s.prompts || []).map(function (p, pi) {
      var varsHtml = (p.variants || []).map(function (v, vi) {
        var vStatus = v.status || 'pending';
        var statusCls = 'is-' + vStatus;
        var isActive = (state.viewer.prompt === pi && state.viewer.variant === vi) ? ' active' : '';
        return '<div class="pg-batch-item-node ' + statusCls + isActive + '" onclick="pgImageBatchSelectViewer(' + pi + ',' + vi + ')">' +
          '<span>Variant ' + (vi + 1) + '</span>' +
          '<span class="pg-batch-status-badge ' + statusCls + '">' + esc(vStatus) + '</span>' +
        '</div>';
      }).join('');

      return '<div class="pg-batch-tree-item" style="margin-bottom:8px">' +
        '<div style="font-weight:600;font-size:12px;margin-bottom:4px;color:var(--text)">' + esc(p.title || p.id) + '</div>' +
        '<div style="padding-left:8px">' + (varsHtml || '<div style="font-size:11px;color:var(--text-secondary)">No variants</div>') + '</div>' +
      '</div>';
    }).join('');

    return '<div class="pg-side-inner" style="padding:12px;display:flex;flex-direction:column;height:100%;box-sizing:border-box">' +
      '<div style="margin-bottom:12px;border-bottom:1px solid var(--border-color);padding-bottom:8px">' +
        '<h4 style="margin:0 0 6px 0;font-size:14px;color:var(--text)">' + esc(s.displayName || s.projectId || text('title')) + '</h4>' +
        '<div style="font-size:11px;color:var(--text-secondary)">' + esc(text('status')) + ': <strong style="color:var(--text)">' + esc(status) + '</strong></div>' +
        '<div style="font-size:11px;color:var(--text-secondary)">' + esc(text('progress')) + ': ' + pr.done + ' / ' + pr.total + '</div>' +
        '<div style="font-size:11px;color:var(--text-secondary);word-break:break-all">' + esc(text('directory')) + ': ' + esc(s.projectDir || s.directory || s.slug || '') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">' +
        controls +
        button(text('refresh'), 'pgImageBatchRefresh') +
        '<button type="button" class="pg-btn" onclick="pgImageBatchCloseUI()">' + esc(text('close')) + '</button>' +
      '</div>' +
      '<div style="flex:1;overflow-y:auto">' + treeHtml + '</div>' +
    '</div>';
  }

  function pgImageBatchRenderCanvas(paneIdx) {
    var s = state.snapshot;
    if (!s) return '<div class="pg-batch-inline-pane"><div style="padding:20px;text-align:center;color:var(--text-secondary)">No active execution project.</div></div>';
    var item = viewerItem(s);
    var img = item && item.v ? assetUrl(item.p, item.v) : '';
    var lastError = (item && item.v && item.v.lastError) || s.lastError || '';
    var navPrompt = '';
    var navVariant = '';
    if (item) {
      var canPrevP = item.pi > 0;
      var canNextP = item.pi < item.pn - 1;
      var canPrevV = item.vi > 0;
      var canNextV = item.vn > 0 && item.vi < item.vn - 1;
      navPrompt =
        '<button type="button" class="pg-btn" onclick="pgImageBatchViewPrompt(' + (item.pi - 1) + ')"' + (canPrevP ? '' : ' disabled') + '>← ' + esc(text('prevPrompt')) + '</button>' +
        '<span style="font-size:12px;color:var(--text-secondary)">Prompt ' + (item.pi + 1) + ' / ' + item.pn + '</span>' +
        '<button type="button" class="pg-btn" onclick="pgImageBatchViewPrompt(' + (item.pi + 1) + ')"' + (canNextP ? '' : ' disabled') + '>' + esc(text('nextPrompt')) + ' →</button>';
      navVariant =
        '<button type="button" class="pg-btn" onclick="pgImageBatchViewVariant(-1)"' + (canPrevV ? '' : ' disabled') + '>←</button>' +
        '<span style="font-size:12px;color:var(--text-secondary)">Variant ' + (item.vi + 1) + ' / ' + Math.max(1, item.vn) + '</span>' +
        '<button type="button" class="pg-btn" onclick="pgImageBatchViewVariant(1)"' + (canNextV ? '' : ' disabled') + '>→</button>';
    }

    return '<div class="pg-batch-inline-pane" style="display:flex;flex-direction:column;gap:12px">' +
      (lastError ? '<div class="pg-batch-error pg-batch-error-box">' + esc(lastError) + '</div>' : '') +
      '<div class="pg-batch-viewer" style="flex:1;min-height:300px;display:flex;align-items:center;justify-content:center;background:var(--bg-surface-2);border-radius:6px;overflow:hidden">' +
        (img ? '<img src="' + esc(img) + '" alt="batch result" style="max-width:100%;max-height:100%;object-fit:contain">' : '<span style="color:var(--text-secondary)">' + esc(text('noImage')) + '</span>') +
      '</div>' +
      (item ? '<div class="pg-batch-viewer-nav" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 8px">' +
        '<span style="display:flex;align-items:center;gap:6px">' + navPrompt + '</span>' +
        '<span style="display:flex;align-items:center;gap:6px">' + navVariant + '</span>' +
      '</div>' : '') +
      (item && item.p ? '<div class="pg-batch-current-prompt" style="padding:10px;background:var(--bg-surface-2);border-radius:6px;font-size:12px">' +
        '<strong style="color:var(--text)">' + esc(item.p.title || item.p.id) + '</strong><br>' +
        '<div style="margin:4px 0;color:var(--text-secondary)">' + esc(item.p.finalPrompt || item.p.naturalPrompt || '') + '</div>' +
        (item.v ? '<div style="font-size:11px;color:var(--text-secondary)">Status: <strong>' + esc(item.v.status || '') + '</strong>' + (item.v.seed != null ? ' · seed ' + item.v.seed : '') +
        (item.v.status === 'failed' || item.v.status === 'interrupted' ? ' ' + button(text('retry'), 'pgImageBatchRetry') : '') + '</div>' : '') +
      '</div>' : '') +
    '</div>';
  }

  root.pgImageBatchSelectViewer = function (pi, vi) {
    state.viewer.prompt = pi;
    state.viewer.variant = vi;
    if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
    if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar();
  };

  function pgImageBatchViewPrompt(i) { if (!state.snapshot || i < 0 || i >= state.snapshot.prompts.length) return; state.viewer.prompt = i; state.viewer.variant = 0; if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes(); if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar(); }
  function pgImageBatchViewVariant(delta) { var item = viewerItem(state.snapshot); if (!item) return; var n = item.vi + delta; if (n < 0 || n >= item.vn) return; state.viewer.variant = n; if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes(); if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar(); }

  function handleEvent(evt) {
    var raw = evt && evt.data;
    if (!raw) return;
    try {
      var d = JSON.parse(raw);
      rememberEvent(d);
      var s = d.snapshot || d.project || (d.type === 'snapshot' && d.data) || (d.data && (d.data.snapshot || d.data.project));
      if (s) applySnapshot(s);
      else if (d.prompts || d.status) applySnapshot(d);
      else if (d.type && state.projectId && !state.reconcileTimer) {
        state.reconcileTimer = setTimeout(function () {
          state.reconcileTimer = null;
          if (state.projectId) pgImageBatchSnapshot(state.projectId).then(function () {
            if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
            if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar();
          }).catch(function () {});
        }, 250);
      }
      if (state.snapshot) {
        if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
        if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar();
      }
    } catch (e) {
      state.events.push({ type: 'client-parse-error', at: new Date().toISOString(), data: e.message || String(e) });
    }
  }

  function pgImageBatchResume() { control('resume'); }
  function pgImageBatchPause() { control('pause'); }
  function pgImageBatchStop() { control('stop', { mode: 'after-current' }); }
  function pgImageBatchStopImmediate() { control('stop', { mode: 'immediate' }); }
  function pgImageBatchRetry() {
    var item = viewerItem(state.snapshot);
    if (!state.projectId || !item || !item.p || !item.v) return;
    var path = '/image-batches/' + encodeURIComponent(state.projectId) + '/retry/' + encodeURIComponent(item.p.id) + '/' + encodeURIComponent(item.v.id);
    apiPost(path, {}).then(function (res) {
      if (!res || res.error) throw new Error(apiError(res));
      applySnapshot(res);
      if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
      if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar();
      openEvents();
    }).catch(function (e) { notify(e.message || text('invalid'), 'error'); });
  }

  function pgImageBatchCleanup() {
    if (state.source) {
      try { state.source.close(); } catch (e) {}
      state.source = null;
    }
    clearTimeout(state.reconnectTimer);
    clearTimeout(state.reconcileTimer);
    state.reconnectTimer = null;
    state.reconcileTimer = null;
    state.reconnecting = false;
  }

  function openEvents() {
    if (!state.projectId || typeof EventSource === 'undefined') return;
    if (state.source) {
      try { state.source.close(); } catch (e) {}
    }
    var id = state.projectId, es = new EventSource('/api/image-batches/' + encodeURIComponent(id) + '/events');
    state.source = es;
    es.onmessage = handleEvent;
    ['project-status','planning-started','planning-completed','transform-completed','variant-started','variant-retry-wait','variant-completed','variant-failed','variant-interrupted','project-reconciled','project-completed','project-error'].forEach(function (name) { es.addEventListener(name, handleEvent); });
    es.onerror = function () {
      if (state.source !== es) return;
      try { es.close(); } catch (e) {}
      state.source = null;
      if (!state.reconnecting) {
        state.reconnecting = true;
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(function () {
          state.reconnecting = false;
          if (state.projectId) pgImageBatchSnapshot(state.projectId).then(function () {
            if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
            if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar();
            openEvents();
          }).catch(function () { openEvents(); });
        }, 1500);
      }
    };
  }

  function draftHasContent() {
    var d = state.draft || {};
    return !!(d.displayName || d.requirements || d.imageModel || d.helperModel ||
              d.negativePrompt || d.customSystemPrompt || d.customUserPrompt);
  }

  function enterExecuting(id) {
    state.projectId = String(id);
    state.uiMode = 'executing';
    state.stage = 4;
    pgImageBatchSetLayout(1);
    pgImageBatchSnapshot(state.projectId).then(function () {
      saveActiveProject();
      if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
      if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar();
      openEvents();
    }).catch(function (e) {
      // Stale project reference: drop it and stay on the normal Image layout.
      state.projectId = null;
      state.snapshot = null;
      clearActiveProject();
      if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar();
      notify(e && e.message ? e.message : text('invalid'), 'error');
    });
  }

  function restorePlanningStage() {
    // Capture the current normal Image layout before switching to the 2-pane
    // planning layout. This runs only while uiMode==='idle' (an earlier
    // ExitUI consumed the previous capture), so the panes show the ordinary
    // Image layout here — never a Batch layout. Without this, a second Return
    // finds previousLayout === null, keeps splitCount 2 and disables the
    // Batch Project button, locking the user out.
    if (!state.previousLayout && root.pgState) {
      state.previousLayout = {
        splitCount: root.pgState.splitCount,
        activeWin: root.pgState.activeWin,
        windows: root.pgState.windows,
        modeWindowsImage: root.pgState.modeWindows && root.pgState.modeWindows.image,
        modeSplitCountImage: root.pgState.modeSplitCounts && root.pgState.modeSplitCounts.image,
        inputMaximized: !!root.pgState.inputMaximized
      };
    }
    if (state.stage === 2 || state.stage === 3) {
      state.uiMode = state.stage === 2 ? 'conversion' : 'review';
    } else {
      state.stage = 1;
      state.uiMode = 'planning';
    }
    pgImageBatchSetLayout(2);
  }

  function restoreDraft(data) {
    state.draftRestored = true;
    state.stage = data.stage || 1;
    state.uiMode = data.uiMode || 'planning';
    state.draft = data.draft || createDraft();
    state.plan = data.plan || null;
    state.transform = data.transform || null;
    if (!state.previousLayout && root.pgState) {
      state.previousLayout = {
        splitCount: root.pgState.splitCount,
        activeWin: root.pgState.activeWin,
        windows: root.pgState.windows,
        modeWindowsImage: root.pgState.modeWindows && root.pgState.modeWindows.image,
        modeSplitCountImage: root.pgState.modeSplitCounts && root.pgState.modeSplitCounts.image,
        inputMaximized: !!root.pgState.inputMaximized
      };
    }
    pgImageBatchSetLayout(2);
  }

  // Restores a previously preserved Batch session: in-memory executing project,
  // in-memory planning-stage state, then the persisted active-project
  // reference and Stage 1-3 draft. Invoked only by an explicit user action
  // (the sidebar Batch Project button) — Batch UI is never entered
  // automatically from persisted state.
  function pgImageBatchRestore() {
    if (state.uiMode !== 'idle') return true;
    if (state.projectId) {
      enterExecuting(state.projectId);
      return true;
    }
    if (state.plan || state.transform || state.stage !== 1 || state.draftRestored || draftHasContent()) {
      restorePlanningStage();
      return true;
    }
    var active = loadActiveProject();
    if (active && active.projectId) {
      enterExecuting(active.projectId);
      return true;
    }
    var draftData = loadBatchDraft();
    if (draftData) {
      restoreDraft(draftData);
      return true;
    }
    return false;
  }

  // Unified close entry: cleanup SSE/timers, then exit the Batch UI while
  // preserving the executing project (the backend task keeps running).
  function pgImageBatchCloseUI() {
    pgImageBatchCleanup();
    pgImageBatchExitUI({ preserveProject: true });
  }

  function pgImageBatchClose() {
    pgImageBatchCloseUI();
  }

  function pgOpenImageBatch() {
    // The sidebar button renders as Return while Batch UI is active; this
    // guard keeps a stale handler from starting a second project.
    if (state.uiMode !== 'idle') {
      pgImageBatchCloseUI();
      return;
    }
    if (typeof pgState !== 'undefined' && pgState.mode === 'image' && pgState.splitCount > 1) {
      notify(text('batchSingleWindow'), 'warning');
      return;
    }
    // Explicit entry: first try to restore a previously preserved session
    // (in-memory or persisted); only otherwise start a new project.
    if (pgImageBatchRestore()) return;
    // Starting a genuinely new project: close any previous SSE/timers and
    // clear stale project references so recovery cannot cross projects.
    pgImageBatchCleanup();
    state.projectId = null;
    state.snapshot = null;
    state.source = null;
    state.viewer = { prompt: 0, variant: 0 };
    clearActiveProject();
    if (!state.previousLayout && root.pgState) {
      state.previousLayout = {
        splitCount: root.pgState.splitCount,
        activeWin: root.pgState.activeWin,
        windows: root.pgState.windows,
        modeWindowsImage: root.pgState.modeWindows && root.pgState.modeWindows.image,
        modeSplitCountImage: root.pgState.modeSplitCounts && root.pgState.modeSplitCounts.image,
        inputMaximized: !!root.pgState.inputMaximized
      };
    }
    state.uiMode = 'planning';
    state.stage = 1;
    state.plan = null;
    state.transform = null;
    state.traces = { plan: null, transform: null, create: null };
    state.events = [];
    state.draft = createDraft();
    state.draftRestored = false;
    readDraft();
    saveBatchDraft();
    pgImageBatchSetLayout(2);
  }

  function pgImageBatchList() {
    apiGet('/image-batches').then(function (res) {
      if (!res || res.error || !Array.isArray(res.projects || res.items || res)) throw new Error(apiError(res));
      var list = res.projects || res.items || res;
      modal(stageHeader(false) + '<div class="pg-modal-body"><h4>' + esc(text('projects')) + '</h4>' + list.map(function (p) {
        var id = p.projectId || p.id;
        return '<button type="button" class="pg-btn" style="display:block;width:100%;text-align:left;margin:5px 0" onclick="pgImageBatchOpenProject(\'' + String(id).replace(/\\/g,'\\\\').replace(/'/g,"\\'") + '\')">' + esc(p.displayName || id) + ' · ' + esc(p.status || '') + '</button>';
      }).join('') + '<div style="margin-top:8px">' + button(text('cancel'), 'closeModal') + '</div></div>');
    }).catch(function (e) { notify(e.message || text('invalid'), 'error'); });
  }

  function pgImageBatchOpenProject(id) {
    if (!state.previousLayout && root.pgState) {
      state.previousLayout = {
        splitCount: root.pgState.splitCount,
        activeWin: root.pgState.activeWin,
        windows: root.pgState.windows,
        modeWindowsImage: root.pgState.modeWindows && root.pgState.modeWindows.image,
        modeSplitCountImage: root.pgState.modeSplitCounts && root.pgState.modeSplitCounts.image,
        inputMaximized: !!root.pgState.inputMaximized
      };
    }
    state.projectId = String(id);
    state.uiMode = 'executing';
    state.stage = 4;
    closeModal();
    pgImageBatchSetLayout(1);
    pgImageBatchSnapshot(state.projectId).then(function () {
      saveActiveProject();
      if (typeof root.pgRenderPanes === 'function') root.pgRenderPanes();
      if (typeof root.pgRenderSidebar === 'function') root.pgRenderSidebar();
      openEvents();
    }).catch(function (e) {
      notify(e.message || text('invalid'), 'error');
      // The project never loaded: undo the transient executing state so a
      // stale projectId/snapshot pair cannot render or feed asset URLs.
      state.projectId = null;
      state.snapshot = null;
      state.stage = 1;
      state.viewer = { prompt: 0, variant: 0 };
      pgImageBatchExitUI({ preserveProject: true });
    });
  }

  root.pgOpenImageBatch = pgOpenImageBatch;
  root.pgImageBatchOpen = pgOpenImageBatch;
  root.pgImageBatchPlan = pgImageBatchPlan;
  root.pgImageBatchTransform = pgImageBatchTransform;
  root.pgImageBatchStage = pgImageBatchStage;
  root.pgImageBatchEditItem = pgImageBatchEditItem;
  root.pgImageBatchMove = pgImageBatchMove;
  root.pgImageBatchDelete = pgImageBatchDelete;
  root.pgImageBatchAddItem = pgImageBatchAddItem;
  root.pgImageBatchStart = pgImageBatchStart;
  root.pgImageBatchClose = pgImageBatchClose;
  root.pgImageBatchCloseUI = pgImageBatchCloseUI;
  root.pgImageBatchRestoreCreateModal = closeModal;
  root.pgImageBatchSnapshot = pgImageBatchSnapshot;
  root.pgImageBatchRefresh = pgImageBatchRefresh;
  root.pgImageBatchPause = pgImageBatchPause;
  root.pgImageBatchResume = pgImageBatchResume;
  root.pgImageBatchStop = pgImageBatchStop;
  root.pgImageBatchStopImmediate = pgImageBatchStopImmediate;
  root.pgImageBatchViewPrompt = pgImageBatchViewPrompt;
  root.pgImageBatchViewVariant = pgImageBatchViewVariant;
  root.pgImageBatchCleanup = pgImageBatchCleanup;
  root.pgImageBatchRestore = pgImageBatchRestore;
  root.pgImageBatchList = pgImageBatchList;
  root.pgImageBatchOpenProject = pgImageBatchOpenProject;
  root.pgImageBatchRenderPane = pgImageBatchRenderPane;
  root.pgImageBatchRenderSidebar = pgImageBatchRenderSidebar;
  root.pgImageBatchRenderCanvas = pgImageBatchRenderCanvas;
  root.pgImageBatchExitUI = pgImageBatchExitUI;
  root.pgImageBatchCancelDraft = pgImageBatchCancelDraft;

})(typeof window !== 'undefined' ? window : this);
