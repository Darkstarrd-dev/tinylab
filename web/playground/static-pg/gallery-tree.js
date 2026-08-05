// gallery-tree.js — Gallery directory tree, navigation, thumbnails, and image render.

'use strict';

// ---------- directory tree & folder navigation helpers -------------
function getDirPath(itemPath) {
  if (!itemPath) return 'Root';
  var parts = itemPath.split('/');
  if (parts.length <= 1) return 'Root';
  parts.pop();
  return parts.join('/') || 'Root';
}

function updateDirStructure() {
  galleryState.dirMap = {};
  galleryState.dirPathList = [];
  for (var i = 0; i < galleryState.items.length; i++) {
    var item = galleryState.items[i];
    var dir = getDirPath(item.path);
    if (!galleryState.dirMap[dir]) {
      galleryState.dirMap[dir] = [];
      galleryState.dirPathList.push(dir);
    }
    galleryState.dirMap[dir].push(i);
  }
  renderTreePanel();
}

function toggleTreePanel() {
  // In split mode, detect which pane actually has DOM focus (via Tab or
  // button clicks) and sync galleryState.focus before toggling. This
  // prevents the "press T twice" issue where the logical focus lags
  // behind the DOM focus.
  if (galleryState.viewMode === 'split') {
    var ae = document.activeElement;
    if (ae) {
      var vidPane = document.getElementById('gallery-pane-video');
      var imgPane = document.getElementById('gallery-pane-image');
      if (vidPane && vidPane.contains(ae) && galleryState.focus !== 'video') {
        galleryState.focus = 'video';
        updateFocusUIOnly();
      } else if (imgPane && imgPane.contains(ae) && galleryState.focus !== 'image') {
        galleryState.focus = 'image';
        updateFocusUIOnly();
      }
    }
  }
  galleryState.treeOpen = !galleryState.treeOpen;
  var isVidActive = (galleryState.viewMode === 'split') ? (galleryState.focus === 'video') : (galleryState.mediaType === 'video');
  var activeTreeId = isVidActive ? 'gallery-video-tree-panel' : 'gallery-tree-panel';
  var activeBtnId = isVidActive ? 'gallery-vid-tree-btn' : 'gallery-tree-btn';

  var panel = document.getElementById(activeTreeId);
  var btn = document.getElementById(activeBtnId);

  if (panel) panel.classList.toggle('hidden', !galleryState.treeOpen);
  if (btn) btn.classList.toggle('active', galleryState.treeOpen);
  renderTreePanel();
}

function renderTreePanel() {
  var isVidActive = (galleryState.viewMode === 'split') ? (galleryState.focus === 'video') : (galleryState.mediaType === 'video');
  var panel = document.getElementById(isVidActive ? 'gallery-video-tree-panel' : 'gallery-tree-panel');
  if (!panel) panel = document.getElementById('gallery-tree-panel');
  if (!panel) return;

  var rs = galleryState.reviewState;
  var headerHTML = '';

  if (!isVidActive && rs.selectMode) {
    // 1. 节点选择模式 Header
    var allSelected = galleryState.dirPathList.length > 0 && rs.selectedNodes.length >= galleryState.dirPathList.length;
    var toggleLabel = allSelected ? (T('galleryReviewDeselect') || 'Deselect') : (T('galleryReviewSelectAll') || 'Select All');
    headerHTML = '<div class="gallery-tree-header">' +
      '<button class="gallery-tree-clear-btn" type="button" id="gallery-review-toggle-all-btn">' + escapeHtml(toggleLabel) + '</button>' +
      '<button class="gallery-tree-clear-btn gallery-review-start-active" type="button" id="gallery-review-start-selected-btn">' + escapeHtml(T('galleryReviewStartSelected') || 'Start') + '</button>' +
      '<button class="gallery-tree-clear-btn" type="button" id="gallery-review-cancel-select-btn">' + escapeHtml(T('cancel') || 'Cancel') + '</button>' +
      '</div>';
  } else if (!isVidActive && rs.active) {
    // 2. 审核中/已完成 Header
    headerHTML = '<div class="gallery-tree-header">' +
      '<button class="gallery-tree-clear-btn" type="button" id="gallery-review-exit-btn" data-tooltip="' + escapeHtml(T('cancel') || 'Cancel') + '">' + escapeHtml(T('cancel') || 'Cancel') + '</button>' +
      '</div>';
  } else {
    // 3. 标准 Header
    headerHTML = '<div class="gallery-tree-header">' +
      '<button class="gallery-tree-clear-btn" type="button" data-tooltip="' + T('galleryClearTitle') + '">' + T('galleryClear') + '</button>' +
      (isVidActive ? '' : '<button class="gallery-tree-clear-btn' + (rs.selectMode ? ' active' : '') + '" type="button" id="gallery-ai-review-btn" data-tooltip="' + T('galleryReviewBtn') + '">' + T('galleryReviewBtn') + '</button>') +
      '</div>';
  }

  var contentHTML = '';
  var needVideoNodeBinding = false;
  var needImageNodeBinding = false;

  if (isVidActive) {
    if (!galleryState.videoItems || !galleryState.videoItems.length) {
      contentHTML = '<div style="padding:10px;font-size:12px;color:var(--text-muted)">No Videos</div>';
    } else {
      // Check if all videos are in root
      var hasDirs = false;
      for (var v = 0; v < galleryState.videoItems.length; v++) {
        if ((galleryState.videoItems[v].path || '').indexOf('/') !== -1) {
          hasDirs = true;
          break;
        }
      }

      var html = '';
      if (!hasDirs) {
        // Flat list of individual video files
        for (var i = 0; i < galleryState.videoItems.length; i++) {
          var item = galleryState.videoItems[i];
          var vName = item.name || item.path || ('Video ' + (i + 1));
          var isAct = (i === galleryState.videoIndex) ? ' active' : '';
          html += '<div class="gallery-tree-node' + isAct + '" data-vid-idx="' + i + '" style="padding-left:8px" data-tooltip="' + escapeHtml(vName) + '">' +
                    '<span class="tree-icon">🎬</span>' +
                    '<span class="tree-name">' + escapeHtml(vName) + '</span>' +
                  '</div>';
        }
      } else {
        // Grouped by directory with individual video items
        var vDirMap = {};
        var vDirList = [];
        for (var j = 0; j < galleryState.videoItems.length; j++) {
          var vp = galleryState.videoItems[j].path || '';
          var parts = vp.split('/');
          var dPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
          if (!vDirMap[dPath]) {
            vDirMap[dPath] = [];
            vDirList.push(dPath);
          }
          vDirMap[dPath].push(j);
        }

        for (var d = 0; d < vDirList.length; d++) {
          var dirKey = vDirList[d];
          var vIndices = vDirMap[dirKey];
          if (dirKey) {
            var dParts = dirKey.split('/');
            var dName = dParts[dParts.length - 1];
            var dIndent = (dParts.length - 1) * 12 + 8;
            html += '<div class="gallery-tree-node tree-folder-node" style="padding-left:' + dIndent + 'px;font-weight:600" data-tooltip="' + escapeHtml(dirKey) + '">' +
                      '<span class="tree-icon">📁</span>' +
                      '<span class="tree-name">' + escapeHtml(dName) + '</span>' +
                      '<span class="tree-count">' + vIndices.length + '</span>' +
                    '</div>';
          }
          var fileIndent = (dirKey ? dirKey.split('/').length * 12 : 0) + 8;
          for (var k = 0; k < vIndices.length; k++) {
            var vIdx = vIndices[k];
            var vItem = galleryState.videoItems[vIdx];
            var fName = vItem.name || (vItem.path ? vItem.path.split('/').pop() : ('Video ' + (vIdx + 1)));
            var vAct = (vIdx === galleryState.videoIndex) ? ' active' : '';
            html += '<div class="gallery-tree-node' + vAct + '" data-vid-idx="' + vIdx + '" style="padding-left:' + fileIndent + 'px" data-tooltip="' + escapeHtml(fName) + '">' +
                      '<span class="tree-icon">🎬</span>' +
                      '<span class="tree-name">' + escapeHtml(fName) + '</span>' +
                    '</div>';
          }
        }
      }
      contentHTML = html;
      needVideoNodeBinding = true;
    }
  } else {
    // Image & Zip Tree rendering
    if (!galleryState.items || !galleryState.items.length) {
      contentHTML = '<div style="padding:10px;font-size:12px;color:var(--text-muted)">No Images</div>';
    } else {
      // Build hierarchical tree structure for images & zips
      var treeMap = {};
      var treeOrder = [];

      for (var idx = 0; idx < galleryState.items.length; idx++) {
        var itemPath = galleryState.items[idx].path || '';
        var segs = itemPath.split('/');
        if (segs.length > 1) {
          segs.pop(); // Remove filename
          var fullDir = segs.join('/');
          var acc = '';
          for (var s = 0; s < segs.length; s++) {
            var seg = segs[s];
            acc = acc ? (acc + '/' + seg) : seg;
            if (!treeMap[acc]) {
              treeMap[acc] = { key: acc, name: seg, count: 0, firstIndex: idx, level: s };
              treeOrder.push(acc);
            }
          }
          if (treeMap[fullDir]) {
            treeMap[fullDir].count++;
          }
        } else {
          // Direct root images
          if (!treeMap['']) {
            treeMap[''] = { key: '', name: 'Root', count: 0, firstIndex: idx, level: 0 };
            treeOrder.unshift('');
          }
          treeMap[''].count++;
        }
      }

      var htmlImg = '';
      for (var t = 0; t < treeOrder.length; t++) {
        var tKey = treeOrder[t];
        var node = treeMap[tKey];
        var indent = node.level * 12 + 8;
        var icon = '📁';
        if (isZipName(node.name) || tKey.indexOf('.zip/') !== -1 || isZipName(tKey)) {
          icon = '📦';
        } else if (tKey === '') {
          icon = '🖼';
        }

        if (rs.selectMode) {
          // A) 节点选择模式
          var isSelected = rs.selectedNodes.indexOf(tKey) >= 0;
          var checkIcon = isSelected ? '☑' : '☐';
          htmlImg += '<div class="gallery-tree-node' + (isSelected ? ' review-selected' : '') + '" data-dir="' + escapeHtml(tKey) + '" data-select-node="true" style="padding-left:' + indent + 'px" data-tooltip="' + escapeHtml(tKey || 'Root') + '">' +
                       '<span class="tree-select-check">' + checkIcon + '</span>' +
                       '<span class="tree-icon">' + icon + '</span>' +
                       '<span class="tree-name">' + escapeHtml(node.name) + '</span>' +
                       '<span class="tree-count">' + node.count + '</span>' +
                     '</div>';
        } else if (rs.active) {
          // B) 审核模式（运行中/已完成）
          var nStatus = rs.nodeStatus[tKey] || '';
          var nMatches = (rs.nodeResults[tKey] || []).length;
          var isFocusedNode = (tKey === rs.focusedReviewNode) ? ' active' : '';

          var statusIcon = icon;
          if (nStatus === 'running') statusIcon = '⏳';
          else if (nStatus === 'completed') statusIcon = (nMatches > 0 ? '⚠️' : '✓');
          else if (nStatus === 'pending') statusIcon = '⏸';

          if (rs.selectedNodes.indexOf(tKey) >= 0 || nStatus) {
            htmlImg += '<div class="gallery-tree-node' + isFocusedNode + '" data-dir="' + escapeHtml(tKey) + '" data-review-node="true" style="padding-left:' + indent + 'px" data-tooltip="' + escapeHtml(tKey || 'Root') + '">' +
                         '<span class="tree-icon">' + statusIcon + '</span>' +
                         '<span class="tree-name">' + escapeHtml(node.name) + '</span>' +
                         '<span class="tree-count">' + (nMatches > 0 ? nMatches : '') + '</span>' +
                       '</div>';
          }
        } else {
          // C) 标准模式
          var isActive = (tKey === galleryState.curDirPath) ? ' active' : '';
          htmlImg += '<div class="gallery-tree-node' + isActive + '" data-dir="' + escapeHtml(tKey) + '" data-first-idx="' + node.firstIndex + '" style="padding-left:' + indent + 'px" data-tooltip="' + escapeHtml(tKey || 'Root') + '">' +
                       '<span class="tree-icon">' + icon + '</span>' +
                       '<span class="tree-name">' + escapeHtml(node.name) + '</span>' +
                       '<span class="tree-count">' + node.count + '</span>' +
                     '</div>';
        }
      }
      contentHTML = htmlImg;
      needImageNodeBinding = true;
    }
  }

  panel.innerHTML = headerHTML + contentHTML;

  // ---- AI Review Section ----
  if (typeof window.renderReviewPanel === 'function' && !isVidActive) {
    window.renderReviewPanel(panel);
    var reviewSection = document.getElementById('gallery-review-section');
    if (reviewSection) {
      reviewSection.style.display = rs.reviewOpen ? '' : 'none';
    }
  }

  // 绑定 Header 按钮事件
  if (!isVidActive && rs.selectMode) {
    // 全选 / 取消全选
    var toggleBtn = panel.querySelector('#gallery-review-toggle-all-btn');
    if (toggleBtn) {
      toggleBtn.onclick = function(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        if (rs.selectedNodes.length >= galleryState.dirPathList.length) {
          rs.selectedNodes = [];
        } else {
          rs.selectedNodes = galleryState.dirPathList.slice();
        }
        rs.lastSelectedNode = null;
        renderTreePanel();
      };
    }
    // Start -> 打开审核配置面板
    var startSelBtn = panel.querySelector('#gallery-review-start-selected-btn');
    if (startSelBtn) {
      startSelBtn.onclick = function(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        if (!rs.selectedNodes.length) {
          showMsg(T('galleryReviewNoNodeSelected') || 'Please select at least one node');
          return;
        }
        rs.reviewOpen = true;
        renderReviewPanel();
      };
    }
    // Cancel -> 退出选择模式并收起面板
    var cancelSelBtn = panel.querySelector('#gallery-review-cancel-select-btn');
    if (cancelSelBtn) {
      cancelSelBtn.onclick = function(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        rs.selectMode = false;
        rs.reviewOpen = false;
        rs.selectedNodes = [];
        rs.lastSelectedNode = null;
        renderTreePanel();
      };
    }
  } else if (!isVidActive && rs.active) {
    // 退出审核模式
    var exitBtn = panel.querySelector('#gallery-review-exit-btn');
    if (exitBtn) {
      exitBtn.onclick = function(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        if (typeof window.resetReview === 'function') window.resetReview();
      };
    }
  } else {
    // 标准 Clear 按钮
    var clearBtn = panel.querySelector('.gallery-tree-clear-btn');
    if (clearBtn) clearBtn.onclick = function(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      clearActiveSideTree();
    };

    // AI Review 按钮 -> 点击同时展开面板并进入节点选择模式
    var aiBtn = panel.querySelector('#gallery-ai-review-btn');
    if (aiBtn) aiBtn.onclick = function(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      rs.selectMode = true;
      rs.reviewOpen = true;
      if (!rs.selectedNodes.length && galleryState.dirPathList.length) {
        // 默认全选所有节点
        rs.selectedNodes = galleryState.dirPathList.slice();
      }
      renderTreePanel();
    };
  }

  if (needVideoNodeBinding) {
    var vNodes = panel.querySelectorAll('[data-vid-idx]');
    vNodes.forEach(function(node) {
      node.onclick = function(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        var idx = parseInt(node.getAttribute('data-vid-idx'), 10);
        if (!isNaN(idx)) setVideoActive(idx);
      };
    });
  }

  if (needImageNodeBinding) {
    if (rs.selectMode) {
      // 节点选择模式下的点击事件
      var selNodes = panel.querySelectorAll('[data-select-node]');
      selNodes.forEach(function(node) {
        node.onclick = function(e) {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          var dir = node.getAttribute('data-dir');
          if (dir === null) return;

          if (e.shiftKey && rs.lastSelectedNode !== null) {
            // Shift 范围选择
            var startIdx = galleryState.dirPathList.indexOf(rs.lastSelectedNode);
            var endIdx = galleryState.dirPathList.indexOf(dir);
            if (startIdx >= 0 && endIdx >= 0) {
              var lo = Math.min(startIdx, endIdx);
              var hi = Math.max(startIdx, endIdx);
              for (var s = lo; s <= hi; s++) {
                var d = galleryState.dirPathList[s];
                if (rs.selectedNodes.indexOf(d) < 0) rs.selectedNodes.push(d);
              }
            }
          } else {
            // 单击切换
            var pos = rs.selectedNodes.indexOf(dir);
            if (pos >= 0) rs.selectedNodes.splice(pos, 1);
            else rs.selectedNodes.push(dir);
            rs.lastSelectedNode = dir;
          }
          renderTreePanel();
        };
      });
    } else if (rs.active) {
      // 审核模式下的节点点击（切换显示该节点的匹配缩略图）
      var revNodes = panel.querySelectorAll('[data-review-node]');
      revNodes.forEach(function(node) {
        node.onclick = function(e) {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          var dir = node.getAttribute('data-dir');
          if (dir !== null && typeof window.showReviewNodeThumbnails === 'function') {
            window.showReviewNodeThumbnails(dir);
            renderTreePanel();
          }
        };
      });
    } else {
      // 标准模式节点点击
      var imgNodes = panel.querySelectorAll('[data-first-idx]');
      imgNodes.forEach(function(node) {
        node.onclick = function(e) {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          var dir = node.getAttribute('data-dir');
          var targetIdx = -1;
          if (dir !== null && galleryState.dirMap[dir] && galleryState.dirMap[dir].length) {
            targetIdx = galleryState.dirMap[dir][0];
          } else {
            var fIdx = parseInt(node.getAttribute('data-first-idx'), 10);
            if (!isNaN(fIdx)) targetIdx = fIdx;
          }
          if (targetIdx >= 0) setActive(targetIdx);
        };
      });
    }
  }
}

// releaseZipSessions fires best-effort DELETE /api/gallery/zip/{sessionId} for
// every distinct zip session referenced by removedItems, skipping any session
// still referenced by a surviving item (so sibling entries of the same pack
// keep their session alive). Fire-and-forget: errors are swallowed (the
// session may already be evicted) and the UI never blocks on this.
function releaseZipSessions(removedItems) {
  if (!removedItems || !removedItems.length) return;
  var sids = {};
  for (var i = 0; i < removedItems.length; i++) {
    var it = removedItems[i];
    if (it && it.kind === 'zip' && it.sessionId) sids[it.sessionId] = true;
  }
  if (!Object.keys(sids).length) return;
  var alive = {};
  var survivors = (galleryState.items || []).concat(galleryState.videoItems || []);
  for (var j = 0; j < survivors.length; j++) {
    var s = survivors[j];
    if (s && s.kind === 'zip' && s.sessionId) alive[s.sessionId] = true;
  }
  for (var sid in sids) {
    if (alive[sid]) continue;
    var url = '/api/gallery/zip/' + encodeURIComponent(sid);
    fetch(url, { method: 'DELETE' }).catch(function() { /* already evicted */ });
  }
}

function clearActiveSideTree() {
  var isVidActive = (galleryState.viewMode === 'split') ? (galleryState.focus === 'video') : (galleryState.mediaType === 'video');

  if (isVidActive) {
    for (var i = 0; i < galleryState.videoItems.length; i++) {
      var vi = galleryState.videoItems[i];
      if (vi && vi.mainURL && String(vi.mainURL).indexOf('blob:') === 0) FsApi.BlobTracker.revoke(vi.mainURL);
      if (vi && vi.thumbURL && String(vi.thumbURL).indexOf('blob:') === 0) FsApi.BlobTracker.revoke(vi.thumbURL);
    }
    galleryState.videoItems = [];
    galleryState.videoIndex = -1;
    galleryState.videoURL = null;
    galleryState.videoPlayingState = false;
    galleryState.videoCurDirPath = '';
    galleryState.videoDirMap = {};
    galleryState.videoDirPathList = [];
    galleryState.currentVideoFolderIndices = [];
    galleryState.currentVideoSubIndex = -1;
    var vidEl = document.getElementById('gallery-main-video');
    if (vidEl) {
      try { vidEl.pause(); } catch (e2) {}
      vidEl.removeAttribute('src');
      try { vidEl.load(); } catch (e3) {}
    }
    var animEl = document.getElementById('gallery-main-anim');
    if (animEl) animEl.removeAttribute('src');
    var vPath = document.getElementById('gallery-video-path') || document.getElementById('gallery-path');
    var vInfo = document.getElementById('gallery-video-info') || document.getElementById('gallery-info');
    if (vPath) { vPath.textContent = '-'; vPath.removeAttribute('data-tooltip'); }
    if (vInfo) vInfo.textContent = '0 / 0 | Video';
    renderTreePanel();
    return;
  }

  var cleared = galleryState.items.slice();
  for (var j = 0; j < cleared.length; j++) {
    var im = cleared[j];
    if (im && im.mainURL && String(im.mainURL).indexOf('blob:') === 0) FsApi.BlobTracker.revoke(im.mainURL);
    if (im && im.thumbURL && String(im.thumbURL).indexOf('blob:') === 0) FsApi.BlobTracker.revoke(im.thumbURL);
  }
  galleryState.items = [];
  // Free the backend zip sessions of the cleared packs immediately (no
  // surviving items reference them, so all are released).
  releaseZipSessions(cleared);
  galleryState.index = -1;
  galleryState.mainURL = null;
  galleryState.curDirPath = '';
  galleryState.dirMap = {};
  galleryState.dirPathList = [];
  galleryState.currentFolderIndices = [];
  galleryState.currentSubIndex = -1;
  updateDirStructure();
  renderThumbnails();
  renderActive(-1);
  renderTreePanel();
}

function updateCurrentFolderItems(index) {
  if (index < 0 || index >= galleryState.items.length) {
    galleryState.curDirPath = '';
    if (!galleryState.reviewState.active) {
      galleryState.currentFolderIndices = [];
    }
    galleryState.currentSubIndex = -1;
    return;
  }
  var item = galleryState.items[index];
  var dir = getDirPath(item.path);
  var prevDir = galleryState.curDirPath;
  galleryState.curDirPath = dir;

  if (galleryState.reviewState.active) {
    // 审核模式：维持当前节点的匹配索引列表 currentFolderIndices 不被重置为全量文件
    var revIndices = galleryState.currentFolderIndices || [];
    galleryState.currentSubIndex = revIndices.indexOf(index);
  } else {
    // 标准模式：更新当前文件夹的包含项列表
    var indices = galleryState.dirMap[dir] || [index];
    galleryState.currentFolderIndices = indices;
    galleryState.currentSubIndex = indices.indexOf(index);

    if (prevDir !== dir) {
      renderThumbnails();
    }
  }

  var panel = document.getElementById('gallery-tree-panel');
  if (panel) {
    var nodes = panel.querySelectorAll('.gallery-tree-node');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var isAct = (n.getAttribute('data-dir') === dir);
      n.classList.toggle('active', isAct);
      if (isAct && galleryState.treeOpen) {
        n.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }
}

function goPrevFolder() {
  if (!galleryState.dirPathList.length) return;
  var curIdx = galleryState.dirPathList.indexOf(galleryState.curDirPath);
  var targetIdx = (curIdx > 0) ? curIdx - 1 : galleryState.dirPathList.length - 1;
  var targetDir = galleryState.dirPathList[targetIdx];
  if (targetDir && galleryState.dirMap[targetDir] && galleryState.dirMap[targetDir].length) {
    setActive(galleryState.dirMap[targetDir][0]);
  }
}

function goNextFolder() {
  if (!galleryState.dirPathList.length) return;
  var curIdx = galleryState.dirPathList.indexOf(galleryState.curDirPath);
  var targetIdx = (curIdx >= 0) ? (curIdx + 1) % galleryState.dirPathList.length : 0;
  var targetDir = galleryState.dirPathList[targetIdx];
  if (targetDir && galleryState.dirMap[targetDir] && galleryState.dirMap[targetDir].length) {
    setActive(galleryState.dirMap[targetDir][0]);
  }
}

function renderThumbnails() {
  var wrap = document.getElementById('gallery-thumbnails');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (galleryState.thumbObserver) {
    galleryState.thumbObserver.disconnect();
    galleryState.thumbObserver = null;
  }
  if (!galleryState.currentFolderIndices || !galleryState.currentFolderIndices.length) return;

  galleryState.thumbObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(en) {
      if (en.isIntersecting) {
        var idx = parseInt(en.target.dataset.idx, 10);
        var item = galleryState.items[idx];
        if (item && !item.thumbReady) ensureThumb(item);
      }
    });
  }, { root: wrap, rootMargin: '120px' });

  for (var k = 0; k < galleryState.currentFolderIndices.length; k++) {
    (function(idx) {
      var item = galleryState.items[idx];
      if (!item) return;
      var div = document.createElement('div');
      div.className = 'gallery-thumb' + (idx === galleryState.index ? ' active' : '');
      if (item.markedForDeletion) div.classList.add('thumb-marked-for-deletion');
      div.dataset.idx = String(idx);
      var img = document.createElement('img');
      img.className = 'gallery-thumb-img';
      img.alt = '';
      item.thumbImgEl = img;
      div.appendChild(img);
      div.addEventListener('click', function() { setActive(idx); });
      wrap.appendChild(div);
      item.thumbDivEl = div;
      galleryState.thumbObserver.observe(div);
      if (item.thumbURL) img.src = item.thumbURL;
    })(galleryState.currentFolderIndices[k]);
  }
}

function renderActive(index) {
  var item = galleryState.items[index];
  var imgEl = document.getElementById('gallery-main-img');
  var pathEl = document.getElementById('gallery-path');
  var info = document.getElementById('gallery-info');
  var empty = document.getElementById('gallery-empty');

  updateCurrentFolderItems(index);

  // highlight active thumb
  if (galleryState.currentFolderIndices) {
    for (var i = 0; i < galleryState.currentFolderIndices.length; i++) {
      var idx = galleryState.currentFolderIndices[i];
      if (galleryState.items[idx] && galleryState.items[idx].thumbDivEl) {
        galleryState.items[idx].thumbDivEl.classList.toggle('active', idx === index);
      }
    }
  }
  if (item && item.thumbDivEl) {
    item.thumbDivEl.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  if (!item) {
    updateDeleteOverlay(null);
    if (imgEl) imgEl.removeAttribute('src');
    if (pathEl) { pathEl.textContent = '-'; pathEl.removeAttribute('data-tooltip'); }
    if (info) info.textContent = '0 / 0';
    if (empty) empty.style.display = '';
    return;
  }

  updateDeleteOverlay(item);

  var displayPath = item.path || item.name || '';
  if (pathEl) {
    pathEl.textContent = displayPath;
    pathEl.setAttribute('data-tooltip', displayPath);
  }

  ensureMainSrc(item).then(function() {
    if (imgEl && item.mainURL) {
      galleryState.mainURL = item.mainURL;
      imgEl.onload = function() { autoBalanceFullscreenSplitRatio(); };
      imgEl.src = item.mainURL;
      if (empty) empty.style.display = 'none';
    }
    var subIdx = (galleryState.currentSubIndex >= 0) ? (galleryState.currentSubIndex + 1) : 0;
    var totalFolder = galleryState.currentFolderIndices ? galleryState.currentFolderIndices.length : 0;
    var countStr = subIdx + ' / ' + totalFolder;
    if (info) info.textContent = countStr + ' | Loading...';
    updateInfo(item, info, countStr);
    autoBalanceFullscreenSplitRatio();
  }).catch(function(e) { console.warn('renderActive failed:', e); });
}

function updateInfo(item, info, countStr) {
  getItemBlob(item).then(function(blob) {
    if (!blob) return;
    item.size = blob.size;
    var sizeStr = prettySize(blob.size);
    createImageBitmap(blob).then(function(bmp) {
      var dim = bmp.width + 'x' + bmp.height;
      bmp.close && bmp.close();
      if (info) info.textContent = countStr + ' | ' + dim + ' | ' + sizeStr;
    }).catch(function() {
      if (info) info.textContent = countStr + ' | ? | ' + sizeStr;
    });
  }).catch(function() {
    if (info) info.textContent = countStr;
  });
}

function setActive(index) {
  if (!galleryState.items.length) return;
  if (index < 0) index = galleryState.items.length - 1;
  if (index >= galleryState.items.length) index = 0;
  // Revoke previous item's mainURL to prevent blob URL leaks during autoplay
  var prevIndex = galleryState.index;
  if (prevIndex >= 0 && prevIndex < galleryState.items.length) {
    var prev = galleryState.items[prevIndex];
    if (prev && prev.mainURL && prev.mainURL.indexOf('blob:') === 0) {
      FsApi.BlobTracker.revoke(prev.mainURL);
      prev.mainURL = null;
    }
  }
  galleryState.index = index;
  // Point the shared zipSessionId at the currently-viewed pack (AI Review and
  // the getItemBlob fallback read it) and bump the session's LRU position so
  // the viewed pack resists eviction. Fire-and-forget the touch; a 404 just
  // means rehydrateZipSession will recreate it on next entry fetch.
  var cur = galleryState.items[index];
  if (cur && cur.kind === 'zip' && cur.sessionId) {
    galleryState.zipSessionId = cur.sessionId;
    fetch('/api/gallery/zip/' + encodeURIComponent(cur.sessionId) + '/touch', { method: 'POST' }).catch(function() {});
  }
  renderActive(index);
}

// ---------- deletion interactions ------------------------------------------

// updateDeleteOverlay toggles the red overlay on the main image based on the
// item's markedForDeletion flag.
function updateDeleteOverlay(item) {
  var overlay = document.getElementById('gallery-delete-overlay');
  if (!overlay) return;
  if (item && item.markedForDeletion) {
    overlay.classList.add('active');
  } else {
    overlay.classList.remove('active');
  }
}

// deleteItemMark marks the current item for deletion, shows a red overlay, and
// advances to the next item after a brief delay (300ms) so the user can
// perceive the mark. If the current item is the last one, it stays in place.
function deleteItemMark() {
  // Del 对视频无效
  var isVidActive = (galleryState.viewMode === 'split') ? (galleryState.focus === 'video') : (galleryState.mediaType === 'video');
  if (isVidActive) return;
  if (!galleryState.items.length) return;
  if (galleryState._markAdvanceTimer) return; // block during transition
  var idx = galleryState.index;
  var item = galleryState.items[idx];
  if (!item) return;
  // Set true (mark — not a toggle; subsequent tasks may add unmark via Shift+Del)
  item.markedForDeletion = true;
  updateDeleteOverlay(item);
  if (item.thumbDivEl) item.thumbDivEl.classList.add('thumb-marked-for-deletion');
  // Advance to next item after a short delay, no wrap if last
  if (idx < galleryState.items.length - 1) {
    galleryState._markAdvanceTimer = setTimeout(function() {
      galleryState._markAdvanceTimer = null;
      // Only auto-advance if user hasn't manually navigated away
      if (galleryState.index === idx) setActive(idx + 1);
    }, 300);
  }
}

// removeItem removes the item at removedIndex from galleryState.items, revokes
// its blob URLs, adjusts the current index (no wrap-around), rebuilds the
// directory structure, and re-renders. Safe to call when the removed item is
// the current one (jumps to next, or stays at new last if was last).
function removeItem(removedIndex) {
  if (removedIndex < 0 || removedIndex >= galleryState.items.length) return;
  var item = galleryState.items[removedIndex];
  // Revoke blob URLs of the removed item
  if (item) {
    if (item.mainURL && item.mainURL.indexOf('blob:') === 0) FsApi.BlobTracker.revoke(item.mainURL);
    if (item.thumbURL && item.thumbURL.indexOf('blob:') === 0) FsApi.BlobTracker.revoke(item.thumbURL);
  }
  // Splice
  galleryState.items.splice(removedIndex, 1);
  // Release the backend zip session if no surviving item still references it.
  if (item && item.kind === 'zip') releaseZipSessions([item]);
  // Adjust current index (no wrap)
  var cur = galleryState.index;
  if (removedIndex < cur) {
    galleryState.index = cur - 1;
  } else if (removedIndex === cur) {
    // Was viewing the removed one: stay at same index (now points to next),
    // or clamp to new last if beyond end.
    if (galleryState.index >= galleryState.items.length) {
      galleryState.index = galleryState.items.length - 1; // -1 if empty
    }
  }
  // removedIndex > cur: index unchanged
  // Rebuild dir structure + re-render
  updateDirStructure();
  if (galleryState.items.length === 0) {
    // empty state: renderActive(0) handles empty via the !item guard
    galleryState.index = -1;
    renderActive(0);
  } else {
    var ni = Math.max(0, Math.min(galleryState.index, galleryState.items.length - 1));
    galleryState.index = ni;
    renderActive(ni);
  }
  renderThumbnails();
  renderTreePanel();
}

// removeItemsByFilter removes all items for which filterFn(item) returns true,
// revokes their blob URLs, adjusts the current index, rebuilds the directory
// structure, and re-renders. If the current item is among the removed, the
// index moves to the next surviving item (or clamps to the new last).
function removeItemsByFilter(filterFn) {
  var removed = [];
  var kept = [];
  for (var i = 0; i < galleryState.items.length; i++) {
    var it = galleryState.items[i];
    if (filterFn(it)) removed.push(it);
    else kept.push(it);
  }
  if (removed.length === 0) return 0;
  // Revoke blobs of removed items
  for (var j = 0; j < removed.length; j++) {
    var r = removed[j];
    if (r.mainURL && r.mainURL.indexOf('blob:') === 0) FsApi.BlobTracker.revoke(r.mainURL);
    if (r.thumbURL && r.thumbURL.indexOf('blob:') === 0) FsApi.BlobTracker.revoke(r.thumbURL);
  }
  // Determine current item's fate (by reference)
  var curItem = galleryState.items[galleryState.index];
  galleryState.items = kept;
  // Release backend zip sessions whose packs are fully removed (no kept item
  // still references them). Sibling entries of a partially-removed pack keep
  // their session alive. Must run after the splice so survivors are read from
  // the new galleryState.items.
  releaseZipSessions(removed);
  var newIdx = -1;
  if (curItem) {
    for (var k = 0; k < kept.length; k++) {
      if (kept[k] === curItem) { newIdx = k; break; }
    }
  }
  if (newIdx < 0) {
    // current was removed; clamp to the position it would occupy
    // (approximation: use min of old index and new length-1)
    newIdx = Math.min(galleryState.index, kept.length - 1);
  }
  galleryState.index = newIdx;
  updateDirStructure();
  if (kept.length === 0) {
    galleryState.index = -1;
    renderActive(0);
  } else {
    var ni = Math.max(0, Math.min(galleryState.index, kept.length - 1));
    galleryState.index = ni;
    renderActive(ni);
  }
  renderThumbnails();
  renderTreePanel();
  return removed.length;
}

// removeVideoItem removes the video at the given index from
// galleryState.videoItems, revokes its blob URLs, adjusts the video index,
// and re-renders the video area.
function removeVideoItem(removedIndex) {
  if (removedIndex < 0 || removedIndex >= galleryState.videoItems.length) return;
  var item = galleryState.videoItems[removedIndex];
  // Revoke blob URLs
  if (item) {
    if (item.mainURL && item.mainURL.indexOf('blob:') === 0) FsApi.BlobTracker.revoke(item.mainURL);
    if (item.thumbURL && item.thumbURL.indexOf('blob:') === 0) FsApi.BlobTracker.revoke(item.thumbURL);
  }
  // Splice
  galleryState.videoItems.splice(removedIndex, 1);
  // Adjust video index
  var cur = galleryState.videoIndex;
  if (removedIndex < cur) {
    galleryState.videoIndex = cur - 1;
  } else if (removedIndex === cur) {
    if (galleryState.videoIndex >= galleryState.videoItems.length) {
      galleryState.videoIndex = galleryState.videoItems.length - 1;
    }
  }
  // Re-render
  if (galleryState.videoItems.length === 0) {
    galleryState.videoIndex = -1;
    galleryState.videoURL = null;
    galleryState.videoPlayingState = false;
    var vidEl = document.getElementById('gallery-main-video');
    if (vidEl) {
      try { vidEl.pause(); } catch (e2) {}
      vidEl.removeAttribute('src');
      try { vidEl.load(); } catch (e3) {}
    }
    var animEl = document.getElementById('gallery-main-anim');
    if (animEl) animEl.removeAttribute('src');
    renderActiveVideo(-1);
  } else {
    var ni = Math.max(0, Math.min(galleryState.videoIndex, galleryState.videoItems.length - 1));
    galleryState.videoIndex = ni;
    renderActiveVideo(ni);
  }
  updateVideoDirStructure();
  renderTreePanel();
}

