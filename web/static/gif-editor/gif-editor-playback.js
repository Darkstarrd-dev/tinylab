// web/static/gif-editor-playback.js
// Playback Control & Key Binding for TinyLab GIF Editor

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

  var SVG_PLAY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  var SVG_PAUSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  var SVG_REVERSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="19 3 5 12 19 21 19 3"/></svg>';

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

    var pb = core.state.playback;
    pb.reverse = false;

    if (core.state.selectedSliceIdx === -1 || core.state.selectedSliceIdx >= slices.length - 1) {
      focusFrame(0);
    }

    pb.playing = true;
    pb.generation++;

    updateButtons();
    scheduleNext();
  }

  function playReverse() {
    var slices = core.state.slices || [];
    if (!slices.length) return;

    var pb = core.state.playback;
    pb.reverse = true;

    if (core.state.selectedSliceIdx <= 0) {
      focusFrame(slices.length - 1);
    }

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
    var pb = core.state.playback;
    if (pb.playing && !pb.reverse) {
      pause();
    } else {
      play();
    }
  }

  function toggleReverse() {
    var pb = core.state.playback;
    if (pb.playing && pb.reverse) {
      pause();
    } else {
      playReverse();
    }
  }

  function toggleLoop() {
    var pb = core.state.playback;
    pb.loop = !pb.loop;
    updateButtons();
  }

  function scheduleNext() {
    var pb = core.state.playback;
    if (!pb.playing) return;

    var gen = pb.generation;
    var idx = core.state.selectedSliceIdx;
    var slices = core.state.slices || [];

    var nextIdx;
    if (pb.reverse) {
      nextIdx = idx - 1;
      if (nextIdx < 0) {
        if (pb.loop) {
          nextIdx = slices.length - 1;
        } else {
          pause();
          return;
        }
      }
    } else {
      nextIdx = idx + 1;
      if (nextIdx >= slices.length) {
        if (pb.loop) {
          nextIdx = 0;
        } else {
          pause();
          return;
        }
      }
    }

    var currentSlice = slices[idx];
    var delay = Math.max(1, Number(currentSlice.delay) || 100);

    pb.timer = setTimeout(function () {
      if (!pb.playing || gen !== pb.generation) return;
      focusFrame(nextIdx);
      scheduleNext();
    }, delay);
  }

  function updateButtons() {
    var slices = core.state.slices || [];
    var total = slices.length;
    var idx = core.state.selectedSliceIdx;
    var pb = core.state.playback;
    var isForwardPlaying = pb.playing && !pb.reverse;
    var isReversePlaying = pb.playing && pb.reverse;

    var firstBtn = document.getElementById('gif-timeline-first');
    var prevBtn = document.getElementById('gif-timeline-prev');
    var reverseBtn = document.getElementById('gif-timeline-reverse');
    var playBtn = document.getElementById('gif-timeline-play');
    var nextBtn = document.getElementById('gif-timeline-next');
    var lastBtn = document.getElementById('gif-timeline-last');
    var loopBtn = document.getElementById('gif-timeline-loop');

    if (firstBtn) {
      firstBtn.disabled = (!total || idx <= 0);
      firstBtn.setAttribute('data-tooltip', t('gifTimelineFirst', 'First Frame'));
    }
    if (prevBtn) {
      prevBtn.disabled = (!total || idx <= 0);
      prevBtn.setAttribute('data-tooltip', t('gifTimelinePrev', 'Previous Frame'));
    }
    if (reverseBtn) {
      reverseBtn.disabled = (!total);
      reverseBtn.innerHTML = isReversePlaying ? SVG_PAUSE : SVG_REVERSE;
      var revTitle = isReversePlaying ? t('gifTimelinePause', 'Pause') : t('gifTimelineReverse', 'Reverse Play');
      reverseBtn.setAttribute('data-tooltip', revTitle);
      reverseBtn.setAttribute('aria-label', revTitle);
      reverseBtn.setAttribute('aria-pressed', isReversePlaying ? 'true' : 'false');
      reverseBtn.classList.toggle('active', isReversePlaying);
    }
    if (playBtn) {
      playBtn.disabled = (!total);
      playBtn.innerHTML = isForwardPlaying ? SVG_PAUSE : SVG_PLAY;
      var playTitle = isForwardPlaying ? t('gifTimelinePause', 'Pause') : t('gifTimelinePlay', 'Play');
      playBtn.setAttribute('data-tooltip', playTitle);
      playBtn.setAttribute('aria-label', playTitle);
      playBtn.setAttribute('aria-pressed', isForwardPlaying ? 'true' : 'false');
      playBtn.classList.toggle('active', isForwardPlaying);
    }
    if (nextBtn) {
      nextBtn.disabled = (!total || idx >= total - 1);
      nextBtn.setAttribute('data-tooltip', t('gifTimelineNext', 'Next Frame'));
    }
    if (lastBtn) {
      lastBtn.disabled = (!total || idx >= total - 1);
      lastBtn.setAttribute('data-tooltip', t('gifTimelineLast', 'Last Frame'));
    }
    if (loopBtn) {
      loopBtn.disabled = (!total);
      loopBtn.setAttribute('data-tooltip', pb.loop ? t('gifTimelineLoopOn', 'Loop (On)') : t('gifTimelineLoop', 'Loop'));
      loopBtn.setAttribute('aria-pressed', pb.loop ? 'true' : 'false');
      loopBtn.classList.toggle('active', pb.loop);
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
    var reverseBtn = document.getElementById('gif-timeline-reverse');
    var playBtn = document.getElementById('gif-timeline-play');
    var nextBtn = document.getElementById('gif-timeline-next');
    var lastBtn = document.getElementById('gif-timeline-last');
    var loopBtn = document.getElementById('gif-timeline-loop');

    if (firstBtn) firstBtn.addEventListener('click', function () { focusFrame(0); });
    if (prevBtn) prevBtn.addEventListener('click', function () { focusFrame(core.state.selectedSliceIdx - 1); });
    if (reverseBtn) reverseBtn.addEventListener('click', function () { toggleReverse(); });
    if (playBtn) playBtn.addEventListener('click', function () { toggle(); });
    if (nextBtn) nextBtn.addEventListener('click', function () { focusFrame(core.state.selectedSliceIdx + 1); });
    if (lastBtn) lastBtn.addEventListener('click', function () { focusFrame(core.state.slices.length - 1); });
    if (loopBtn) loopBtn.addEventListener('click', function () { toggleLoop(); });

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
    toggleReverse: toggleReverse,
    toggleLoop: toggleLoop,
    next: function () { focusFrame(core.state.selectedSliceIdx + 1); },
    last: function () { focusFrame((core.state.slices || []).length - 1); },
    updateButtons: updateButtons,
    bindEvents: bindEvents,
    cleanup: cleanup
  };

  core.registerModule('playback', playbackApi);
  core.playback = playbackApi;
})();
