// web/static/gif-editor-playback.js
// Playback Control & Key Binding for TinyRouter GIF Editor

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

  var bound = false; // per-render event binding guard

  // ------------------------------------------------------------------
  // FocusFrame Command Implementation
  // ------------------------------------------------------------------

  function focusFrame(index, options) {
    options = options || {};
    var slices = core.state.slices || [];
    var total = slices.length;

    var countEl = document.getElementById('gif-timeline-count');
    var frameIndEl = core.dom.frameIndicator || document.getElementById('gif-frame-indicator');

    if (!total) {
      core.state.selectedSliceIdx = -1;
      core.state.activeLayer = null;
      if (countEl) countEl.textContent = '0 / 0';
      if (frameIndEl) frameIndEl.textContent = '';
      if (core.commands.updateSelectionUI) core.commands.updateSelectionUI(-1);
      if (core.commands.redrawSelection) core.commands.redrawSelection(-1);
      updateButtons();
      return false;
    }

    index = Math.max(0, Math.min(total - 1, Number(index) || 0));
    core.state.selectedSliceIdx = index;
    core.state.mode = 'editor';
    core.state.activeLayer = null;

    var displayTxt = (index + 1) + ' / ' + total;
    if (countEl) countEl.textContent = displayTxt;
    if (frameIndEl) frameIndEl.textContent = displayTxt;

    if (core.commands.updateSelectionUI) core.commands.updateSelectionUI(index);
    if (core.commands.redrawSelection) core.commands.redrawSelection(index);

    if (options.ensureVisible !== false && core.timeline && core.timeline.ensureVisible) {
      core.timeline.ensureVisible(index);
    }
    if (core.timeline && core.timeline.render) {
      core.timeline.render();
    }
    updateButtons();
    return true;
  }

  // Re-register on every render: cleanupModules() wipes core.commands.
  core.commands.focusFrame = focusFrame;

  // ------------------------------------------------------------------
  // Playback Control Machine (recursive setTimeout, per-frame delay)
  // ------------------------------------------------------------------

  function play() {
    var slices = core.state.slices || [];
    if (!slices.length) return;

    if (core.state.selectedSliceIdx === -1 || core.state.selectedSliceIdx >= slices.length - 1) {
      focusFrame(0);
    }

    var pb = core.state.playback;
    pb.playing = true;
    pb.generation++;

    updateButtons();
    scheduleNext();
  }

  function pause() {
    var pb = core.state.playback;
    pb.playing = false;
    pb.generation++;

    if (pb.timer) {
      clearTimeout(pb.timer);
      pb.timer = null;
    }
    updateButtons();
  }

  function toggle() {
    if (core.state.playback.playing) {
      pause();
    } else {
      play();
    }
  }

  function scheduleNext() {
    var pb = core.state.playback;
    if (!pb.playing) return;

    var gen = pb.generation;
    var idx = core.state.selectedSliceIdx;
    var slices = core.state.slices || [];

    if (idx >= slices.length - 1) {
      pause();
      return;
    }

    var currentSlice = slices[idx];
    var delay = Math.max(1, Number(currentSlice.delay) || 100);

    pb.timer = setTimeout(function () {
      if (!pb.playing || gen !== pb.generation) return;
      focusFrame(core.state.selectedSliceIdx + 1);
      scheduleNext();
    }, delay);
  }

  function updateButtons() {
    var slices = core.state.slices || [];
    var total = slices.length;
    var idx = core.state.selectedSliceIdx;
    var isPlaying = core.state.playback.playing;

    var firstBtn = document.getElementById('gif-timeline-first');
    var prevBtn = document.getElementById('gif-timeline-prev');
    var playBtn = document.getElementById('gif-timeline-play');
    var nextBtn = document.getElementById('gif-timeline-next');
    var lastBtn = document.getElementById('gif-timeline-last');

    if (firstBtn) {
      firstBtn.disabled = (!total || idx <= 0);
      firstBtn.title = t('gifTimelineFirst', 'First Frame');
    }
    if (prevBtn) {
      prevBtn.disabled = (!total || idx <= 0);
      prevBtn.title = t('gifTimelinePrev', 'Previous Frame');
    }
    if (playBtn) {
      playBtn.disabled = (!total);
      playBtn.textContent = isPlaying ? '⏸️' : '▶️';
      playBtn.title = isPlaying ? t('gifTimelinePause', 'Pause') : t('gifTimelinePlay', 'Play');
      playBtn.setAttribute('aria-label', playBtn.title);
      playBtn.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
    }
    if (nextBtn) {
      nextBtn.disabled = (!total || idx >= total - 1);
      nextBtn.title = t('gifTimelineNext', 'Next Frame');
    }
    if (lastBtn) {
      lastBtn.disabled = (!total || idx >= total - 1);
      lastBtn.title = t('gifTimelineLast', 'Last Frame');
    }
  }

  // ------------------------------------------------------------------
  // Keybindings (frame navigation + play/pause; Escape is owned by the entry)
  // ------------------------------------------------------------------

  function onKeyDown(e) {
    var activeEl = document.activeElement;
    var activeTag = activeEl ? activeEl.tagName : '';
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT' ||
        (activeEl && activeEl.isContentEditable)) {
      return;
    }
    var modalOverlay = document.getElementById('modal-overlay');
    if (modalOverlay && modalOverlay.classList.contains('show')) {
      return;
    }

    var slices = core.state.slices || [];
    if (!slices.length) return;

    var key = e.key;
    if (key === 'ArrowLeft' || key === 'PageUp') {
      e.preventDefault();
      focusFrame(core.state.selectedSliceIdx - 1);
    } else if (key === 'ArrowRight' || key === 'PageDown') {
      e.preventDefault();
      focusFrame(core.state.selectedSliceIdx + 1);
    } else if (key === 'Home') {
      e.preventDefault();
      focusFrame(0);
    } else if (key === 'End') {
      e.preventDefault();
      focusFrame(slices.length - 1);
    } else if (key === ' ' || key === 'Spacebar') {
      e.preventDefault();
      toggle();
    }
  }

  function bindEvents() {
    // Commands are wiped by cleanupModules() on every teardown; re-register.
    core.commands.focusFrame = focusFrame;

    if (bound) {
      updateButtons();
      return;
    }
    bound = true;

    var firstBtn = document.getElementById('gif-timeline-first');
    var prevBtn = document.getElementById('gif-timeline-prev');
    var playBtn = document.getElementById('gif-timeline-play');
    var nextBtn = document.getElementById('gif-timeline-next');
    var lastBtn = document.getElementById('gif-timeline-last');

    if (firstBtn) firstBtn.addEventListener('click', function () { focusFrame(0); });
    if (prevBtn) prevBtn.addEventListener('click', function () { focusFrame(core.state.selectedSliceIdx - 1); });
    if (playBtn) playBtn.addEventListener('click', function () { toggle(); });
    if (nextBtn) nextBtn.addEventListener('click', function () { focusFrame(core.state.selectedSliceIdx + 1); });
    if (lastBtn) lastBtn.addEventListener('click', function () { focusFrame(core.state.slices.length - 1); });

    document.addEventListener('keydown', onKeyDown);
    updateButtons();
  }

  function cleanup() {
    bound = false;
    pause();
    document.removeEventListener('keydown', onKeyDown);
  }

  var playbackApi = {
    first: function () { focusFrame(0); },
    previous: function () { focusFrame(core.state.selectedSliceIdx - 1); },
    play: play,
    pause: pause,
    toggle: toggle,
    next: function () { focusFrame(core.state.selectedSliceIdx + 1); },
    last: function () { focusFrame((core.state.slices || []).length - 1); },
    updateButtons: updateButtons,
    bindEvents: bindEvents,
    cleanup: cleanup
  };

  core.registerModule('playback', playbackApi);
  core.playback = playbackApi;
})();
