// web/static/gif-editor-timeline.js
// Timeline, Virtual Window & Zoom Handling for TinyRouter GIF Editor
//
// DOM contract (style.css "GIF Editor Upgrade Styles"): the track
// (#gif-timeline, .gif-timeline-track) is a position:relative strip sized
// N x pitch; only the visible window of .gif-timeline-item nodes is mounted,
// each absolutely positioned at left: i*pitch. All interactions are
// delegated on the track/scroll container.

(function () {
  'use strict';

  var core = window.GifEditorCore;
  if (!core) return;

  function t(key, fallback) {
    if (typeof window.t === 'function') {
      var res = window.t(key);
      if (res && res !== key) return res;
    }
    return fallback || key;
  }

  var TL_BUFFER = 4;          // frames rendered beyond the viewport each side
  var THUMB_CACHE_MAX = 256;  // bounded thumbnail cache entries

  var thumbRaf = null;
  var bound = false;          // per-render event binding guard

  function getZoom() {
    return core.state.timeline ? (core.state.timeline.zoom || 1) : 1;
  }

  // Item width scales with zoom; pitch = width + gap. The track keeps the
  // native horizontal geometry so the browser scrollbar matches reality.
  function getGeometry() {
    var zoom = getZoom();
    var itemWidth = Math.max(50, Math.round(100 * zoom));
    var itemGap = Math.max(4, Math.round(10 * zoom));
    return {
      itemWidth: itemWidth,
      itemGap: itemGap,
      itemPitch: itemWidth + itemGap
    };
  }

  function getScrollEl() {
    return core.dom.timelineScroll || document.getElementById('gif-timeline-scroll');
  }

  function getTrack() {
    return core.dom.timeline || document.getElementById('gif-timeline');
  }

  function clearThumbCache() {
    if (!core.state.timeline) return;
    core.state.timeline.thumbCache = {};
    core.state.timeline.thumbKeys = [];
  }

  // Small bounded preview (~ item size, never a full-frame payload).
  function getThumb(slice) {
    if (!slice || !slice.canvas) return '';
    var tl = core.state.timeline;
    if (!tl) return '';

    if (tl.thumbCache[slice.id]) return tl.thumbCache[slice.id];

    var geo = getGeometry();
    var thumbW = Math.max(1, geo.itemWidth - 8);
    var thumbH = Math.max(1, Math.round(thumbW * (slice.canvas.height / slice.canvas.width)));
    if (thumbH > 96) { thumbH = 96; thumbW = Math.max(1, Math.round(thumbH * (slice.canvas.width / slice.canvas.height))); }

    var thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = thumbW;
    thumbCanvas.height = thumbH;
    var tCtx = thumbCanvas.getContext('2d');
    tCtx.drawImage(slice.canvas, 0, 0, thumbW, thumbH);

    var dataUrl = thumbCanvas.toDataURL('image/png');
    tl.thumbCache[slice.id] = dataUrl;
    tl.thumbKeys.push(slice.id);

    if (tl.thumbKeys.length > THUMB_CACHE_MAX) {
      var oldest = tl.thumbKeys.shift();
      delete tl.thumbCache[oldest];
    }
    return dataUrl;
  }

  function timelineWindow() {
    var slices = core.state.slices || [];
    var total = slices.length;
    var geo = getGeometry();
    if (!total) return { start: 0, end: 0, pitch: geo.itemPitch };

    var scrollEl = getScrollEl();
    var scrollLeft = scrollEl ? scrollEl.scrollLeft : 0;
    var clientWidth = scrollEl ? scrollEl.clientWidth : 800;

    var start = Math.floor(scrollLeft / geo.itemPitch) - TL_BUFFER;
    var end = Math.ceil((scrollLeft + clientWidth) / geo.itemPitch) + TL_BUFFER;

    start = Math.max(0, Math.min(total, start));
    end = Math.max(start, Math.min(total, end));

    return { start: start, end: end, pitch: geo.itemPitch };
  }

  // One .gif-timeline-item node (matches the CSS contract exactly).
  function buildSliceItem(i) {
    var s = core.state.slices[i];
    var geo = getGeometry();
    var el = document.createElement('div');
    el.className = 'gif-timeline-item' + (i === core.state.selectedSliceIdx ? ' active' : '');
    el.draggable = true;
    el.dataset.index = i;
    el.style.left = (i * geo.itemPitch) + 'px';
    el.style.width = geo.itemWidth + 'px';

    var imgBox = document.createElement('div');
    imgBox.className = 'gif-thumb-wrapper';
    var img = document.createElement('img');
    img.alt = 'Frame ' + (i + 1);
    img.src = getThumb(s);
    imgBox.appendChild(img);

    var info = document.createElement('div');
    info.className = 'gif-timeline-info';
    var numSpan = document.createElement('span');
    numSpan.textContent = '#' + (i + 1);
    info.appendChild(numSpan);

    var delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.className = 'gif-delay-input';
    delayInput.dataset.index = i;
    delayInput.value = Math.round(s.delay);
    delayInput.min = '0';
    delayInput.title = t('gifEditorDelayTitle', 'Frame delay (ms)');
    info.appendChild(delayInput);

    var actions = document.createElement('div');
    actions.className = 'gif-timeline-item-actions';
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-copy-slice';
    copyBtn.dataset.action = 'duplicate';
    copyBtn.textContent = '📑';
    copyBtn.title = t('gifTimelineCopy', 'Copy frame');
    copyBtn.setAttribute('aria-label', copyBtn.title);
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-del-slice';
    delBtn.dataset.action = 'delete';
    delBtn.textContent = '🗑️';
    delBtn.title = t('gifTimelineDelete', 'Delete frame');
    delBtn.setAttribute('aria-label', delBtn.title);
    actions.appendChild(copyBtn);
    actions.appendChild(delBtn);

    el.appendChild(imgBox);
    el.appendChild(info);
    el.appendChild(actions);
    return el;
  }

  function render() {
    var track = getTrack();
    if (!track) return;

    var slices = core.state.slices || [];
    var geo = getGeometry();

    if (!slices.length) {
      track.style.width = '100%';
      track.innerHTML = '';
      var empty = document.createElement('div');
      empty.className = 'gif-timeline-empty';
      empty.innerText = t('gifEditorNoFrames', 'No frames');
      track.appendChild(empty);
      if (core.state.timeline) core.state.timeline.window = null;
      clearThumbCache();
      updateZoomDisplay();
      var countEl = document.getElementById('gif-timeline-count');
      if (countEl) countEl.textContent = '0 / 0';
      return;
    }

    if (core.state.selectedSliceIdx >= slices.length) {
      core.state.selectedSliceIdx = slices.length - 1;
    }
    var countEl = document.getElementById('gif-timeline-count');
    if (countEl) countEl.textContent = (Math.max(0, core.state.selectedSliceIdx) + 1) + ' / ' + slices.length;

    track.style.width = (slices.length * geo.itemPitch + geo.itemGap) + 'px';

    var win = timelineWindow();
    if (core.state.timeline) core.state.timeline.window = win;

    var frag = document.createDocumentFragment();
    for (var i = win.start; i < win.end; i++) {
      frag.appendChild(buildSliceItem(i));
    }
    track.innerHTML = '';
    track.appendChild(frag);

    updateZoomDisplay();
    if (core.playback && core.playback.updateButtons) {
      core.playback.updateButtons();
    }
  }

  function updateWindow() {
    if (thumbRaf) return;
    thumbRaf = requestAnimationFrame(function () {
      thumbRaf = null;
      render();
    });
  }

  // Focus is owned by core.commands.focusFrame; this only makes the frame
  // visible in the scroll viewport (scroll is never the buttons' job).
  function ensureVisible(index) {
    var slices = core.state.slices || [];
    if (index < 0 || index >= slices.length) return;

    var scrollEl = getScrollEl();
    if (!scrollEl) return;

    var geo = getGeometry();
    var itemLeft = index * geo.itemPitch;
    var itemRight = itemLeft + geo.itemWidth;

    var viewLeft = scrollEl.scrollLeft;
    var viewRight = viewLeft + scrollEl.clientWidth;

    if (itemLeft < viewLeft) {
      scrollEl.scrollLeft = Math.max(0, itemLeft - geo.itemGap);
    } else if (itemRight > viewRight) {
      scrollEl.scrollLeft = itemRight - scrollEl.clientWidth + geo.itemGap;
    }
  }

  function setZoom(value) {
    var val = parseFloat(value);
    if (isNaN(val)) val = 1;
    val = Math.max(0.5, Math.min(2.0, val));
    if (!core.state.timeline) core.state.timeline = {};
    core.state.timeline.zoom = val;

    clearThumbCache();
    render();
    if (core.state.selectedSliceIdx >= 0) {
      ensureVisible(core.state.selectedSliceIdx);
    }
  }

  function updateZoomDisplay() {
    var zoomRange = document.getElementById('gif-timeline-zoom-range');
    var zoomVal = document.getElementById('gif-timeline-zoom-value');
    var scale = core.state.scale || 1;

    if (zoomRange && Math.abs(parseFloat(zoomRange.value) - scale) > 0.001) {
      zoomRange.value = scale;
    }
    if (zoomVal) {
      zoomVal.textContent = Math.round(scale * 100) + '%';
    }
  }

  // ------------------------------------------------------------------
  // Delegated Timeline Events
  // ------------------------------------------------------------------

  function onScroll() {
    updateWindow();
  }

  function onTrackClick(e) {
    var target = e.target;

    // Click/focus separation: the delay input never changes the selection.
    if (target.closest('input')) return;

    var actionEl = target.closest('.btn-copy-slice, .btn-del-slice');
    if (actionEl) {
      var item = actionEl.closest('.gif-timeline-item');
      if (!item) return;
      var aIdx = parseInt(item.dataset.index, 10);
      if (isNaN(aIdx)) return;
      if (actionEl.dataset.action === 'duplicate') copySlice(aIdx);
      else if (actionEl.dataset.action === 'delete') deleteSlice(aIdx);
      return;
    }

    var frameEl = target.closest('.gif-timeline-item');
    if (frameEl) {
      var idx = parseInt(frameEl.dataset.index, 10);
      if (!isNaN(idx) && core.commands.focusFrame) {
        core.commands.focusFrame(idx);
      }
    }
  }

  function onDelayChange(e) {
    var target = e.target;
    if (!target || target.tagName !== 'INPUT' || !target.classList.contains('gif-delay-input')) return;
    var idx = parseInt(target.dataset.index, 10);
    var s = (core.state.slices || [])[idx];
    if (!s) return;
    var val = parseFloat(target.value);
    s.delay = (isNaN(val) || val < 0) ? 0 : val;
  }

  function copySlice(index) {
    var slices = core.state.slices;
    if (!slices || index < 0 || index >= slices.length) return;

    var src = slices[index];
    var newCanvas = document.createElement('canvas');
    newCanvas.width = src.canvas.width;
    newCanvas.height = src.canvas.height;
    newCanvas.getContext('2d').drawImage(src.canvas, 0, 0);

    var newLayers = (src.layers || []).map(function (l) {
      return Object.assign({}, l);
    });

    slices.splice(index + 1, 0, {
      id: core.freshId(),
      canvas: newCanvas,
      delay: src.delay,
      layers: newLayers
    });
    render();
    if (core.commands.focusFrame) core.commands.focusFrame(index + 1);
  }

  function deleteSlice(index) {
    var slices = core.state.slices;
    if (!slices || index < 0 || index >= slices.length) return;

    slices.splice(index, 1);
    clearThumbCache();
    render();

    if (!slices.length) {
      core.state.selectedSliceIdx = -1;
      if (core.playback) core.playback.pause();
      if (core.playback) core.playback.updateButtons();
      if (core.commands.redrawSelection) core.commands.redrawSelection(-1);
    } else {
      var newIndex = Math.min(index, slices.length - 1);
      if (core.commands.focusFrame) core.commands.focusFrame(newIndex);
    }
  }

  function onDragStart(e) {
    var item = e.target && e.target.closest ? e.target.closest('.gif-timeline-item') : null;
    if (!item) return;
    var idx = parseInt(item.dataset.index, 10);
    if (isNaN(idx)) return;
    core.state.dragSrcIndex = idx;
    core.state.dragItemEl = item;
    item.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    }
  }

  function onDragOver(e) {
    if (core.state.dragSrcIndex === null || core.state.dragSrcIndex === undefined) return;
    if (e.preventDefault) e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    return false;
  }

  function onDrop(e) {
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (core.state.dragSrcIndex === null || core.state.dragSrcIndex === undefined) return false;
    var item = e.target && e.target.closest ? e.target.closest('.gif-timeline-item') : null;
    if (!item) return false;

    var srcIdx = core.state.dragSrcIndex;
    var targetIdx = parseInt(item.dataset.index, 10);
    core.state.dragSrcIndex = null;
    if (srcIdx === targetIdx || isNaN(targetIdx)) return false;

    var slices = core.state.slices;
    var moved = slices.splice(srcIdx, 1)[0];
    slices.splice(targetIdx, 0, moved);

    render();
    if (core.commands.focusFrame) core.commands.focusFrame(targetIdx);
    return false;
  }

  function onDragEnd() {
    core.state.dragSrcIndex = null;
    var track = getTrack();
    if (track) {
      var draggingEls = track.querySelectorAll('.gif-timeline-item.dragging, .gif-timeline-item.drag-over');
      for (var i = 0; i < draggingEls.length; i++) {
        draggingEls[i].classList.remove('dragging');
        draggingEls[i].classList.remove('drag-over');
      }
    }
  }

  function bindEvents() {
    if (bound) return; // no listener accumulation across repeated renders
    bound = true;

    var scrollEl = getScrollEl();
    var track = getTrack();
    var zoomRange = document.getElementById('gif-timeline-zoom-range');

    if (scrollEl) {
      scrollEl.addEventListener('scroll', onScroll, { passive: true });
    }
    if (track) {
      track.addEventListener('click', onTrackClick);
      track.addEventListener('change', onDelayChange);
      track.addEventListener('dragstart', onDragStart);
      track.addEventListener('dragover', onDragOver);
      track.addEventListener('drop', onDrop);
      track.addEventListener('dragend', onDragEnd);
    }
    if (zoomRange) {
      zoomRange.addEventListener('input', function () {
        var val = parseFloat(zoomRange.value);
        if (!isNaN(val) && val > 0) {
          core.state.scale = val;
          if (core.commands.updateTransform) core.commands.updateTransform();
        }
      });
    }
  }

  function cleanup() {
    bound = false;
    var scrollEl = getScrollEl();
    var track = getTrack();

    if (scrollEl) scrollEl.removeEventListener('scroll', onScroll);
    if (track) {
      track.removeEventListener('click', onTrackClick);
      track.removeEventListener('change', onDelayChange);
      track.removeEventListener('dragstart', onDragStart);
      track.removeEventListener('dragover', onDragOver);
      track.removeEventListener('drop', onDrop);
      track.removeEventListener('dragend', onDragEnd);
    }
    if (thumbRaf) {
      cancelAnimationFrame(thumbRaf);
      thumbRaf = null;
    }
    clearThumbCache();
  }

  var timelineApi = {
    render: render,
    updateWindow: updateWindow,
    ensureVisible: ensureVisible,
    setZoom: setZoom,
    getZoom: getZoom,
    clearThumbCache: clearThumbCache,
    bindEvents: bindEvents,
    cleanup: cleanup
  };

  core.registerModule('timeline', timelineApi);
  core.timeline = timelineApi;
})();
