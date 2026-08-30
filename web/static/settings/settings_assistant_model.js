'use strict';

var __assistantMS = null;

var ASSISTANT_MS_PARAMS = [
  { key: 'reasoning', label: 'reasoning', kind: 'reasoning_toggle', def: true },
  { key: 'reasoning_effort', label: 'reasoning_effort', kind: 'reasoning_effort', def: 'medium' },
  { key: 'temperature', label: 'temperature', kind: 'stepper', min: 0, max: 2, step: 0.1, def: 0.7 },
  { key: 'top_p', label: 'top_p', kind: 'stepper', min: 0, max: 1, step: 0.1, def: 1 },
  { key: 'top_k', label: 'top_k', kind: 'stepper', min: 0, max: 4096, step: 1, def: 0 },
  { key: 'min_p', label: 'min_p', kind: 'stepper', min: 0, max: 1, step: 0.1, def: 0 },
  { key: 'presence_penalty', label: 'presence_penalty', kind: 'stepper', min: -2, max: 2, step: 0.1, def: 0 },
  { key: 'repetition_penalty', label: 'repetition_penalty', kind: 'stepper', min: 0, max: 2, step: 0.1, def: 1 }
];

function assistantMSDefaultParams() {
  var m = {};
  ASSISTANT_MS_PARAMS.forEach(function(p) {
    m[p.key] = { enabled: false, value: p.def };
  });
  return m;
}

function assistantMSClonePreset(p) {
  var out = {
    name: p.name || '',
    systemPrompt: p.systemPrompt || '',
    memoryModel: p.memoryModel || '',
    params: p.params ? JSON.parse(JSON.stringify(p.params)) : assistantMSDefaultParams()
  };
  // Back-compat: legacy assistantName migrates to name
  if (!out.name && p.assistantName) out.name = String(p.assistantName).trim();
  // Ensure every known key exists.
  ASSISTANT_MS_PARAMS.forEach(function(k) {
    if (!out.params[k.key]) out.params[k.key] = { enabled: false, value: k.def };
  });
  return out;
}

function assistantMSStashForm() {
  if (!__assistantMS) return;
  var sel = __assistantMS.sel;
  var idx = -1;
  for (var i = 0; i < __assistantMS.presets.length; i++) {
    if (__assistantMS.presets[i].name === sel) { idx = i; break; }
  }
  if (idx < 0) return;
  __assistantMS.presets[idx] = assistantMSCollectForm(__assistantMS.presets[idx]);
}

function assistantMSCollectForm(base) {
  var p = assistantMSClonePreset(base);
  var promptEl = document.getElementById('assistant-ms-prompt');
  if (promptEl) p.systemPrompt = promptEl.value;
  var memEl = document.getElementById('assistant-ms-memory-model');
  if (memEl) p.memoryModel = (memEl.getAttribute('data-value') || '').trim();
  ASSISTANT_MS_PARAMS.forEach(function(k) {
    // reasoning is a single toggle: enabled == value
    if (k.kind === 'reasoning_toggle') {
      var cbR = document.getElementById('assistant-ms-enable-' + k.key);
      var on = !!(cbR && cbR.checked);
      p.params[k.key] = { enabled: on, value: on };
      return;
    }
    var cb = document.getElementById('assistant-ms-enable-' + k.key);
    if (!cb) return;
    var enabled = !!cb.checked;
    var val;
    if (k.kind === 'reasoning_effort') {
      var s2 = document.getElementById('assistant-ms-val-' + k.key);
      val = s2 ? s2.value : k.def;
    } else if (k.kind === 'stepper') {
      var inp = document.getElementById('assistant-ms-val-' + k.key);
      if (k.key === 'top_k') {
        val = inp ? parseInt(inp.value, 10) : k.def;
      } else {
        val = inp ? parseFloat(inp.value) : k.def;
      }
      if (isNaN(val)) val = k.def;
    } else {
      var inp2 = document.getElementById('assistant-ms-val-' + k.key);
      val = inp2 ? parseFloat(inp2.value) : k.def;
      if (isNaN(val)) val = k.def;
    }
    p.params[k.key] = { enabled: enabled, value: val };
  });
  return p;
}

function assistantMSLoadForm(preset) {
  var p = assistantMSClonePreset(preset);
  var promptEl = document.getElementById('assistant-ms-prompt');
  if (promptEl) promptEl.value = p.systemPrompt || '';
  var memEl = document.getElementById('assistant-ms-memory-model');
  if (memEl) {
    var disp = p.memoryModel || '';
    memEl.textContent = disp ? disp : t('assistantMSMemoryModelFollow');
    memEl.setAttribute('data-value', disp);
  }
  ASSISTANT_MS_PARAMS.forEach(function(k) {
    if (k.kind === 'reasoning_toggle') {
      var pvR = p.params[k.key];
      var onR = false;
      if (pvR) {
        if (typeof pvR.value === 'boolean') onR = !!pvR.value;
        else onR = !!pvR.enabled;
      }
      var cbR2 = document.getElementById('assistant-ms-enable-' + k.key);
      if (cbR2) cbR2.checked = onR;
      return;
    }
    var pv = p.params[k.key] || { enabled: false, value: k.def };
    var cb = document.getElementById('assistant-ms-enable-' + k.key);
    if (cb) cb.checked = !!pv.enabled;
    if (k.kind === 'reasoning_effort') {
      var s2 = document.getElementById('assistant-ms-val-' + k.key);
      if (s2) {
        s2.value = String(pv.value || k.def);
        var wrap2 = document.getElementById('assistant-ms-wrap-' + k.key);
        if (wrap2) {
          var lbl = s2.value;
          var le2 = wrap2.querySelector('.custom-select-label');
          if (le2) le2.textContent = lbl;
        }
        // Hidden select disabled still; visual wrap opacity tracks enabled.
        if (wrap2) wrap2.style.opacity = pv.enabled ? '1' : '0.5';
      }
    } else if (k.kind === 'stepper') {
      var inp3 = document.getElementById('assistant-ms-val-' + k.key);
      if (inp3) {
        inp3.value = String(pv.value);
        inp3.disabled = !pv.enabled;
        // Also disable stepper buttons visually
        var wrapS = inp3.closest('.number-stepper');
        if (wrapS) wrapS.style.opacity = pv.enabled ? '1' : '0.5';
      }
    } else {
      var inp = document.getElementById('assistant-ms-val-' + k.key);
      if (inp) inp.disabled = !pv.enabled;
    }
  });
}

// Portaled body-anchored menu for reasoning_effort (escapes modal clip).
var __assistantMSEffortMenuOpen = false;
var __assistantMSEffortCloseHandler = null;
function assistantMSCloseEffortMenu() {
  var m = document.getElementById('assistant-ms-effort-portal');
  if (m) m.style.display = 'none';
  var wrap = document.getElementById('assistant-ms-wrap-reasoning_effort');
  if (wrap) wrap.classList.remove('open');
  __assistantMSEffortMenuOpen = false;
  if (__assistantMSEffortCloseHandler) {
    document.removeEventListener('click', __assistantMSEffortCloseHandler, true);
    window.removeEventListener('resize', __assistantMSEffortCloseHandler);
    __assistantMSEffortCloseHandler = null;
  }
}
function assistantMSToggleEffortMenu(e) {
  if (e) e.stopPropagation();
  var wrap = document.getElementById('assistant-ms-wrap-reasoning_effort');
  var sel = document.getElementById('assistant-ms-val-reasoning_effort');
  var cb = document.getElementById('assistant-ms-enable-reasoning_effort');
  if (wrap && cb && !cb.checked) return;
  if (__assistantMSEffortMenuOpen) { assistantMSCloseEffortMenu(); return; }
  var portal = document.getElementById('assistant-ms-effort-portal');
  if (!portal) {
    portal = document.createElement('div');
    portal.id = 'assistant-ms-effort-portal';
    portal.style.cssText = 'position:fixed;z-index:10025;display:none;min-width:150px;max-height:220px;overflow-y:auto;background:var(--surface-overlay, #1a1a2e);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid var(--accent, #00d4aa);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.4);padding:4px 0;box-sizing:border-box;';
    document.body.appendChild(portal);
    ['none','minimal','low','medium','high','xhigh'].forEach(function(v){
      var d = document.createElement('div');
      d.className = 'custom-select-option';
      d.dataset.value = v;
      d.innerHTML = '<span class="custom-select-option-link" style="display:block;padding:8px 14px;color:var(--text,#e2e8f0);font-size:13px;cursor:pointer">' + v + '</span>';
      d.addEventListener('click', function(ev){
        ev.stopPropagation();
        if (sel) { sel.value = v; sel.dispatchEvent(new Event('change')); }
        if (wrap) { var lbl = wrap.querySelector('.custom-select-label'); if (lbl) lbl.textContent = v; }
        portal.querySelectorAll('.custom-select-option').forEach(function(o){
          o.classList.toggle('selected', o.dataset.value === v);
        });
        assistantMSCloseEffortMenu();
      });
      portal.appendChild(d);
    });
  }
  // Position directly under trigger
  var trigger = wrap ? wrap.querySelector('.custom-select-trigger') : wrap;
  var rect = (trigger || wrap).getBoundingClientRect();
  portal.style.left = rect.left + 'px';
  portal.style.width = rect.width + 'px';
  // Measure portal height first
  portal.style.display = 'block';
  var ph = portal.offsetHeight || 160;
  var topBelow = rect.bottom + 4;
  var topAbove = rect.top - ph - 4;
  var useBelow = topBelow + ph <= window.innerHeight - 8;
  portal.style.top = (useBelow ? topBelow : Math.max(8, topAbove)) + 'px';
  portal.style.display = 'block';
  // Selected highlight
  var curVal = sel ? sel.value : 'medium';
  portal.querySelectorAll('.custom-select-option').forEach(function(o){
    o.classList.toggle('selected', o.dataset.value === curVal);
  });
  if (wrap) wrap.classList.add('open');
  __assistantMSEffortMenuOpen = true;
  __assistantMSEffortCloseHandler = function(ev){
    if (ev.type === 'resize') { assistantMSCloseEffortMenu(); return; }
    if (portal.contains(ev.target) || (wrap && wrap.contains(ev.target))) return;
    assistantMSCloseEffortMenu();
  };
  setTimeout(function(){
    document.addEventListener('click', __assistantMSEffortCloseHandler, true);
    window.addEventListener('resize', __assistantMSEffortCloseHandler);
  }, 0);
}

function assistantMSToggleParam(key) {
  // reasoning toggle has no value input
  var k = ASSISTANT_MS_PARAMS.find(function(x){ return x.key===key; });
  if (k && k.kind === 'reasoning_toggle') return;
  var cb = document.getElementById('assistant-ms-enable-' + key);
  var enabled = cb ? !!cb.checked : false;
  var inp = document.getElementById('assistant-ms-val-' + key);
  var wrap = document.getElementById('assistant-ms-wrap-' + key);
  if (inp) {
    inp.disabled = !enabled;
    var stepperWrap = inp.closest('.number-stepper');
    if (stepperWrap) stepperWrap.style.opacity = enabled ? '1' : '0.5';
  }
  if (wrap) wrap.style.opacity = enabled ? '1' : '0.5';
}

function assistantMSParamRowHtml(k) {
  var toggle = '<label class="toggle-switch"><input type="checkbox" id="assistant-ms-enable-' + k.key + '" onchange="assistantMSToggleParam(\'' + k.key + '\', this.checked)"><span class="toggle-slider"></span></label>';
  // reasoning is enable-only: no separate value input
  if (k.kind === 'reasoning_toggle') {
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--glass-border)">' +
      '<span style="flex:1;font-size:13px">' + k.label + '</span>' +
      toggle +
      '<span style="width:160px"></span>' +
    '</div>';
  }
  var inputHtml = '';
  if (k.kind === 'stepper') {
    if (typeof renderStepperHtml === 'function') {
      inputHtml = renderStepperHtml('assistant-ms-val-' + k.key, k.def, { min: k.min, max: k.max, step: k.step, style: 'width:160px' });
    } else {
      inputHtml = '<input type="number" class="input" id="assistant-ms-val-' + k.key + '" value="' + k.def + '" min="' + k.min + '" max="' + k.max + '" step="' + k.step + '" style="width:110px"> ';
    }
  } else if (k.kind === 'reasoning_effort') {
    // Portaled menu: keep label + hidden select, trigger opens body-anchored portal
    inputHtml = '<div class="custom-select-wrapper" id="assistant-ms-wrap-' + k.key + '" style="width:150px;position:relative" onclick="event.stopPropagation()">' +
      '<div class="custom-select-trigger" onclick="assistantMSToggleEffortMenu(event)">' +
        '<span class="custom-select-label">' + (k.def || 'medium') + '</span>' +
        '<svg viewBox="0 0 512 512"><path d="M233.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L256 338.7 77.7 160.3c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z"/></svg>' +
      '</div>' +
      '<select id="' + 'assistant-ms-val-' + k.key + '" style="display:none"><option value="none">none</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select>' +
    '</div>';
  }
  return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--glass-border)">' +
    '<span style="flex:1;font-size:13px">' + k.label + '</span>' +
    toggle +
    '<span style="width:160px;display:flex;justify-content:flex-end">' + inputHtml + '</span>' +
  '</div>';
}

function openAssistantModelSettings() {
  fetch('/api/assistant/model-presets')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var presets = (data && Array.isArray(data.presets)) ? data.presets : [];
      if (!presets.length) {
        presets = [{ name: 'default', params: assistantMSDefaultParams() }];
      } else {
        presets = presets.map(function(p) { return assistantMSClonePreset(p); });
      }
      var active = (data && data.active) || (presets[0] ? presets[0].name : 'default');
      __assistantMS = { active: active, presets: presets, sel: active };
      assistantMSRenderOverlay();
    })
    .catch(function(err) {
      if (typeof toast === 'function') toast('加载失败: ' + (err && err.message ? err.message : err));
    });
}

function assistantMSRenderOverlay() {
  var old = document.getElementById('assistant-ms-overlay');
  if (old) old.remove();

  var presetOpts = __assistantMS.presets.map(function(p) { return { value: p.name, label: p.name }; });

  var bodyHtml =
    '<div class="form-group"><label>' + escapeHtml(t('assistantMSPreset')) + '</label>' +
      '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">';

  if (typeof renderCustomSelectHtml === 'function') {
    bodyHtml += renderCustomSelectHtml('assistant-ms-preset-wrap', 'assistant-ms-preset-select', presetOpts, __assistantMS.sel, 'assistantMSSelectPreset(this.value)', 'flex:1;min-width:160px');
  } else {
    bodyHtml += '<select id="assistant-ms-preset-select" onchange="assistantMSSelectPreset(this.value)" style="flex:1;min-width:160px" class="input">';
    presetOpts.forEach(function(o) {
      bodyHtml += '<option value="' + escapeHtml(o.value) + '"' + (o.value === __assistantMS.sel ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>';
    });
    bodyHtml += '</select>';
  }
  bodyHtml +=
      '<button type="button" class="btn btn-ghost btn-sm" onclick="assistantMSAddPreset()">' + escapeHtml(t('assistantMSPresetAdd')) + '</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="assistantMSDeletePreset()" style="color:var(--danger,#e5484d)">' + escapeHtml(t('assistantMSPresetDelete')) + '</button>' +
      '</div></div>' +
    '<div class="form-group" style="margin-top:12px"><label>' + escapeHtml(t('assistantMSMemoryModel')) + '</label>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<button type="button" class="input" id="assistant-ms-memory-model" data-value="" onclick="assistantMSPickMemoryModel()" style="flex:1;text-align:left;cursor:pointer;display:flex;justify-content:space-between;align-items:center">' + escapeHtml(t('assistantMSMemoryModelFollow')) + ' <span style="opacity:0.5">\u25BC</span></button>' +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="assistantMSClearMemoryModel()" title="' + escapeHtml(t('assistantMSMemoryModelFollow')) + '">\u2715</button>' +
      '</div>' +
      '<p class="muted" style="margin-top:4px;font-size:12px">' + escapeHtml(t('assistantMSMemoryModelDesc') || '') + '</p>' +
    '</div>' +
    '<div class="form-group" style="margin-top:12px"><label>' + escapeHtml(t('assistantMSSystemPrompt')) + '</label>' +
      '<textarea class="input" id="assistant-ms-prompt" rows="5" style="width:100%;resize:vertical"></textarea>' +
    '</div>' +
    '<div class="form-group" style="margin-top:12px"><label>' + escapeHtml(t('assistantMSParams')) + '</label>' +
      '<div id="assistant-ms-params">' + ASSISTANT_MS_PARAMS.map(assistantMSParamRowHtml).join('') + '</div>' +
    '</div>';

  var overlay = document.createElement('div');
  overlay.id = 'assistant-ms-overlay';
  overlay.className = 'modal-overlay show';
  overlay.style.zIndex = 'calc(var(--z-modal, 1000) + 20)';
  overlay.innerHTML =
    '<div class="modal" style="min-width:520px;max-width:640px;max-height:85vh;display:flex;flex-direction:column">' +
      '<div class="modal-title">' + escapeHtml(t('assistantMSTitle')) + '</div>' +
      '<div class="modal-body" style="flex:1">' + bodyHtml + '</div>' +
      '<div class="modal-footer">' +
        '<button type="button" class="btn btn-ghost" onclick="closeAssistantMSOverlay()">' + escapeHtml(t('cancel')) + '</button>' +
        '<button type="button" class="btn btn-primary" id="assistant-ms-save">' + escapeHtml(t('save')) + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeAssistantMSOverlay();
  });
  var escHandler = function(e) {
    if (e.key === 'Escape') {
      // Let model picker handle its own Esc if open.
      if (document.getElementById('assistant-model-picker-overlay')) return;
      closeAssistantMSOverlay();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
  overlay._escHandler = escHandler;

  document.getElementById('assistant-ms-save').onclick = function() {
    var btn = this;
    if (typeof withLoading === 'function') {
      withLoading(btn, assistantMSSave);
    } else {
      assistantMSSave();
    }
  };

  // Load form for current selection.
  var cur = __assistantMS.presets.find(function(p) { return p.name === __assistantMS.sel; });
  if (cur) assistantMSLoadForm(cur);
}

function closeAssistantMSOverlay() {
  assistantMSCloseEffortMenu();
  var portal = document.getElementById('assistant-ms-effort-portal');
  if (portal) { try { portal.remove(); } catch(e) {} }
  var overlay = document.getElementById('assistant-ms-overlay');
  if (overlay) {
    if (overlay._escHandler) document.removeEventListener('keydown', overlay._escHandler);
    overlay.remove();
  }
}

function assistantMSSelectPreset(name) {
  assistantMSStashForm();
  __assistantMS.sel = name;
  var cur = __assistantMS.presets.find(function(p) { return p.name === name; });
  if (cur) assistantMSLoadForm(cur);
}

function assistantMSAddPreset() {
  var doAdd = function(name) {
    if (!name) return;
    name = String(name).trim();
    if (!name) return;
    if (__assistantMS.presets.some(function(p) { return p.name === name; })) {
      if (typeof toast === 'function') toast(name + ' exists');
      return;
    }
    assistantMSStashForm();
    __assistantMS.presets.push({ name: name, assistantName: '', systemPrompt: '', memoryModel: '', params: assistantMSDefaultParams() });
    __assistantMS.sel = name;
    assistantMSRenderOverlay();
  };
  if (typeof promptModal === 'function') {
    promptModal(t('assistantMSPresetNamePrompt'), '', '').then(function(v) { if (v) doAdd(v); });
  } else {
    var v = prompt(t('assistantMSPresetNamePrompt'));
    if (v) doAdd(v);
  }
}

function assistantMSDeletePreset() {
  if (!__assistantMS || __assistantMS.presets.length <= 1) {
    if (typeof toast === 'function') toast(t('assistantMSPresetDeleteLast') || 'At least one preset required');
    return;
  }
  var name = __assistantMS.sel;
  var doDelete = function() {
    var idx = -1;
    for (var i = 0; i < __assistantMS.presets.length; i++) {
      if (__assistantMS.presets[i].name === name) { idx = i; break; }
    }
    if (idx < 0) return;
    __assistantMS.presets.splice(idx, 1);
    __assistantMS.sel = __assistantMS.presets[0].name;
    if (__assistantMS.active === name) __assistantMS.active = __assistantMS.sel;
    assistantMSRenderOverlay();
  };
  var msg = t('assistantMSPresetDeleteConfirm', [name], 'Delete preset "' + name + '"?');
  if (typeof confirmModal === 'function') {
    confirmModal(msg).then(function(ok) { if (ok) doDelete(); });
  } else {
    if (confirm(msg)) doDelete();
  }
}

function assistantMSPickMemoryModel() {
  var btn = document.getElementById('assistant-ms-memory-model');
  var cur = btn ? (btn.getAttribute('data-value') || '') : '';
  if (typeof openAssistantModelPicker === 'function') {
    openAssistantModelPicker(cur, function(v) {
      var b = document.getElementById('assistant-ms-memory-model');
      if (!b) return;
      b.setAttribute('data-value', v || '');
      b.innerHTML = escapeHtml(v || t('assistantMSMemoryModelFollow')) + ' <span style="opacity:0.5">\u25BC</span>';
    });
  }
}

function assistantMSClearMemoryModel() {
  var btn = document.getElementById('assistant-ms-memory-model');
  if (!btn) return;
  btn.setAttribute('data-value', '');
  btn.innerHTML = escapeHtml(t('assistantMSMemoryModelFollow')) + ' <span style="opacity:0.5">\u25BC</span>';
}

function assistantMSSave() {
  assistantMSStashForm();
  var payload = {
    active: __assistantMS.sel,
    presets: __assistantMS.presets.map(function(p) {
      return {
        name: p.name,
        systemPrompt: p.systemPrompt || '',
        memoryModel: p.memoryModel || '',
        params: p.params || {}
      };
    })
  };
  return fetch('/api/assistant/model-presets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function(res) {
    if (!res.ok) {
      return res.json().then(function(d) {
        throw new Error((d && d.error) || ('HTTP ' + res.status));
      }).catch(function(e) {
        if (e && e.message && e.message.indexOf('HTTP') !== 0) throw e;
        throw new Error('HTTP ' + res.status);
      });
    }
    return res.json();
  }).then(function() {
    if (typeof toast === 'function') toast(t('assistantMSSaved'));
    closeAssistantMSOverlay();
  }).catch(function(err) {
    if (typeof toast === 'function') toast(err.message || String(err));
    throw err;
  });
}

// Helpers for outer modal (settings_modal.js) to share one preset list.
var __assistantMSCache = null;
// Lightweight persist for outer preset changes: best-effort, no await.
function __assistantMSPersistPresetChange(kind, name) {
  // kind: 'add' | 'update' | 'remove' — persist current outer list to inner store
  try {
    var presets = window.__assistantPresets || [];
    // Build inner-compatible payload from outer actions
    fetch('/api/assistant/model-presets').then(function(r){ return r.json(); }).then(function(cur){
      var existing = cur && Array.isArray(cur.presets) ? cur.presets : [];
      var byName = {};
      existing.forEach(function(p){ byName[p.name]=p; });
      if (kind === 'remove') {
        delete byName[name];
      } else if (kind === 'add' || kind === 'update') {
        var found = null;
        for (var i=0;i<presets.length;i++) if((presets[i].name||'').toLowerCase()===(name||'').toLowerCase()){ found=presets[i]; break; }
        if (found) {
          if (byName[found.name]) {
            byName[found.name].actions = (found.actions||[]).map(function(a){ return { name:a.name||'', spritesheetPath:a.spritesheetPath||'', cols:a.cols||1, rows:a.rows||1, frameStart:a.frameStart||0, frameEnd:(a.frameEnd!==undefined?a.frameEnd:0), fps:a.fps||8, mirror:!!a.mirror }; });
          } else {
            byName[found.name] = { name: found.name, systemPrompt:'', memoryModel:'', params: assistantMSDefaultParams(), actions: (found.actions||[]).map(function(a){ return { name:a.name||'', spritesheetPath:a.spritesheetPath||'', cols:a.cols||1, rows:a.rows||1, frameStart:a.frameStart||0, frameEnd:(a.frameEnd!==undefined?a.frameEnd:0), fps:a.fps||8, mirror:!!a.mirror }; }) };
          }
        }
      }
      var names = Object.keys(byName);
      if (!names.length) {
        // keep at least one if outer just deleted last one
        return;
      }
      var active = cur && cur.active ? cur.active : names[0];
      if (!byName[active]) active = names[0];
      var payloadPresets = names.map(function(n){ var p=byName[n]; return { name:p.name, systemPrompt:p.systemPrompt||'', memoryModel:p.memoryModel||'', params:p.params||{}, actions:p.actions||[] }; });
      fetch('/api/assistant/model-presets', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ active: active, presets: payloadPresets }) })
        .then(function(){ __assistantMSCache = { active: active, presets: payloadPresets.map(assistantMSClonePreset) }; })
        .catch(function(){});
    }).catch(function(){});
  } catch(e){}
}
function __assistantMSLoadForOuter() {
  if (__assistantMS && __assistantMS.presets) {
    __assistantMSCache = { active: __assistantMS.sel || __assistantMS.active, presets: __assistantMS.presets.map(assistantMSClonePreset) };
    return __assistantMSCache;
  }
  if (__assistantMSCache) return __assistantMSCache;
  // Synchronous XHR fallback: inner not yet opened this session.
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/assistant/model-presets', false);
    xhr.send(null);
    if (xhr.status >= 200 && xhr.status < 300) {
      var data = JSON.parse(xhr.responseText || '{}');
      var arr = Array.isArray(data.presets) ? data.presets.map(assistantMSClonePreset) : [];
      if (arr.length) {
        __assistantMSCache = { active: data.active || arr[0].name, presets: arr };
        return __assistantMSCache;
      }
    }
  } catch (e) {}
  return null;
}
async function __assistantMSSyncFromOuter(outerPresets) {
  // Merge outer sprite presets into inner store by name, preserving model settings fields.
  var cur = null;
  try {
    var r = await fetch('/api/assistant/model-presets');
    cur = await r.json();
  } catch (e) { cur = null; }
  var existing = (cur && Array.isArray(cur.presets)) ? cur.presets.map(assistantMSClonePreset) : [];
  var byName = {};
  existing.forEach(function(p) { byName[p.name] = p; });
  (outerPresets || []).forEach(function(op) {
    var nm = (op && op.name || '').trim();
    if (!nm) return;
    if (byName[nm]) {
      byName[nm].actions = (op.actions || []).map(function(a){
        return { name: a.name||'', spritesheetPath: a.spritesheetPath||'', cols: a.cols||1, rows: a.rows||1, frameStart: a.frameStart||0, frameEnd: (a.frameEnd!==undefined?a.frameEnd:0), fps: a.fps||8, mirror: !!a.mirror };
      });
    } else {
      byName[nm] = { name: nm, systemPrompt: '', memoryModel: '', params: assistantMSDefaultParams(), actions: (op.actions||[]).map(function(a){ return { name: a.name||'', spritesheetPath: a.spritesheetPath||'', cols: a.cols||1, rows: a.rows||1, frameStart: a.frameStart||0, frameEnd: (a.frameEnd!==undefined?a.frameEnd:0), fps: a.fps||8, mirror: !!a.mirror }; }) };
    }
  });
  // Keep presets that were deleted in outer? Yes, remove ones not in outer.
  var outerNames = {};
  (outerPresets || []).forEach(function(op){ if(op&&op.name) outerNames[String(op.name).trim()] = true; });
  var merged = existing.filter(function(p){ return outerNames[p.name]; });
  // Add any brand-new outer presets not yet in existing
  (outerPresets || []).forEach(function(op){
    var nm = op && op.name ? String(op.name).trim() : '';
    if (nm && !merged.some(function(m){ return m.name===nm; })) merged.push(byName[nm]);
  });
  if (!merged.length) return;
  var active = (cur && cur.active) || merged[0].name;
  if (!merged.some(function(m){ return m.name===active; })) active = merged[0].name;
  await fetch('/api/assistant/model-presets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: active, presets: merged.map(function(p){ return { name: p.name, systemPrompt: p.systemPrompt||'', memoryModel: p.memoryModel||'', params: p.params||{}, actions: p.actions||[] }; }) }) });
  __assistantMSCache = { active: active, presets: merged };
  if (__assistantMS) { __assistantMS.presets = merged.map(assistantMSClonePreset); __assistantMS.active = active; }
}
