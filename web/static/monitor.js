// ===== Entry: page lifecycle (called by the SPA router) =====

async function renderUsage(c) {
  try {
  var cachedEntries = lastUsageEntries.slice();
  var quotaCardHtml = '<div class="card"><div class="card-title" style="display:flex;justify-content:space-between;align-items:center"><span>' + t('quotaMonitor') + '</span><button type="button" class="btn btn-sm btn-ghost" onclick="resetQuotaTimers()">' + t('resetQuota') + '</button></div><div class="quota-section quota-section-scroll"><table class="usage-table quota-table"><thead><tr><th class="quota-th-chevron"></th><th>' + t('thProvider') + '</th><th>' + t('thModel') + '</th><th>' + t('thQuota') + '</th><th>' + t('thInput') + '</th><th>' + t('thOutput') + '</th><th>' + t('thLatency') + '</th><th>' + t('thAvgSpeed') + '</th></tr></thead><tbody id="quota-tbody"></tbody></table></div></div>';
  c.innerHTML = '\
    <div class="usage-header usage-fullscreen">\
      <div class="usage-body-grid">\
        <div class="usage-left-col">\
          <div class="quota-monitor-card">' + quotaCardHtml + '\
          </div>\
          <div class="recent-requests-section">' + renderRecentRequestsInline(cachedEntries) + '</div>\
        </div>\
        <div class="usage-right-col" id="usage-console-col"></div>\
      </div>\
    </div>';
  c.classList.remove('usage-page');
  var mainEl = document.querySelector('.main');
  if (mainEl) mainEl.classList.add('main-no-scroll');
  var results = await Promise.allSettled([
    apiGet('/monitor/summary'),
    apiGet('/monitor?limit=500'),
    apiGet('/monitor/quotas'),
    apiGet('/settings'),
    apiGet('/providers')
  ]);
  if (currentPage !== 'monitor') return;
  var summary = results[0].status === 'fulfilled' ? results[0].value : {};
  var usage = results[1].status === 'fulfilled' ? results[1].value : {};
  var quotas = results[2].status === 'fulfilled' ? results[2].value : {};
  var settings = results[3].status === 'fulfilled' ? results[3].value : {};
  if (results[4].status === 'fulfilled' && results[4].value && results[4].value.providers) {
    providersCache = results[4].value.providers;
    buildModelIdToAlias();
  }
  var rejected = results.slice(0, 4).some(function(r) { return r.status === 'rejected'; });
  if (rejected) toast(t('loadFailed') || 'Load failed', 'error');
  usageDebugMode = !!(settings && settings.debugMode);
  traceEnabled = !!(settings && settings.trace && settings.trace.enabled);
  mergeUsageEntries(usage.entries || []);
  var quotaBars = quotas.quotas || [];
  quotaBarItems = {};
  var tbody = document.getElementById('quota-tbody');
  if (tbody) {
    updateQuotaTable(quotaBars);
    refreshAllKeyDetails();
  }
  updateUsageSummary(summary);
  updateRecentRequestsInline(lastUsageEntries);
  scheduleMonitorTableAutoFit();
  var consoleCol = document.getElementById('usage-console-col');
  if (consoleCol && typeof buildConsoleInto === 'function') {
    buildConsoleInto(consoleCol);
  }
  startUsageRefresh();
  ensureProcessingTimer();
  } catch(e) {
    c.innerHTML = emptyState(t('loadFailed') || 'Load failed');
    console.warn('renderUsage failed:', e);
  }
}

function updateProcessingLatencyCells() {
  var rows = document.querySelectorAll('tr[data-status="processing"]');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute('data-ttft')) continue;
    var ts = rows[i].getAttribute('data-ts');
    if (!ts) continue;
    var elapsed = Date.now() - new Date(ts).getTime();
    if (isNaN(elapsed) || elapsed < 0) elapsed = 0;
    var cell = rows[i].querySelector('.latency-cell');
    if (!cell) continue;
    if (elapsed > MAX_PROCESSING_MS) {
      cell.textContent = '>10m';
    } else {
      cell.textContent = formatLatency(elapsed);
    }
  }
}

function ensureProcessingTimer() {
  if (processingTimer) return;
  processingTimer = setInterval(function() {
    if (currentPage === 'monitor' && hasProcessingEntries()) {
      updateProcessingLatencyCells();
    } else {
      clearInterval(processingTimer);
      processingTimer = null;
    }
  }, 200);
}

function stopProcessingTimer() {
  if (processingTimer) {
    clearInterval(processingTimer);
    processingTimer = null;
  }
}

function startUsageRefresh() {
  stopUsageRefresh();
  usageEventSource = new EventSource('/api/monitor/events');
  applyUsageSSEHandlers(usageEventSource);

  usageVisibilityHandler = function() {
    if (document.visibilityState === 'visible' && currentPage === 'monitor') {
      if (!usageEventSource || usageEventSource.readyState === EventSource.CLOSED) {
        if (usageEventSource) usageEventSource.close();
        usageEventSource = new EventSource('/api/monitor/events');
        applyUsageSSEHandlers(usageEventSource);
      }
      refreshQuotaData();
    }
  };
  document.addEventListener('visibilitychange', usageVisibilityHandler);

  usagePeriodicTimer = setInterval(function() {
    if (currentPage === 'monitor') {
      refreshQuotaData();
    }
  }, 5000);
}

function stopUsageRefresh() {
  if (usageVisibilityHandler) {
    document.removeEventListener('visibilitychange', usageVisibilityHandler);
    usageVisibilityHandler = null;
  }
  if (usageEventSource) {
    usageEventSource.close();
    usageEventSource = null;
  }
  if (usagePeriodicTimer) {
    clearInterval(usagePeriodicTimer);
    usagePeriodicTimer = null;
  }
  if (lockCountdownInterval) {
    clearInterval(lockCountdownInterval);
    lockCountdownInterval = null;
  }
  lockCountdownTimerStarted = false;
  stopProcessingTimer();
}

async function clearUsage() {
  await apiDelete('/monitor');
  toast(t('usageCleared'), 'info');
  renderUsage(document.getElementById('page-content'));
}

async function resetQuotaTimers() {
	var ok = await confirmModal(t('confirmResetQuota'));
	if (!ok) return;
	try {
		var resp = await apiPost('/monitor/reset-quota', {});
		if (resp && resp.ok) {
			toast(t('quotaReset'), 'success');
			refreshQuotaMonitor();
		} else {
			toast(t('failed', [resp.error || '']), 'error');
		}
	} catch(e) {
		toast(t('failed', [e.message]), 'error');
	}
}

function refreshQuotaMonitor() {
	var c = document.getElementById('page-content');
	if (c) renderUsage(c);
}