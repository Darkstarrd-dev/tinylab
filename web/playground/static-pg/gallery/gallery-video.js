// gallery-video.js — Gallery video playback and controls.

'use strict';

function updateVideoDirStructure() {
  galleryState.videoDirMap = {};
  galleryState.videoDirPathList = [];
  for (var i = 0; i < galleryState.videoItems.length; i++) {
    var item = galleryState.videoItems[i];
    var dir = getDirPath(item.path);
    if (!galleryState.videoDirMap[dir]) {
      galleryState.videoDirMap[dir] = [];
      galleryState.videoDirPathList.push(dir);
    }
    galleryState.videoDirMap[dir].push(i);
  }
}

function setVideoActive(index) {
  if (!galleryState.videoItems.length) return;
  if (index < 0) index = galleryState.videoItems.length - 1;
  if (index >= galleryState.videoItems.length) index = 0;
  galleryState.videoIndex = index;
  renderActiveVideo(index);
  renderTreePanel();
}

function renderActiveVideo(index) {
  var item = galleryState.videoItems[index];
  var vidEl = document.getElementById('gallery-main-video');
  var animEl = document.getElementById('gallery-main-anim');
  var pathEl = document.getElementById('gallery-video-path') || document.getElementById('gallery-path');
  var info = document.getElementById('gallery-video-info') || document.getElementById('gallery-info');

  if (!item) {
    if (vidEl) vidEl.removeAttribute('src');
    if (animEl) animEl.removeAttribute('src');
    if (pathEl) { pathEl.textContent = '-'; pathEl.removeAttribute('data-tooltip'); }
    if (info) info.textContent = '0 / 0 | Video';
    return;
  }

  if (pathEl) {
    var displayPath = item.path || item.name || '';
    pathEl.textContent = displayPath;
    pathEl.setAttribute('data-tooltip', displayPath);
  }

  var isAnim = isAnimatedImg(item);
  applyVideoPaneMode(isAnim);

  ensureMainSrc(item).then(function() {
    // Render race guard: ensureMainSrc is async, so by the time the blob
    // URL is ready the user may have selected another item. A stale request
    // must NOT overwrite the newer selection.
    if (galleryState.videoIndex !== index) return;
    if (isAnim) {
      if (animEl && item.mainURL) {
        galleryState.videoURL = item.mainURL;
        // Changing src triggers replay — browsers auto-play GIF/WebP in <img>.
        if (animEl.getAttribute('src') !== item.mainURL) {
          animEl.setAttribute('src', item.mainURL);
        }
        galleryState.videoPlayingState = true;
      }
    } else if (vidEl && item.mainURL) {
      galleryState.videoURL = item.mainURL;
      if (vidEl.src !== item.mainURL) {
        vidEl.src = item.mainURL;
      }
      var restoreVidState = function() {
        if (galleryState.videoPlayingState === true) {
          try { vidEl.play().catch(function() {}); } catch (e) {}
        } else {
          try { vidEl.pause(); } catch (e) {}
        }
      };
      if (vidEl.readyState >= 1) {
        restoreVidState();
      } else {
        vidEl.onloadedmetadata = restoreVidState;
      }
    }
    if (info) {
      var countStr = (index + 1) + ' / ' + galleryState.videoItems.length;
      info.textContent = countStr + ' | Video';
    }
    autoBalanceFullscreenSplitRatio();
  }).catch(function(e) { console.warn('renderActiveVideo failed:', e); });
}

// ---------- animation-mode helpers ------------------------------------
// applyVideoPaneMode toggles the video pane controls for the two playback
// modes. Real video shows the <video> plus the seeker/time bar; animated
// images (GIF/WebP) switch to the <img> element and cannot seek, pause or
// play audio, so the seeker/time bar and the volume control are hidden and
// the play button becomes a replay trigger.
function applyVideoPaneMode(isAnim) {
  var vidEl = document.getElementById('gallery-main-video');
  var animEl = document.getElementById('gallery-main-anim');
  if (vidEl) vidEl.style.display = isAnim ? 'none' : '';
  if (animEl) animEl.style.display = isAnim ? 'block' : 'none';
  var ctrl = document.getElementById('gallery-video-ctrl');
  if (ctrl) ctrl.style.display = isAnim ? 'none' : '';
  var volWrap = document.querySelector('.gallery-vol-wrapper');
  if (volWrap) volWrap.style.display = isAnim ? 'none' : '';
  if (isAnim) {
    var playBtn = document.getElementById('gallery-vid-play');
    if (playBtn) playBtn.innerHTML = GALLERY_ICONS.play;
  }
}

// replayAnim restarts the animated image by re-setting its src. Chromium
// restarts GIF/WebP animation when the src attribute is re-applied; removing
// it first and forcing a reflow guarantees a restart even when the URL is
// unchanged (assigning the same src to a fully loaded <img> is a no-op).
function replayAnim() {
  var el = document.getElementById('gallery-main-anim');
  if (!el) return;
  var s = el.getAttribute('src') || galleryState.videoURL || '';
  if (!s) return;
  el.removeAttribute('src');
  void el.offsetWidth; // force reflow so the re-set src restarts the animation
  el.setAttribute('src', s);
  galleryState.videoPlayingState = true;
}

// stopAnim clears the animated image's src — its only "pause": the browser
// keeps looping while src is present and offers no frame-level pause API.
// videoPlayingState only records the "should autoplay on load" intent; false
// here does NOT mean the image is paused.
function stopAnim() {
  var el = document.getElementById('gallery-main-anim');
  if (el) el.removeAttribute('src');
  galleryState.videoPlayingState = false;
  var playBtn = document.getElementById('gallery-vid-play');
  if (playBtn) playBtn.innerHTML = GALLERY_ICONS.play;
}

function bindVideoControls() {
  var vidEl = document.getElementById('gallery-main-video');
  var animEl = document.getElementById('gallery-main-anim');
  var seeker = document.getElementById('gallery-video-seeker');
  var playBtn = document.getElementById('gallery-vid-play');
  var stopBtn = document.getElementById('gallery-vid-stop');
  var volSlider = document.getElementById('gallery-vol-slider');
  var timeTxt = document.getElementById('gallery-vid-time');
  var infoTxt = document.getElementById('gallery-vid-info');

  if (!vidEl && !animEl) return;

  if (animEl) {
    // An animated image reports its natural size only after load; rebalance
    // the fullscreen split ratio once the dimensions are known.
    animEl.onload = function() {
      autoBalanceFullscreenSplitRatio();
    };
  }

  if (playBtn) {
    playBtn.onclick = function() {
      var curItem = galleryState.videoItems[galleryState.videoIndex];
      if (curItem && isAnimatedImg(curItem)) {
        // Animation mode has no real pause: play means replay (re-set src).
        replayAnim();
        return;
      }
      if (vidEl) {
        if (vidEl.paused) vidEl.play();
        else vidEl.pause();
      }
    };
  }
  if (stopBtn) {
    stopBtn.onclick = function() {
      var curItem = galleryState.videoItems[galleryState.videoIndex];
      if (curItem && isAnimatedImg(curItem)) {
        stopAnim();
        return;
      }
      vidEl.pause();
      vidEl.currentTime = 0;
      galleryState.videoPlayingState = false;
    };
  }
  vidEl.onplay = function() {
    galleryState.videoPlayingState = true;
    if (playBtn) playBtn.innerHTML = GALLERY_ICONS.pause;
  };
  vidEl.onpause = function() {
    galleryState.videoPlayingState = false;
    if (playBtn) playBtn.innerHTML = GALLERY_ICONS.play;
  };
  vidEl.onended = function() {
    galleryState.videoPlayingState = true;
    setVideoActive(galleryState.videoIndex + 1);
  };

  vidEl.ontimeupdate = function() {
    if (seeker && vidEl.duration) {
      seeker.value = (vidEl.currentTime / vidEl.duration) * 100;
    }
    if (timeTxt) {
      timeTxt.textContent = formatTime(vidEl.currentTime) + ' / ' + formatTime(vidEl.duration);
    }
  };

  vidEl.onloadedmetadata = function() {
    if (infoTxt) {
      infoTxt.textContent = vidEl.videoWidth + 'x' + vidEl.videoHeight;
    }
    if (timeTxt) {
      timeTxt.textContent = formatTime(vidEl.currentTime) + ' / ' + formatTime(vidEl.duration);
    }
    autoBalanceFullscreenSplitRatio();
  };

  if (seeker) {
    seeker.oninput = function() {
      if (vidEl.duration) {
        vidEl.currentTime = (seeker.value / 100) * vidEl.duration;
      }
    };
  }

  if (volSlider) {
    volSlider.oninput = function() {
      vidEl.volume = volSlider.value / 100;
    };
  }
}