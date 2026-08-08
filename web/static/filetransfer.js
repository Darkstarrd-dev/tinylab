// FileTransfer settings modal: collect arbitrary files, confirm, ZIP, and
// upload through the backend's ordered temporary-host fallback.
'use strict';

var fileTransferState = {
  items: [], busy: false, pasteHandler: null, dragGuard: null,
  root: null, actionButton: null, cancelButton: null
};

function fileTransferElement(id) {
  var root = fileTransferState.root;
  if (root && root.querySelector) {
    var scoped = root.querySelector('#' + id);
    if (scoped) return scoped;
  }
  return document.getElementById(id);
}

function fileTransferFormatSize(size) {
  size = Number(size) || 0;
  if (size < 1024) return size + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
  if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB';
  return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function fileTransferRenderList() {
  var list = fileTransferElement('filetransfer-file-list');
  var summary = fileTransferElement('filetransfer-summary');
  var zone = fileTransferElement('filetransfer-drop-zone');
  if (!list || !summary || !zone) return;
  if (!fileTransferState.items.length) {
    list.innerHTML = '<div class="filetransfer-empty">' + escapeHtml(t('fileTransferNoFiles')) + '</div>';
    summary.textContent = t('fileTransferSelectHint');
    zone.classList.remove('has-files');
    return;
  }
  var total = 0;
  list.innerHTML = fileTransferState.items.map(function(item, index) {
    total += Number(item.size) || 0;
    var name = escapeHtml(item.name || 'unnamed file');
    return '<div class="filetransfer-file-row">' +
      '<span class="filetransfer-file-name" title="' + name + '">' + name + '</span>' +
      '<span class="filetransfer-file-size">' + fileTransferFormatSize(item.size) + '</span>' +
      '<button type="button" class="btn btn-sm btn-ghost filetransfer-remove" data-index="' + index + '" aria-label="' + escapeHtml(t('fileTransferRemove')) + '">&times;</button>' +
      '</div>';
  }).join('');
  summary.textContent = t('fileTransferSelected', [String(fileTransferState.items.length), fileTransferFormatSize(total)]);
  zone.classList.add('has-files');
}

function fileTransferAddItem(item) {
  if (!item || !item.name) return;
  fileTransferState.items.push(item);
  fileTransferRenderList();
}

function fileTransferAddPlainFiles(files) {
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (file && file.name) {
      fileTransferAddItem({ name: file.name, size: file.size || 0, file: file });
    }
  }
}

async function fileTransferAddHandles(entries) {
  var pending = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!entry) continue;
    if (entry.file) {
      fileTransferAddPlainFiles([entry.file]);
      continue;
    }
    if (!entry.handle) continue;
    var handle = entry.handle;
    if (handle.kind === 'directory') {
      await FsApi.walkDir(handle, function(fileHandle, relativePath) {
        pending.push(fileHandle.getFile().then(function(file) {
          fileTransferAddItem({ name: relativePath, size: file.size, file: file });
        }));
      });
    } else if (handle.kind === 'file') {
      var file = await handle.getFile();
      fileTransferAddItem({ name: file.name, size: file.size, file: file });
    }
  }
  if (pending.length) await Promise.all(pending);
}

async function fileTransferAddCollected(collected) {
  var handles = [];
  var files = [];
  for (var i = 0; i < collected.length; i++) {
    if (collected[i].handle) handles.push(collected[i]);
    else if (collected[i].file) files.push(collected[i].file);
  }
  if (handles.length) await fileTransferAddHandles(handles);
  if (files.length) fileTransferAddPlainFiles(files);
}

async function fileTransferCollectDataTransfer(dt) {
  if (!dt) return;
  await fileTransferAddCollected(await FsApi.collectFilesFromDataTransfer(dt));
}

async function fileTransferPaste(e) {
  if (fileTransferState.busy || !fileTransferElement('filetransfer-drop-zone')) return;
  e.preventDefault();
  try {
    var pathResponse = await fetch('/api/gallery/paste-paths', { method: 'POST' });
    if (pathResponse.ok) {
      var pathData = await pathResponse.json();
      if (pathData.paths && pathData.paths.length) {
        var paths = pathData.paths;
        try {
          var infoResponse = await fetch('/api/filetransfer/path-info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: paths })
          });
          if (infoResponse.ok) {
            var infoData = await infoResponse.json();
            if (infoData.paths && infoData.paths.length) {
              for (var i = 0; i < infoData.paths.length; i++) {
                var info = infoData.paths[i];
                fileTransferAddItem({ name: info.name, size: Number(info.size) || 0, localPath: info.path });
              }
              return;
            }
          }
        } catch (infoErr) {
          console.warn('FileTransfer clipboard path sizes failed:', infoErr);
        }
        for (var j = 0; j < paths.length; j++) {
          var fallbackPath = paths[j];
          fileTransferAddItem({ name: fallbackPath.replace(/[\\/]/g, '/').split('/').pop(), size: 0, localPath: fallbackPath });
        }
        return;
      }
    }
  } catch (err) {
    console.warn('FileTransfer clipboard paths failed:', err);
  }
  if (e.clipboardData && e.clipboardData.items && e.clipboardData.items.length) {
    var hasFile = false;
    for (var k = 0; k < e.clipboardData.items.length; k++) {
      if (e.clipboardData.items[k].kind === 'file') { hasFile = true; break; }
    }
    if (hasFile) await fileTransferCollectDataTransfer(e.clipboardData);
  }
}

function fileTransferDragOver(e) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  var zone = fileTransferElement('filetransfer-drop-zone');
  if (zone) zone.classList.add('drag-active');
}

function fileTransferDragLeave() {
  var zone = fileTransferElement('filetransfer-drop-zone');
  if (zone) zone.classList.remove('drag-active');
}

async function fileTransferDrop(e) {
  e.preventDefault();
  fileTransferDragLeave();
  if (!e.dataTransfer) return;
  await fileTransferCollectDataTransfer(e.dataTransfer);
}

function fileTransferInstallDragGuard() {
  var guard = function(e) {
    var zone = fileTransferElement('filetransfer-drop-zone');
    if (zone && zone.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  };
  fileTransferState.dragGuard = guard;
  document.addEventListener('dragenter', guard, true);
  document.addEventListener('dragover', guard, true);
  document.addEventListener('drop', guard, true);
}

function fileTransferRemove(index) {
  if (fileTransferState.busy) return;
  if (index >= 0 && index < fileTransferState.items.length) {
    fileTransferState.items.splice(index, 1);
    fileTransferRenderList();
  }
}
function fileTransferCancelButton() {
  if (fileTransferState.cancelButton) return fileTransferState.cancelButton;
  return document.querySelector('#modal-overlay .modal-footer .btn-ghost');
}

function fileTransferSetStatus(message, isError) {
  var status = fileTransferElement('filetransfer-status');
  if (!status) return;
  status.textContent = message || '';
  status.className = 'filetransfer-status' + (isError ? ' error' : '');
}

function fileTransferSetProgress(percent, visible) {
  var wrap = fileTransferElement('filetransfer-progress-wrap');
  var bar = fileTransferElement('filetransfer-progress');
  var label = fileTransferElement('filetransfer-progress-label');
  if (!wrap || !bar || !label) return;
  if (!visible) {
    wrap.hidden = true;
    bar.value = 0;
    label.textContent = '';
    return;
  }
  var value = Math.max(0, Math.min(100, Number(percent) || 0));
  wrap.hidden = false;
  bar.value = value;
  label.textContent = value.toFixed(0) + '%';
}

function fileTransferBuildFormData() {
  var form = new FormData();
  var paths = [];
  for (var i = 0; i < fileTransferState.items.length; i++) {
    var item = fileTransferState.items[i];
    if (item.localPath) paths.push(item.localPath);
    else if (item.file) form.append('files', item.file, item.name || item.file.name || 'file');
    else throw new Error(t('fileTransferReadFailed'));
  }
  if (paths.length) form.append('paths', JSON.stringify(paths));
  return form;
}

function fileTransferResetView() {
  fileTransferState.items = [];
  fileTransferSetStatus('', false);
  fileTransferSetProgress(0, false);
  var result = fileTransferElement('filetransfer-result');
  if (result) result.innerHTML = '';
  var saveButton = fileTransferState.actionButton || fileTransferElement('settings-modal-save');
  if (saveButton) {
    saveButton.textContent = t('fileTransferConfirm');
    saveButton.style.display = '';
    saveButton.disabled = false;
  }
  var clearButton = fileTransferElement('filetransfer-clear');
  if (clearButton) clearButton.disabled = false;
  var cancel = fileTransferCancelButton();
  if (cancel) cancel.textContent = t('cancel');
  fileTransferRenderList();
}

function fileTransferClear() {
  if (fileTransferState.busy) return;
  fileTransferResetView();
}

async function fileTransferUpload() {
  if (fileTransferState.busy) return;
  if (!fileTransferState.items.length) {
    fileTransferSetStatus(t('fileTransferNoFiles'), true);
    return;
  }
  fileTransferState.busy = true;
  var saveButton = fileTransferState.actionButton || fileTransferElement('settings-modal-save');
  var clearButton = fileTransferElement('filetransfer-clear');
  if (saveButton) saveButton.disabled = true;
  if (clearButton) clearButton.disabled = true;
  fileTransferSetStatus(t('fileTransferPacking'), false);
  fileTransferSetProgress(0, true);
  try {
    var data = await new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/filetransfer/upload');
      xhr.responseType = 'text';
      xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) fileTransferSetProgress((e.loaded / e.total) * 100, true);
      };
      xhr.onerror = function() { reject(new Error(t('fileTransferNetworkFailed'))); };
      xhr.onabort = function() { reject(new Error(t('fileTransferNetworkFailed'))); };
      xhr.onload = function() {
        var response = {};
        try { response = JSON.parse(xhr.responseText || '{}'); } catch (err) { /* keep empty response */ }
        if (xhr.status < 200 || xhr.status >= 300 || !response.url) {
          var details = response.failures && response.failures.length ? ' ' + response.failures.join('; ') : '';
          reject(new Error((response.error || ('HTTP ' + xhr.status)) + details));
          return;
        }
        resolve(response);
      };
      try {
        xhr.send(fileTransferBuildFormData());
      } catch (err) {
        reject(err);
      }
    });
    fileTransferSetProgress(100, true);
    fileTransferSetStatus(t('fileTransferSuccess', [data.service || '']), false);
    var result = fileTransferElement('filetransfer-result');
    if (result) {
      var url = escapeHtml(data.url);
      result.innerHTML = '<a class="filetransfer-result-link" href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    }
    var cancel = fileTransferCancelButton();
    if (cancel) cancel.textContent = t('close');
    if (saveButton) saveButton.style.display = 'none';
  } catch (err) {
    fileTransferSetProgress(0, false);
    fileTransferSetStatus(err.message || String(err), true);
  } finally {
    fileTransferState.busy = false;
    if (saveButton) saveButton.disabled = false;
    if (clearButton) clearButton.disabled = false;
  }
}

function fileTransferRemoveGlobalListeners() {
  if (fileTransferState.pasteHandler) {
    document.removeEventListener('paste', fileTransferState.pasteHandler);
    fileTransferState.pasteHandler = null;
  }
  if (fileTransferState.dragGuard) {
    document.removeEventListener('dragenter', fileTransferState.dragGuard, true);
    document.removeEventListener('dragover', fileTransferState.dragGuard, true);
    document.removeEventListener('drop', fileTransferState.dragGuard, true);
    fileTransferState.dragGuard = null;
  }
}

function fileTransferBind(root, actionButton, cancelButton) {
  if (!root) return;
  fileTransferState.root = root;
  fileTransferState.actionButton = actionButton || null;
  fileTransferState.cancelButton = cancelButton || null;
  var zone = fileTransferElement('filetransfer-drop-zone');
  var input = fileTransferElement('filetransfer-input');
  var browse = fileTransferElement('filetransfer-browse');
  var clearButton = fileTransferElement('filetransfer-clear');
  if (!zone || !input || !browse) return;
  if (fileTransferState.boundRoot !== root) {
    zone.addEventListener('dragover', fileTransferDragOver);
    zone.addEventListener('dragleave', fileTransferDragLeave);
    zone.addEventListener('drop', fileTransferDrop);
    zone.addEventListener('click', function(e) { if (e.target !== browse) input.click(); });
    browse.onclick = function(e) { e.stopPropagation(); input.click(); };
    if (clearButton) clearButton.onclick = fileTransferClear;
    input.onchange = function() {
      fileTransferAddPlainFiles(Array.prototype.slice.call(input.files || []));
      input.value = '';
    };
    var list = fileTransferElement('filetransfer-file-list');
    if (list) list.addEventListener('click', function(e) {
      var button = e.target.closest('.filetransfer-remove');
      if (button) fileTransferRemove(parseInt(button.dataset.index, 10));
    });
    fileTransferState.boundRoot = root;
  }
  fileTransferState.pasteHandler = function(e) {
    if (fileTransferElement('filetransfer-drop-zone')) fileTransferPaste(e);
  };
  document.addEventListener('paste', fileTransferState.pasteHandler);
  fileTransferInstallDragGuard();
  requestAnimationFrame(function() { zone.focus(); });
  fileTransferRenderList();
}

function cleanupFileTransferModal() {
  fileTransferRemoveGlobalListeners();
  fileTransferState.items = [];
  fileTransferState.busy = false;
  fileTransferState.root = null;
  fileTransferState.actionButton = null;
  fileTransferState.cancelButton = null;
  fileTransferState.boundRoot = null;
}

function suspendFileTransfer() {
  fileTransferRemoveGlobalListeners();
}

function resumeFileTransfer() {
  var root = fileTransferState.root;
  if (!root) return;
  fileTransferState.pasteHandler = function(e) {
    if (fileTransferElement('filetransfer-drop-zone')) fileTransferPaste(e);
  };
  document.addEventListener('paste', fileTransferState.pasteHandler);
  fileTransferInstallDragGuard();
}

function cleanupFileTransfer() {
  cleanupFileTransferModal();
}

function renderUtilityFileTransfer(container) {
  if (!container) return null;
  suspendFileTransfer();
  fileTransferState.boundRoot = null;
  fileTransferState.root = container;
  container.innerHTML =
    '<div class="filetransfer-utility">' +
      '<p class="muted">' + escapeHtml(t('fileTransferDesc')) + '</p>' +
      '<div id="filetransfer-drop-zone" class="filetransfer-drop-zone" tabindex="0">' +
        '<input id="filetransfer-input" type="file" multiple style="display:none">' +
        '<div class="filetransfer-drop-title">' + escapeHtml(t('fileTransferDropHere')) + '</div>' +
        '<div class="filetransfer-drop-hint">' + escapeHtml(t('fileTransferPasteHint')) + '</div>' +
        '<button type="button" class="btn btn-sm btn-primary" id="filetransfer-browse">' + escapeHtml(t('fileTransferBrowse')) + '</button>' +
      '</div>' +
      '<div id="filetransfer-summary" class="filetransfer-summary"></div>' +
      '<div class="filetransfer-toolbar"><button type="button" class="btn btn-sm btn-ghost" id="filetransfer-clear">' + escapeHtml(t('fileTransferClear')) + '</button></div>' +
      '<div id="filetransfer-file-list" class="filetransfer-file-list"></div>' +
      '<div id="filetransfer-progress-wrap" class="filetransfer-progress-wrap" hidden><div class="filetransfer-progress-head"><span>' + escapeHtml(t('fileTransferProgress')) + '</span><span id="filetransfer-progress-label"></span></div><progress id="filetransfer-progress" max="100" value="0"></progress></div>' +
      '<div id="filetransfer-result" class="filetransfer-result"></div>' +
      '<div id="filetransfer-status" class="filetransfer-status"></div>' +
      '<div class="filetransfer-actions"><button type="button" class="btn btn-ghost" id="filetransfer-cancel">' + escapeHtml(t('cancel')) + '</button><button type="button" class="btn btn-primary" id="filetransfer-action">' + escapeHtml(t('fileTransferConfirm')) + '</button></div>' +
    '</div>';
  var action = fileTransferElement('filetransfer-action');
  var cancel = fileTransferElement('filetransfer-cancel');
  if (action) action.onclick = function() { withLoading(this, fileTransferUpload); };
  if (cancel) cancel.onclick = function() { suspendFileTransfer(); container.innerHTML = ''; };
  fileTransferState.boundRoot = null;
  fileTransferBind(container, action, cancel);
  return container;
}

window.renderUtilityFileTransfer = renderUtilityFileTransfer;
window.suspendFileTransfer = suspendFileTransfer;
window.resumeFileTransfer = resumeFileTransfer;
window.cleanupFileTransfer = cleanupFileTransfer;

function openFileTransferModal() {
  cleanupFileTransferModal();
  openSettingsModal(t('fileTransfer'),
    '<p class="muted">' + escapeHtml(t('fileTransferDesc')) + '</p>' +
    '<div id="filetransfer-drop-zone" class="filetransfer-drop-zone" tabindex="0">' +
      '<input id="filetransfer-input" type="file" multiple style="display:none">' +
      '<div class="filetransfer-drop-title">' + escapeHtml(t('fileTransferDropHere')) + '</div>' +
      '<div class="filetransfer-drop-hint">' + escapeHtml(t('fileTransferPasteHint')) + '</div>' +
      '<button type="button" class="btn btn-sm btn-primary" id="filetransfer-browse">' + escapeHtml(t('fileTransferBrowse')) + '</button>' +
    '</div>' +
    '<div id="filetransfer-summary" class="filetransfer-summary">' + escapeHtml(t('fileTransferSelectHint')) + '</div>' +
    '<div class="filetransfer-toolbar">' +
      '<button type="button" class="btn btn-sm btn-ghost" id="filetransfer-clear">' + escapeHtml(t('fileTransferClear')) + '</button>' +
    '</div>' +
    '<div id="filetransfer-file-list" class="filetransfer-file-list"><div class="filetransfer-empty">' + escapeHtml(t('fileTransferNoFiles')) + '</div></div>' +
    '<div id="filetransfer-progress-wrap" class="filetransfer-progress-wrap" hidden>' +
      '<div class="filetransfer-progress-head"><span>' + escapeHtml(t('fileTransferProgress')) + '</span><span id="filetransfer-progress-label"></span></div>' +
      '<progress id="filetransfer-progress" max="100" value="0"></progress>' +
    '</div>' +
    '<div id="filetransfer-result" class="filetransfer-result"></div>' +
    '<div id="filetransfer-status" class="filetransfer-status"></div>'
  );
  var saveButton = document.getElementById('settings-modal-save');
  if (saveButton) {
    saveButton.textContent = t('fileTransferConfirm');
    saveButton.onclick = function() { withLoading(this, fileTransferUpload); };
  }
  var zone = document.getElementById('filetransfer-drop-zone');
  var input = document.getElementById('filetransfer-input');
  var browse = document.getElementById('filetransfer-browse');
  var clearButton = document.getElementById('filetransfer-clear');
  if (!zone || !input || !browse) return;
  zone.addEventListener('dragover', fileTransferDragOver);
  zone.addEventListener('dragleave', fileTransferDragLeave);
  zone.addEventListener('drop', fileTransferDrop);
  zone.addEventListener('click', function(e) { if (e.target !== browse) input.click(); });
  browse.onclick = function(e) { e.stopPropagation(); input.click(); };
  if (clearButton) clearButton.onclick = fileTransferClear;
  input.onchange = function() {
    fileTransferAddPlainFiles(Array.prototype.slice.call(input.files || []));
    input.value = '';
  };
  var list = document.getElementById('filetransfer-file-list');
  if (list) list.addEventListener('click', function(e) {
    var button = e.target.closest('.filetransfer-remove');
    if (button) fileTransferRemove(parseInt(button.dataset.index, 10));
  });
  fileTransferState.pasteHandler = function(e) {
    if (document.getElementById('filetransfer-drop-zone')) fileTransferPaste(e);
  };
  document.addEventListener('paste', fileTransferState.pasteHandler);
  fileTransferInstallDragGuard();
  requestAnimationFrame(function() { zone.focus(); });
}
