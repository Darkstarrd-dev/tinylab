// pg-image-inspire.js — text-only Prompt Inspire helper.
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
  function render(model, format, input, result, error) {
    var models = helperModels();
    var opts = models.map(function (m) { return '<option value="' + pgEscapeAttr(m.id) + '"' + (m.id === model ? ' selected' : '') + '>' + pgEscapeHtml(m.id) + '</option>'; }).join('');
    var infinitySvgHtml =
      '<div class="pg-infinity-loader" id="pg-inspire-loader">' +
        '<svg preserveAspectRatio="xMidYMid meet" viewBox="0 0 187.3 93.7" style="width:140px;height:70px">' +
          '<path d="M93.9,46.4c9.3,9.5,13.8,17.9,23.5,17.9s17.5-7.8,17.5-17.5s-7.8-17.6-17.5-17.5c-9.7,0.1-13.3,7.2-22.1,17.1 c-8.9,8.8-15.7,17.9-25.4,17.9s-17.5-7.8-17.5-17.5s7.8-17.5,17.5-17.5S86.2,38.6,93.9,46.4z" stroke-miterlimit="10" stroke-linejoin="round" stroke-linecap="round" stroke-width="5" fill="none" id="outline" stroke="var(--accent, #10b981)"></path>' +
          '<path d="M93.9,46.4c9.3,9.5,13.8,17.9,23.5,17.9s17.5-7.8,17.5-17.5s-7.8-17.6-17.5-17.5c-9.7,0.1-13.3,7.2-22.1,17.1 c-8.9,8.8-15.7,17.9-25.4,17.9s-17.5-7.8-17.5-17.5s7.8-17.5,17.5-17.5S86.2,38.6,93.9,46.4z" stroke-miterlimit="10" stroke-linejoin="round" stroke-linecap="round" stroke-width="5" stroke="var(--accent, #10b981)" fill="none" opacity="0.15" id="outline-bg"></path>' +
        '</svg>' +
      '</div>';

    var out = '<div class="pg-modal-header"><span class="pg-modal-title">' + pgEscapeHtml(pgT('pgInspireTitle')) + '</span><button class="pg-modal-close" onclick="pgCloseModal()">✕</button></div><div class="pg-modal-body pg-inspire-body">';
    out += '<label>' + pgEscapeHtml(pgT('pgPromptHelperModel')) + '</label><select id="pg-inspire-model">' + opts + '</select><label>' + pgEscapeHtml(pgT('pgInspireFormat')) + '</label><select id="pg-inspire-format"><option value="natural"' + (format === 'natural' ? ' selected' : '') + '>Natural</option><option value="tag"' + (format === 'tag' ? ' selected' : '') + '>Tag</option><option value="json"' + (format === 'json' ? ' selected' : '') + '>JSON</option></select><label>' + pgEscapeHtml(pgT('pgCurrentInput')) + '</label><div class="pg-inspire-input-wrap"><textarea id="pg-inspire-input" class="pg-input">' + pgEscapeHtml(input || '') + '</textarea>' + infinitySvgHtml + '</div>';
    if (error) out += '<div class="pg-inspire-error">' + pgEscapeHtml(error) + '</div>';
    if (result != null) out += '<label>' + pgEscapeHtml(pgT('pgGeneratedPrompt')) + '</label><pre class="pg-inspire-preview">' + pgEscapeHtml(result) + '</pre><div class="pg-modal-footer"><button class="pg-btn" onclick="pgImageInspireGenerate()">' + pgEscapeHtml(pgT('pgRegenerate')) + '</button><button class="pg-btn active" onclick="pgImageInspireApply()">' + pgEscapeHtml(pgT('pgApplyToInput')) + '</button><button class="pg-btn" onclick="pgCloseModal()">' + pgEscapeHtml(pgT('Cancel')) + '</button></div>';
    else out += '<div class="pg-modal-footer"><button class="pg-btn active" onclick="pgImageInspireGenerate()">' + pgEscapeHtml(pgT('pgGenerateInspiration')) + '</button><button class="pg-btn" onclick="pgCloseModal()">' + pgEscapeHtml(pgT('Cancel')) + '</button></div>';
    return out + '</div>';
  }
  window.pgOpenImageInspire = function () {
    var w = pgWin(), model = w && w.config.imgPromptModel || '', input = (document.getElementById('pg-input') || {}).value || '';
    if (!helperModels().length || !model) { pgToast(pgT('pgPromptHelperRequired'), 'warning'); return; }
    pgShowModal(render(model, 'natural', input, null, ''));
  };
  window.pgImageInspireGenerate = function () {
    var model = (document.getElementById('pg-inspire-model') || {}).value || '', format = (document.getElementById('pg-inspire-format') || {}).value || 'natural', input = (document.getElementById('pg-inspire-input') || {}).value || '';
    if (!model) { pgToast(pgT('pgPromptHelperRequired'), 'warning'); return; }
    var loader = document.getElementById('pg-inspire-loader');
    if (loader) loader.classList.add('active');
    var instruction = format === 'json' ? 'Return only valid JSON object with subject, action, environment, composition, style, lighting, quality, negative.' : (format === 'tag' ? 'Return only comma-separated image tags.' : 'Return only a polished natural-language image prompt.');
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
      var parsed = format === 'json' ? jsonPrompt(raw) : { text: String(raw).replace(/^```[\s\S]*?\n|```$/g, '').trim() };
      if (!parsed.text) throw new Error(pgT('pgInspireEmpty'));
      pgShowModal(render(model, format, input, parsed.text, ''));
    }).catch(function (e) {
      pgShowModal(render(model, format, input, null, e.message || String(e)));
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
      pgToast('提示词灵感生成成功', 'success');
    }).catch(function (e) {
      pgToast(e.message || String(e), 'error');
    }).finally(function () {
      if (loader) loader.classList.remove('active');
    });
  };
  window.pgImageInspireApply = function () {
    var preview = document.querySelector('.pg-inspire-preview'), fmt = (document.getElementById('pg-inspire-format') || {}).value || 'natural', value = preview ? preview.textContent : '';
    if (fmt === 'json') { try { jsonPrompt(value); } catch (e) { pgToast(pgT('pgInspireInvalidJson'), 'error'); return; } }
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
