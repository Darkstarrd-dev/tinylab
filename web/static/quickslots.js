// ===================== QuickSlots Page =====================

var quickSlotCache = [];
var qsEditingModels = [];
var qsEditingDisabledModels = [];
var qsProvidersCache = null;
var qsDragFromIndex = -1;

function renderQuickSlotListInline(quickslots) {
  var el = document.getElementById('quickslot-list');
  if (!el) return;
  var list = (quickslots || []).slice();
  list.sort(function(a, b) { return (a.order || 0) - (b.order || 0); });
  if (list.length === 0) {
    el.innerHTML = emptyState(t('noQuickSlots'));
    return;
  }
  el.innerHTML = list.map(function(qs) {
    var modelsStr = qs.models ? qs.models.join(', ') : 'none';
    var fullModelsText = t('models') + ' ' + modelsStr;
    return '\
    <div class="card quickslot-card' + (qs.disabled ? ' quickslot-disabled' : '') + '">\
      <div class="provider-card-row">\
        <div class="provider-card-left">\
          <span class="card-title copyable" data-name="' + escapeHtml(qs.name) + '" onclick="copyToClipboard(this.dataset.name, this.dataset.name)" title="' + t('clickToCopy') + '">' + escapeHtml(qs.name) + '</span>\
        </div>\
        <div class="provider-card-actions">\
          <span class="badge provider-btn-col1 ' + (qs.disabled ? 'badge-inactive' : 'badge-active') + '">order: ' + (qs.order || 0) + '</span>\
          <button type="button" class="btn btn-sm provider-btn-col2" onclick="toggleQuickSlotDisabled(\'' + escapeAttr(qs.id) + '\')">' + (qs.disabled ? t('enable') : t('disable')) + '</button>\
        </div>\
      </div>\
      <div class="provider-card-row mt-12">\
        <div class="provider-card-left">\
          <span class="muted card-left-models" title="' + escapeHtml(fullModelsText) + '">' + escapeHtml(fullModelsText) + '</span>\
        </div>\
        <div class="provider-card-actions">\
          <button type="button" class="btn btn-sm provider-btn-col1" onclick="showEditQuickSlot(\'' + escapeAttr(qs.id) + '\')">' + t('edit') + '</button>\
          <button type="button" class="btn btn-sm btn-danger provider-btn-col2" onclick="deleteQuickSlot(\'' + escapeAttr(qs.id) + '\')">' + t('delete') + '</button>\
        </div>\
      </div>\
    </div>';
  }).join('');
}

function showAddQuickSlot() {
  var overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = '<div class="modal" style="max-width:520px">\
    <div class="modal-title">' + t('newQuickSlot') + '</div>\
    <div class="form-group"><label for="qs-name">' + t('name') + '</label><input id="qs-name" placeholder="' + t('name') + '"></div>\
    <div class="form-group"><label for="qs-order">' + t('quickSlotOrder') + '</label>\
      <input type="number" id="qs-order" min="1" max="9" value="1">\
      <p class="muted mt-12">' + t('quickSlotOrderHint') + '</p>\
    </div>\
    <div class="form-group"><label>' + t('quickSlotModels') + '</label>\
      <div style="display:flex;gap:8px;margin-bottom:8px">\
        <button type="button" class="btn btn-sm" onclick="importModelsForQuickSlot()">' + t('importFromProvider') + '</button>\
      </div>\
      <div id="qs-models-list"></div>\
    </div>\
    <div class="modal-footer">\
      <button type="button" class="btn" onclick="closeModalOverlay()">' + t('cancel') + '</button>\
      <button type="button" class="btn btn-primary" onclick="withLoading(this, () => addQuickSlot())">' + t('create') + '</button>\
    </div>\
  </div>';
  requestAnimationFrame(function() { overlay.classList.add('show'); });
  qsEditingModels = [];
  qsEditingDisabledModels = [];
  loadQuickSlotProvidersAndRender();
}

async function addQuickSlot() {
  var order = parseInt(document.getElementById('qs-order').value, 10);
  if (isNaN(order)) order = 1;
  var c = {
    name: document.getElementById('qs-name').value,
    order: order,
    models: qsEditingModels.slice(),
    disabledModels: qsEditingDisabledModels.slice()
  };
  try {
    var result = await apiPost('/quickslots', c);
    if (result && result.error) {
      toast(result.error, 'error');
      return;
    }
    closeModalOverlay();
    toast(t('quickSlotCreated'), 'success');
    renderEndpoint(document.getElementById('page-content'));
    renderHeaderQuickSlots();
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

async function deleteQuickSlot(id) {
  var ok = await confirmModal(t('confirmDeleteQuickSlot'));
  if (!ok) return;
  if (_qsActiveId === id) qsClearActive();
  await apiDelete('/quickslots/' + id);
  toast(t('quickSlotDeleted'), 'success');
  renderEndpoint(document.getElementById('page-content'));
  renderHeaderQuickSlots();
}

async function toggleQuickSlotDisabled(id) {
  var data = await apiGet('/quickslots');
  var qs = (data.quickslots || []).find(function(x) { return x.id === id; });
  if (!qs) return;
  qs.disabled = !qs.disabled;
  await apiPut('/quickslots/' + id, qs);
  if (_qsActiveId === id && qs.disabled) qsClearActive();
  toast(qs.disabled ? t('quickSlotDisabled') : t('quickSlotEnabled'), 'success');
  renderEndpoint(document.getElementById('page-content'));
  renderHeaderQuickSlots();
}

async function showEditQuickSlot(id) {
  var data = await apiGet('/quickslots');
  var qs = (data.quickslots || []).find(function(x) { return x.id === id; });
  if (!qs) return;
  var overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = '<div class="modal" style="max-width:70vw;width:70vw">\
    <div class="modal-title">' + t('quickSlotEdit') + '</div>\
    <div class="form-group"><label for="qs-name">' + t('name') + '</label><input id="qs-name" value="' + escapeHtml(qs.name) + '"></div>\
    <div class="form-group"><label for="qs-order">' + t('quickSlotOrder') + '</label>\
      <input type="number" id="qs-order" min="1" max="9" value="' + (qs.order || 1) + '">\
      <p class="muted mt-12">' + t('quickSlotOrderHint') + '</p>\
    </div>\
    <div class="form-group"><label>' + t('quickSlotModels') + '</label>\
      <div style="display:flex;gap:8px;margin-bottom:8px">\
        <button type="button" class="btn btn-sm" onclick="importModelsForQuickSlot()">' + t('importFromProvider') + '</button>\
      </div>\
      <div id="qs-models-list"></div>\
    </div>\
    <div class="modal-footer">\
      <button type="button" class="btn" onclick="closeModalOverlay()">' + t('cancel') + '</button>\
      <button type="button" class="btn btn-primary" onclick="withLoading(this, () => saveEditQuickSlot(\'' + escapeAttr(id) + '\'))">' + t('saveQuickSlot') + '</button>\
    </div>\
  </div>';
  requestAnimationFrame(function() { overlay.classList.add('show'); });
  qsEditingModels = (qs.models || []).slice();
  qsEditingDisabledModels = (qs.disabledModels || []).slice();
  loadQuickSlotProvidersAndRender();
}

async function saveEditQuickSlot(id) {
  var data = await apiGet('/quickslots');
  var existing = (data.quickslots || []).find(function(x) { return x.id === id; });
  if (!existing) existing = {};
  var order = parseInt(document.getElementById('qs-order').value, 10);
  if (isNaN(order)) order = 1;
  var c = {
    name: document.getElementById('qs-name').value,
    order: order,
    models: qsEditingModels.slice(),
    disabledModels: qsEditingDisabledModels.slice(),
    disabled: !!existing.disabled,
    selectedIndex: existing.selectedIndex || 0
  };
  try {
    await apiPut('/quickslots/' + id, c);
    closeModalOverlay();
    toast(t('quickSlotUpdated'), 'success');
    renderEndpoint(document.getElementById('page-content'));
    renderHeaderQuickSlots();
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

function attachModalFocusTrap(modalOverlay, initialFocusEl) {
  function handleGlobalKeyDown(e) {
    if (!document.body.contains(modalOverlay)) {
      document.removeEventListener('keydown', handleGlobalKeyDown, true);
      document.removeEventListener('focusin', handleGlobalFocusIn, true);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function handleGlobalFocusIn(e) {
    if (!document.body.contains(modalOverlay)) {
      document.removeEventListener('keydown', handleGlobalKeyDown, true);
      document.removeEventListener('focusin', handleGlobalFocusIn, true);
      return;
    }
    if (!modalOverlay.contains(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (initialFocusEl && modalOverlay.contains(initialFocusEl)) {
        initialFocusEl.focus();
      } else {
        var firstFocusable = modalOverlay.querySelector('input, button, [tabindex]');
        if (firstFocusable) firstFocusable.focus();
      }
    }
  }

  document.addEventListener('keydown', handleGlobalKeyDown, true);
  document.addEventListener('focusin', handleGlobalFocusIn, true);
}

function setupImportModalKeyboardAndFocus(importOverlay, onConfirm, onClose) {
  var filterInput = importOverlay.querySelector('#import-filter');
  var selectAllBtn = importOverlay.querySelector('#import-select-all');
  var deselectAllBtn = importOverlay.querySelector('#import-deselect-all');
  var closeBtn = importOverlay.querySelector('#import-close');
  var addBtn = importOverlay.querySelector('#import-add');

  attachModalFocusTrap(importOverlay, filterInput);

  function getVisibleModelItems() {
    var items = importOverlay.querySelectorAll('.import-model-item');
    var visible = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].style.display !== 'none') visible.push(items[i]);
    }
    return visible;
  }

  function clearModelItemsFocus() {
    var items = importOverlay.querySelectorAll('.import-model-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.remove('focused');
    }
  }

  function getFocusedModelItemIdx() {
    var visible = getVisibleModelItems();
    var active = document.activeElement;
    for (var i = 0; i < visible.length; i++) {
      if (visible[i] === active || visible[i].classList.contains('focused')) {
        return i;
      }
    }
    return -1;
  }

  function setModelItemFocus(idx) {
    var visible = getVisibleModelItems();
    if (visible.length === 0) {
      clearModelItemsFocus();
      return false;
    }
    if (idx < 0) idx = 0;
    if (idx >= visible.length) idx = visible.length - 1;
    clearModelItemsFocus();
    var target = visible[idx];
    target.classList.add('focused');
    target.setAttribute('tabindex', '-1');
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
    return true;
  }

  function findFirstItemInView(container, visibleItems) {
    if (!container || visibleItems.length === 0) return -1;
    var containerRect = container.getBoundingClientRect();
    var containerTop = containerRect.top;
    var containerBottom = containerRect.bottom;

    for (var i = 0; i < visibleItems.length; i++) {
      var rect = visibleItems[i].getBoundingClientRect();
      if (rect.top >= containerTop - 5 && rect.top < containerBottom - 10) {
        return i;
      }
    }
    for (var j = 0; j < visibleItems.length; j++) {
      var r = visibleItems[j].getBoundingClientRect();
      if (r.bottom > containerTop + 10) {
        return j;
      }
    }
    return 0;
  }

  if (filterInput) filterInput.focus();

  filterInput.addEventListener('focus', clearModelItemsFocus);
  selectAllBtn.addEventListener('focus', clearModelItemsFocus);
  deselectAllBtn.addEventListener('focus', clearModelItemsFocus);
  closeBtn.addEventListener('focus', clearModelItemsFocus);
  addBtn.addEventListener('focus', clearModelItemsFocus);

  importOverlay.addEventListener('focusin', function(e) {
    var item = e.target.closest('.import-model-item');
    if (item) {
      clearModelItemsFocus();
      item.classList.add('focused');
    }
  });

  filterInput.addEventListener('input', function() {
    var visible = getVisibleModelItems();
    var curIdx = getFocusedModelItemIdx();
    if (curIdx >= 0 && (curIdx >= visible.length || !visible[curIdx] || visible[curIdx].style.display === 'none')) {
      clearModelItemsFocus();
    }
  });

  importOverlay.addEventListener('keydown', function(e) {
    var active = document.activeElement;
    var visibleItems = getVisibleModelItems();
    var curListIdx = getFocusedModelItemIdx();
    var isListFocused = (curListIdx >= 0) || (active && active.classList && active.classList.contains('import-model-item'));

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
      return;
    }

    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      var modalBody = importOverlay.querySelector('.modal-body');
      if (modalBody && visibleItems.length > 0) {
        var pageSize = Math.max(100, modalBody.clientHeight - 40);
        if (e.key === 'PageDown') {
          modalBody.scrollTop += pageSize;
        } else {
          modalBody.scrollTop -= pageSize;
        }
        setTimeout(function() {
          var targetIdx = findFirstItemInView(modalBody, visibleItems);
          if (targetIdx >= 0) {
            setModelItemFocus(targetIdx);
          }
        }, 30);
      }
      return;
    }

    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (visibleItems.length > 0) {
        if (e.key === 'Home') {
          setModelItemFocus(0);
        } else {
          setModelItemFocus(visibleItems.length - 1);
        }
      }
      return;
    }

    if (e.key === ' ' || e.key === 'Spacebar') {
      if (isListFocused) {
        e.preventDefault();
        e.stopImmediatePropagation();
        var targetEl = (curListIdx >= 0 && visibleItems[curListIdx]) ? visibleItems[curListIdx] : active;
        toggleImportModel(targetEl);
        return;
      }
    }

    if (e.key === 'Enter') {
      if (active === closeBtn) {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      onConfirm();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();

      if (e.shiftKey) { // Shift+Tab
        if (active === filterInput) {
          addBtn.focus();
        } else if (active === selectAllBtn || active === deselectAllBtn) {
          filterInput.focus();
        } else if (isListFocused) {
          clearModelItemsFocus();
          selectAllBtn.focus();
        } else if (active === closeBtn) {
          if (visibleItems.length > 0) {
            setModelItemFocus(visibleItems.length - 1);
          } else {
            deselectAllBtn.focus();
          }
        } else if (active === addBtn) {
          closeBtn.focus();
        } else {
          filterInput.focus();
        }
      } else { // Tab
        if (active === filterInput) {
          selectAllBtn.focus();
        } else if (active === selectAllBtn) {
          deselectAllBtn.focus();
        } else if (active === deselectAllBtn) {
          if (visibleItems.length > 0) {
            deselectAllBtn.blur();
            setModelItemFocus(0);
          } else {
            closeBtn.focus();
          }
        } else if (isListFocused) {
          clearModelItemsFocus();
          closeBtn.focus();
        } else if (active === closeBtn) {
          addBtn.focus();
        } else if (active === addBtn) {
          filterInput.focus();
        } else {
          filterInput.focus();
        }
      }
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();

      if (e.key === 'ArrowDown') {
        if (active === filterInput) {
          selectAllBtn.focus();
        } else if (active === selectAllBtn || active === deselectAllBtn) {
          if (visibleItems.length > 0) {
            if (active) active.blur();
            setModelItemFocus(0);
          } else {
            closeBtn.focus();
          }
        } else if (isListFocused) {
          if (curListIdx < visibleItems.length - 1) {
            setModelItemFocus(curListIdx + 1);
          } else {
            clearModelItemsFocus();
            closeBtn.focus();
          }
        } else if (active === closeBtn || active === addBtn) {
          filterInput.focus();
        } else {
          filterInput.focus();
        }
      } else { // ArrowUp
        if (active === filterInput) {
          addBtn.focus();
        } else if (active === selectAllBtn || active === deselectAllBtn) {
          filterInput.focus();
        } else if (isListFocused) {
          if (curListIdx > 0) {
            setModelItemFocus(curListIdx - 1);
          } else {
            clearModelItemsFocus();
            selectAllBtn.focus();
          }
        } else if (active === closeBtn || active === addBtn) {
          if (visibleItems.length > 0) {
            if (active) active.blur();
            setModelItemFocus(visibleItems.length - 1);
          } else {
            deselectAllBtn.focus();
          }
        } else {
          filterInput.focus();
        }
      }
      return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (active === selectAllBtn) {
        e.preventDefault();
        e.stopImmediatePropagation();
        deselectAllBtn.focus();
      } else if (active === deselectAllBtn) {
        e.preventDefault();
        e.stopImmediatePropagation();
        selectAllBtn.focus();
      } else if (active === closeBtn) {
        e.preventDefault();
        e.stopImmediatePropagation();
        addBtn.focus();
      } else if (active === addBtn) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeBtn.focus();
      }
    }
  }, true);
}

async function openModelSelectorModal(opts) {
  opts = opts || {};
  var initialSelected = opts.initialSelected || [];
  var includeCombos = !!opts.includeCombos;
  var onConfirm = opts.onConfirm || function() {};
  var onClose = opts.onClose || function() {};

  var providersData = await apiGet('/providers');
  var providers = providersData.providers || [];
  var combos = [];
  if (includeCombos) {
    var combosData = await apiGet('/combos');
    combos = (combosData.combos || []).filter(function(c) { return !c.disabled; });
  }
  if (providers.length === 0 && combos.length === 0) {
    toast(t('noModelsAvailable'), 'warning');
    return;
  }

  var html = '<div class="modal" style="width:500px;padding:20px 24px">\
    <div class="modal-title" style="margin-bottom:12px">' + t('selectModels') + '</div>\
    <div class="modal-header-controls" style="margin-bottom:12px;padding:2px">\
      <input type="text" id="import-filter" placeholder="' + t('filterModels') + '" style="width:100%;margin-bottom:10px;padding:6px 10px;box-sizing:border-box;background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:6px;color:var(--text-primary)">\
      <div style="display:flex;gap:8px;padding:2px">\
        <button type="button" class="btn btn-sm" id="import-select-all">' + t('selectAll') + '</button>\
        <button type="button" class="btn btn-sm" id="import-deselect-all">' + t('deselectAll') + '</button>\
      </div>\
    </div>\
    <div class="modal-body" style="max-height:360px;overflow-y:auto;padding:4px 6px">';

  for (var i = 0; i < providers.length; i++) {
    var p = providers[i];
    if (!p.isActive) continue;
    var models = p.models || [];
    html += '<div class="import-provider-group" style="margin-bottom:12px">';
    html += '<div><strong>' + escapeHtml(p.name) + ' (' + escapeHtml(p.prefix) + ')</strong></div>';
    if (models.length === 0) {
      html += '<div class="muted" style="margin-bottom:8px">' + t('noModels') + '</div>';
    } else {
      for (var j = 0; j < models.length; j++) {
        var displayId = models[j].alias || models[j].id;
        if (p.prefix && displayId.indexOf(p.prefix + '/') === 0) {
          displayId = displayId.slice(p.prefix.length + 1);
        }
        var fullId = p.prefix + '/' + displayId;
        var note = models[j].note || '';
        var isInList = initialSelected.indexOf(fullId) >= 0;
        var itemCls = 'import-model-item' + (isInList ? ' selected' : '') + (note ? ' has-model-note' : '');
        var noteAttr = note ? ' data-model-note="' + escapeHtml(note) + '"' : '';
        html += '<div class="' + itemCls + '" tabindex="-1"' + noteAttr + ' data-value="' + escapeHtml(fullId) + '" onclick="toggleImportModel(this)" style="padding:6px 10px;margin-bottom:3px;border-radius:6px;cursor:pointer;transition:background .15s;border:1px solid transparent">' + escapeHtml(fullId) + '</div>';
      }
    }
    html += '</div>';
  }

  if (combos.length > 0) {
    html += '<div class="import-provider-group" style="margin-bottom:12px">';
    html += '<div><strong>' + t('combos') + '</strong></div>';
    for (var c = 0; c < combos.length; c++) {
      var comboName = combos[c].name;
      var isInList = initialSelected.indexOf(comboName) >= 0;
      html += '<div class="import-model-item' + (isInList ? ' selected' : '') + '" tabindex="-1" data-value="' + escapeHtml(comboName) + '" data-is-combo="1" onclick="toggleImportModel(this)" style="padding:6px 10px;margin-bottom:3px;border-radius:6px;cursor:pointer;transition:background .15s;border:1px solid transparent"><span class="badge badge-combo" style="margin-right:6px">' + t('combo') + '</span>' + escapeHtml(comboName) + '</div>';
    }
    html += '</div>';
  }

  html += '</div>\
    <div class="modal-footer" style="margin-top:16px">\
      <button type="button" class="btn btn-ghost" id="import-close">' + t('close') + '</button>\
      <button type="button" class="btn btn-primary" id="import-add">' + t('addSelected') + '</button>\
    </div></div>';

  var importOverlay = document.createElement('div');
  importOverlay.className = 'modal-overlay';
  importOverlay.innerHTML = html;
  document.body.appendChild(importOverlay);
  requestAnimationFrame(function() { importOverlay.classList.add('show'); });

  var filterInput = importOverlay.querySelector('#import-filter');
  var importAdd = importOverlay.querySelector('#import-add');
  var importClose = importOverlay.querySelector('#import-close');
  var importSelectAll = importOverlay.querySelector('#import-select-all');
  var importDeselectAll = importOverlay.querySelector('#import-deselect-all');

  function closeOverlay() {
    importOverlay.classList.remove('show');
    setTimeout(function() { if (importOverlay.parentNode) importOverlay.remove(); }, 400);
  }

  function handleClose() {
    closeOverlay();
    onClose();
  }

  function handleConfirm() {
    var selected = [];
    var items = importOverlay.querySelectorAll('.import-model-item.selected');
    for (var k = 0; k < items.length; k++) {
      selected.push(items[k].getAttribute('data-value'));
    }
    closeOverlay();
    onConfirm(selected);
  }

  if (importClose) importClose.onclick = handleClose;
  if (importAdd) importAdd.onclick = handleConfirm;

  if (importSelectAll) importSelectAll.onclick = function() {
    var items = importOverlay.querySelectorAll('.import-model-item');
    for (var k = 0; k < items.length; k++) items[k].classList.add('selected');
  };
  if (importDeselectAll) importDeselectAll.onclick = function() {
    var items = importOverlay.querySelectorAll('.import-model-item');
    for (var k = 0; k < items.length; k++) items[k].classList.remove('selected');
  };

  if (filterInput) filterInput.oninput = function() {
    var keyword = this.value.toLowerCase().trim();
    var groups = importOverlay.querySelectorAll('.import-provider-group');
    for (var gi = 0; gi < groups.length; gi++) {
      var group = groups[gi];
      var items = group.querySelectorAll('.import-model-item');
      var visibleCount = 0;
      for (var ii = 0; ii < items.length; ii++) {
        var val = items[ii].getAttribute('data-value') || '';
        if (keyword === '' || val.toLowerCase().indexOf(keyword) >= 0) {
          items[ii].style.display = '';
          visibleCount++;
        } else {
          items[ii].style.display = 'none';
        }
      }
      group.style.display = visibleCount > 0 ? '' : 'none';
    }
  };

  setupImportModalKeyboardAndFocus(importOverlay, handleConfirm, handleClose);
}

async function importModelsForQuickSlot() {
  openModelSelectorModal({
    initialSelected: qsEditingModels,
    includeCombos: true,
    onConfirm: function(selected) {
      for (var k = 0; k < selected.length; k++) {
        if (qsEditingModels.indexOf(selected[k]) < 0) qsEditingModels.push(selected[k]);
      }
      renderQuickSlotModelsList();
    }
  });
}

async function loadQuickSlotProvidersAndRender() {
  if (!qsProvidersCache) {
    var data = await apiGet('/providers');
    qsProvidersCache = (data.providers || []);
  }
  renderQuickSlotModelsList();
}

function findQsProviderByPrefix(prefix) {
  if (!qsProvidersCache) return null;
  for (var i = 0; i < qsProvidersCache.length; i++) {
    if (qsProvidersCache[i].prefix === prefix) return qsProvidersCache[i];
  }
  return null;
}

function renderQuickSlotModelsList() {
  var container = document.getElementById('qs-models-list');
  if (!container) return;
  if (qsEditingModels.length === 0) {
    container.innerHTML = emptyState(t('noModels'));
    return;
  }
  var html = '';
  for (var i = 0; i < qsEditingModels.length; i++) {
    var fullId = qsEditingModels[i];
    var slashIdx = fullId.indexOf('/');
    var prefix = slashIdx > 0 ? fullId.substring(0, slashIdx) : '';
    var modelId = slashIdx > 0 ? fullId.substring(slashIdx + 1) : fullId;
    var provider = findQsProviderByPrefix(prefix);
    var pid = provider ? provider.id : '';
    var ts = modelTestStatus[modelId];
    var fullIdEsc = escapeHtml(fullId);
    var modelIdEsc = escapeHtml(modelId);
    var pidEsc = escapeHtml(pid);
    var isDisabled = qsEditingDisabledModels.indexOf(fullId) >= 0;
    var note = provider ? findModelNote(provider, modelId) : '';
    var noteAttr = note ? ' data-model-note="' + escapeHtml(note) + '"' : '';
    var hasNoteCls = note ? ' has-model-note' : '';
    var disabledRowStyle = isDisabled ? ' style="opacity:0.5"' : '';
    var isFirst = i === 0;
    var isLast = i === qsEditingModels.length - 1;
    var isCombo = slashIdx <= 0;
    html += '<div class="model-row' + hasNoteCls + '" data-index="' + i + '" draggable="true"' + disabledRowStyle + '>' +
      '<div class="model-row-main"' + noteAttr + '>' +
        '<span class="drag-handle" title="' + t('dragToReorder') + '" draggable="false">⠿</span>' +
        (isCombo ? '' : '<button type="button" class="btn btn-sm ' + (ts ? (ts.ok ? 'btn-test-ok' : 'btn-test-err') : '') + '" onclick="withLoading(this, () => testQuickSlotModel(' + i + '))">' + t('test') + '</button>') +
        (isCombo ? '' : buildMiniProtocolBadges(ts, modelId)) +
        '<button type="button" class="btn btn-sm ' + (isFirst ? 'disabled ' : '') + 'onclick="moveQuickSlotModel(' + i + ',' + (i - 1) + ')">' + t('moveUp') + '</button>' +
        '<button type="button" class="btn btn-sm ' + (isLast ? 'disabled ' : '') + 'onclick="moveQuickSlotModel(' + i + ',' + (i + 1) + ')">' + t('moveDown') + '</button>' +
        '<button type="button" class="btn btn-sm btn-danger" onclick="removeQuickSlotModel(' + i + ')">' + t('delete') + '</button>' +
        (isCombo ? '<span class="badge badge-combo" style="margin-right:6px">' + t('combo') + '</span>' : '') +
        '<span class="model-id copyable" onclick="copyToClipboard(\'' + escapeForJsString(fullIdEsc) + '\')" title="' + t('clickToCopy') + '">' + fullIdEsc + '</span>' +
      '</div>' +
    '</div>';
  }
  container.innerHTML = html;
  attachQuickSlotRowDragHandlers(container);
}

function attachQuickSlotRowDragHandlers(container) {
  var rows = container.querySelectorAll('.model-row');
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    row.addEventListener('dragstart', function(e) {
      qsDragFromIndex = parseInt(this.getAttribute('data-index'), 10);
      this.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(qsDragFromIndex)); } catch (err) {}
      }
    });
    row.addEventListener('dragend', function() {
      this.classList.remove('dragging');
      qsDragFromIndex = -1;
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
      if (qsDragFromIndex >= 0 && qsDragFromIndex !== to) {
        moveQuickSlotModel(qsDragFromIndex, to);
      }
    });
  }
}

function moveQuickSlotModel(from, to) {
  if (from < 0 || from >= qsEditingModels.length) return;
  if (to < 0 || to >= qsEditingModels.length) return;
  if (from === to) return;
  var m = qsEditingModels.splice(from, 1)[0];
  qsEditingModels.splice(to, 0, m);
  renderQuickSlotModelsList();
}

function toggleQuickSlotModelDisabled(i) {
  var fullId = qsEditingModels[i];
  var idx = qsEditingDisabledModels.indexOf(fullId);
  if (idx >= 0) {
    qsEditingDisabledModels.splice(idx, 1);
  } else {
    qsEditingDisabledModels.push(fullId);
  }
  renderQuickSlotModelsList();
}

async function testQuickSlotModel(idx) {
  var fullId = qsEditingModels[idx];
  if (!fullId) return;
  if (fullId.indexOf('/') < 0) {
    toast(t('comboCannotTest'), 'warning');
    return;
  }
  var slashIdx = fullId.indexOf('/');
  var prefix = slashIdx > 0 ? fullId.substring(0, slashIdx) : '';
  var modelId = slashIdx > 0 ? fullId.substring(slashIdx + 1) : fullId;
  var provider = findQsProviderByPrefix(prefix);
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
      renderQuickSlotModelsList();
    }
  });
}

function removeQuickSlotModel(idx) {
  qsEditingModels.splice(idx, 1);
  renderQuickSlotModelsList();
}

// ===================== Header QuickSlots =====================

// --- QuickSlot Modal State ---
var _qsModalOverlay = null;
var _qsModalData = null;       // { qsId, orderNum, models, selectedIndex, name }
var _qsModalFocusIdx = 0;
var _qsModalTimer = null;
var _qsModalAutoClose = false;

// --- QuickSlot Active State (session-only) ---
var _qsActiveId = null;

function _qsResolveModel(qs) {
  var models = qs.models || [];
  if (models.length === 0) return null;
  var idx = qs.selectedIndex || 0;
  if (idx < 0 || idx >= models.length) idx = 0;
  return models[idx];
}

function _qsUpdateActiveClass() {
  var container = document.getElementById('quickslot-header');
  if (!container) return;
  container.querySelectorAll('.quickslot-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-qs-id') === _qsActiveId);
  });
}

function qsGetActiveModel() {
  if (!_qsActiveId) return Promise.resolve(null);
  return apiGet('/quickslots').then(function(data) {
    var qs = (data.quickslots || []).find(function(x) { return x.id === _qsActiveId; });
    if (!qs || qs.disabled) return null;
    var model = _qsResolveModel(qs);
    return model ? { id: qs.id, name: qs.name, model: model } : null;
  }).catch(function() { return null; });
}

function qsSetActive(id, qs) {
  _qsActiveId = id;
  _qsUpdateActiveClass();
  if (!qs) return;
  var model = _qsResolveModel(qs);
  if (model && typeof currentPage !== 'undefined' && currentPage === 'playground' && typeof pgApplyActiveQuickSlot === 'function') {
    pgApplyActiveQuickSlot(model);
  }
}

function qsClearActive() {
  if (!_qsActiveId) return;
  _qsActiveId = null;
  _qsUpdateActiveClass();
}

async function renderHeaderQuickSlots() {
  var container = document.getElementById('quickslot-header');
  if (!container) return;
  try {
    var data = await apiGet('/quickslots');
    var quickslots = (data.quickslots || []).filter(function(qs) { return !qs.disabled; });
    quickslots.sort(function(a, b) { return (a.order || 0) - (b.order || 0); });
    if (quickslots.length === 0) {
      container.innerHTML = '';
      container.style.gridTemplateColumns = '';
      return;
    }
    var cols = quickslots.length <= 3 ? quickslots.length : Math.ceil(quickslots.length / 2);
    container.style.gridTemplateColumns = 'repeat(' + cols + ', 110px)';
    var html = '';
    for (var i = 0; i < quickslots.length; i++) {
      var qs = quickslots[i];
      var models = qs.models || [];
      var idx = qs.selectedIndex || 0;
      if (idx < 0 || idx >= models.length) idx = 0;
      var bottom = '—';
      var fullId = models[idx] || '';
      if (models.length > 0) {
        var slashIdx = fullId.indexOf('/');
        if (slashIdx > 0) {
          var prefix = fullId.substring(0, slashIdx);
          var modelPart = fullId.substring(slashIdx + 1);
          var lastSlashIdx = modelPart.lastIndexOf('/');
          var lastSegment = lastSlashIdx >= 0 ? modelPart.substring(lastSlashIdx + 1) : modelPart;
          bottom = lastSegment ? prefix + '/' + lastSegment : prefix;
        } else {
          bottom = fullId;
        }
      }
      var nameEsc = escapeHtml(qs.name);
      var bottomEsc = escapeHtml(bottom);
      var fullIdEsc = escapeHtml(fullId);
      var num = i + 1;
      var titleAttr = fullIdEsc ? nameEsc + '&#10;' + fullIdEsc : nameEsc;
      html += '<div class="quickslot-btn" onclick="openQuickSlotModalById(\'' + escapeAttr(qs.id) + '\', false)" oncontextmenu="event.preventDefault();" data-qs-id="' + escapeAttr(qs.id) + '" title="' + titleAttr + '">\
        <div class="qs-number">' + num + '</div>\
        <div class="qs-content">\
          <div class="qs-name">' + nameEsc + '</div>\
          <div class="qs-bottom">' + bottomEsc + '</div>\
        </div>\
      </div>';
    }
    container.innerHTML = html;
    _qsUpdateActiveClass();
  } catch (e) {
    // ignore render errors (e.g. not yet on settings page)
  }
}

// --- QuickSlot Modal ---

function _qsModalClearTimer() {
  if (_qsModalTimer) { clearTimeout(_qsModalTimer); _qsModalTimer = null; }
}

function _qsModalStartTimer() {
  _qsModalClearTimer();
  if (_qsModalAutoClose) {
    _qsModalTimer = setTimeout(function() { closeQuickSlotModal(); }, 1000);
  }
}

function _qsModalCancelAutoClose() {
  _qsModalAutoClose = false;
  _qsModalClearTimer();
}

async function openQuickSlotModalByOrder(orderNum, autoClose) {
  var data = await apiGet('/quickslots');
  var quickslots = (data.quickslots || []).filter(function(qs) { return !qs.disabled; });
  var qs = null;
  for (var i = 0; i < quickslots.length; i++) {
    if (quickslots[i].order === orderNum) { qs = quickslots[i]; break; }
  }
  if (!qs) return;
  _openQuickSlotModal(qs, autoClose);
}

async function openQuickSlotModalById(qsId, autoClose) {
  var data = await apiGet('/quickslots');
  var qs = (data.quickslots || []).find(function(x) { return x.id === qsId; });
  if (!qs) return;
  _openQuickSlotModal(qs, autoClose);
}

async function _openQuickSlotModal(qs, autoClose) {
  closeQuickSlotModal();
  var modelsData = await apiGet('/models');
  var noteMap = {};
  ((modelsData || {}).models || []).forEach(function(m) { if (m.note) noteMap[m.id] = m.note; });
  var models = qs.models || [];
  var sel = qs.selectedIndex || 0;
  if (sel < 0 || sel >= models.length) sel = 0;
  _qsModalData = { qsId: qs.id, orderNum: qs.order, models: models, selectedIndex: sel, name: qs.name, noteMap: noteMap, disabledModels: qs.disabledModels || [] };
  _qsModalFocusIdx = sel;
  _qsModalAutoClose = !!autoClose;
  qsSetActive(qs.id, qs);
  // Build overlay
  var overlay = document.createElement('div');
  overlay.className = 'qs-modal-overlay';
  overlay.id = 'qs-modal-overlay';
  overlay.innerHTML = _qsModalBuildHtml();
  document.body.appendChild(overlay);
  _qsModalOverlay = overlay;
  attachModalFocusTrap(overlay, null);
  requestAnimationFrame(function() { overlay.classList.add('show'); });
  // Events
  overlay.addEventListener('mousedown', function(e) {
    if (e.target === overlay) { closeQuickSlotModal(); return; }
    _qsModalCancelAutoClose();
  });
  overlay.addEventListener('mousemove', function() { /* no-op, mouse presence cancels via click */ });
  _qsModalStartTimer();
}

function _qsModalOpenImport() {
  if (!_qsModalData) return;
  var qsId = _qsModalData.qsId;
  closeQuickSlotModal();
  importModelsForQuickSlotHeader(qsId);
}

function _qsModalBuildHtml() {
  var d = _qsModalData;
  var html = '<div class="qs-modal">';
  html += '<div class="qs-modal-title">#' + d.orderNum + ' ' + escapeHtml(d.name) + '</div>';
  html += '<div class="qs-modal-list">';
  if (d.models.length === 0) {
    html += '<div class="qs-modal-item muted">—</div>';
  } else {
    for (var i = 0; i < d.models.length; i++) {
      var note = d.noteMap[d.models[i]] || '';
      var cls = 'qs-modal-item' + (i === _qsModalFocusIdx ? ' focused' : '') + (i === d.selectedIndex ? ' selected' : '') + (note ? ' has-model-note' : '');
      var noteAttr = note ? ' data-model-note="' + escapeHtml(note) + '"' : '';
      html += '<div class="' + cls + '"' + noteAttr + ' data-idx="' + i + '" onclick="_qsModalItemClick(' + i + ')" oncontextmenu="event.preventDefault();event.stopPropagation();_qsModalItemDelete(' + i + ')">' + escapeHtml(d.models[i]) + '</div>';
    }
  }
  var isImportFocused = (_qsModalFocusIdx === d.models.length);
  var importCls = 'qs-modal-item qs-modal-import-item' + (isImportFocused ? ' focused' : '');
  html += '<div class="' + importCls + '" data-idx="' + d.models.length + '" onclick="_qsModalOpenImport()">' + t('import') + '...</div>';
  html += '</div>';
  html += '<div class="qs-modal-hint">' + t('qsModalHint') + '</div>';
  html += '</div>';
  return html;
}

function _qsModalRefresh() {
  if (!_qsModalOverlay) return;
  var items = _qsModalOverlay.querySelectorAll('.qs-modal-item');
  for (var i = 0; i < items.length; i++) {
    var idx = parseInt(items[i].getAttribute('data-idx'), 10);
    items[i].classList.toggle('focused', idx === _qsModalFocusIdx);
    if (_qsModalData) items[i].classList.toggle('selected', idx === _qsModalData.selectedIndex);
  }
  // Scroll focused item into view
  var focused = _qsModalOverlay.querySelector('.qs-modal-item.focused');
  if (focused) focused.scrollIntoView({ block: 'nearest' });
}

function _qsModalItemClick(idx) {
  _qsModalCancelAutoClose();
  _qsModalFocusIdx = idx;
  _qsModalRefresh();
  _qsModalSelectFocused();
}

function _qsModalItemDelete(idx) {
  _qsModalCancelAutoClose();
  _qsModalFocusIdx = idx;
  _qsModalRefresh();
  _qsModalDeleteFocused();
}

async function _qsModalSelectFocused() {
  if (!_qsModalData) return;
  var idx = _qsModalFocusIdx;
  if (idx === _qsModalData.models.length) {
    _qsModalOpenImport();
    return;
  }
  if (idx < 0 || idx >= _qsModalData.models.length) return;
  var qsId = _qsModalData.qsId;
  var modelName = _qsModalData.models[idx];
  var qsName = _qsModalData.name;
  var data = await apiGet('/quickslots');
  var qs = (data.quickslots || []).find(function(x) { return x.id === qsId; });
  if (!qs) return;
  qs.selectedIndex = idx;
  await apiPut('/quickslots/' + qsId, qs);
  closeQuickSlotModal();
  renderHeaderQuickSlots();
  toast(t('quickSlotSwitched', [qsName, modelName]), 'info', 2000, 'quickslot');
  // If the active quickslot just had its model changed, update playground
  if (_qsActiveId === qsId && typeof currentPage !== 'undefined' && currentPage === 'playground' && typeof pgApplyActiveQuickSlot === 'function') {
    pgApplyActiveQuickSlot(modelName);
  }
}

async function _qsModalDeleteFocused() {
  if (!_qsModalData) return;
  var idx = _qsModalFocusIdx;
  if (idx === _qsModalData.models.length) return;
  if (idx < 0 || idx >= _qsModalData.models.length) return;
  var qsId = _qsModalData.qsId;
  var modelName = _qsModalData.models[idx];
  var ok = await confirmModal(t('confirmDeleteQuickSlotModel', [modelName]));
  if (!ok) {
    // Cancel: return to quickslot modal (do NOT close it)
    return;
  }
  // Perform deletion
  var data = await apiGet('/quickslots');
  var qs = (data.quickslots || []).find(function(x) { return x.id === qsId; });
  if (!qs) return;
  var models = qs.models || [];
  models.splice(idx, 1);
  var sel = qs.selectedIndex || 0;
  if (models.length === 0) {
    sel = 0;
  } else if (sel >= models.length) {
    sel = models.length - 1;
  } else if (sel === idx) {
    sel = Math.min(idx, models.length - 1);
  }
  var updated = {
    name: qs.name,
    order: qs.order,
    models: models,
    disabledModels: (qs.disabledModels || []).filter(function(m) { return m !== modelName; }),
    disabled: !!qs.disabled,
    selectedIndex: sel
  };
  await apiPut('/quickslots/' + qsId, updated);
  renderHeaderQuickSlots();
  toast(t('quickSlotModelRemoved'), 'success');
  // Update modal in-place
  if (_qsModalOverlay) {
    _qsModalData.models = models;
    _qsModalData.selectedIndex = sel;
    if (_qsModalFocusIdx >= models.length) _qsModalFocusIdx = Math.max(0, models.length - 1);
    if (models.length === 0) { closeQuickSlotModal(); return; }
    _qsModalOverlay.querySelector('.qs-modal').innerHTML = _qsModalBuildInner();
    _qsModalRefresh();
  }
}

function _qsModalBuildInner() {
  var d = _qsModalData;
  var html = '<div class="qs-modal-title">#' + d.orderNum + ' ' + escapeHtml(d.name) + '</div>';
  html += '<div class="qs-modal-list">';
  if (d.models.length === 0) {
    html += '<div class="qs-modal-item muted">—</div>';
  } else {
    for (var i = 0; i < d.models.length; i++) {
      var note = d.noteMap[d.models[i]] || '';
      var cls = 'qs-modal-item' + (i === _qsModalFocusIdx ? ' focused' : '') + (i === d.selectedIndex ? ' selected' : '') + (note ? ' has-model-note' : '');
      var noteAttr = note ? ' data-model-note="' + escapeHtml(note) + '"' : '';
      html += '<div class="' + cls + '"' + noteAttr + ' data-idx="' + i + '" onclick="_qsModalItemClick(' + i + ')" oncontextmenu="event.preventDefault();event.stopPropagation();_qsModalItemDelete(' + i + ')">' + escapeHtml(d.models[i]) + '</div>';
    }
  }
  var isImportFocused = (_qsModalFocusIdx === d.models.length);
  var importCls = 'qs-modal-item qs-modal-import-item' + (isImportFocused ? ' focused' : '');
  html += '<div class="' + importCls + '" data-idx="' + d.models.length + '" onclick="_qsModalOpenImport()">' + t('import') + '...</div>';
  html += '</div>';
  html += '<div class="qs-modal-hint">' + t('qsModalHint') + '</div>';
  return html;
}

function closeQuickSlotModal() {
  _qsModalClearTimer();
  if (_qsModalOverlay) {
    _qsModalOverlay.classList.remove('show');
    var el = _qsModalOverlay;
    setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    _qsModalOverlay = null;
  }
  _qsModalData = null;
  _qsModalFocusIdx = 0;
  _qsModalAutoClose = false;
}

function isQuickSlotModalOpen() {
  return !!_qsModalOverlay;
}

// Keyboard handler for quickslot modal (capture phase to take priority)
document.addEventListener('keydown', function(e) {
  if (!_qsModalOverlay) return;
  // If a confirm modal is on top, let it handle keys
  var mainOverlay = document.getElementById('modal-overlay');
  if (mainOverlay && mainOverlay.classList.contains('show')) return;

  var d = _qsModalData;
  if (!d) return;
  var len = d.models.length + 1;

  // '+' or '=' key: trigger import modal directly
  if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    e.stopImmediatePropagation();
    _qsModalCancelAutoClose();
    _qsModalOpenImport();
    return;
  }

  // Number keys: move focus down (restarts 1s timer)
  if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (len > 0) {
      _qsModalFocusIdx = (_qsModalFocusIdx + 1) % len;
      _qsModalRefresh();
    }
    _qsModalStartTimer();
    return;
  }
  // Arrow keys: navigate
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopImmediatePropagation();
    _qsModalCancelAutoClose();
    if (len > 0) {
      if (e.key === 'ArrowDown') {
        _qsModalFocusIdx = (_qsModalFocusIdx + 1) % len;
      } else {
        _qsModalFocusIdx = (_qsModalFocusIdx - 1 + len) % len;
      }
      _qsModalRefresh();
    }
    return;
  }
  // Enter: select focused
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopImmediatePropagation();
    _qsModalCancelAutoClose();
    _qsModalSelectFocused();
    return;
  }
  // Delete: delete focused model
  if (e.key === 'Delete') {
    e.preventDefault();
    e.stopImmediatePropagation();
    _qsModalCancelAutoClose();
    _qsModalDeleteFocused();
    return;
  }
  // Escape: close modal
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeQuickSlotModal();
    return;
  }
}, true); // capture phase

// Right-click on quickslot modal background closes it
document.addEventListener('contextmenu', function(e) {
  if (!_qsModalOverlay) return;
  var mainOverlay = document.getElementById('modal-overlay');
  if (mainOverlay && mainOverlay.classList.contains('show')) return;
  if (_qsModalOverlay.contains(e.target)) {
    // Item contextmenu is handled inline; background closes
    if (!e.target.closest('.qs-modal-item')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeQuickSlotModal();
    }
  }
}, true);

// Keep legacy cycleQuickSlotModel as opening the modal with auto-close
async function cycleQuickSlotModel(orderNum) {
  openQuickSlotModalByOrder(orderNum, true);
}

async function importModelsForQuickSlotHeader(qsId) {
  var data = await apiGet('/quickslots');
  var qs = (data.quickslots || []).find(function(x) { return x.id === qsId; });
  if (!qs) return;

  openModelSelectorModal({
    initialSelected: qs.models || [],
    includeCombos: true,
    onConfirm: function(selected) {
      var newModels = (qs.models || []).slice();
      for (var k = 0; k < selected.length; k++) {
        if (newModels.indexOf(selected[k]) < 0) newModels.push(selected[k]);
      }
      var updated = {
        name: qs.name,
        order: qs.order,
        models: newModels,
        disabledModels: (qs.disabledModels || []).slice(),
        disabled: !!qs.disabled,
        selectedIndex: qs.selectedIndex || 0
      };
      apiPut('/quickslots/' + qsId, updated).then(function() {
        renderHeaderQuickSlots();
        openQuickSlotModalById(qsId, false);
      });
    },
    onClose: function() {
      openQuickSlotModalById(qsId, false);
    }
  });
}

async function importModelsForQuickSlotByOrder(orderNum) {
  var data = await apiGet('/quickslots');
  var quickslots = (data.quickslots || []).filter(function(qs) { return !qs.disabled; });
  for (var i = 0; i < quickslots.length; i++) {
    if (quickslots[i].order === orderNum) { importModelsForQuickSlotHeader(quickslots[i].id); return; }
  }
}

// Legacy: confirmDeleteQuickSlotModel now handled by _qsModalDeleteFocused
async function confirmDeleteQuickSlotModel(qsId, modelIndex) {
  // Open the modal for this quickslot and trigger delete on the specified index
  var data = await apiGet('/quickslots');
  var qs = (data.quickslots || []).find(function(x) { return x.id === qsId; });
  if (!qs) return;
  await _openQuickSlotModal(qs, false);
  _qsModalFocusIdx = modelIndex;
  _qsModalRefresh();
  _qsModalDeleteFocused();
}

async function deleteCurrentQuickSlotModel(orderNum) {
  var data = await apiGet('/quickslots');
  var quickslots = (data.quickslots || []).filter(function(qs) { return !qs.disabled; });
  var qs = null;
  for (var i = 0; i < quickslots.length; i++) {
    if (quickslots[i].order === orderNum) { qs = quickslots[i]; break; }
  }
  if (!qs) return;
  var models = qs.models || [];
  var sel = qs.selectedIndex || 0;
  if (sel < 0 || sel >= models.length) {
    toast(t('noModels'), 'warning');
    return;
  }
  // Open modal and trigger delete on current selection
  await _openQuickSlotModal(qs, false);
  _qsModalFocusIdx = sel;
  _qsModalRefresh();
  _qsModalDeleteFocused();
}
