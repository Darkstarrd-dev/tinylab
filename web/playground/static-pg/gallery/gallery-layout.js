// gallery-layout.js — Gallery rendering and layout management.

'use strict';

// ---------- render ----------------------------------------------
function renderInitial(container) {
  galleryState.container = container;
  container.classList.add('gallery-page');
  updateLayoutMode();

  // hidden fallback input
  var input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,video/*,.zip';
  input.style.display = 'none';
  input.id = 'gallery-file-input';
  input.addEventListener('change', function(e) {
    var files = e.target.files;
    if (files && files.length) {
      processFiles(Array.prototype.slice.call(files));
    }
    input.value = '';
  });
  container.appendChild(input);

  galleryState.pasteHandler = onPaste;
  document.addEventListener('paste', galleryState.pasteHandler);

  if (!galleryState.pageKeyHandler) {
    galleryState.pageKeyHandler = onGalleryKeyDown;
    document.addEventListener('keydown', galleryState.pageKeyHandler);
  }
}

// ---------- split / media mode & focus handlers ---------------------
function toggleSplitMode() {
  if (galleryState.viewMode === 'split') {
    galleryState.viewMode = 'single';
    galleryState.mediaType = galleryState.focus; // Inherit focus side mode on exit!
  } else {
    galleryState.viewMode = 'split';
  }
  updateLayoutMode();
  flashFocusOverlay(galleryState.focus);
}

function toggleMediaType() {
  galleryState.mediaType = (galleryState.mediaType === 'image') ? 'video' : 'image';
  if (galleryState.viewMode === 'split') {
    galleryState.focus = galleryState.mediaType;
  }
  updateLayoutMode();
  flashFocusOverlay(galleryState.focus);
}

function flashFocusOverlay(targetFocus) {
  // Focus indicator handled by CSS border and fullscreen left accent border line
}

function autoBalanceFullscreenSplitRatio() {
  var paneImg = document.getElementById('gallery-pane-image');
  var paneVid = document.getElementById('gallery-pane-video');
  if (!paneImg || !paneVid) return;

  if (!isFullscreen() || galleryState.viewMode !== 'split') {
    paneImg.style.flex = '1 1 50%';
    paneVid.style.flex = '1 1 50%';
    return;
  }

  var imgEl = document.getElementById('gallery-main-img');
  var vidEl = document.getElementById('gallery-main-video');
  var animEl = document.getElementById('gallery-main-anim');

  var rImg = (imgEl && imgEl.naturalWidth && imgEl.naturalHeight)
    ? (imgEl.naturalWidth / imgEl.naturalHeight) : 1.0;
  var rVid = 1.0;
  // Measure the ACTIVE video-pane media: an animated image reports its
  // natural size, a real video its intrinsic video size. The img and video
  // elements coexist, so pick by the current item's mode.
  var vidItem = galleryState.videoItems[galleryState.videoIndex];
  if (vidItem && isAnimatedImg(vidItem)) {
    if (animEl && animEl.naturalWidth && animEl.naturalHeight) {
      rVid = animEl.naturalWidth / animEl.naturalHeight;
    }
  } else if (vidEl && vidEl.videoWidth && vidEl.videoHeight) {
    rVid = vidEl.videoWidth / vidEl.videoHeight;
  }

  var containerW = window.innerWidth || document.documentElement.clientWidth || 1920;
  var containerH = window.innerHeight || document.documentElement.clientHeight || 1080;

  var ratioImg, ratioVid;

  var isImgPortrait = rImg < 1.0;
  var isVidPortrait = rVid < 1.0;

  if (isImgPortrait && !isVidPortrait) {
    // 图片竖向，视频横向/方图：图片优先占满 100vh 高度，算出其所需宽度占比，剩余归视频
    var neededImgW = containerH * rImg;
    ratioImg = neededImgW / containerW;
    ratioImg = Math.max(0.20, Math.min(0.75, ratioImg));
    ratioVid = 1 - ratioImg;
  } else if (!isImgPortrait && isVidPortrait) {
    // 视频竖向，图片横向/方图：视频优先占满 100vh 高度，算出其所需宽度占比，剩余归图片
    var neededVidW = containerH * rVid;
    ratioVid = neededVidW / containerW;
    ratioVid = Math.max(0.20, Math.min(0.75, ratioVid));
    ratioImg = 1 - ratioVid;
  } else if (isImgPortrait && isVidPortrait) {
    // 两侧均为竖向：按各自 Aspect Ratio 的比例分配宽度
    ratioImg = rImg / (rImg + rVid);
    ratioImg = Math.max(0.25, Math.min(0.75, ratioImg));
    ratioVid = 1 - ratioImg;
  } else {
    // 两侧均为横向或 1:1：左右平分各 50%
    ratioImg = 0.5;
    ratioVid = 0.5;
  }

  paneImg.style.flex = (ratioImg * 100) + ' 1 0%';
  paneVid.style.flex = (ratioVid * 100) + ' 1 0%';
}

function buildPanelHTML(type, isSplit) {
  var isVid = (type === 'video');
  var panelId = isVid ? 'gallery-pane-video' : 'gallery-pane-image';
  var focused = (galleryState.viewMode === 'split' && galleryState.focus === type) ? ' focused' : '';
  var showTree = galleryState.treeOpen && ((galleryState.viewMode === 'split' && galleryState.focus === type) || (galleryState.viewMode === 'single'));
  var treeClass = showTree ? '' : ' hidden';

  var splitIcon = (galleryState.viewMode === 'split') ? GALLERY_ICONS.single : GALLERY_ICONS.dual;
  var splitBtnTitle = (galleryState.viewMode === 'split') ? 'Single View (D)' : 'Dual View (D)';

  var modeIcon = (galleryState.mediaType === 'video') ? GALLERY_ICONS.picture : GALLERY_ICONS.video;
  var modeBtnTitle = (galleryState.mediaType === 'video') ? 'Picture Mode (M)' : 'Video Mode (M)';

  // Mode button is hidden in split mode!
  var modeBtnHTML = isSplit ? '' : '<button class="gallery-btn gallery-btn-icon" id="gallery-mode-btn" type="button" data-tooltip="' + modeBtnTitle + '">' + modeIcon + '</button>';
  var editBtnTitle = 'Edit (ffmpeg)';


  var autoPlayIcon = galleryState.autoplayOn ? GALLERY_ICONS.stop : GALLERY_ICONS.play;
  var autoPlayTitle = galleryState.autoplayOn ? 'Stop (A / ■)' : 'Autoplay (A / ▶)';

  var ctrlCenter = isVid ?
    '<button class="gallery-btn gallery-btn-icon" id="gallery-vid-prev-btn" type="button" data-tooltip="Prev Video (‹ / Up)">' + GALLERY_ICONS.prev + '</button>' +
    '<button class="gallery-btn gallery-btn-icon" id="gallery-vid-play" type="button" data-tooltip="Play / Pause (Space)">' + GALLERY_ICONS.play + '</button>' +
    '<button class="gallery-btn gallery-btn-icon" id="gallery-vid-stop" type="button" data-tooltip="Stop">' + GALLERY_ICONS.stop + '</button>' +
    '<button class="gallery-btn gallery-btn-icon" id="gallery-vid-next-btn" type="button" data-tooltip="Next Video (› / Down)">' + GALLERY_ICONS.next + '</button>'
    :
    '<button class="gallery-btn gallery-btn-icon" id="gallery-prev-folder-btn" type="button" data-tooltip="Prev Folder (&lt;| / Up)">' + GALLERY_ICONS.prevFolder + '</button>' +
    '<button class="gallery-btn gallery-btn-icon" id="gallery-prev-btn" type="button" data-tooltip="Prev (‹ / Left / PageUp)">' + GALLERY_ICONS.prev + '</button>' +
    '<div class="gallery-auto-wrapper" id="gallery-auto-wrapper">' +
      '<button class="gallery-btn gallery-btn-icon" id="gallery-autoplay-btn" type="button" data-tooltip="' + autoPlayTitle + '">' + autoPlayIcon + '</button>' +
      '<div class="gallery-interval-dropdown" id="gallery-interval-dropdown">' +
        AUTOPLAY_LABELS.map(function(l, i) {
          var act = (AUTOPLAY_INTERVALS[i] === galleryState.autoplayInterval) ? ' active' : '';
          return '<div class="gallery-interval-item' + act + '" data-idx="' + i + '">' +
                   '<span>' + escapeHtml(l) + '</span>' +
                   '<span class="gallery-key-hint">' + (i + 1) + '</span>' +
                 '</div>';
        }).join('') +
      '</div>' +
    '</div>' +
    '<button class="gallery-btn gallery-btn-icon" id="gallery-next-btn" type="button" data-tooltip="Next (› / Right / PageDown / Space)">' + GALLERY_ICONS.next + '</button>' +
    '<button class="gallery-btn gallery-btn-icon" id="gallery-next-folder-btn" type="button" data-tooltip="Next Folder (|&gt; / Down)">' + GALLERY_ICONS.nextFolder + '</button>';

  var extraRight = isVid ?
    '<div class="gallery-vol-wrapper">' +
      '<button class="gallery-btn gallery-btn-icon" id="gallery-vol-btn" type="button" data-tooltip="Volume">' + GALLERY_ICONS.volume + '</button>' +
      '<div class="gallery-vol-popover">' +
        '<input type="range" class="gallery-vol-slider-vert" id="gallery-vol-slider" value="80" min="0" max="100" data-tooltip="Volume">' +
      '</div>' +
    '</div>'
    : '';

  var mainInner = isVid ?
    '<video class="gallery-main-video" id="gallery-main-video"></video>' +
    // Animated images (GIF/WebP) play in the video pane through their own
    // <img> node. It MUST NOT reuse the image pane's #gallery-main-img:
    // split mode would then produce a duplicate DOM id (R9). It is hidden
    // by default and revealed in animation mode.
    '<img class="gallery-main-anim" id="gallery-main-anim" alt="" style="width:100%;height:100%;object-fit:contain;user-select:none;pointer-events:none;display:none">' +
    '<div class="gallery-video-hover-ctrl" id="gallery-video-ctrl">' +
      '<input type="range" class="gallery-video-seeker" id="gallery-video-seeker" value="0" min="0" max="100" step="0.1">' +
      '<span id="gallery-vid-time" class="gallery-video-time">00:00 / 00:00</span>' +
    '</div>'
    :
    '<img class="gallery-main-img" id="gallery-main-img" alt="">' +
    '<div class="gallery-empty" id="gallery-empty" style="display:none">' +
      '<div class="gallery-empty-icon">⬚</div>' +
      '<div class="gallery-empty-hint">' + escapeHtml(T('Drop/Paste/Open') || 'Drop / Paste / Open') + '</div>' +
    '</div>' +
    '<div class="gallery-delete-overlay" id="gallery-delete-overlay"></div>';

  var treeId = isVid ? 'gallery-video-tree-panel' : 'gallery-tree-panel';
  var pathId = isVid ? 'gallery-video-path' : 'gallery-path';
  var infoId = isVid ? 'gallery-video-info' : 'gallery-info';
  var thumbsHTML = isVid ? '' : '<div class="gallery-thumbnails" id="gallery-thumbnails"></div>';

  return '<div class="gallery-pane' + focused + '" id="' + panelId + '">' +
           '<div class="gallery-tree-panel' + treeClass + '" id="' + treeId + '"></div>' +
           '<div class="gallery-main-area">' +
             '<div class="gallery-main" id="gallery-main">' +
               mainInner +
               '<span class="gallery-main-msg" id="gallery-toolbar-msg" style="display:none"></span>' +
             '</div>' +
             '<div class="gallery-bottom">' +
               thumbsHTML +
               '<div class="gallery-controls">' +
                 '<button class="gallery-btn gallery-btn-icon" id="' + (isVid ? 'gallery-vid-tree-btn' : 'gallery-tree-btn') + '" type="button" data-tooltip="Directory Tree (T)">' + GALLERY_ICONS.tree + '</button>' +
                 '<div class="gallery-path" id="' + pathId + '" data-tooltip="">-</div>' +
                 '<div class="gallery-ctrl-center">' + ctrlCenter + '</div>' +
                 '<div class="gallery-ctrl-right">' +
                   extraRight +
                   '<span class="gallery-info" id="' + infoId + '">0 / 0</span>' +
                   '<button class="gallery-btn gallery-btn-icon" id="gallery-split-btn" type="button" data-tooltip="' + splitBtnTitle + '">' + splitIcon + '</button>' +
                   modeBtnHTML +
                   '<button class="gallery-btn gallery-btn-icon" id="gallery-edit-btn" type="button" data-tooltip="' + editBtnTitle + '">' + GALLERY_ICONS.edit + '</button>' +
                   '<button class="gallery-btn gallery-btn-icon" id="gallery-fs-btn" type="button" data-tooltip="Fullscreen (F)">' + GALLERY_ICONS.fullscreen + '</button>' +
                 '</div>' +
               '</div>' +
             '</div>' +
           '</div>' +
         '</div>';
}

function updateLayoutMode() {
  var vidElBefore = document.getElementById('gallery-main-video');
  if (vidElBefore) {
    if (vidElBefore.currentTime > 0) galleryState.videoCurrentTime = vidElBefore.currentTime;
    galleryState.videoPaused = vidElBefore.paused;
  }

  var layout = document.getElementById('gallery-layout');
  if (!layout && galleryState.container) {
    layout = document.createElement('div');
    layout.className = 'gallery-layout';
    layout.id = 'gallery-layout';
    galleryState.container.appendChild(layout);
  }
  if (!layout) return;

  if (galleryState.viewMode === 'split') {
    layout.className = 'gallery-layout gallery-main-split';
    layout.innerHTML = buildPanelHTML('image', true) + buildPanelHTML('video', true);
  } else {
    layout.className = 'gallery-layout';
    layout.innerHTML = buildPanelHTML(galleryState.mediaType, false);
  }

  layout.addEventListener('dragover', onDragOver);
  layout.addEventListener('dragenter', onDragEnter);
  layout.addEventListener('dragleave', onDragLeave);
  layout.addEventListener('drop', onDrop);

  bindEventsForCurrentLayout();

  renderTreePanel();
  renderThumbnails();
  if (galleryState.index >= 0 && galleryState.items.length) renderActive(galleryState.index);
  if (galleryState.videoIndex >= 0 && galleryState.videoItems.length) renderActiveVideo(galleryState.videoIndex);
  autoBalanceFullscreenSplitRatio();
}

function updateFocusUIOnly() {
  var paneImg = document.getElementById('gallery-pane-image');
  var paneVid = document.getElementById('gallery-pane-video');
  if (paneImg) paneImg.classList.toggle('focused', galleryState.focus === 'image');
  if (paneVid) paneVid.classList.toggle('focused', galleryState.focus === 'video');

  // In split mode, only the focused side's tree panel is visible.
  if (galleryState.viewMode === 'split' && galleryState.treeOpen) {
    var imgTree = document.getElementById('gallery-tree-panel');
    var vidTree = document.getElementById('gallery-video-tree-panel');
    if (imgTree) imgTree.classList.toggle('hidden', galleryState.focus !== 'image');
    if (vidTree) vidTree.classList.toggle('hidden', galleryState.focus !== 'video');
  }

  if (galleryState.treeOpen) renderTreePanel();
}

function switchFocus() {
  if (galleryState.viewMode !== 'split') return;
  galleryState.focus = (galleryState.focus === 'image') ? 'video' : 'image';
  updateFocusUIOnly();
  flashFocusOverlay(galleryState.focus);
}

function bindEventsForCurrentLayout() {
  var paneImg = document.getElementById('gallery-pane-image');
  var paneVid = document.getElementById('gallery-pane-video');

  if (paneImg) {
    paneImg.addEventListener('click', function(e) {
      if (galleryState.viewMode === 'split' && galleryState.focus !== 'image') {
        galleryState.focus = 'image';
        updateFocusUIOnly();
        flashFocusOverlay('image');
      }
    });
  }
  if (paneVid) {
    paneVid.addEventListener('click', function(e) {
      if (galleryState.viewMode === 'split' && galleryState.focus !== 'video') {
        galleryState.focus = 'video';
        updateFocusUIOnly();
        flashFocusOverlay('video');
      }
    });
  }

  var treeBtn = document.getElementById('gallery-tree-btn');
  if (treeBtn) treeBtn.onclick = toggleTreePanel;
  var vidTreeBtn = document.getElementById('gallery-vid-tree-btn');
  if (vidTreeBtn) vidTreeBtn.onclick = toggleTreePanel;

  var splitBtns = document.querySelectorAll('#gallery-split-btn');
  splitBtns.forEach(function(b) {
    b.onclick = function(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      toggleSplitMode();
    };
  });

  var modeBtns = document.querySelectorAll('#gallery-mode-btn');
  modeBtns.forEach(function(b) {
    b.onclick = function(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      toggleMediaType();
    };
  });

  var fsBtns = document.querySelectorAll('#gallery-fs-btn');
  fsBtns.forEach(function(b) {
    b.onclick = function(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      toggleFullscreen();
    };
  });

  // Edit button — delegates to the shared triggerMediaEditor function
  var editBtns = document.querySelectorAll('#gallery-edit-btn');
  editBtns.forEach(function(b) {
    b.onclick = function(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      // Determine media type from which pane the button is in
      var mt;
      if (galleryState.viewMode === 'split') {
        var paneEl = e.currentTarget.closest('.gallery-pane');
        mt = paneEl && paneEl.id === 'gallery-pane-video' ? 'video' : 'image';
      } else {
        mt = galleryState.mediaType;
      }
      if (typeof window.triggerMediaEditor === 'function') {
        window.triggerMediaEditor(mt);
      }
    };
  });

  var empty = document.getElementById('gallery-empty');
  if (empty) empty.onclick = onOpenClick;

  // image controls
  var prevFolderBtn = document.getElementById('gallery-prev-folder-btn');
  if (prevFolderBtn) prevFolderBtn.onclick = goPrevFolder;
  var prevBtn = document.getElementById('gallery-prev-btn');
  if (prevBtn) prevBtn.onclick = goPrev;
  var nextBtn = document.getElementById('gallery-next-btn');
  if (nextBtn) nextBtn.onclick = goNext;
  var nextFolderBtn = document.getElementById('gallery-next-folder-btn');
  if (nextFolderBtn) nextFolderBtn.onclick = goNextFolder;
  var autoBtn = document.getElementById('gallery-autoplay-btn');
  if (autoBtn) autoBtn.onclick = toggleAutoplay;

  var dropdown = document.getElementById('gallery-interval-dropdown');
  if (dropdown) {
    dropdown.onclick = function(e) {
      var item = e.target.closest('[data-idx]');
      if (!item) return;
      var idx = parseInt(item.dataset.idx, 10);
      if (!isNaN(idx)) setAutoplayInterval(idx);
    };
  }

  // video controls
  var vidPrevFolderBtn = document.getElementById('gallery-vid-prev-folder-btn');
  if (vidPrevFolderBtn) vidPrevFolderBtn.onclick = goPrevFolder;
  var vidPrevBtn = document.getElementById('gallery-vid-prev-btn');
  if (vidPrevBtn) vidPrevBtn.onclick = function() { setVideoActive(galleryState.videoIndex - 1); };
  var vidNextBtn = document.getElementById('gallery-vid-next-btn');
  if (vidNextBtn) vidNextBtn.onclick = function() { setVideoActive(galleryState.videoIndex + 1); };
  var vidNextFolderBtn = document.getElementById('gallery-vid-next-folder-btn');
  if (vidNextFolderBtn) vidNextFolderBtn.onclick = goNextFolder;

  bindVideoControls();

  var treePanels = document.querySelectorAll('#gallery-tree-panel, #gallery-video-tree-panel');
  treePanels.forEach(function(tp) {
    tp.onclick = function(e) {
      var target = e.target.closest('.gallery-tree-node');
      if (!target) return;
      // Detect which side this tree panel belongs to and auto-focus it
      var isThisVidPanel = (tp.id === 'gallery-video-tree-panel');
      if (galleryState.viewMode === 'split') {
        var clickedSide = isThisVidPanel ? 'video' : 'image';
        if (galleryState.focus !== clickedSide) {
          galleryState.focus = clickedSide;
          updateFocusUIOnly();
          flashFocusOverlay(clickedSide);
        }
      }
      var dir = target.getAttribute('data-dir');
      var isVid = isThisVidPanel;
      var map = isVid ? galleryState.videoDirMap : galleryState.dirMap;
      if (dir && map[dir] && map[dir].length) {
        if (isVid) setVideoActive(map[dir][0]);
        else setActive(map[dir][0]);
      }
    };
  });
}