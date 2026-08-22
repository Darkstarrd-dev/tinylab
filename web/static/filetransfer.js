// FileTransfer: collect arbitrary files, confirm, optionally ZIP, and
// upload through the backend's ordered temporary-host fallback.
// Dual-Panel Staging Workflow layout, matching TinyRouter design system.
'use strict';

// Mirror of internal/filetransfer/upload.go limits; keep in sync.
// (maxFileSize / maxTotalInputSize / maxFiles)
var FT_LIMITS = {
  fileMax: 500 * 1024 * 1024,
  totalMax: 600 * 1024 * 1024,
  countMax: 2000
};

var fileTransferState = {
  items: [],
  busy: false,
  pasteHandler: null,
  dragGuard: null,
  root: null,
  actionButton: null,
  boundRoot: null,
  xhr: null,
  packageZip: true,
  dragDepth: 0
};

function fileTransferElement(id) {
  var root = fileTransferState.root;
  if (root && root.querySelector) {
    var scoped = root.querySelector('#' + id);
    if (scoped) return scoped;
  }
  return document.getElementById(id);
}

function fileTransferToast(message) {
  if (typeof showToast === 'function') showToast(message);
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
      label: t('fileTransferFileType_document', null, '文档'),
      colorClass: 'ft-icon-pdf',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>'
    };
  }
  if (['.json', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.go', '.py', '.rs', '.c', '.cpp', '.h', '.java', '.yaml', '.yml', '.toml', '.sh', '.bat', '.ps1', '.sql'].indexOf(ext) !== -1) {
    return {
      type: 'code',
      label: t('fileTransferFileType_code', null, '代码/配置'),
      colorClass: 'ft-icon-code',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'
    };
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.avif'].indexOf(ext) !== -1) {
    return {
      type: 'image',
      label: t('fileTransferFileType_image', null, '图片'),
      colorClass: 'ft-icon-image',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>'
    };
  }
  if (['.mp4', '.mkv', '.webm', '.avi', '.mov', '.flv', '.wmv'].indexOf(ext) !== -1) {
    return {
      type: 'video',
      label: t('fileTransferFileType_video', null, '视频'),
      colorClass: 'ft-icon-video',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>'
    };
  }
  if (['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma'].indexOf(ext) !== -1) {
    return {
      type: 'audio',
      label: t('fileTransferFileType_audio', null, '音频'),
      colorClass: 'ft-icon-audio',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
    };
  }
  if (['.zip', '.tar', '.gz', '.7z', '.rar', '.bz2', '.xz', '.tgz'].indexOf(ext) !== -1) {
    return {
      type: 'archive',
      label: t('fileTransferFileType_archive', null, '压缩包'),
      colorClass: 'ft-icon-archive',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>'
    };
  }
  if (['.xlsx', '.xls', '.csv', '.tsv'].indexOf(ext) !== -1) {
    return {
      type: 'spreadsheet',
      label: t('fileTransferFileType_spreadsheet', null, '表格'),
      colorClass: 'ft-icon-spreadsheet',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>'
    };
  }
  if (['.txt', '.md', '.doc', '.docx', '.rtf', '.log'].indexOf(ext) !== -1) {
    return {
      type: 'document',
      label: t('fileTransferFileType_document', null, '文档'),
      colorClass: 'ft-icon-doc',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
    };
  }
  return {
    type: 'file',
    label: t('fileTransferFileType_file', null, '文件'),
    colorClass: 'ft-icon-file',
    svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>'
  };
}

function fileTransferRenderList() {
  var list = fileTransferElement('filetransfer-file-list');
  var summary = fileTransferElement('filetransfer-summary');
  var stageCount = fileTransferElement('filetransfer-stage-count');
  var clearBtn = fileTransferElement('filetransfer-clear');
  var actionBtn = fileTransferState.actionButton || fileTransferElement('filetransfer-action');
  var zone = fileTransferElement('filetransfer-drop-zone');

  var count = fileTransferState.items.length;
  var total = 0;
  for (var i = 0; i < count; i++) {
    total += Number(fileTransferState.items[i].size) || 0;
  }
  var formattedTotal = fileTransferFormatSize(total);

  if (stageCount) {
    stageCount.textContent = t('fileTransferStage1Count', [String(count)], '已加入 {0} 项文件');
  }

  if (summary) {
    summary.textContent = t('fileTransferSummaryLabel', [String(count), formattedTotal], '文件统计: {0} 文件 / {1}');
  }

  if (clearBtn) {
    clearBtn.disabled = (count === 0 || fileTransferState.busy);
  }

  // B4 fix: never leave the action button hidden after a completed upload —
  // only busy state and empty list disable it.
  if (actionBtn && !fileTransferState.busy) {
    actionBtn.style.display = '';
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
        '<div class="filetransfer-empty-text">' + escapeHtml(t('fileTransferNoFiles', null, '暂未选择文件，请从上方拖入或浏览选择。')) + '</div>' +
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
      '<button type="button" class="filetransfer-item-remove-btn filetransfer-remove" data-index="' + index + '" aria-label="' + escapeHtml(t('fileTransferRemove', null, '移除文件')) + '" title="' + escapeHtml(t('fileTransferRemove', null, '移除文件')) + '">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' +
      '</button>' +
    '</div>';
  }).join('');
}

// Batched add with client-side preflight validation mirroring the server
// limits (single-file size, staged count, combined size). One render per batch.
function fileTransferAddMany(items) {
  var added = [];
  var total = 0;
  for (var i = 0; i < fileTransferState.items.length; i++) {
    total += Number(fileTransferState.items[i].size) || 0;
  }
  for (var j = 0; j < items.length; j++) {
    var item = items[j];
    if (!item || !item.name) continue;
    if (fileTransferState.items.length + added.length >= FT_LIMITS.countMax) {
      fileTransferToast(t('fileTransferTooManyFiles', [String(FT_LIMITS.countMax)], '最多可加入 {0} 项文件'));
      break;
    }
    var size = Number(item.size) || 0;
    // Grant sizes for directories are unreliable until path-info refreshes
    // them; skip the single-file check for grants, the server re-verifies.
    if (!item.grantId && size > FT_LIMITS.fileMax) {
      fileTransferToast(t('fileTransferTooLargeFile', [item.name, fileTransferFormatSize(FT_LIMITS.fileMax)], '"{0}" 超过单文件上限 {1}'));
      continue;
    }
    if (total + size > FT_LIMITS.totalMax) {
      fileTransferToast(t('fileTransferTooLargeTotal', [fileTransferFormatSize(FT_LIMITS.totalMax)], '总大小超过 {0} 上限'));
      break;
    }
    total += size;
    added.push(item);
  }
  if (added.length) {
    for (var k = 0; k < added.length; k++) fileTransferState.items.push(added[k]);
    fileTransferRenderList();
  }
  return added.length;
}

function fileTransferAddItem(item) {
  fileTransferAddMany([item]);
}

function fileTransferAddPlainFiles(files) {
  var collected = [];
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (file && file.name) {
      collected.push({ name: file.name, size: file.size || 0, file: file });
    }
  }
  fileTransferAddMany(collected);
}

async function fileTransferAddHandles(entries) {
  var collected = [];
  var pending = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!entry) continue;
    if (entry.file) {
      collected.push({ name: entry.file.name, size: entry.file.size || 0, file: entry.file });
      continue;
    }
    if (!entry.handle) continue;
    var handle = entry.handle;
    if (handle.kind === 'directory') {
      await FsApi.walkDir(handle, function(fileHandle, relativePath) {
        pending.push(fileHandle.getFile().then(function(file) {
          collected.push({ name: relativePath, size: file.size, file: file });
        }));
      });
    } else if (handle.kind === 'file') {
      var file = await handle.getFile();
      collected.push({ name: file.name, size: file.size, file: file });
    }
  }
  if (pending.length) await Promise.all(pending);
  fileTransferAddMany(collected);
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

// B2 fix: while the FileTransfer view is active the document-level paste
// handler must not hijack text pastes into editable elements.
function fileTransferPasteTargetEditable(e) {
  if (!e || !e.target || typeof e.target.closest !== 'function') return false;
  return !!e.target.closest('input,textarea,select,[contenteditable="true"]');
}

async function fileTransferRefreshGrantSizes() {
  var ids = [];
  for (var i = 0; i < fileTransferState.items.length; i++) {
    if (fileTransferState.items[i].grantId) ids.push(fileTransferState.items[i].grantId);
  }
  if (!ids.length) return true;
  try {
    var resp = await fetch('/api/filetransfer/path-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pathGrantIds: ids })
    });
    if (resp.status === 403 || resp.status === 410) return false;
    if (!resp.ok) return true;
    var data = await resp.json();
    if (data.paths && data.paths.length === ids.length) {
      var byId = {};
      for (var g = 0; g < ids.length; g++) byId[ids[g]] = data.paths[g];
      for (var k = 0; k < fileTransferState.items.length; k++) {
        var item = fileTransferState.items[k];
        if (item.grantId && byId[item.grantId]) {
          item.name = byId[item.grantId].name || item.name;
          item.size = Number(byId[item.grantId].size) || 0;
        }
      }
      fileTransferRenderList();
    }
    return true;
  } catch (err) {
    console.warn('FileTransfer path-info refresh failed:', err);
    return true; // non-fatal: the server re-validates at upload time
  }
}

async function fileTransferPaste(e) {
  if (fileTransferState.busy) return;

  // Fast path first: the event itself carries in-memory clipboard content
  // (screenshots, copied blobs). No server round-trip needed.
  if (e && e.clipboardData && e.clipboardData.items && e.clipboardData.items.length) {
    var hasFile = false;
    for (var k = 0; k < e.clipboardData.items.length; k++) {
      if (e.clipboardData.items[k].kind === 'file') { hasFile = true; break; }
    }
    if (hasFile) {
      e.preventDefault();
      await fileTransferCollectDataTransfer(e.clipboardData);
      return;
    }
  }
  if (e) e.preventDefault();

  // Path capability contract (audit F-01/B-2): the server reads the OS
  // clipboard and registers short-TTL export grants; the browser only ever
  // holds pathGrantIds, never local paths.
  try {
    var pathResponse = await fetch('/api/filetransfer/paste', { method: 'POST' });
    if (pathResponse.ok) {
      var pathData = await pathResponse.json();
      if (pathData.grants && pathData.grants.length) {
        var collected = [];
        for (var i = 0; i < pathData.grants.length; i++) {
          var g = pathData.grants[i];
          collected.push({ name: g.name || 'unnamed', size: Number(g.size) || 0, grantId: g.pathGrantId });
        }
        fileTransferAddMany(collected);
        // Directory grant entries report a meaningless Lstat size; refresh
        // via path-info so the staging summary shows real recursive totals.
        await fileTransferRefreshGrantSizes();
        fileTransferToast(t('fileTransferAddedFromClipboard', [String(pathData.grants.length)], '已从剪贴板添加 {0} 项'));
        return;
      }
    }
  } catch (err) {
    console.warn('FileTransfer clipboard grants failed:', err);
  }

  // Manual "Paste Clipboard" button fallback: read the async clipboard API.
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
          fileTransferToast(t('fileTransferAddedFromClipboard', [String(filesFound.length)], '已从剪贴板添加 {0} 项'));
          return;
        }
      }
    } catch (clipErr) {
      console.warn('navigator.clipboard.read error:', clipErr);
    }

    fileTransferToast(t('fileTransferNoClipboardFiles', null, '剪贴板中未检测到文件（请复制文件后重试或按 Ctrl+V）'));
  }
}

function fileTransferDragOver(e) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}

// Counter-based enter/leave so crossing child elements cannot flicker.
function fileTransferDragEnter() {
  fileTransferState.dragDepth++;
  var zone = fileTransferElement('filetransfer-drop-zone');
  if (zone) zone.classList.add('drag-active');
}

function fileTransferDragLeave() {
  fileTransferState.dragDepth = Math.max(0, fileTransferState.dragDepth - 1);
  if (fileTransferState.dragDepth === 0) {
    var zone = fileTransferElement('filetransfer-drop-zone');
    if (zone) zone.classList.remove('drag-active');
  }
}

async function fileTransferDrop(e) {
  e.preventDefault();
  fileTransferState.dragDepth = 0;
  var zone = fileTransferElement('filetransfer-drop-zone');
  if (zone) zone.classList.remove('drag-active');
  if (fileTransferState.busy) {
    fileTransferToast(t('fileTransferBusy', null, '已有上传任务进行中。'));
    return;
  }
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
    bar.setAttribute('value', '0');
    bar.value = 0;
    label.textContent = '0%';
    return;
  }
  bar.removeAttribute('value'); // determinate again before setting a value
  var value = Math.max(0, Math.min(100, Number(percent) || 0));
  wrap.hidden = false;
  bar.value = value;
  bar.setAttribute('value', String(value));
  label.textContent = value.toFixed(0) + '%';
}

// Progress semantics: the determinate phase covers browser → local server
// transfer only; once bytes are handed off, packaging + remote publishing is
// genuinely indeterminate, so show that instead of a lying 100%.
function fileTransferSetIndeterminate(on) {
  var bar = fileTransferElement('filetransfer-progress');
  var label = fileTransferElement('filetransfer-progress-label');
  var cancelBtn = fileTransferElement('filetransfer-cancel-upload');
  if (!bar || !label) return;
  if (on) {
    bar.removeAttribute('value');
    label.textContent = t('fileTransferPhaseRemote', null, '打包并发布中…');
  } else if (cancelBtn) {
    cancelBtn.hidden = true;
  }
  if (cancelBtn) cancelBtn.hidden = !on;
}

function fileTransferCancelUpload() {
  if (fileTransferState.xhr) fileTransferState.xhr.abort();
}

function fileTransferBuildFormData() {
  var form = new FormData();
  form.append('package', fileTransferState.packageZip ? 'zip' : 'raw');
  var grantIds = [];
  for (var i = 0; i < fileTransferState.items.length; i++) {
    var item = fileTransferState.items[i];
    if (item.grantId) grantIds.push(item.grantId);
    else if (item.file) form.append('files', item.file, item.name || item.file.name || 'file');
    else throw new Error(t('fileTransferReadFailed', null, '无法读取暂存文件'));
  }
  if (grantIds.length) form.append('grantIds', JSON.stringify(grantIds));
  return form;
}

function fileTransferUpdatePackageHint() {
  var hint = fileTransferElement('filetransfer-package-hint');
  if (hint) {
    hint.textContent = fileTransferState.packageZip
      ? t('fileTransferPackageZipHint', null, '所有暂存文件将压缩为一个 ZIP 并生成单条分享链接')
      : t('fileTransferPackageRawHint', null, '不打包：每个文件单独上传并生成独立链接');
  }
}

function fileTransferResetView() {
  fileTransferState.items = [];
  fileTransferSetStatus('', false);
  fileTransferSetProgress(0, false);
  var result = fileTransferElement('filetransfer-result');
  if (result) result.innerHTML = '';
  var saveButton = fileTransferState.actionButton || fileTransferElement('filetransfer-action');
  if (saveButton) {
    saveButton.style.display = '';
    saveButton.disabled = true;
  }
  var clearButton = fileTransferElement('filetransfer-clear');
  if (clearButton) clearButton.disabled = true;
  fileTransferRenderList();
}

function fileTransferClear() {
  if (fileTransferState.busy) return;
  fileTransferResetView();
}

function fileTransferResultRowHTML(entry) {
  var url = escapeHtml(entry.url);
  return '<div class="filetransfer-result-row">' +
    '<div class="filetransfer-result-row-name">' + escapeHtml(entry.name || '') + '</div>' +
    '<div class="filetransfer-link-box">' +
      '<input type="text" class="filetransfer-link-input" value="' + url + '" readonly tabindex="-1">' +
    '</div>' +
    '<div class="filetransfer-success-actions">' +
      '<button type="button" class="btn btn-sm btn-primary filetransfer-copy-btn">' +
        '<span>' + escapeHtml(t('fileTransferCopyLink', null, '复制链接')) + '</span>' +
      '</button>' +
      '<a class="btn btn-sm btn-secondary filetransfer-open-btn" href="' + url + '" target="_blank" rel="noopener noreferrer">' +
        '<span>' + escapeHtml(t('fileTransferOpenLink', null, '打开链接')) + '</span>' +
      '</a>' +
    '</div>' +
  '</div>';
}

function fileTransferBindCopyButtons(container, resolveUrl) {
  var buttons = container.querySelectorAll('.filetransfer-copy-btn');
  for (var i = 0; i < buttons.length; i++) {
    (function(btn) {
      btn.onclick = function() {
        var url = resolveUrl(btn);
        var input = btn.closest('.filetransfer-result-row').querySelector('.filetransfer-link-input');
        if (input) input.select();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url);
        } else {
          document.execCommand('copy');
        }
        var span = btn.querySelector('span');
        if (span) span.textContent = t('fileTransferCopied', null, '已复制！');
        fileTransferToast(t('fileTransferCopied', null, '已复制到剪贴板！'));
        setTimeout(function() {
          if (span) span.textContent = t('fileTransferCopyLink', null, '复制链接');
        }, 2000);
      };
    })(buttons[i]);
  }
}

async function fileTransferUpload() {
  if (fileTransferState.busy) return;
  if (!fileTransferState.items.length) {
    fileTransferSetStatus(t('fileTransferNoFiles', null, '暂未选择文件'), true);
    return;
  }
  fileTransferState.busy = true;
  var saveButton = fileTransferState.actionButton || fileTransferElement('filetransfer-action');
  var clearButton = fileTransferElement('filetransfer-clear');
  if (saveButton) saveButton.disabled = true;
  if (clearButton) clearButton.disabled = true;
  fileTransferSetStatus(t('fileTransferPacking', null, '正在处理…'), false);
  fileTransferSetProgress(0, true);
  try {
    // Grant preflight: expired clipboard grants fail fast with an actionable
    // message instead of a mid-upload denial from the server.
    var hasGrants = false;
    for (var gi = 0; gi < fileTransferState.items.length; gi++) {
      if (fileTransferState.items[gi].grantId) { hasGrants = true; break; }
    }
    if (hasGrants) {
      var fresh = await fileTransferRefreshGrantSizes();
      if (!fresh) throw new Error(t('fileTransferGrantExpired', null, '本地暂存项已过期，请重新粘贴。'));
    }

    var data = await new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      fileTransferState.xhr = xhr;
      xhr.open('POST', '/api/filetransfer/upload');
      xhr.responseType = 'text';
      xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) fileTransferSetProgress((e.loaded / e.total) * 100, true);
      };
      // Bytes fully handed to the local server: packaging + remote publish
      // is now running server-side with no observable progress.
      xhr.upload.onload = function() {
        fileTransferSetIndeterminate(true);
      };
      xhr.onerror = function() { reject(new Error(t('fileTransferNetworkFailed'))); };
      xhr.onabort = function() {
        var err = new Error(t('fileTransferCancelled', null, '已取消上传。'));
        err.isCancel = true;
        reject(err);
      };
      xhr.onload = function() {
        var response = {};
        try { response = JSON.parse(xhr.responseText || '{}'); } catch (err) { /* keep empty response */ }
        if (xhr.status < 200 || xhr.status >= 300) {
          var message;
          if (xhr.status === 413) {
            message = t('fileTransferTooLargeTotal', [fileTransferFormatSize(FT_LIMITS.totalMax)], '总大小超过 {0} 上限');
          } else if (response.results) {
            // Raw mode with every file failed still answers 502 + results.
            message = response.error || ('HTTP ' + xhr.status);
          } else {
            message = response.error || ('HTTP ' + xhr.status);
            var details = response.failures && response.failures.length ? ' ' + response.failures.join('; ') : '';
            message += details;
          }
          reject(new Error(message));
          return;
        }
        if ((response.url || (response.results && response.results.some(function(r) { return r.url; })))) {
          resolve(response);
          return;
        }
        reject(new Error(response.error || 'empty download URL'));
      };
      try {
        xhr.send(fileTransferBuildFormData());
      } catch (err) {
        reject(err);
      }
    });

    fileTransferSetIndeterminate(false);
    fileTransferSetProgress(100, true);

    var result = fileTransferElement('filetransfer-result');
    if (result) {
      if (data.results) {
        // Raw mode: one row per file, failures inline.
        var okCount = 0;
        var rows = data.results.map(function(r) {
          if (r.url) { okCount++; return fileTransferResultRowHTML(r); }
          return '<div class="filetransfer-result-row filetransfer-result-row-error">' +
            '<div class="filetransfer-result-row-name">' + escapeHtml(r.name || '') + '</div>' +
            '<div class="filetransfer-status error">' + escapeHtml(r.error || 'upload failed') + '</div>' +
          '</div>';
        });
        result.innerHTML =
          '<div class="filetransfer-success-card">' +
            '<div class="filetransfer-success-header">' +
              '<div class="filetransfer-success-title-box">' +
                '<div class="filetransfer-success-title">' + escapeHtml(t('fileTransferUploadCompleted', null, '打包上传完成！')) + '</div>' +
                '<div class="filetransfer-success-sub">' +
                  (okCount === data.results.length
                    ? escapeHtml(t('fileTransferRawAllOk', [String(okCount)], '{0} 个文件均已生成独立链接'))
                    : escapeHtml(t('fileTransferRawPartialFail', [String(okCount), String(data.results.length)], '{1} 个文件中 {0 个成功'))) +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="filetransfer-result-list">' + rows.join('') + '</div>' +
            '<div class="filetransfer-success-actions">' +
              '<button type="button" class="btn btn-sm btn-ghost filetransfer-new-btn">' +
                '<span>' + escapeHtml(t('fileTransferNewTransfer', null, '继续传输')) + '</span>' +
              '</button>' +
            '</div>' +
          '</div>';
        fileTransferBindCopyButtons(result, function(btn) {
          var input = btn.closest('.filetransfer-result-row').querySelector('.filetransfer-link-input');
          return input ? input.value : '';
        });
      } else {
        var url = escapeHtml(data.url);
        var serviceName = escapeHtml(data.service || 'tmpfiles');
        var retentionText = data.retention || t('fileTransferRetentionUnknown', null, '未知');
        result.innerHTML =
          '<div class="filetransfer-success-card">' +
            '<div class="filetransfer-success-header">' +
              '<div class="filetransfer-success-icon">' +
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' +
              '</div>' +
              '<div class="filetransfer-success-title-box">' +
                '<div class="filetransfer-success-title">' + escapeHtml(t('fileTransferUploadCompleted', null, '打包上传完成！')) + '</div>' +
                '<div class="filetransfer-success-sub">' + escapeHtml(t('fileTransferSuccess', [serviceName], '已通过 {0} 托管')) + '</div>' +
                '<div class="filetransfer-success-sub">' + escapeHtml(t('fileTransferRetention', [retentionText], '保留时限：{0}')) + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="filetransfer-link-box">' +
              '<input type="text" class="filetransfer-link-input" value="' + url + '" readonly id="filetransfer-url-input">' +
            '</div>' +
            '<div class="filetransfer-success-actions">' +
              '<button type="button" class="btn btn-sm btn-primary filetransfer-copy-btn" id="filetransfer-copy-btn">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
                '<span>' + escapeHtml(t('fileTransferCopyLink', null, '复制链接')) + '</span>' +
              '</button>' +
              '<a class="btn btn-sm btn-secondary filetransfer-open-btn" href="' + url + '" target="_blank" rel="noopener noreferrer">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
                '<span>' + escapeHtml(t('fileTransferOpenLink', null, '打开链接')) + '</span>' +
              '</a>' +
              '<button type="button" class="btn btn-sm btn-ghost filetransfer-new-btn" id="filetransfer-new-btn">' +
                '<span>' + escapeHtml(t('fileTransferNewTransfer', null, '继续传输')) + '</span>' +
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
            if (span) span.textContent = t('fileTransferCopied', null, '已复制！');
            fileTransferToast(t('fileTransferCopied', null, '已复制到剪贴板！'));
            setTimeout(function() {
              if (span) span.textContent = t('fileTransferCopyLink', null, '复制链接');
            }, 2000);
          };
        }
      }
      var newBtn = result.querySelector('#filetransfer-new-btn');
      if (newBtn) {
        newBtn.onclick = function() {
          fileTransferResetView();
        };
      }
    }
    fileTransferSetStatus('', false);
  } catch (err) {
    fileTransferSetProgress(0, false);
    fileTransferSetStatus(err.message || String(err), !err.isCancel);
  } finally {
    fileTransferState.xhr = null;
    fileTransferState.busy = false;
    if (saveButton) {
      saveButton.style.display = '';
      saveButton.disabled = (fileTransferState.items.length === 0);
    }
    if (clearButton) clearButton.disabled = (fileTransferState.items.length === 0);
    fileTransferRenderList();
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

function fileTransferBind(root, actionButton) {
  if (!root) return;
  fileTransferState.root = root;
  fileTransferState.actionButton = actionButton || null;
  var zone = fileTransferElement('filetransfer-drop-zone');
  var input = fileTransferElement('filetransfer-input');
  var browse = fileTransferElement('filetransfer-browse');
  var pasteBtn = fileTransferElement('filetransfer-paste-btn');
  var clearButton = fileTransferElement('filetransfer-clear');
  var packageToggle = fileTransferElement('filetransfer-package-zip');
  var cancelUploadBtn = fileTransferElement('filetransfer-cancel-upload');
  if (!zone || !input || !browse) return;
  if (fileTransferState.boundRoot !== root) {
    zone.addEventListener('dragenter', fileTransferDragEnter);
    zone.addEventListener('dragover', fileTransferDragOver);
    zone.addEventListener('dragleave', fileTransferDragLeave);
    zone.addEventListener('drop', fileTransferDrop);
    zone.addEventListener('click', function(e) {
      if (e.target !== browse && !e.target.closest('#filetransfer-browse') && !e.target.closest('#filetransfer-paste-btn') && !e.target.closest('#filetransfer-clear')) {
        input.click();
      }
    });
    // Keyboard accessibility: the focused dropzone opens the picker on
    // Enter/Space (inner buttons handle their own activation).
    zone.addEventListener('keydown', function(e) {
      if (e.target === zone && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
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
    if (packageToggle) {
      packageToggle.onchange = function() {
        fileTransferState.packageZip = packageToggle.checked;
        fileTransferUpdatePackageHint();
      };
    }
    if (cancelUploadBtn) {
      cancelUploadBtn.onclick = function(e) {
        e.stopPropagation();
        fileTransferCancelUpload();
      };
    }
    input.onchange = function() {
      if (fileTransferState.busy) {
        fileTransferToast(t('fileTransferBusy', null, '已有上传任务进行中。'));
        return;
      }
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
    if (!fileTransferElement('filetransfer-drop-zone')) return;
    if (fileTransferPasteTargetEditable(e)) return;
    fileTransferPaste(e);
  };
  document.addEventListener('paste', fileTransferState.pasteHandler);
  fileTransferInstallDragGuard();
  requestAnimationFrame(function() { zone.focus(); });
  fileTransferUpdatePackageHint();
  fileTransferRenderList();
}

function cleanupFileTransferModal() {
  fileTransferRemoveGlobalListeners();
  if (fileTransferState.xhr) {
    fileTransferState.xhr.abort();
    fileTransferState.xhr = null;
  }
  fileTransferState.items = [];
  fileTransferState.busy = false;
  fileTransferState.root = null;
  fileTransferState.actionButton = null;
  fileTransferState.boundRoot = null;
}

function suspendFileTransfer() {
  fileTransferRemoveGlobalListeners();
}

function resumeFileTransfer() {
  var root = fileTransferState.root;
  if (!root) return;
  fileTransferState.pasteHandler = function(e) {
    if (!fileTransferElement('filetransfer-drop-zone')) return;
    if (fileTransferPasteTargetEditable(e)) return;
    fileTransferPaste(e);
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
              '<span>' + escapeHtml(t('fileTransferPipelineTitle', null, '临时传输流水线')) + '</span>' +
              '<span class="filetransfer-badge-tag">2-Stage Workflow</span>' +
            '</h2>' +
            '<p class="filetransfer-subtitle">' + escapeHtml(t('fileTransferPipelineSubtitle', null, '左侧管理筹备文件，右侧控制 ZIP 打包与临时外传')) + '</p>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="filetransfer-grid">' +
        '<!-- Stage 1 Panel: Staging Zone -->' +
        '<div class="filetransfer-panel filetransfer-stage-left">' +
          '<div class="filetransfer-panel-header">' +
            '<div class="filetransfer-header-title">' +
              '<span class="filetransfer-stage-num">1</span>' +
              '<span class="filetransfer-stage-heading">' + escapeHtml(t('fileTransferStage1Title', null, '筹备待上传文件 (Staging Zone)')) + '</span>' +
            '</div>' +
            '<span id="filetransfer-stage-count" class="filetransfer-stage-count">' + escapeHtml(t('fileTransferStage1Count', ['0'], '已加入 0 项文件')) + '</span>' +
          '</div>' +
          '<div class="filetransfer-stage-body">' +
            '<div id="filetransfer-drop-zone" class="filetransfer-dropzone" tabindex="0" role="button" aria-label="' + escapeHtml(t('fileTransferBrowse', null, '选择文件')) + '">' +
              '<input id="filetransfer-input" type="file" multiple style="display:none">' +
              '<div class="filetransfer-drop-icon">' +
                '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 10v6"/><path d="m9 13 3-3 3 3"/></svg>' +
              '</div>' +
              '<div class="filetransfer-drop-text">' + escapeHtml(t('fileTransferPasteHint', null, '将文件拖放到此区域，或粘贴剪贴板')) + '</div>' +
              '<div class="filetransfer-drop-actions">' +
                '<button type="button" class="btn btn-sm btn-primary" id="filetransfer-browse">' +
                  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
                  '<span>' + escapeHtml(t('fileTransferBrowse', null, '选择文件')) + '</span>' +
                '</button>' +
                '<button type="button" class="btn btn-sm btn-secondary" id="filetransfer-paste-btn">' +
                  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>' +
                  '<span>' + escapeHtml(t('fileTransferPasteBtn', null, '粘贴剪贴板')) + '</span>' +
                '</button>' +
              '</div>' +
            '</div>' +
            '<div id="filetransfer-file-list" class="filetransfer-file-list"></div>' +
          '</div>' +
          '<div class="filetransfer-panel-footer">' +
            '<span id="filetransfer-summary" class="filetransfer-summary-text">' + escapeHtml(t('fileTransferSummaryLabel', ['0', '0 B'], '文件统计: 0 文件 / 0 B')) + '</span>' +
            '<button type="button" class="filetransfer-clear-btn" id="filetransfer-clear" disabled>' +
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
              '<span>' + escapeHtml(t('fileTransferClearAll', null, '全部清空')) + '</span>' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<!-- Stage 2 Panel: Output & Packaging -->' +
        '<div class="filetransfer-panel filetransfer-stage-right">' +
          '<div class="filetransfer-panel-header">' +
            '<div class="filetransfer-header-title">' +
              '<span class="filetransfer-stage-num ft-stage-2">2</span>' +
              '<span class="filetransfer-stage-heading">' + escapeHtml(t('fileTransferStage2Title', null, '打包配置与生成 (Output)')) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="filetransfer-stage-body ft-output-body">' +
            '<div class="filetransfer-info-group">' +
              '<div class="filetransfer-info-item">' +
                '<div class="filetransfer-info-label">' + escapeHtml(t('fileTransferArchiveFormat', null, '归档格式')) + '</div>' +
                '<div class="filetransfer-info-value">' +
                  '<label class="filetransfer-package-row">' +
                    '<input type="checkbox" id="filetransfer-package-zip" checked>' +
                    '<span>' + escapeHtml(t('fileTransferPackageToggle', null, '打包为 ZIP')) + '</span>' +
                  '</label>' +
                  '<span class="filetransfer-info-subtext" id="filetransfer-package-hint"></span>' +
                '</div>' +
              '</div>' +
              '<div class="filetransfer-info-item">' +
                '<div class="filetransfer-info-label">' + escapeHtml(t('fileTransferHostNode', null, '临时托管节点')) + '</div>' +
                '<div class="filetransfer-info-value">' +
                  '<span class="filetransfer-host-badge">High Availability</span>' +
                  '<span class="filetransfer-info-subtext">' + escapeHtml(t('fileTransferHostNodeVal', null, '多源高可用中转 (tfLink / tmpfiles / temp.sh / Filebin 自动故障回退)')) + '</span>' +
                '</div>' +
              '</div>' +
              '<div class="filetransfer-info-hint">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' +
                '<span>' + escapeHtml(t('fileTransferFeatureHint', null, '公共临时外传链接，无需登录即可快速下载。')) + '</span>' +
              '</div>' +
            '</div>' +
            '<div id="filetransfer-progress-wrap" class="filetransfer-progress-wrap" hidden>' +
              '<div class="filetransfer-progress-head">' +
                '<span class="filetransfer-progress-title">' + escapeHtml(t('fileTransferProgress', null, '上传进度')) + '</span>' +
                '<span id="filetransfer-progress-label" class="filetransfer-progress-label">0%</span>' +
              '</div>' +
              '<div class="filetransfer-progress-bar-bg">' +
                '<progress id="filetransfer-progress" max="100" value="0"></progress>' +
              '</div>' +
              '<button type="button" class="btn btn-sm btn-ghost filetransfer-cancel-upload-btn" id="filetransfer-cancel-upload" hidden>' +
                escapeHtml(t('fileTransferCancelUpload', null, '取消')) +
              '</button>' +
            '</div>' +
            '<div id="filetransfer-status" class="filetransfer-status"></div>' +
            '<div id="filetransfer-result" class="filetransfer-result"></div>' +
          '</div>' +
          '<div class="filetransfer-panel-footer ft-action-footer">' +
            '<button type="button" class="btn btn-primary filetransfer-action-btn" id="filetransfer-action" disabled>' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>' +
              '<span>' + escapeHtml(t('fileTransferConfirm', null, '打包并生成临时分享链接')) + '</span>' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  var action = fileTransferElement('filetransfer-action');
  if (action) action.onclick = function() { withLoading(this, fileTransferUpload); };
  fileTransferBind(container, action);
  return container;
}

window.renderUtilityFileTransfer = renderUtilityFileTransfer;
window.suspendFileTransfer = suspendFileTransfer;
window.resumeFileTransfer = resumeFileTransfer;
window.cleanupFileTransfer = cleanupFileTransfer;
