// web/static/download.js
// Video download page for TinyLab.
// Uses the shared helpers from api.js (apiGet/apiPost/apiDelete) and
// app.js (t/escapeHtml/emptyState/toast/confirmModal).

var downloadEventSource = null;
var downloadReconnectTimer = null;
var downloadActivePredicate = null;
// Map of task id -> task object, used to reconcile SSE updates and the REST list.
var downloadTasksMap = {};
// Map of task id -> rendered DOM element.
var downloadTaskEls = {};
// Persisted default download directory from the server settings.
var downloadDefaultDir = '';
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
var cachedParsedOptionsMap = {};

// selectedTaskIds tracks all selected task IDs (for batch operations like multi-play)
var selectedTaskIds = [];

// renderDownload renders the download page into the given container.
function renderDownload(container) {
  container.innerHTML = `
    <div class="download-sections">
    <div class="card download-input-card">
      <div class="download-toolbar">
        <div class="custom-select-wrapper" id="dl-type-wrap">
          <div class="custom-select-trigger" onclick="toggleCustomSelect('dl-type-wrap', event)">
            <span class="custom-select-label">${escapeHtml(t('video'))}</span>
            <svg viewBox="0 0 360 360" xml:space="preserve" aria-hidden="true" focusable="false">
              <path d="M325.607,79.393c-5.857-5.857-15.355-5.858-21.213,0.001l-139.39,139.393L25.607,79.393 c-5.857-5.857-15.355-5.858-21.213,0.001c-5.858,5.858-5.858,15.355,0,21.213l150.004,150c2.813,2.813,6.628,4.393,10.606,4.393 s7.794-1.581,10.606-4.394l149.996-150C331.465,94.749,331.465,85.251,325.607,79.393z"></path>
            </svg>
          </div>
          <div class="custom-select-menu">
            <div class="custom-select-option selected" data-value="video" onclick="selectCustomOption('dl-type-wrap', 'video', '${escapeHtml(t('video'))}')">
              <span class="custom-select-option-link">${escapeHtml(t('video'))}</span>
            </div>
            <div class="custom-select-option" data-value="audio" onclick="selectCustomOption('dl-type-wrap', 'audio', '${escapeHtml(t('audio'))}')">
              <span class="custom-select-option-link">${escapeHtml(t('audio'))}</span>
            </div>
          </div>
          <select id="dl-type" class="select" style="display:none;">
            <option value="video" selected>${escapeHtml(t('video'))}</option>
            <option value="audio">${escapeHtml(t('audio'))}</option>
          </select>
        </div>

        <div class="custom-select-wrapper" id="dl-quality-wrap">
          <div class="custom-select-trigger" onclick="toggleCustomSelect('dl-quality-wrap', event)">
            <span class="custom-select-label">${escapeHtml(t('qualityBest'))}</span>
            <svg viewBox="0 0 360 360" xml:space="preserve" aria-hidden="true" focusable="false">
              <path d="M325.607,79.393c-5.857-5.857-15.355-5.858-21.213,0.001l-139.39,139.393L25.607,79.393 c-5.857-5.857-15.355-5.858-21.213,0.001c-5.858,5.858-5.858,15.355,0,21.213l150.004,150c2.813,2.813,6.628,4.393,10.606,4.393 s7.794-1.581,10.606-4.394l149.996-150C331.465,94.749,331.465,85.251,325.607,79.393z"></path>
            </svg>
          </div>
          <div class="custom-select-menu">
            <div class="custom-select-option selected" data-value="best" onclick="selectCustomOption('dl-quality-wrap', 'best', '${escapeHtml(t('qualityBest'))}')">
              <span class="custom-select-option-link">${escapeHtml(t('qualityBest'))}</span>
            </div>
            <div class="custom-select-option" data-value="good" onclick="selectCustomOption('dl-quality-wrap', 'good', '1080p')">
              <span class="custom-select-option-link">1080p</span>
            </div>
            <div class="custom-select-option" data-value="normal" onclick="selectCustomOption('dl-quality-wrap', 'normal', '720p')">
              <span class="custom-select-option-link">720p</span>
            </div>
            <div class="custom-select-option" data-value="bad" onclick="selectCustomOption('dl-quality-wrap', 'bad', '480p')">
              <span class="custom-select-option-link">480p</span>
            </div>
            <div class="custom-select-option" data-value="worst" onclick="selectCustomOption('dl-quality-wrap', 'worst', '360p')">
              <span class="custom-select-option-link">360p</span>
            </div>
          </div>
          <select id="dl-quality" class="select" style="display:none;">
            <option value="best" selected>${escapeHtml(t('qualityBest'))}</option>
            <option value="good">1080p</option>
            <option value="normal">720p</option>
            <option value="bad">480p</option>
            <option value="worst">360p</option>
          </select>
        </div>

        <div class="custom-select-wrapper" id="dl-container-wrap">
          <div class="custom-select-trigger" onclick="toggleCustomSelect('dl-container-wrap', event)">
            <span class="custom-select-label">Auto (MP4/MKV)</span>
            <svg viewBox="0 0 360 360" xml:space="preserve" aria-hidden="true" focusable="false">
              <path d="M325.607,79.393c-5.857-5.857-15.355-5.858-21.213,0.001l-139.39,139.393L25.607,79.393 c-5.857-5.857-15.355-5.858-21.213,0.001c-5.858,5.858-5.858,15.355,0,21.213l150.004,150c2.813,2.813,6.628,4.393,10.606,4.393 s7.794-1.581,10.606-4.394l149.996-150C331.465,94.749,331.465,85.251,325.607,79.393z"></path>
            </svg>
          </div>
          <div class="custom-select-menu">
            <div class="custom-select-option selected" data-value="auto" onclick="selectCustomOption('dl-container-wrap', 'auto', 'Auto (MP4/MKV)')">
              <span class="custom-select-option-link">Auto (MP4/MKV)</span>
            </div>
            <div class="custom-select-option" data-value="mp4" onclick="selectCustomOption('dl-container-wrap', 'mp4', 'MP4')">
              <span class="custom-select-option-link">MP4</span>
            </div>
            <div class="custom-select-option" data-value="mkv" onclick="selectCustomOption('dl-container-wrap', 'mkv', 'MKV')">
              <span class="custom-select-option-link">MKV</span>
            </div>
            <div class="custom-select-option" data-value="webm" onclick="selectCustomOption('dl-container-wrap', 'webm', 'WebM')">
              <span class="custom-select-option-link">WebM</span>
            </div>
            <div class="custom-select-option" data-value="original" onclick="selectCustomOption('dl-container-wrap', 'original', '${escapeHtml(t('original'))}')">
              <span class="custom-select-option-link">${escapeHtml(t('original'))}</span>
            </div>
          </div>
          <select id="dl-container" class="select" style="display:none;">
            <option value="auto" selected>Auto (MP4/MKV)</option>
            <option value="mp4">MP4</option>
            <option value="mkv">MKV</option>
            <option value="webm">WebM</option>
            <option value="original">${escapeHtml(t('original'))}</option>
          </select>
        </div>
        <input type="text" id="dl-url" class="input" placeholder="${escapeHtml(t('downloadUrlPlaceholder'))}" />
        <button class="btn btn-primary" id="dl-parse-btn" type="button" onclick="parseDownloadUrl()">${escapeHtml(t('parse'))}</button>
        <button class="btn btn-primary" id="dl-settings-btn" type="button" onclick="openPathSettingsModal({ sections: { defaultDir: true, ytDlpPath: true, ffmpegPath: true }, useProxy: true })">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 20 20" fill="none" class="dl-settings-svg-icon" aria-hidden="true" focusable="false">
            <g stroke-width="1.5" stroke-linecap="round" stroke="currentColor">
              <circle r="2.5" cy="10" cx="10"></circle>
              <path fill-rule="evenodd" d="m8.39079 2.80235c.53842-1.51424 2.67991-1.51424 3.21831-.00001.3392.95358 1.4284 1.40477 2.3425.97027 1.4514-.68995 2.9657.82427 2.2758 2.27575-.4345.91407.0166 2.00334.9702 2.34248 1.5143.53842 1.5143 2.67996 0 3.21836-.9536.3391-1.4047 1.4284-.9702 2.3425.6899 1.4514-.8244 2.9656-2.2758 2.2757-.9141-.4345-2.0033.0167-2.3425.9703-.5384 1.5142-2.67989 1.5142-3.21831 0-.33914-.9536-1.4284-1.4048-2.34247-.9703-1.45148.6899-2.96571-.8243-2.27575-2.2757.43449-.9141-.01669-2.0034-.97028-2.3425-1.51422-.5384-1.51422-2.67994.00001-3.21836.95358-.33914 1.40476-1.42841.97027-2.34248-.68996-1.45148.82427-2.9657 2.27575-2.27575.91407.4345 2.00333-.01669 2.34247-.97026z" clip-rule="evenodd"></path>
            </g>
          </svg>
          <span>${escapeHtml(t('settings'))}</span>
        </button>
        <button class="btn btn-ghost btn-icon bin-button" type="button" onclick="clearCompletedDownloads()" data-tooltip="${escapeHtml(t('clearCompleted'))}" aria-label="${escapeHtml(t('clearCompleted'))}">
          <svg class="bin-top" viewBox="0 0 39 7" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
            <line y1="5" x2="39" y2="5" stroke="currentColor" stroke-width="4"></line>
            <line x1="12" y1="1.5" x2="26.0357" y2="1.5" stroke="currentColor" stroke-width="3"></line>
          </svg>
          <svg class="bin-bottom" viewBox="0 0 33 39" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
            <mask id="dl-bin-mask" fill="white">
              <path d="M0 0H33V35C33 37.2091 31.2091 39 29 39H4C1.79086 39 0 37.2091 0 35V0Z"></path>
            </mask>
            <path d="M0 0H33H0ZM37 35C37 39.4183 33.4183 43 29 43H4C-0.418278 43 -4 39.4183 -4 35H4H29H37ZM4 43C-0.418278 43 -4 39.4183 -4 35V0H4V35V43ZM37 0V35C37 39.4183 33.4183 43 29 43V35V0H37Z" fill="currentColor" mask="url(#dl-bin-mask)"></path>
            <path d="M12 6L12 29" stroke="currentColor" stroke-width="4"></path>
            <path d="M21 6V29" stroke="currentColor" stroke-width="4"></path>
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
  // Audio/video types offer different container sets; keep the hidden
  // native select and the animated menu in sync on type change.
  var typeSelect = document.getElementById('dl-type');
  if (typeSelect) {
    typeSelect.addEventListener('change', function() {
      applyContainerOptions(typeSelect.value);
    });
  }


  selectedTaskId = '';
  selectedTaskIds = [];
  loadDownloadTasks();
  resumeDownload();
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
  // Snapshot the toolbar options now so the card keeps them even if the
  // user changes the dropdowns before clicking Download.
  var toolbar = readToolbarOptions();

  // Prefer playlist view when the playlist endpoint returned entries.
  if (playlist && Array.isArray(playlist.entries) && playlist.entries.length > 0) {
    renderPlaylistPreview(cardId, url, playlist, toolbar);
    return;
  }
  if (single && !single.error && (single.title || single.webpage_url || single.extractor_key)) {
    renderSinglePreview(cardId, url, single, toolbar);
    return;
  }
  // Some servers return the single info nested under "info".
  if (single && !single.error && single.info) {
    renderSinglePreview(cardId, url, single.info, toolbar);
    return;
  }
  var msg = (single && single.error) ? single.error : (playlist && playlist.error ? playlist.error : 'unknown');
  toast(t('parseFailed', [msg]), 'error');
}

// renderSinglePreview shows the parsed video info. opts is the toolbar
// snapshot taken at parse time; the card keeps it until Download is clicked.
function renderSinglePreview(cardId, url, info, opts) {
  opts = opts || readToolbarOptions();
  cachedParsedOptionsMap[cardId] = opts;
  var title = info.title || url;
  var sub = [];
  if (info.duration) sub.push(formatDuration(info.duration));
  if (info.uploader) sub.push(info.uploader);
  var optsLabel = parsedOptionsLabel(opts);
  if (optsLabel) sub.push(optsLabel);

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
            <button class="btn-action-icon" type="button" onclick="removeParsedCard('${cardId}')" data-tooltip="${escapeHtml(t('removeList'))}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        </div>
        <div class="dl-playlist-actions-row">
          <div class="dl-playlist-actions-left"></div>
          <div class="dl-playlist-actions-right">
            <button class="btn btn-primary btn-sm" type="button" onclick="withLoading(this, function(){ startDownload('${cardId}', '${escapeForJsString(url)}'); })">${escapeHtml(t('download'))}</button>
          </div>
        </div>
      </div>
    </div>
  `;
  addParsedPreviewCard(cardId, html);
}

// renderPlaylistPreview shows the detected playlist with a selectable list of
// entries, so users can pick which ones to download.
function renderPlaylistPreview(cardId, url, playlist, opts) {
  var title = playlist.title || url;
  var entries = playlist.entries || [];
  var count = entries.length;
  opts = opts || readToolbarOptions();
  cachedParsedOptionsMap[cardId] = opts;
  var optsLabel = parsedOptionsLabel(opts);
  var subtitle = t('playlistDetected', [count]) + (optsLabel ? ' · ' + optsLabel : '');
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
            <div class="dl-playlist-subtitle">${escapeHtml(subtitle)}</div>
          </div>
          <div class="dl-playlist-header-actions">
            <button class="btn-action-icon" type="button" onclick="toggleParsedCard('${cardId}')" data-tooltip="${escapeHtml(t('collapseExpandList'))}">
              <svg class="icon-chevron-up" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
              <svg class="icon-chevron-down" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <button class="btn-action-icon" type="button" onclick="removeParsedCard('${cardId}')" data-tooltip="${escapeHtml(t('removeList'))}">
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
            <span class="dl-playlist-count">${escapeHtml(t('nSelected', [count]))}</span>
            <button class="btn btn-primary btn-sm" type="button" onclick="withLoading(this, function(){ startPlaylistDownload('${cardId}', '${escapeForJsString(url)}'); })">${escapeHtml(t('download'))}</button>
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
  delete cachedParsedOptionsMap[cardId];
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

async function startDownload(cardId, url) {
  if (!url) url = (document.getElementById('dl-url') || {}).value;
  if (!url || !url.trim()) {
    toast(t('downloadUrlPlaceholder'), 'warning');
    return;
  }
  url = url.trim();
  // Prefer the options snapshotted on the parsed card over the live dropdowns.
  var opts = (cardId && cachedParsedOptionsMap[cardId]) || readToolbarOptions();
  // Reject a duplicate submit of the same URL while a task for it is live.
  var duplicate = Object.keys(downloadTasksMap).some(function(id) {
    var task = downloadTasksMap[id];
    return task && task.url === url && !isTerminalTaskStatus(task.status);
  });
  if (duplicate) {
    toast(t('downloadAlreadyQueued'), 'warning');
    return;
  }
  var body = {
    url: url,
    type: opts.type,
    quality: opts.quality,
    container: opts.container,
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
  var urlInput = document.getElementById('dl-url');
  if (urlInput) urlInput.value = '';
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
  url = url.trim();
  var indices = getSelectedPlaylistIndices(cardId);
  if (indices.length === 0) {
    toast(t('noSelection'), 'warning');
    return;
  }
  // Prefer the options snapshotted on the parsed card over the live dropdowns.
  var opts = (cardId && cachedParsedOptionsMap[cardId]) || readToolbarOptions();
  var body = {
    url: url,
    type: opts.type,
    quality: opts.quality,
    container: opts.container,
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
  var urlInput = document.getElementById('dl-url');
  if (urlInput) urlInput.value = '';
  toast(t('downloadStarted'), 'success');
  // The backend may return a single id, a list of ids, or a status object.
  var ids = res && res.ids ? res.ids : (res && res.id ? [res.id] : []);
  if (ids.length) {
    ids.forEach(function(id) {
      downloadTasksMap[id] = { id: id, status: 'pending', url: url };
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

function isTerminalTaskStatus(status) {
  return status === 'completed' || status === 'error' || status === 'cancelled';
}

// readToolbarOptions snapshots the current type/quality/container dropdowns.
function readToolbarOptions() {
  return {
    type: (document.getElementById('dl-type') || {}).value || 'video',
    quality: (document.getElementById('dl-quality') || {}).value || 'best',
    container: (document.getElementById('dl-container') || {}).value || 'auto'
  };
}

// parsedOptionsLabel renders a short "quality · container" summary for cards.
function parsedOptionsLabel(opts) {
  if (!opts) return '';
  var quality = getResolutionLabel(opts.quality);
  if (quality === '-') quality = opts.quality;
  var container;
  if (opts.container === 'auto') {
    container = 'Auto';
  } else if (opts.container === 'original') {
    container = t('original');
  } else {
    container = String(opts.container).toUpperCase();
  }
  return quality + ' · ' + container;
}

// DL_CONTAINER_OPTIONS lists container choices per download type. Audio uses
// yt-dlp --audio-format values; video uses merge/remux containers.
var DL_CONTAINER_OPTIONS = {
  video: [
    ['auto', 'Auto (MP4/MKV)'],
    ['mp4', 'MP4'],
    ['mkv', 'MKV'],
    ['webm', 'WebM'],
    ['original', null] // label filled at call time via t('original')
  ],
  audio: [
    ['auto', 'Auto'],
    ['mp3', 'MP3'],
    ['m4a', 'M4A'],
    ['flac', 'FLAC'],
    ['wav', 'WAV'],
    ['opus', 'Opus']
  ]
};

// applyContainerOptions rebuilds the animated custom-select menu and the
// hidden native select when the download type changes. Keeps the current
// value when still valid; otherwise resets to auto.
function applyContainerOptions(type) {
  var wrapper = document.getElementById('dl-container-wrap');
  var selectEl = document.getElementById('dl-container');
  if (!wrapper || !selectEl) return;
  var defs = DL_CONTAINER_OPTIONS[type === 'audio' ? 'audio' : 'video'];
  var current = selectEl.value;
  var nextValue = 'auto';
  defs.forEach(function(def) { if (def[0] === current) nextValue = current; });
  function labelOf(def) { return def[1] === null ? t('original') : def[1]; }
  var menuHtml = '';
  var optionHtml = '';
  defs.forEach(function(def) {
    var selected = def[0] === nextValue ? ' selected' : '';
    menuHtml += '<div class="custom-select-option' + selected + '" data-value="' + escapeAttr(def[0]) + '" onclick="selectCustomOption(\'dl-container-wrap\', \'' + def[0] + '\', \'' + escapeForJsString(labelOf(def)) + '\')">' +
      '<span class="custom-select-option-link">' + escapeHtml(labelOf(def)) + '</span>' +
      '</div>';
    optionHtml += '<option value="' + escapeAttr(def[0]) + '"' + selected + '>' + escapeHtml(labelOf(def)) + '</option>';
  });
  var menu = wrapper.querySelector('.custom-select-menu');
  if (menu) menu.innerHTML = menuHtml;
  selectEl.innerHTML = optionHtml;
  selectEl.value = nextValue;
  var labelEl = wrapper.querySelector('.custom-select-label');
  var match = defs.filter(function(d) { return d[0] === nextValue; })[0];
  if (labelEl && match) labelEl.textContent = labelOf(match);
}

// taskListItemHtml returns the compact left-side list row for a task.
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

// playVideo - hands completed download outputs to the Gallery through the
// MediaBridge. No direct galleryState writes and no absolute paths: each
// output is registered as a MediaAsset whose bytes are served by the
function getResolutionLabel(quality) {
  var map = {
    best: null, // label filled at call time via t('qualityBest')
    good: '1080p',
    normal: '720p',
    bad: '480p',
    worst: '360p'
  };
  var label = map[quality];
  return label === null ? t('qualityBest') : (label || '-');
}

// Custom dropdown interaction handlers for theme-integrated animated select menus.
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
