// pg-image-batch.js — Image Batch Project workflow.
// This module deliberately keeps batch state in memory. The backend owns the
// task and manifest; leaving the page only closes EventSource.
(function (root) {
  'use strict';

  var STATUS = ['draft','planning','converting','review','queued','running','paused','stopping','completed','completed_with_errors','failed','canceled'];
  var VARIANT_STATUS = ['pending','running','retry_wait','succeeded','failed','interrupted','canceled'];
  var FORMAT = ['natural','tag','json'];
  var state = {
    projectId: null,
    snapshot: null,
    source: null,
    reconnectTimer: null,
    reconnecting: false,
    modal: false,
    stage: 1,
    draft: { displayName: '', helperModel: '', imageModel: '', protocol: '', endpoint: '', requirements: '', format: 'natural', negativePrompt: '', quantity: 4, intervalMs: 0, maxRetries: 1, retryDelayMs: 1000, retryBackoff: 'fixed', onError: 'continue', seedMode: 'provider-controlled', baseSeed: 0, params: {}, customSystemPrompt: '', customUserPrompt: '', error: '', starting: false },
    reconcileTimer: null,
    plan: null,
    transform: null,
    viewer: { prompt: 0, variant: 0 },
    events: []
  };
  if (root.pgState && typeof root.pgState === 'object') root.pgState.imageBatch = state;
  root.pgImageBatch = state;

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
      status: ['Status','状态'], progress: ['Progress','进度'], directory: ['Project directory','项目目录'], interval: ['Interval (ms)','间隔（毫秒）'], retries: ['Max retries','最大重试'], retryDelay: ['Retry delay (ms)','重试延迟（毫秒）'], seedMode: ['Seed mode','Seed 策略'], baseSeed: ['Base seed','基础 Seed'], pause: ['Pause','暂停'], resume: ['Resume','继续'], stop: ['Stop','停止'], retry: ['Retry','重试'], previous: ['Previous','上一个'], nextImage: ['Next','下一个'], noImage: ['No image yet','暂无图片'], projects: ['Projects','项目列表'], refresh: ['Refresh','刷新'], planningError: ['Planning returned an invalid item list.','规划返回的项目列表无效。'], invalid: ['Invalid response','响应格式无效'], helperRequired: ['Select a prompt helper model first.','请先选择提示词辅助模型。'], imageRequired: ['Select an image model first.','请先选择图片模型。'], requirementsRequired: ['Enter image requirements first.','请先输入批量创作要求。'], nameRequired: ['Project name is required.','项目名称不能为空。'], jsonInvalid: ['JSON prompt is invalid.','JSON 提示词无效。']
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

  function hamsterLoaderHtml() {
    return '<div class="pg-hamster-overlay" id="pg-batch-modal-loader">' +
      '<div class="wheel-and-hamster">' +
        '<div class="wheel"></div>' +
        '<div class="hamster">' +
          '<div class="hamster__body">' +
            '<div class="hamster__head"><div class="hamster__ear"></div><div class="hamster__eye"></div><div class="hamster__nose"></div></div>' +
            '<div class="hamster__limb hamster__limb--fr"></div><div class="hamster__limb hamster__limb--fl"></div>' +
            '<div class="hamster__limb hamster__limb--br"></div><div class="hamster__limb hamster__limb--bl"></div>' +
            '<div class="hamster__tail"></div>' +
          '</div>' +
        '</div>' +
        '<div class="spoke"></div>' +
      '</div>' +
    '</div>';
  }

  function stageHeader(includeInspect) {
    return '<div class="pg-modal-header"><span class="pg-modal-title">' + esc(text('title')) + '</span><button type="button" class="pg-modal-close" onclick="pgImageBatchClose()">✕</button></div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 20px;border-bottom:1px solid var(--glass-border);font-size:12px;color:var(--text-secondary)">' +
        '<div style="display:flex;gap:6px"><span>1. ' + esc(text('planning')) + '</span><span>→</span><span>2. ' + esc(text('conversion')) + '</span><span>→</span><span>3. ' + esc(text('review')) + '</span></div>' +
        (includeInspect ? '<button type="button" class="pg-btn" onclick="pgImageBatchInspectPrompts()" style="font-size:11px;padding:3px 8px;border-radius:var(--radius-xs)">🔍 查看/修改 Prompt 模版</button>' : '') +
      '</div>';
  }

  root.pgImageBatchInspectPrompts = function () {
    readDraft();
    var d = state.draft;
    var defaultSys = "Return raw JSON only. No code blocks, no backticks, no explanations. Start with { and end with }. Preserve the user's subject and intent.";
    var sysPrompt = d.customSystemPrompt || defaultSys;
    var defaultUser = "Create a JSON image plan for these requirements: " + (d.requirements || '[批量创作要求]') + "\nUse this as the default negative prompt unless an item specifies otherwise: " + (d.negativePrompt || '[默认负面提示词]') + "\nDefault quantity: " + d.quantity + "\nReturn {\"title\":string,\"items\":[{\"id\":unique alphanumeric string (max 128 chars)\",\"title\":string,\"naturalPrompt\":string,\"negativePrompt\":string,\"quantity\":integer 1-100}]}";
    var reqPrompt = d.customUserPrompt || defaultUser;

    var html = '<div class="pg-modal-header"><span class="pg-modal-title">🔍 Prompt 模版与透明度（可查看并修改）</span><button type="button" class="pg-modal-close" onclick="pgImageBatchRestoreCreateModal()">✕</button></div>' +
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
    renderCreate();
  };

  function planningHtml() {
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

    return stageHeader(true) + '<div class="pg-modal-body pg-batch-modal-body" style="max-height:72vh;overflow:auto;position:relative">' +
      hamsterLoaderHtml() +
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
      '<div id="pg-img-batch-error" style="color:var(--danger);min-height:18px;margin-top:6px"></div><div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">' + button(text('cancel'), 'pgImageBatchClose') + button(text('plan'), 'pgImageBatchPlan', false, 'pg-btn-primary') + '</div></div>';
  }
  function setError(msg) { var e = document.getElementById('pg-img-batch-error'); if (e) e.textContent = msg || ''; else if (msg) notify(msg, 'error'); }
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
    var btn = document.querySelector('#pg-modal-overlay .pg-btn-primary'); if (btn) btn.disabled = true;
    var loader = document.getElementById('pg-batch-modal-loader');
    if (loader) loader.classList.add('active');

    apiPost('/image-batches/plan', { helperModel: state.draft.helperModel, requirements: state.draft.requirements, defaultNegativePrompt: state.draft.negativePrompt, defaultQuantity: state.draft.quantity, customSystemPrompt: state.draft.customSystemPrompt, customUserPrompt: state.draft.customUserPrompt }).then(function (res) {
      if (!res || res.error) throw new Error(apiError(res)); state.plan = validatePlan(res); state.stage = 2; renderCreate();
    }).catch(function (e) { setError(e.message || text('planningError')); }).finally(function () {
      var b = document.querySelector('#pg-modal-overlay .pg-btn-primary'); if (b) b.disabled = false;
      if (loader) loader.classList.remove('active');
    });
  }
  function editPlan(index, prop, value) { if (!state.plan || !state.plan.items[index]) return; var it = state.plan.items[index]; if (prop === 'quantity') it.quantity = safeNum(value, it.quantity, 1, 100); else it[prop] = String(value); }
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
  function conversionHtml() {
    return stageHeader(true) +
      '<div class="pg-modal-body pg-batch-modal-body" style="max-height:72vh;overflow:auto;position:relative">' +
        hamsterLoaderHtml() +
        '<p style="font-size:12px;color:var(--text-secondary);margin-bottom:10px">' + esc(text('planning')) + ': <strong style="color:var(--text)">' + esc(state.plan.title) + '</strong></p>' +
        '<div id="pg-img-batch-items">' + renderPlanItems() + '</div>' +
        '<div style="display:flex;justify-content:space-between;gap:10px;margin-top:16px">' +
          button(text('add'), 'pgImageBatchAddItem') +
          '<div style="display:flex;gap:10px"><button type="button" class="pg-btn" onclick="pgImageBatchStage(1)" style="height:38px;padding:0 20px;font-size:13px;font-weight:600;min-width:88px">' + esc(text('back')) + '</button><button type="button" class="pg-btn pg-btn-primary" onclick="pgImageBatchTransform()" style="height:38px;padding:0 20px;font-size:13px;font-weight:600;min-width:88px">' + esc(text('transform')) + '</button></div>' +
        '</div>' +
        '<div id="pg-img-batch-error" style="color:var(--danger);min-height:18px;margin-top:6px"></div>' +
      '</div>';
  }
  function transformItems(raw) { var source = raw && Array.isArray(raw.items) ? raw.items : (Array.isArray(raw) ? raw : null); if (!source || source.length !== state.plan.items.length) throw new Error(text('invalid')); return state.plan.items.map(function (it, i) { var x = source[i] || {}; var out = Object.assign({}, it); out.index = i + 1; out.finalFormat = state.draft.format; out.finalPrompt = String(x.finalPrompt != null ? x.finalPrompt : it.naturalPrompt); out.finalPromptObject = x.finalPromptObject != null ? x.finalPromptObject : null; if (!String(out.finalPrompt).trim()) { out._invalid = true; } else if (out.finalFormat === 'json') { try { var o = out.finalPromptObject; if (!o || typeof o === 'string') o = JSON.parse(out.finalPrompt); out.finalPromptObject = o; if (!o || typeof o !== 'object' || !o.subject) out._invalid = true; } catch (e) { out._invalid = true; } } else if (out.finalFormat === 'tag') { var fp = String(out.finalPrompt); if (/^[\s]*[[{]/.test(fp) || /[\r\n]/.test(fp)) out._invalid = true; } return out; }); }
  function pgImageBatchTransform() {
    readDraft();
    var items = state.plan.items.map(function (x, i) {
      return { id: x.id, index: i + 1, title: x.title, naturalPrompt: x.naturalPrompt, finalFormat: state.draft.format, finalPrompt: x.naturalPrompt, negativePrompt: x.negativePrompt, quantity: x.quantity, variants: [] };
    });
    setError('');
    if (state.draft.format === 'natural') {
      state.transform = items;
      state.stage = 3;
      renderCreate();
      return;
    }
    var btn = document.querySelector('#pg-modal-overlay .pg-btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Transforming...'; }
    var loader = document.getElementById('pg-batch-modal-loader');
    if (loader) loader.classList.add('active');
    apiPost('/image-batches/transform', { helperModel: state.draft.helperModel, format: state.draft.format, items: items }).then(function (res) {
      if (!res || res.error) throw new Error(apiError(res));
      state.transform = transformItems(res);
      state.draft.error = '';
      state.stage = 3;
      renderCreate();
    }).catch(function (e) {
      setError(e.message || text('invalid'));
    }).finally(function () {
      var currentBtn = document.querySelector('#pg-modal-overlay .pg-btn-primary');
      if (currentBtn) currentBtn.disabled = false;
      if (loader) loader.classList.remove('active');
    });
  }
  function reviewHtml() {
    var items = state.transform || state.plan.items;
    var total = items.reduce(function (n, x) { return n + safeNum(x.quantity, 0, 0, 100); }, 0);
    var invalid = items.some(function (x) { return x._invalid || !x.finalPrompt || (x.finalFormat === 'json' && !x.finalPromptObject); });
    var err = state.draft.error || '';
    return stageHeader(true) + '<div class="pg-modal-body pg-batch-modal-body" style="max-height:72vh;overflow:auto">' +
      '<div class="pg-batch-summary"><div>' + esc(text('name')) + ': <strong>' + esc(state.draft.displayName) + '</strong></div><div>Prompt count: ' + items.length + ' · Total variants: ' + total + ' · Maximum attempts: ' + (total * (1 + state.draft.maxRetries)) + '</div><div>' + esc(text('imageModel')) + ': ' + esc(state.draft.imageModel) + ' · ' + esc(text('helper')) + ': ' + esc(state.draft.helperModel) + '</div><div>' + esc(text('interval')) + ': ' + state.draft.intervalMs + ' · ' + esc(text('retries')) + ': ' + state.draft.maxRetries + ' · ' + esc(text('seedMode')) + ': ' + esc(state.draft.seedMode) + '</div></div>' +
      '<div class="pg-batch-review-items">' + items.map(function (it) { return '<div class="pg-batch-review-item"><strong>' + esc(it.title) + '</strong> × ' + esc(it.quantity) + '<div>' + esc(it.finalPrompt) + '</div>' + (it._invalid ? '<div class="pg-batch-error">' + esc(text('jsonInvalid')) + '</div>' : '') + '</div>'; }).join('') + '</div>' +
      (err ? '<div class="pg-batch-error pg-batch-error-box">' + esc(err) + '</div>' : '<div class="pg-batch-error-box"></div>') +
      '<div class="pg-batch-footer"><button type="button" class="pg-btn pg-batch-action-btn" onclick="pgImageBatchStage(2)">' + esc(text('back')) + '</button><button type="button" class="pg-btn pg-btn-primary pg-batch-action-btn" onclick="pgImageBatchStart()"' + (invalid || state.draft.starting ? ' disabled' : '') + '>' + esc(state.draft.starting ? 'Starting…' : text('start')) + '</button></div>' +
      '</div>';
  }
  function renderCreate() { if (!state.modal) return; modal(state.stage === 1 ? planningHtml() : state.stage === 2 ? conversionHtml() : reviewHtml()); }
  function pgImageBatchStage(n) { if (n === 1) readDraft(); state.stage = n; renderCreate(); }
  function pgImageBatchEditItem(i, prop, value) { editPlan(i, prop, value); }
  function pgImageBatchMove(i, delta) { if (!state.plan || i + delta < 0 || i + delta >= state.plan.items.length) return; var a = state.plan.items; var x = a.splice(i, 1)[0]; a.splice(i + delta, 0, x); a.forEach(function (v, n) { v.index = n; }); renderCreate(); }
  function pgImageBatchDelete(i) { if (state.plan.items.length <= 1) return; state.plan.items.splice(i, 1); renderCreate(); }
  function pgImageBatchAddItem() { state.plan.items.push({ id: 'p' + String(state.plan.items.length + 1).padStart(4, '0'), index: state.plan.items.length, title: 'New item', naturalPrompt: '', negativePrompt: state.draft.negativePrompt, finalFormat: state.draft.format, finalPrompt: '', finalPromptObject: null, quantity: state.draft.quantity, variants: [] }); renderCreate(); }
  function pgImageBatchStart() {
    if (state.draft.starting) return;
    readDraft();
    state.draft.error = '';
    var source = state.transform || state.plan.items;
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
      renderCreate();
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
    renderCreate();
    apiPost('/image-batches', body).then(function (res) {
      if (!res || res.error || !res.projectId) throw new Error(apiError(res));
      state.projectId = String(res.projectId);
      state.snapshot = res.snapshot || null;
      return state.snapshot ? Promise.resolve(state.snapshot) : pgImageBatchSnapshot(state.projectId);
    }).then(function (snap) {
      if (!snap) throw new Error(text('invalid'));
      applySnapshot(snap);
      state.draft.starting = false;
      closeModal();
      renderDashboard();
      openEvents();
    }).catch(function (e) {
      state.draft.starting = false;
      state.draft.error = e.message || text('invalid');
      renderCreate();
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
      if (state.modal) renderDashboard();
    }).catch(function (e) { notify(e.message || text('invalid'), 'error'); });
  }
  function pgImageBatchRefresh() {
    if (!state.projectId) return Promise.resolve(null);
    return pgImageBatchSnapshot(state.projectId).then(function (snap) {
      if (state.modal) renderDashboard();
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
  function viewerItem(s) { var ps = s && s.prompts || []; if (!ps.length) return null; state.viewer.prompt = Math.max(0, Math.min(state.viewer.prompt, ps.length - 1)); var p = ps[state.viewer.prompt]; var vs = p.variants || []; state.viewer.variant = Math.max(0, Math.min(state.viewer.variant, Math.max(0, vs.length - 1))); return { p: p, v: vs[state.viewer.variant] || null, pi: state.viewer.prompt, vi: state.viewer.variant, pn: ps.length, vn: vs.length }; }
  function dashboardHtml(s) { var pr = progress(s), item = viewerItem(s), ps = s.prompts || [], status = projectStatus(s), controls = status === 'paused' ? button(text('resume'), 'pgImageBatchResume') : (status === 'running' || status === 'queued' ? button(text('pause'), 'pgImageBatchPause') : ''); if (status === 'running' || status === 'queued' || status === 'paused') controls += button(text('stop'), 'pgImageBatchStop'); var th = ps.map(function (p, i) { return '<button type="button" class="pg-btn pg-batch-prompt-tab" onclick="pgImageBatchViewPrompt(' + i + ')">' + esc(p.title || p.id) + '</button>'; }).join(''); var img = item && item.v ? assetUrl(item.p, item.v) : ''; var lastError = (item && item.v && item.v.lastError) || s.lastError || ''; var eventRows = state.events.slice(-12).reverse().map(function (ev) { return '<div class="pg-batch-event-row"><span>' + esc(ev.type) + '</span><span>' + esc(ev.promptId || ev.variantId || '') + '</span><span>' + esc(ev.data || '') + '</span></div>'; }).join(''); return '<div class="pg-modal-header"><span class="pg-modal-title">' + esc(s.displayName || s.projectId || text('title')) + '</span><button type="button" class="pg-modal-close" onclick="pgImageBatchClose()">✕</button></div><div class="pg-modal-body pg-batch-modal-body" style="max-height:78vh;overflow:auto"><div class="pg-batch-dashboard-meta"><span>' + esc(text('status')) + ': <strong>' + esc(status) + '</strong></span><span>' + esc(text('progress')) + ': ' + pr.done + ' / ' + pr.total + '</span><span>' + esc(text('directory')) + ': ' + esc(s.projectDir || s.directory || s.slug || '') + '</span></div>' + (lastError ? '<div class="pg-batch-error pg-batch-error-box">' + esc(lastError) + '</div>' : '') + '<div class="pg-batch-dashboard-actions">' + controls + button(text('refresh'), 'pgImageBatchRefresh') + '</div><div class="pg-batch-prompt-tabs">' + th + '</div><div class="pg-batch-viewer">' + (img ? '<img src="' + esc(img) + '" alt="batch result">' : '<span>' + esc(text('noImage')) + '</span>') + '</div><div class="pg-batch-viewer-nav"><button type="button" class="pg-btn" onclick="pgImageBatchViewVariant(-1)">←</button><span>' + (item ? ('Prompt ' + (item.pi + 1) + ' / ' + item.pn + ' · Variant ' + (item.vi + 1) + ' / ' + Math.max(1, item.vn)) : '') + '</span><button type="button" class="pg-btn" onclick="pgImageBatchViewVariant(1)">→</button></div>' + (item && item.p ? '<div class="pg-batch-current-prompt"><strong>' + esc(item.p.title || item.p.id) + '</strong><br>' + esc(item.p.finalPrompt || item.p.naturalPrompt || '') + (item.v ? '<br><span>' + esc(item.v.status || '') + (item.v.seed != null ? ' · seed ' + item.v.seed : '') + '</span>' + (item.v.status === 'failed' || item.v.status === 'interrupted' ? ' ' + button(text('retry'), 'pgImageBatchRetry') : '') : '') + '</div>' : '') + '<details class="pg-batch-debug"><summary>Execution details (' + state.events.length + ' events)</summary><div class="pg-batch-event-list">' + (eventRows || '<span>No events received yet.</span>') + '</div></details></div>'; }
  function renderDashboard() { if (!state.snapshot) return; state.modal = true; modal(dashboardHtml(state.snapshot)); }
  function pgImageBatchViewPrompt(i) { if (!state.snapshot || i < 0 || i >= state.snapshot.prompts.length) return; state.viewer.prompt = i; state.viewer.variant = 0; renderDashboard(); }
  function pgImageBatchViewVariant(delta) { var item = viewerItem(state.snapshot); if (!item) return; var n = item.vi + delta; if (n < 0 || n >= item.vn) return; state.viewer.variant = n; renderDashboard(); }
  function handleEvent(evt) { var raw = evt && evt.data; if (!raw) return; try { var d = JSON.parse(raw); rememberEvent(d); var s = d.snapshot || d.project || (d.type === 'snapshot' && d.data) || (d.data && (d.data.snapshot || d.data.project)); if (s) applySnapshot(s); else if (d.prompts || d.status) applySnapshot(d); else if (d.type && state.projectId && !state.reconcileTimer) { state.reconcileTimer = setTimeout(function () { state.reconcileTimer = null; if (state.projectId) pgImageBatchSnapshot(state.projectId).then(function () { if (state.modal) renderDashboard(); }).catch(function () {}); }, 250); } if (state.snapshot && state.modal) renderDashboard(); } catch (e) { state.events.push({ type: 'client-parse-error', at: new Date().toISOString(), data: e.message || String(e) }); } }
  function pgImageBatchResume() { control('resume'); }
  function pgImageBatchPause() { control('pause'); }
  function pgImageBatchStop() { control('stop', { mode: 'after-current' }); }
  function pgImageBatchRetry() { var item = viewerItem(state.snapshot); if (!state.projectId || !item || !item.p || !item.v) return; var path = '/image-batches/' + encodeURIComponent(state.projectId) + '/retry/' + encodeURIComponent(item.p.id) + '/' + encodeURIComponent(item.v.id); apiPost(path, {}).then(function (res) { if (!res || res.error) throw new Error(apiError(res)); applySnapshot(res); if (state.modal) renderDashboard(); openEvents(); }).catch(function (e) { notify(e.message || text('invalid'), 'error'); }); }
  function pgImageBatchCleanup() { if (state.source) { try { state.source.close(); } catch (e) {} state.source = null; } clearTimeout(state.reconnectTimer); clearTimeout(state.reconcileTimer); state.reconnectTimer = null; state.reconcileTimer = null; state.reconnecting = false; }
  function openEvents() { if (!state.projectId || typeof EventSource === 'undefined') return; if (state.source) { try { state.source.close(); } catch (e) {} } var id = state.projectId, es = new EventSource('/api/image-batches/' + encodeURIComponent(id) + '/events'); state.source = es; es.onmessage = handleEvent; ['project-status','planning-started','planning-completed','transform-completed','variant-started','variant-retry-wait','variant-completed','variant-failed','variant-interrupted','project-reconciled','project-completed','project-error'].forEach(function (name) { es.addEventListener(name, handleEvent); }); es.onerror = function () { if (state.source !== es) return; try { es.close(); } catch (e) {} state.source = null; if (!state.reconnecting) { state.reconnecting = true; clearTimeout(state.reconnectTimer); state.reconnectTimer = setTimeout(function () { state.reconnecting = false; if (state.projectId) pgImageBatchSnapshot(state.projectId).then(function () { if (state.modal) renderDashboard(); openEvents(); }).catch(function () { openEvents(); }); }, 1500); } }; }
  function pgImageBatchOnEnter() { if (!state.projectId) return; pgImageBatchSnapshot(state.projectId).then(function () { if (state.modal) renderDashboard(); openEvents(); }).catch(function () {}); }
  function pgImageBatchClose() { pgImageBatchCleanup(); closeModal(); }
  function pgOpenImageBatch() { if (typeof pgState !== 'undefined' && pgState.mode === 'image' && pgState.splitCount > 1) { notify(text('batchSingleWindow'), 'warning'); return; } state.modal = true; state.stage = 1; state.plan = null; state.transform = null; state.events = []; state.draft.displayName = ''; state.draft.requirements = ''; state.draft.error = ''; state.draft.starting = false; readDraft(); renderCreate(); }
  function pgImageBatchList() { apiGet('/image-batches').then(function (res) { if (!res || res.error || !Array.isArray(res.projects || res.items || res)) throw new Error(apiError(res)); var list = res.projects || res.items || res; modal(stageHeader(false) + '<div class="pg-modal-body"><h4>' + esc(text('projects')) + '</h4>' + list.map(function (p) { var id = p.projectId || p.id; return '<button type="button" class="pg-btn" style="display:block;width:100%;text-align:left;margin:5px 0" onclick="pgImageBatchOpenProject(\'' + String(id).replace(/\\/g,'\\\\').replace(/'/g,"\\'") + '\')">' + esc(p.displayName || id) + ' · ' + esc(p.status || '') + '</button>'; }).join('') + '<div style="margin-top:8px">' + button(text('cancel'), 'pgImageBatchClose') + '</div></div>'); }).catch(function (e) { notify(e.message || text('invalid'), 'error'); }); }
  function pgImageBatchOpenProject(id) { state.projectId = String(id); state.modal = true; pgImageBatchSnapshot(state.projectId).then(function () { renderDashboard(); openEvents(); }).catch(function (e) { notify(e.message || text('invalid'), 'error'); }); }

  root.pgOpenImageBatch = pgOpenImageBatch; root.pgImageBatchOpen = pgOpenImageBatch; root.pgImageBatchPlan = pgImageBatchPlan; root.pgImageBatchTransform = pgImageBatchTransform; root.pgImageBatchStage = pgImageBatchStage; root.pgImageBatchEditItem = pgImageBatchEditItem; root.pgImageBatchMove = pgImageBatchMove; root.pgImageBatchDelete = pgImageBatchDelete; root.pgImageBatchAddItem = pgImageBatchAddItem; root.pgImageBatchStart = pgImageBatchStart; root.pgImageBatchClose = pgImageBatchClose; root.pgImageBatchRestoreCreateModal = restoreCreateModal; root.pgImageBatchSnapshot = pgImageBatchSnapshot; root.pgImageBatchRefresh = pgImageBatchRefresh; root.pgImageBatchPause = pgImageBatchPause; root.pgImageBatchResume = pgImageBatchResume; root.pgImageBatchStop = pgImageBatchStop; root.pgImageBatchRetry = pgImageBatchRetry; root.pgImageBatchViewPrompt = pgImageBatchViewPrompt; root.pgImageBatchViewVariant = pgImageBatchViewVariant; root.pgImageBatchCleanup = pgImageBatchCleanup; root.pgImageBatchOnEnter = pgImageBatchOnEnter; root.pgImageBatchList = pgImageBatchList; root.pgImageBatchOpenProject = pgImageBatchOpenProject;
})(typeof window !== 'undefined' ? window : this);
