// ===================== Combos Page =====================

var comboEditingModels = [];
var comboEditingDisabledModels = [];
var comboProvidersCache = null;
var comboSpeedCache = {};
var currentEditingComboId = null;

async function renderCombos(c) {
  showSkeleton(c, 3);
  const data = await apiGet('/combos');
  const combos = data.combos || [];
  c.innerHTML = '\
    <h2>' + t('combos') + '</h2>\
    <button type="button" class="btn btn-primary mb-12" onclick="showAddCombo()">' + t('addCombo') + '</button>\
    <div id="combo-list"></div>\
    <div id="combo-form" style="display:none"></div>';
  const list = document.getElementById('combo-list');
  if (combos.length === 0) {
    list.innerHTML = emptyState(t('noCombos'));
    return;
  }
  list.innerHTML = combos.map(function(cb) {
    var modelsStr = cb.models ? cb.models.join(', ') : 'none';
    var fullModelsText = t('models') + ' ' + modelsStr;
    return '\
    <div class="card combo-card' + (cb.disabled ? ' combo-disabled' : '') + '">\
      <div class="provider-card-row">\
        <div class="provider-card-left">\
          <span class="card-title copyable" data-name="' + escapeHtml(cb.name) + '" onclick="copyToClipboard(this.dataset.name, this.dataset.name)" data-tooltip="' + t('clickToCopy') + '">' + escapeHtml(cb.name) + '</span>\
        </div>\
        <div class="provider-card-actions">\
          <span class="badge provider-btn-col1 ' + (cb.disabled ? 'badge-inactive' : 'badge-active') + '">' + escapeHtml(cb.strategy) + '</span>\
          <button type="button" class="btn btn-sm provider-btn-col2" onclick="toggleComboDisabled(\'' + escapeForJsString(cb.id) + '\')">' + (cb.disabled ? t('enable') : t('disable')) + '</button>\
        </div>\
      </div>\
      <div class="provider-card-row mt-12">\
        <div class="provider-card-left">\
          <span class="muted card-left-models" data-tooltip="' + escapeHtml(fullModelsText) + '">' + escapeHtml(fullModelsText) + '</span>\
        </div>\
        <div class="provider-card-actions">\
          <button type="button" class="btn btn-sm provider-btn-col1" onclick="showEditCombo(\'' + escapeForJsString(cb.id) + '\')">' + t('edit') + '</button>\
          <button type="button" class="btn btn-sm btn-danger provider-btn-col2" onclick="deleteCombo(\'' + escapeForJsString(cb.id) + '\')">' + t('delete') + '</button>\
        </div>\
      </div>\
    </div>';
  }).join('');
}

async function toggleComboDisabled(id) {
  const data = await apiGet('/combos');
  const cb = (data.combos || []).find(function(x) { return x.id === id; });
  if (!cb) return;
  cb.disabled = !cb.disabled;
  await apiPut('/combos/' + id, cb);
  var settingsPanel = document.querySelector('.settings-panel-section');
  if (settingsPanel) {
    renderEndpoint(document.getElementById('page-content'));
  } else {
    renderCombos(document.getElementById('page-content'));
  }
  toast(cb.disabled ? t('comboDisabled') : t('comboEnabled'), 'success');
}

function showAddCombo() {
  var overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = '<div class="modal" style="max-width:520px">\
    <div class="modal-title">' + t('newCombo') + '</div>\
    <div class="form-group"><label for="c-name">' + t('name') + '</label><input id="c-name" class="input" placeholder="' + t('comboNamePlaceholder') + '"></div>\
    <div class="form-group"><label for="c-strategy">' + t('comboStrategy') + '</label>\
      ' + renderCustomSelectHtml('c-strategy-wrap', 'c-strategy', [
        { value: 'fallback', label: t('fallbackDesc') },
        { value: 'round-robin', label: t('roundRobinDesc') },
        { value: 'greedy-squirrel', label: t('greedySquirrelDesc') }
      ], 'fallback') + '\
    </div>\
    <div class="form-group"><label>' + t('comboModels') + '</label>\
      <div style="display:flex;gap:8px;margin-bottom:8px">\
        <button type="button" class="btn btn-sm" onclick="importModelsFromProvider(\'models\')">' + t('importFromProvider') + '</button>\
      </div>\
      <div id="c-models-list"></div>\
    </div>\
    <div id="greedy-squirrel-hint" class="form-group" style="display:none">\
      <p class="muted">' + t('greedySquirrelHint') + '</p>\
    </div>\
    <div class="modal-footer">\
      <button type="button" class="btn" onclick="closeModalOverlay()">' + t('cancel') + '</button>\
      <button type="button" class="btn btn-primary" onclick="withLoading(this, () => addCombo())">' + t('create') + '</button>\
    </div>\
  </div>';
  requestAnimationFrame(function() { overlay.classList.add('show'); });
  var sel = overlay.querySelector('#c-strategy');
  var hintBox = overlay.querySelector('#greedy-squirrel-hint');
  if (sel && hintBox) {
    function syncHint() {
      hintBox.style.display = (sel.value === 'greedy-squirrel') ? 'block' : 'none';
    }
    sel.addEventListener('change', syncHint);
    syncHint();
  }
  comboEditingModels = [];
  loadComboProvidersAndRender();
}

async function addCombo() {
  const models = comboEditingModels.slice();
  const c = {
    name: document.getElementById('c-name').value,
    strategy: document.getElementById('c-strategy').value,
    models: models
  };
  try {
    const result = await apiPost('/combos', c);
    if (result.error) {
      toast(result.error, 'error');
      return;
    }
    closeModalOverlay();
    toast(t('comboCreated'), 'success');
    renderEndpoint(document.getElementById('page-content'));
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

async function deleteCombo(id) {
  const ok = await confirmModal(t('confirmDeleteCombo'));
  if (!ok) return;
  await apiDelete('/combos/' + id);
  toast(t('comboDeleted'), 'success');
  renderEndpoint(document.getElementById('page-content'));
}

async function showEditCombo(id) {
  const data = await apiGet('/combos');
  const cb = (data.combos || []).find(function(x) { return x.id === id; });
  if (!cb) return;
  var overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = '<div class="modal" style="max-width:70vw;width:70vw">\
    <div class="modal-title">' + t('comboEdit') + '</div>\
    <div class="form-group"><label for="c-name">' + t('name') + '</label><input id="c-name" class="input" value="' + escapeHtml(cb.name) + '"></div>\
    <div class="form-group"><label for="c-strategy">' + t('comboStrategy') + '</label>\
      ' + renderCustomSelectHtml('cb-edit-strategy-wrap', 'c-strategy', [
        { value: 'fallback', label: t('fallbackDesc') },
        { value: 'round-robin', label: t('roundRobinDesc') },
        { value: 'greedy-squirrel', label: t('greedySquirrelDesc') }
      ], cb.strategy || 'fallback') + '\
    </div>\
    <div class="form-group"><label>' + t('comboModels') + '</label>\
      <div style="display:flex;gap:8px;margin-bottom:8px">\
        <button type="button" class="btn btn-sm" onclick="importModelsFromProvider(\'models\')">' + t('importFromProvider') + '</button>\
        <button type="button" class="btn btn-sm" id="combo-speed-test-btn" onclick="runComboSpeedTest(\'' + escapeForJsString(id) + '\')">' + t('comboSpeedTest') + '</button>\
        <span id="combo-speed-test-status" style="margin-left:8px;font-size:12px;"></span>\
      </div>\
      <div id="c-models-list"></div>\
    </div>\
    <div id="greedy-squirrel-hint" class="form-group" style="display:none">\
      <p class="muted">' + t('greedySquirrelHint') + '</p>\
    </div>\
    <div class="modal-footer">\
      <button type="button" class="btn" onclick="closeModalOverlay()">' + t('cancel') + '</button>\
      <button type="button" class="btn btn-primary" onclick="withLoading(this, () => saveEditCombo(\'' + escapeForJsString(id) + '\'))">' + t('saveCombo') + '</button>\
    </div>\
  </div>';
  requestAnimationFrame(function() { overlay.classList.add('show'); });
  var sel = overlay.querySelector('#c-strategy');
  var hintBox = overlay.querySelector('#greedy-squirrel-hint');
  if (sel && hintBox) {
    function syncHint() {
      hintBox.style.display = (sel.value === 'greedy-squirrel') ? 'block' : 'none';
    }
    sel.addEventListener('change', syncHint);
    syncHint();
  }
  comboEditingModels = (cb.models || []).slice();
  comboEditingDisabledModels = (cb.disabledModels || []).slice();
  currentEditingComboId = id;
  loadComboProvidersAndRender();
  apiGet('/combos/' + id + '/speed-results').then(function(data) {
    if (data && data.results && data.results.length > 0) {
      comboSpeedCache[id] = data.results;
      renderComboModelsList();
    }
  }).catch(function() {});
}

async function saveEditCombo(id) {
  const models = comboEditingModels.slice();
  const c = {
    name: document.getElementById('c-name').value,
    strategy: document.getElementById('c-strategy').value,
    models: models,
    disabledModels: comboEditingDisabledModels
  };
  await apiPut('/combos/' + id, c);
  closeModalOverlay();
  toast(t('comboUpdated'), 'success');
  renderEndpoint(document.getElementById('page-content'));
}

async function importModelsFromProvider(target) {
  importTarget = target || 'models';
  openModelSelectorModal({
    initialSelected: comboEditingModels,
    includeCombos: false,
    onConfirm: function(selected) {
      for (var k = 0; k < selected.length; k++) {
        if (comboEditingModels.indexOf(selected[k]) < 0) comboEditingModels.push(selected[k]);
      }
      renderComboModelsList();
    }
  });
}

function toggleImportModel(el) {
  el.classList.toggle('selected');
}

async function loadComboProvidersAndRender() {
  if (!comboProvidersCache) {
    var data = await apiGet('/providers');
    comboProvidersCache = (data.providers || []);
  }
  renderComboModelsList();
}

function findProviderByPrefix(prefix) {
  if (!comboProvidersCache) return null;
  for (var i = 0; i < comboProvidersCache.length; i++) {
    if (comboProvidersCache[i].prefix === prefix) return comboProvidersCache[i];
  }
  return null;
}

function renderComboModelsList() {
  var container = document.getElementById('c-models-list');
  if (!container) return;
  var displayModels = comboEditingModels.slice();
  var extraDisabled = [];
  for (var d = 0; d < comboEditingDisabledModels.length; d++) {
    var m = comboEditingDisabledModels[d];
    if (displayModels.indexOf(m) < 0) extraDisabled.push(m);
  }
  displayModels = displayModels.concat(extraDisabled);
  if (displayModels.length === 0) {
    container.innerHTML = emptyState(t('noModels'));
    return;
  }
  var html = '';
  for (var i = 0; i < displayModels.length; i++) {
    var fullId = displayModels[i];
    var slashIdx = fullId.indexOf('/');
    var prefix = slashIdx > 0 ? fullId.substring(0, slashIdx) : '';
    var modelId = slashIdx > 0 ? fullId.substring(slashIdx + 1) : fullId;
    var provider = findProviderByPrefix(prefix);
    var pid = provider ? provider.id : '';
    var ts = modelTestStatus[modelId];
    var fullIdEsc = escapeHtml(fullId);
    var modelIdEsc = escapeHtml(modelId);
    var isDisabled = comboEditingDisabledModels.indexOf(fullId) >= 0;
    var isInMain = comboEditingModels.indexOf(fullId) >= 0;
    var mainIdx = comboEditingModels.indexOf(fullId);
    var note = provider ? findModelNote(provider, modelId) : '';
    var noteAttr = note ? ' data-model-note="' + escapeHtml(note) + '"' : '';
    var hasNoteCls = note ? ' has-model-note' : '';
    var disabledRowCls = isDisabled ? ' combo-model-disabled' : '';
    var isFirst = mainIdx === 0;
    var isLast = mainIdx === comboEditingModels.length - 1;
    html += '<div class="model-row' + hasNoteCls + disabledRowCls + '" data-index="' + i + '" draggable="' + (isInMain ? 'true' : 'false') + '" id="combo-row-' + i + '" data-fullid="' + fullIdEsc + '">' +
      '<div class="model-row-main"' + noteAttr + '>' +
        '<span class="drag-handle" data-tooltip="' + t('dragToReorder') + '" draggable="false">⠿</span>' +
        (isDisabled && isInMain
          ? '<button type="button" class="btn btn-sm" onclick="toggleComboModelDisabled(' + mainIdx + ')">' + t('enable') + '</button>'
          : isDisabled
            ? '<button type="button" class="btn btn-sm" onclick="enableComboModel(\'' + escapeForJsString(fullId) + '\')">' + t('enable') + '</button>'
            : '<button type="button" class="btn btn-sm" onclick="toggleComboModelDisabled(' + mainIdx + ')">' + t('disable') + '</button>') +
        (isInMain ? '<button type="button" class="btn btn-sm ' + (ts ? (ts.ok ? 'btn-test-ok' : 'btn-test-err') : '') + '"' + (isDisabled ? ' disabled' : '') + ' onclick="withLoading(this, () => testComboModel(' + mainIdx + '))">' + t('test') + '</button>' : '') +
        (isInMain ? buildMiniProtocolBadges(ts, modelId) : '') +
        (isInMain ? '<button type="button" class="btn btn-sm ' + (isFirst ? 'disabled ' : '') + '" onclick="moveComboModel(' + mainIdx + ',' + (mainIdx - 1) + ')">' + t('moveUp') + '</button>' : '') +
        (isInMain ? '<button type="button" class="btn btn-sm ' + (isLast ? 'disabled ' : '') + '" onclick="moveComboModel(' + mainIdx + ',' + (mainIdx + 1) + ')">' + t('moveDown') + '</button>' : '') +
        (isInMain ? '<button type="button" class="btn btn-sm btn-danger" onclick="removeComboModel(' + mainIdx + ')">' + t('delete') + '</button>' : '') +
        '<span class="model-id copyable" onclick="copyToClipboard(\'' + escapeForJsString(fullId) + '\')" data-tooltip="' + t('clickToCopy') + '">' + fullIdEsc + '</span>' +
      '</div>' +
      '<span class="combo-speed-status" data-fullid="' + fullIdEsc + '"></span>' +
    '</div>';
  }
  container.innerHTML = html;
  attachComboRowDragHandlers(container);
  if (currentEditingComboId && comboSpeedCache[currentEditingComboId]) {
    var results = comboSpeedCache[currentEditingComboId];
    var resultMap = {};
    for (var ri = 0; ri < results.length; ri++) resultMap[results[ri].fullId] = results[ri];
    var statusSpans = container.querySelectorAll('.combo-speed-status');
    for (var si = 0; si < statusSpans.length; si++) {
      var span = statusSpans[si];
      var result = resultMap[span.getAttribute('data-fullid')];
      if (!result) continue;
      if (result.ok) {
        span.textContent = result.ttftMs + 'ms \u00b7 ' + (result.tokensPerSec ? result.tokensPerSec.toFixed(1) : '?') + ' tok/s \u00b7 ' + (result.score ? result.score.toFixed(1) : '?');
        span.classList.add('combo-speed-status-success');
        span.classList.remove('combo-speed-status-error');
      } else {
        span.textContent = 'ERROR: ' + (result.error || 'unknown');
        span.classList.add('combo-speed-status-error');
        span.classList.remove('combo-speed-status-success');
      }
    }
  }
}

var comboDragFromIndex = -1;

function attachComboRowDragHandlers(container) {
  var rows = container.querySelectorAll('.model-row');
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    row.addEventListener('dragstart', function(e) {
      comboDragFromIndex = parseInt(this.getAttribute('data-index'), 10);
      this.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(comboDragFromIndex)); } catch (err) {}
      }
    });
    row.addEventListener('dragend', function() {
      this.classList.remove('dragging');
      comboDragFromIndex = -1;
    });
    row.addEventListener('dragover', function(e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this.classList.add('drag-over');
    });
    row.addEventListener('dragleave', function() {
      this.classList.remove('drag-over');
    });
    row.addEventListener('drop', function(e) {
      e.preventDefault();
      this.classList.remove('drag-over');
      var to = parseInt(this.getAttribute('data-index'), 10);
      if (comboDragFromIndex >= 0 && comboDragFromIndex !== to) {
        moveComboModel(comboDragFromIndex, to);
      }
    });
  }
}

function moveComboModel(from, to) {
  if (from < 0 || from >= comboEditingModels.length) return;
  if (to < 0 || to >= comboEditingModels.length) return;
  if (from === to) return;
  var m = comboEditingModels.splice(from, 1)[0];
  comboEditingModels.splice(to, 0, m);
  renderComboModelsList();
}

function toggleComboModelDisabled(i) {
  var fullId = comboEditingModels[i];
  var idx = comboEditingDisabledModels.indexOf(fullId);
  if (idx >= 0) {
    comboEditingDisabledModels.splice(idx, 1);
  } else {
    comboEditingDisabledModels.push(fullId);
  }
  renderComboModelsList();
}

function enableComboModel(fullId) {
  var idx = comboEditingDisabledModels.indexOf(fullId);
  if (idx >= 0) comboEditingDisabledModels.splice(idx, 1);
  if (comboEditingModels.indexOf(fullId) < 0) comboEditingModels.push(fullId);
  renderComboModelsList();
}

async function testComboModel(idx) {
  var fullId = comboEditingModels[idx];
  if (!fullId) return;
  var slashIdx = fullId.indexOf('/');
  var prefix = slashIdx > 0 ? fullId.substring(0, slashIdx) : '';
  var modelId = slashIdx > 0 ? fullId.substring(slashIdx + 1) : fullId;
  var provider = findProviderByPrefix(prefix);
  if (!provider) {
    toast(t('modelTestFailed') + 'provider not found', 'error');
    return;
  }
  await testModelProtosSerial(provider.id, modelId, {
    onComplete: function(result) {
      if (!result.ok) {
        var err = '';
        for (var k in result) {
          if (result[k] && result[k].error) err = result[k].error;
        }
        toast(t('modelTestFailed') + (err || 'unknown error'), 'error');
      }
      renderComboModelsList();
    }
  });
}

function removeComboModel(idx) {
  comboEditingModels.splice(idx, 1);
  renderComboModelsList();
}

async function runComboSpeedTest(comboId) {
  var btn = document.getElementById('combo-speed-test-btn');
  var statusEl = document.getElementById('combo-speed-test-status');
  if (btn) { btn.disabled = true; btn.textContent = t('comboSpeedTesting'); }
  if (statusEl) statusEl.textContent = '';
  delete comboSpeedCache[comboId];
  var total = 0;
  var count = 0;
  var failedModels = [];
  const controller = new AbortController();
  const timeoutId = setTimeout(function() { controller.abort(); }, 60000);
  let reader;
  try {
    const resp = await fetch('/api/combos/' + comboId + '/speed-test', { method: 'POST', headers: { 'Accept': 'text/event-stream' }, signal: controller.signal });
    if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
    reader = resp.body.getReader();
    const decoder = new TextDecoder();
    var buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      var events = buffer.split('\n\n');
      buffer = events.pop();
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var lines = ev.split('\n');
        var eventType = '', dataStr = '';
        for (var j = 0; j < lines.length; j++) {
          if (lines[j].indexOf('event:') === 0) eventType = lines[j].slice(6).trim();
          else if (lines[j].indexOf('data:') === 0) dataStr += lines[j].slice(5).trim();
        }
        if (eventType === 'meta') {
          try { total = JSON.parse(dataStr).total; } catch (_) {}
          if (statusEl) statusEl.textContent = '0/' + total;
        } else if (eventType === 'model') {
          var r;
          try { r = JSON.parse(dataStr); } catch (_) { continue; }
          count++;
          if (statusEl) statusEl.textContent = count + '/' + total;
          var rows = document.querySelectorAll('#c-models-list .model-row');
          var targetRow = null;
          for (var ri = 0; ri < rows.length; ri++) {
            if (rows[ri].getAttribute('data-fullid') === r.fullId) { targetRow = rows[ri]; break; }
          }
          if (targetRow) {
            var statusSpan = targetRow.querySelector('.combo-speed-status');
            targetRow.classList.toggle('combo-speed-row-success', !!r.ok);
            targetRow.classList.toggle('combo-speed-row-error', !r.ok);
            if (statusSpan) {
              if (r.ok) {
                statusSpan.textContent = r.ttftMs + 'ms · ' + (r.tokensPerSec ? r.tokensPerSec.toFixed(1) : '?') + ' tok/s · ' + (r.score ? r.score.toFixed(1) : '?');
                statusSpan.classList.add('combo-speed-status-success');
                statusSpan.classList.remove('combo-speed-status-error');
              } else {
                statusSpan.textContent = 'ERROR: ' + (r.error || 'unknown');
                statusSpan.classList.add('combo-speed-status-error');
                statusSpan.classList.remove('combo-speed-status-success');
              }
            }
            if (!r.ok && failedModels.indexOf(r.fullId) < 0) failedModels.push(r.fullId);
          }
        } else if (eventType === 'done') {
          var summary;
          try { summary = JSON.parse(dataStr); } catch (_) { summary = {}; }
          if (summary.newModels) comboEditingModels = summary.newModels.slice();
          if (summary.newDisabled) comboEditingDisabledModels = summary.newDisabled.slice();
          if (summary.results) comboSpeedCache[comboId] = summary.results;
          renderComboModelsList();
          var newRows = document.querySelectorAll('#c-models-list .model-row');
          for (var nri = 0; nri < newRows.length; nri++) {
            var fullId = newRows[nri].getAttribute('data-fullid');
            if (failedModels.indexOf(fullId) >= 0) {
              newRows[nri].classList.add('combo-speed-row-error');
              newRows[nri].classList.remove('combo-speed-row-success');
              var newStatus = newRows[nri].querySelector('.combo-speed-status');
              if (newStatus) { newStatus.textContent = 'ERROR'; newStatus.classList.add('combo-speed-status-error'); newStatus.classList.remove('combo-speed-status-success'); }
            }
          }
          var ok = summary.ok || 0;
          var fail = summary.fail || 0;
          if (statusEl) { statusEl.textContent = t('comboSpeedTestDone', [ok, fail]); statusEl.classList.toggle('combo-speed-status-error', fail > 0); statusEl.classList.toggle('combo-speed-status-success', fail === 0); }
          if (btn) { btn.disabled = false; btn.textContent = t('comboSpeedTest'); }
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      if (statusEl) { statusEl.textContent = t('comboSpeedTestTimeout'); statusEl.classList.add('combo-speed-status-error'); }
    } else if (statusEl) {
      statusEl.textContent = e.message || String(e);
      statusEl.classList.add('combo-speed-status-error');
    }
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
    if (reader) reader.cancel().catch(function() {});
    if (btn) { btn.disabled = false; btn.textContent = t('comboSpeedTest'); }
  }
}
