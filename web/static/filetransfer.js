// FileTransfer: collect arbitrary files, confirm, ZIP, and
// upload through the backend's ordered temporary-host fallback.
// Dual-Panel Staging Workflow layout, matching TinyRouter design system.
'use strict';

var fileTransferState = {
  items: [],
  busy: false,
  pasteHandler: null,
  dragGuard: null,
  root: null,
  actionButton: null,
  cancelButton: null,
  boundRoot: null
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

function fileTransferGetFileTypeInfo(name) {
  name = String(name || '').toLowerCase();
  var ext = '';
  var dotIdx = name.lastIndexOf('.');
  if (dotIdx !== -1) ext = name.slice(dotIdx);

  if (['.pdf'].indexOf(ext) !== -1) {
    return {
      type: 'pdf',
      label: 'PDF ' + t('fileTransferFileType_document', '文档'),
      colorClass: 'ft-icon-pdf',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>'
    };
  }
  if (['.json', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.go', '.py', '.rs', '.c', '.cpp', '.h', '.java', '.yaml', '.yml', '.toml', '.sh', '.bat', '.ps1', '.sql'].indexOf(ext) !== -1) {
    return {
      type: 'code',
      label: t('fileTransferFileType_code', '代码/配置'),
      colorClass: 'ft-icon-code',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'
    };
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.avif'].indexOf(ext) !== -1) {
    return {
      type: 'image',
      label: t('fileTransferFileType_image', '图片'),
      colorClass: 'ft-icon-image',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>'
    };
  }
  if (['.mp4', '.mkv', '.webm', '.avi', '.mov', '.flv', '.wmv'].indexOf(ext) !== -1) {
    return {
      type: 'video',
      label: t('fileTransferFileType_video', '视频'),
      colorClass: 'ft-icon-video',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>'
    };
  }
  if (['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma'].indexOf(ext) !== -1) {
    return {
      type: 'audio',
      label: t('fileTransferFileType_audio', '音频'),
      colorClass: 'ft-icon-audio',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
    };
  }
  if (['.zip', '.tar', '.gz', '.7z', '.rar', '.bz2', '.xz', '.tgz'].indexOf(ext) !== -1) {
    return {
      type: 'archive',
      label: t('fileTransferFileType_archive', '压缩包'),
      colorClass: 'ft-icon-archive',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>'
    };
  }
  if (['.xlsx', '.xls', '.csv', '.tsv'].indexOf(ext) !== -1) {
    return {
      type: 'spreadsheet',
      label: t('fileTransferFileType_spreadsheet', '表格'),
      colorClass: 'ft-icon-spreadsheet',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>'
    };
  }
  if (['.txt', '.md', '.doc', '.docx', '.rtf', '.log'].indexOf(ext) !== -1) {
    return {
      type: 'document',
      label: t('fileTransferFileType_document', '文档'),
      colorClass: 'ft-icon-doc',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
    };
  }
  return {
    type: 'file',
    label: t('fileTransferFileType_file', '文件'),
    colorClass: 'ft-icon-file',
    svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>'
  };
}

function fileTransferRenderList() {
  var list = fileTransferElement('filetransfer-file-list');
  var summary = fileTransferElement('filetransfer-summary');
  var stageCount = fileTransferElement('filetransfer-stage-count');
  var clearBtn = fileTransferElement('filetransfer-clear');
  var actionBtn = fileTransferState.actionButton || fileTransferElement('filetransfer-action') || fileTransferElement('settings-modal-save');
  var zone = fileTransferElement('filetransfer-drop-zone');

  var count = fileTransferState.items.length;
  var total = 0;
  for (var i = 0; i < count; i++) {
    total += Number(fileTransferState.items[i].size) || 0;
  }
  var formattedTotal = fileTransferFormatSize(total);

  if (stageCount) {
    stageCount.textContent = t('fileTransferStage1Count', [String(count)], '已加入 ' + count + ' 项文件');
  }

  if (summary) {
    if (count === 0) {
      summary.textContent = t('fileTransferSummaryLabel', ['0', '0 B'], '文件统计: 0 文件 / 0 B');
    } else {
      summary.textContent = t('fileTransferSummaryLabel', [String(count), formattedTotal], '文件统计: ' + count + ' 文件 / ' + formattedTotal);
    }
  }

  if (clearBtn) {
    clearBtn.disabled = (count === 0 || fileTransferState.busy);
  }

  if (actionBtn && !fileTransferState.busy) {
    actionBtn.disabled = (count === 0);
  }

  if (zone) {
    if (count > 0) zone.classList.add('has-files');
    else zone.classList.remove('has-files');
  }

  if (!list) return;

  if (count === 0) {
    list.innerHTML =
      '<div class="filetransfer-empty-zone">' +
        '<div class="filetransfer-empty-icon">' +
          '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>' +
        '</div>' +
        '<div class="filetransfer-empty-text">' + escapeHtml(t('fileTransferNoFiles', '暂未选择文件，请从上方拖入或浏览选择。')) + '</div>' +
      '</div>';
    return;
  }

  list.innerHTML = fileTransferState.items.map(function(item, index) {
    var name = escapeHtml(item.name || 'unnamed file');
    var sizeStr = fileTransferFormatSize(item.size);
    var typeInfo = fileTransferGetFileTypeInfo(item.name);
    return '<div class="filetransfer-file-item">' +
      '<div class="filetransfer-item-icon-box ' + typeInfo.colorClass + '">' +
        typeInfo.svg +
      '</div>' +
      '<div class="filetransfer-item-info">' +
        '<div class="filetransfer-item-name" title="' + name + '">' + name + '</div>' +
        '<div class="filetransfer-item-meta">' + sizeStr + ' · ' + escapeHtml(typeInfo.label) + '</div>' +
      '</div>' +
      '<button type="button" class="filetransfer-item-remove-btn filetransfer-remove" data-index="' + index + '" aria-label="' + escapeHtml(t('fileTransferRemove', '移除文件')) + '" title="' + escapeHtml(t('fileTransferRemove', '移除文件')) + '">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' +
      '</button>' +
    '</div>';
  }).join('');
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
  if (typeof FsApi !== 'undefined' && typeof FsApi.collectFilesFromDataTransfer === 'function') {
    await fileTransferAddCollected(await FsApi.collectFilesFromDataTransfer(dt));
  } else if (dt.files && dt.files.length) {
    fileTransferAddPlainFiles(Array.prototype.slice.call(dt.files));
  }
}

async function fileTransferPaste(e) {
  if (fileTransferState.busy) return;
  if (e && typeof e.preventDefault === 'function') e.preventDefault();

  var addedCount = 0;
  try {
    // Path capability contract (audit F-01/B-2): the server reads the OS
    // clipboard and registers short-TTL export grants; the browser only ever
    // holds pathGrantIds, never local paths.
    var pathResponse = await fetch('/api/filetransfer/paste', { method: 'POST' });
    if (pathResponse.ok) {
      var pathData = await pathResponse.json();
      if (pathData.grants && pathData.grants.length) {
        for (var i = 0; i < pathData.grants.length; i++) {
          var g = pathData.grants[i];
          fileTransferAddItem({ name: g.name || 'unnamed', size: Number(g.size) || 0, grantId: g.pathGrantId });
          addedCount++;
        }
        if (typeof showToast === 'function' && addedCount > 0) {
          showToast(t('fileTransferAddedFromClipboard', [String(addedCount)], '已从剪贴板添加 ' + addedCount + ' 项'));
        }
        return;
      }
    }
  } catch (err) {
    console.warn('FileTransfer clipboard grants failed:', err);
  }

  if (e && e.clipboardData && e.clipboardData.items && e.clipboardData.items.length) {
    var hasFile = false;
    for (var k = 0; k < e.clipboardData.items.length; k++) {
      if (e.clipboardData.items[k].kind === 'file') { hasFile = true; break; }
    }
    if (hasFile) {
      await fileTransferCollectDataTransfer(e.clipboardData);
      return;
    }
  }

  // If invoked via manual "Paste Clipboard" button and clipboardData is not present in event
  if (!e || !e.clipboardData) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
        var clipItems = await navigator.clipboard.read();
        var filesFound = [];
        for (var c = 0; c < clipItems.length; c++) {
          var item = clipItems[c];
          for (var tIdx = 0; tIdx < item.types.length; tIdx++) {
            var type = item.types[tIdx];
            if (type.startsWith('image/') || type === 'application/pdf' || type.startsWith('text/')) {
              var blob = await item.getType(type);
              var ext = type === 'image/png' ? '.png' : type === 'image/jpeg' ? '.jpg' : '.txt';
              var blobFile = new File([blob], 'clipboard_' + Date.now() + ext, { type: type });
              filesFound.push(blobFile);
              break;
            }
          }
        }
        if (filesFound.length) {
          fileTransferAddPlainFiles(filesFound);
          if (typeof showToast === 'function') {
            showToast(t('fileTransferAddedFromClipboard', [String(filesFound.length)], '已从剪贴板添加 ' + filesFound.length + ' 项'));
          }
          return;
        }
      }
    } catch (clipErr) {
      console.warn('navigator.clipboard.read error:', clipErr);
    }

    if (typeof showToast === 'function') {
      showToast(t('fileTransferNoClipboardFiles', '剪贴板中未检测到文件（请复制文件后重试或按 Ctrl+V）'));
    }
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
    label.textContent = '0%';
    return;
  }
  var value = Math.max(0, Math.min(100, Number(percent) || 0));
  wrap.hidden = false;
  bar.value = value;
  label.textContent = value.toFixed(0) + '%';
}

function fileTransferBuildFormData() {
  var form = new FormData();
  var grantIds = [];
  for (var i = 0; i < fileTransferState.items.length; i++) {
    var item = fileTransferState.items[i];
    if (item.grantId) grantIds.push(item.grantId);
    else if (item.file) form.append('files', item.file, item.name || item.file.name || 'file');
    else throw new Error(t('fileTransferReadFailed'));
  }
  if (grantIds.length) form.append('grantIds', JSON.stringify(grantIds));
  return form;
}

function fileTransferResetView() {
  fileTransferState.items = [];
  fileTransferSetStatus('', false);
  fileTransferSetProgress(0, false);
  var result = fileTransferElement('filetransfer-result');
  if (result) result.innerHTML = '';
  var saveButton = fileTransferState.actionButton || fileTransferElement('filetransfer-action') || fileTransferElement('settings-modal-save');
  if (saveButton) {
    saveButton.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>' +
      '<span>' + escapeHtml(t('fileTransferConfirm', '打包并生成临时分享链接')) + '</span>';
    saveButton.style.display = '';
    saveButton.disabled = true;
  }
  var clearButton = fileTransferElement('filetransfer-clear');
  if (clearButton) clearButton.disabled = true;
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
    fileTransferSetStatus(t('fileTransferNoFiles', '暂未选择文件'), true);
    return;
  }
  fileTransferState.busy = true;
  var saveButton = fileTransferState.actionButton || fileTransferElement('filetransfer-action') || fileTransferElement('settings-modal-save');
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
      var serviceName = escapeHtml(data.service || 'tmpfiles');
      result.innerHTML =
        '<div class="filetransfer-success-card">' +
          '<div class="filetransfer-success-header">' +
            '<div class="filetransfer-success-icon">' +
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' +
            '</div>' +
            '<div class="filetransfer-success-title-box">' +
              '<div class="filetransfer-success-title">' + escapeHtml(t('fileTransferUploadCompleted', '打包上传完成！')) + '</div>' +
              '<div class="filetransfer-success-sub">' + escapeHtml(t('fileTransferSuccess', [serviceName], '已通过 ' + serviceName + ' 托管')) + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="filetransfer-link-box">' +
            '<input type="text" class="filetransfer-link-input" value="' + url + '" readonly id="filetransfer-url-input">' +
          '</div>' +
          '<div class="filetransfer-success-actions">' +
            '<button type="button" class="btn btn-sm btn-primary filetransfer-copy-btn" id="filetransfer-copy-btn">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
              '<span>' + escapeHtml(t('fileTransferCopyLink', '复制链接')) + '</span>' +
            '</button>' +
            '<a class="btn btn-sm btn-secondary filetransfer-open-btn" href="' + url + '" target="_blank" rel="noopener noreferrer">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
              '<span>' + escapeHtml(t('fileTransferOpenLink', '打开链接')) + '</span>' +
            '</a>' +
            '<button type="button" class="btn btn-sm btn-ghost filetransfer-new-btn" id="filetransfer-new-btn">' +
              '<span>' + escapeHtml(t('fileTransferNewTransfer', '继续传输')) + '</span>' +
            '</button>' +
          '</div>' +
        '</div>';

      var copyBtn = result.querySelector('#filetransfer-copy-btn');
      var urlInput = result.querySelector('#filetransfer-url-input');
      if (copyBtn && urlInput) {
        copyBtn.onclick = function() {
          urlInput.select();
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(data.url);
          } else {
            document.execCommand('copy');
          }
          var span = copyBtn.querySelector('span');
          if (span) span.textContent = t('fileTransferCopied', '已复制！');
          if (typeof showToast === 'function') {
            showToast(t('fileTransferCopied', '已复制到剪贴板！'));
          }
          setTimeout(function() {
            if (span) span.textContent = t('fileTransferCopyLink', '复制链接');
          }, 2000);
        };
      }
      var newBtn = result.querySelector('#filetransfer-new-btn');
      if (newBtn) {
        newBtn.onclick = function() {
          fileTransferResetView();
        };
      }
    }
    var cancel = fileTransferCancelButton();
    if (cancel) cancel.textContent = t('close');
    if (saveButton) saveButton.style.display = 'none';
  } catch (err) {
    fileTransferSetProgress(0, false);
    fileTransferSetStatus(err.message || String(err), true);
  } finally {
    fileTransferState.busy = false;
    if (saveButton) saveButton.disabled = (fileTransferState.items.length === 0);
    if (clearButton) clearButton.disabled = (fileTransferState.items.length === 0);
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
  var pasteBtn = fileTransferElement('filetransfer-paste-btn');
  var clearButton = fileTransferElement('filetransfer-clear');
  if (!zone || !input || !browse) return;
  if (fileTransferState.boundRoot !== root) {
    zone.addEventListener('dragover', fileTransferDragOver);
    zone.addEventListener('dragleave', fileTransferDragLeave);
    zone.addEventListener('drop', fileTransferDrop);
    zone.addEventListener('click', function(e) {
      if (e.target !== browse && !e.target.closest('#filetransfer-browse') && !e.target.closest('#filetransfer-paste-btn') && !e.target.closest('#filetransfer-clear')) {
        input.click();
      }
    });
    browse.onclick = function(e) { e.stopPropagation(); input.click(); };
    if (pasteBtn) {
      pasteBtn.onclick = function(e) {
        e.stopPropagation();
        fileTransferPaste(null);
      };
    }
    if (clearButton) {
      clearButton.onclick = function(e) {
        e.stopPropagation();
        fileTransferClear();
      };
    }
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
    '<div class="filetransfer-utility-view">' +
      '<div class="filetransfer-banner">' +
        '<div class="filetransfer-banner-left">' +
          '<div class="filetransfer-badge-icon">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>' +
          '</div>' +
          '<div>' +
            '<h2 class="filetransfer-title">' +
              '<span>' + escapeHtml(t('fileTransferPipelineTitle', '临时传输流水线')) + '</span>' +
              '<span class="filetransfer-badge-tag">2-Stage Workflow</span>' +
            '</h2>' +
            '<p class="filetransfer-subtitle">' + escapeHtml(t('fileTransferPipelineSubtitle', '左侧管理筹备文件，右侧控制 ZIP 打包与临时外传')) + '</p>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="filetransfer-grid">' +
        '<!-- Stage 1 Panel: Staging Zone -->' +
        '<div class="filetransfer-panel filetransfer-stage-left">' +
          '<div class="filetransfer-panel-header">' +
            '<div class="filetransfer-header-title">' +
              '<span class="filetransfer-stage-num">1</span>' +
              '<span class="filetransfer-stage-heading">' + escapeHtml(t('fileTransferStage1Title', '筹备待上传文件 (Staging Zone)')) + '</span>' +
            '</div>' +
            '<span id="filetransfer-stage-count" class="filetransfer-stage-count">' + escapeHtml(t('fileTransferStage1Count', ['0'], '已加入 0 项文件')) + '</span>' +
          '</div>' +
          '<div class="filetransfer-stage-body">' +
            '<div id="filetransfer-drop-zone" class="filetransfer-dropzone" tabindex="0">' +
              '<input id="filetransfer-input" type="file" multiple style="display:none">' +
              '<div class="filetransfer-drop-icon">' +
                '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 10v6"/><path d="m9 13 3-3 3 3"/></svg>' +
              '</div>' +
              '<div class="filetransfer-drop-text">' + escapeHtml(t('fileTransferPasteHint', '将文件拖放到此区域，或粘贴剪贴板')) + '</div>' +
              '<div class="filetransfer-drop-actions">' +
                '<button type="button" class="btn btn-sm btn-primary" id="filetransfer-browse">' +
                  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
                  '<span>' + escapeHtml(t('fileTransferBrowse', '选择文件')) + '</span>' +
                '</button>' +
                '<button type="button" class="btn btn-sm btn-secondary" id="filetransfer-paste-btn">' +
                  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>' +
                  '<span>' + escapeHtml(t('fileTransferPasteBtn', '粘贴剪贴板')) + '</span>' +
                '</button>' +
              '</div>' +
            '</div>' +
            '<div id="filetransfer-file-list" class="filetransfer-file-list"></div>' +
          '</div>' +
          '<div class="filetransfer-panel-footer">' +
            '<span id="filetransfer-summary" class="filetransfer-summary-text">' + escapeHtml(t('fileTransferSummaryLabel', ['0', '0 B'], '文件统计: 0 文件 / 0 B')) + '</span>' +
            '<button type="button" class="filetransfer-clear-btn" id="filetransfer-clear" disabled>' +
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
              '<span>' + escapeHtml(t('fileTransferClearAll', '全部清空')) + '</span>' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<!-- Stage 2 Panel: Output & Packaging -->' +
        '<div class="filetransfer-panel filetransfer-stage-right">' +
          '<div class="filetransfer-panel-header">' +
            '<div class="filetransfer-header-title">' +
              '<span class="filetransfer-stage-num ft-stage-2">2</span>' +
              '<span class="filetransfer-stage-heading">' + escapeHtml(t('fileTransferStage2Title', '打包配置与生成 (Output)')) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="filetransfer-stage-body ft-output-body">' +
            '<div class="filetransfer-info-group">' +
              '<div class="filetransfer-info-item">' +
                '<div class="filetransfer-info-label">' + escapeHtml(t('fileTransferArchiveFormat', '归档格式')) + '</div>' +
                '<div class="filetransfer-info-value">' +
                  '<span class="filetransfer-format-badge">ZIP</span>' +
                  '<span class="filetransfer-info-subtext">' + escapeHtml(t('fileTransferArchiveFormatVal', 'ZIP Deflate 格式 (自动时效命名)')) + '</span>' +
                '</div>' +
              '</div>' +
              '<div class="filetransfer-info-item">' +
                '<div class="filetransfer-info-label">' + escapeHtml(t('fileTransferHostNode', '临时托管节点')) + '</div>' +
                '<div class="filetransfer-info-value">' +
                  '<span class="filetransfer-host-badge">High Availability</span>' +
                  '<span class="filetransfer-info-subtext">' + escapeHtml(t('fileTransferHostNodeVal', '多源高可用中转 (tfLink / tmpfiles / temp.sh / Filebin 自动故障回退)')) + '</span>' +
                '</div>' +
              '</div>' +
              '<div class="filetransfer-info-hint">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' +
                '<span>' + escapeHtml(t('fileTransferFeatureHint', '公共临时外传链接，无需登录即可快速下载。')) + '</span>' +
              '</div>' +
            '</div>' +
            '<div id="filetransfer-progress-wrap" class="filetransfer-progress-wrap" hidden>' +
              '<div class="filetransfer-progress-head">' +
                '<span class="filetransfer-progress-title">' + escapeHtml(t('fileTransferProgress', '上传进度')) + '</span>' +
                '<span id="filetransfer-progress-label" class="filetransfer-progress-label">0%</span>' +
              '</div>' +
              '<div class="filetransfer-progress-bar-bg">' +
                '<progress id="filetransfer-progress" max="100" value="0"></progress>' +
              '</div>' +
            '</div>' +
            '<div id="filetransfer-status" class="filetransfer-status"></div>' +
            '<div id="filetransfer-result" class="filetransfer-result"></div>' +
          '</div>' +
          '<div class="filetransfer-panel-footer ft-action-footer">' +
            '<button type="button" class="btn btn-primary filetransfer-action-btn" id="filetransfer-action" disabled>' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>' +
              '<span>' + escapeHtml(t('fileTransferConfirm', '打包并生成临时分享链接')) + '</span>' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
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
    '<div class="filetransfer-utility-view ft-in-modal">' +
      '<div class="filetransfer-grid">' +
        '<div class="filetransfer-panel filetransfer-stage-left">' +
          '<div class="filetransfer-panel-header">' +
            '<div class="filetransfer-header-title">' +
              '<span class="filetransfer-stage-num">1</span>' +
              '<span class="filetransfer-stage-heading">' + escapeHtml(t('fileTransferStage1Title', '筹备待上传文件 (Staging Zone)')) + '</span>' +
            '</div>' +
            '<span id="filetransfer-stage-count" class="filetransfer-stage-count">' + escapeHtml(t('fileTransferStage1Count', ['0'], '已加入 0 项文件')) + '</span>' +
          '</div>' +
          '<div class="filetransfer-stage-body">' +
            '<div id="filetransfer-drop-zone" class="filetransfer-dropzone" tabindex="0">' +
              '<input id="filetransfer-input" type="file" multiple style="display:none">' +
              '<div class="filetransfer-drop-icon">' +
                '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 10v6"/><path d="m9 13 3-3 3 3"/></svg>' +
              '</div>' +
              '<div class="filetransfer-drop-text">' + escapeHtml(t('fileTransferPasteHint', '将文件拖放到此区域，或粘贴剪贴板')) + '</div>' +
              '<div class="filetransfer-drop-actions">' +
                '<button type="button" class="btn btn-sm btn-primary" id="filetransfer-browse">' + escapeHtml(t('fileTransferBrowse', '选择文件')) + '</button>' +
                '<button type="button" class="btn btn-sm btn-secondary" id="filetransfer-paste-btn">' + escapeHtml(t('fileTransferPasteBtn', '粘贴剪贴板')) + '</button>' +
              '</div>' +
            '</div>' +
            '<div id="filetransfer-file-list" class="filetransfer-file-list"></div>' +
          '</div>' +
          '<div class="filetransfer-panel-footer">' +
            '<span id="filetransfer-summary" class="filetransfer-summary-text">' + escapeHtml(t('fileTransferSummaryLabel', ['0', '0 B'], '文件统计: 0 文件 / 0 B')) + '</span>' +
            '<button type="button" class="filetransfer-clear-btn" id="filetransfer-clear" disabled>' + escapeHtml(t('fileTransferClearAll', '全部清空')) + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="filetransfer-panel filetransfer-stage-right">' +
          '<div class="filetransfer-panel-header">' +
            '<div class="filetransfer-header-title">' +
              '<span class="filetransfer-stage-num ft-stage-2">2</span>' +
              '<span class="filetransfer-stage-heading">' + escapeHtml(t('fileTransferStage2Title', '打包配置与生成 (Output)')) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="filetransfer-stage-body ft-output-body">' +
            '<div class="filetransfer-info-group">' +
              '<div class="filetransfer-info-item">' +
                '<div class="filetransfer-info-label">' + escapeHtml(t('fileTransferArchiveFormat', '归档格式')) + '</div>' +
                '<div class="filetransfer-info-value"><span class="filetransfer-format-badge">ZIP</span> <span class="filetransfer-info-subtext">' + escapeHtml(t('fileTransferArchiveFormatVal', 'ZIP Deflate 格式 (自动时效命名)')) + '</span></div>' +
              '</div>' +
              '<div class="filetransfer-info-item">' +
                '<div class="filetransfer-info-label">' + escapeHtml(t('fileTransferHostNode', '临时托管节点')) + '</div>' +
                '<div class="filetransfer-info-value"><span class="filetransfer-host-badge">High Availability</span> <span class="filetransfer-info-subtext">' + escapeHtml(t('fileTransferHostNodeVal', '多源高可用中转')) + '</span></div>' +
              '</div>' +
            '</div>' +
            '<div id="filetransfer-progress-wrap" class="filetransfer-progress-wrap" hidden>' +
              '<div class="filetransfer-progress-head"><span>' + escapeHtml(t('fileTransferProgress', '上传进度')) + '</span><span id="filetransfer-progress-label">0%</span></div>' +
              '<progress id="filetransfer-progress" max="100" value="0"></progress>' +
            '</div>' +
            '<div id="filetransfer-status" class="filetransfer-status"></div>' +
            '<div id="filetransfer-result" class="filetransfer-result"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
  var saveButton = document.getElementById('settings-modal-save');
  if (saveButton) {
    saveButton.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>' +
      '<span>' + escapeHtml(t('fileTransferConfirm', '打包并生成临时分享链接')) + '</span>';
    saveButton.disabled = true;
    saveButton.onclick = function() { withLoading(this, fileTransferUpload); };
  }
  var zone = document.getElementById('filetransfer-drop-zone');
  var input = document.getElementById('filetransfer-input');
  var browse = document.getElementById('filetransfer-browse');
  var pasteBtn = document.getElementById('filetransfer-paste-btn');
  var clearButton = document.getElementById('filetransfer-clear');
  if (!zone || !input || !browse) return;
  zone.addEventListener('dragover', fileTransferDragOver);
  zone.addEventListener('dragleave', fileTransferDragLeave);
  zone.addEventListener('drop', fileTransferDrop);
  zone.addEventListener('click', function(e) {
    if (e.target !== browse && !e.target.closest('#filetransfer-browse') && !e.target.closest('#filetransfer-paste-btn') && !e.target.closest('#filetransfer-clear')) {
      input.click();
    }
  });
  browse.onclick = function(e) { e.stopPropagation(); input.click(); };
  if (pasteBtn) {
    pasteBtn.onclick = function(e) {
      e.stopPropagation();
      fileTransferPaste(null);
    };
  }
  if (clearButton) clearButton.onclick = function(e) { e.stopPropagation(); fileTransferClear(); };
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
  fileTransferRenderList();
}
