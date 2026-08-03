// ===== Quota Monitor table =====


function formatQuotaCell(bar) {
  var capacity = bar.hasQuota ? String(bar.totalCapacity) : '\u221e';
  var html = '<span class="quota-success">' + (bar.successCount || 0) + '</span>' +
    '<span class="quota-sep"> / </span>' +
    '<span class="quota-capacity">' + capacity + '</span>';
  if (bar.errorCount && bar.errorCount > 0) {
    html += '<span class="quota-error-badge">' + bar.errorCount + '</span>';
  }
  return html;
}
// renderQuotaRow returns a top-level <tr> for a QuotaBar.
function renderQuotaRow(bar) {
  var itemId = 'qr-' + sanitizeId(bar.provider) + '-' + sanitizeId(bar.model);
  var multi = isMultiKeyProvider(bar.provider);
  var chevronHtml = multi
    ? '<span class="quota-row-chevron">' + QUOTA_CHEVRON + '</span>'
    : '';
  var quotaHtml = formatQuotaCell(bar);
  var rowHtml = '<tr class="quota-row" id="' + itemId + '" data-key="' + escapeHtml(bar.provider + '/' + bar.model) + '"';
  if (multi) {
    var pEsc = escapeHtml(bar.provider).replace(/'/g, "\\'");
    var mEsc = escapeHtml(bar.model).replace(/'/g, "\\'");
    rowHtml += ' onclick="toggleQuotaRowExpand(\'' + pEsc + '\',\'' + mEsc + '\')" style="cursor:pointer"';
  }
  rowHtml += '>\
    <td class="quota-td-chevron">' + chevronHtml + '</td>\
    <td>' + escapeHtml(bar.provider) + '</td>\
    <td>' + escapeHtml(displayModelName(bar.model, bar.alias || bar.model)) + '</td>\
    <td class="quota-td-quota">' + quotaHtml + '</td>\
    <td>' + formatCompactTokens(bar.inputTokens) + '</td>\
    <td>' + formatCompactTokens(bar.outputTokens) + '</td>\
    <td class="quota-td-latency">—</td>\
    <td class="quota-td-speed">—</td>\
  </tr>';
  return rowHtml;
}

// patchQuotaRow updates a top-level row's volatile cells (quota, tokens,
// latency, speed, chevron rotation). Reuses the existing <tr> by id.
function patchQuotaRow(el, bar) {
  el.querySelector('.quota-td-quota').innerHTML = formatQuotaCell(bar);
  // tokens columns (4th and 5th data cells)
  var tds = el.querySelectorAll('td');
  tds[4].textContent = formatCompactTokens(bar.inputTokens);
  tds[5].textContent = formatCompactTokens(bar.outputTokens);
  // latency + speed filled by patchQuotaRowActiveMetrics when per-key data arrives
}

// patchQuotaRowActiveMetrics fills the latency/speed cells of a top-level row
// from the active key's per-key metrics once model-keys data is available.
function patchQuotaRowActiveMetrics(provider, model, data) {
  var itemId = 'qr-' + sanitizeId(provider) + '-' + sanitizeId(model);
  var el = document.getElementById(itemId);
  if (!el) return;
  // find the corresponding QuotaBar to identify the active key
  var bar = null;
  for (var key in quotaBarItems) {
    if (key === provider + '/' + model) {
      bar = quotaBarItems[key]._bar;
      break;
    }
  }
  var ak = findActiveKey(data, bar);
  var latCell = el.querySelector('.quota-td-latency');
  var spdCell = el.querySelector('.quota-td-speed');
  if (ak) {
    latCell.innerHTML = formatAvgLatency(ak);
    spdCell.innerHTML = formatAvgSpeed(ak);
  } else {
    latCell.textContent = '—';
    spdCell.textContent = '—';
  }
}

// renderQuotaKeyRows builds per-key <tr> sub-rows inserted after a top row.
function renderQuotaKeyRows(provider, model, data) {
  var itemId = 'qr-' + sanitizeId(provider) + '-' + sanitizeId(model);
  var setKey = JSON.stringify([provider, model]);
  if (!expandedModels.has(setKey)) return;
  var color = getModelColor(provider, model);
  if (!data || !data.keys || data.keys.length === 0) {
    return '<tr class="quota-key-row quota-key-row-empty"><td colspan="8" style="text-align:center;color:var(--text-muted)">' + escapeHtml(t('noKeysConfigured')) + '</td></tr>';
  }
  var rows = '';
  data.keys.forEach(function(k) {
    if (data.hasQuota && k.hasQuota && k.modelRemaining === 0) {
      return; // skip exhausted keys — they're counted in the provider-level aggregate, not shown per-key
    }
    var statusBadge = '';
    if (data.hasQuota) {
      if (k.hasQuota) {
        if (k.modelRemaining === 0) {
          statusBadge = '<span class="key-status-badge key-status-exhausted">' + t('exhausted') + '</span>';
        } else {
          statusBadge = '<span class="key-status-badge key-status-available">' + t('available') + '</span>';
        }
      } else {
        statusBadge = '<span class="key-status-badge key-status-untested">' + t('untestedKey') + '</span>';
      }
    } else {
      if (k.modelLock) {
        if (k.status === 'locked') {
          statusBadge = '<span class="key-status-badge key-status-locked">' + t('dailyLocked') + '</span>';
        } else {
          statusBadge = '<span class="key-status-badge key-status-cooldown">' + t('cooldown') + '</span>';
        }
      } else if (!k.isActive) {
        statusBadge = '<span class="key-status-badge key-status-inactive">' + t('inactive') + '</span>';
      } else {
        statusBadge = '<span class="key-status-badge key-status-available">' + t('available') + '</span>';
      }
    }

    var dotClass = 'model-color-dot';
    if (k.inFlight && k.inFlight > 0) dotClass += ' model-color-dot-calling';

    var rowClass = 'quota-key-row';
    var usable = k.isActive && k.status === 'active' && !k.modelLock;
    if (usable && ((data.inUseKeyID && k.keyId === data.inUseKeyID) || (!data.inUseKeyID && data.inUseKeyName && k.keyName === data.inUseKeyName))) {
      dotClass += ' model-color-dot-in-use';
      rowClass += ' quota-key-row-in-use';
    } else if (!usable) {
      rowClass += ' quota-key-row-disabled';
    }

    var timerHtml = '';
    if (k.modelLock || k.status === 'cooldown' || k.status === 'locked') {
      if (k.modelLock) {
        var unlockMs = new Date(k.modelLock).getTime() - Date.now();
        timerHtml = '<span class="model-key-timer model-key-timer-cooldown" data-type="cooldown" data-unlock="' + k.modelLock + '">' + formatMinutes(unlockMs) + '</span>';
      }
    } else if (k.lastUsedAt) {
      var isCurrentlyInUse = (data.inUseKeyID && k.keyId === data.inUseKeyID) ||
        (!data.inUseKeyID && data.inUseKeyName && k.keyName === data.inUseKeyName);
      var isCurrentlyCalling = k.inFlight && k.inFlight > 0;
      if (!isCurrentlyInUse && !isCurrentlyCalling) {
        var idleMs = Date.now() - new Date(k.lastUsedAt).getTime();
        timerHtml = '<span class="model-key-timer model-key-timer-idle" data-type="idle" data-used-at="' + k.lastUsedAt + '">' + formatMinutes(idleMs) + '</span>';
      }
    }
    var leadHtml = timerHtml !== '' ? timerHtml : '<span class="' + dotClass + '" style="background:' + color + '"></span>';

    var quotaStr = (data.hasQuota && k.hasQuota) ? ((k.modelLimit - k.modelRemaining) + '/' + k.modelLimit) : '∞';

    rows += '<tr class="' + rowClass + '">\
      <td></td>\
      <td>' + leadHtml + '</td>\
      <td>' + escapeHtml(k.keyName) + '</td>\
      <td>' + quotaStr + '</td>\
      <td colspan="2">' + statusBadge + '</td>\
      <td>' + formatAvgLatency(k) + '</td>\
      <td>' + formatAvgSpeed(k) + '</td>\
    </tr>';
  });
  if (rows === '') {
    return '<tr class="quota-key-row quota-key-row-empty"><td colspan="8" style="text-align:center;color:var(--text-muted)">' + escapeHtml(t('noKeysConfigured')) + '</td></tr>';
  }
  return rows;
}

// updateQuotaTable renders/updates the quota monitor table. Active (in-flight)
// rows float to the top; the rest stay in provider/model letter order.
function updateQuotaTable(bars) {
  if (!bars) bars = [];
  var tbody = document.getElementById('quota-tbody');
  if (!tbody) return;
  if (!lockCountdownTimerStarted) {
    lockCountdownTimerStarted = true;
    clearInterval(lockCountdownInterval);
    lockCountdownInterval = setInterval(function() {
      updateLockCountdowns();
      updateKeyTimers();
    }, 1000);
  }
  // sort: active first, then provider/model
  var sorted = bars.slice().sort(function(a, b) {
    var aActive = a.inFlightKeyNames && a.inFlightKeyNames.length > 0 ? 0 : 1;
    var bActive = b.inFlightKeyNames && b.inFlightKeyNames.length > 0 ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    var ka = a.provider + '/' + a.model;
    var kb = b.provider + '/' + b.model;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  var seen = {};
  var orderedKeys = [];
  // Pass 1: patch existing rows + create new ones (left detached; Pass 2
  // attaches them in sorted order). No DOM moves happen here.
  for (var i = 0; i < sorted.length; i++) {
    var bar = sorted[i];
    var key = bar.provider + '/' + bar.model;
    seen[key] = true;
    orderedKeys.push(key);
    var el = quotaBarItems[key];
    if (el) {
      patchQuotaRow(el, bar);
      el._bar = bar;
    } else {
      var temp = document.createElement('tbody');
      temp.innerHTML = renderQuotaRow(bar);
      var newEl = temp.firstElementChild;
      quotaBarItems[key] = newEl;
      newEl._bar = bar;
    }
  }
  // Drop stale empty-state placeholder rows now that we have data.
  if (sorted.length > 0) {
    var empties = tbody.querySelectorAll('.quota-empty');
    for (var e = 0; e < empties.length; e++) empties[e].remove();
  }
  // Pass 2: reorder only when the live main-row order differs from sorted
  // order. Move each main row together with its expanded sub-rows (which are
  // DOM siblings, not children) via a DocumentFragment: one reflow relocates
  // a whole group and never orphans sub-rows. Steady state → 0 DOM moves.
  var liveMain = [];
  for (var j = 0; j < tbody.children.length; j++) {
    var ch = tbody.children[j];
    if (ch.classList && !ch.classList.contains('quota-key-row') && !ch.classList.contains('quota-empty')) {
      liveMain.push(ch);
    }
  }
  var needReorder = liveMain.length !== orderedKeys.length;
  if (!needReorder) {
    for (var i = 0; i < orderedKeys.length; i++) {
      if (liveMain[i] !== quotaBarItems[orderedKeys[i]]) { needReorder = true; break; }
    }
  }
  if (needReorder) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < orderedKeys.length; i++) {
      var key = orderedKeys[i];
      var el = quotaBarItems[key];
      if (!el) continue;
      frag.appendChild(el);
      var subs = tbody.querySelectorAll('.quota-key-row[data-parent="' + key + '"]');
      for (var s = 0; s < subs.length; s++) frag.appendChild(subs[s]);
    }
    tbody.appendChild(frag);
  }
  // remove rows (and their sub-rows) no longer present
  for (var key2 in quotaBarItems) {
    if (!seen[key2]) {
      var el2 = quotaBarItems[key2];
      if (el2 && el2.parentNode) el2.parentNode.removeChild(el2);
      var subs2 = tbody.querySelectorAll('.quota-key-row[data-parent="' + key2 + '"]');
      for (var s = 0; s < subs2.length; s++) subs2[s].remove();
      delete quotaBarItems[key2];
    }
  }
  // empty state
  if (sorted.length === 0) {
    tbody.innerHTML = '<tr class="quota-empty"><td colspan="8" style="text-align:center;color:var(--text-muted)">' + escapeHtml(t('noQuota')) + '</td></tr>';
  }
}

function updateLockCountdowns() {
  var els = document.querySelectorAll('.model-key-countdown[data-unlock]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var unlock = el.getAttribute('data-unlock');
    if (!unlock) continue;
    var remaining = new Date(unlock).getTime() - Date.now();
    if (remaining <= 0) {
      el.textContent = '0s';
      el.classList.add('model-key-countdown-done');
    } else {
      el.textContent = formatRemaining(remaining);
    }
  }
}

function updateKeyTimers() {
  var els = document.querySelectorAll('.model-key-timer');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var type = el.getAttribute('data-type');
    if (type === 'cooldown') {
      var unlock = el.getAttribute('data-unlock');
      if (!unlock) continue;
      var remaining = new Date(unlock).getTime() - Date.now();
      if (remaining <= 0) {
        el.classList.remove('model-key-timer-cooldown');
        el.classList.add('model-key-timer-idle');
        el.setAttribute('data-type', 'idle');
        el.removeAttribute('data-unlock');
        var nowIso = new Date().toISOString();
        el.setAttribute('data-used-at', nowIso);
        el.textContent = '00';
        var row = el.closest('.quota-key-row');
        if (row) {
          var badge = row.querySelector('.key-status-badge');
          if (badge && (badge.classList.contains('key-status-cooldown') || badge.classList.contains('key-status-locked'))) {
            badge.classList.remove('key-status-cooldown', 'key-status-locked');
            badge.classList.add('key-status-available');
            badge.textContent = t('available');
          }
        }
      } else {
        el.textContent = formatMinutes(remaining);
      }
    } else if (type === 'idle') {
      var usedAt = el.getAttribute('data-used-at');
      if (!usedAt) continue;
      var elapsed = Date.now() - new Date(usedAt).getTime();
      if (elapsed < 0) elapsed = 0;
      el.textContent = formatMinutes(elapsed);
    }
  }
}

function toggleQuotaRowExpand(provider, model) {
  var itemId = 'qr-' + sanitizeId(provider) + '-' + sanitizeId(model);
  var el = document.getElementById(itemId);
  if (!el) return;
  var setKey = JSON.stringify([provider, model]);
  var chevron = el.querySelector('.quota-row-chevron');
  if (expandedModels.has(setKey)) {
    expandedModels.delete(setKey);
    if (chevron) chevron.style.transform = '';
    var key = provider + '/' + model;
    var subs = el.parentNode.querySelectorAll('.quota-key-row[data-parent="' + key + '"]');
    subs.forEach(function(s) { s.remove(); });
  } else {
    expandedModels.add(setKey);
    if (chevron) chevron.style.transform = 'rotate(180deg)';
    var cache = keyDetailCache[provider + '/' + model];
    if (cache && cache.data) {
      var html = renderQuotaKeyRows(provider, model, cache.data);
      if (html) {
        var tmp = document.createElement('tbody');
        tmp.innerHTML = html;
        var key2 = provider + '/' + model;
        var parent = el;
        while (tmp.firstElementChild) {
          var node = tmp.firstElementChild;
          node.setAttribute('data-parent', key2);
          parent.parentNode.insertBefore(node, parent.nextSibling);
          parent = node;
        }
      }
    } else {
      // loading placeholder
      var ph = document.createElement('tr');
      ph.className = 'quota-key-row quota-key-row-loading';
      ph.setAttribute('data-parent', provider + '/' + model);
      ph.innerHTML = '<td colspan="8" style="text-align:center;color:var(--text-muted)">' + escapeHtml(t('loading')) + '...</td>';
      el.parentNode.insertBefore(ph, el.nextSibling);
    }
    fetchModelKeyDetail(provider, model);
  }
}

async function fetchModelKeyDetail(provider, model) {
  try {
    var data = await apiGet('/usage/model-keys?provider=' + encodeURIComponent(provider) + '&model=' + encodeURIComponent(model));
    keyDetailCache[provider + '/' + model] = { data: data, ts: Date.now() };
    patchQuotaRowActiveMetrics(provider, model, data);
    var setKey = JSON.stringify([provider, model]);
    if (expandedModels.has(setKey)) {
      renderQuotaKeyRowsInto(provider, model, data);
    }
  } catch(e) {
    var setKey2 = JSON.stringify([provider, model]);
    if (expandedModels.has(setKey2)) {
      var itemId = 'qr-' + sanitizeId(provider) + '-' + sanitizeId(model);
      var el = document.getElementById(itemId);
      if (el) {
        var key = provider + '/' + model;
        var subs = el.parentNode.querySelectorAll('.quota-key-row[data-parent="' + key + '"]');
        subs.forEach(function(s) { s.remove(); });
        var err = document.createElement('tr');
        err.className = 'quota-key-row quota-key-row-error';
        err.setAttribute('data-parent', key);
        err.innerHTML = '<td colspan="8" style="color:var(--danger)">' + t('failed', [e.message || '']) + '</td>';
        el.parentNode.insertBefore(err, el.nextSibling);
      }
    }
  }
}

// renderQuotaKeyRowsInto replaces the sub-rows under a top-level row with fresh
// per-key <tr>s built from data.
function renderQuotaKeyRowsInto(provider, model, data) {
  var itemId = 'qr-' + sanitizeId(provider) + '-' + sanitizeId(model);
  var el = document.getElementById(itemId);
  if (!el) return;
  var key = provider + '/' + model;
  var subs = el.parentNode.querySelectorAll('.quota-key-row[data-parent="' + key + '"]');
  subs.forEach(function(s) { s.remove(); });
 var html = renderQuotaKeyRows(provider, model, data);
  if (!html) return;
  var tmp = document.createElement('tbody');
  tmp.innerHTML = html;
  var parent = el;
  while (tmp.firstElementChild) {
    var node = tmp.firstElementChild;
    node.setAttribute('data-parent', key);
    parent.parentNode.insertBefore(node, parent.nextSibling);
    parent = node;
  }
}
// latency/speed + expanded sub-rows. It fetches every quota bar so the
// top-level latency/speed cells are populated even before a row is expanded.
// Sub-row rendering remains gated by expandedModels inside fetchModelKeyDetail.
function refreshAllKeyDetails() {
  var now = Date.now();
  if (now - _lastPerKeyRefresh < KEY_DETAIL_TTL) return;
  _lastPerKeyRefresh = now;
  for (var key in quotaBarItems) {
    var el = quotaBarItems[key];
    if (!el || !el._bar) continue;
    var cache = keyDetailCache[key];
    if (cache && now - cache.ts < KEY_DETAIL_TTL) continue;  // still fresh
    fetchModelKeyDetail(el._bar.provider, el._bar.model);
  }
}