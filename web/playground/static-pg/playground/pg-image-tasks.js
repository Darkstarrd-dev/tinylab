// pg-image-tasks.js — Playground Image task queue, asynchronous dispatcher, and concurrency controller.
(function () {
  'use strict';

  function uid(prefix) { return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }

  // Semantic delimiter that splits one input into multiple per-request prompts
  // (inspire batch mode). Exposed for the inspire modal and tests.
  var PROMPT_DELIMITER = '<<<PROMPT>>>';
  function splitPrompts(text) {
    var raw = String(text || '');
    if (raw.indexOf(PROMPT_DELIMITER) === -1) return [raw.trim()];
    return raw.split(PROMPT_DELIMITER).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
  }
  window.pgImagePromptDelimiter = PROMPT_DELIMITER;
  window.pgImageSplitPrompts = splitPrompts;

  var tasks = [];
  var activeTaskId = null;
  var providerRunning = {};
  var tasksTimer = null;

  function findTask(id) {
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === id) return tasks[i];
    }
    return null;
  }

  function providerKeyOf(t) {
    if (t.protocol === 'comfyui') return 'comfyui';
    return String(t.model || '').split('/')[0] || t.protocol || 'default';
  }

  function effectiveConcurrency() {
    var w = pgWinAt(pgState.activeWin);
    var v = w && w.config ? parseInt(w.config.imgConcurrency, 10) : 0;
    return Math.max(1, Math.min(8, v || 1));
  }

  function manageTimer(hasRunning) {
    if (hasRunning) {
      if (!tasksTimer) {
        tasksTimer = setInterval(function () {
          if (typeof pgRenderTaskQueue === 'function') pgRenderTaskQueue(true);
        }, 500);
      }
    } else {
      if (tasksTimer) {
        clearInterval(tasksTimer);
        tasksTimer = null;
      }
    }
  }

  function settleTask(t) {
    var canceled = t.status === 'canceled' || (t.abortCtrl && t.abortCtrl.signal.aborted);
    if (canceled) {
      t.status = 'canceled';
    } else if (t.failed > 0) {
      t.status = 'failed';
    } else if (t.generation.assets && t.generation.assets.length > 0) {
      t.status = 'completed';
    } else {
      t.status = 'failed';
    }
    t.completedAt = Date.now();
    t.durationMs = t.completedAt - t.createdAt;
    t.generation.status = canceled ? 'canceled' : (t.failed > 0 ? 'error' : (t.generation.assets && t.generation.assets.length ? 'ready' : 'error'));
    t.generation.error = t.error || (!t.generation.assets.length && !canceled ? (typeof pgT === 'function' ? pgT('pgImgNoResult') : 'No image') : '');
    t.generation.completedAt = t.completedAt;
    t.generation.durationMs = t.durationMs;
    t.generation.totalExpected = 0;
    var w = pgWinAt(t.winIndex);
    var st = w && pgImageState(w);
    if (st) {
      st.phase = t.generation.status;
      if (t.generation.status === 'error' && !st.error) st.error = t.generation.error;
    }
    if (t.winIndex === pgState.activeWin && pgState.mode === 'image') {
      if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(t.winIndex);
    }
    if (typeof pgSave === 'function') pgSave();
  }

  function mergeNorm(t, norm) {
    var newAssets = norm && Array.isArray(norm.assets) ? norm.assets : [];
    if (!newAssets.length) return;
    var prevLen = t.generation.assets.length;
    newAssets.forEach(function (a) { t.generation.assets.push(a); });
    if (!t.generation.revisedPrompt && norm.revisedPrompt) t.generation.revisedPrompt = norm.revisedPrompt;
    if (!t.generation.provider && norm.provider) t.generation.provider = norm.provider;
    if (!t.generation.key && norm.key) t.generation.key = norm.key;
    if (typeof window.finalizeImageAssets === 'function') {
      window.finalizeImageAssets(newAssets, t.generation, t.protocol === 'comfyui');
    }
    var w = pgWinAt(t.winIndex);
    var st = w && pgImageState(w);
    if (st) {
      var flat = typeof pgImageFlatAssets === 'function' ? pgImageFlatAssets(st) : [];
      if (prevLen === 0) {
        var targetIndex = -1;
        flat.forEach(function (entry, idx) {
          if (targetIndex < 0 && entry.generation === t.generation && entry.asset === newAssets[0]) {
            targetIndex = idx;
          }
        });
        if (targetIndex >= 0 && (st.activeAssetIndex < 0 || (flat[st.activeAssetIndex] && flat[st.activeAssetIndex].generation === t.generation))) {
          st.activeAssetIndex = targetIndex;
        }
      }
    }
    if (activeTaskId === t.id && (t.viewIndex < 0 || prevLen === 0)) {
      t.viewIndex = 0;
    }
    if (t.winIndex === pgState.activeWin && pgState.mode === 'image') {
      if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(t.winIndex);
    }
    if (typeof pgSave === 'function') pgSave();
  }

  function startUnit(t, key, uIdx) {
    var w = pgWinAt(t.winIndex);
    var unit = t.units[uIdx];
    window.pgImageExecUnit(w, unit.prompt || t.prompt, unit.req || t.req, unit, t.abortCtrl.signal, t.generation)
      .then(function (norm) {
        if (t.abortCtrl.signal.aborted) return;
        mergeNorm(t, norm);
      })
      .catch(function (err) {
        t.failed++;
        if (!t.error && err && err.name !== 'AbortError') {
          t.error = (err && err.message) || String(err);
        }
      })
      .then(function () {
        providerRunning[key] = Math.max(0, (providerRunning[key] || 1) - 1);
        t.inFlight = Math.max(0, t.inFlight - 1);
        if (t.inFlight === 0 && (t.nextUnit >= t.units.length || t.abortCtrl.signal.aborted)) {
          settleTask(t);
        }
        if (typeof pgRenderTaskQueue === 'function') pgRenderTaskQueue(true);
        pump();
      });
  }

  function pump() {
    var hasRunning = false;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (t.status === 'queued' || t.status === 'running') {
        if (t.abortCtrl.signal.aborted) {
          if (t.inFlight === 0) {
            settleTask(t);
          }
          continue;
        }
        var key = providerKeyOf(t);
        var limit = effectiveConcurrency();
        while (t.nextUnit < t.units.length && (providerRunning[key] || 0) < limit && !t.abortCtrl.signal.aborted) {
          providerRunning[key] = (providerRunning[key] || 0) + 1;
          t.status = 'running';
          t.inFlight++;
          var uIdx = t.nextUnit;
          t.nextUnit++;
          startUnit(t, key, uIdx);
        }
        if (t.status === 'running') hasRunning = true;
      }
    }
    manageTimer(hasRunning);
  }

  window.pgTaskEnqueue = function (winIndex, prompt, snapshot) {
    var w = pgWinAt(winIndex);
    if (!w) return Promise.reject(new Error(pgT('pgSelectModel')));
    var parts = splitPrompts(prompt);
    var built = window.pgImageBuildRequest(w, parts[0], snapshot);
    var cfg = w.config || {};
    var isComfy = built.req.protocol === 'comfyui';
    var model = (snapshot && snapshot.model) || cfg.model || (isComfy ? 'comfyui' : '');
    var st = pgImageState(w);
    var units;
    var totalExpected;
    if (parts.length === 1) {
      units = window.pgImagePlanUnits(built.req, built.count);
      totalExpected = built.count;
    } else {
      // Inspire batch mode: one request per delimiter-separated prompt.
      units = [];
      totalExpected = parts.length;
      for (var pi = 0; pi < parts.length; pi++) {
        var partBuilt = pi === 0 ? built : window.pgImageBuildRequest(w, parts[pi], snapshot);
        var partUnits = window.pgImagePlanUnits(partBuilt.req, 1);
        partUnits[0].prompt = parts[pi];
        partUnits[0].req = partBuilt.req;
        units.push(partUnits[0]);
      }
    }

    var generation = {
      id: uid('generation'),
      status: 'generating',
      prompt: prompt,
      promptFormat: (snapshot && snapshot.promptFormat) || 'natural',
      promptObject: (snapshot && snapshot.promptObject) || null,
      revisedPrompt: '',
      createdAt: Date.now(),
      completedAt: null,
      durationMs: 0,
      model: model,
      protocol: built.req.protocol,
      endpoint: built.req.endpoint,
      params: built.req.params,
      assets: [],
      totalExpected: totalExpected
    };

    st.phase = 'generating';
    st.error = '';
    st.submittedPrompt = prompt;
    st.generations.push(generation);

    var task = {
      id: uid('task'),
      winIndex: winIndex,
      prompt: prompt,
      model: model,
      protocol: built.req.protocol,
      endpoint: built.req.endpoint,
      req: built.req,
      status: 'queued',
      totalExpected: totalExpected,
      error: '',
      createdAt: Date.now(),
      completedAt: null,
      durationMs: 0,
      generation: generation,
      units: units,
      nextUnit: 0,
      inFlight: 0,
      failed: 0,
      viewIndex: -1,
      abortCtrl: new AbortController()
    };

    activeTaskId = task.id;
    st.activeAssetIndex = Math.max(0, (typeof pgImageFlatAssets === 'function' ? pgImageFlatAssets(st).length : 1) - 1);
    tasks.push(task);

    if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(winIndex);
    if (typeof pgRenderTaskQueue === 'function') pgRenderTaskQueue(true);

    pump();
    return Promise.resolve(generation);
  };

  window.pgTaskCancel = function (id) {
    var t = findTask(id);
    if (!t) return;
    if (t.status === 'queued' || t.status === 'running') {
      t.abortCtrl.abort();
      t.status = 'canceled';
      t.generation.status = 'canceled';
      t.generation.totalExpected = 0;
      var w = pgWinAt(t.winIndex);
      var st = w && pgImageState(w);
      if (st) st.phase = 'canceled';
      if (t.inFlight === 0) {
        settleTask(t);
      }
      if (typeof pgRenderTaskQueue === 'function') pgRenderTaskQueue(true);
      if (t.winIndex === pgState.activeWin && pgState.mode === 'image') {
        if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(t.winIndex);
      }
      pump();
    }
  };

  function abortTaskEntry(t) {
    if (t.status !== 'queued' && t.status !== 'running') return false;
    t.abortCtrl.abort();
    t.status = 'canceled';
    t.generation.status = 'canceled';
    t.generation.totalExpected = 0;
    if (t.inFlight === 0) settleTask(t);
    return true;
  }

  // Removes one queue entry; running work is aborted. Saved image files and
  // the generation kept in window history are untouched.
  window.pgTaskRemove = function (id) {
    var t = findTask(id);
    if (!t) return;
    tasks.splice(tasks.indexOf(t), 1);
    if (activeTaskId === id) activeTaskId = null;
    abortTaskEntry(t);
    if (typeof pgRenderTaskQueue === 'function') pgRenderTaskQueue(true);
    if (t.winIndex === pgState.activeWin && pgState.mode === 'image') {
      if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(t.winIndex);
    }
    pump();
  };

  // Clears every queue entry; running tasks are aborted in place. In-flight
  // units settle against detached task objects so their generations end up
  // consistently marked canceled in window history.
  window.pgTaskClearAll = function () {
    if (!tasks.length) return;
    var hadActiveWin = {};
    tasks.forEach(function (t) { hadActiveWin[t.winIndex] = true; abortTaskEntry(t); });
    tasks = [];
    activeTaskId = null;
    if (typeof pgRenderTaskQueue === 'function') pgRenderTaskQueue(true);
    if (pgState.mode === 'image' && hadActiveWin[pgState.activeWin]) {
      if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(pgState.activeWin);
    }
    pump();
  };

  window.pgTaskSelect = function (id) {
    if (activeTaskId === id) {
      activeTaskId = null;
    } else {
      activeTaskId = id;
      var t = findTask(id);
      if (t) {
        pgState.activeWin = t.winIndex;
        if (typeof pgRenderPanes === 'function') pgRenderPanes();
      }
    }
    if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(pgState.activeWin);
    if (typeof pgRenderTaskQueue === 'function') pgRenderTaskQueue(true);
  };

  window.pgTaskSelectedView = function () {
    if (!activeTaskId) return null;
    var t = findTask(activeTaskId);
    if (!t) return null;
    var gen = t.generation;
    var phase = (gen.status === 'generating') ? 'generating' : (gen.status === 'ready' ? 'ready' : (gen.status === 'error' ? 'error' : (gen.status === 'canceled' ? 'canceled' : 'empty')));
    return {
      phase: phase,
      error: t.error || gen.error || '',
      generations: [gen],
      get activeAssetIndex() { return t.viewIndex; },
      set activeAssetIndex(v) { t.viewIndex = v; },
      submittedPrompt: t.prompt
    };
  };

  window.pgTasksSnapshot = function () {
    return { tasks: tasks.slice(), activeTaskId: activeTaskId };
  };

  window.pgTaskWindowBusy = function (winIndex) {
    return tasks.some(function (t) {
      return t.winIndex === winIndex && (t.status === 'queued' || t.status === 'running');
    });
  };

  function escHtml(s) { return typeof pgEscapeHtml === 'function' ? pgEscapeHtml(s) : String(s || ''); }
  function escAttr(s) { return typeof pgEscapeAttr === 'function' ? pgEscapeAttr(s) : String(s || ''); }
  function t(k) { return typeof pgT === 'function' ? pgT(k) : k; }

  // Animated trash icon copied from the download page "Clear Completed"
  // button (style.css .bin-button hover rotates .bin-top). Mask id must be
  // unique per instance — several buttons can coexist in one document.
  var binSeq = 0;
  function binSvg() {
    binSeq++;
    var maskId = 'pg-bin-mask-' + binSeq;
    return '<svg class="bin-top" viewBox="0 0 39 7" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
      '<line y1="5" x2="39" y2="5" stroke="currentColor" stroke-width="4"></line>' +
      '<line x1="12" y1="1.5" x2="26.0357" y2="1.5" stroke="currentColor" stroke-width="3"></line>' +
      '</svg>' +
      '<svg class="bin-bottom" viewBox="0 0 33 39" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
      '<mask id="' + maskId + '" fill="white"><path d="M0 0H33V35C33 37.2091 31.2091 39 29 39H4C1.79086 39 0 37.2091 0 35V0Z"></path></mask>' +
      '<path d="M0 0H33H0ZM37 35C37 39.4183 33.4183 43 29 43H4C-0.418278 43 -4 39.4183 -4 35H4H29H37ZM4 43C-0.418278 43 -4 39.4183 -4 35V0H4V35V43ZM37 0V35C37 39.4183 33.4183 43 29 43V35V0H37Z" fill="currentColor" mask="url(#' + maskId + ')"></path>' +
      '<path d="M12 6L12 29" stroke="currentColor" stroke-width="4"></path>' +
      '<path d="M21 6V29" stroke="currentColor" stroke-width="4"></path>' +
      '</svg>';
  }
  window.pgTaskBinSvg = binSvg;

  window.pgRenderTaskQueue = function (visible) {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    var container = document.getElementById('pg-tasks-content');
    if (!visible || !container) {
      if (container) container.innerHTML = '';
      manageTimer(false);
      return;
    }

    if (!tasks.length) {
      container.innerHTML = '<div class="pg-req-empty">' + escHtml(t('pgTaskEmpty')) + '</div>';
      manageTimer(false);
      return;
    }

    var html = '';
    var hasRunning = false;
    for (var idx = tasks.length - 1; idx >= 0; idx--) {
      var taskItem = tasks[idx];
      var isRunning = taskItem.status === 'running';
      if (isRunning) hasRunning = true;
      var isSelected = taskItem.id === activeTaskId;
      var statusKey = 'pgTaskStatus' + taskItem.status.charAt(0).toUpperCase() + taskItem.status.slice(1);
      var statusLabel = t(statusKey);
      var modelShort = String(taskItem.model || '').split('/').pop() || taskItem.protocol;
      var countDone = taskItem.generation && taskItem.generation.assets ? taskItem.generation.assets.length : 0;
      var countText = countDone + '/' + taskItem.totalExpected;
      var elapsedText = '';
      if (isRunning) {
        var elapsedSec = Math.floor((Date.now() - taskItem.createdAt) / 1000);
        elapsedText = elapsedSec + 's';
      } else if (taskItem.durationMs > 0) {
        elapsedText = Math.max(1, Math.round(taskItem.durationMs / 1000)) + 's';
      }

      var stopBtnHtml = '';
      if (taskItem.status === 'queued' || taskItem.status === 'running') {
        stopBtnHtml = '<button class="pg-task-stop-btn" onclick="event.stopPropagation();pgTaskCancel(\'' + escAttr(taskItem.id) + '\')" title="' + escAttr(t('pgStop')) + '">⏹</button>';
      }

      html += '<div class="pg-task-row' + (isSelected ? ' active' : '') + '" onclick="pgTaskSelect(\'' + escAttr(taskItem.id) + '\')">' +
        '<span class="pg-task-dot pg-task-dot-' + escAttr(taskItem.status) + '" title="' + escAttr(statusLabel) + '"></span>' +
        '<div class="pg-task-info">' +
          '<div class="pg-task-prompt" title="' + escAttr(taskItem.prompt) + '">' + escHtml(taskItem.prompt) + '</div>' +
          '<div class="pg-task-meta">' +
            '<span class="pg-task-model" title="' + escAttr(taskItem.model) + '">' + escHtml(modelShort) + '</span>' +
            '<span class="pg-task-count">' + escHtml(countText) + '</span>' +
            (elapsedText ? '<span class="pg-task-time">' + escHtml(elapsedText) + '</span>' : '') +
          '</div>' +
        '</div>' +
        stopBtnHtml +
        '<button class="pg-task-remove-btn btn-icon bin-button" onclick="event.stopPropagation();pgTaskRemove(\'' + escAttr(taskItem.id) + '\')" title="' + escAttr(t('pgTaskRemoveTip')) + '" aria-label="' + escAttr(t('pgTaskRemoveTip')) + '">' + binSvg() + '</button>' +
      '</div>';
    }

    container.innerHTML = html;
    manageTimer(hasRunning);
  };
})();
