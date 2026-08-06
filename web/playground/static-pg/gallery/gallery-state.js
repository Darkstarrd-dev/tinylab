// gallery-state.js — Gallery state, constants, and helper functions.

'use strict';

// ---------- helpers ----------------------------------------------
var SUPPORTED_IMG_EXTS = ['webp', 'png', 'jpg', 'jpeg', 'bmp', 'tiff', 'tif', 'avif', 'gif'];
// GIF and WebP live in BOTH whitelists: they are images, but the video pane
// plays them as <img> (browser-native animation, no Go transcoding).
// Classification is video-first (isVideoExt wins) so a file never lands in
// both the image and the video list.
var SUPPORTED_VIDEO_EXTS = ['mp4', 'webm', 'ogv', 'gif', 'webp'];
// ANIMATED_IMG_EXTS — extensions rendered as <img> inside the video pane.
// GIF is always treated as animation (single-frame GIF has no side effect);
// WebP is not parsed for VP8X — a static WebP simply shows a single frame
// and an animated WebP auto-plays, so one unified <img> path is correct.
var ANIMATED_IMG_EXTS = ['gif', 'webp'];
var AUTOPLAY_INTERVALS = [1000, 2000, 3000, 5000, 10000, 15000, 30000, 60000, 120000]; // ms
var AUTOPLAY_LABELS = ['1s', '2s', '3s', '5s', '10s', '15s', '30s', '60s', '120s'];
var THUMB_SIZE = 300;

function isVideoExt(name) {
  if (!name) return false;
  var dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  var ext = name.slice(dot + 1).toLowerCase();
  return SUPPORTED_VIDEO_EXTS.indexOf(ext) >= 0;
}

// isAnimatedImg reports whether the item is a browser-animated image (GIF or
// WebP) shown via the video pane's <img id="gallery-main-anim"> element.
function isAnimatedImg(item) {
  var ext = extOf(item && (item.name || item.path));
  return ANIMATED_IMG_EXTS.indexOf(ext) >= 0;
}

function isSupportedExt(name) {
  if (!name) return false;
  var dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  var ext = name.slice(dot + 1).toLowerCase();
  return SUPPORTED_IMG_EXTS.indexOf(ext) >= 0 || SUPPORTED_VIDEO_EXTS.indexOf(ext) >= 0;
}

function isZipName(name) {
  if (!name) return false;
  var lower = name.toLowerCase();
  return lower.endsWith('.zip');
}

// isArchiveName reports whether the name is a browsable archive (.zip/.7z/.rar).
// The /api/archive migration registers any of these as an archive source; 7z
// and RAR require the configured external tools, so the backend may report a
// diagnostic error when they are missing.
function isArchiveName(name) {
  if (!name) return false;
  var lower = name.toLowerCase();
  return lower.endsWith('.zip') || lower.endsWith('.7z') || lower.endsWith('.rar');
}

function extOf(name) {
  if (!name) return '';
  var dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

function isTiff(name) {
  var ext = extOf(name);
  return ext === 'tiff' || ext === 'tif';
}

function prettySize(n) {
  if (!n && n !== 0) return '';
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  var units = ['KB', 'MB', 'GB', 'TB'];
  var i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
}

function formatTime(secs) {
  if (isNaN(secs) || secs < 0) return '00:00';
  var m = Math.floor(secs / 60);
  var s = Math.floor(secs % 60);
  return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function naturalComparePath(pathA, pathB) {
  var segsA = (pathA || '').split('/');
  var segsB = (pathB || '').split('/');
  var minLen = Math.min(segsA.length, segsB.length);

  for (var i = 0; i < minLen; i++) {
    var a = segsA[i];
    var b = segsB[i];
    if (a !== b) {
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    }
  }
  return segsA.length - segsB.length;
}

function sortItems(items) {
  items.sort(function(a, b) {
    return naturalComparePath(a.path, b.path);
  });
}

function showMsg(text, targetPaneId) {
  var isVidActive = (galleryState.viewMode === 'split') ? (galleryState.focus === 'video') : (galleryState.mediaType === 'video');
  var el;
  if (targetPaneId) {
    var pane = document.getElementById(targetPaneId);
    if (pane) el = pane.querySelector('#gallery-toolbar-msg');
  }
  if (!el && isVidActive) {
    var vidPane = document.getElementById('gallery-pane-video');
    if (vidPane) el = vidPane.querySelector('#gallery-toolbar-msg');
  }
  if (!el) el = document.getElementById('gallery-toolbar-msg');
  if (!el) return;

  el.textContent = text || '';
  el.style.display = text ? '' : 'none';
  if (showMsg._timer) clearTimeout(showMsg._timer);
  if (text) {
    showMsg._timer = setTimeout(function() {
      el.textContent = '';
      el.style.display = 'none';
    }, 3000);
  }
}

// ---------- state ------------------------------------------------
var galleryState = {
  items: [],
  index: -1,
  videoItems: [],
  videoIndex: -1,
  videoPlayingState: false,
  viewMode: 'single',
  mediaType: 'image',
  focus: 'image',
  videoURL: null,
  videoCurDirPath: '',
  videoDirMap: {},
  videoDirPathList: [],
  currentVideoFolderIndices: [],
  currentVideoSubIndex: -1,
  autoplayTimer: null,
  autoplayOn: false,
  autoplayInterval: 3000, // ms, default 3rd gear
  mainURL: null,
  fullscreenEl: null,
  keyHandler: null,
  fsChangeHandler: null,
  contextMenuHandler: null,
  pasteHandler: null,
  pageKeyHandler: null,
  zipSessionId: null,
  // zip item fields (constructed in gallery-io.js):
  //   zipFileHandle: FileSystemFileHandle|null — null means the zip cannot
  //   be written back to disk (pasted blob or legacy drop). UI should
  //   degrade delete/overwrite actions accordingly.
  pendingZipQueue: [],
  loadingZip: false,
  _markAdvanceTimer: null, // 300ms delete-mark transition lock
  objectURLs: [],
  thumbObserver: null,
  container: null,
  treeOpen: false,
  curDirPath: '',
  dirMap: {},
  dirPathList: [],
  currentFolderIndices: [],
  currentSubIndex: -1,
  // AI Review 状态
  reviewState: {
    active: false,           // 是否正在审核或已审核完成
    status: null,            // 'running' | 'completed' | 'cancelled' | 'error' | null
    total: 0,                // 总图片数
    processed: 0,            // 已处理数
    failed: 0,               // 审核失败数
    results: [],             // 审核结果 [{index, path, isMatch, reason}]（只含 isMatch=true）
    sessionId: null,         // 当前审核的 sessionId
    // 模型选择（两个独立模型）
    promptModelId: '',       // 提示词生成模型 id (prefix/model)
    reviewModelId: '',        // 视觉审核模型 id (prefix/model)
    // 提示词
    judgeTarget: '',         // 用户填写的审核目标描述（用于生成提示词）
    systemPrompt: '',         // 当前系统提示词（生成后/预设加载后/手动编辑后）
    userPrompt: '',           // 用户消息提示词（可选，空时后端用默认）
    matchField: 'match',     // LLM 返回的 bool 字段名，固定 'match'
    // 预设
    availablePresets: [],    // 从后端加载的预设列表
    selectedPresetId: '',    // 当前选中的预设 id
    // 配置
    strategy: 'all',         // 'all' | 'head-tail'
    headSize: 5,             // 首部审核张数
    tailSize: 5,             // 尾部审核张数
    concurrency: 3,          // 并发数
    // 运行时
    pollTimer: null,         // 轮询定时器
    reviewMode: false,       // 审核完成后的浏览模式（仅显示 matched）
    reviewOpen: false,       // 左侧面板是否展开审核配置
    originalIndices: [],     // 审核前的完整索引列表（用于恢复）
    // 生成中标志
    generatingPrompt: false,  // 正在调用 gen-prompt
    // 节点选择与多节点审核状态
    selectMode: false,        // 是否处于节点选择模式（点击 AI Review 后）
    selectedNodes: [],        // 选中的节点 dir key 列表
    lastSelectedNode: null,   // 最后一次单击选中的节点 key（用于 Shift 范围选择）
    reviewQueue: [],          // 待审核节点队列 [{dir, sessionId, entryIndices, itemIndices}]
    reviewQueueIndex: -1,     // 当前审核到第几个节点
    currentReviewNode: null,  // 当前正在审核的节点 dir key
    nodeResults: {},          // dir -> [{index, path, isMatch, reason}] 每节点审核结果
    nodeStatus: {},           // dir -> 'pending'|'running'|'completed'|'error'
    reviewedNodes: [],        // 已审核/审核中且有匹配结果的节点 dir 列表（有序）
    focusedReviewNode: '',    // 当前 focus 的审核节点 dir
    allReviewMatchIndices: [] // 跨所有已审核节点的匹配 item indices（有序）
  }
};

var GALLERY_ICONS = {
  tree: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.5" fill="currentColor"/><circle cx="4.5" cy="12" r="1.5" fill="currentColor"/><circle cx="4.5" cy="18" r="1.5" fill="currentColor"/></svg>',
  prevFolder: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/></svg>',
  prev: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  play: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  pause: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
  stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  next: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  nextFolder: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></svg>',
  volume: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
  single: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
  dual: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="18" rx="1"/><rect x="13" y="3" width="8" height="18" rx="1"/></svg>',
  picture: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  video: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
  fullscreen: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
  edit: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>'
};

function trackURL(url) {
  if (url) galleryState.objectURLs.push(url);
  return url;
}

function clearObjectURLs() {
  if (galleryState.objectURLs && galleryState.objectURLs.length) {
    for (var i = 0; i < galleryState.objectURLs.length; i++) {
      var url = galleryState.objectURLs[i];
      if (url) FsApi.BlobTracker.revoke(url);
    }
    galleryState.objectURLs.length = 0;
  }
  // Revoke and null out all item-level blob URLs to prevent stale references
  var allItems = (galleryState.items || []).concat(galleryState.videoItems || []);
  for (var i = 0; i < allItems.length; i++) {
    var item = allItems[i];
    if (item) {
      if (item.mainURL && item.mainURL.indexOf('blob:') === 0) {
        FsApi.BlobTracker.revoke(item.mainURL);
      }
      item.mainURL = null;
      if (item.thumbURL && item.thumbURL.indexOf('blob:') === 0) {
        FsApi.BlobTracker.revoke(item.thumbURL);
      }
      item.thumbURL = null;
    }
  }
  galleryState.mainURL = null;
}

function setMainURL(item, url) {
  if (item.mainURL && item.mainURL.startsWith('blob:')) {
    FsApi.BlobTracker.revoke(item.mainURL);
  }
  item.mainURL = url;
}

function setThumbURL(item, url) {
  if (item.thumbURL && item.thumbURL.startsWith('blob:')) {
    FsApi.BlobTracker.revoke(item.thumbURL);
  }
  item.thumbURL = url;
}