// ===================== Info Modal Common Functions =====================

var INFO_COLLAPSE_THRESHOLD = 3;
var INFO_PREVIEW_ITEMS = 2;
var INFO_PREVIEW_LENGTH = 80;
function updateInfoModalStaticI18n() {
  var btn = document.getElementById('info-modal-copy-all');
  if (btn) btn.textContent = t('copyAll');
}

var observer = new MutationObserver(function() { updateInfoModalStaticI18n(); });
observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lang'] });

var __infoModalSections = [];
var __rawFieldMap = {};
updateInfoModalStaticI18n();

function renderMarkdown(s) {
  if (!s) return '';
  var str = String(s);
  str = str.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
  str = str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (typeof marked !== 'undefined') {
    try {
      var html = marked.parse(str, { breaks: true, gfm: true });
      if (typeof DOMPurify !== 'undefined') {
        html = DOMPurify.sanitize(html);
      }
      return html;
    } catch (e) {}
  }
  return str.replace(/\n/g, '<br>');
}

// Kept as a compatibility hook for callers that render shared modal content.
// Raw values are now written directly into the DOM, so no second pass is needed.
function postProcessRawFields() {}

function infoRawString(value) {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  }
  return String(value);
}

function infoHasValue(value) {
  return value !== undefined && value !== null;
}

function renderInfoSection(title, data, rawOverrides, options) {
  options = options || {};
  var isMonitor = options.monitor === true;
  var collapsible = options.collapsible === true;
  var sectionView = options.sectionView === true;
  var sectionCopy = options.sectionCopy === true;
  var collapsed = collapsible && options.defaultCollapsed === true;
  var sectionIndex = __infoModalSections.length;
  var sectionId = options.sectionId || ('info-section-' + Math.random().toString(36).slice(2, 8));
  if (options.sectionId) {
    __infoModalSections = __infoModalSections.filter(function(section) { return section.sectionId !== sectionId; });
    sectionIndex = __infoModalSections.length;
  }
  var contentId = sectionId + '-content';
  __infoModalSections.push({
    title: title,
    data: data,
    rawOverrides: rawOverrides || null,
    rawData: Object.prototype.hasOwnProperty.call(options, 'rawData') ? options.rawData : data,
    sectionId: sectionId
  });

  var content = '';
  if (!infoHasValue(data)) {
    content = '<pre class="info-json">' + escapeHtml(t('noData')) + '</pre>';
  } else {
    var keys = [];
    if (typeof data === 'object') {
      for (var k in data) {
        if (k === 'bodyRaw' || k === 'responseBodyRaw') continue;
        keys.push(k);
      }
    } else {
      keys.push('Value');
    }
    for (var ki = 0; ki < keys.length; ki++) {
      var key = keys[ki];
      var value = typeof data === 'object' ? data[key] : data;
      var rawOverride = (rawOverrides && Object.prototype.hasOwnProperty.call(rawOverrides, key)) ? rawOverrides[key] : null;
      content += buildInfoField(key, value, rawOverride);
    }
  }

  var classes = 'info-section' + (isMonitor ? ' info-section-monitor' : '') + (collapsed ? ' info-section-collapsed' : '');
  var titleInner = '';
  if (collapsible) {
    titleInner += '<button type="button" class="info-section-toggle" onclick="toggleInfoSection(this)" aria-expanded="' + (collapsed ? 'false' : 'true') + '" aria-controls="' + escapeHtml(contentId) + '">' +
      '<span class="info-section-chevron" aria-hidden="true">' + (collapsed ? '&#9656;' : '&#9662;') + '</span>' +
      '<span class="info-section-title-text">' + escapeHtml(title) + '</span>' +
    '</button>';
  } else {
    titleInner += '<span class="info-section-title-text">' + escapeHtml(title) + '</span>';
  }
  var actions = '';
  if (sectionView) {
    actions += '<span class="info-toggle-view info-section-view" role="group" aria-label="' + escapeHtml(title) + '">' +
      '<button type="button" class="info-toggle-btn info-section-view-btn info-toggle-btn-active" data-view="pretty" onclick="toggleInfoSectionView(this,\'pretty\')">' + t('pretty') + '</button>' +
      '<button type="button" class="info-toggle-btn info-section-view-btn" data-view="raw" onclick="toggleInfoSectionView(this,\'raw\')">' + t('raw') + '</button>' +
    '</span>';
  }
  if (sectionCopy) {
    actions += '<button type="button" class="info-copy-btn info-section-copy-btn" onclick="copyInfoSection(this)">' + t('copy') + '</button>';
  }
  return '<div class="' + classes + '" id="' + escapeHtml(sectionId) + '" data-info-section-index="' + sectionIndex + '">' +
    '<div class="info-section-title">' + titleInner + (actions ? '<span class="info-section-actions">' + actions + '</span>' : '') + '</div>' +
    '<div class="info-section-content" id="' + escapeHtml(contentId) + '"' + (collapsed ? ' hidden' : '') + '>' + content + '</div>' +
  '</div>';
}

function removeInfoSectionRecord(sectionId) {
  __infoModalSections = __infoModalSections.filter(function(section) { return section.sectionId !== sectionId; });
}

function buildInfoField(key, value, rawOverride) {
  if (value === null) {
    var raw = rawOverride !== undefined && rawOverride !== null ? rawOverride : 'null';
    return buildSimpleField(key, 'null', raw);
  }
  if (typeof value === 'string') {
    try {
      var parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object') {
        var rawStr = rawOverride !== undefined && rawOverride !== null ? rawOverride : value;
        return buildFieldWithSubFields(key, parsed, rawStr);
      }
    } catch (e) {}
    var raw = rawOverride !== undefined && rawOverride !== null ? rawOverride : value;
    return buildSimpleField(key, value, raw);
  }
  if (typeof value === 'object') {
    var pretty = JSON.stringify(value, null, 2);
    var raw = rawOverride !== undefined && rawOverride !== null ? rawOverride : pretty;
    return buildFieldWithSubFields(key, value, raw);
  }
  var raw = rawOverride !== undefined && rawOverride !== null ? rawOverride : String(value);
  return buildSimpleField(key, String(value), raw);
}

function countItems(obj) {
  if (Array.isArray(obj)) return obj.length;
  if (obj !== null && typeof obj === 'object') return Object.keys(obj).length;
  return 0;
}

function buildPreview(obj) {
  var items = [];
  var isArr = Array.isArray(obj);
  var keys = isArr ? null : Object.keys(obj);
  var count = Math.min(isArr ? obj.length : keys.length, INFO_PREVIEW_ITEMS);
  for (var i = 0; i < count; i++) {
    var item = isArr ? obj[i] : obj[keys[i]];
    var caption = '';
    if (isArr) {
      if (item !== null && typeof item === 'object') {
        var captionRaw = item.role || item.name || item.type || (item.function && item.function.name) || '';
        caption = escapeHtml(captionRaw);
        if (captionRaw) caption += ': ';
        caption += truncateString(JSON.stringify(item));
      } else {
        caption = truncateString(JSON.stringify(item));
      }
    } else {
      caption = escapeHtml(keys[i]) + ': ' + truncateString(JSON.stringify(item));
    }
    items.push(caption);
  }
  return items.join('<br>');
}

function truncateString(s) {
  if (s.length <= INFO_PREVIEW_LENGTH) return escapeHtml(s);
  return escapeHtml(s.slice(0, INFO_PREVIEW_LENGTH)) + '&hellip;';
}

function buildSimpleField(key, prettyHtml, rawStr) {
  var renderedContent = renderMarkdown(prettyHtml);
  var rawText = infoRawString(rawStr);
  return '<div class="info-field">' +
    '<span class="info-field-key">' +
      '<span class="info-field-key-name">' + escapeHtml(key) + '</span>' +
      '<span class="info-field-actions">' +
        '<span class="info-toggle-view">' +
          '<button type="button" class="info-toggle-btn info-toggle-btn-active" data-view="pretty" onclick="toggleInfoView(this,\'pretty\')">' + t('pretty') + '</button>' +
          '<button type="button" class="info-toggle-btn" data-view="raw" onclick="toggleInfoView(this,\'raw\')">' + t('raw') + '</button>' +
        '</span>' +
        '<button type="button" class="info-copy-btn" onclick="copyInfoText(this)">' + t('copy') + '</button>' +
      '</span>' +
    '</span>' +
    '<div class="info-field-value">' +
      '<div class="info-json info-json-pretty info-json-markdown">' + renderedContent + '</div>' +
      '<pre class="info-json info-json-raw info-json-hidden">' + escapeHtml(rawText) + '</pre>' +
    '</div>' +
  '</div>';
}

function buildFieldWithSubFields(key, obj, rawStr) {
  var n = countItems(obj);
  var needsCollapse = n >= INFO_COLLAPSE_THRESHOLD;
  var collapseBtn = '';
  var previewHtml = '';
  if (needsCollapse) {
    collapseBtn = '<button type="button" class="info-collapse-btn" onclick="toggleInfoCollapse(this)" data-tooltip="' + t('expand') + '" aria-label="' + t('expand') + '">' +
      '<svg width="10" height="10" viewBox="0 0 10 10"><polygon points="2,2 8,5 2,8" fill="currentColor"/></svg></button>';
    previewHtml = '<div class="info-field-preview"><span class="info-preview-count">(' + n + ')</span> ' + buildPreview(obj) + '</div>';
  }
  var prettyHtml = renderMarkdown(JSON.stringify(obj, null, 2));
  var rawText = infoRawString(rawStr);
  return '<div class="info-field' + (needsCollapse ? ' collapsed' : '') + '">' +
    '<span class="info-field-key">' +
      '<span class="info-field-key-name">' + escapeHtml(key) + '</span>' +
      '<span class="info-field-actions">' +
        collapseBtn +
        '<span class="info-toggle-view">' +
          '<button type="button" class="info-toggle-btn info-toggle-btn-active" data-view="pretty" onclick="toggleInfoView(this,\'pretty\')">' + t('pretty') + '</button>' +
          '<button type="button" class="info-toggle-btn" data-view="raw" onclick="toggleInfoView(this,\'raw\')">' + t('raw') + '</button>' +
        '</span>' +
        '<button type="button" class="info-copy-btn" onclick="copyInfoText(this)">' + t('copy') + '</button>' +
      '</span>' +
    '</span>' +
    previewHtml +
    '<div class="info-field-value">' +
      '<div class="info-json info-json-pretty info-json-markdown">' + prettyHtml + '</div>' +
      '<pre class="info-json info-json-raw info-json-hidden">' + escapeHtml(rawText) + '</pre>' +
    '</div>' +
  '</div>';
}


function toggleInfoSection(btn) {
  var section = btn.closest('.info-section');
  if (!section) return;
  var content = section.querySelector('.info-section-content');
  var expanded = !section.classList.contains('info-section-collapsed');
  section.classList.toggle('info-section-collapsed', expanded);
  if (content) content.hidden = expanded;
  btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
  var chevron = btn.querySelector('.info-section-chevron');
  if (chevron) chevron.innerHTML = expanded ? '&#9656;' : '&#9662;';
}

function toggleInfoSectionView(btn, view) {
  var section = btn.closest('.info-section');
  if (!section) return;
  var sectionBtns = section.querySelectorAll('.info-section-view-btn');
  for (var i = 0; i < sectionBtns.length; i++) {
    sectionBtns[i].classList.toggle('info-toggle-btn-active', sectionBtns[i] === btn);
  }
  var fieldBtns = section.querySelectorAll('.info-field .info-toggle-btn[data-view="' + view + '"]');
  for (var j = 0; j < fieldBtns.length; j++) toggleInfoView(fieldBtns[j], view);
}
function toggleInfoView(btn, view) {
  var field = btn.closest('.info-field');
  if (!field) return;
  var toggleBtns = field.querySelectorAll('.info-toggle-btn[data-view]');
  for (var i = 0; i < toggleBtns.length; i++) {
    toggleBtns[i].classList.toggle('info-toggle-btn-active', toggleBtns[i] === btn);
  }
  var prettyPre = field.querySelector('.info-json-pretty');
  var rawPre = field.querySelector('.info-json-raw');
  if (view === 'raw') {
    if (prettyPre) prettyPre.classList.add('info-json-hidden');
    if (rawPre) rawPre.classList.remove('info-json-hidden');
  } else {
    if (prettyPre) prettyPre.classList.remove('info-json-hidden');
    if (rawPre) rawPre.classList.add('info-json-hidden');
  }
}

function infoCopyFeedback(btn) {
  var orig = btn.textContent;
  btn.textContent = t('copied');
  setTimeout(function() { btn.textContent = orig; }, 1500);
}

function copyInfoSection(btn) {
  var sectionEl = btn.closest('.info-section');
  if (!sectionEl) return;
  var sectionId = sectionEl.id;
  var section = __infoModalSections.find(function(item) { return item.sectionId === sectionId; });
  if (!section) return;
  var text = infoRawString(section.rawData !== undefined ? section.rawData : section.data);
  navigator.clipboard.writeText(text).then(function() { infoCopyFeedback(btn); });
}

function copyInfoText(btn) {
  var field = btn.closest('.info-field');
  if (!field) return;
  var activeBtn = field.querySelector('.info-toggle-btn-active[data-view]');
  var view = activeBtn ? activeBtn.getAttribute('data-view') : null;
  var pre;
  if (view === 'pretty') {
    pre = field.querySelector('.info-json-pretty');
  } else if (view === 'raw') {
    pre = field.querySelector('.info-json-raw');
  } else {
    pre = field.querySelector('.info-json');
  }
  var text = pre ? pre.textContent : '';
  navigator.clipboard.writeText(text).then(function() { infoCopyFeedback(btn); });
}

function copyAllInfo(btn) {
  var obj = {};
  for (var i = 0; i < __infoModalSections.length; i++) {
    var section = __infoModalSections[i];
    var data = section.data;
    if (data !== null && typeof data === 'object') {
      var clean = {};
      for (var k in data) {
        if (k === 'bodyRaw' || k === 'responseBodyRaw') continue;
        clean[k] = data[k];
      }
      obj[section.title] = clean;
    } else {
      obj[section.title] = data;
    }
  }
  var text = JSON.stringify(obj, null, 2);
  navigator.clipboard.writeText(text).then(function() { infoCopyFeedback(btn); });
}