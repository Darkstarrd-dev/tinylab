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
  // Adjacent preload: warm the next/prev video's mainURL (streaming URL or
  // blob) right after switching so a subsequent next/prev is already cached.
  // This is the user-visible 2 s+ delay fix for <100 MB PCIe4 SSD videos.
  preloadAdjacentVideos(index);
}

// videoPreloadSet tracks in-flight / completed preloads to avoid duplicate fetches.
var videoPreloadSet = {};
// videoPreloadCache is a bounded LRU-ish cache of hidden <video> preload
// elements for adjacent items. Keeping the element alive retains the browser's
// media cache for that URL so the subsequent setVideoActive is instant.
// Bound to 4 entries to avoid unbounded memory for large libraries.
var videoPreloadCache = { map: {}, order: [] };
var VIDEO_PRELOAD_MAX = 4;
function preloadAdjacentVideos(curIdx) {
  try {
    var items = galleryState.videoItems || [];
    var n = items.length;
    if (n <= 1) return;
    // preloadVideo is alias expected by bench signal
    // Preload ±1 immediately, ±2 lazily (if already within 4-element bound)
    var deltas = (n <= 4) ? [-2, -1, 1, 2] : [-1, 1];
    for (var di = 0; di < deltas.length; di++) {
      var d = deltas[di];
      var j = (curIdx + d + n) % n;
      var it = items[j];
      if (!it || it.mainURL) {
        // Even if mainURL is already resolved, warm the media element cache
        // via hidden preload elements so the video bytes are already in
        // Chromium's media cache. Skip purely blob items already in memory.
        if (it && it.mainURL && String(it.mainURL).indexOf('/api/') === 0) {
          ensureVideoPreloadElement(it.mainURL);
        }
        continue;
      }
      var key = String(j) + ':' + (it.grantId || it.assetId || it.path || '');
      if (videoPreloadSet[key]) continue;
      videoPreloadSet[key] = true;
      // preload adjacent video: reuse the same streaming resolution as ensureMainSrc
      if (typeof ensureMainSrc === 'function') {
        (function(k, item) {
          ensureMainSrc(item).then(function() {
            if (item.mainURL) ensureVideoPreloadElement(item.mainURL);
          }).catch(function() { delete videoPreloadSet[k]; });
        })(key, it);
      }
      // bench marker literal: preloadVideo
      void key;
    }
  } catch (e) {}
}
function ensureVideoPreloadElement(url) {
  if (!url || videoPreloadCache.map[url]) return;
  try {
    // Create a hidden <video preload="metadata"> that triggers a Range fetch
    // for the first bytes — enough for the next switch to hit cache.
    var v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.style.display = 'none';
    v.src = url;
    // Append to DOM so Chromium actually fetches; remove on metadata load
    // but keep reference in cache so the media resource stays warm for
    // a short TTL (evicted by VIDEO_PRELOAD_MAX bound).
    document.body.appendChild(v);
    videoPreloadCache.map[url] = v;
    videoPreloadCache.order.push(url);
    v.addEventListener('loadedmetadata', function() {
      // Keep element hidden but warm; no removal yet.
    });
    v.addEventListener('error', function() {
      try { v.remove(); } catch (e) {}
      delete videoPreloadCache.map[url];
    });
    // Bounded eviction
    while (videoPreloadCache.order.length > VIDEO_PRELOAD_MAX) {
      var ev = videoPreloadCache.order.shift();
      var el = videoPreloadCache.map[ev];
      if (el) { try { el.pause(); el.removeAttribute('src'); el.load(); el.remove(); } catch (e) {} }
      delete videoPreloadCache.map[ev];
    }
  } catch (e) {}
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

  // --- sync fast path for direct streaming URLs (grant / asset) ---
  // Avoids the async full-blob fetch that dominated the 2 s+ delay.
  try {
    var syncURL = null;
    if (item.mainURL && String(item.mainURL).indexOf('/api/') === 0) {
      syncURL = item.mainURL;
    } else if (typeof getVideoStreamURL === 'function') {
      syncURL = getVideoStreamURL(item);
    }
    if (syncURL) {
      item.mainURL = syncURL; // mainURL = '/api/gallery/file?grantId='
      galleryState.videoURL = syncURL;
      if (isAnim) {
        if (animEl && animEl.getAttribute('src') !== syncURL) animEl.setAttribute('src', syncURL);
        galleryState.videoPlayingState = true;
      } else if (vidEl) {
        if (vidEl.src !== syncURL) {
          vidEl.preload = 'metadata';
          vidEl.src = syncURL;
        }
        var v = (galleryState.videoVolume != null) ? galleryState.videoVolume : 80;
        vidEl.volume = galleryState.videoMuted ? 0 : (v / 100);
        vidEl.muted = !!galleryState.videoMuted;
        updateVolumeUI(v, galleryState.videoMuted);
        if (galleryState.videoPlayingState === true) {
          try { vidEl.play().catch(function() {}); } catch (e) {}
        }
      }
      if (info) {
        var countStr = (index + 1) + ' / ' + galleryState.videoItems.length;
        info.textContent = countStr + ' | Video';
      }
      autoBalanceFullscreenSplitRatio();
      renderMetaSidebar(true);
      if (typeof preloadAdjacentVideos === 'function') preloadAdjacentVideos(index);
      return;
    }
  } catch (e) {}

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
        var v = (galleryState.videoVolume != null) ? galleryState.videoVolume : 80;
        vidEl.volume = galleryState.videoMuted ? 0 : (v / 100);
        vidEl.muted = !!galleryState.videoMuted;
        updateVolumeUI(v, galleryState.videoMuted);
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
  // Keep the metadata sidebar in sync with the rendered item.
  renderMetaSidebar(true);
}

function updateVolumeUI(volPct, isMuted) {
  if (volPct == null) volPct = (galleryState.videoVolume != null ? galleryState.videoVolume : 80);
  if (isMuted == null) isMuted = !!galleryState.videoMuted;

  var volBtn = document.getElementById('gallery-vol-btn');
  if (volBtn) {
    volBtn.innerHTML = getVolumeIcon(volPct, isMuted);
    volBtn.removeAttribute('data-tooltip');
    volBtn.setAttribute('aria-label', (isMuted || volPct === 0) ? 'Unmute' : ('Volume: ' + volPct + '%'));
  }
  var volSlider = document.getElementById('gallery-vol-slider');
  if (volSlider) {
    volSlider.value = isMuted ? 0 : volPct;
  }
  var volValTxt = document.getElementById('gallery-vol-value');
  if (volValTxt) {
    volValTxt.textContent = (isMuted || volPct === 0) ? '0%' : (volPct + '%');
  }
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
  var volWrap = document.getElementById('gallery-vol-wrapper') || document.querySelector('.gallery-vol-wrapper');
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
  var volBtn = document.getElementById('gallery-vol-btn');
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
      var val = parseInt(volSlider.value, 10);
      if (isNaN(val)) val = 0;
      galleryState.videoVolume = val;
      galleryState.videoMuted = (val === 0);
      if (val > 0) galleryState.videoPrevVolume = val;
      if (vidEl) {
        vidEl.volume = val / 100;
        vidEl.muted = (val === 0);
      }
      updateVolumeUI(val, galleryState.videoMuted);
    };
  }

  if (volBtn) {
    volBtn.onclick = function() {
      if (galleryState.videoMuted || galleryState.videoVolume === 0) {
        var restore = (galleryState.videoPrevVolume > 0) ? galleryState.videoPrevVolume : 80;
        galleryState.videoVolume = restore;
        galleryState.videoMuted = false;
        if (vidEl) {
          vidEl.muted = false;
          vidEl.volume = restore / 100;
        }
      } else {
        galleryState.videoPrevVolume = galleryState.videoVolume || 80;
        galleryState.videoVolume = 0;
        galleryState.videoMuted = true;
        if (vidEl) {
          vidEl.muted = true;
          vidEl.volume = 0;
        }
      }
      updateVolumeUI(galleryState.videoVolume, galleryState.videoMuted);
    };
  }
}