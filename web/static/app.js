// app.js — Entry + core helpers (autofill, shared state, escape/toast/picker-lock, custom UI).
// P2-03 split: router → app-router.js, modal → app-modal.js, shortcuts → app-shortcuts.js,
// i18n/theme boot → app-i18n-boot.js, session guard → app-auth.js, demo → app-demo.js.
// Load order (see index.html): app.js → app-demo.js → app-router.js → app-i18n-boot.js → app-auth.js → app-modal.js → app-shortcuts.js
// --- Global Autofill Suppression ---
// Disable browser autofill / "Saved Information" popups globally across all input and form elements.
(function disableGlobalAutofill() {
  function applyAutofillOff(el) {
    if (!el || !el.tagName) return;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var type = (el.type || 'text').toLowerCase();
      if (type !== 'checkbox' && type !== 'radio' && type !== 'range' && type !== 'file' && type !== 'submit' && type !== 'button' && type !== 'color') {
        if (!el.hasAttribute('autocomplete') || el.getAttribute('autocomplete') !== 'off') {
          el.setAttribute('autocomplete', 'off');
        }
        if (!el.hasAttribute('autocorrect') || el.getAttribute('autocorrect') !== 'off') {
          el.setAttribute('autocorrect', 'off');
        }
        if (!el.hasAttribute('autocapitalize') || el.getAttribute('autocapitalize') !== 'off') {
          el.setAttribute('autocapitalize', 'off');
        }
        if (!el.hasAttribute('spellcheck') || el.getAttribute('spellcheck') !== 'false') {
          el.setAttribute('spellcheck', 'false');
        }
      }
    } else if (tag === 'form') {
      if (!el.hasAttribute('autocomplete') || el.getAttribute('autocomplete') !== 'off') {
        el.setAttribute('autocomplete', 'off');
      }
    }
  }

  function scanAndApply(root) {
    var inputs = (root || document).querySelectorAll('input, form');
    for (var i = 0; i < inputs.length; i++) {
      applyAutofillOff(inputs[i]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { scanAndApply(document); });
  } else {
    scanAndApply(document);
  }

  document.addEventListener('focusin', function(e) {
    if (e.target) applyAutofillOff(e.target);
  }, true);

  if (window.MutationObserver) {
    var observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType === 1) {
            applyAutofillOff(node);
            scanAndApply(node);
          }
        }
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
})();

// --- State ---
let currentPage = 'monitor';
let currentProviderId = null;
let providersCache = [];
let providerDetailCache = null;
let modelTestStatus = {};
let importTarget = 'models';
var usageEventSource = null;
var navGen = 0;
var utilityActiveTool = null;
var utilityMenuOpen = false;

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function escapeForJsString(s) {
  if (!s) return '';
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

// Lookup a model note by `displayId` (alias OR model id) within a provider.
function findModelNote(provider, displayId) {
  if (!provider || !provider.models) return '';
  for (var i = 0; i < provider.models.length; i++) {
    var m = provider.models[i];
    if ((m.alias && m.alias === displayId) || m.id === displayId) return m.note || '';
  }
  return '';
}

// ===================== Model Note Popover =====================
// Shows a custom hover popover with the model note text. Listens at the
// document level for mouseenter/mouseleave on any element carrying a
// `data-model-note` attribute (decoded from the HTML-escaped value set at
// render time). Supports dynamically-inserted dropdowns without per-item
// re-binding.
document.addEventListener('mouseover', function(e) {
  var el = e.target.closest && e.target.closest('[data-model-note]');
  if (!el || el === document.documentElement) return;
  if (el.dataset.modelNote === '') return;
  showModelNotePopover(el, el.dataset.modelNote);
});
document.addEventListener('mouseout', function(e) {
  var el = e.target.closest && e.target.closest('[data-model-note]');
  if (!el || el === document.documentElement) return;
  if (e.relatedTarget && el.contains(e.relatedTarget)) return;
  hideModelNotePopover();
});

function showModelNotePopover(target, note) {
  if (!note) { hideModelNotePopover(); return; }
  hideModelNotePopover();
  var tip = document.createElement('div');
  tip.className = 'model-note-tip';
  tip.id = 'model-note-tip';
  tip.textContent = note;
  document.body.appendChild(tip);
  positionModelNotePopover(tip, target);
  target._modelNoteTip = tip;
}
function positionModelNotePopover(tip, target) {
  var rect = target.getBoundingClientRect();
  var margin = 6;
  var left = rect.left;
  if (left + tip.offsetWidth > window.innerWidth - 4) {
    left = window.innerWidth - tip.offsetWidth - 4;
  }
  if (left < 4) left = 4;
  var top = rect.top - tip.offsetHeight - margin;
  if (top < 4) top = rect.bottom + margin;
  if (top + tip.offsetHeight > window.innerHeight - 4) {
    top = window.innerHeight - tip.offsetHeight - 4;
  }
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
function hideModelNotePopover() {
  var existing = document.getElementById('model-note-tip');
  if (existing) existing.remove();
}
// ===================== TooltipSystem =====================
// Unified themed tooltip for any element carrying a `data-tooltip` attribute.
// Replaces native title= tooltips (which the UA renders as un-styled OS blocks
// that ignore the theme). Shows on hover AND keyboard focus — matching the
// native title behaviour for sighted keyboard users. A single shared DOM node
// is reused; listeners are delegated at document level so dynamically inserted
// content (rendered lists, dropdowns, streamed messages) needs no per-item
// binding. Styling comes from the `.tip` class in style.css, which consumes the
// same theme tokens as .model-note-tip / .quota-tip, so it follows every
// mode/variant/style automatically.
var TooltipSystem = (function() {
  var tip = null;          // shared <div class="tip">
  var showTimer = null;    // hover delay handle
  var currentEl = null;    // element the tip is currently anchored to
  var SHOW_DELAY = 600;     // ms — matches native title hover delay, avoids flicker on rapid traversal

  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.id = 'app-tooltip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    return tip;
  }

  function showFor(el, content) {
    if (!content) { hide(); return; }
    currentEl = el;
    var t = ensureTip();
    t.textContent = content;          // textContent keeps us immune to HTML injection from data-tooltip values
    
    // 1. 移除 visible，重置为 scale: 0
    t.classList.remove('visible');
    
    // 2. 重新计算位置
    position(t, el);
    
    // 3. 双重 rAF 确保浏览器渲染引擎与 GPU 合成器记录初始帧状态
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        t.classList.add('visible');
      });
    });
  }

  function position(t, el) {
    var rect = el.getBoundingClientRect();
    var margin = 8;
    var rawLeft = rect.left + (rect.width / 2) - (t.offsetWidth / 2);
    var left = rawLeft;
    var arrowOffset = 0;
    if (left + t.offsetWidth > window.innerWidth - 6) {
      var clampedLeft = window.innerWidth - t.offsetWidth - 6;
      arrowOffset = rawLeft - clampedLeft;
      left = clampedLeft;
    }
    if (left < 6) {
      var clampedLeft = 6;
      arrowOffset = rawLeft - clampedLeft;
      left = clampedLeft;
    }

    var isAbove = true;
    var top = rect.top - t.offsetHeight - margin;       // prefer above
    if (top < 6) {
      top = rect.bottom + margin;            // flip below if no room above
      isAbove = false;
    }
    if (top + t.offsetHeight > window.innerHeight - 6) {
      top = window.innerHeight - t.offsetHeight - 6;
    }

    t.setAttribute('data-placement', isAbove ? 'top' : 'bottom');
    t.style.setProperty('--arrow-offset', arrowOffset + 'px');
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }

  function hide() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (tip) {
      tip.classList.remove('visible');
    }
    currentEl = null;
  }

  function scheduleShow(el, content) {
    clearTimeout(showTimer);
    showTimer = setTimeout(function() { showFor(el, content); }, SHOW_DELAY);
  }

  function contentOf(el) { return el.getAttribute('data-tooltip') || ''; }

  // Hover path (delegated — covers dynamically inserted elements).
  document.addEventListener('mouseover', function(e) {
    var el = e.target.closest && e.target.closest('[data-tooltip]');
    if (!el || el === document.documentElement) return;
    var c = contentOf(el);
    if (!c) return;
    scheduleShow(el, c);
  });
  document.addEventListener('mouseout', function(e) {
    var el = e.target.closest && e.target.closest('[data-tooltip]');
    if (!el || el === document.documentElement) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;   // moving within the same el
    hide();
  });

  // Focus path — restores the visual tooltip sighted keyboard users get from
  // native title=. Without this, removing title= would regress keyboard UX.
  // Immediate (no delay): focus is an intentional act, not incidental traversal.
  document.addEventListener('focusin', function(e) {
    var el = e.target.closest && e.target.closest('[data-tooltip]');
    if (!el || el === document.documentElement) return;
    var c = contentOf(el);
    if (!c) return;
    showFor(el, c);
  });
  document.addEventListener('focusout', function(e) {
    var el = e.target.closest && e.target.closest('[data-tooltip]');
    if (!el || el === document.documentElement) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    hide();
  });

  // Reposition / hide on scroll/resize so the tip never floats away from its anchor.
  window.addEventListener('scroll', function() { if (currentEl && tip && tip.classList.contains('visible')) position(tip, currentEl); }, true);
  window.addEventListener('resize', function() { if (currentEl && tip && tip.classList.contains('visible')) position(tip, currentEl); });

  return { showFor: showFor, hide: hide };
})();

function maskKey(key) {
  if (!key || key.length <= 8) return '***';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

function formatMillionTokens(n) {
  return (Number(n || 0) / 1000000).toFixed(3) + 'M';
}

function copyToClipboard(text, label) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      toast((label || text) + ' ' + t('copied'), 'success');
    }).catch(function() {
      fallbackCopy(text, label);
    });
  } else {
    fallbackCopy(text, label);
  }
}

function fallbackCopy(text, label) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast((label || text) + ' ' + t('copied'), 'success');
  } catch (e) {
    toast(t('copyFailed'), 'error');
  }
  document.body.removeChild(ta);
}

function getSpinnerHtml() {
  return '<svg class="btn-spinner-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" style="display:inline-block;vertical-align:middle;box-sizing:border-box"><path d="M12 2a10 10 0 0 1 10 10"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.75s" repeatCount="indefinite"/></path></svg>';
}

function withLoading(btn, asyncFn) {
  if (!btn || btn.disabled) return Promise.resolve();
  var original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = getSpinnerHtml();
  return Promise.resolve(asyncFn()).finally(function() {
    btn.disabled = false;
    btn.innerHTML = original;
  });
}

function emptyState(msg) {
  return '<div class="empty"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg><p>' + msg + '</p></div>';
}

function getProviderBrand(name) {
  var n = (name || '').toLowerCase();
  if (n.indexOf('deepseek') >= 0) return '#4fc3f7';
  if (n.indexOf('openai') >= 0 || n.indexOf('gpt') >= 0) return '#10a37f';
  if (n.indexOf('claude') >= 0 || n.indexOf('anthropic') >= 0) return '#d97706';
  if (n.indexOf('gemini') >= 0 || n.indexOf('google') >= 0) return '#4285f4';
  if (n.indexOf('moonshot') >= 0 || n.indexOf('kimi') >= 0) return '#6b21a8';
  if (n.indexOf('qwen') >= 0 || n.indexOf('alibaba') >= 0 || n.indexOf('aliyun') >= 0) return '#ff6a00';
  if (n.indexOf('baichuan') >= 0) return '#2563eb';
  if (n.indexOf('siliconflow') >= 0) return '#7c3aed';
  if (n.indexOf('modelscope') >= 0) return '#a855f7';
  return '';
}

function toast(message, type, duration, key) {
  if (type === undefined) type = 'info';
  if (duration === undefined) duration = 3500;
  const container = document.getElementById('toast-container');
  if (!container) return;
  if (key) {
    var prev = container.querySelectorAll('[data-toast-key="' + key + '"]');
    for (var pi = 0; pi < prev.length; pi++) prev[pi].remove();
  }
  var svgCheck = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  var svgX = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var svgInfo = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  var svgWarn = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  const icons = { success: svgCheck, error: svgX, info: svgInfo, warning: svgWarn };
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  if (key) el.setAttribute('data-toast-key', key);
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = '<span class="toast-icon">' + icons[type] + '</span><span class="toast-message">' + escapeHtml(message) + '</span><div class="toast-progress"></div>';
  container.appendChild(el);
  requestAnimationFrame(function() { el.classList.add('show'); });
  setTimeout(function() {
    el.classList.remove('show');
    el.addEventListener('transitionend', function() { el.remove(); }, { once: true });
  }, duration);
}

function beginNativePickerLock(kind) {
  if (window.__nativePickerBusy) return false;
  window.__nativePickerBusy = true;
  window.__nativePickerKind = kind || 'file';
  var blocker = document.createElement('div');
  blocker.id = 'native-picker-blocker';
  blocker.setAttribute('aria-hidden', 'true');
  blocker.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:transparent;cursor:wait;pointer-events:auto;';
  document.body.appendChild(blocker);
  return true;
}

function endNativePickerLock() {
  window.__nativePickerBusy = false;
  window.__nativePickerKind = '';
  var blocker = document.getElementById('native-picker-blocker');
  if (blocker) blocker.remove();
}

function blockNativePickerEvent(event) {
  if (!window.__nativePickerBusy) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'dragstart', 'focusin', 'keydown', 'keyup', 'keypress'].forEach(function (type) {
  document.addEventListener(type, blockNativePickerEvent, true);
});

// ===================== Global Modal & Keyboard =====================
// Returns the topmost currently-open modal overlay (.modal-overlay or .info-modal-overlay).
function renderCustomSelectHtml(wrapperId, selectId, options, selectedValue, onChangeHandler, extraStyle, extraSelectAttrs) {
  var styleAttr = extraStyle ? ' style="' + extraStyle + '"' : '';
  var selectedText = selectedValue;
  var optionsHtml = options.map(function(opt) {
    var val = typeof opt === 'object' ? opt.value : opt;
    var label = typeof opt === 'object' ? opt.label : opt;
    var isSel = String(val) === String(selectedValue);
    if (isSel) selectedText = label;
    return '<div class="custom-select-option' + (isSel ? ' selected' : '') + '" data-value="' + escapeAttr(val) + '" data-tooltip="' + escapeAttr(label) + '" onclick="selectCustomOption(\'' + wrapperId + '\', \'' + escapeForJsString(val) + '\', \'' + escapeForJsString(label) + '\')">' +
      '<span class="custom-select-option-link">' + escapeHtml(label) + '</span>' +
      '</div>';
  }).join('');

  var selectOptionsHtml = options.map(function(opt) {
    var val = typeof opt === 'object' ? opt.value : opt;
    var label = typeof opt === 'object' ? opt.label : opt;
    var isSel = String(val) === String(selectedValue);
    return '<option value="' + escapeAttr(val) + '"' + (isSel ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }).join('');

  var onchangeAttr = onChangeHandler ? ' onchange="' + onChangeHandler + '"' : '';
  var selectAttrs = extraSelectAttrs ? ' ' + extraSelectAttrs : '';

  return '<div class="custom-select-wrapper" id="' + wrapperId + '"' + styleAttr + ' onclick="event.stopPropagation()">' +
    '<div class="custom-select-trigger" onclick="toggleCustomSelect(\'' + wrapperId + '\', event)">' +
      '<span class="custom-select-label">' + escapeHtml(selectedText) + '</span>' +
      '<svg viewBox="0 0 512 512"><path d="M233.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L256 338.7 77.7 160.3c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z"/></svg>' +
    '</div>' +
    '<div class="custom-select-menu">' +
      optionsHtml +
    '</div>' +
    '<select id="' + selectId + '"' + onchangeAttr + selectAttrs + ' style="display:none;">' +
      selectOptionsHtml +
    '</select>' +
  '</div>';
}

function toggleCustomSelect(wrapperId, event) {
  if (event) event.stopPropagation();
  var wrapper = document.getElementById(wrapperId);
  if (!wrapper) return;
  var isOpen = wrapper.classList.contains('open');
  closeAllCustomSelects();
  if (!isOpen) {
    wrapper.classList.add('open');
  }
}

function selectCustomOption(wrapperId, value, labelText) {
  var wrapper = document.getElementById(wrapperId);
  if (!wrapper) return;
  var selectEl = wrapper.querySelector('select');
  var labelEl = wrapper.querySelector('.custom-select-label');
  if (selectEl) {
    selectEl.value = value;
    selectEl.dispatchEvent(new Event('change'));
  }
  if (labelEl) {
    labelEl.textContent = labelText;
  }
  var options = wrapper.querySelectorAll('.custom-select-option');
  options.forEach(function(opt) {
    if (opt.dataset.value === value) {
      opt.classList.add('selected');
    } else {
      opt.classList.remove('selected');
    }
  });
  wrapper.classList.remove('open');
}

function closeAllCustomSelects() {
  document.querySelectorAll('.custom-select-wrapper.open').forEach(function(el) {
    el.classList.remove('open');
  });
}

document.addEventListener('click', closeAllCustomSelects);

// Global Number Stepper Component (matching Settings Modal)
// Accepts both the positional form (id, value, min, max, step, extraStyle,
// onchange) used by provider/quick-slot forms AND the legacy opts-object form
// (id, value, {min, max, step, style, placeholder, dataId, inputClass, onchange})
// used by the settings/trace modals, so a single global component serves every caller.
function renderStepperHtml(id, value, min, max, step, extraStyle, onchangeAttrStr) {
  var placeholder = '';
  var dataId = '';
  var inputClass = 'stepper-input';
  if (min && typeof min === 'object') {
    var opts = min;
    min = opts.min;
    max = opts.max;
    step = opts.step;
    extraStyle = opts.style;
    placeholder = opts.placeholder || '';
    dataId = opts.dataId || '';
    if (opts.inputClass) inputClass += ' ' + opts.inputClass;
    if (opts.onchange) onchangeAttrStr = opts.onchange;
  }
  var minAttr = min !== undefined && min !== null ? ' min="' + min + '"' : '';
  var maxAttr = max !== undefined && max !== null ? ' max="' + max + '"' : '';
  var phAttr = placeholder ? ' placeholder="' + placeholder + '"' : '';
  var dataIdAttr = dataId ? ' data-id="' + dataId + '"' : '';
  var stepVal = step || 1;
  var styleAttr = extraStyle ? ' style="' + extraStyle + '"' : '';
  var onchangeStr = onchangeAttrStr ? ' onchange="' + onchangeAttrStr + '"' : '';
  return '<div class="number-stepper"' + styleAttr + '>' +
    '<button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'' + id + '\', -' + stepVal + ')">-</button>' +
    '<input type="number" class="' + inputClass + '" id="' + id + '" value="' + value + '"' + minAttr + maxAttr + phAttr + dataIdAttr + onchangeStr + '>' +
    '<button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'' + id + '\', ' + stepVal + ')">+</button>' +
    '</div>';
}

function changeStepper(id, delta) {
  var input = document.getElementById(id);
  if (!input) return;
  var minStr = input.getAttribute('min');
  var maxStr = input.getAttribute('max');
  var min = minStr !== null && minStr !== '' ? parseFloat(minStr) : null;
  var max = maxStr !== null && maxStr !== '' ? parseFloat(maxStr) : null;
  var stepStr = input.getAttribute('step');
  var isDecimalStep = stepStr && stepStr.indexOf('.') >= 0;
  var hasVal = input.value !== '' && input.value !== null && !isNaN(parseFloat(input.value));
  var step = delta || 1;
  var val = hasVal ? parseFloat(input.value) : (step > 0 && min !== null && min > 0 ? min - step : 0);
  var newVal = val + step;
  if (isDecimalStep) newVal = Math.round(newVal * 10) / 10;
  if (input.hasAttribute('placeholder') && min !== null && newVal < min) {
    input.value = '';
  } else {
    if (min !== null && newVal < min) newVal = min;
    if (max !== null && newVal > max) newVal = max;
    input.value = isDecimalStep ? newVal.toFixed(1).replace(/\.0$/, '') : String(newVal).replace(/\.0$/, '');
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}




