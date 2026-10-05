// ===== Quota Monitor table =====


// --- Provider 列的渠道余额读数（Free Hub 聚合，ref 用量徽标同款口径） ---
//
// 数据来自 `GET /api/jethub/balances`：每个渠道一份**归一单位**的余额合计
// （token / 积分），后端已按 ref creditGroupsOf 的口径求和（失败账号不进合计）
// 并带 120s TTL 缓存。这里只负责「找到该 provider 的读数并格式化」。
//
// ⚠️ 只对 Free Hub 桥接渠道显示（`apiType === 'jethub'`）：普通 API Key 渠道
// 没有余额端点，硬查只会得到 404 与空白。

// jethubProviderIdOf 把 QuotaMonitor 的 provider（**名称或 ID**，/monitor/quotas
// 两种形态都可能出现）解析成 Free Hub 短 id（`jethub-zcode` → `zcode`）。
// 返回 '' 表示「不是可查余额的桥接渠道」。
function jethubProviderIdOf(provider) {
  if (!provider || typeof providersCache === 'undefined' || !providersCache) return '';
  for (var i = 0; i < providersCache.length; i++) {
    var p = providersCache[i];
    if (!p || (p.name !== provider && p.id !== provider)) continue;
    // 非桥接渠道直接判否：不要顺着名字去猜（用户手建的 provider 也可能叫
    // 「ZCode」，但它没有 Free Hub 账号池，查余额是错的）。
    if (p.apiType !== 'jethub') return '';
    var id = String(p.id || '');
    return id.indexOf('jethub-') === 0 ? id.slice('jethub-'.length) : '';
  }
  return '';
}

// formatProviderBalanceReading 把一个单位分组的合计格式化成读数文案。
//
// ⚠️ 复用 Free Hub 的格式化函数（`jethub.js` 的 `__jethubFormatUnits`）而不是
// 在 Monitor 里另写一份：token 的两位小数（`30.09M`）与积分的整数/两位小数
// 是**全站唯一口径**（对应 ref credits-format.js），两份实现必然漂移。
// 按用户口径**不带单位字样**（不显示 Token，也不显示「积分」）。
function formatProviderBalanceReading(group) {
  if (!group) return '';
  var value = Number(group.total);
  if (!isFinite(value)) return '';
  if (typeof __jethubFormatUnits !== 'function') return '';
  return String(__jethubFormatUnits(value, group.unit === 'token' ? 'token' : ''));
}

// providerBalanceReading 返回某 provider 的读数 `{ text, title }`，没有可显示
// 的读数时返回 null（非桥接渠道 / 未桥接 / 未拉到 / 全部账号读取失败）。
function providerBalanceReading(provider) {
  var pid = jethubProviderIdOf(provider);
  if (!pid) return null;
  var sum = providerBalances[pid];
  if (!sum || !sum.groups || !sum.groups.length) return null;
  var parts = [];
  for (var i = 0; i < sum.groups.length; i++) {
    var one = formatProviderBalanceReading(sum.groups[i]);
    if (one !== '') parts.push(one);
  }
  if (parts.length === 0) return null;
  // 单元格里只放**第一组**（混合单位是极罕见形态：同一渠道的账号分属两种量纲，
  // 按用户口径不并排堆数字）；title 里给全部组，信息不丢。
  var text = parts[0];
  var title = t('quotaProviderBalanceTitle', [parts.join(' · ')]);
  if (sum.failedCount > 0) {
    title += ' · ' + t('quotaProviderBalancePartial', [String(sum.failedCount)]);
  }
  return { text: text, title: title };
}

// updateProviderBalanceCells 把内存里的读数刷进所有已渲染的 Provider 单元格。
// 行是增量创建/复用的（updateQuotaTable），故本函数必须可重复调用。
function updateProviderBalanceCells() {
  var cells = document.querySelectorAll('.quota-td-provider[data-provider]');
  for (var i = 0; i < cells.length; i++) {
    var span = cells[i].querySelector('.quota-provider-balance');
    if (!span) continue;
    var reading = providerBalanceReading(cells[i].getAttribute('data-provider'));
    if (!reading) {
      // 清空而不是留旧值：渠道被停用/账号删光后，残留的旧数字比空白更误导。
      if (span.textContent !== '') span.textContent = '';
      if (span.title !== '') span.removeAttribute('title');
      continue;
    }
    if (span.textContent !== reading.text) span.textContent = reading.text;
    if (span.title !== reading.title) span.title = reading.title;
  }
}

// refreshProviderBalances 拉一次渠道级合计。失败**静默**（保留内存里的上一次
// 读数）：余额是补语，不该为它弹错或打断 Monitor 的其它渲染。
async function refreshProviderBalances() {
  if (_providerBalancesInFlight) return _providerBalancesInFlight;
  _providerBalancesInFlight = (async function() {
    try {
      var data = await apiGet('/jethub/balances');
      providerBalances = (data && data.balances) || {};
      updateProviderBalanceCells();
    } catch (e) {
      // Free Hub 未接线时该路由不存在（404）——与服务器不可达同款：留空即可。
    }
  })().finally(function() { _providerBalancesInFlight = null; });
  return _providerBalancesInFlight;
}

// providerBalanceTick 由既有的 1s 计数节奏驱动，内部按 PROVIDER_BALANCE_TTL
// 节流（60s，与 ref 徽标 BADGE_POLL_MS 同值）；后端另有 120s TTL，故真实的
// 上游余额请求最多每两分钟一轮 —— Monitor 的 5s 配额轮询绝不会打穿上游。
function providerBalanceTick() {
  if (typeof currentPage !== 'undefined' && currentPage !== 'monitor') return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  var now = Date.now();
  if (providerBalancesAt && now - providerBalancesAt < PROVIDER_BALANCE_TTL) return;
  // 先打点再发请求：in-flight 期间不重复触发（失败也按 60s 退避）。
  providerBalancesAt = now;
  refreshProviderBalances();
}


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
  var setKey = JSON.stringify([bar.provider, bar.model]);
  var isExpanded = expandedModels.has(setKey);
  var chevronHtml = multi
    ? '<span class="quota-row-chevron' + (isExpanded ? ' quota-chevron-expanded' : '') + '" style="margin-right:6px;vertical-align:middle">' + QUOTA_CHEVRON + '</span>'
    : '';
  var quotaHtml = formatQuotaCell(bar);
  var rowHtml = '<tr class="quota-row' + (multi ? ' quota-row-clickable' : '') + (isExpanded ? ' quota-row-expanded' : '') + '" id="' + itemId + '" data-key="' + escapeHtml(bar.provider + '/' + bar.model) + '"';
  if (multi) {
    var pEsc = escapeForJsString(bar.provider);
    var mEsc = escapeForJsString(bar.model);
    rowHtml += ' onclick="toggleQuotaRowExpand(\'' + pEsc + '\',\'' + mEsc + '\')"';
  }
  rowHtml += '>\
    <td class="quota-td-provider" data-provider="' + escapeAttr(bar.provider) + '">' + chevronHtml + escapeHtml(bar.provider) + '<span class="quota-provider-balance"></span></td>\
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
  // tokens columns (4th and 5th data cells in 0-indexed: index 3 is input, index 4 is output)
  var tds = el.querySelectorAll('td');
  if (tds.length >= 5) {
    tds[3].textContent = formatCompactTokens(bar.inputTokens);
    tds[4].textContent = formatCompactTokens(bar.outputTokens);
  }
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
    return '<tr class="quota-key-row quota-key-row-empty"><td colspan="7" style="text-align:center;color:var(--text-muted)">' + escapeHtml(t('noKeysConfigured')) + '</td></tr>';
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

    var keyQuotaHtml = formatQuotaCell({
      hasQuota: data.hasQuota && k.hasQuota,
      totalCapacity: k.modelLimit,
      successCount: k.successCount,
      errorCount: k.errorCount
    });

    rows += '<tr class="' + rowClass + '" title="' + escapeHtml(t('keyRowHint')) + '" onclick="quotaKeyRowClick(event,\'' + escapeForJsString(provider) + '\',\'' + escapeForJsString(model) + '\',\'' + escapeForJsString(k.keyId) + '\')">\
      <td style="padding-left:22px;white-space:nowrap">' + leadHtml + statusBadge + '</td>\
      <td>' + escapeHtml(k.keyName) + '</td>\
      <td class="quota-td-quota">' + keyQuotaHtml + '</td>\
      <td>' + formatCompactTokens(k.inputTokens) + '</td>\
      <td>' + formatCompactTokens(k.outputTokens) + '</td>\
      <td>' + formatAvgLatency(k) + '</td>\
      <td>' + formatAvgSpeed(k) + '</td>\
    </tr>';
  });
  if (rows === '') {
    return '<tr class="quota-key-row quota-key-row-empty"><td colspan="7" style="text-align:center;color:var(--text-muted)">' + escapeHtml(t('noKeysConfigured')) + '</td></tr>';
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
      // 渠道余额读数搭这趟 1s 节奏的车（内部 60s 节流）：不再为它单开一个
      // 定时器与一套启停逻辑（stopUsageRefresh 已负责清掉本 interval）。
      providerBalanceTick();
    }, 1000);
    providerBalanceTick(); // 首屏立刻拉一次，不等第一拍
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
  // 本趟新建的行是空槽 —— 余额读数已在内存里时当场填上（否则要等下一轮 60s）。
  updateProviderBalanceCells();
  scheduleMonitorTableAutoFit();
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
    el.classList.remove('quota-row-expanded');
    if (chevron) chevron.classList.remove('quota-chevron-expanded');
    var key = provider + '/' + model;
    var subs = el.parentNode.querySelectorAll('.quota-key-row[data-parent="' + key + '"]');
    subs.forEach(function(s) { s.remove(); });
  } else {
    expandedModels.add(setKey);
    el.classList.add('quota-row-expanded');
    if (chevron) chevron.classList.add('quota-chevron-expanded');
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
      ph.innerHTML = '<td colspan="7" style="text-align:center;color:var(--text-muted)">' + escapeHtml(t('loading')) + '...</td>';
      el.parentNode.insertBefore(ph, el.nextSibling);
    }
    fetchModelKeyDetail(provider, model);
  }
}

async function fetchModelKeyDetail(provider, model) {
  try {
    var data = await apiGet('/monitor/model-keys?provider=' + encodeURIComponent(provider) + '&model=' + encodeURIComponent(model));
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
  scheduleMonitorTableAutoFit();
}

// quotaKeyRowClick implements the multi-key sub-row shortcuts. Ctrl+click
// toggles the key's pause/resume state (same effect as the settings provider
// detail pause/resume button, persisted to config.yaml); Shift+click pins the
// key as the provider's manual active key (runtime-only preference, no
// strategy change). Plain clicks are ignored.
async function quotaKeyRowClick(ev, provider, model, keyId) {
  if (!ev || (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey)) return;
  ev.preventDefault();
  var cache = keyDetailCache[provider + '/' + model];
  var data = cache && cache.data;
  if (!data || !data.keys || !data.providerId) return;
  var k = null;
  for (var i = 0; i < data.keys.length; i++) {
    if (data.keys[i].keyId === keyId) { k = data.keys[i]; break; }
  }
  if (!k) return;
  var url = '/providers/' + data.providerId + '/keys/' + keyId;
  try {
    if (ev.ctrlKey || ev.metaKey) {
      var next = !k.isActive;
      // Send name/priority along: the backend applies them unconditionally,
      // so an isActive-only body would wipe both.
      await apiPut(url, { name: k.keyName, priority: k.priority, isActive: next });
      toast(next ? t('keyResumed', [k.keyName]) : t('keyPaused', [k.keyName]), 'success');
    } else {
      await apiPost(url + '/activate', {});
      toast(t('keyActivated', [k.keyName]), 'success');
    }
  } catch(e) {
    toast(t('failed', [e.message || '']), 'error');
    return;
  }
  await fetchModelKeyDetail(provider, model);
  scheduleQuotaRefresh();
}
// latency/speed + expanded sub-rows. It fetches every quota bar so the
// top-level latency/speed cells are populated even before a row is expanded.
// Sub-row rendering remains gated by expandedModels inside fetchModelKeyDetail.
// M-EN-1: runWithConcurrency limits parallel detail fetches to avoid 50-bar burst.
function runWithConcurrency(tasks, cap, fn) { cap = Math.max(1, cap || 6); return new Promise(function(resolve) { var i = 0, active = 0, done = 0; if (!tasks.length) { resolve([]); return; } function next() { while (active < cap && i < tasks.length) { (function(idx) { var t = tasks[idx]; i++; active++; Promise.resolve(fn(t, idx)).then(function() { active--; done++; if (done === tasks.length) resolve(); else next(); }, function() { active--; done++; if (done === tasks.length) resolve(); else next(); }); })(i); } } next(); }); }
function refreshAllKeyDetails() {
  var now = Date.now();
  if (now - _lastPerKeyRefresh < KEY_DETAIL_TTL) return;
  _lastPerKeyRefresh = now;
  // M-EN-1: cap concurrency to 6 to avoid 50-bar burst.
  var pending = [];
  for (var key in quotaBarItems) {
    var el = quotaBarItems[key];
    if (!el || !el._bar) continue;
    var cache = keyDetailCache[key];
    if (cache && now - cache.ts < KEY_DETAIL_TTL) continue;
    (function(provider, model) {
      pending.push(function() { return fetchModelKeyDetail(provider, model); });
    })(el._bar.provider, el._bar.model);
  }
  if (pending.length === 0) { scheduleMonitorTableAutoFit(); return; }
  runWithConcurrency(pending, 6, function(fn) { return fn().catch(function() {}); }).then(function() { scheduleMonitorTableAutoFit(); });
}