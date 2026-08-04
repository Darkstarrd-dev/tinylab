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

function postProcessRawFields() {
  var elements = document.querySelectorAll('.info-json-raw');
  for (var i = 0; i < elements.length; i++) {
    var id = elements[i].getAttribute('data-raw-id');
    if (id && __rawFieldMap[id] !== undefined) {
      elements[i].textContent = String(__rawFieldMap[id]);
    }
  }
}

function renderInfoSection(title, data, rawOverrides) {
  __infoModalSections.push({title: title, data: data});
  var content = '';
  if (data === null || data === undefined) {
    content = '<pre class="info-json">' + t('noData') + '</pre>';
  } else {
    var keys = [];
    for (var k in data) {
      if (k === 'bodyRaw' || k === 'responseBodyRaw') continue;
      keys.push(k);
    }
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki];
      var v = data[k];
      var rawOverride = (rawOverrides && rawOverrides[k] != null) ? rawOverrides[k] : null;
      content += buildInfoField(k, v, rawOverride);
    }
  }
  return '<div class="info-section"><div class="info-section-title">' + escapeHtml(title) + '</div>' + content + '</div>';
}

function buildInfoField(key, value, rawOverride) {
  if (value === null) {
    var raw = rawOverride != null ? rawOverride : 'null';
    return buildSimpleField(key, 'null', raw);
  }
  if (typeof value === 'string') {
    try {
      var parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object') {
        var rawStr = rawOverride != null ? rawOverride : value;
        return buildFieldWithSubFields(key, parsed, rawStr);
      }
    } catch (e) {}
    var raw = rawOverride != null ? rawOverride : value;
    return buildSimpleField(key, value, raw);
  }
  if (typeof value === 'object') {
    var pretty = JSON.stringify(value, null, 2);
    var raw = rawOverride != null ? rawOverride : pretty;
    return buildFieldWithSubFields(key, value, raw);
  }
  var raw = rawOverride != null ? rawOverride : String(value);
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
  var prettyId = 'ip-' + Math.random().toString(36).slice(2, 8);
  var rawId = 'ir-' + Math.random().toString(36).slice(2, 8);
  var rawAttr = 'data-raw-id="' + rawId + '"';
  __rawFieldMap[rawId] = rawStr || '';
  var renderedContent = renderMarkdown(prettyHtml);
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
      '<div class="info-json info-json-pretty info-json-markdown" id="' + prettyId + '">' + renderedContent + '</div>' +
      '<pre class="info-json info-json-raw info-json-hidden" id="' + rawId + '" ' + rawAttr + '></pre>' +
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
  var prettyId = 'ip-' + Math.random().toString(36).slice(2, 8);
  var rawId = 'ir-' + Math.random().toString(36).slice(2, 8);
  var rawAttr = 'data-raw-id="' + rawId + '"';
  __rawFieldMap[rawId] = rawStr || '';
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
      '<div class="info-json info-json-pretty info-json-markdown" id="' + prettyId + '">' + prettyHtml + '</div>' +
      '<pre class="info-json info-json-raw info-json-hidden" id="' + rawId + '" ' + rawAttr + '></pre>' +
    '</div>' +
  '</div>';
}

function toggleInfoCollapse(btn) {
  var field = btn.closest('.info-field');
  if (!field) return;
  field.classList.toggle('collapsed');
  var isCollapsed = field.classList.contains('collapsed');
  var label = isCollapsed ? t('expand') : t('collapse');
  btn.setAttribute('data-tooltip', label);
  btn.setAttribute('aria-label', label);
  var svg = btn.querySelector('svg polygon');
  if (svg) {
    if (isCollapsed) {
      svg.setAttribute('points', '2,2 8,5 2,8');
    } else {
      svg.setAttribute('points', '2,2 8,2 5,8');
    }
  }
}

function toggleInfoView(btn, view) {
  var field = btn.closest('.info-field');
  if (!field) return;
  var toggleBtns = field.querySelectorAll('.info-toggle-btn');
  for (var i = 0; i < toggleBtns.length; i++) {
    toggleBtns[i].classList.remove('info-toggle-btn-active');
  }
  btn.classList.add('info-toggle-btn-active');
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

function copyInfoText(btn) {
  var field = btn.closest('.info-field');
  if (!field) return;
  var activeBtn = field.querySelector('.info-toggle-btn-active');
  var view = activeBtn ? activeBtn.getAttribute('data-view') : null;
  var pre;
  if (view === 'pretty') {
    pre = field.querySelector('.info-json-pretty');
  } else if (view === 'raw') {
    pre = field.querySelector('.info-json-raw');
  } else {
    pre = field.querySelector('.info-json');
  }
  var text = pre ? pre.innerText : '';
  navigator.clipboard.writeText(text).then(function() {
    var orig = btn.textContent;
    btn.textContent = t('copied');
    setTimeout(function() { btn.textContent = orig; }, 1500);
  });
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
  navigator.clipboard.writeText(text).then(function() {
    var orig = btn.textContent;
    btn.textContent = t('copied');
    setTimeout(function() { btn.textContent = orig; }, 1500);
  });
}