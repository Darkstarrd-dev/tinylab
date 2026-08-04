// FileTransfer settings modal: collect arbitrary files, confirm, ZIP, and
// upload through the backend's ordered temporary-host fallback.
'use strict';

var fileTransferState = { items: [], busy: false, pasteHandler: null };

function fileTransferFormatSize(size) {
  if (size < 1024) return size + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
  if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB';
  return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function fileTransferRenderList() {
  var list = document.getElementById('filetransfer-file-list');
  var summary = document.getElementById('filetransfer-summary');
  var zone = document.getElementById('filetransfer-drop-zone');
  if (!list || !summary || !zone) return;
  if (!fileTransferState.items.length) {
    list.innerHTML = '<div class="filetransfer-empty">' + escapeHtml(t('fileTransferNoFiles')) + '</div>';
    summary.textContent = t('fileTransferSelectHint');
    zone.classList.remove('has-files');
    return;
  }
  var total = 0;
  list.innerHTML = fileTransferState.items.map(function(item, index) {
    total += item.size || 0;
    var name = escapeHtml(item.name || 'unnamed file');
    return '<div class="filetransfer-file-row">' +
      '<span class="filetransfer-file-name" title="' + name + '">' + name + '</span>' +
      '<span class="filetransfer-file-size">' + fileTransferFormatSize(item.size || 0) + '</span>' +
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
    if (file && file.size > 0) {
      fileTransferAddItem({ name: file.name || 'pasted-file', size: file.size, file: file });
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
    if (collected[i].handle || collected[i].file) {
      if (collected[i].handle) handles.push(collected[i]);
      else files.push(collected[i].file);
    }
  }
  if (handles.length) await fileTransferAddHandles(handles);
  if (files.length) fileTransferAddPlainFiles(files);
}

async function fileTransferCollectDataTransfer(dt) {
  if (!dt) return;
  await fileTransferAddCollected(await FsApi.collectFilesFromDataTransfer(dt));
}

async function fileTransferPaste(e) {
  if (fileTransferState.busy || !document.getElementById('filetransfer-drop-zone')) return;
  try {
    var pathResponse = await fetch('/api/gallery/paste-paths', { method: 'POST' });
    if (pathResponse.ok) {
      var pathData = await pathResponse.json();
      if (pathData.paths && pathData.paths.length) {
        e.preventDefault();
        for (var i = 0; i < pathData.paths.length; i++) {
          var p = pathData.paths[i];
          fileTransferAddItem({ name: p.replace(/[\\/]/g, '/').split('/').pop(), size: 0, localPath: p });
        }
        return;
      }
    }
  } catch (err) {
    console.warn('FileTransfer clipboard paths failed:', err);
  }
  if (e.clipboardData && e.clipboardData.items && e.clipboardData.items.length) {
    var hasFile = false;
    for (var j = 0; j < e.clipboardData.items.length; j++) {
      if (e.clipboardData.items[j].kind === 'file') { hasFile = true; break; }
    }
    if (hasFile) {
      e.preventDefault();
      await fileTransferCollectDataTransfer(e.clipboardData);
    }
  }
}

function fileTransferDragOver(e) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  var zone = document.getElementById('filetransfer-drop-zone');
  if (zone) zone.classList.add('drag-active');
}

function fileTransferDragLeave() {
  var zone = document.getElementById('filetransfer-drop-zone');
  if (zone) zone.classList.remove('drag-active');
}

async function fileTransferDrop(e) {
  e.preventDefault();
  fileTransferDragLeave();
  await fileTransferCollectDataTransfer(e.dataTransfer);
}

function fileTransferOpenPicker() {
  if (fileTransferState.busy) return;
  FsApi.pickFiles({ multiple: true }).then(fileTransferAddHandles).catch(function(err) {
    console.warn('FileTransfer picker failed:', err);
  });
}

function fileTransferRemove(index) {
  if (index >= 0 && index < fileTransferState.items.length) {
    fileTransferState.items.splice(index, 1);
    fileTransferRenderList();
  }
}

function fileTransferSetStatus(message, isError) {
  var status = document.getElementById('filetransfer-status');
  if (!status) return;
  status.textContent = message || '';
  status.className = 'filetransfer-status' + (isError ? ' error' : '');
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

async function fileTransferUpload() {
  if (fileTransferState.busy) return;
  if (!fileTransferState.items.length) {
    fileTransferSetStatus(t('fileTransferNoFiles'), true);
    return;
  }
  fileTransferState.busy = true;
  var saveButton = document.getElementById('settings-modal-save');
  if (saveButton) saveButton.disabled = true;
  fileTransferSetStatus(t('fileTransferPacking'), false);
  try {
    var response = await fetch('/api/filetransfer/upload', { method: 'POST', body: fileTransferBuildFormData() });
    var data = await response.json();
    if (!response.ok || !data.url) {
      var details = data.failures && data.failures.length ? ' ' + data.failures.join('; ') : '';
      throw new Error((data.error || ('HTTP ' + response.status)) + details);
    }
    fileTransferSetStatus(t('fileTransferSuccess', [data.service || '']), false);
    var result = document.getElementById('filetransfer-result');
    if (result) {
      var url = escapeHtml(data.url);
      result.innerHTML = '<a class="filetransfer-result-link" href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    }
    var cancel = document.querySelector('#modal-overlay .modal-footer .btn-ghost');
    if (cancel) cancel.textContent = t('close');
    if (saveButton) saveButton.style.display = 'none';
  } catch (err) {
    fileTransferSetStatus(err.message || String(err), true);
  } finally {
    fileTransferState.busy = false;
    if (saveButton) saveButton.disabled = false;
  }
}

function cleanupFileTransferModal() {
  if (fileTransferState.pasteHandler) {
    document.removeEventListener('paste', fileTransferState.pasteHandler);
    fileTransferState.pasteHandler = null;
  }
  fileTransferState.items = [];
  fileTransferState.busy = false;
}

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
    '<div id="filetransfer-file-list" class="filetransfer-file-list"><div class="filetransfer-empty">' + escapeHtml(t('fileTransferNoFiles')) + '</div></div>' +
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
  if (!zone || !input || !browse) return;
  zone.addEventListener('dragover', fileTransferDragOver);
  zone.addEventListener('dragleave', fileTransferDragLeave);
  zone.addEventListener('drop', fileTransferDrop);
  zone.addEventListener('click', function(e) { if (e.target !== browse) input.click(); });
  browse.onclick = function(e) { e.stopPropagation(); input.click(); };
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
  requestAnimationFrame(function() { zone.focus(); });
}
