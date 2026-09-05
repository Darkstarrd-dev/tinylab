// web/static/utility/story/story-m5.js — M5 Chapter Management & Consistency Review
// Dependency load order:
// vendor/diff.min.js -> utility/editor/editor.js -> editor_textreview_diff.js -> storymaker.js -> story sub-pages -> story-m5.js

(function() {
  'use strict';

  var currentCtx = null;
  var currentTab = 'chapters'; // 'chapters' | 'timeline'
  var checkModel = { value: '', label: '' };

  var chaptersCache = [];
  var issuesCache = [];
  var stateEventsCache = [];
  var cardsCache = [];
  var selectedTimelineCharId = '';

  var finalizePromptOverride = '';
  var consistencyPromptOverride = '';

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
      currentCtx.api.get('/chapters?bookId=' + encodeURIComponent(bookId)),
      currentCtx.api.get('/issues?bookId=' + encodeURIComponent(bookId)),
      currentCtx.api.get('/state-events?bookId=' + encodeURIComponent(bookId)),
      currentCtx.api.get('/cards?bookId=' + encodeURIComponent(bookId)),
      currentCtx.api.get('/prompts/m5-finalize'),
      currentCtx.api.get('/prompts/m5-consistency')
    ]).then(function(results) {
      chaptersCache = (results[0] && results[0].chapters) || [];
      issuesCache = (results[1] && results[1].issues) || [];
      stateEventsCache = (results[2] && results[2].stateEvents) || [];
      cardsCache = (results[3] && results[3].cards) || [];
      finalizePromptOverride = (results[4] && results[4].content) || '';
      consistencyPromptOverride = (results[5] && results[5].content) || '';

      var charCards = cardsCache.filter(function(c) { return c.type === 'character'; });
      if (!selectedTimelineCharId && charCards.length > 0) {
        selectedTimelineCharId = charCards[0].id;
      }
      if (cb) cb();
    }).catch(function(err) {
      console.warn('load m5 data error:', err);
      if (cb) cb();
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

    container.innerHTML = '' +
      '<div class="sm-page-container">' +
        '<div class="sm-page-header">' +
          '<div class="sm-page-title">' + escapeHtml(t('storyM5')) + ' <span style="font-size:14px;color:var(--text-secondary);font-weight:normal;">(' + escapeHtml(book.title) + ')</span></div>' +
          '<div class="sm-page-actions">' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM5CheckModel')) + '</span>' +
              '<button type="button" class="sm-model-btn" id="sm-m5-model-btn">' +
                '<span>🤖</span><span id="sm-m5-model-label">' + escapeHtml(checkModel.label || t('storySelectModel')) + '</span>' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Tab switches & Prompt overrides
        '<div class="sm-card" style="padding:14px 20px;gap:12px;">' +
          '<div class="sm-tabs">' +
            '<button type="button" class="sm-tab-btn' + (currentTab === 'chapters' ? ' active' : '') + '" data-tab="chapters">' + escapeHtml(t('storyM5TabChapters')) + ' (' + chaptersCache.length + ')</button>' +
            '<button type="button" class="sm-tab-btn' + (currentTab === 'timeline' ? ' active' : '') + '" data-tab="timeline">' + escapeHtml(t('storyM5TabTimeline')) + ' (' + stateEventsCache.length + ')</button>' +
          '</div>' +

          '<details class="sm-prompt-details">' +
            '<summary class="sm-prompt-summary">⚙️ ' + escapeHtml(t('storyM5PromptPreset')) + '</summary>' +
            '<div class="sm-form-grid" style="margin-top:10px;">' +
              '<div class="sm-field">' +
                '<span class="sm-field-label">' + escapeHtml(t('storyM5FinalizePromptLabel')) + '</span>' +
                '<textarea class="sm-textarea" id="sm-m5-fin-prompt" rows="3">' + escapeHtml(finalizePromptOverride) + '</textarea>' +
              '</div>' +
              '<div class="sm-field">' +
                '<span class="sm-field-label">' + escapeHtml(t('storyM5ConsistencyPromptLabel')) + '</span>' +
                '<textarea class="sm-textarea" id="sm-m5-con-prompt" rows="3">' + escapeHtml(consistencyPromptOverride) + '</textarea>' +
              '</div>' +
            '</div>' +
            '<button type="button" class="btn btn-ghost btn-sm" id="sm-m5-save-prompts" style="margin-top:8px;align-self:flex-end;">' + escapeHtml(t('storyM5SavePrompts')) + '</button>' +
          '</details>' +
        '</div>' +

        // Main Tab Content Area
        '<div id="sm-m5-main-content"></div>' +
      '</div>';

    container.querySelector('#sm-m5-model-btn')?.addEventListener('click', function() {
      pickModel(checkModel, function(m) {
        checkModel = m;
        container.querySelector('#sm-m5-model-label').textContent = m.label;
      });
    });

    container.querySelectorAll('.sm-tab-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        currentTab = btn.dataset.tab;
        drawUI(container);
      });
    });

    container.querySelector('#sm-m5-save-prompts')?.addEventListener('click', function() {
      var fin = container.querySelector('#sm-m5-fin-prompt').value.trim();
      var con = container.querySelector('#sm-m5-con-prompt').value.trim();
      Promise.all([
        currentCtx.api.put('/prompts/m5-finalize', { content: fin }),
        currentCtx.api.put('/prompts/m5-consistency', { content: con })
      ]).then(function() {
        finalizePromptOverride = fin;
        consistencyPromptOverride = con;
        toast(t('storySaved'), 'success');
      });
    });

    renderCurrentTab(container);
  }

  function renderCurrentTab(container) {
    var contentEl = container.querySelector('#sm-m5-main-content');
    if (!contentEl) return;
    if (currentTab === 'chapters') {
      renderChaptersTable(contentEl);
    } else {
      renderStateTimeline(contentEl);
    }
  }

  function renderChaptersTable(contentEl) {
    var isEn = currentLang() === 'en';
    if (chaptersCache.length === 0) {
      contentEl.innerHTML = '<div class="sm-card">' +
        '<div class="sm-empty-state">' +
          '<div class="sm-empty-icon">📑</div>' +
          '<p>' + escapeHtml(t('storyM5NoChapters')) + '</p>' +
        '</div>' +
      '</div>';
      return;
    }

    var html = '<div class="sm-card" style="padding:0;overflow:hidden;">' +
      '<table class="sm-table">' +
        '<thead>' +
          '<tr>' +
            '<th>#</th>' +
            '<th>' + escapeHtml(t('storyM5ColTitle')) + '</th>' +
            '<th>' + escapeHtml(t('storyM5ColStatus')) + '</th>' +
            '<th>' + escapeHtml(t('storyM5ColWordCount')) + '</th>' +
            '<th>' + escapeHtml(t('storyM5ColConflicts')) + '</th>' +
            '<th>' + escapeHtml(t('createdAt')) + '</th>' +
            '<th style="text-align:right;">' + escapeHtml(t('actions')) + '</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>';

    for (var i = 0; i < chaptersCache.length; i++) {
      var ch = chaptersCache[i];
      var chIssues = issuesCache.filter(function(is) { return is.chapterId === ch.id && is.status === 'open'; });
      var issueBadge = chIssues.length > 0 ?
        '<span class="tag tag-amber" style="font-size:11px;">⚠️ ' + (isEn ? (chIssues.length + ' conflict(s)') : (chIssues.length + ' 项冲突')) + '</span>' :
        '<span style="color:var(--text-secondary);font-size:11px;">' + (isEn ? 'No conflicts' : '无冲突') + '</span>';

      var statusBadge = ch.Status === 'final' ?
        '<span class="tag tag-green">' + escapeHtml(t('storyM5StatusFinal')) + '</span>' :
        '<span class="tag tag-blue">' + escapeHtml(t('storyM5StatusDraft')) + '</span>';

      html += '<tr>' +
        '<td>' + ch.Index + '</td>' +
        '<td><button type="button" class="btn btn-ghost btn-sm sm-ch-view-title" data-id="' + escapeHtml(ch.id) + '" style="font-weight:600;padding:2px 6px;">' + escapeHtml(ch.Title) + '</button></td>' +
        '<td>' + statusBadge + '</td>' +
        '<td>' + t('storyM4WordStats', [(ch.Content || '').length]) + '</td>' +
        '<td>' + issueBadge + '</td>' +
        '<td style="color:var(--text-secondary);">' + escapeHtml((ch.UpdatedAt || '').slice(0, 16).replace('T', ' ')) + '</td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          (ch.Status !== 'final' ?
            '<button class="btn btn-primary btn-sm sm-ch-finalize" data-id="' + escapeHtml(ch.id) + '" type="button">' + escapeHtml(t('storyM5BtnFinalize')) + '</button> ' :
            '<button class="btn btn-ghost btn-sm sm-ch-revert" data-id="' + escapeHtml(ch.id) + '" type="button">' + (isEn ? 'Revert' : '退回草稿') + '</button> ' +
            '<button class="btn btn-ghost btn-sm sm-ch-recheck" data-id="' + escapeHtml(ch.id) + '" type="button">' + escapeHtml(t('storyM5BtnReview')) + '</button> '
          ) +
          '<button class="btn btn-ghost btn-sm sm-ch-edit" data-id="' + escapeHtml(ch.id) + '" type="button">' + (isEn ? 'Draft' : '正文') + '</button>' +
        '</td>' +
      '</tr>';
    }
    html += '</tbody></table></div>';
    contentEl.innerHTML = html;

    // Events
    contentEl.querySelectorAll('.sm-ch-view-title, .sm-ch-edit').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var ch = chaptersCache.find(function(x) { return x.id === btn.dataset.id; });
        if (ch) openChapterDrawer(ch);
      });
    });

    contentEl.querySelectorAll('.sm-ch-finalize').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var ch = chaptersCache.find(function(x) { return x.id === btn.dataset.id; });
        if (ch) runFinalizeAndCheck(ch);
      });
    });

    contentEl.querySelectorAll('.sm-ch-recheck').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var ch = chaptersCache.find(function(x) { return x.id === btn.dataset.id; });
        if (ch) runConsistencyCheckOnly(ch);
      });
    });

    contentEl.querySelectorAll('.sm-ch-revert').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var ch = chaptersCache.find(function(x) { return x.id === btn.dataset.id; });
        if (!ch) return;
        ch.Status = 'draft';
        currentCtx.api.patch('/chapters/' + encodeURIComponent(ch.id), { status: 'draft' }).then(function() {
          toast(isEn ? 'Chapter reverted to draft' : '章节已退回草稿状态', 'success');
          loadData(function() { drawUI(contentEl.parentElement); });
        });
      });
    });
  }

  function runFinalizeAndCheck(ch) {
    var isEn = currentLang() === 'en';
    if (!checkModel.value) {
      toast(isEn ? 'Please select a review model first' : '请先在右上角选择审校模型', 'warning');
      return;
    }
    toast(isEn ? 'Extracting summary & running consistency review...' : '正在进行定稿摘要提取与一致性审校...', 'info');

    var globalSummary = (currentCtx.getActiveBook() && currentCtx.getActiveBook().globalSummary) || '';

    // Step 1: Finalize
    currentCtx.api.post('/finalize', {
      model: checkModel.value,
      bookId: currentCtx.activeBookId,
      chapterId: ch.id,
      chapterText: ch.Content,
      existingGlobalSummary: globalSummary,
      systemPrompt: finalizePromptOverride
    }).then(function(finRes) {
      // Step 2: Consistency
      return currentCtx.api.post('/consistency', {
        model: checkModel.value,
        bookId: currentCtx.activeBookId,
        chapterId: ch.id,
        chapterText: ch.Content,
        systemPrompt: consistencyPromptOverride
      }).then(function(conRes) {
        // Mark chapter final and save summary
        return currentCtx.api.patch('/chapters/' + encodeURIComponent(ch.id), {
          status: 'final',
          summary: finRes.chapterSummary || ''
        });
      });
    }).then(function() {
      toast(t('storyM5FinalizeDone'), 'success');
      loadData(function() {
        var container = document.getElementById('sm-main-content');
        if (container) drawUI(container);
      });
    }).catch(function(err) {
      toast((isEn ? 'Finalize failed: ' : '定稿流程失败: ') + err.message, 'error');
    });
  }

  function runConsistencyCheckOnly(ch) {
    var isEn = currentLang() === 'en';
    if (!checkModel.value) {
      toast(isEn ? 'Please select a review model first' : '请先选择审校模型', 'warning');
      return;
    }
    toast(isEn ? 'Running consistency review...' : '正在进行一致性审校...', 'info');
    currentCtx.api.post('/consistency', {
      model: checkModel.value,
      bookId: currentCtx.activeBookId,
      chapterId: ch.id,
      chapterText: ch.Content,
      systemPrompt: consistencyPromptOverride
    }).then(function() {
      toast(isEn ? 'Consistency review complete!' : '审校完成！', 'success');
      loadData(function() {
        var container = document.getElementById('sm-main-content');
        if (container) drawUI(container);
      });
    }).catch(function(err) {
      toast((isEn ? 'Review failed: ' : '审校失败: ') + err.message, 'error');
    });
  }

  function openChapterDrawer(chapter) {
    var isEn = currentLang() === 'en';
    var overlay = document.createElement('div');
    overlay.className = 'sm-drawer-overlay';
    var chTitle = (isEn ? ('Chapter ' + chapter.Index + ': ') : ('第 ' + chapter.Index + ' 章：')) + escapeHtml(chapter.Title);
    overlay.innerHTML = '' +
      '<div class="sm-drawer" style="width:720px;">' +
        '<div class="sm-drawer-header">' +
          '<div class="modal-title">' + chTitle + '</div>' +
          '<button class="modal-close-btn">&times;</button>' +
        '</div>' +
        '<div class="sm-drawer-body">' +
          '<div class="sm-field">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
              '<span class="sm-field-label">' + (isEn ? 'Content (saving will revert to draft):' : '正文内容 (修改保存后将重置为草稿状态)：') + '</span>' +
              '<span style="font-size:12px;color:var(--text-secondary);">' + t('storyM4WordStats', [(chapter.Content || '').length]) + '</span>' +
            '</div>' +
            '<textarea class="sm-textarea" id="sm-dr-content" style="height:320px;font-family:monospace;line-height:1.6;">' +
              escapeHtml(chapter.Content || '') +
            '</textarea>' +
          '</div>' +

          // Consistency Issues List
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + (isEn ? 'Consistency Issue Report:' : '一致性审校问题报告：') + '</span>' +
            '<div id="sm-dr-issues-wrap" style="display:flex;flex-direction:column;gap:8px;"></div>' +
          '</div>' +
        '</div>' +
        '<div class="sm-drawer-footer">' +
          '<button class="btn btn-ghost" type="button" id="sm-dr-close">' + escapeHtml(t('cancel')) + '</button>' +
          '<button class="btn btn-primary" type="button" id="sm-dr-save">' + escapeHtml(t('storySave')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var close = function() { overlay.remove(); };
    overlay.querySelector('.modal-close-btn').addEventListener('click', close);
    overlay.querySelector('#sm-dr-close').addEventListener('click', close);

    var issuesWrap = overlay.querySelector('#sm-dr-issues-wrap');
    function renderIssues() {
      var list = issuesCache.filter(function(x) { return x.chapterId === chapter.id; });
      if (list.length === 0) {
        issuesWrap.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">' + (isEn ? 'No conflicts reported for this chapter.' : '本章暂无冲突报告。') + '</span>';
        return;
      }
      var iHtml = '';
      for (var i = 0; i < list.length; i++) {
        var is = list[i];
        var levelClass = is.level === 'error' ? 'tag-red' : 'tag-amber';
        var statusClass = is.status === 'open' ? 'tag-amber' : 'tag-gray';
        var resolveLabel = isEn ? 'Resolve' : '标记已解决';
        var ignoreLabel = isEn ? 'Ignore' : '忽略';
        var reopenLabel = isEn ? 'Reopen' : '重新打开';
        iHtml += '<div style="padding:10px 12px;border:1px solid var(--glass-border);border-radius:var(--radius-md);background:rgba(255,255,255,0.02);display:flex;flex-direction:column;gap:4px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="display:flex;gap:6px;align-items:center;">' +
              '<span class="tag ' + levelClass + '">' + escapeHtml(is.type || (isEn ? 'Consistency' : '一致性')) + '</span>' +
              '<span class="tag ' + statusClass + '">' + escapeHtml(is.status) + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:6px;">' +
              (is.status === 'open' ?
                '<button type="button" class="btn btn-ghost btn-sm sm-iss-resolve" data-id="' + escapeHtml(is.id) + '">' + resolveLabel + '</button>' +
                '<button type="button" class="btn btn-ghost btn-sm sm-iss-ignore" data-id="' + escapeHtml(is.id) + '">' + ignoreLabel + '</button>' :
                '<button type="button" class="btn btn-ghost btn-sm sm-iss-reopen" data-id="' + escapeHtml(is.id) + '">' + reopenLabel + '</button>'
              ) +
            '</div>' +
          '</div>' +
          '<div style="font-size:13px;color:var(--text);">' + escapeHtml(is.description) + '</div>' +
          (is.suggestion ? '<div style="font-size:12px;color:var(--text-secondary);">💡 ' + (isEn ? 'Suggestion: ' : '建议：') + escapeHtml(is.suggestion) + '</div>' : '') +
        '</div>';
      }
      issuesWrap.innerHTML = iHtml;

      issuesWrap.querySelectorAll('.sm-iss-resolve').forEach(function(btn) {
        btn.addEventListener('click', function() {
          updateIssueStatus(btn.dataset.id, 'resolved');
        });
      });
      issuesWrap.querySelectorAll('.sm-iss-ignore').forEach(function(btn) {
        btn.addEventListener('click', function() {
          updateIssueStatus(btn.dataset.id, 'ignored');
        });
      });
      issuesWrap.querySelectorAll('.sm-iss-reopen').forEach(function(btn) {
        btn.addEventListener('click', function() {
          updateIssueStatus(btn.dataset.id, 'open');
        });
      });
    }
    renderIssues();

    function updateIssueStatus(issId, status) {
      currentCtx.api.patch('/issues/' + encodeURIComponent(issId), { status: status }).then(function() {
        var target = issuesCache.find(function(x) { return x.id === issId; });
        if (target) target.status = status;
        renderIssues();
      });
    }

    overlay.querySelector('#sm-dr-save').addEventListener('click', function() {
      var newContent = overlay.querySelector('#sm-dr-content').value;
      chapter.Content = newContent;
      chapter.Status = 'draft'; // editing final degrades to draft
      currentCtx.api.patch('/chapters/' + encodeURIComponent(chapter.id), {
        content: newContent,
        status: 'draft'
      }).then(function() {
        toast(isEn ? 'Chapter saved (reverted to draft)' : '章节保存成功（已降级为草稿状态）', 'success');
        close();
        loadData(function() {
          var container = document.getElementById('sm-main-content');
          if (container) drawUI(container);
        });
      }).catch(function(err) {
        toast((isEn ? 'Save failed: ' : '保存失败: ') + err.message, 'error');
      });
    });
  }

  function renderStateTimeline(contentEl) {
    var isEn = currentLang() === 'en';
    var charCards = cardsCache.filter(function(c) { return c.type === 'character'; });
    var charOptions = charCards.map(function(c) {
      return { value: c.id, label: '👤 ' + c.name };
    });

    var filteredEvents = stateEventsCache.filter(function(se) {
      return !selectedTimelineCharId || se.entityId === selectedTimelineCharId;
    });

    var html = '<div class="sm-card">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">' +
        '<div style="font-weight:600;font-size:var(--font-base);">' + escapeHtml(t('storyM5TimelineTitle')) + '</div>' +
        '<div style="width:200px;">' +
          renderCustomSelectHtml('sm-tl-char-wrap', 'sm-tl-char-select', charOptions, selectedTimelineCharId, null, 'width:100%;height:32px') +
        '</div>' +
      '</div>' +
      '<div style="margin-top:20px;">';

    if (filteredEvents.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:13px;padding:20px 0;text-align:center;">' + escapeHtml(t('storyM5NoTimeline')) + '</div>';
    } else {
      html += '<div class="sm-timeline">';
      for (var i = 0; i < filteredEvents.length; i++) {
        var ev = filteredEvents[i];
        var ch = chaptersCache.find(function(c) { return c.id === ev.chapterId; });
        var chLabel = ch ? ((isEn ? ('Chapter ' + ch.Index + ' ') : ('第 ' + ch.Index + ' 章 ')) + ch.Title) : ((isEn ? 'Chapter ' : '章节 ') + ev.chapterId);

        html += '<div class="sm-timeline-item">' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<span class="tag tag-blue">' + escapeHtml(ev.eventType) + '</span>' +
            '<span style="font-size:12px;font-weight:600;">' + escapeHtml(chLabel) + '</span>' +
            '<span style="font-size:11px;color:var(--text-secondary);">' + escapeHtml((ev.createdAt || '').slice(0, 10)) + '</span>' +
          '</div>' +
          '<div style="font-size:13px;line-height:1.5;color:var(--text);">' + escapeHtml(ev.description) + '</div>' +
        '</div>';
      }
      html += '</div>';
    }

    html += '</div></div>';
    contentEl.innerHTML = html;

    contentEl.querySelector('#sm-tl-char-select')?.addEventListener('change', function(e) {
      selectedTimelineCharId = e.target.value;
      renderCurrentTab(contentEl.parentElement);
    });
  }

    html += '</div></div>';
    contentEl.innerHTML = html;

    contentEl.querySelector('#sm-tl-char-select')?.addEventListener('change', function(e) {
      selectedTimelineCharId = e.target.value;
      renderCurrentTab(contentEl.parentElement);
    });
  }

  // Lifecycle
  window.storyRenderM5 = render;
  window.storyCleanupM5 = function() {};

})();
