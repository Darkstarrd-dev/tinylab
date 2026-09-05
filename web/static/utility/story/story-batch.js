// web/static/utility/story/story-batch.js — Batch Generation
// Dependency load order:
// vendor/diff.min.js -> utility/editor/editor.js -> editor_textreview_diff.js -> storymaker.js -> story sub-pages -> story-batch.js

(function() {
  'use strict';

  var currentCtx = null;
  var currentAbort = null;
  var draftModel = { value: '', label: '' };
  var reviewModel = { value: '', label: '' };

  var outlineNodes = [];
  var existingChapters = [];

  // Batch runner state
  var tasks = []; // { chapterIndex, title, outlineNodeId, status: 'pending'|'drafting'|'finalizing'|'completed'|'failed', error?: string }
  var runnerState = 'idle'; // 'idle' | 'running' | 'paused'
  var currentIndex = 0;
  var targetWordCount = 3000;

  function render(container, ctx) {
    currentCtx = ctx;
    var book = ctx.getActiveBook();
    if (!book) {
      ctx.showEmptyBookState(container);
      return;
    }
    loadData(function() {
      drawUI(container);
    });
  }

  function loadData(cb) {
    var bookId = currentCtx.activeBookId;
    Promise.all([
      currentCtx.api.get('/outline?bookId=' + encodeURIComponent(bookId)),
      currentCtx.api.get('/chapters?bookId=' + encodeURIComponent(bookId))
    ]).then(function(results) {
      outlineNodes = (results[0] && results[0].outline) || [];
      existingChapters = (results[1] && results[1].chapters) || [];
      if (tasks.length === 0 && outlineNodes.length > 0) {
        initTasksFromOutline();
      }
      if (cb) cb();
    }).catch(function(err) {
      console.warn('load batch data error:', err);
      if (cb) cb();
    });
  }

  function initTasksFromOutline() {
    var isEn = currentLang() === 'en';
    tasks = outlineNodes.map(function(n) {
      var existing = existingChapters.find(function(c) { return c.Index === n.order; });
      var status = (existing && existing.Status === 'final') ? 'completed' : 'pending';
      var fallbackTitle = isEn ? ('Chapter ' + n.order) : ('第 ' + n.order + ' 章');
      return {
        chapterIndex: n.order,
        title: n.title || fallbackTitle,
        outlineNodeId: n.id,
        status: status,
        selected: status !== 'completed' // pre-select incomplete
      };
    });
  }

  function pickModel(current, onPick) {
    if (typeof pgOpenModelPicker === 'function') {
      pgOpenModelPicker(current.value, function(res) {
        if (res && res.id) {
          onPick({ value: res.id, label: res.name || res.id });
        }
      }, { kindFilter: 'text' });
    } else {
      var isEn = currentLang() === 'en';
      var m = prompt(isEn ? 'Enter Model ID (e.g. provider/model-name):' : '请输入模型 ID (例如 provider/model-name):', current.value || '');
      if (m) onPick({ value: m, label: m });
    }
  }

  function drawUI(container) {
    var book = currentCtx.getActiveBook();
    var isEn = currentLang() === 'en';

    var completedCount = tasks.filter(function(t) { return t.status === 'completed'; }).length;
    var totalCount = tasks.length;
    var pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    var startBtnText = '▶ ' + escapeHtml(t('storyBatchStartBtn'));
    var pauseBtnText = '⏸ ' + escapeHtml(t('storyBatchPauseBtn'));
    var resumeBtnText = '▶ ' + (isEn ? 'Resume' : '继续');
    var stopBtnText = '⏹ ' + escapeHtml(t('storyBatchCancelBtn'));

    var draftLabel = draftModel.label || (isEn ? 'Select Draft Model' : '选择正文模型');
    var reviewLabel = reviewModel.label || (isEn ? 'Select Review Model' : '选择审校模型');

    var progressText = isEn ?
      ('Progress: ' + completedCount + ' / ' + totalCount + ' chapters (' + pct + '%)') :
      ('生产总进度：' + completedCount + ' / ' + totalCount + ' 章 (' + pct + '%)');

    var statusText = runnerState === 'running' ?
      ('🚀 ' + escapeHtml(t('storyBatchStatusRunning'))) :
      (runnerState === 'paused' ? ('⏸ ' + escapeHtml(t('storyBatchStatusPaused'))) : escapeHtml(t('storyBatchStatusIdle')));

    container.innerHTML = '' +
      '<div class="sm-page-container">' +
        '<div class="sm-page-header">' +
          '<div class="sm-page-title">' + escapeHtml(t('storyBatch')) + ' <span style="font-size:14px;color:var(--text-secondary);font-weight:normal;">(' + escapeHtml(book.title) + ')</span></div>' +
          '<div class="sm-page-actions">' +
            (runnerState === 'idle' ?
              '<button class="btn btn-primary" type="button" id="sm-batch-start" ' + (totalCount === 0 ? 'disabled' : '') + '>' + startBtnText + '</button>' :
              (runnerState === 'running' ?
                '<button class="btn btn-ghost" type="button" id="sm-batch-pause">' + pauseBtnText + '</button>' :
                '<button class="btn btn-primary" type="button" id="sm-batch-resume">' + resumeBtnText + '</button>'
              ) +
              '<button class="btn btn-danger" type="button" id="sm-batch-stop">' + stopBtnText + '</button>'
            ) +
          '</div>' +
        '</div>' +

        // Configuration Card
        '<div class="sm-card">' +
          '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">' +
            '<div style="display:flex;flex-direction:column;gap:4px;">' +
              '<span class="sm-field-label">' + (isEn ? 'Draft Generation Model:' : '正文生成模型：') + '</span>' +
              '<button type="button" class="sm-model-btn" id="sm-batch-draft-model-btn" ' + (runnerState !== 'idle' ? 'disabled' : '') + '>' +
                '<span>✍️</span><span id="sm-batch-draft-model-label">' + escapeHtml(draftLabel) + '</span>' +
              '</button>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:4px;">' +
              '<span class="sm-field-label">' + (isEn ? 'Finalize Review Model:' : '定稿审校模型：') + '</span>' +
              '<button type="button" class="sm-model-btn" id="sm-batch-rev-model-btn" ' + (runnerState !== 'idle' ? 'disabled' : '') + '>' +
                '<span>📑</span><span id="sm-batch-rev-model-label">' + escapeHtml(reviewLabel) + '</span>' +
              '</button>' +
            '</div>' +
            '<div style="width:130px;">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM4TargetWords')) + '</span>' +
              renderStepperHtml('sm-batch-target-words', targetWordCount, 1000, 10000, 500) +
            '</div>' +
            '<div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:6px;">' +
              '<div style="display:flex;justify-content:space-between;font-size:12px;">' +
                '<span>' + progressText + '</span>' +
                '<span style="color:var(--text-secondary);">' + statusText + '</span>' +
              '</div>' +
              '<div style="height:8px;background:rgba(255,255,255,0.1);border-radius:4px;overflow:hidden;">' +
                '<div style="width:' + pct + '%;height:100%;background:var(--accent);transition:width 0.3s ease;"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Task Queue Card
        '<div class="sm-card" style="padding:0;overflow:hidden;">' +
          '<div style="padding:12px 16px;background:rgba(0,0,0,0.05);border-bottom:1px solid var(--glass-border);display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="font-weight:600;font-size:var(--font-base);">' + (isEn ? 'Production Queue' : '生产任务队列') + '</div>' +
            (runnerState === 'idle' ?
              '<div style="display:flex;gap:8px;">' +
                '<button type="button" class="btn btn-ghost btn-sm" id="sm-batch-sel-all">' + (isEn ? 'Select All' : '全选') + '</button>' +
                '<button type="button" class="btn btn-ghost btn-sm" id="sm-batch-sel-none">' + (isEn ? 'Deselect All' : '全清') + '</button>' +
                '<button type="button" class="btn btn-ghost btn-sm" id="sm-batch-reset">' + (isEn ? 'Reset' : '重置状态') + '</button>' +
              '</div>' : '') +
          '</div>' +
          '<div class="sm-table-wrap" style="border:none;border-radius:0;">' +
            '<table class="sm-table">' +
              '<thead>' +
                '<tr>' +
                  '<th style="width:40px;">' + (isEn ? 'Select' : '选择') + '</th>' +
                  '<th style="width:60px;">#</th>' +
                  '<th>' + (isEn ? 'Outline Title' : '章节大纲标题') + '</th>' +
                  '<th>' + escapeHtml(t('storyM5ColStatus')) + '</th>' +
                  '<th>' + (isEn ? 'Details / Error' : '详情 / 错误') + '</th>' +
                '</tr>' +
              '</thead>' +
              '<tbody id="sm-batch-tbody"></tbody>' +
            '</table>' +
          '</div>' +
        '</div>' +
      '</div>';

    var tbody = container.querySelector('#sm-batch-tbody');
    if (tasks.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text-secondary);">' +
        (isEn ? 'Outline is empty. Please plan and adopt chapter blueprints in M0 first.' : '大纲蓝图为空，请先在 M0 规划并采纳章节蓝图。') + '</td></tr>';
    } else {
      var rowsHtml = '';
      for (var i = 0; i < tasks.length; i++) {
        var tsk = tasks[i];
        var statusBadge = '';
        switch (tsk.status) {
          case 'drafting':
            statusBadge = '<span class="tag tag-blue">✍️ ' + (isEn ? 'Drafting' : '起草正文中') + '</span>';
            break;
          case 'finalizing':
            statusBadge = '<span class="tag tag-purple">📑 ' + (isEn ? 'Finalizing' : '定稿审校中') + '</span>';
            break;
          case 'completed':
            statusBadge = '<span class="tag tag-green">✓ ' + (isEn ? 'Completed' : '已完成') + '</span>';
            break;
          case 'failed':
            statusBadge = '<span class="tag tag-red">✕ ' + (isEn ? 'Failed' : '失败中断') + '</span>';
            break;
          default:
            statusBadge = '<span class="tag tag-gray">' + (isEn ? 'Waiting' : '等待中') + '</span>';
            break;
        }

        var detailText = tsk.error || (tsk.status === 'completed' ? (isEn ? 'Stored' : '已入库') : '—');
        rowsHtml += '<tr>' +
          '<td><input type="checkbox" class="sm-task-cb" data-idx="' + i + '" ' + (tsk.selected ? 'checked' : '') + ' ' + (runnerState !== 'idle' ? 'disabled' : '') + '></td>' +
          '<td>' + tsk.chapterIndex + '</td>' +
          '<td><strong>' + escapeHtml(tsk.title) + '</strong></td>' +
          '<td>' + statusBadge + '</td>' +
          '<td style="color:' + (tsk.status === 'failed' ? 'var(--danger, #ff6b6b)' : 'var(--text-secondary)') + ';font-size:12px;">' +
            escapeHtml(detailText) +
          '</td>' +
        '</tr>';
      }
      tbody.innerHTML = rowsHtml;
    }

    // Bind event listeners
    container.querySelector('#sm-batch-draft-model-btn')?.addEventListener('click', function() {
      pickModel(draftModel, function(m) {
        draftModel = m;
        container.querySelector('#sm-batch-draft-model-label').textContent = m.label;
      });
    });

    container.querySelector('#sm-batch-rev-model-btn')?.addEventListener('click', function() {
      pickModel(reviewModel, function(m) {
        reviewModel = m;
        container.querySelector('#sm-batch-rev-model-label').textContent = m.label;
      });
    });

    container.querySelector('#sm-batch-target-words')?.addEventListener('change', function(e) {
      targetWordCount = parseInt(e.target.value, 10) || 3000;
    });

    tbody.querySelectorAll('.sm-task-cb').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var idx = parseInt(cb.dataset.idx, 10);
        if (tasks[idx]) tasks[idx].selected = cb.checked;
      });
    });

    container.querySelector('#sm-batch-sel-all')?.addEventListener('click', function() {
      tasks.forEach(function(t) { t.selected = true; });
      drawUI(container);
    });
    container.querySelector('#sm-batch-sel-none')?.addEventListener('click', function() {
      tasks.forEach(function(t) { t.selected = false; });
      drawUI(container);
    });
    container.querySelector('#sm-batch-reset')?.addEventListener('click', function() {
      initTasksFromOutline();
      drawUI(container);
    });

    // Start / Pause / Resume / Stop
    container.querySelector('#sm-batch-start')?.addEventListener('click', function() {
      if (!draftModel.value || !reviewModel.value) {
        toast(isEn ? 'Please select both draft and review models' : '请先选择正文模型与审校模型', 'warning');
        return;
      }
      var selectedTasks = tasks.filter(function(t) { return t.selected && t.status !== 'completed'; });
      if (selectedTasks.length === 0) {
        toast(isEn ? 'No pending selected chapters' : '没有待处理的选中章节', 'warning');
        return;
      }
      runnerState = 'running';
      currentIndex = 0;
      drawUI(container);
      runNextTask(container);
    });

    container.querySelector('#sm-batch-pause')?.addEventListener('click', function() {
      runnerState = 'paused';
      toast(isEn ? 'Batch paused, will suspend after active chapter' : '生产已暂停，在途章节完成后挂起', 'info');
      drawUI(container);
    });

    container.querySelector('#sm-batch-resume')?.addEventListener('click', function() {
      runnerState = 'running';
      toast(isEn ? 'Resuming batch production' : '继续批量生产', 'info');
      drawUI(container);
      runNextTask(container);
    });

    container.querySelector('#sm-batch-stop')?.addEventListener('click', function() {
      runnerState = 'idle';
      if (currentAbort) {
        try { currentAbort.abort(); } catch (e) {}
        currentAbort = null;
      }
      toast(isEn ? 'Batch production cancelled' : '已终止批量生产', 'warning');
      drawUI(container);
    });
  }

  function runNextTask(container) {
    var isEn = currentLang() === 'en';
    if (runnerState !== 'running') return;

    // Find next pending selected task
    var task = null;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].selected && (tasks[i].status === 'pending' || tasks[i].status === 'drafting' || tasks[i].status === 'finalizing')) {
        task = tasks[i];
        break;
      }
    }

    if (!task) {
      runnerState = 'idle';
      toast(isEn ? 'All selected chapters completed!' : '全部选中章节批量生产完毕！', 'success');
      drawUI(container);
      return;
    }

    // Step 1: Draft
    task.status = 'drafting';
    task.error = '';
    drawUI(container);

    var draftedContent = '';
    currentAbort = currentCtx.api.sse('/draft', {
      model: draftModel.value,
      context: {
        bookId: currentCtx.activeBookId,
        chapterIndex: task.chapterIndex
      },
      targetWordCount: targetWordCount
    }, function(delta) {
      if (typeof delta === 'string') draftedContent += delta;
    }, function() {
      // Step 2: Save Draft Chapter
      var chapPayload = {
        id: 'ch_' + Date.now() + '_' + task.chapterIndex,
        bookId: currentCtx.activeBookId,
        index: task.chapterIndex,
        title: task.title,
        content: draftedContent,
        status: 'draft',
        outlineNodeId: task.outlineNodeId
      };

      currentCtx.api.post('/chapters', chapPayload).then(function(savedChap) {
        // Step 3: Finalize & Consistency
        task.status = 'finalizing';
        drawUI(container);

        var globalSummary = (currentCtx.getActiveBook() && currentCtx.getActiveBook().globalSummary) || '';
        return currentCtx.api.post('/finalize', {
          model: reviewModel.value,
          bookId: currentCtx.activeBookId,
          chapterId: savedChap.id,
          chapterText: draftedContent,
          existingGlobalSummary: globalSummary
        }).then(function(finRes) {
          return currentCtx.api.post('/consistency', {
            model: reviewModel.value,
            bookId: currentCtx.activeBookId,
            chapterId: savedChap.id,
            chapterText: draftedContent
          }).then(function() {
            // Mark final
            return currentCtx.api.patch('/chapters/' + encodeURIComponent(savedChap.id), {
              status: 'final',
              summary: finRes.chapterSummary || ''
            });
          });
        });
      }).then(function() {
        task.status = 'completed';
        drawUI(container);
        // Continue to next task
        setTimeout(function() { runNextTask(container); }, 300);
      }).catch(function(err) {
        // Fail-fast
        task.status = 'failed';
        task.error = err.message;
        runnerState = 'idle';
        toast((isEn ? ('Chapter ' + task.chapterIndex + ' failed: ') : ('第 ' + task.chapterIndex + ' 章生产失败，已中断后续任务 (Fail-Fast): ')) + err.message, 'error');
        drawUI(container);
      });
    }, function(err) {
      // Draft generation failed
      task.status = 'failed';
      task.error = err.message;
      runnerState = 'idle';
      toast((isEn ? ('Chapter ' + task.chapterIndex + ' drafting failed: ') : ('第 ' + task.chapterIndex + ' 章起草失败，已中断生产: ')) + err.message, 'error');
      drawUI(container);
    });
  }

  // Lifecycle
  window.storyRenderBatch = render;
  window.storyCleanupBatch = function() {
    runnerState = 'idle';
    if (currentAbort) {
      try { currentAbort.abort(); } catch (e) {}
      currentAbort = null;
    }
  };

})();
