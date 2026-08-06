// gallery-review.js — AI Review panel: preset management, prompt generation,
// model selection, review execution, and result filtering.
// This file is loaded after gallery-tree.js and provides window.renderReviewPanel().
// Backend: internal/api/gallery/review_engine.go + review_handlers.go.

'use strict';

// ---------- helpers shared with gallery-tree.js ----------------------------
// entryIndexToArrayIndex 将后端 Entry.Index 转换为 galleryState.items 数组索引。
function entryIndexToArrayIndex(entryIdx) {
  if (entryIdx == null) return -1;
  var items = galleryState.items || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i] && items[i].index === entryIdx) return i;
  }
  return -1;
}

// openReviewModelPicker 确保模型列表已加载后再打开选择器
function openReviewModelPicker(currentValue, onSelect, opts) {
  if (pgState && pgState.models && pgState.models.length) {
    pgOpenModelPicker(currentValue, onSelect, opts || {});
    return;
  }
  if (typeof pgLoadModels === 'function') {
    pgLoadModels().then(function() {
      pgOpenModelPicker(currentValue, onSelect, opts || {});
    });
  } else {
    pgOpenModelPicker(currentValue, onSelect, opts || {});
  }
}

// ---------- render ---------------------------------------------------------

window.renderReviewPanel = function(panel) {
  var old = document.getElementById('gallery-review-section');

  if (!panel && old) {
    panel = old.parentNode;
  }
  if (!panel) {
    panel = document.getElementById('gallery-tree-panel');
  }
  if (!panel) return;

  if (old) old.remove();

  var rs = galleryState.reviewState;
  var section = document.createElement('div');
  section.id = 'gallery-review-section';
  section.className = 'gallery-review-section';

  var html = '<div class="gallery-review-header">' + T('galleryReviewHeader') + '</div>';

  if (rs.active) {
    html += renderActivePanel(rs);
  } else {
    html += renderConfigPanel(rs);
  }

  section.innerHTML = html;
  panel.appendChild(section);

  if (!galleryState.reviewState.reviewOpen) {
    section.style.display = 'none';
  }

  bindReviewEvents();
};

function renderConfigPanel(rs) {
  var html = '';

  // 1. 预设选择
  html += '<div class="gallery-review-field">' +
    '<label class="gallery-review-label">' + T('galleryReviewPreset') + '</label>' +
    '<div style="display:flex;gap:4px">' +
    '<select id="gallery-review-preset-select" class="gallery-review-select" style="flex:1">' +
    '<option value="">' + T('galleryReviewSelectPreset') + '</option>';
  for (var pi = 0; pi < rs.availablePresets.length; pi++) {
    var p = rs.availablePresets[pi];
    var sel = p.id === rs.selectedPresetId ? ' selected' : '';
    html += '<option value="' + escapeHtml(p.id) + '"' + sel + '>' + escapeHtml(p.name) + '</option>';
  }
  html += '</select>' +
    '<button class="gallery-review-model-btn" id="gallery-review-delete-preset-btn" style="flex:0 0 auto" data-tooltip="' + T('galleryReviewDeletePreset') + '">✕</button>' +
    '</div></div>';

  // 2. 提示词生成模型
  var promptLabel = rs.promptModelId ? escapeHtml(rs.promptModelId) : T('galleryReviewNotSelected');
  html += '<div class="gallery-review-field">' +
    '<label class="gallery-review-label">' + T('galleryReviewPromptModel') + '</label>' +
    '<button class="pg-btn" id="gallery-review-prompt-model-btn" style="width:100%;text-align:left;justify-content:flex-start;font-size:12px;padding:5px 8px">' +
    promptLabel + ' <span style="float:right;opacity:0.5">▼</span>' +
    '</button></div>';

  // 3. 审核目标描述
  html += '<div class="gallery-review-field">' +
    '<label class="gallery-review-label">' + T('galleryReviewJudgeTarget') +
    '<button class="gallery-review-expand-btn" id="gallery-review-expand-judge" type="button" data-tooltip="' + T('galleryReviewExpand') + '">▼</button>' +
    '<textarea class="gallery-review-textarea" id="gallery-review-judge-target" placeholder="' + T('galleryReviewJudgeTargetPlaceholder') + '">' + escapeHtml(rs.judgeTarget) + '</textarea>' +
    '</div>';

  // 4. 生成提示词按钮
  html += '<div class="gallery-review-field">' +
    '<button class="gallery-review-btn gallery-review-start-btn" id="gallery-review-gen-prompt-btn" style="width:100%">' +
    (rs.generatingPrompt ? T('galleryReviewGenerating') : T('galleryReviewGeneratePrompt')) +
    '</button></div>';

  // 5. 系统提示词
  html += '<div class="gallery-review-field">' +
    '<label class="gallery-review-label">' + T('galleryReviewSystemPrompt') +
    '<button class="gallery-review-expand-btn" id="gallery-review-expand-system" type="button" data-tooltip="' + T('galleryReviewCollapse') + '">▼</button>' +
    '<textarea class="gallery-review-textarea" id="gallery-review-system-prompt" placeholder="' + T('galleryReviewSystemPromptPlaceholder') + '">' + escapeHtml(rs.systemPrompt) + '</textarea>' +
    '</div>';

  // 6. 视觉审核模型
  var reviewLabel = rs.reviewModelId ? escapeHtml(rs.reviewModelId) : T('galleryReviewNotSelected');
  html += '<div class="gallery-review-field">' +
    '<label class="gallery-review-label">' + T('galleryReviewReviewModel') + '</label>' +
    '<button class="pg-btn" id="gallery-review-review-model-btn" style="width:100%;text-align:left;justify-content:flex-start;font-size:12px;padding:5px 8px">' +
    reviewLabel + ' <span style="float:right;opacity:0.5">▼</span>' +
    '</button></div>';

  // 7. 策略 / 并发 / head-tail 参数
  html += '<div class="gallery-review-field">' +
    '<div class="gallery-review-row">' +
    '<div><label class="gallery-review-label">' + t('strategy') + '</label>' +
    '<select id="gallery-review-strategy" class="gallery-review-select">' +
    '<option value="all"' + (rs.strategy === 'all' ? ' selected' : '') + '>' + T('galleryReviewStrategyAll') + '</option>' +
    '<option value="head-tail"' + (rs.strategy === 'head-tail' ? ' selected' : '') + '>' + T('galleryReviewStrategyHeadTail') + '</option>' +
    '</select></div>' +
    '<div><label class="gallery-review-label">' + T('galleryReviewConcurrency') + '</label>' +
    '<input type="number" id="gallery-review-concurrency" class="gallery-review-input" value="' + rs.concurrency + '" min="1" max="10">' +
    '</div></div>' +
    '<div id="gallery-review-headtail-params" style="' + (rs.strategy === 'head-tail' ? 'display:flex' : 'display:none') + ';gap:4px;margin-top:4px">' +
    '<div style="flex:1"><label class="gallery-review-label">' + T('galleryReviewHeadSize') + '</label>' +
    '<input type="number" id="gallery-review-headsize" class="gallery-review-input" value="' + rs.headSize + '" min="1" max="50">' +
    '</div>' +
    '<div style="flex:1"><label class="gallery-review-label">' + T('galleryReviewTailSize') + '</label>' +
    '<input type="number" id="gallery-review-tailsize" class="gallery-review-input" value="' + rs.tailSize + '" min="1" max="50">' +
    '</div></div></div>';

  // 8. Start Review 按钮
  html += '<div class="gallery-review-field">' +
    '<button class="gallery-review-btn gallery-review-start-btn" id="gallery-review-start-btn" style="width:100%">' + T('galleryReviewStartReview') + '</button>' +
    '</div>';

  // 9. 保存为预设按钮
  html += '<div class="gallery-review-field">' +
    '<button class="gallery-review-btn" id="gallery-review-save-preset-btn" style="width:100%">' + T('galleryReviewSavePreset') + '</button>' +
    '</div>';

  return html;
}

function renderActivePanel(rs) {
  var html = '';

  var totalProcessed = rs.processed;
  var totalEntries = rs.total;
  var totalFailed = rs.failed;
  var totalMatched = 0;

  for (var dir in rs.nodeResults) {
    if (rs.nodeResults.hasOwnProperty(dir)) {
      totalMatched += (rs.nodeResults[dir] || []).length;
    }
  }

  if (rs.status === 'running') {
    var queueLen = rs.reviewQueue.length;
    var queueIdx = Math.min(rs.reviewQueueIndex + 1, queueLen);
    var pct = totalEntries > 0 ? (totalProcessed / totalEntries * 100) : 0;

    html += '<div style="padding:4px 8px;font-size:11px">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
      '<span style="color:var(--text-secondary)">' + T('galleryReviewProcessing') +
      (queueLen > 1 ? ' (' + queueIdx + '/' + queueLen + ')' : '') + '</span>' +
      '<span style="color:var(--text-muted)">' + totalProcessed + '/' + totalEntries + '</span>' +
      '</div>';
    if (totalFailed > 0) {
      html += '<div style="color:var(--danger);font-size:10px;margin-bottom:2px">' + T('galleryReviewFailed') + totalFailed + '</div>';
    }
    html += '<div class="gallery-review-progress">' +
      '<div class="gallery-review-progress-bar" style="width:' + pct + '%"></div>' +
      '</div>' +
      '<button class="gallery-review-btn" id="gallery-review-cancel-btn" style="margin-top:6px;width:100%">' + (T('cancel') || 'Cancel') + '</button>';
  } else if (rs.status === 'completed' || rs.status === 'error') {
    html += '<div style="padding:4px 8px;font-size:11px">' +
      '<div style="margin-bottom:6px">' +
      '<span style="color:' + (totalMatched > 0 ? 'var(--danger)' : 'var(--text-muted)') + ';font-weight:600">' + totalMatched + T('galleryReviewMatched') + '</span>' +
      '</div>';

    if (totalMatched > 0) {
      html += '<button class="gallery-review-btn gallery-review-start-btn" id="gallery-review-confirm-delete-btn" style="width:100%;margin-bottom:6px">' + T('galleryReviewConfirmDelete') + '</button>';
    }

    if (rs.status === 'error') {
      html += '<div style="color:var(--danger);font-size:10px;margin-bottom:4px">' + T('galleryReviewError') + '</div>';
    }

    html += '<button class="gallery-review-btn" id="gallery-review-reset-btn" style="width:100%">' + T('galleryReviewReset') + '</button>';
  }

  // 全宽视图切换按钮（Cancel/Reset 按钮下方），显示按下后将切换到的目标状态
  var toggleBtnText = (rs.reviewMode !== false) ? T('galleryReviewShowAll') : T('galleryReviewShowMatchedOnly');
  html += '<button class="gallery-review-btn" id="gallery-review-toggle-mode-btn" style="margin-top:6px;width:100%">' + escapeHtml(toggleBtnText) + '</button>' +
    '</div>';

  return html;
}

// ---------- event binding --------------------------------------------------

function bindReviewEvents() {
  // 预设选择
  var presetSelect = document.getElementById('gallery-review-preset-select');
  if (presetSelect) {
    presetSelect.onchange = function() {
      selectPreset(this.value);
    };
  }

  // 删除预设按钮
  var deletePresetBtn = document.getElementById('gallery-review-delete-preset-btn');
  if (deletePresetBtn) {
    deletePresetBtn.onclick = function() {
      var rs = galleryState.reviewState;
      if (!rs.selectedPresetId) { showMsg(T('galleryReviewNoPreset')); return; }
      deletePreset(rs.selectedPresetId);
    };
  }

  // 提示词生成模型选择按钮
  var promptModelBtn = document.getElementById('gallery-review-prompt-model-btn');
  if (promptModelBtn) {
    promptModelBtn.onclick = function() {
      var rs = galleryState.reviewState;
      openReviewModelPicker(rs.promptModelId, function(v) {
        rs.promptModelId = v;
        renderReviewPanel();
      }, { kindFilter: 'text' });
    };
  }

  // 审核目标输入
  var judgeTarget = document.getElementById('gallery-review-judge-target');
  if (judgeTarget) {
    judgeTarget.oninput = function() {
      galleryState.reviewState.judgeTarget = this.value;
    };
  }

  // 生成提示词按钮
  var genPromptBtn = document.getElementById('gallery-review-gen-prompt-btn');
  if (genPromptBtn) {
    genPromptBtn.onclick = function() {
      generatePrompt();
    };
  }

  // 系统提示词输入
  var systemPrompt = document.getElementById('gallery-review-system-prompt');
  if (systemPrompt) {
    systemPrompt.oninput = function() {
      galleryState.reviewState.systemPrompt = this.value;
    };
  }

  // 文本框展开/折叠按钮
  var expandBtns = document.querySelectorAll('.gallery-review-expand-btn');
  expandBtns.forEach(function(btn) {
    btn.onclick = function(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      var textareaId = this.id === 'gallery-review-expand-judge' ? 'gallery-review-judge-target' : 'gallery-review-system-prompt';
      var textarea = document.getElementById(textareaId);
      if (!textarea) return;
      var expanded = textarea.classList.toggle('expanded');
      if (expanded) {
        textarea.style.height = textarea.scrollHeight + 'px';
        this.textContent = '\u25b2';
      } else {
        textarea.style.height = '';
        this.textContent = '\u25bc';
      }
    };
  });

  // 视觉审核模型选择按钮
  var reviewModelBtn = document.getElementById('gallery-review-review-model-btn');
  if (reviewModelBtn) {
    reviewModelBtn.onclick = function() {
      var rs = galleryState.reviewState;
      openReviewModelPicker(rs.reviewModelId, function(v) {
        rs.reviewModelId = v;
        renderReviewPanel();
      }, {});
    };
  }

  // 策略选择
  var strategySelect = document.getElementById('gallery-review-strategy');
  if (strategySelect) {
    strategySelect.onchange = function() {
      var htParams = document.getElementById('gallery-review-headtail-params');
      if (htParams) {
        htParams.style.display = this.value === 'head-tail' ? 'flex' : 'none';
      }
      galleryState.reviewState.strategy = this.value;
    };
  }

  // 并发数
  var concurrencyInput = document.getElementById('gallery-review-concurrency');
  if (concurrencyInput) {
    concurrencyInput.onchange = function() {
      var val = parseInt(this.value, 10) || 3;
      if (val > 50) {
        val = 50;
        this.value = 50;
        showMsg(T('galleryReviewMaxConcurrency'));
      }
    };
  }

  // head size
  var headSizeInput = document.getElementById('gallery-review-headsize');
  if (headSizeInput) {
    headSizeInput.onchange = function() {
      galleryState.reviewState.headSize = parseInt(this.value, 10) || 5;
    };
  }

  // tail size
  var tailSizeInput = document.getElementById('gallery-review-tailsize');
  if (tailSizeInput) {
    tailSizeInput.onchange = function() {
      galleryState.reviewState.tailSize = parseInt(this.value, 10) || 5;
    };
  }

  // Start Review 按钮
  var startBtn = document.getElementById('gallery-review-start-btn');
  if (startBtn) {
    startBtn.onclick = function() {
      startReview();
    };
  }

  // 保存为预设按钮
  var savePresetBtn = document.getElementById('gallery-review-save-preset-btn');
  if (savePresetBtn) {
    savePresetBtn.onclick = function() {
      savePreset();
    };
  }

  // Cancel 按钮
  var cancelBtn = document.getElementById('gallery-review-cancel-btn');
  if (cancelBtn) {
    cancelBtn.onclick = function() {
      cancelReview();
    };
  }

  // Reset 按钮
  var resetBtn = document.getElementById('gallery-review-reset-btn');
  if (resetBtn) {
    resetBtn.onclick = function() {
      resetReview();
    };
  }

  // 确认删除按钮（功能与 Ctrl+Del 相同）
  var confirmDeleteBtn = document.getElementById('gallery-review-confirm-delete-btn');
  if (confirmDeleteBtn) {
    confirmDeleteBtn.onclick = function() {
      if (typeof window.deleteItemPrompt === 'function') {
        window.deleteItemPrompt();
      }
    };
  }

  // 全宽视图切换按钮（Show All / Show Matched）
  var toggleModeBtn = document.getElementById('gallery-review-toggle-mode-btn');
  if (toggleModeBtn) {
    toggleModeBtn.onclick = function() {
      var rs = galleryState.reviewState;
      rs.reviewMode = (rs.reviewMode === false);
      updateReviewThumbnailDisplay();
      if (typeof renderTreePanel === 'function') {
        renderTreePanel();
      }
    };
  }
}

// ---------- preset management ----------------------------------------------

function loadReviewPresets() {
  fetch('/api/review-presets')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      galleryState.reviewState.availablePresets = data.presets || [];
      renderReviewPanel();
    })
    .catch(function(err) {
      console.warn('loadReviewPresets failed:', err);
    });
}

function selectPreset(presetId) {
  var rs = galleryState.reviewState;
  rs.selectedPresetId = presetId;
  if (!presetId) {
    rs.systemPrompt = '';
    rs.userPrompt = '';
    renderReviewPanel();
    return;
  }
  for (var i = 0; i < rs.availablePresets.length; i++) {
    if (rs.availablePresets[i].id === presetId) {
      var preset = rs.availablePresets[i];
      rs.systemPrompt = preset.systemPrompt || '';
      rs.userPrompt = preset.userPrompt || '';
      renderReviewPanel();
      return;
    }
  }
}

function deletePreset(presetId) {
  var rs = galleryState.reviewState;
  var presetName = presetId;
  for (var i = 0; i < rs.availablePresets.length; i++) {
    if (rs.availablePresets[i].id === presetId) {
      presetName = rs.availablePresets[i].name || presetId;
      break;
    }
  }
  var html = '<div style="text-align:center;padding:8px">' +
    '<div style="font-size:15px;margin-bottom:8px">' + T('galleryReviewDeletePresetTitle') + '</div>' +
    '<div style="font-size:12px;color:#888;margin-bottom:14px;word-break:break-all">' + escapeHtml(presetName) + '</div>' +
    '<div style="display:flex;justify-content:center;gap:8px">' +
    '<button class="pg-btn" id="gallery-preset-del-ok" style="padding:6px 16px">' + (T('delete') || 'Delete') + '</button>' +
    '<button class="pg-btn" id="gallery-preset-del-cancel" style="padding:6px 16px">' + (T('cancel') || 'Cancel') + '</button>' +
    '</div></div>';
  pgShowModal(html);
  document.getElementById('gallery-preset-del-ok').onclick = function() {
    pgCloseModal();
    doDeletePreset(presetId);
  };
  document.getElementById('gallery-preset-del-cancel').onclick = function() {
    pgCloseModal();
  };
}

function doDeletePreset(presetId) {
  fetch('/api/review-presets/' + encodeURIComponent(presetId), { method: 'DELETE' })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function() {
      var rs = galleryState.reviewState;
      rs.selectedPresetId = '';
      loadReviewPresets();
      showMsg(T('galleryReviewPresetDeleted'));
    })
    .catch(function(err) {
      showMsg(T('galleryReviewDeletePresetFailed') + err.message);
    });
}

function savePreset() {
  var rs = galleryState.reviewState;
  var nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = T('galleryReviewPresetNamePlaceholder');
  nameInput.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;border-radius:var(--radius-xs);background:rgba(0,0,0,0.2);border:1px solid var(--glass-border);color:var(--text);font-size:13px;font-family:inherit;outline:none;margin-bottom:8px';

  var html = '<div style="text-align:center;padding:8px">' +
    '<div style="font-size:15px;margin-bottom:8px">' + T('galleryReviewSavePresetTitle') + '</div>' +
    '<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">' + T('galleryReviewNamePreset') + '</div>' +
    '</div>' +
    '<div style="padding:0 8px"><div id="gallery-preset-name-container"></div></div>' +
    '<div style="display:flex;justify-content:center;gap:8px;padding:8px">' +
    '<button class="pg-btn" id="gallery-preset-save-btn" style="padding:6px 16px">' + (T('save') || 'Save') + '</button>' +
    '<button class="pg-btn" id="gallery-preset-cancel-btn" style="padding:6px 16px">' + (T('cancel') || 'Cancel') + '</button>' +
    '</div>';

  pgShowModal(html);
  var container = document.getElementById('gallery-preset-name-container');
  if (container) container.appendChild(nameInput);

  document.getElementById('gallery-preset-save-btn').onclick = function() {
    var name = nameInput.value.trim();
    if (!name) { showMsg(T('galleryReviewEnterPresetName')); return; }
    pgCloseModal();
    doSavePreset(name);
  };
  document.getElementById('gallery-preset-cancel-btn').onclick = function() {
    pgCloseModal();
  };
  setTimeout(function() { nameInput.focus(); }, 100);
}

function doSavePreset(name) {
  var rs = galleryState.reviewState;
  var body = {
    name: name,
    systemPrompt: rs.systemPrompt,
    userPrompt: rs.userPrompt
  };

  fetch('/api/review-presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'HTTP ' + r.status); });
      return r.json();
    })
    .then(function(data) {
      var preset = data.preset;
      rs.selectedPresetId = preset.id;
      loadReviewPresets();
      showMsg(T('galleryReviewPresetSaved'));
    })
    .catch(function(err) {
      showMsg(T('galleryReviewSavePresetFailed') + err.message);
    });
}

// ---------- prompt generation ----------------------------------------------

function generatePrompt() {
  var rs = galleryState.reviewState;
  if (!rs.promptModelId) {
    showMsg(T('galleryReviewSelectPromptModel'));
    return;
  }
  if (!rs.judgeTarget.trim()) {
    showMsg(T('galleryReviewEnterJudgeTarget'));
    return;
  }

  rs.generatingPrompt = true;
  renderReviewPanel();

  var slashIdx = rs.promptModelId.indexOf('/');
  var provider = '';
  var model = rs.promptModelId;
  if (slashIdx >= 0) {
    provider = rs.promptModelId.substring(0, slashIdx);
    model = rs.promptModelId.substring(slashIdx + 1);
  }

  fetch('/api/gallery/review/gen-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: provider,
      model: model,
      judgeTarget: rs.judgeTarget
    })
  })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'HTTP ' + r.status); });
      return r.json();
    })
    .then(function(data) {
      rs.generatingPrompt = false;
      rs.systemPrompt = data.systemPrompt || '';
      renderReviewPanel();
    })
    .catch(function(err) {
      rs.generatingPrompt = false;
      renderReviewPanel();
      showMsg(T('galleryReviewGenPromptFailed') + err.message);
    });
}

// ---------- review execution (Multi-Node Sequential) -----------------------

function buildReviewQueue(selectedNodes) {
  var queue = [];
  var nodes = selectedNodes && selectedNodes.length ? selectedNodes : galleryState.dirPathList;
  if (!nodes || !nodes.length) return queue;

  for (var i = 0; i < nodes.length; i++) {
    var dir = nodes[i];
    var itemIndices = galleryState.dirMap[dir] || [];
    if (!itemIndices.length) continue;

    // Group zip items by pack: archive-source packs key on sourceId, legacy
    // in-memory sessions on sessionId. The review backend accepts either.
    var sessionGroups = {};
    for (var j = 0; j < itemIndices.length; j++) {
      var item = galleryState.items[itemIndices[j]];
      if (!item || item.kind !== 'zip') continue;
      var packId = item.sourceId || item.sessionId;
      if (!packId) continue;
      if (!sessionGroups[packId]) sessionGroups[packId] = { sourceId: item.sourceId || '', sessionId: item.sessionId || '', indices: [] };
      sessionGroups[packId].indices.push(item.index);
    }

    for (var packKey in sessionGroups) {
      if (sessionGroups.hasOwnProperty(packKey)) {
        var grp = sessionGroups[packKey];
        var node = {
          dir: dir,
          entryIndices: grp.indices,
          itemIndices: itemIndices
        };
        if (grp.sourceId) node.sourceId = grp.sourceId;
        else node.sessionId = grp.sessionId;
        queue.push(node);
      }
    }
  }
  return queue;
}

function startReview() {
  var rs = galleryState.reviewState;

  if (!rs.reviewModelId) {
    showMsg(T('galleryReviewSelectReviewModel'));
    return;
  }
  if (!rs.systemPrompt.trim()) {
    showMsg(T('galleryReviewSystemPromptRequired'));
    return;
  }

  var queue = buildReviewQueue(rs.selectedNodes);
  if (!queue.length) {
    showMsg(T('galleryReviewNoEntries'));
  }

  rs.reviewQueue = queue;
  rs.reviewQueueIndex = 0;
  rs.nodeResults = {};
  rs.nodeStatus = {};
  rs.reviewedNodes = [];
  rs.allReviewMatchIndices = [];
  rs.active = true;
  rs.status = 'running';
  rs.selectMode = false;
  rs.focusedReviewNode = queue[0].dir;

  for (var i = 0; i < queue.length; i++) {
    rs.nodeStatus[queue[i].dir] = 'pending';
  }

  rs.originalIndices = galleryState.currentFolderIndices.slice();
  galleryState.currentFolderIndices = [];
  renderThumbnails();

  renderReviewPanel();
  if (typeof renderTreePanel === 'function') renderTreePanel();

  reviewNextNode();
}

function reviewNextNode() {
  var rs = galleryState.reviewState;
  if (rs.reviewQueueIndex >= rs.reviewQueue.length) {
    rs.status = 'completed';
    renderReviewPanel();
    if (typeof renderTreePanel === 'function') renderTreePanel();
    return;
  }

  var node = rs.reviewQueue[rs.reviewQueueIndex];
  rs.currentReviewNode = node.dir;
  rs.nodeStatus[node.dir] = 'running';
  // The poll key is the review task id: sourceId for archive-source packs,
  // sessionId for legacy in-memory zip sessions.
  rs.sessionId = node.sourceId || node.sessionId;

  rs.total = node.entryIndices.length;
  rs.processed = 0;
  rs.failed = 0;

  if (typeof renderTreePanel === 'function') renderTreePanel();

  var slashIdx = rs.reviewModelId.indexOf('/');
  var provider = '';
  var model = rs.reviewModelId;
  if (slashIdx >= 0) {
    provider = rs.reviewModelId.substring(0, slashIdx);
    model = rs.reviewModelId.substring(slashIdx + 1);
  }

  var body = {
    provider: provider,
    model: model,
    systemPrompt: rs.systemPrompt,
    matchField: rs.matchField,
    strategy: rs.strategy,
    headSize: rs.headSize,
    tailSize: rs.tailSize,
    concurrency: rs.concurrency
  };
  if (node.sourceId) body.sourceId = node.sourceId;
  else body.sessionId = node.sessionId;
  if (rs.userPrompt) body.userPrompt = rs.userPrompt;

  fetch('/api/gallery/review/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'HTTP ' + r.status); });
      return r.json();
    })
    .then(function(data) {
      rs.total = data.total;
      startNodePolling(node);
    })
    .catch(function(err) {
      rs.nodeStatus[node.dir] = 'error';
      rs.reviewQueueIndex++;
      if (typeof renderTreePanel === 'function') renderTreePanel();
      reviewNextNode();
    });
}

function startNodePolling(node) {
  stopPolling();

  galleryState.reviewState.pollTimer = setInterval(function() {
    var rs = galleryState.reviewState;
    // Poll key = the review task id: sourceId for archive-source packs,
    // sessionId for legacy in-memory zip sessions (same key reviewNextNode
    // used to start the task).
    var pollKey = node.sourceId || node.sessionId;
    fetch('/api/gallery/review/status/' + encodeURIComponent(pollKey))
      .then(function(r) {
        if (r.status === 404) {
          return {
            status: 'completed',
            total: rs.total,
            processed: rs.total,
            failed: rs.failed,
            results: rs.nodeResults[node.dir] || []
          };
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        var prevCount = (rs.nodeResults[node.dir] || []).length;
        rs.processed = data.processed;
        rs.failed = data.failed || 0;
        rs.nodeResults[node.dir] = data.results || [];

        if (rs.nodeResults[node.dir].length > prevCount) {
          applyReviewFilterIncremental(node);
        }

        renderReviewPanel();

        if (data.status === 'completed' || data.status === 'error') {
          stopPolling();
          rs.nodeStatus[node.dir] = (data.status === 'error' ? 'error' : 'completed');

          if (rs.reviewedNodes.indexOf(node.dir) < 0 && (rs.nodeResults[node.dir] || []).length > 0) {
            rs.reviewedNodes.push(node.dir);
          }

          if (typeof renderTreePanel === 'function') renderTreePanel();

          rs.reviewQueueIndex++;
          reviewNextNode();
        }
      })
      .catch(function(err) {
        console.warn('Review polling error:', err);
      });
  }, 800);
}

function stopPolling() {
  if (galleryState.reviewState.pollTimer) {
    clearInterval(galleryState.reviewState.pollTimer);
    galleryState.reviewState.pollTimer = null;
  }
}

// ---------- incremental filter & node focus ---------------------------------

function applyReviewFilterIncremental(node) {
  var rs = galleryState.reviewState;
  updateReviewMatchIndices();

  var nodeResults = rs.nodeResults[node.dir] || [];
  for (var i = 0; i < nodeResults.length; i++) {
    var arrIdx = entryIndexToArrayIndex(nodeResults[i].index);
    if (arrIdx >= 0) {
      var item = galleryState.items[arrIdx];
      if (item && !item._reviewMarked) {
        item.markedForDeletion = true;
        item._reviewMarked = true;
      }
    }
  }

  var focusDir = rs.focusedReviewNode || node.dir;
  showReviewNodeThumbnails(focusDir);
}

function updateReviewMatchIndices() {
  var rs = galleryState.reviewState;
  var all = [];
  for (var dir in rs.nodeResults) {
    if (rs.nodeResults.hasOwnProperty(dir)) {
      var results = rs.nodeResults[dir];
      for (var i = 0; i < results.length; i++) {
        var arrIdx = entryIndexToArrayIndex(results[i].index);
        if (arrIdx >= 0 && all.indexOf(arrIdx) < 0) {
          all.push(arrIdx);
        }
      }
    }
  }
  all.sort(function(a, b) { return a - b; });
  rs.allReviewMatchIndices = all;
}

function showReviewNodeThumbnails(dir) {
  var rs = galleryState.reviewState;
  rs.focusedReviewNode = dir;
  updateReviewThumbnailDisplay();
}

function updateReviewThumbnailDisplay() {
  var rs = galleryState.reviewState;
  var focusDir = rs.focusedReviewNode || rs.currentReviewNode || galleryState.curDirPath;
  if (!focusDir && galleryState.dirPathList.length > 0) {
    focusDir = galleryState.dirPathList[0];
  }
  if (focusDir === undefined || focusDir === null) return;

  var displayIndices = [];
  if (rs.reviewMode !== false) {
    // A) 仅显示符合结果 (Show matched only) — 默认
    var nodeResults = rs.nodeResults[focusDir] || [];
    for (var i = 0; i < nodeResults.length; i++) {
      var arrIdx = entryIndexToArrayIndex(nodeResults[i].index);
      if (arrIdx >= 0) displayIndices.push(arrIdx);
    }
  } else {
    // B) 显示该节点的全部图片 (Show all items in the node)
    var allIndices = galleryState.dirMap[focusDir] || [];
    displayIndices = allIndices.slice();
  }

  galleryState.currentFolderIndices = displayIndices;
  renderThumbnails();

  if (displayIndices.length > 0 && displayIndices.indexOf(galleryState.index) < 0) {
    setActive(displayIndices[0]);
  }
}

// ---------- review navigation helpers --------------------------------------

function getReviewedNodesWithMatches() {
  var rs = galleryState.reviewState;
  var result = [];
  var seen = {};
  for (var i = 0; i < rs.reviewQueue.length; i++) {
    var dir = rs.reviewQueue[i].dir;
    if (seen[dir]) continue;
    seen[dir] = true;
    var status = rs.nodeStatus[dir];
    if ((status === 'running' || status === 'completed') &&
        rs.nodeResults[dir] && rs.nodeResults[dir].length > 0) {
      result.push(dir);
    }
  }
  return result;
}

function getAdjacentReviewNode(delta) {
  var rs = galleryState.reviewState;
  var nodes = getReviewedNodesWithMatches();
  if (!nodes.length) return null;

  var curIdx = nodes.indexOf(rs.focusedReviewNode);
  if (curIdx < 0) {
    return delta > 0 ? nodes[0] : nodes[nodes.length - 1];
  }
  var target = curIdx + delta;
  if (target < 0) target = nodes.length - 1;
  if (target >= nodes.length) target = 0;
  return nodes[target];
}

function goReviewPrev() {
  var folderIndices = galleryState.currentFolderIndices || [];
  if (!folderIndices.length) return;

  var curPos = folderIndices.indexOf(galleryState.index);
  if (curPos > 0) {
    setActive(folderIndices[curPos - 1]);
  } else {
    var prevDir = getAdjacentReviewNode(-1);
    if (prevDir) {
      showReviewNodeThumbnails(prevDir);
      var newIndices = galleryState.currentFolderIndices;
      if (newIndices.length > 0) setActive(newIndices[newIndices.length - 1]);
      if (typeof renderTreePanel === 'function') renderTreePanel();
    }
  }
}

function goReviewNext() {
  var folderIndices = galleryState.currentFolderIndices || [];
  if (!folderIndices.length) return;

  var curPos = folderIndices.indexOf(galleryState.index);
  if (curPos >= 0 && curPos < folderIndices.length - 1) {
    setActive(folderIndices[curPos + 1]);
  } else {
    var nextDir = getAdjacentReviewNode(1);
    if (nextDir) {
      showReviewNodeThumbnails(nextDir);
      var newIndices = galleryState.currentFolderIndices;
      if (newIndices.length > 0) setActive(newIndices[0]);
      if (typeof renderTreePanel === 'function') renderTreePanel();
    }
  }
}

function goReviewPrevNode() {
  var prevDir = getAdjacentReviewNode(-1);
  if (prevDir) {
    showReviewNodeThumbnails(prevDir);
    var newIndices = galleryState.currentFolderIndices;
    if (newIndices.length > 0) setActive(newIndices[0]);
    if (typeof renderTreePanel === 'function') renderTreePanel();
  }
}

function goReviewNextNode() {
  var nextDir = getAdjacentReviewNode(1);
  if (nextDir) {
    showReviewNodeThumbnails(nextDir);
    var newIndices = galleryState.currentFolderIndices;
    if (newIndices.length > 0) setActive(newIndices[0]);
    if (typeof renderTreePanel === 'function') renderTreePanel();
  }
}

function startReviewPolling() {
  var rs = galleryState.reviewState;
  if (!rs.active || rs.status !== 'running') return;
  if (rs.reviewQueue && rs.reviewQueueIndex >= 0 && rs.reviewQueueIndex < rs.reviewQueue.length) {
    var node = rs.reviewQueue[rs.reviewQueueIndex];
    startNodePolling(node);
  }
}

// Expose globals
window.startReviewPolling = startReviewPolling;
window.loadReviewPresets = loadReviewPresets;
window.showReviewNodeThumbnails = showReviewNodeThumbnails;
window.updateReviewThumbnailDisplay = updateReviewThumbnailDisplay;
window.goReviewPrev = goReviewPrev;
window.goReviewNext = goReviewNext;
window.goReviewPrevNode = goReviewPrevNode;
window.goReviewNextNode = goReviewNextNode;

// ---------- cleanup --------------------------------------------------------

window.cleanupReview = function() {
  stopPolling();
};

// ---------- cancel / reset -------------------------------------------------

function cancelReview() {
  var sid = galleryState.reviewState.sessionId;
  if (sid) {
    fetch('/api/gallery/review/cancel/' + encodeURIComponent(sid), { method: 'POST' }).catch(function() {});
  }
  stopPolling();
  galleryState.reviewState.status = 'cancelled';
  galleryState.reviewState.active = false;
  renderReviewPanel();
  if (typeof renderTreePanel === 'function') renderTreePanel();
  showMsg(T('galleryReviewCancelled'));
}

function resetReview() {
  stopPolling();
  var rs = galleryState.reviewState;
  rs.active = false;
  rs.status = null;
  rs.total = 0;
  rs.processed = 0;
  rs.failed = 0;
  rs.results = [];
  rs.sessionId = null;
  rs.reviewMode = false;
  rs.selectMode = false;
  rs.reviewQueue = [];
  rs.reviewQueueIndex = -1;
  rs.currentReviewNode = null;
  rs.nodeResults = {};
  rs.nodeStatus = {};
  rs.reviewedNodes = [];
  rs.focusedReviewNode = '';
  rs.allReviewMatchIndices = [];

  for (var i = 0; i < galleryState.items.length; i++) {
    if (galleryState.items[i]) delete galleryState.items[i]._reviewMarked;
  }

  galleryState.currentFolderIndices = rs.originalIndices.slice();
  rs.originalIndices = [];
  renderReviewPanel();
  if (typeof renderTreePanel === 'function') renderTreePanel();
  renderThumbnails();
  showMsg(T('galleryReviewResetMsg'));
}

window.resetReview = resetReview;

// ---------- auto-load presets on page ready --------------------------------
// 在页面加载完成后自动加载预设列表
(function autoLoadPresets() {
  if (document.readyState === 'complete') {
    loadReviewPresets();
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      loadReviewPresets();
    });
  }
})();