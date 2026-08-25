// pg-image-tasks.js — Playground Image task queue, asynchronous dispatcher, and concurrency controller.
(function () {
  'use strict';

  function uid(prefix) { return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }

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
    window.pgImageExecUnit(w, t.prompt, t.req, unit, t.abortCtrl.signal, t.generation)
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
    var built = window.pgImageBuildRequest(w, prompt, snapshot);
    var cfg = w.config || {};
    var isComfy = built.req.protocol === 'comfyui';
    var model = (snapshot && snapshot.model) || cfg.model || (isComfy ? 'comfyui' : '');
    var st = pgImageState(w);
    var units = window.pgImagePlanUnits(built.req, built.count);

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
      totalExpected: built.count
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
      totalExpected: built.count,
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
      '</div>';
    }

    container.innerHTML = html;
    manageTimer(hasRunning);
  };
})();
