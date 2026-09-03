// web/static/download-settings.js
// Path/tool settings modal for TinyLab Download.
// Extracted from download.js (P2-05): modal + path settings + browse picker.
// Depends on download.js globals: downloadDefaultDir, browsePickerOpen, apiGet/apiPost, t/escapeHtml/escapeAttr, toast

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
  if (typeof beginNativePickerLock === 'function' && !beginNativePickerLock(mode)) return;
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
    if (res && res.path) inputEl.value = res.path;
  } catch (e) {
    console.warn('browse picker failed:', e);
  } finally {
    browsePickerOpen = false;
    btns.forEach(function(b) { b.disabled = false; });
    if (overlay) overlay.style.pointerEvents = '';
    if (typeof endNativePickerLock === 'function') endNativePickerLock();
  }
}

// openPathSettingsModal shows a modal with path/tool settings.
// opts = { title?: string, sections: { defaultDir?, imageDir?, docDir?, logDir?, gamesDir?, musicDir?, ytDlpPath?, ffmpegPath? }, useProxy?: bool }
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
  if (sections.docDir) {
    var docVal = (res && res.docDir) || '';
    var docInit = docVal || (configDir ? configDir + '/docs' : '');
    var docPh = configDir ? configDir + '/docs' : 'docs';
    formRows += browseRow('docDir', 'modal-dl-doc-dir', docVal, docPh, 'directory', null, docInit);
  }
  if (sections.logDir) {
    var logVal = (res && res.trace && res.trace.logDir) || '';
    var logInit = logVal || (configDir ? configDir + '/traces' : '');
    var logPh = configDir ? configDir + '/traces' : 'traces';
    formRows += browseRow('logDir', 'modal-dl-log-dir', logVal, logPh, 'directory', null, logInit);
  }
  if (sections.gamesDir) {
    var gamesVal = (res && res.gamesDir) || '';
    var gamesInit = gamesVal || (configDir ? configDir + '/games' : '');
    var gamesPh = configDir ? configDir + '/games' : 'games';
    formRows += browseRow('gamesDir', 'modal-dl-games-dir', gamesVal, gamesPh, 'directory', null, gamesInit);
  }
  if (sections.musicDir) {
    var musicVal = (res && res.musicDir) || '';
    var musicInit = musicVal || (configDir ? configDir + '/Musics' : '');
    var musicPh = configDir ? configDir + '/Musics' : 'Musics';
    formRows += browseRow('musicDir', 'modal-dl-music-dir', musicVal, musicPh, 'directory', null, musicInit);
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
    if (sections.docDir) payload.docDir = (document.getElementById('modal-dl-doc-dir') || {}).value || '';
    if (sections.logDir) payload.trace = { logDir: (document.getElementById('modal-dl-log-dir') || {}).value || '' };
    if (sections.gamesDir) payload.gamesDir = (document.getElementById('modal-dl-games-dir') || {}).value || '';
    if (sections.musicDir) payload.musicDir = (document.getElementById('modal-dl-music-dir') || {}).value || '';

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

