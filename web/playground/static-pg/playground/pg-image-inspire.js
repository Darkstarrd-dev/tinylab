// pg-image-inspire.js — text-only Prompt Inspire helper.
(function () {
  'use strict';
  function helperModels() { return (pgState.models || []).filter(function (m) { return m && m.kind === 'text'; }); }
  function jsonPrompt(raw) {
    var text = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    var obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('JSON object required');
    return { text: JSON.stringify(obj, null, 2), object: obj };
  }
  function render(model, format, input, result, error) {
    var models = helperModels();
    var opts = models.map(function (m) { return '<option value="' + pgEscapeAttr(m.id) + '"' + (m.id === model ? ' selected' : '') + '>' + pgEscapeHtml(m.id) + '</option>'; }).join('');
    var out = '<div class="pg-modal-header"><span class="pg-modal-title">' + pgEscapeHtml(pgT('pgInspireTitle')) + '</span><button class="pg-modal-close" onclick="pgCloseModal()">✕</button></div><div class="pg-modal-body pg-inspire-body">';
    out += '<label>' + pgEscapeHtml(pgT('pgPromptHelperModel')) + '</label><select id="pg-inspire-model">' + opts + '</select><label>' + pgEscapeHtml(pgT('pgInspireFormat')) + '</label><select id="pg-inspire-format"><option value="natural"' + (format === 'natural' ? ' selected' : '') + '>Natural</option><option value="tag"' + (format === 'tag' ? ' selected' : '') + '>Tag</option><option value="json"' + (format === 'json' ? ' selected' : '') + '>JSON</option></select><label>' + pgEscapeHtml(pgT('pgCurrentInput')) + '</label><textarea id="pg-inspire-input" class="pg-input">' + pgEscapeHtml(input || '') + '</textarea>';
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
    var instruction = format === 'json' ? 'Return only valid JSON object with subject, action, environment, composition, style, lighting, quality, negative.' : (format === 'tag' ? 'Return only comma-separated image tags.' : 'Return only a polished natural-language image prompt.');
    var body = { model: model, messages: [{ role: 'system', content: instruction }, { role: 'user', content: input.trim() || 'Create a random image prompt.' }], temperature: 0.8, stream: false };
    pgApiPost('/chat/completions', body).then(function (res) {
      var raw = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content || res && res.content || '';
      var parsed = format === 'json' ? jsonPrompt(raw) : { text: String(raw).replace(/^```[\s\S]*?\n|```$/g, '').trim() };
      if (!parsed.text) throw new Error(pgT('pgInspireEmpty'));
      pgShowModal(render(model, format, input, parsed.text, ''));
    }).catch(function (e) { pgShowModal(render(model, format, input, null, e.message || String(e))); });
  };
  window.pgImageInspireApply = function () {
    var preview = document.querySelector('.pg-inspire-preview'), fmt = (document.getElementById('pg-inspire-format') || {}).value || 'natural', value = preview ? preview.textContent : '';
    if (fmt === 'json') { try { jsonPrompt(value); } catch (e) { pgToast(pgT('pgInspireInvalidJson'), 'error'); return; } }
    var ta = document.getElementById('pg-input'); if (ta) { ta.value = value; ta.focus(); }
    pgCloseModal();
  };
})();
