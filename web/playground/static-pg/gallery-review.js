// gallery-review.js — AI Review panel: preset management, prompt generation,
// model selection, review execution, and result filtering.
// This file is loaded after gallery-tree.js and provides window.renderReviewPanel().

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
    '<button class="gallery-review-expand-btn" id="gallery-review-expand-judge" type="button" data-tooltip="Expand">▼</button>' +
    '</label>' +
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
    '<button class="gallery-review-expand-btn" id="gallery-review-expand-system" type="button" data-tooltip="Expand">▼</button>' +
    '</label>' +
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

  if (rs.status === 'running') {
    // 进度
    var pct = rs.total > 0 ? (rs.processed / rs.total * 100) : 0;
    html += '<div style="padding:4px 8px;font-size:11px">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
      '<span style="color:var(--text-secondary)">' + T('galleryReviewProcessing') + '</span>' +
      '<span style="color:var(--text-muted)">' + rs.processed + '/' + rs.total + '</span>' +
      '</div>';
    if (rs.failed > 0) {
      html += '<div style="color:var(--danger);font-size:10px;margin-bottom:2px">' + T('galleryReviewFailed') + rs.failed + '</div>';
    }
    html += '<div class="gallery-review-progress">' +
      '<div class="gallery-review-progress-bar" style="width:' + pct + '%"></div>' +
      '</div>' +
      '<button class="gallery-review-btn" id="gallery-review-cancel-btn" style="margin-top:6px;width:100%">' + t('cancel') + '</button>' +
      '</div>';
  } else if (rs.status === 'completed' || rs.status === 'error') {
    // 完成 / 错误
    var foundCount = rs.results.length;
    html += '<div style="padding:4px 8px;font-size:11px">' +
      '<div style="margin-bottom:6px">' +
      '<span style="color:' + (foundCount > 0 ? 'var(--danger)' : 'var(--text-muted)') + ';font-weight:600">' + foundCount + T('galleryReviewMatched') + '</span>' +
      '<span style="color:var(--text-muted)"> / ' + rs.total + T('galleryReviewTotal') + '</span>';
    if (rs.failed > 0) {
      html += '<span style="color:var(--danger);font-size:10px;margin-left:4px">(' + rs.failed + T('galleryReviewFailedCount') + ')</span>';
    }
    html += '</div>';

    if (foundCount > 0) {
      html += '<div class="gallery-review-result-list">';
      for (var ri = 0; ri < rs.results.length; ri++) {
        var r = rs.results[ri];
        var shortPath = (r.path || '').split('/').pop();
        html += '<div class="gallery-review-result-item" data-ri="' + ri + '">' +
          '<span style="color:var(--danger);flex-shrink:0">\u26a0</span>' +
          '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" data-tooltip="' + escapeHtml(r.reason || '') + '">' + escapeHtml(shortPath) + '</span>' +
          '</div>';
      }
      html += '</div>';

      html += '<div style="margin-bottom:4px;font-size:10px;color:var(--text-muted)">' +
        '<label style="display:flex;align-items:center;gap:4px;cursor:pointer">' +
        '<input type="checkbox" id="gallery-review-mode-toggle" ' + (rs.reviewMode ? 'checked' : '') + '>' +
        T('galleryReviewShowMatched') +
        '</label></div>';
    }

    if (rs.status === 'error') {
      html += '<div style="color:var(--danger);font-size:10px;margin-bottom:4px">' + T('galleryReviewError') + '</div>';
    }

    html += '<button class="gallery-review-btn" id="gallery-review-reset-btn" style="width:100%">' + T('galleryReviewReset') + '</button>' +
      '</div>';
  }

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
      galleryState.reviewState.concurrency = parseInt(this.value, 10) || 3;
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

  // 审核模式切换
  var modeToggle = document.getElementById('gallery-review-mode-toggle');
  if (modeToggle) {
    modeToggle.onchange = function() {
      galleryState.reviewState.reviewMode = this.checked;
      applyReviewFilter();
    };
  }

  // 审核结果项点击跳转
  var resultItems = document.querySelectorAll('.gallery-review-result-item');
  resultItems.forEach(function(el) {
    el.onclick = function() {
      var ri = parseInt(this.getAttribute('data-ri'), 10);
      if (!isNaN(ri) && galleryState.reviewState.results[ri]) {
        var entryIdx = galleryState.reviewState.results[ri].index;
        var arrIdx = entryIndexToArrayIndex(entryIdx);
        if (arrIdx >= 0) setActive(arrIdx);
      }
    };
  });
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
  // 查找预设名展示在对话框中
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
    '<button class="pg-btn" id="gallery-preset-del-ok" style="padding:6px 16px">' + t('delete') + '</button>' +
    '<button class="pg-btn" id="gallery-preset-del-cancel" style="padding:6px 16px">' + t('cancel') + '</button>' +
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
    '<button class="pg-btn" id="gallery-preset-save-btn" style="padding:6px 16px">' + t('save') + '</button>' +
    '<button class="pg-btn" id="gallery-preset-cancel-btn" style="padding:6px 16px">' + t('cancel') + '</button>' +
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

  // 解析 provider/model 格式：prefix/model-id
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

// ---------- review execution -----------------------------------------------

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

  var sessionId = galleryState.zipSessionId;
  if (!sessionId) {
    showMsg(T('galleryReviewNoSession'));
    return;
  }

  // 解析 provider/model
  var slashIdx = rs.reviewModelId.indexOf('/');
  var provider = '';
  var model = rs.reviewModelId;
  if (slashIdx >= 0) {
    provider = rs.reviewModelId.substring(0, slashIdx);
    model = rs.reviewModelId.substring(slashIdx + 1);
  }

  var body = {
    sessionId: sessionId,
    provider: provider,
    model: model,
    systemPrompt: rs.systemPrompt,
    matchField: rs.matchField,
    strategy: rs.strategy,
    headSize: rs.headSize,
    tailSize: rs.tailSize,
    concurrency: rs.concurrency
  };
  if (rs.userPrompt) {
    body.userPrompt = rs.userPrompt;
  }

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
      rs.active = true;
      rs.status = 'running';
      rs.total = data.total;
      rs.processed = 0;
      rs.failed = 0;
      rs.results = [];
      rs.sessionId = sessionId;
      rs.originalIndices = galleryState.currentFolderIndices.slice();
      renderReviewPanel();
      startPolling();
    })
    .catch(function(err) {
      showMsg(T('galleryReviewStartFailed') + err.message);
    });
}

// ---------- polling --------------------------------------------------------

function startPolling() {
  if (galleryState.reviewState.pollTimer) {
    clearInterval(galleryState.reviewState.pollTimer);
  }
  galleryState.reviewState.pollTimer = setInterval(function() {
    var sid = galleryState.reviewState.sessionId;
    if (!sid) return;
    fetch('/api/gallery/review/status/' + encodeURIComponent(sid))
      .then(function(r) {
        if (r.status === 404) {
          return { status: 'completed', total: galleryState.reviewState.total,
                   processed: galleryState.reviewState.total,
                   failed: galleryState.reviewState.failed,
                   results: galleryState.reviewState.results };
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        var rs = galleryState.reviewState;
        rs.status = data.status;
        rs.total = data.total;
        rs.processed = data.processed;
        rs.failed = data.failed || 0;
        rs.results = data.results || [];
        renderReviewPanel();

        if (data.status === 'completed') {
          stopPolling();
          rs.reviewMode = true;
          applyReviewFilter();
        } else if (data.status === 'error' || data.status === 'cancelled') {
          stopPolling();
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

// Expose startPolling for gallery.js recovery
window.startReviewPolling = startPolling;
// Expose loadReviewPresets for gallery.js to trigger on page entry
window.loadReviewPresets = loadReviewPresets;

// ---------- cleanup --------------------------------------------------------

window.cleanupReview = function() {
  stopPolling();
};

// ---------- cancel / reset -------------------------------------------------

function cancelReview() {
  var sid = galleryState.reviewState.sessionId;
  if (!sid) return;
  fetch('/api/gallery/review/cancel/' + encodeURIComponent(sid), { method: 'POST' })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function() {
      stopPolling();
      galleryState.reviewState.status = 'cancelled';
      galleryState.reviewState.active = false;
      renderReviewPanel();
      showMsg(T('galleryReviewCancelled'));
    })
    .catch(function(err) {
      showMsg(T('galleryReviewCancelFailed') + err.message);
    });
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
  galleryState.currentFolderIndices = rs.originalIndices.slice();
  rs.originalIndices = [];
  renderReviewPanel();
  renderThumbnails();
  showMsg(T('galleryReviewResetMsg'));
}

// ---------- filter ---------------------------------------------------------

function applyReviewFilter() {
  var rs = galleryState.reviewState;
  if (!rs.reviewMode || !rs.results.length) {
    updateDirStructure();
    if (galleryState.index >= 0) setActive(galleryState.index);
    renderThumbnails();
    return;
  }

  var matchedArrayIndices = {};
  for (var i = 0; i < rs.results.length; i++) {
    var arrIdx = entryIndexToArrayIndex(rs.results[i].index);
    if (arrIdx >= 0) matchedArrayIndices[arrIdx] = true;
  }

  var filtered = [];
  for (var j = 0; j < galleryState.currentFolderIndices.length; j++) {
    if (matchedArrayIndices[galleryState.currentFolderIndices[j]]) {
      filtered.push(galleryState.currentFolderIndices[j]);
    }
  }

  galleryState.currentFolderIndices = filtered;
  if (filtered.indexOf(galleryState.index) === -1) {
    if (filtered.length > 0) {
      setActive(filtered[0]);
    } else {
      galleryState.index = -1;
      renderActive(-1);
    }
  }
  renderThumbnails();
  renderTreePanel();
}

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