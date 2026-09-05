// ===== REST/SSE data plumbing and entry merging =====

// mergeUsageEntries deduplicates API entries by ID (preferring the terminal
// ring entry over a duplicate inflight one), preserves streaming buffers
// from the previous render, merges live inflight entries, retains a bounded
// set of ring-evicted terminal entries, sorts by time desc, and commits the
// result to lastUsageEntries. Shared by renderUsage and refreshQuotaData.
function mergeUsageEntries(apiEntries) {
  var apiIds = {};
  apiEntries.forEach(function(e) { if (e.id) apiIds[e.id] = true; });
  // Index lastUsageEntries by id once (O(n)) instead of .find() per entry.
  var existingById = {};
  for (var i = 0; i < lastUsageEntries.length; i++) {
    var x = lastUsageEntries[i];
    if (x.id) existingById[x.id] = x;
  }
  var seenIds = {};
  var merged = [];
  apiEntries.forEach(function(e) {
    if (e.id && seenIds[e.id]) return;
    var existing = e.id ? existingById[e.id] : null;
    if (existing) {
      if (existing.__streamingReasoning) e.__streamingReasoning = existing.__streamingReasoning;
      if (existing.__streamingAssistant) e.__streamingAssistant = existing.__streamingAssistant;
      if (existing.__streamingUsage) e.__streamingUsage = existing.__streamingUsage;
      // Monotonic guard: REST snapshots of a processing entry may carry
      // older counters than the SSE-driven live values (ttft/tokens arrive
      // via request-ttft/request-tokens between polls). Never regress a
      // processing entry's live fields — GT anchoring and OUT/SPD would
      // otherwise jump backwards on every refresh. Terminal entries bypass
      // merge via handleRequestDone direct replace.
      if (e.status === 'processing' && existing.status === 'processing') {
        if ((existing.ttftMs || 0) > (e.ttftMs || 0)) e.ttftMs = existing.ttftMs;
        if ((existing.inputTokens || 0) > (e.inputTokens || 0)) e.inputTokens = existing.inputTokens;
        if ((existing.outputTokens || 0) > (e.outputTokens || 0)) e.outputTokens = existing.outputTokens;
        // Sentinel-aware: "enc" (-1) beats 0/no-info, loses to any counted
        // plaintext; never regress live RES on REST snapshots.
        var mResE = existing.reasoningTokens, mResN = e.reasoningTokens;
        if (mResN === -1) { if (mResE > 0) e.reasoningTokens = mResE; }
        else if (mResE === -1) { if (!(mResN > 0)) e.reasoningTokens = -1; }
        else if ((mResE || 0) > (mResN || 0)) e.reasoningTokens = mResE;
        if ((existing.contentTokens || 0) > (e.contentTokens || 0)) e.contentTokens = existing.contentTokens;
        if (existing.firstContentMs && !(e.firstContentMs)) e.firstContentMs = existing.firstContentMs;
      }
    }
    if (e.id) seenIds[e.id] = true;
    merged.push(e);
  });
  Object.keys(inflightEntries).forEach(function(id) {
    if (!apiIds[id]) {
      var ts = new Date(inflightEntries[id].timestamp).getTime();
      if (Date.now() - ts > MAX_PROCESSING_MS) {
        delete inflightEntries[id];
      } else {
        merged.unshift(inflightEntries[id]);
      }
    }
  });
  for (var i = 0; i < merged.length; i++) {
    var me = merged[i];
    if (me.id && me.status !== 'processing' && inflightEntries[me.id]) {
      delete inflightEntries[me.id];
    }
  }
  sortEntriesByTimeDesc(merged);
  var _preserved = 0;
  for (var i = 0; i < lastUsageEntries.length; i++) {
    var e = lastUsageEntries[i];
    if (e.id && e.status !== 'processing' && !seenIds[e.id]) {
      merged.push(e);
      seenIds[e.id] = true;
      if (++_preserved >= MAX_PRESERVED_TERMINAL) break;
    }
  }
  sortEntriesByTimeDesc(merged);
  lastUsageEntries = merged;
  return merged;
}

function scheduleQuotaRefresh() {
  if (_quotaRefreshTimer) clearTimeout(_quotaRefreshTimer);
  _quotaRefreshTimer = setTimeout(function() {
    _quotaRefreshTimer = null;
    refreshQuotaData();
  }, 300);
}

var _quotaRefreshInFlight = null;
async function refreshQuotaData() {
  if (_quotaRefreshInFlight) return _quotaRefreshInFlight;
  _quotaRefreshInFlight = (async function() {
    try {
      const [summary, usage, quotas] = await Promise.all([
        apiGet('/monitor/summary'),
        apiGet('/monitor?limit=500'),
        apiGet('/monitor/quotas')
      ]);
      mergeUsageEntries(usage.entries || []);
      updateUsageSummary(summary);
      updateQuotaTable(quotas.quotas || []);
      // Review Bug1/U1: the quotas response now inlines per-key model detail
      // (keyDetail map). Seed the cache so expanded sub-rows render without
      // any N+1 /monitor/model-keys fetches and their 3s TTL staleness.
      if (quotas.keyDetail) {
        var now = Date.now();
        Object.keys(quotas.keyDetail).forEach(function(key) {
          keyDetailCache[key] = { data: quotas.keyDetail[key], ts: now };
          // Inline detail makes refreshAllKeyDetails a no-op (cache fresh), so
          // the top-level latency/speed cells must be patched here directly —
          // they used to be filled by fetchModelKeyDetail (review Bug1/U1).
          var slash = key.indexOf('/');
          if (slash > 0 && typeof patchQuotaRowActiveMetrics === 'function') {
            patchQuotaRowActiveMetrics(key.substring(0, slash), key.substring(slash + 1), quotas.keyDetail[key]);
          }
        });
      }
      updateRecentRequestsInline(lastUsageEntries);
      ensureProcessingTimer();
      refreshAllKeyDetails();
    } catch(e) {
      if (e && e.message && e.message.indexOf('Failed to fetch') >= 0) {
        // Server unreachable (SSE dropped / restarting) — suppress storm.
      } else {
        console.warn('refreshQuotaData failed:', e);
      }
    }
  })().finally(function() { _quotaRefreshInFlight = null; });
  return _quotaRefreshInFlight;
}

function applyUsageSSEHandlers(es) {
  es.onmessage = function(ev) {
    try {
      var data = JSON.parse(ev.data);
      // Review Bug1/U1: a monotonic version lets us detect a dropped SSE frame
      // (an event arriving with a gap) and compensate with an immediate pull.
      // Events are delivered on one connection, so seq gaps mean missed frames.
      if (data.version && typeof lastSseVersion === 'number') {
        if (data.version > lastSseVersion + 1) {
          scheduleQuotaRefresh();
        }
        lastSseVersion = data.version;
      }
      if (data.type === 'usage-updated' || data.type === 'key-inflight') {
        scheduleQuotaRefresh();
        return;
      }
      if (data.type === 'request-start') {
        handleRequestStart(data.entry);
        scheduleQuotaRefresh();
        return;
      }
      if (data.type === 'request-done') {
        handleRequestDone(data.id, data.status, data.entry);
        scheduleQuotaRefresh();
        return;
      }
      if (data.type === 'request-chunk') {
        handleRequestChunk(data.id, data.section, data.delta);
      }
      if (data.type === 'request-ttft') {
        handleRequestTTFT(data.id, data.entry);
      }
      if (data.type === 'request-tokens') {
        handleRequestTokens(data.id, data.entry);
      }
    } catch(e) {}
  };
  // Preserve base handlers set here; monitor.js connectUsageSSE wraps
  // onerror/onopen with reconnect/backoff while keeping status updates.
  // Only set defaults if not already overridden by the wrapper.
  if (!es._trWrapped) {
    es.onerror = function() {
      var status = document.getElementById('console-status');
      if (status) status.textContent = t('disconnected');
    };
    es.onopen = function() {
      var status = document.getElementById('console-status');
      if (status) status.textContent = t('connected');
    };
  }
}

function handleRequestStart(entry) {
  if (!entry) return;
  // 排除 Playground 来源：Playground 请求由其独立列表展示，不进 Recent Requests
  if (entry.source === 'playground') return;
  if (!entry.id) entry.id = 'inflight-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  // 去重：如果 ID 已在 inflight 中，仅更新不做重复插入
  if (inflightEntries[entry.id]) {
    inflightEntries[entry.id] = entry;
    var found2 = lastUsageEntries.findIndex(function(x) { return x.id === entry.id; });
    if (found2 >= 0 && lastUsageEntries[found2].status === 'processing') {
      lastUsageEntries[found2] = entry;
    }
    return;
  }
  inflightEntries[entry.id] = entry;
  var found = lastUsageEntries.findIndex(function(x) { return x.id === entry.id; });
  if (found >= 0) {
    if (lastUsageEntries[found].status === 'processing') {
      lastUsageEntries[found] = entry;
    }
  } else {
    lastUsageEntries.unshift(entry);
  }
  sortEntriesByTimeDesc(lastUsageEntries);
  updateRecentRequestsInline(lastUsageEntries);
  ensureProcessingTimer();
}

function handleRequestDone(id, status, entry) {
  if (!id) return;
  // 排除 Playground 来源（entry 可能为 undefined，需判空）
  if (entry && entry.source === 'playground') return;
  var inflightEntry = inflightEntries[id];
  if (!inflightEntry && !entry) return;
  var completeEntry = entry || inflightEntry;
  if (inflightEntry) {
    completeEntry.__streamingReasoning = inflightEntry.__streamingReasoning || '';
    completeEntry.__streamingAssistant = inflightEntry.__streamingAssistant || '';
    completeEntry.__streamingUsage = inflightEntry.__streamingUsage || '';
    if (!completeEntry.reqPayload && inflightEntry.reqPayload) {
      completeEntry.reqPayload = inflightEntry.reqPayload;
    }
    if (!completeEntry.reqHeaders && inflightEntry.reqHeaders) {
      completeEntry.reqHeaders = inflightEntry.reqHeaders;
    }
    if (!completeEntry.upstreamUrl && inflightEntry.upstreamUrl) {
      completeEntry.upstreamUrl = inflightEntry.upstreamUrl;
    }
  }
  if (completeEntry) {
    if (status) completeEntry.status = status;
  }
  var found = lastUsageEntries.findIndex(function(x) { return x.id === id; });
  if (found >= 0) {
    lastUsageEntries[found] = completeEntry;
  } else {
    lastUsageEntries.unshift(completeEntry);
  }
  sortEntriesByTimeDesc(lastUsageEntries);
  delete inflightEntries[id];
  updateRecentRequestsInline(lastUsageEntries);
  if (!hasProcessingEntries()) stopProcessingTimer();
  if (currentInfoModalRequestId === id) {
    currentInfoModalStreamingDone = true;
    // SSE no longer carries payload; fetch the full entry for the modal.
    apiGet('/monitor/entry/' + encodeURIComponent(id)).then(function(fullEntry) {
      if (currentInfoModalRequestId !== id) return;
      if (fullEntry && infoHasValue(fullEntry.respPayload)) {
        updateStreamingModalResponse(fullEntry);
      } else if (traceEnabled) {
        // trace mode: ring entry has no payload; fetch final response from trace file.
        // Remove streaming sections first so trace content replaces them.
        var bodyEl = document.getElementById('info-modal-body');
        if (bodyEl) {
          var sr = bodyEl.querySelector('#streaming-reasoning-section');
          if (sr) sr.remove();
          var sa = bodyEl.querySelector('#streaming-assistant-section');
          if (sa) sa.remove();
          var su = bodyEl.querySelector('#streaming-usage-section');
          if (su) su.remove();
          var srb = bodyEl.querySelector('#streaming-response-body-section');
          if (srb) srb.remove();
          // Add the same collapsible monitor trace placeholder used by the modal renderer.
          if (!bodyEl.querySelector('#trace-loading-section')) {
            var ph = document.createElement('div');
            ph.innerHTML = monitorRenderTextSection(t('infoTraceDetail'), 'trace-loading-section', 'trace-loading-text', t('infoLoadingTrace'), false, false);
            bodyEl.appendChild(ph.firstElementChild);
          }
        }
        loadTraceDetails(completeEntry);
      }
    }).catch(function() {
      if (traceEnabled && currentInfoModalRequestId === id) {
        var bodyEl = document.getElementById('info-modal-body');
        if (bodyEl) {
          var sr = bodyEl.querySelector('#streaming-reasoning-section');
          if (sr) sr.remove();
          var sa = bodyEl.querySelector('#streaming-assistant-section');
          if (sa) sa.remove();
          var su = bodyEl.querySelector('#streaming-usage-section');
          if (su) su.remove();
          var srb = bodyEl.querySelector('#streaming-response-body-section');
          if (srb) srb.remove();
          if (!bodyEl.querySelector('#trace-loading-section')) {
            var ph = document.createElement('div');
            ph.innerHTML = monitorRenderTextSection(t('infoTraceDetail'), 'trace-loading-section', 'trace-loading-text', t('infoLoadingTrace'), false, false);
            bodyEl.appendChild(ph.firstElementChild);
          }
        }
        loadTraceDetails(completeEntry);
      }
    });
  }
}

function handleRequestChunk(id, section, delta) {
  if (!id || !delta) return;
  var inflight = inflightEntries[id];
  if (inflight) {
    if (section === 'reasoning') {
      inflight.__streamingReasoning = (inflight.__streamingReasoning || '') + delta;
    } else if (section === 'assistant') {
      inflight.__streamingAssistant = (inflight.__streamingAssistant || '') + delta;
    } else if (section === 'usage') {
      inflight.__streamingUsage = (inflight.__streamingUsage || '') + delta;
    }
  }
  if (currentInfoModalRequestId !== id) return;
  if (currentInfoModalStreamingDone) return;
  var targetEl;
  if (section === 'reasoning') {
    targetEl = currentInfoModalReasoningEl;
  } else if (section === 'assistant') {
    targetEl = currentInfoModalAssistantEl;
  } else if (section === 'usage') {
    targetEl = currentInfoModalUsageEl;
  }
  if (!targetEl) return;
  var text = targetEl.textContent || '';
  targetEl.textContent = text + (delta || '');
}

function handleRequestTTFT(id, entry) {
  if (!id || !entry) return;
  var ttftMs = entry.ttftMs || 0;
  if (ttftMs <= 0) return;
  var inflight = inflightEntries[id];
  if (inflight) {
    inflight.ttftMs = ttftMs;
  }
  var found = lastUsageEntries.findIndex(function(x) { return x.id === id; });
  if (found >= 0 && lastUsageEntries[found].status === 'processing') {
    lastUsageEntries[found].ttftMs = ttftMs;
  }
  var row = document.querySelector('tr[data-id="' + sanitizeId(id) + '"]');
  if (row) {
    row.setAttribute('data-ttft', '1');
    var cell = row.querySelector('.ttft-cell');
    if (cell) cell.textContent = formatTTFT(ttftMs);
    // Gen start anchors GT ticking: ts + ttft. Prefer the row's data-ts
    // (authoritative request start) over Date.now() - ttft.
    var tsAttr = row.getAttribute('data-ts');
    var base = tsAttr ? new Date(tsAttr).getTime() : NaN;
    if (isNaN(base)) base = Date.now() - ttftMs;
    row.setAttribute('data-gen-start', String(base + ttftMs));
    // Source tag lets request-tokens upgrade the anchor to the server
    // first-content stamp when it arrives (more accurate than ts+ttft).
    if (row.getAttribute('data-gen-src') !== 'fcm') {
      row.setAttribute('data-gen-src', 'ttft');
    }
    var gtCell = row.querySelector('.gt-cell');
    if (gtCell) gtCell.textContent = formatGenTime(0);
  }
}

function handleRequestTokens(id, entry) {
  if (!id || !entry) return;
  var input = entry.inputTokens;
  var output = entry.outputTokens || 0;
  // Encrypted-reasoning sentinel: -1 carries no countable tokens; a later
  // no-info 0 must not clear an established "enc".
  var resRaw = entry.reasoningTokens;
  var res = (typeof resIsEnc === 'function' && resIsEnc(resRaw)) ? -1 : (resRaw || 0);
  var ct = entry.contentTokens || 0;
  // Backend sends aggregate-only broadcasts (Anthropic usage path) with
  // res/ct unset: keep the row's existing split and only lift the total.
  var fcm = entry.firstContentMs || 0;
  var inflight = inflightEntries[id];
  if (inflight) {
    if (input && input > 0) inflight.inputTokens = input;
    // Monotonic: the locally estimated eff may already exceed a later
    // upstream value in edge cases — never regress the live OUT.
    if (output > (inflight.outputTokens || 0)) inflight.outputTokens = output;
    // Encrypted sentinel sticks over zero; plaintext always overwrites it;
    // a no-info zero never clears "enc".
    if (res === -1) { if ((inflight.reasoningTokens || 0) === 0) inflight.reasoningTokens = -1; }
    else if (res > (inflight.reasoningTokens || 0) && (res !== 0 || inflight.reasoningTokens !== -1)) inflight.reasoningTokens = res;
    if (ct > (inflight.contentTokens || 0)) inflight.contentTokens = ct;
    if (fcm > 0 && !(inflight.firstContentMs)) inflight.firstContentMs = fcm;
  }
  var found = lastUsageEntries.findIndex(function(x) { return x.id === id; });
  if (found >= 0 && lastUsageEntries[found].status === 'processing') {
    if (input && input > 0) lastUsageEntries[found].inputTokens = input;
    if (output > (lastUsageEntries[found].outputTokens || 0)) lastUsageEntries[found].outputTokens = output;
    if (res === -1) { if ((lastUsageEntries[found].reasoningTokens || 0) === 0) lastUsageEntries[found].reasoningTokens = -1; }
    else if (res > (lastUsageEntries[found].reasoningTokens || 0) && (res !== 0 || lastUsageEntries[found].reasoningTokens !== -1)) lastUsageEntries[found].reasoningTokens = res;
    if (ct > (lastUsageEntries[found].contentTokens || 0)) lastUsageEntries[found].contentTokens = ct;
    if (fcm > 0 && !(lastUsageEntries[found].firstContentMs)) lastUsageEntries[found].firstContentMs = fcm;
  }
  var row = document.querySelector('tr[data-id="' + sanitizeId(id) + '"]');
  if (row) {
    // Local per-cell patch: IN / RES / CT columns + immediate speed
    // recompute against current GT (covers the gap between 200ms ticks).
    // OUT is monotonic: the row may already show a higher local estimate
    // than this event carries — take the max so the column never jumps back.
    var prevOut = Number(row.getAttribute('data-out') || '0');
    if (output < prevOut) output = prevOut;
    var displayInput = (input && input > 0) ? input : ((inflight && inflight.inputTokens) || (found >= 0 ? lastUsageEntries[found].inputTokens : 0) || 0);
    var inCell = row.querySelector('.in-cell');
    if (inCell) inCell.textContent = String(displayInput);
    var prevRes = Number(row.getAttribute('data-res') || '0');
    // Sentinel-aware monotonic: -1 ("enc") beats 0 but loses to any
    // counted plaintext; a no-info 0 never clears "enc".
    if (res === -1) { if (prevRes !== 0) res = prevRes; }
    else if (prevRes === -1) { if (res <= 0) res = -1; }
    else if (res < prevRes) res = prevRes;
    var prevCt = Number(row.getAttribute('data-ct') || '0');
    if (ct < prevCt) ct = prevCt;
    // Aggregate-only event (no split): attribute the delta to CT so the
    // total stays consistent without disturbing an established RES.
    var resN0 = (typeof resNum === 'function') ? resNum(res) : (res < 0 ? 0 : res);
    var prevResN0 = (typeof resNum === 'function') ? resNum(prevRes) : (prevRes < 0 ? 0 : prevRes);
    if (resN0 + ct === 0 && output > 0) ct = output - prevResN0 > 0 ? output - prevResN0 : prevCt;
    row.setAttribute('data-out', String(output));
    row.setAttribute('data-res', String(res));
    row.setAttribute('data-ct', String(ct));
    var resCell = row.querySelector('.res-cell');
    if (resCell) resCell.textContent = (typeof resDisplay === 'function') ? resDisplay(res) : (res < 0 ? 'enc' : String(res));
    var ctCell = row.querySelector('.ct-cell');
    if (ctCell) ctCell.textContent = String(ct);
    // GT anchor priority: server first-content stamp > ts+ttft. The stamp
    // is provider-agnostic (local byte observation), so GT no longer jumps
    // when ttft arrives late or not at all.
    if (fcm > 0 && row.getAttribute('data-gen-src') !== 'fcm') {
      row.setAttribute('data-gen-start', String(fcm));
      row.setAttribute('data-gen-src', 'fcm');
    }
    var genStart = row.getAttribute('data-gen-start');
    if (genStart) {
      var gtMs = Date.now() - Number(genStart);
      if (isNaN(gtMs) || gtMs < 0) gtMs = 0;
      var spdCell = row.querySelector('.speed-cell');
      var spdResN = (typeof resNum === 'function') ? resNum(res) : (res < 0 ? 0 : res);
      var spdBase = spdResN + ct > 0 ? spdResN + ct : output;
      if (spdCell) spdCell.textContent = formatGenSpeed(spdBase, gtMs);
    }
  }
}