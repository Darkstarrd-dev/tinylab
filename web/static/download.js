// web/static/download.js
// Video download page for TinyRouter.
// Uses the shared helpers from api.js (apiGet/apiPost/apiDelete) and
// app.js (t/escapeHtml/emptyState/toast/confirmModal).

var downloadEventSource = null;
// Map of task id -> task object, used to reconcile SSE updates and the REST list.
var downloadTasksMap = {};
// Map of task id -> rendered DOM element.
var downloadTaskEls = {};
// Persisted default download directory from the server settings.
var browsePickerOpen = false;

// DL_STATUS_KEYS maps a raw TaskStatus to the i18n key for its label.
var DL_STATUS_KEYS = {
  pending: 'statusPending',
  downloading: 'statusDownloading',
  processing: 'statusProcessing',
  completed: 'statusCompleted',
  error: 'statusError',
  cancelled: 'statusCancelled'
};

// selectedTaskId tracks the task currently shown in the right-hand detail panel.
var selectedTaskId = '';

// In-memory cache to restore parsed playlist and folding state when navigating back.
var cachedParsedPreviewMap = {};
var cachedParsedFoldedMap = {};

// selectedTaskIds tracks all selected task IDs (for batch operations like multi-play)
var selectedTaskIds = [];

// renderDownload renders the download page into the given container.
function renderDownload(container) {
  container.innerHTML = `
    <div class="download-sections">
    <div class="card download-input-card">
      <div class="download-toolbar">
        <select id="dl-type" class="select">
          <option value="video">${escapeHtml(t('video'))}</option>
          <option value="audio">${escapeHtml(t('audio'))}</option>
        </select>
        <select id="dl-quality" class="select">
          <option value="best">${escapeHtml(t('qualityBest'))}</option>
          <option value="good">1080p</option>
          <option value="normal">720p</option>
          <option value="bad">480p</option>
          <option value="worst">360p</option>
        </select>
        <select id="dl-container" class="select">
          <option value="auto">Auto (MP4/MKV)</option>
          <option value="mp4">MP4</option>
          <option value="mkv">MKV</option>
          <option value="webm">WebM</option>
          <option value="original">${escapeHtml(t('original'))}</option>
        </select>
        <input type="text" id="dl-url" class="input" placeholder="${escapeHtml(t('downloadUrlPlaceholder'))}" />
        <button class="btn btn-primary" id="dl-parse-btn" type="button" onclick="parseDownloadUrl()">${escapeHtml(t('parse'))}</button>
        <button class="btn btn-ghost" type="button" onclick="openPathSettingsModal({ sections: { defaultDir: true, ytDlpPath: true, ffmpegPath: true }, useProxy: true })">${escapeHtml(t('settings'))}</button>
        <button class="btn btn-ghost btn-icon" type="button" onclick="clearCompletedDownloads()" data-tooltip="${escapeHtml(t('clearCompleted'))}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M3 6h18"></path>
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
            <path d="m9 14 2 2 4-4"></path>
          </svg>
        </button>
      </div>
    </div>
    <div class="download-queue">
      <div class="dl-task-split">
        <div class="dl-task-left-col">
          <div id="dl-info-preview" class="dl-info-preview" style="display:none;"></div>
          <div id="dl-task-list" class="dl-task-list"></div>
        </div>
        <div id="dl-task-detail" class="dl-task-detail"></div>
      </div>
    </div>
    </div>
  `;

  // Enter key in the URL field triggers parse.
  var urlInput = document.getElementById('dl-url');
  if (urlInput) {
    urlInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); parseDownloadUrl(); }
    });
  }

  selectedTaskId = '';
  loadDownloadTasks();
  connectDownloadSSE();
  loadDownloadSettings();
}

// parseDownloadUrl queries video/playlist info for the entered URL and
// renders a preview. For simplicity it tries both the single-video info
// endpoint and the playlist-info endpoint.
function parseDownloadUrl() {
  var url = (document.getElementById('dl-url') || {}).value;
  if (!url || !url.trim()) {
    toast(t('downloadUrlPlaceholder'), 'warning');
    return;
  }
  url = url.trim();
  var btn = document.getElementById('dl-parse-btn');
  return withLoading(btn, function() { return doParse(url); });
}

async function doParse(url) {
  var singleP = apiPost('/downloads/info', { url: url });
  var playlistP = apiPost('/downloads/playlist-info', { url: url });
  var results = await Promise.allSettled([singleP, playlistP]);
  var single = results[0].status === 'fulfilled' ? results[0].value : null;
  var playlist = results[1].status === 'fulfilled' ? results[1].value : null;

  var cardId = 'parse-card-' + Math.random().toString(36).substr(2, 9);

  // Prefer playlist view when the playlist endpoint returned entries.
  if (playlist && Array.isArray(playlist.entries) && playlist.entries.length > 0) {
    renderPlaylistPreview(cardId, url, playlist);
    return;
  }
  if (single && !single.error && (single.title || single.webpage_url || single.extractor_key)) {
    renderSinglePreview(cardId, url, single);
    return;
  }
  // Some servers return the single info nested under "info".
  if (single && !single.error && single.info) {
    renderSinglePreview(cardId, url, single.info);
    return;
  }
  var msg = (single && single.error) ? single.error : (playlist && playlist.error ? playlist.error : 'unknown');
  toast(t('parseFailed', [msg]), 'error');
}

// renderSinglePreview shows the parsed video info.
function renderSinglePreview(cardId, url, info) {
  var thumb = info.thumbnail || '';
  var title = info.title || url;
  var sub = [];
  if (info.duration) sub.push(formatDuration(info.duration));
  if (info.uploader) sub.push(info.uploader);
  
  var html = `
    <div class="dl-playlist-preview">
      <div class="dl-playlist-header-sticky" style="border-bottom:none; margin-bottom:0;">
        <div class="dl-playlist-header-row">
          <div class="dl-info-thumb-icon-mini">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          </div>
          <div class="dl-playlist-header-text">
            <div class="dl-playlist-title" data-tooltip="${escapeHtml(title)}">${escapeHtml(title)}</div>
            <div class="dl-playlist-subtitle">${escapeHtml(sub.join(' · '))}</div>
          </div>
          <div class="dl-playlist-header-actions">
            <button class="btn-action-icon" type="button" onclick="removeParsedCard('${cardId}')" data-tooltip="Remove List">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        </div>
        <div class="dl-playlist-actions-row">
          <div class="dl-playlist-actions-left"></div>
          <div class="dl-playlist-actions-right">
            <button class="btn btn-primary btn-sm" type="button" onclick="startDownload('${cardId}', '${escapeForJsString(url)}')">${escapeHtml(t('download'))}</button>
          </div>
        </div>
      </div>
    </div>
  `;
  addParsedPreviewCard(cardId, html);
}

// renderPlaylistPreview shows the detected playlist with a selectable list of
// entries, so users can pick which ones to download.
function renderPlaylistPreview(cardId, url, playlist) {
  var title = playlist.title || url;
  var entries = playlist.entries || [];
  var count = entries.length;
  var rows = entries.map(function(entry) {
    var label = entry.title || (playlist.url || url);
    return '' +
      '<div class="dl-playlist-entry">' +
        '<input type="checkbox" name="dl-playlist-select" data-index="' + escapeAttr(entry.index) + '" checked onchange="updatePlaylistSelectionLabel(\'' + cardId + '\')" />' +
        '<div class="dl-playlist-entry-title">' +
          '<span class="dl-playlist-entry-index">' + escapeHtml(entry.index) + '.</span> ' +
          escapeHtml(label) +
        '</div>' +
      '</div>';
  }).join('');

  var html = `
    <div class="dl-playlist-preview">
      <div class="dl-playlist-header-sticky">
        <div class="dl-playlist-header-row">
          <div class="dl-info-thumb-icon-mini">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
          </div>
          <div class="dl-playlist-header-text">
            <div class="dl-playlist-title" data-tooltip="${escapeHtml(title)}">${escapeHtml(title)}</div>
            <div class="dl-playlist-subtitle">${escapeHtml(t('playlistDetected', [count]))}</div>
          </div>
          <div class="dl-playlist-header-actions">
            <button class="btn-action-icon" type="button" onclick="toggleParsedCard('${cardId}')" data-tooltip="Collapse/Expand List">
              <svg class="icon-chevron-up" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
              <svg class="icon-chevron-down" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <button class="btn-action-icon" type="button" onclick="removeParsedCard('${cardId}')" data-tooltip="Remove List">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        </div>
        <div class="dl-playlist-actions-row">
          <div class="dl-playlist-actions-left">
            <button class="btn btn-ghost btn-sm" type="button" onclick="setAllPlaylistSelected('${cardId}', true)">${escapeHtml(t('selectAll'))}</button>
            <button class="btn btn-ghost btn-sm" type="button" onclick="setAllPlaylistSelected('${cardId}', false)">${escapeHtml(t('deselectAll'))}</button>
          </div>
          <div class="dl-playlist-actions-right">
            <span class="dl-playlist-count" id="dl-playlist-count">${escapeHtml(t('nSelected', [count]))}</span>
            <button class="btn btn-primary btn-sm" type="button" onclick="startPlaylistDownload('${cardId}', '${escapeForJsString(url)}')">${escapeHtml(t('download'))}</button>
          </div>
        </div>
      </div>
      <div class="dl-playlist-entries">
        <div class="dl-playlist-entries-heading">${escapeHtml(t('playlistEntries'))}</div>
        ${rows}
      </div>
    </div>
  `;
  addParsedPreviewCard(cardId, html);
}

// getSelectedPlaylistIndices returns the array of selected 1-based playlist indices.
function getSelectedPlaylistIndices(cardId) {
  var cardEl = document.getElementById(cardId);
  if (!cardEl) return [];
  var boxes = cardEl.querySelectorAll('input[name="dl-playlist-select"]:checked');
  var idx = [];
  boxes.forEach(function(b) {
    var n = parseInt(b.getAttribute('data-index'), 10);
    if (!isNaN(n)) idx.push(n);
  });
  return idx;
}

// setAllPlaylistSelected checks or unchecks every playlist entry checkbox.
function setAllPlaylistSelected(cardId, checked) {
  var cardEl = document.getElementById(cardId);
  if (!cardEl) return;
  var boxes = cardEl.querySelectorAll('input[name="dl-playlist-select"]');
  boxes.forEach(function(b) { b.checked = !!checked; });
  updatePlaylistSelectionLabel(cardId);
}

// updatePlaylistSelectionLabel refreshes the "N selected" counter text.
function updatePlaylistSelectionLabel(cardId) {
  var cardEl = document.getElementById(cardId);
  if (!cardEl) return;
  var el = cardEl.querySelector('.dl-playlist-count');
  if (!el) return;
  var n = getSelectedPlaylistIndices(cardId).length;
  el.textContent = t('nSelected', [n]);
}

// showInfoPreview fills the info preview area and reveals it, toggling the task list visibility.
// addParsedPreviewCard adds a new parsed preview card with a unique cardId
function addParsedPreviewCard(cardId, html) {
  var previewEl = document.getElementById('dl-info-preview');
  if (!previewEl) return;

  cachedParsedPreviewMap[cardId] = html;
  cachedParsedFoldedMap[cardId] = false;

  var cardDiv = document.createElement('div');
  cardDiv.id = cardId;
  cardDiv.className = 'dl-parsed-card';
  cardDiv.style.borderBottom = '1px solid var(--glass-border)';
  cardDiv.style.marginBottom = '0';
  cardDiv.innerHTML = html;

  previewEl.appendChild(cardDiv);
  checkPreviewVisibility();
}

// removeParsedCard removes a parsed card by id
function removeParsedCard(cardId) {
  var cardEl = document.getElementById(cardId);
  if (cardEl) {
    cardEl.remove();
  }
  delete cachedParsedPreviewMap[cardId];
  delete cachedParsedFoldedMap[cardId];
  checkPreviewVisibility();
}

// toggleParsedCard collapses or expands a specific card
function toggleParsedCard(cardId) {
  var cardEl = document.getElementById(cardId);
  if (!cardEl) return;
  var entries = cardEl.querySelector('.dl-playlist-entries');
  var heading = cardEl.querySelector('.dl-playlist-entries-heading');
  var iconUp = cardEl.querySelector('.icon-chevron-up');
  var iconDown = document.getElementById('dl-task-list') ? cardEl.querySelector('.icon-chevron-down') : null; // Safe select
  iconDown = cardEl.querySelector('.icon-chevron-down');

  if (entries) {
    var folded = entries.classList.contains('dl-playlist-entries-folded');
    entries.classList.toggle('dl-playlist-entries-folded', !folded);
    if (heading) heading.classList.toggle('dl-playlist-heading-hidden', !folded);
    if (iconUp) iconUp.classList.toggle('dl-chevron-hidden', !folded);
    if (iconDown) iconDown.classList.toggle('dl-chevron-hidden', folded);
    cachedParsedFoldedMap[cardId] = !folded;
  }
  checkPreviewVisibility();
}

// checkPreviewVisibility syncs visibility of the preview container and download task list
function checkPreviewVisibility() {
  var previewEl = document.getElementById('dl-info-preview');
  var listEl = document.getElementById('dl-task-list');
  if (!previewEl) return;

  var cardIds = Object.keys(cachedParsedPreviewMap);
  if (cardIds.length === 0) {
    previewEl.style.display = 'none';
    if (listEl) listEl.style.display = 'flex';
    return;
  }

  previewEl.style.display = 'block';

  var hasExpanded = false;
  cardIds.forEach(function(id) {
    if (!cachedParsedFoldedMap[id]) {
      hasExpanded = true;
    }
  });

  if (hasExpanded) {
    if (listEl) listEl.style.display = 'none';
  } else {
    if (listEl) listEl.style.display = 'flex';
  }
}

// loadDownloadSettings fetches the download settings (yt-dlp / ffmpeg paths)
// and persists the default download directory used by resolveDownloadDir.
async function loadDownloadSettings() {
  var res = await apiGet('/settings');
  var dl = (res && res.download) || {};
  downloadDefaultDir = dl.defaultDir || '';
}

// openExternalUrl requests the server to open an HTTP/HTTPS link in default browser.
function openExternalUrl(url) {
  apiPost('/open-url', { url: url }).catch(function() {
    window.open(url, '_blank');
  });
}

// fasBrowsePicker requests native system file/directory picker from backend and sets full absolute path.
// initialPath is optional; if given, the picker opens at that directory (or its parent, for file targets).
// A global lock prevents multiple simultaneous native dialogs.
async function fasBrowsePicker(inputEl, mode, initialPath) {
  if (!inputEl || browsePickerOpen) return;
  browsePickerOpen = true;
  // Freeze other browse buttons and the overlay backdrop while the native
  // dialog is open, so the user cannot open additional pickers or dismiss
  // the modal by clicking outside.
  var overlay = document.getElementById('dl-settings-overlay');
  var btns = overlay ? overlay.querySelectorAll('.dl-browse-btn') : [];
  btns.forEach(function(b) { b.disabled = true; });
  if (overlay) overlay.style.pointerEvents = 'none';
  try {
    var body = { mode: mode };
    if (initialPath) body.initialPath = initialPath;
    var res = await apiPost('/browse', body);
    if (res && res.path) {
      inputEl.value = res.path;
    }
  } catch (e) {
    console.warn('browse picker failed:', e);
  } finally {
    browsePickerOpen = false;
    btns.forEach(function(b) { b.disabled = false; });
    if (overlay) overlay.style.pointerEvents = '';
  }
}

// openPathSettingsModal shows a modal with path/tool settings.
// opts = { title?: string, sections: { defaultDir?, imageDir?, logDir?, ytDlpPath?, ffmpegPath? }, useProxy?: bool }
async function openPathSettingsModal(opts) {
  opts = opts || {};
  var sections = opts.sections || {};
  if (document.getElementById('dl-settings-overlay')) return;
  try {
  var dl = {}, res = {};
  try {
    res = await apiGet('/settings');
    dl = (res && res.download) || {};
  } catch (e) {
    dl = {};
  }

  var overlay = document.createElement('div');
  overlay.className = 'dl-settings-modal';
  overlay.id = 'dl-settings-overlay';
  function browseRow(labelKey, inputId, value, placeholder, mode, getToolHtml, initialPath) {
    var browseBtn = '<button class="btn btn-ghost btn-sm dl-browse-btn" type="button" data-input="' + inputId + '" data-mode="' + mode + '"' + (initialPath ? ' data-initial="' + escapeAttr(initialPath) + '"' : '') + '>' + escapeHtml(t('browse')) + '</button>';
    var headerHtml = '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:calc(var(--font-base) - 1.5px); font-weight:500; color:var(--text-secondary);">' +
      '<span>' + escapeHtml(t(labelKey)) + '</span>' +
      (getToolHtml || '') +
    '</div>';

    return '<div class="dl-settings-field" style="margin-bottom:12px;">' +
      headerHtml +
      '<div class="dl-settings-row">' +
        '<input type="text" class="input" id="' + inputId + '" value="' + escapeAttr(value) + '" placeholder="' + escapeAttr(placeholder) + '" />' +
        browseBtn +
      '</div>' +
    '</div>';
  }
  var configDir = (res && res.configDir) || '';
  var formRows = '';
  if (sections.ytDlpPath) {
    formRows += browseRow('ytDlpPath', 'modal-dl-ytdlp-path', dl.ytDlpPath || '', 'yt-dlp', 'file', '<button class="btn btn-ghost btn-sm" style="padding:0 6px; height:18px; font-size:10px; line-height:16px; border:1px solid var(--glass-border); text-transform:none; font-weight:normal;" type="button" onclick="openExternalUrl(\'https://github.com/yt-dlp/yt-dlp/releases\')">Get yt-dlp</button>', dl.ytDlpPath || '');
  }
  if (sections.ffmpegPath) {
    formRows += browseRow('ffmpegPath', 'modal-dl-ffmpeg-path', dl.ffmpegPath || '', 'ffmpeg', 'file', '<button class="btn btn-ghost btn-sm" style="padding:0 6px; height:18px; font-size:10px; line-height:16px; border:1px solid var(--glass-border); text-transform:none; font-weight:normal;" type="button" onclick="openExternalUrl(\'https://www.ffmpeg.org/download.html\')">Get ffmpeg</button>', dl.ffmpegPath || '');
  }
  if (sections.defaultDir) {
    formRows += browseRow('defaultDir', 'modal-dl-default-dir', dl.defaultDir || '', 'Downloads', 'directory', null, dl.defaultDir || '');
  }
  if (sections.imageDir) {
    var imgVal = (res && res.imageSaveDir) || '';
    var imgInit = imgVal || (configDir ? configDir + '/imgs' : '');
    var imgPh = configDir ? configDir + '/imgs' : 'imgs';
    formRows += browseRow('imageDir', 'modal-dl-image-dir', imgVal, imgPh, 'directory', null, imgInit);
  }
  if (sections.logDir) {
    var logVal = (res && res.trace && res.trace.logDir) || '';
    var logInit = logVal || (configDir ? configDir + '/traces' : '');
    var logPh = configDir ? configDir + '/traces' : 'traces';
    formRows += browseRow('logDir', 'modal-dl-log-dir', logVal, logPh, 'directory', null, logInit);
  }
  if (opts.useProxy) {
    formRows += '<div class="dl-settings-field" style="margin-bottom:12px;">' +
      '<div class="dl-settings-row" style="justify-content:space-between; align-items:center;">' +
        '<span style="font-size:calc(var(--font-base) - 1.5px); font-weight:500; color:var(--text-secondary);">' + escapeHtml(t('useProxy')) + '</span>' +
        '<label class="toggle-switch" style="margin:0;"><input type="checkbox" id="modal-dl-use-proxy"' + (dl.useProxy ? ' checked' : '') + '><span class="toggle-slider"></span></label>' +
      '</div>' +
      '<div style="margin-top:4px; font-size:calc(var(--font-base) - 2px); color:var(--text-tertiary);">' + escapeHtml(t('useProxyHint')) + '</div>' +
    '</div>';
  }

  overlay.innerHTML = '' +
    '<div class="dl-settings-card">' +
      '<div class="dl-settings-modal-title">' + escapeHtml(opts.title || t('downloadSettings')) + '</div>' +
      '<form class="dl-settings-form" id="dl-settings-form" onsubmit="return false;">' +
        formRows +
      '</form>' +
      '<div class="dl-settings-modal-actions">' +
        '<button class="btn btn-ghost" type="button" id="dl-settings-cancel">' + escapeHtml(t('cancel')) + '</button>' +
        '<button class="btn btn-primary" type="button" id="dl-settings-save">' + escapeHtml(t('save')) + '</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);
  requestAnimationFrame(function() { overlay.classList.add('show'); });

  // Auto-focus the Save button so the user can dismiss immediately with Enter.
  var saveBtn = document.getElementById('dl-settings-save');
  if (saveBtn) {
    saveBtn.focus();
  }

  // Trap keyboard events inside the modal. Capture phase ensures we see
  // the event before any app-level handler (e.g. an app-wide Escape that
  // closes other modals).
  var trapHandler = function(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeModal();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      var focusable = overlay.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !overlay.contains(document.activeElement)) {
          last.focus();
          return;
        }
      } else {
        if (document.activeElement === last || !overlay.contains(document.activeElement)) {
          first.focus();
          return;
        }
      }
    }
  };
  overlay.addEventListener('keydown', trapHandler, true);

  function closeModal() {
    overlay.removeEventListener('keydown', trapHandler, true);
    overlay.classList.remove('show');
    overlay.addEventListener('transitionend', function() { overlay.remove(); }, { once: true });
  }

  function save() {
    var dlPayload = {};
    if (sections.ytDlpPath) dlPayload.ytDlpPath = (document.getElementById('modal-dl-ytdlp-path') || {}).value || '';
    if (sections.ffmpegPath) dlPayload.ffmpegPath = (document.getElementById('modal-dl-ffmpeg-path') || {}).value || '';
    if (sections.defaultDir) dlPayload.defaultDir = (document.getElementById('modal-dl-default-dir') || {}).value || '';
    if (opts.useProxy) dlPayload.useProxy = document.getElementById('modal-dl-use-proxy').checked;

    var payload = {};
    if (Object.keys(dlPayload).length) payload.download = dlPayload;
    if (sections.imageDir) payload.imageSaveDir = (document.getElementById('modal-dl-image-dir') || {}).value || '';
    if (sections.logDir) payload.trace = { logDir: (document.getElementById('modal-dl-log-dir') || {}).value || '' };

    apiPatch('/settings', payload)
      .then(function() {
        if (sections.defaultDir) {
          downloadDefaultDir = (document.getElementById('modal-dl-default-dir') || {}).value || '';
        }
        toast(t('downloadSettingsSaved'), 'success');
        closeModal();
      })
      .catch(function(e) {
        toast(t('downloadSettingsSaveFailed', [e && e.message ? e.message : String(e)]), 'error');
      });
  }

  document.getElementById('dl-settings-cancel').onclick = closeModal;
  document.getElementById('dl-settings-save').onclick = save;

  Array.prototype.forEach.call(overlay.querySelectorAll('.dl-browse-btn'), function(btn) {
    btn.addEventListener('click', function() {
      var target = document.getElementById(btn.getAttribute('data-input'));
      fasBrowsePicker(target, btn.getAttribute('data-mode'), btn.getAttribute('data-initial') || '');
    });
  });
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeModal();
  });
  } catch (err) {
    console.error('[Path] openPathSettingsModal error:', err);
  }
}

// startDownload creates a single download task from the current options.
async function startDownload(cardId, url) {
  if (!url) url = (document.getElementById('dl-url') || {}).value;
  if (!url || !url.trim()) {
    toast(t('downloadUrlPlaceholder'), 'warning');
    return;
  }
  var body = {
    url: url.trim(),
    type: (document.getElementById('dl-type') || {}).value || 'video',
    quality: (document.getElementById('dl-quality') || {}).value || 'best',
    container: (document.getElementById('dl-container') || {}).value || 'auto',
    downloadDir: resolveDownloadDir()
  };
  var res = await apiPost('/downloads', body);
  if (res && res.error) {
    toast(t('downloadFailed', [res.error]), 'error');
    return;
  }
  if (cardId) {
    removeParsedCard(cardId);
  }
  toast(t('downloadStarted'), 'success');
  if (res && res.id) {
    downloadTasksMap[res.id] = res;
    renderDownloadTask(res, true);
  }
}

// startPlaylistDownload creates a playlist batch download.
async function startPlaylistDownload(cardId, url) {
  if (!url) url = (document.getElementById('dl-url') || {}).value;
  if (!url || !url.trim()) {
    toast(t('downloadUrlPlaceholder'), 'warning');
    return;
  }
  var indices = getSelectedPlaylistIndices(cardId);
  if (indices.length === 0) {
    toast(t('noSelection'), 'warning');
    return;
  }
  var body = {
    url: url.trim(),
    type: (document.getElementById('dl-type') || {}).value || 'video',
    quality: (document.getElementById('dl-quality') || {}).value || 'best',
    container: (document.getElementById('dl-container') || {}).value || 'auto',
    downloadDir: resolveDownloadDir(),
    selectedIndices: indices
  };
  var res = await apiPost('/downloads/playlist', body);
  if (res && res.error) {
    toast(t('downloadFailed', [res.error]), 'error');
    return;
  }
  if (cardId) {
    var cardEl = document.getElementById(cardId);
    if (cardEl) {
      var entries = cardEl.querySelector('.dl-playlist-entries');
      if (entries && entries.style.display !== 'none') {
        toggleParsedCard(cardId);
      }
    }
  }
  toast(t('downloadStarted'), 'success');
  // The backend may return a single id, a list of ids, or a status object.
  var ids = res && res.ids ? res.ids : (res && res.id ? [res.id] : []);
  if (ids.length) {
    ids.forEach(function(id) {
      downloadTasksMap[id] = { id: id, status: 'pending', url: url.trim() };
      renderDownloadTask(downloadTasksMap[id], true);
    });
  }
}

// resolveDownloadDir returns the persisted server default download dir.
// The per-task directory is no longer entered on the page; it is managed
// centrally in the Download Settings modal.
function resolveDownloadDir() {
  return downloadDefaultDir || '';
}

// loadDownloadTasks fetches the current task list from the REST API.
async function loadDownloadTasks() {
  var res = await apiGet('/downloads');
  var tasks = Array.isArray(res) ? res : (res && res.tasks ? res.tasks : []);
  var listEl = document.getElementById('dl-task-list');
  var detailEl = document.getElementById('dl-task-detail');
  if (!listEl || !detailEl) return;
  listEl.innerHTML = '';
  detailEl.innerHTML = '';
  downloadTasksMap = {};
  downloadTaskEls = {};

  // Restore cached multi-cards and folding states
  var previewEl = document.getElementById('dl-info-preview');
  if (previewEl) {
    previewEl.innerHTML = '';
    var cardIds = Object.keys(cachedParsedPreviewMap);
    cardIds.forEach(function(cardId) {
      var html = cachedParsedPreviewMap[cardId];
      var cardDiv = document.createElement('div');
      cardDiv.id = cardId;
      cardDiv.className = 'dl-parsed-card';
      cardDiv.style.borderBottom = '1px solid var(--glass-border)';
      cardDiv.style.marginBottom = '0';
      cardDiv.innerHTML = html;
      previewEl.appendChild(cardDiv);

      var isFolded = cachedParsedFoldedMap[cardId];
      var entries = cardDiv.querySelector('.dl-playlist-entries');
      var heading = cardDiv.querySelector('.dl-playlist-entries-heading');
      var iconUp = cardDiv.querySelector('.icon-chevron-up');
      var iconDown = cardDiv.querySelector('.icon-chevron-down');
      if (entries) {
        if (isFolded) {
          entries.style.display = 'none';
          if (heading) heading.style.display = 'none';
          if (iconUp) iconUp.style.display = 'none';
          if (iconDown) iconDown.style.display = 'block';
        } else {
          entries.style.display = 'flex';
          if (heading) heading.style.display = 'block';
          if (iconUp) iconUp.style.display = 'block';
          if (iconDown) iconDown.style.display = 'none';
        }
      }
    });
  }
  checkPreviewVisibility();

  if (!tasks.length) {
    detailEl.innerHTML = emptyState(t('noDownloads'));
    selectedTaskId = '';
    return;
  }
  tasks.forEach(function(task) {
    downloadTasksMap[task.id] = task;
    renderDownloadTask(task, false);
  });
  // Default selection: first task (the one rendered first).
  if (!selectedTaskId && tasks.length) {
    selectTask(null, tasks[0].id);
  } else if (selectedTaskId) {
    renderTaskDetail();
  }
}

// connectDownloadSSE subscribes to the download event stream with auto-reconnect.
function connectDownloadSSE() {
  if (downloadEventSource) { downloadEventSource.close(); downloadEventSource = null; }
  try {
    downloadEventSource = new EventSource('/api/downloads/stream');
  } catch (e) {
    setTimeout(connectDownloadSSE, 3000);
    return;
  }
  downloadEventSource.onmessage = function(event) {
    if (!event || !event.data) return;
    var evt;
    try { evt = JSON.parse(event.data); } catch (e) { return; }
    if (evt && evt.type === 'task-updated' && evt.task) {
      updateDownloadTask(evt.task);
    }
  };
  downloadEventSource.onerror = function() {
    if (downloadEventSource) { downloadEventSource.close(); downloadEventSource = null; }
    setTimeout(connectDownloadSSE, 3000);
  };
}

// renderDownloadTask creates (or replaces) the left-side list item for a task
// and, if the task is the selected one, refreshes the detail panel. When the
// first task appears it also bootstraps the left/right split layout.
function renderDownloadTask(task, _replaceEmpty) {
  var listEl = document.getElementById('dl-task-list');
  if (!listEl || !task || !task.id) return;
  downloadTasksMap[task.id] = task;

  var existing = downloadTaskEls[task.id];
  var itemHtml = taskListItemHtml(task);
  if (existing) {
    existing.outerHTML = itemHtml;
  } else {
    var tmp = document.createElement('div');
    tmp.innerHTML = itemHtml;
    var node = tmp.firstElementChild;
    // Keep list order aligned with insertion order (newest appended).
    listEl.appendChild(node);
  }
  downloadTaskEls[task.id] = document.getElementById('dl-task-item-' + task.id);

  var itemEl = downloadTaskEls[task.id];
  if (itemEl) {
    itemEl.classList.toggle('selected', selectedTaskIds.indexOf(task.id) >= 0);
  }

  // Default selection to the first task ever rendered.
  if (!selectedTaskId) {
    selectTask(null, task.id);
  } else if (task.id === selectedTaskId) {
    renderTaskDetail();
  }
}

// updateDownloadTask reconciles an incoming task update from the SSE stream.
function updateDownloadTask(task) {
  if (!task || !task.id) return;
  downloadTasksMap[task.id] = task;
  var existing = downloadTaskEls[task.id];
  if (!existing) {
    renderDownloadTask(task, true);
    return;
  }
  // Refresh the list item in place.
  existing.outerHTML = taskListItemHtml(task);
  downloadTaskEls[task.id] = document.getElementById('dl-task-item-' + task.id);

  var itemEl = downloadTaskEls[task.id];
  if (itemEl) {
    itemEl.classList.toggle('selected', selectedTaskIds.indexOf(task.id) >= 0);
  }

  // Refresh the detail panel if this is the selected task.
  if (task.id === selectedTaskId) {
    renderTaskDetail();
  }
}

// selectTask updates the selected task id, highlights the left list items and
// refreshes the right-hand detail panel. Supports Ctrl and Shift multi-select.
function selectTask(event, taskId) {
  var listEl = document.getElementById('dl-task-list');
  if (!listEl) return;

  var allItems = Array.prototype.slice.call(listEl.querySelectorAll('.dl-task-item'));
  var allIds = allItems.map(function(el) { return el.getAttribute('data-task-id'); });

  var isCtrl = event && (event.ctrlKey || event.metaKey);
  var isShift = event && event.shiftKey;

  if (isShift && selectedTaskId && selectedTaskIds.length > 0) {
    var startIdx = allIds.indexOf(selectedTaskId);
    var endIdx = allIds.indexOf(taskId);
    if (startIdx >= 0 && endIdx >= 0) {
      var min = Math.min(startIdx, endIdx);
      var max = Math.max(startIdx, endIdx);
      var rangeIds = allIds.slice(min, max + 1);

      rangeIds.forEach(function(id) {
        if (selectedTaskIds.indexOf(id) < 0) {
          selectedTaskIds.push(id);
        }
      });
    }
    selectedTaskId = taskId;
  } else if (isCtrl) {
    var idx = selectedTaskIds.indexOf(taskId);
    if (idx >= 0) {
      if (selectedTaskIds.length > 1) {
        selectedTaskIds.splice(idx, 1);
      }
    } else {
      selectedTaskIds.push(taskId);
    }
    selectedTaskId = taskId;
  } else {
    selectedTaskIds = [taskId];
    selectedTaskId = taskId;
  }

  allItems.forEach(function(el) {
    var tid = el.getAttribute('data-task-id');
    el.classList.toggle('selected', selectedTaskIds.indexOf(tid) >= 0);
  });

  renderTaskDetail();
}

// renderTaskDetail renders the right-hand detail panel for the selected task.
// renderTaskDetail renders the right-hand detail panel for the selected task.
function renderTaskDetail() {
  var detail = document.getElementById('dl-task-detail');
  if (!detail) return;
  var task = selectedTaskId ? downloadTasksMap[selectedTaskId] : null;
  detail.innerHTML = taskDetailHtml(task);
  if (!task) return;

  // Fetch the log content for the pre element.
  fetch('/api/downloads/' + encodeURIComponent(task.id) + '/log')
    .then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.text();
    })
    .then(function(text) {
      var logEl = document.getElementById('dl-detail-log');
      if (!logEl) return;
      if (!text || !text.trim()) {
        logEl.textContent = t('logEmpty');
      } else {
        logEl.textContent = text;
        logEl.scrollTop = logEl.scrollHeight;
      }
    })
    .catch(function(err) {
      var logEl = document.getElementById('dl-detail-log');
      if (logEl) logEl.textContent = 'Failed to load logs: ' + (err && err.message ? err.message : String(err));
    });
}

// taskListItemHtml returns the compact left-side list row for a task.
function taskListItemHtml(task) {
  var p = task.progress || {};
  var percent = typeof p.percent === 'number' ? p.percent : 0;
  if (percent < 0) percent = 0;
  if (percent > 1) percent = 1;
  var pctText = formatProgress(percent);

  var status = task.status || 'pending';
  var title = task.title || task.url || task.id;
  var tid = escapeAttr(task.id);
  var isSelected = task.id === selectedTaskId ? ' selected' : '';

  var pctHtml = '';
  if (status === 'downloading' || status === 'processing' || status === 'pending') {
    pctHtml = '<span class="dl-task-item-pct">' + escapeHtml(pctText) + '</span>';
  }

  return '' +
    '<div class="dl-task-item' + isSelected + '" id="dl-task-item-' + tid + '" data-task-id="' + tid + '" onclick="selectTask(event, \'' + escapeForJsString(task.id) + '\')">' +
      '<span class="dl-status-dot ' + escapeAttr('dl-status-' + status) + '"></span>' +
      '<span class="dl-task-item-title" data-tooltip="' + escapeAttr(title) + '">' + escapeHtml(title) + '</span>' +
      pctHtml +
    '</div>';
}

// taskDetailHtml returns the right-side detail panel HTML for a task.
function taskDetailHtml(task) {
  if (!task) {
    return '<div class="dl-detail-empty">' + escapeHtml(t('noDownloads')) + '</div>';
  }
  var p = task.progress || {};
  var percent = typeof p.percent === 'number' ? p.percent : 0;
  if (percent < 0) percent = 0;
  if (percent > 1) percent = 1;
  var pctText = formatProgress(percent);

  var status = task.status || 'pending';
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
    var parts = [pctText];
    if (p.speedBytes) parts.push(formatSpeed(p.speedBytes));
    if (p.etaSeconds) parts.push('ETA ' + formatETA(p.etaSeconds));
    progressText = parts.join(' · ');
  }

  var actions = '';
  if (status === 'pending' || status === 'downloading' || status === 'processing') {
    actions = '<button class="btn btn-ghost" type="button" onclick="cancelDownload(\'' + tid + '\')">' + escapeHtml(t('cancelDownload')) + '</button>';
  } else if (status === 'error' || status === 'cancelled') {
    actions = '<button class="btn btn-ghost" type="button" onclick="retryDownload(\'' + tid + '\')">' + escapeHtml(t('retry')) + '</button>';
    actions += '<button class="btn btn-ghost" type="button" onclick="removeDownload(\'' + tid + '\')">' + escapeHtml(t('removeDownload')) + '</button>';
  } else if (status === 'completed') {
    actions = '<button class="btn btn-ghost" type="button" onclick="openDownloadDir(\'' + tid + '\')">' + escapeHtml(t('openDir')) + '</button>';
    actions += '<button class="btn btn-ghost" type="button" onclick="playVideo(\'' + tid + '\')">Play</button>';
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
    '<div class="dl-detail-layout" data-task-id="' + tid + '">' +
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
    selectTask(firstId);
  } else {
    renderTaskDetail();
  }
}

// clearCompletedDownloads removes all terminal tasks.
async function clearCompletedDownloads() {
  var res = await apiPost('/downloads/clear-completed', {});
  if (res && res.error) {
    toast(t('downloadFailed', [res.error]), 'error');
    return;
  }
  loadDownloadTasks();
}

// openDownloadDir requests the server to open the downloaded file's folder in the system file manager.
async function openDownloadDir(taskId) {
  var res = await apiPost('/downloads/' + encodeURIComponent(taskId) + '/open', {});
  if (res && res.error) {
    toast(res.error, 'error');
  }
}

// viewLog opens a modal displaying the yt-dlp log output for a task.
function viewLog(taskId) {
  if (document.getElementById('dl-log-overlay')) return;

  var overlay = document.createElement('div');
  overlay.className = 'dl-log-modal';
  overlay.id = 'dl-log-overlay';
  overlay.innerHTML = '' +
    '<div class="dl-log-card">' +
      '<div class="dl-log-modal-title">' +
        escapeHtml(t('viewLog')) +
        '<button class="dl-log-modal-close" id="dl-log-close" type="button">&times;</button>' +
      '</div>' +
      '<pre class="dl-log-content" id="dl-log-content">' + escapeHtml(t('loading')) + '...</pre>' +
    '</div>';

  document.body.appendChild(overlay);
  requestAnimationFrame(function() { overlay.classList.add('show'); });

  var keyHandler = null;
  function closeModal() {
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    overlay.classList.remove('show');
    overlay.addEventListener('transitionend', function() { overlay.remove(); }, { once: true });
  }

  document.getElementById('dl-log-close').onclick = closeModal;
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeModal();
  });
  keyHandler = function(e) {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', keyHandler);

  // Fetch the log content.
  fetch('/api/downloads/' + encodeURIComponent(taskId) + '/log')
    .then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.text();
    })
    .then(function(text) {
      var el = document.getElementById('dl-log-content');
      if (!el) return;
      if (!text || !text.trim()) {
        el.textContent = t('logEmpty');
      } else {
        el.textContent = text;
      }
    })
    .catch(function(err) {
      var el = document.getElementById('dl-log-content');
      if (el) el.textContent = t('downloadFailed', [err && err.message ? err.message : String(err)]);
    });
}

// formatBytes formats a byte count into a human-readable string.
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i < 0) i = 0;
  if (i >= units.length) i = units.length - 1;
  var value = bytes / Math.pow(1024, i);
  return (i === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[i];
}

// formatSpeed formats a bytes/sec rate.
function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  return formatBytes(bytesPerSec) + '/s';
}

// formatETA formats a seconds count as HH:MM:SS or MM:SS.
function formatETA(seconds) {
  if (!seconds || seconds <= 0) return '';
  seconds = Math.round(seconds);
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = seconds % 60;
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  if (h > 0) return pad(h) + ':' + pad(m) + ':' + pad(s);
  return pad(m) + ':' + pad(s);
}

// formatDuration formats a seconds count as a media duration (H:MM:SS / M:SS).
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  seconds = Math.round(seconds);
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = seconds % 60;
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
  return m + ':' + pad(s);
}

// formatProgress formats a 0..1 fraction as a percentage string.
function formatProgress(percent) {
  var pct = (percent || 0) * 100;
  return pct.toFixed(1) + '%';
}

// togglePlaylistEntries expands or collapses the playlist list rows in preview.
function togglePlaylistEntries() {
  var entries = document.querySelector('.dl-playlist-entries');
  var heading = document.querySelector('.dl-playlist-entries-heading');
  var iconUp = document.querySelector('.icon-chevron-up');
  var iconDown = document.querySelector('.icon-chevron-down');
  var taskList = document.getElementById('dl-task-list');
  if (!entries) return;
  if (entries.style.display === 'none') {
    entries.style.display = 'flex';
    isParsedPreviewFolded = false;
    if (heading) heading.style.display = 'block';
    if (iconUp) iconUp.style.display = 'block';
    if (iconDown) iconDown.style.display = 'none';
    if (taskList) taskList.style.display = 'none';
  } else {
    entries.style.display = 'none';
    isParsedPreviewFolded = true;
    if (heading) heading.style.display = 'none';
    if (iconUp) iconUp.style.display = 'none';
    if (iconDown) iconDown.style.display = 'block';
    if (taskList) taskList.style.display = 'flex';
  }
}

// playVideo - triggers single or multi video playback in Gallery module.
function playVideo(taskId) {
  if (taskId && selectedTaskIds.indexOf(taskId) < 0) {
    selectedTaskIds.push(taskId);
  }

  var completedTasks = selectedTaskIds.map(function(id) {
    return downloadTasksMap[id];
  }).filter(function(t) {
    return t && t.status === 'completed' && (t.filePath || t.savedFile);
  });

  if (!completedTasks.length) {
    toast('No completed videos selected', 'warning');
    return;
  }

  var videoObjs = completedTasks.map(function(task) {
    var fileUrl = '/api/downloads/' + encodeURIComponent(task.id) + '/file';
    var rawPath = task.filePath || task.savedFile || task.url || '';
    var normalizedPath = rawPath.replace(/\\/g, '/');
    return {
      name: task.title || (normalizedPath.split(/[\\/]/).pop()) || task.id,
      path: normalizedPath,
      kind: 'plain',
      absPath: normalizedPath,
      mainURL: fileUrl,
      size: task.fileSize || 0
    };
  });

  if (typeof galleryState !== 'undefined') {
    galleryState.mediaType = 'video';
    galleryState.focus = 'video';
    galleryState.videoPlayingState = true;
    galleryState.videoItems = videoObjs;
    galleryState.videoIndex = 0;
    if (typeof updateVideoDirStructure === 'function') updateVideoDirStructure();
    if (typeof renderTreePanel === 'function') renderTreePanel();
    if (typeof updateLayoutMode === 'function') updateLayoutMode();
    if (typeof setVideoActive === 'function') setVideoActive(0);
  }

  // Redirect to Gallery page and play
  var playMsg = videoObjs.length > 1
    ? 'Playing ' + videoObjs.length + ' videos... (Switching to Gallery)'
    : 'Playing ' + videoObjs[0].name + '... (Switching to Gallery)';
  toast(playMsg, 'success');

  var galleryBtn = document.querySelector('button[data-page="gallery"]');
  if (galleryBtn) {
    galleryBtn.click();
  }
}

// getResolutionLabel maps quality preset to display resolution labels.
function getResolutionLabel(quality) {
  var map = {
    best: 'Best',
    good: '1080p',
    normal: '720p',
    bad: '480p',
    worst: '360p'
  };
  return map[quality] || '-';
}
