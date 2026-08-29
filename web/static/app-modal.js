// app-modal.js — Modal stack (confirm/prompt/model-picker + topOpenModal/dismissTopModal + theme modal keys).
// Extracted from app.js (P2-03). Load after app.js (helpers like escapeHtml/escapeForJsString/escapeAttr,
// toast, t) are available. Depends on DOM (#modal-overlay).
// Globals preserved: confirmModal, promptModal, openModelPickerModal, closeModalOverlay, topOpenModal,
// dismissTopModal, handleThemeModalKeyDown, window.promptModal, window.openModelPickerModal, window.__confirmResolver
function confirmModal(message) {
  return new Promise(function(resolve) {
    var overlay = document.getElementById('modal-overlay');
    if (overlay.classList.contains('show') || overlay.children.length > 0) { resolve(false); return; }
    overlay.innerHTML = '<div class="modal"><div class="modal-title">' + t('confirmTitle') + '</div><div class="modal-body">' + escapeHtml(message) + '</div><div class="modal-footer"><button type="button" class="btn btn-ghost" id="modal-cancel">' + t('cancel') + '</button><button type="button" class="btn btn-primary" id="modal-confirm">' + t('confirm') + '</button></div></div>';
    overlay.classList.add('show');
    window.__confirmResolver = resolve;
    setTimeout(function() {
      var confirmBtn = document.getElementById('modal-confirm');
      if (confirmBtn) confirmBtn.focus();
    }, 20);
    function close(result) {
      window.__confirmResolver = null;
      overlay.classList.remove('show');
      overlay.innerHTML = '';
      resolve(result);
    }
    document.getElementById('modal-cancel').onclick = function() { close(false); };
    document.getElementById('modal-confirm').onclick = function() { close(true); };
  });
}

function promptModal(title, defaultValue, placeholder) {
  return new Promise(function(resolve) {
    var overlay = document.getElementById('modal-overlay');
    if (!overlay) { resolve(null); return; }
    if (overlay.classList.contains('show') || overlay.children.length > 0) { resolve(null); return; }
    var val = defaultValue || '';
    var ph = placeholder || '';
    overlay.innerHTML =
      '<div class="modal" style="max-width:440px;">' +
        '<div class="modal-title">' + escapeHtml(title || t('inputPromptTitle')) + '</div>' +
        '<div class="modal-body" style="margin-top:12px;">' +
          '<input type="text" class="input" id="prompt-input" value="' + escapeAttr(val) + '" placeholder="' + escapeAttr(ph) + '" style="width:100%; box-sizing:border-box;" />' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button type="button" class="btn btn-ghost" id="prompt-cancel">' + t('cancel') + '</button>' +
          '<button type="button" class="btn btn-primary" id="prompt-confirm">' + t('confirm') + '</button>' +
        '</div>' +
      '</div>';
    overlay.classList.add('show');
    var input = document.getElementById('prompt-input');
    if (input) {
      setTimeout(function() {
        input.focus();
        input.select();
      }, 50);
      input.onkeydown = function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          close(input.value.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close(null);
        }
      };
    }
    function close(result) {
      overlay.classList.remove('show');
      overlay.innerHTML = '';
      resolve(result);
    }
    document.getElementById('prompt-cancel').onclick = function() { close(null); };
    document.getElementById('prompt-confirm').onclick = function() {
      var inp = document.getElementById('prompt-input');
      close(inp ? inp.value.trim() : null);
    };
  });
}
window.promptModal = promptModal;

function openModelPickerModal(currentValue, onSelect) {
  if (typeof pgOpenModelPicker === 'function') {
    pgOpenModelPicker(currentValue, onSelect);
    return;
  }
  var overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  fetch('/api/models').then(function(r) { return r.json(); }).then(function(data) {
    var items = [];
    var models = (data && Array.isArray(data.models)) ? data.models : (Array.isArray(data) ? data : []);
    if (models.length > 0) {
      models.forEach(function(m) {
        if (m && m.id) {
          var label = m.provider ? (m.provider + ' / ' + (m.alias || m.name || m.realModelId || m.id)) : m.id;
          items.push({ id: m.id, name: label, note: m.note || '' });
        }
      });
    } else {
      if (data && Array.isArray(data.combos)) {
        data.combos.forEach(function(c) {
          items.push({ id: 'combo:' + c.name, name: '⚡ combo:' + c.name });
        });
      }
      if (data && Array.isArray(data.providers)) {
        data.providers.forEach(function(p) {
          if (p && Array.isArray(p.models)) {
            p.models.forEach(function(m) {
              items.push({ id: p.id + '/' + (m.id || m.name), name: (p.name || p.id) + ' / ' + (m.name || m.id) });
            });
          }
        });
      }
    }
    renderPicker(items);
  }).catch(function() {
    renderPicker([]);
  });

  function renderPicker(items) {
    var selectedVal = currentValue || '';
    overlay.innerHTML =
      '<div class="modal" style="max-width:480px; width:90%; max-height:80vh; display:flex; flex-direction:column;">' +
        '<div class="modal-title" style="display:flex; justify-content:space-between; align-items:center;">' +
          '<span>选择 AI 模型 (Model)</span>' +
          '<button type="button" class="btn btn-ghost btn-sm" id="picker-close" style="padding:2px 8px;">✕</button>' +
        '</div>' +
        '<div style="margin-top:10px;">' +
          '<input type="text" class="input" id="picker-filter" placeholder="搜索过滤模型 (Filter models)..." style="width:100%; box-sizing:border-box;" />' +
        '</div>' +
        '<div id="picker-list" style="margin-top:10px; flex:1; overflow-y:auto; max-height:360px; display:flex; flex-direction:column; gap:4px; padding-right:4px;">' +
        '</div>' +
        '<div class="modal-footer" style="margin-top:12px;">' +
          '<button type="button" class="btn btn-ghost" id="picker-cancel">取消</button>' +
          '<button type="button" class="btn btn-primary" id="picker-confirm">确定</button>' +
        '</div>' +
      '</div>';
    overlay.classList.add('show');
    var listEl = document.getElementById('picker-list');
    var filterEl = document.getElementById('picker-filter');
    var confirmBtn = document.getElementById('picker-confirm');
    var cancelBtn = document.getElementById('picker-cancel');
    var closeBtn = document.getElementById('picker-close');

    function updateList(filterText) {
      if (!listEl) return;
      listEl.innerHTML = '';
      var query = (filterText || '').toLowerCase();
      var filtered = items.filter(function(it) {
        return !query || it.id.toLowerCase().indexOf(query) >= 0 || it.name.toLowerCase().indexOf(query) >= 0;
      });
      if (filtered.length === 0) {
        listEl.innerHTML = '<div style="padding:16px; text-align:center; opacity:0.6; font-size:13px;">无匹配模型</div>';
        return;
      }
      filtered.forEach(function(it) {
        var itemDiv = document.createElement('div');
        var isSel = it.id === selectedVal;
        itemDiv.className = 'model-picker-item' + (isSel ? ' active' : '');
        itemDiv.style.cssText = 'padding:8px 12px; border-radius:6px; cursor:pointer; font-size:13px; display:flex; justify-content:space-between; align-items:center; background:' + (isSel ? 'var(--accent-color-transparent, rgba(79, 70, 229, 0.15))' : 'rgba(255,255,255,0.03)') + '; border:1px solid ' + (isSel ? 'var(--accent-color, #4f46e5)' : 'transparent') + '; transition:background 0.15s;';
        itemDiv.innerHTML = '<span>' + escapeHtml(it.name) + '</span>' + (isSel ? '<span style="color:var(--accent-color, #4f46e5); font-weight:bold;">✓</span>' : '');
        itemDiv.onclick = function() {
          selectedVal = it.id;
          updateList(filterEl ? filterEl.value : '');
        };
        listEl.appendChild(itemDiv);
      });
    }

    updateList('');
    if (filterEl) {
      setTimeout(function() { filterEl.focus(); }, 50);
      filterEl.oninput = function() { updateList(filterEl.value); };
    }
    function close() {
      overlay.classList.remove('show');
      overlay.innerHTML = '';
    }
    cancelBtn.onclick = close;
    closeBtn.onclick = close;
    confirmBtn.onclick = function() {
      close();
      if (typeof onSelect === 'function') onSelect(selectedVal);
    };
  }
}
window.promptModal = promptModal;
window.openModelPickerModal = openModelPickerModal;

function closeModalOverlay() {
  document.dispatchEvent(new CustomEvent('tinyrouter:modal-close'));
  var overlay = document.getElementById('modal-overlay');
  if (typeof window.__confirmResolver === 'function') {
    var r = window.__confirmResolver;
    window.__confirmResolver = null;
    r(false);
  }
  if (typeof cleanupFileTransferModal === 'function') cleanupFileTransferModal();
  overlay.classList.remove('show');
  overlay.innerHTML = '';
}

function topOpenModal() {
  var modalOverlay = document.getElementById('modal-overlay');
  if (modalOverlay && (modalOverlay.classList.contains('show') || modalOverlay.children.length > 0 || typeof window.__confirmResolver === 'function')) {
    return modalOverlay;
  }
  var ms = document.querySelectorAll('.modal-overlay.show, .info-modal-overlay.show, .pg-modal-overlay.show');
  return ms.length ? ms[ms.length - 1] : null;
}

// Unified dismissal: ESC / right-click / Cancel all funnel here.
function dismissTopModal() {
  var m = topOpenModal();
  if (!m) return;
  if (m.id === 'modal-overlay') {
    closeModalOverlay();
    return;
  }
  if (m.classList.contains('info-modal-overlay')) {
    if (typeof closeInfoModal === 'function') closeInfoModal();
    return;
  }
  if (m.classList.contains('pg-modal-overlay')) {
    if (m.id === 'pg-model-picker-overlay') {
      if (typeof pgCloseModelPicker === 'function') pgCloseModelPicker();
    } else {
      if (typeof pgCloseModal === 'function') pgCloseModal();
    }
    return;
  }
  if (typeof m.__close === 'function') { m.__close(); return; }
  m.classList.remove('show');
  setTimeout(function() { if (m.parentNode && m.id !== 'modal-overlay') m.parentNode.removeChild(m); }, 400);
}

// Right-click anywhere closes the topmost open modal.
document.addEventListener('contextmenu', function(e) {
  if (topOpenModal()) { e.preventDefault(); dismissTopModal(); }
});

function handleThemeModalKeyDown(e, modal) {
  if (e.key === 'Escape') {
    e.preventDefault();
    dismissTopModal();
    return true;
  }

  var darkCards = Array.prototype.slice.call(modal.querySelectorAll('[data-group="dark"] .theme-card'));
  var lightCards = Array.prototype.slice.call(modal.querySelectorAll('[data-group="light"] .theme-card'));
  var styleSwatches = Array.prototype.slice.call(modal.querySelectorAll('.style-swatch'));
  var footerBtns = Array.prototype.slice.call(modal.querySelectorAll('.modal-footer button'));

  var groups = [
    { name: 'dark', items: darkCards },
    { name: 'night', items: lightCards },
    { name: 'style', items: styleSwatches },
    { name: 'button', items: footerBtns }
  ];

  var activeEl = document.activeElement;
  var targetControl = activeEl ? (activeEl.closest ? activeEl.closest('.theme-card, .style-swatch, .btn, button') : activeEl) : null;
  var currentGroupIdx = -1;
  var currentItemIdx = -1;

  for (var gi = 0; gi < groups.length; gi++) {
    var idx = groups[gi].items.indexOf(targetControl);
    if (idx !== -1) {
      currentGroupIdx = gi;
      currentItemIdx = idx;
      break;
    }
  }

  // 1. Tab key cycling: dark -> night -> style -> button -> dark
  if (e.key === 'Tab') {
    e.preventDefault();
    var nextGroupIdx;
    if (e.shiftKey) {
      if (currentGroupIdx <= 0) nextGroupIdx = groups.length - 1;
      else nextGroupIdx = currentGroupIdx - 1;
    } else {
      if (currentGroupIdx < 0 || currentGroupIdx >= groups.length - 1) nextGroupIdx = 0;
      else nextGroupIdx = currentGroupIdx + 1;
    }

    var targetGroup = groups[nextGroupIdx];
    if (targetGroup && targetGroup.items.length > 0) {
      var targetItem = targetGroup.items.find(function(el) {
        return el.classList.contains('active') || el.classList.contains('selected') || el.id === 'settings-modal-save';
      }) || targetGroup.items[0];
      if (targetItem) targetItem.focus();
    }
    return true;
  }

  // 2. Arrow keys: Move focus within the active group
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (currentGroupIdx === -1) {
      if (groups[0].items.length > 0) {
        var firstItem = groups[0].items.find(function(el) { return el.classList.contains('active') || el.classList.contains('selected'); }) || groups[0].items[0];
        if (firstItem) firstItem.focus();
      }
      return true;
    }

    var items = groups[currentGroupIdx].items;
    if (items.length === 0) return true;

    var nextItemIdx = currentItemIdx;
    if (currentGroupIdx === 0 || currentGroupIdx === 1) {
      // 3x3 Card Grid (Dark or Night Group)
      var cols = 3;
      var total = items.length;
      if (e.key === 'ArrowRight') {
        nextItemIdx = (currentItemIdx + 1) % total;
      } else if (e.key === 'ArrowLeft') {
        nextItemIdx = (currentItemIdx - 1 + total) % total;
      } else if (e.key === 'ArrowDown') {
        nextItemIdx = (currentItemIdx + cols) % total;
      } else if (e.key === 'ArrowUp') {
        nextItemIdx = (currentItemIdx - cols + total) % total;
      }
    } else {
      // Linear layout (Style Group or Button Group)
      var totalLinear = items.length;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        nextItemIdx = (currentItemIdx + 1) % totalLinear;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        nextItemIdx = (currentItemIdx - 1 + totalLinear) % totalLinear;
      }
    }

    if (items[nextItemIdx]) {
      items[nextItemIdx].focus();
    }
    return true;
  }

  // 3. Spacebar: Select / Activate item
  if (e.key === ' ' || e.key === 'Spacebar') {
    if (activeEl && (activeEl.classList.contains('theme-card') || activeEl.classList.contains('style-swatch') || activeEl.tagName === 'BUTTON')) {
      e.preventDefault();
      activeEl.click();
      return true;
    }
  }

  // 4. Enter: Confirm and Exit
  if (e.key === 'Enter') {
    e.preventDefault();
    if (activeEl && activeEl.tagName === 'BUTTON' && activeEl.id !== 'settings-modal-save') {
      activeEl.click();
    } else {
      var saveBtn = modal.querySelector('#settings-modal-save');
      if (saveBtn) saveBtn.click();
      else dismissTopModal();
    }
    return true;
  }

  return false;
}

// Global Custom Animated Dropdown Component (matching Download & Settings Modal)
window.topOpenModal = topOpenModal;
window.dismissTopModal = dismissTopModal;

