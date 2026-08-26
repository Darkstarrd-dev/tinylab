// pg-image-inspire.js — text-only Prompt Inspire helper with preset prompts,
// batch (multi-prompt) generation, and an auto-growing input textarea.
(function () {
  'use strict';
  function helperModels() {
    return (pgState.models || []).filter(function (m) {
      if (!m) return false;
      var k = String(m.kind || '').toLowerCase();
      return k !== 'image' && k !== 'embedding';
    });
  }
  function jsonPrompt(raw) {
    var text = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    var obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('JSON object required');
    return { text: JSON.stringify(obj, null, 2), object: obj };
  }
  function delimiter() {
    return (typeof window.pgImagePromptDelimiter === 'string' && window.pgImagePromptDelimiter) || '<<<PROMPT>>>';
  }
  function splitGenerated(raw) {
    var d = delimiter();
    return String(raw || '').split(d).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
  }
  function presets() {
    var w = pgWin();
    var list = w && w.config && Array.isArray(w.config.imgInspirePresets) ? w.config.imgInspirePresets : [];
    return list.filter(function (p) { return String(p || '').trim().length > 0; });
  }
  function infinitySvgHtml() {
    return '<div class="pg-infinity-loader" id="pg-inspire-loader">' +
      '<svg preserveAspectRatio="xMidYMid meet" viewBox="0 0 187.3 93.7" style="width:140px;height:70px">' +
        '<path d="M93.9,46.4c9.3,9.5,13.8,17.9,23.5,17.9s17.5-7.8,17.5-17.5s-7.8-17.6-17.5-17.5c-9.7,0.1-13.3,7.2-22.1,17.1 c-8.9,8.8-15.7,17.9-25.4,17.9s-17.5-7.8-17.5-17.5s7.8-17.5,17.5-17.5S86.2,38.6,93.9,46.4z" stroke-miterlimit="10" stroke-linejoin="round" stroke-linecap="round" stroke-width="5" fill="none" id="outline" stroke="var(--accent, #10b981)"></path>' +
        '<path d="M93.9,46.4c9.3,9.5,13.8,17.9,23.5,17.9s17.5-7.8,17.5-17.5s-7.8-17.6-17.5-17.5c-9.7,0.1-13.3,7.2-22.1,17.1 c-8.9,8.8-15.7,17.9-25.4,17.9s-17.5-7.8-17.5-17.5s7.8-17.5,17.5-17.5S86.2,38.6,93.9,46.4z" stroke-miterlimit="10" stroke-linejoin="round" stroke-linecap="round" stroke-width="5" stroke="var(--accent, #10b981)" fill="none" opacity="0.15" id="outline-bg"></path>' +
      '</svg>' +
    '</div>';
  }
  function presetsHtml(list, editing) {
    var out = '<div class="pg-inspire-presets">';
    if (editing) {
      out += '<div class="pg-inspire-presets-head"><label>' + pgEscapeHtml(pgT('pgInspirePresets')) + '</label></div>' +
        '<textarea id="pg-inspire-presets-edit" class="pg-input pg-inspire-presets-edit" placeholder="' + pgEscapeAttr(pgT('pgInspirePresetsPlaceholder')) + '">' +
        pgEscapeHtml(list.join('\n')) + '</textarea>' +
        '<div class="pg-inspire-presets-actions">' +
          '<button class="pg-btn active" onclick="pgInspireSavePresets()">' + pgEscapeHtml(pgT('pgInspirePresetsSave')) + '</button>' +
          '<button class="pg-btn" onclick="pgInspireToggleEdit(false)">' + pgEscapeHtml(pgT('Cancel')) + '</button>' +
        '</div>';
    } else {
      out += '<div class="pg-inspire-presets-head"><label>' + pgEscapeHtml(pgT('pgInspirePresets')) + '</label>' +
        '<button class="pg-btn pg-inspire-presets-edit-btn" onclick="pgInspireToggleEdit(true)">' + pgEscapeHtml(pgT('pgInspirePresetsEdit')) + '</button></div>';
      if (!list.length) {
        out += '<div class="pg-inspire-preset-empty">' + pgEscapeHtml(pgT('pgInspirePresetsEmpty')) + '</div>';
      } else {
        out += '<div class="pg-inspire-preset-list">';
        list.forEach(function (p, i) {
          out += '<div class="pg-inspire-preset-item" onclick="pgInspireUsePreset(' + i + ')" title="' + pgEscapeAttr(p) + '">' + pgEscapeHtml(p) + '</div>';
        });
        out += '</div>';
      }
    }
    return out + '</div>';
  }
  function render(model, format, input, result, error, editingPresets) {
    var models = helperModels();
    var opts = models.map(function (m) { return '<option value="' + pgEscapeAttr(m.id) + '"' + (m.id === model ? ' selected' : '') + '>' + pgEscapeHtml(m.id) + '</option>'; }).join('');
    var list = presets();
    var out = '<div class="pg-modal-header"><span class="pg-modal-title">' + pgEscapeHtml(pgT('pgInspireTitle')) + '</span><button class="pg-modal-close" onclick="pgCloseModal()">✕</button></div><div class="pg-modal-body pg-inspire-body">';
    out += '<label>' + pgEscapeHtml(pgT('pgPromptHelperModel')) + '</label><select id="pg-inspire-model" onchange="pgInspireOnModel(this.value)">' + opts + '</select>';
    out += '<div class="pg-inspire-row2">';
    out += '<div class="pg-inspire-col"><label>' + pgEscapeHtml(pgT('pgInspireFormat')) + '</label><select id="pg-inspire-format"><option value="natural"' + (format === 'natural' ? ' selected' : '') + '>Natural</option><option value="tag"' + (format === 'tag' ? ' selected' : '') + '>Tag</option><option value="json"' + (format === 'json' ? ' selected' : '') + '>JSON</option></select></div>';
    out += '<div class="pg-inspire-col pg-inspire-col-batch"><label>' + pgEscapeHtml(pgT('pgInspireBatchCount')) + '</label>' +
      '<div class="number-stepper pg-inspire-batch-stepper" data-tooltip="' + pgEscapeAttr(pgT('pgImageSubmitCountTip')) + '">' +
        '<button type="button" class="stepper-btn stepper-minus" onclick="pgStepImageSubmitCount(-1)" tabindex="-1">-</button>' +
        '<input type="number" class="stepper-input" min="1" max="99" step="1" value="' + (typeof pgGetImageSubmitCount === 'function' ? pgGetImageSubmitCount() : 1) + '" onchange="pgOnImageSubmitCount(this.value)" aria-label="' + pgEscapeAttr(pgT('pgInspireBatchCount')) + '">' +
        '<button type="button" class="stepper-btn stepper-plus" onclick="pgStepImageSubmitCount(1)" tabindex="-1">+</button>' +
      '</div></div>';
    out += '</div>';
    out += presetsHtml(list, !!editingPresets);
    out += '<label>' + pgEscapeHtml(pgT('pgCurrentInput')) + '</label><div class="pg-inspire-input-wrap"><textarea id="pg-inspire-input" class="pg-input" oninput="pgInspireAutosize()">' + pgEscapeHtml(input || '') + '</textarea>' + infinitySvgHtml() + '</div>';
    if (error) out += '<div class="pg-inspire-error">' + pgEscapeHtml(error) + '</div>';
    if (result != null) out += '<label>' + pgEscapeHtml(pgT('pgGeneratedPrompt')) + '</label><pre class="pg-inspire-preview">' + pgEscapeHtml(result) + '</pre><div class="pg-modal-footer"><button class="pg-btn" onclick="pgImageInspireGenerate()">' + pgEscapeHtml(pgT('pgRegenerate')) + '</button><button class="pg-btn active" onclick="pgImageInspireApply()">' + pgEscapeHtml(pgT('pgApplyToInput')) + '</button><button class="pg-btn" onclick="pgCloseModal()">' + pgEscapeHtml(pgT('Cancel')) + '</button></div>';
    else out += '<div class="pg-modal-footer"><button class="pg-btn active" onclick="pgImageInspireGenerate()">' + pgEscapeHtml(pgT('pgGenerateInspiration')) + '</button><button class="pg-btn" onclick="pgCloseModal()">' + pgEscapeHtml(pgT('Cancel')) + '</button></div>';
    return out + '</div>';
  }
  window.pgInspireAutosize = function () {
    var ta = document.getElementById('pg-inspire-input');
    if (!ta) return;
    ta.style.height = 'auto';
    // Textarea grows with content until the modal reaches ~80% of the window
    // height (chrome around the textarea ≈ 280px), then it scrolls.
    var cap = Math.max(160, Math.floor((window.innerHeight || 800) * 0.8) - 280);
    ta.style.height = Math.min(ta.scrollHeight, cap) + 'px';
    ta.style.overflowY = ta.scrollHeight > cap ? 'auto' : 'hidden';
  };
  window.pgOpenImageInspire = function () {
    var w = pgWin(), model = w && w.config.imgPromptModel || '', input = (document.getElementById('pg-input') || {}).value || '';
    if (!helperModels().length || !model) { pgToast(pgT('pgPromptHelperRequired'), 'warning'); return; }
    pgShowModal(render(model, 'natural', input, null, '', false));
    setTimeout(pgInspireAutosize, 0);
  };
  window.pgInspireOnModel = function (v) {
    var w = pgWin();
    if (w && w.config) { w.config.imgPromptModel = v; pgSave(); }
  };
  window.pgInspireUsePreset = function (i) {
    var list = presets();
    var ta = document.getElementById('pg-inspire-input');
    if (!ta || i < 0 || i >= list.length) return;
    ta.value = list[i];
    pgInspireAutosize();
  };
  window.pgInspireToggleEdit = function (editing) {
    var model = (document.getElementById('pg-inspire-model') || {}).value || '', format = (document.getElementById('pg-inspire-format') || {}).value || 'natural', input = (document.getElementById('pg-inspire-input') || {}).value || '';
    var preview = document.querySelector('.pg-inspire-preview');
    pgShowModal(render(model, format, input, preview ? preview.textContent : null, '', editing));
    setTimeout(pgInspireAutosize, 0);
  };
  window.pgInspireSavePresets = function () {
    var ta = document.getElementById('pg-inspire-presets-edit');
    var w = pgWin();
    if (!ta || !w || !w.config) return;
    w.config.imgInspirePresets = String(ta.value || '').split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
    pgSave();
    pgInspireToggleEdit(false);
  };
  window.pgImageInspireGenerate = function () {
    var model = (document.getElementById('pg-inspire-model') || {}).value || '', format = (document.getElementById('pg-inspire-format') || {}).value || 'natural', input = (document.getElementById('pg-inspire-input') || {}).value || '';
    if (!model) { pgToast(pgT('pgPromptHelperRequired'), 'warning'); return; }
    var batchCount = (typeof pgGetImageSubmitCount === 'function') ? pgGetImageSubmitCount() : 1;
    var loader = document.getElementById('pg-inspire-loader');
    if (loader) loader.classList.add('active');
    var instruction;
    if (batchCount > 1) {
      instruction = 'Generate exactly ' + batchCount + ' DIFFERENT image prompts based on the user input. ' +
        'Each prompt must be a self-contained ' + (format === 'json' ? 'JSON object with subject, action, environment, composition, style, lighting, quality, negative' : (format === 'tag' ? 'comma-separated image tag list' : 'natural-language image prompt')) + '. ' +
        'Separate consecutive prompts with a line containing only ' + delimiter() + ' and nothing else. ' +
        'Return ONLY the prompts and the separators — no numbering, no explanations, no Markdown fences.';
    } else {
      instruction = format === 'json' ? 'Return only valid JSON object with subject, action, environment, composition, style, lighting, quality, negative.' : (format === 'tag' ? 'Return only comma-separated image tags.' : 'Return only a polished natural-language image prompt.');
    }
    var body = { model: model, messages: [{ role: 'system', content: instruction }, { role: 'user', content: input.trim() || 'Create a random image prompt.' }], temperature: 0.8, stream: false };
    fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tinyrouter-Source': 'playground' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.error && (data.error.message || data.error)) || ('HTTP ' + r.status));
        return data;
      });
    }).then(function (res) {
      var raw = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content || res && res.content || '';
      var parsed = format === 'json' && batchCount === 1 ? jsonPrompt(raw) : { text: String(raw).replace(/^```[\s\S]*?\n|```$/g, '').trim() };
      if (!parsed.text) throw new Error(pgT('pgInspireEmpty'));
      if (batchCount > 1) {
        var parts = splitGenerated(parsed.text);
        if (!parts.length) throw new Error(pgT('pgInspireEmpty'));
        if (parts.length < batchCount) pgToast(pgT('pgInspireBatchShort').replace('{n}', String(parts.length)), 'warning');
        // Batch mode: all generated prompts stay visible in the input box,
        // separated by the same semantic delimiter the task queue splits on.
        var ta = document.getElementById('pg-inspire-input');
        if (ta) {
          ta.value = parts.join('\n' + delimiter() + '\n');
          pgInspireAutosize();
        }
        pgShowModal(render(model, format, ta ? ta.value : parsed.text, null, '', false));
        setTimeout(pgInspireAutosize, 0);
      } else {
        pgShowModal(render(model, format, input, parsed.text, '', false));
        setTimeout(pgInspireAutosize, 0);
      }
    }).catch(function (e) {
      pgShowModal(render(model, format, input, null, e.message || String(e), false));
      setTimeout(pgInspireAutosize, 0);
    }).finally(function () {
      if (loader) loader.classList.remove('active');
    });
  };
  window.pgImageInspireQuick = function () {
    var w = pgWin(), model = w && w.config.imgPromptModel || '';
    if (!helperModels().length || !model) {
      pgToast(pgT('pgPromptHelperRequired'), 'warning');
      return;
    }
    var ta = document.getElementById('pg-input');
    var input = ta ? ta.value : '';
    var loader = document.getElementById('pg-main-input-loader');
    if (loader) loader.classList.add('active');

    var instruction = 'Return only a polished natural-language image prompt.';
    var body = {
      model: model,
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: input.trim() || 'Create a random image prompt.' }
      ],
      temperature: 0.8,
      stream: false
    };

    fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tinyrouter-Source': 'playground' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.error && (data.error.message || data.error)) || ('HTTP ' + r.status));
        return data;
      });
    }).then(function (res) {
      var raw = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content || res && res.content || '';
      var text = String(raw).replace(/^```[\s\S]*?\n|```$/g, '').trim();
      if (!text) throw new Error(pgT('pgInspireEmpty'));
      if (ta) {
        ta.value = text;
        ta.focus();
        try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      }
      if (w && w.config) {
        w.config.prompt = text;
        pgSave();
      }
      pgToast(pgT('pgInspireQuickDone'), 'success');
    }).catch(function (e) {
      pgToast(e.message || String(e), 'error');
    }).finally(function () {
      if (loader) loader.classList.remove('active');
    });
  };
  window.pgImageInspireApply = function () {
    var preview = document.querySelector('.pg-inspire-preview'), fmt = (document.getElementById('pg-inspire-format') || {}).value || 'natural';
    var inputTa = document.getElementById('pg-inspire-input');
    // Batch mode has no preview: the delimiter-joined prompts live in the
    // input textarea and that is what gets applied.
    var value = preview ? preview.textContent : (inputTa ? inputTa.value : '');
    if (fmt === 'json' && !value.includes(delimiter())) { try { jsonPrompt(value); } catch (e) { pgToast(pgT('pgInspireInvalidJson'), 'error'); return; } }
    var ta = document.getElementById('pg-input');
    if (ta) {
      ta.value = value;
      ta.focus();
      try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    }
    var w = pgWin();
    if (w && w.config) {
      w.config.prompt = value;
      pgSave();
    }
    pgCloseModal();
  };
})();
