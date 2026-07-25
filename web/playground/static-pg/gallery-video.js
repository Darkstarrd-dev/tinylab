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
  var pathEl = document.getElementById('gallery-video-path') || document.getElementById('gallery-path');
  var info = document.getElementById('gallery-video-info') || document.getElementById('gallery-info');

  if (!item) {
    if (vidEl) vidEl.removeAttribute('src');
    if (pathEl) { pathEl.textContent = '-'; pathEl.removeAttribute('data-tooltip'); }
    if (info) info.textContent = '0 / 0 | Video';
    return;
  }

  if (pathEl) {
    var displayPath = item.path || item.name || '';
    pathEl.textContent = displayPath;
    pathEl.setAttribute('data-tooltip', displayPath);
  }

  ensureMainSrc(item).then(function() {
    if (vidEl && item.mainURL) {
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

function bindVideoControls() {
  var vidEl = document.getElementById('gallery-main-video');
  var seeker = document.getElementById('gallery-video-seeker');
  var playBtn = document.getElementById('gallery-vid-play');
  var stopBtn = document.getElementById('gallery-vid-stop');
  var volSlider = document.getElementById('gallery-vol-slider');
  var timeTxt = document.getElementById('gallery-vid-time');
  var infoTxt = document.getElementById('gallery-vid-info');

  if (!vidEl) return;

  if (playBtn) {
    playBtn.onclick = function() {
      if (vidEl.paused) vidEl.play();
      else vidEl.pause();
    };
  }
  if (stopBtn) {
    stopBtn.onclick = function() {
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