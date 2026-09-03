// web/static/download-detail.js
// Right detail panel for TinyLab Download.
// Extracted from download.js (P2-05): detail render, log, progress, actions, gallery handoff.
// Depends on download.js globals: downloadTasksMap, downloadTaskEls, selectedTaskId, selectedTaskIds, DL_STATUS_KEYS, formatBytes etc

var lastDetailLogFetchAt = 0;

// renderTaskDetail renders the right-hand detail panel for the selected task.
function renderTaskDetail() {
  var detail = document.getElementById('dl-task-detail');
  if (!detail) return;
  var task = selectedTaskId ? downloadTasksMap[selectedTaskId] : null;
  detail.innerHTML = taskDetailHtml(task);
  if (!task) return;
  lastDetailLogFetchAt = Date.now();
  fetchLogInto(task.id, 'dl-detail-log', true);
}

// fetchLogInto loads a task's yt-dlp log tail into the given pre element.
function fetchLogInto(taskId, elId, autoscroll) {
  fetch('/api/downloads/' + encodeURIComponent(taskId) + '/log')
    .then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.text();
    })
    .then(function(text) {
      var el = document.getElementById(elId);
      if (!el) return;
      if (!text || !text.trim()) {
        el.textContent = t('logEmpty');
      } else {
        el.textContent = text;
        if (autoscroll) el.scrollTop = el.scrollHeight;
      }
    })
    .catch(function(err) {
      var el = document.getElementById(elId);
      if (el) el.textContent = t('logLoadFailed', [err && err.message ? err.message : String(err)]);
    });
}

// updateSelectedTaskView refreshes the open detail panel for one SSE tick.
// Same live status: patch progress text only (no rebuild, no log refetch).
// Status changed or terminal: full re-render so actions/badge stay correct.
function updateSelectedTaskView(task) {
  var detail = document.getElementById('dl-task-detail');
  if (!detail) return;
  var layoutEl = detail.querySelector('.dl-detail-layout');
  var renderedStatus = layoutEl ? (layoutEl.getAttribute('data-status') || '') : '';
  var status = task.status || 'pending';
  if (status !== renderedStatus || (status !== 'downloading' && status !== 'processing')) {
    renderTaskDetail();
    return;
  }
  var progEl = detail.querySelector('.dl-detail-progress');
  if (progEl) progEl.textContent = taskProgressText(task);
  maybeRefreshDetailLog(task.id);
}

// maybeRefreshDetailLog refetches the log tail at most once every 2s while a
// task is downloading, instead of on every progress event.
function maybeRefreshDetailLog(taskId) {
  var now = Date.now();
  if (now - lastDetailLogFetchAt < 2000) return;
  lastDetailLogFetchAt = now;
  fetchLogInto(taskId, 'dl-detail-log', true);
}

// clampProgress returns the task's progress fraction clamped to 0..1.
function clampProgress(task) {
  var p = (task && task.progress) || {};
  var percent = typeof p.percent === 'number' ? p.percent : 0;
  if (percent < 0) percent = 0;
  if (percent > 1) percent = 1;
  return percent;
}

// taskProgressText renders "NN.N% · speed · ETA" for a live task.
function taskProgressText(task) {
  var p = task.progress || {};
  var parts = [formatProgress(clampProgress(task))];
  if (p.speedBytes) parts.push(formatSpeed(p.speedBytes));
  if (p.etaSeconds) parts.push('ETA ' + formatETA(p.etaSeconds));
  return parts.join(' · ');
}

// isTerminalTaskStatus reports whether a raw TaskStatus will never change.

function taskDetailHtml(task) {
  if (!task) {
    return '<div class="dl-detail-empty">' + escapeHtml(t('noDownloads')) + '</div>';
  }
  var p = task.progress || {};
  var status = task.status || 'pending';
  var pctText = formatProgress(clampProgress(task));

  var statusKey = DL_STATUS_KEYS[status] || 'statusPending';
  var statusLabel = t(statusKey);
  var title = task.title || task.url || task.id;
  var thumb = task.thumbnail ? '<img src="' + escapeHtml(task.thumbnail) + '" alt="" onerror="this.style.display=\'none\'">' : '';
  var tid = escapeAttr(task.id);

  var statusDetail = '';
  if (status === 'pending') {
    statusDetail = t('statusPendingDetail');
  } else if (status === 'cancelled') {
    statusDetail = t('statusCancelledDetail');
  }

  var progressText = '';
  if (status === 'downloading' || status === 'processing') {
    progressText = taskProgressText(task);
  }

  var actions = '';
  if (status === 'pending' || status === 'downloading' || status === 'processing') {
    actions = '<button class="btn btn-ghost" type="button" onclick="cancelDownload(\'' + tid + '\')">' + escapeHtml(t('cancelDownload')) + '</button>';
  } else if (status === 'error' || status === 'cancelled') {
    actions = '<button class="btn btn-ghost" type="button" onclick="retryDownload(\'' + tid + '\')">' + escapeHtml(t('retry')) + '</button>';
    actions += '<button class="btn btn-ghost" type="button" onclick="removeDownload(\'' + tid + '\')">' + escapeHtml(t('removeDownload')) + '</button>';
  } else if (status === 'completed') {
    actions = '<button class="btn btn-ghost" type="button" onclick="openDownloadDir(\'' + tid + '\')">' + escapeHtml(t('openDir')) + '</button>';
    actions += '<button class="btn btn-ghost" type="button" onclick="playVideo(\'' + tid + '\')">' + escapeHtml(t('play')) + '</button>';
    actions += '<button class="btn btn-ghost" type="button" onclick="removeDownload(\'' + tid + '\')">' + escapeHtml(t('removeDownload')) + '</button>';
  }

  var urlRow = '<div class="dl-detail-url" data-tooltip="' + escapeAttr(task.url || '') + '">' + escapeHtml(task.url || '') + '</div>';

  var errorRow = task.error
    ? '<div class="dl-detail-error">' + escapeHtml(task.error) + '</div>'
    : '';

  var progressRow = progressText
    ? '<div class="dl-detail-progress">' + escapeHtml(progressText) + '</div>'
    : (statusDetail ? '<div class="dl-detail-status-detail">' + escapeHtml(statusDetail) + '</div>' : '');

  // Meta rows (Path, Size, Resolution)
  var pathLabel = task.filePath ? escapeHtml(task.filePath) : '-';
  var sizeVal = task.fileSize || p.totalBytes || 0;
  var sizeLabel = sizeVal ? formatBytes(sizeVal) : '-';
  var resLabel = getResolutionLabel(task.quality);

  var metaInfoRows = '' +
    '<div class="dl-detail-meta-line"><strong>' + escapeHtml(t('path')) + ':</strong> ' + pathLabel + '</div>' +
    '<div class="dl-detail-meta-line"><strong>' + escapeHtml(t('size')) + ':</strong> ' + sizeLabel + ' · <strong>' + escapeHtml(t('resolution')) + ':</strong> ' + resLabel + '</div>';

  return '' +
    '<div class="dl-detail-layout" data-task-id="' + tid + '" data-status="' + escapeAttr(status) + '">' +
      '<div class="dl-detail-left">' +
        '<div class="dl-detail-thumb">' + thumb + '</div>' +
        '<div class="dl-detail-title" data-tooltip="' + escapeAttr(title) + '">' + escapeHtml(title) + '</div>' +
        metaInfoRows +
        '<div class="dl-detail-status">' +
          '<span class="dl-status-badge ' + escapeAttr('dl-status-' + status) + '">' + escapeHtml(statusLabel) + '</span>' +
        '</div>' +
        progressRow +
        urlRow +
        errorRow +
        '<div class="dl-detail-actions">' + actions + '</div>' +
      '</div>' +
      '<div class="dl-detail-right">' +
        '<pre class="dl-detail-log" id="dl-detail-log">' + escapeHtml(t('loading')) + '...</pre>' +
      '</div>' +
    '</div>';
}

// cancelDownload cancels an in-progress task.

async function cancelDownload(taskId) {
  var res = await apiPost('/downloads/' + encodeURIComponent(taskId) + '/cancel', {});
  if (res && res.error) {
    toast(t('downloadFailed', [res.error]), 'error');
  }
}

// retryDownload re-queues a failed or cancelled task in place, reusing the
// original task id so the task item stays in its current position.

async function retryDownload(taskId) {
  var res = await apiPost('/downloads/' + encodeURIComponent(taskId) + '/retry', {});
  if (res && res.error) {
    toast(t('downloadFailed', [res.error]), 'error');
    return;
  }
  toast(t('downloadStarted'), 'success');
}

// removeDownload removes a terminal task from the list.

async function removeDownload(taskId) {
  var res = await apiDelete('/downloads/' + encodeURIComponent(taskId));
  if (res && res.error) {
    toast(t('downloadFailed', [res.error]), 'error');
    return;
  }
  if (downloadTaskEls[taskId]) { downloadTaskEls[taskId].remove(); delete downloadTaskEls[taskId]; }
  delete downloadTasksMap[taskId];
  var selIdx = selectedTaskIds.indexOf(taskId);
  if (selIdx >= 0) selectedTaskIds.splice(selIdx, 1);
  if (selectedTaskId === taskId) selectedTaskId = '';
  var listEl = document.getElementById('dl-task-list');
  var detailEl = document.getElementById('dl-task-detail');
  if (listEl && !Object.keys(downloadTaskEls).length) {
    listEl.innerHTML = '';
    if (detailEl) detailEl.innerHTML = emptyState(t('noDownloads'));
    selectedTaskId = '';
    return;
  }
  // Pick a new selection if the removed one was selected.
  if (!selectedTaskId) {
    var firstId = Object.keys(downloadTaskEls)[0];
    selectTask(null, firstId);
  } else {
    renderTaskDetail();
  }
}

// clearCompletedDownloads removes all terminal tasks.

async function openDownloadDir(taskId) {
  var res = await apiPost('/downloads/' + encodeURIComponent(taskId) + '/open', {});
  if (res && res.error) {
    toast(t('downloadFailed', [res.error]), 'error');
  }
}

// formatBytes formats a byte count into a human-readable string.

function playVideo(taskId) {
  // Play the whole multi-selection when the clicked task is part of it;
  // otherwise play just the clicked task. No hidden selection mutation.
  var sourceIds = (taskId && selectedTaskIds.indexOf(taskId) >= 0) ? selectedTaskIds : [taskId];

  var completedTasks = sourceIds.map(function(id) {
    return downloadTasksMap[id];
  }).filter(function(t) {
    return t && t.status === 'completed' && (t.filePath || t.savedFile);
  });

  if (!completedTasks.length) {
    toast(t('noCompletedSelected'), 'warning');
    return;
  }

  var assets = completedTasks.map(function(task) {
    var rawPath = task.filePath || task.savedFile || task.url || '';
    var normalizedPath = rawPath.replace(/\\/g, '/');
    var name = task.title || normalizedPath.split('/').pop() || task.id;
    return {
      name: name,
      mime: mimeFromDownloadName(name),
      kind: 'video',
      format: (name.split('.').pop() || '').toLowerCase(),
      url: '/api/downloads/' + encodeURIComponent(task.id) + '/file',
      size: task.fileSize || 0
    };
  });

  if (typeof window.MediaBridge === 'undefined' ||
      typeof window.MediaBridge.register !== 'function' ||
      typeof window.MediaBridge.openGallery !== 'function') {
    toast(t('mediaBridgeUnavailable'), 'error');
    return;
  }

  var playMsg = t('playingInGallery', [assets.length > 1 ? assets.length : assets[0].name]);

  Promise.all(assets.map(function(a) { return window.MediaBridge.register(a); }))
    .then(function(ids) {
      window.MediaBridge.openGallery(ids);
    })
    .catch(function(err) {
      toast(t('openGalleryFailed'), 'error');
    });
}

// mimeFromDownloadName maps a downloaded file's extension to a MIME type for
// MediaAsset registration (informational — the bridge classifies by kind).

function mimeFromDownloadName(name) {
  var ext = (name.split('.').pop() || '').toLowerCase();
  var map = {
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/x-m4v',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
    oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus'
  };
  return map[ext] || 'application/octet-stream';
}

// getResolutionLabel maps quality preset to display resolution labels.
