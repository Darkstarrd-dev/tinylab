// web/static/utility/story/story-m5.js — M5 Chapter Management & Consistency Review
// Dependency load order:
// vendor/diff.min.js -> utility/editor/editor.js -> editor_textreview_diff.js -> storymaker.js -> story sub-pages -> story-m5.js

(function() {
  'use strict';

  var currentCtx = null;
  var currentTab = 'chapters'; // 'chapters' | 'timeline'
  var checkModel = { value: '', label: '选择模型' };

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
      var m = prompt('请输入模型 ID (例如 provider/model-name):', current.value || '');
      if (m) onPick({ value: m, label: m });
    }
  }

  function drawUI(container) {
    var book = currentCtx.getActiveBook();

    container.innerHTML = '' +
      '<div class="sm-page-container">' +
        '<div class="sm-page-header">' +
          '<div class="sm-page-title">' + escapeHtml(t('storyM5')) + ' <span style="font-size:14px;color:var(--text-secondary);font-weight:normal;">(' + escapeHtml(book.title) + ')</span></div>' +
          '<div class="sm-page-actions">' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
              '<span class="sm-field-label">审校模型：</span>' +
              '<button type="button" class="sm-model-btn" id="sm-m5-model-btn">' +
                '<span>🤖</span><span id="sm-m5-model-label">' + escapeHtml(checkModel.label) + '</span>' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Tab switches & Prompt overrides
        '<div class="sm-card" style="padding:14px 20px;gap:12px;">' +
          '<div class="sm-tabs">' +
            '<button type="button" class="sm-tab-btn' + (currentTab === 'chapters' ? ' active' : '') + '" data-tab="chapters">章节管理 (' + chaptersCache.length + ')</button>' +
            '<button type="button" class="sm-tab-btn' + (currentTab === 'timeline' ? ' active' : '') + '" data-tab="timeline">角色状态时间线 (' + stateEventsCache.length + ')</button>' +
          '</div>' +

          '<details class="sm-prompt-details">' +
            '<summary class="sm-prompt-summary">⚙️ 定稿与一致性 Prompt 预设</summary>' +
            '<div class="sm-form-grid" style="margin-top:10px;">' +
              '<div class="sm-field">' +
                '<span class="sm-field-label">m5-finalize (定稿与摘要提取)：</span>' +
                '<textarea class="sm-textarea" id="sm-m5-fin-prompt" rows="3">' + escapeHtml(finalizePromptOverride) + '</textarea>' +
              '</div>' +
              '<div class="sm-field">' +
                '<span class="sm-field-label">m5-consistency (三维度一致性审校)：</span>' +
                '<textarea class="sm-textarea" id="sm-m5-con-prompt" rows="3">' + escapeHtml(consistencyPromptOverride) + '</textarea>' +
              '</div>' +
            '</div>' +
            '<button type="button" class="btn btn-ghost btn-sm" id="sm-m5-save-prompts" style="margin-top:8px;align-self:flex-end;">保存 Prompt 覆盖</button>' +
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
        toast('Prompt 覆盖已保存', 'success');
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
    if (chaptersCache.length === 0) {
      contentEl.innerHTML = '<div class="sm-card">' +
        '<div class="sm-empty-state">' +
          '<div class="sm-empty-icon">📑</div>' +
          '<p>当前作品暂无章节。请先在 M4 生成草稿。</p>' +
        '</div>' +
      '</div>';
      return;
    }

    var html = '<div class="sm-card" style="padding:0;overflow:hidden;">' +
      '<table class="sm-table">' +
        '<thead>' +
          '<tr>' +
            '<th>#</th>' +
            '<th>章节标题</th>' +
            '<th>状态</th>' +
            '<th>字数</th>' +
            '<th>审校冲突</th>' +
            '<th>更新时间</th>' +
            '<th style="text-align:right;">操作</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>';

    for (var i = 0; i < chaptersCache.length; i++) {
      var ch = chaptersCache[i];
      var chIssues = issuesCache.filter(function(is) { return is.chapterId === ch.id && is.status === 'open'; });
      var issueBadge = chIssues.length > 0 ?
        '<span class="tag tag-amber" style="font-size:11px;">⚠️ ' + chIssues.length + ' 项冲突</span>' :
        '<span style="color:var(--text-secondary);font-size:11px;">无冲突</span>';

      var statusBadge = ch.Status === 'final' ?
        '<span class="tag tag-green">定稿 (final)</span>' :
        '<span class="tag tag-blue">草稿 (draft)</span>';

      html += '<tr>' +
        '<td>' + ch.Index + '</td>' +
        '<td><button type="button" class="btn btn-ghost btn-sm sm-ch-view-title" data-id="' + escapeHtml(ch.id) + '" style="font-weight:600;padding:2px 6px;">' + escapeHtml(ch.Title) + '</button></td>' +
        '<td>' + statusBadge + '</td>' +
        '<td>' + ((ch.Content || '').length) + ' 字</td>' +
        '<td>' + issueBadge + '</td>' +
        '<td style="color:var(--text-secondary);">' + escapeHtml((ch.UpdatedAt || '').slice(0, 16).replace('T', ' ')) + '</td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          (ch.Status !== 'final' ?
            '<button class="btn btn-primary btn-sm sm-ch-finalize" data-id="' + escapeHtml(ch.id) + '" type="button">定稿与检查</button> ' :
            '<button class="btn btn-ghost btn-sm sm-ch-revert" data-id="' + escapeHtml(ch.id) + '" type="button">退回草稿</button> ' +
            '<button class="btn btn-ghost btn-sm sm-ch-recheck" data-id="' + escapeHtml(ch.id) + '" type="button">重新审校</button> '
          ) +
          '<button class="btn btn-ghost btn-sm sm-ch-edit" data-id="' + escapeHtml(ch.id) + '" type="button">正文</button>' +
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
          toast('章节已退回草稿状态', 'success');
          loadData(function() { drawUI(contentEl.parentElement); });
        });
      });
    });
  }

  function runFinalizeAndCheck(ch) {
    if (!checkModel.value) {
      toast('请先在右上角选择审校模型', 'warning');
      return;
    }
    toast('正在进行定稿摘要提取与一致性审校...', 'info');

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
      toast('章节定稿与审校完成！', 'success');
      loadData(function() {
        var container = document.getElementById('sm-main-content');
        if (container) drawUI(container);
      });
    }).catch(function(err) {
      toast('定稿流程失败: ' + err.message, 'error');
    });
  }

  function runConsistencyCheckOnly(ch) {
    if (!checkModel.value) {
      toast('请先选择审校模型', 'warning');
      return;
    }
    toast('正在进行一致性审校...', 'info');
    currentCtx.api.post('/consistency', {
      model: checkModel.value,
      bookId: currentCtx.activeBookId,
      chapterId: ch.id,
      chapterText: ch.Content,
      systemPrompt: consistencyPromptOverride
    }).then(function() {
      toast('审校完成！', 'success');
      loadData(function() {
        var container = document.getElementById('sm-main-content');
        if (container) drawUI(container);
      });
    }).catch(function(err) {
      toast('审校失败: ' + err.message, 'error');
    });
  }

  function openChapterDrawer(chapter) {
    var overlay = document.createElement('div');
    overlay.className = 'sm-drawer-overlay';
    overlay.innerHTML = '' +
      '<div class="sm-drawer" style="width:720px;">' +
        '<div class="sm-drawer-header">' +
          '<div class="modal-title">第 ' + chapter.Index + ' 章：' + escapeHtml(chapter.Title) + '</div>' +
          '<button class="modal-close-btn">&times;</button>' +
        '</div>' +
        '<div class="sm-drawer-body">' +
          '<div class="sm-field">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
              '<span class="sm-field-label">正文内容 (修改保存后将重置为草稿状态)：</span>' +
              '<span style="font-size:12px;color:var(--text-secondary);">' + ((chapter.Content || '').length) + ' 字</span>' +
            '</div>' +
            '<textarea class="sm-textarea" id="sm-dr-content" style="height:320px;font-family:monospace;line-height:1.6;">' +
              escapeHtml(chapter.Content || '') +
            '</textarea>' +
          '</div>' +

          // Consistency Issues List
          '<div class="sm-field">' +
            '<span class="sm-field-label">一致性审校问题报告：</span>' +
            '<div id="sm-dr-issues-wrap" style="display:flex;flex-direction:column;gap:8px;"></div>' +
          '</div>' +
        '</div>' +
        '<div class="sm-drawer-footer">' +
          '<button class="btn btn-ghost" type="button" id="sm-dr-close">关闭</button>' +
          '<button class="btn btn-primary" type="button" id="sm-dr-save">保存修改</button>' +
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
        issuesWrap.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">本章暂无冲突报告。</span>';
        return;
      }
      var iHtml = '';
      for (var i = 0; i < list.length; i++) {
        var is = list[i];
        var levelClass = is.level === 'error' ? 'tag-red' : 'tag-amber';
        var statusClass = is.status === 'open' ? 'tag-amber' : 'tag-gray';
        iHtml += '<div style="padding:10px 12px;border:1px solid var(--glass-border);border-radius:var(--radius-md);background:rgba(255,255,255,0.02);display:flex;flex-direction:column;gap:4px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="display:flex;gap:6px;align-items:center;">' +
              '<span class="tag ' + levelClass + '">' + escapeHtml(is.type || '一致性') + '</span>' +
              '<span class="tag ' + statusClass + '">' + escapeHtml(is.status) + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:6px;">' +
              (is.status === 'open' ?
                '<button type="button" class="btn btn-ghost btn-sm sm-iss-resolve" data-id="' + escapeHtml(is.id) + '">标记已解决</button>' +
                '<button type="button" class="btn btn-ghost btn-sm sm-iss-ignore" data-id="' + escapeHtml(is.id) + '">忽略</button>' :
                '<button type="button" class="btn btn-ghost btn-sm sm-iss-reopen" data-id="' + escapeHtml(is.id) + '">重新打开</button>'
              ) +
            '</div>' +
          '</div>' +
          '<div style="font-size:13px;color:var(--text);">' + escapeHtml(is.description) + '</div>' +
          (is.suggestion ? '<div style="font-size:12px;color:var(--text-secondary);">💡 建议：' + escapeHtml(is.suggestion) + '</div>' : '') +
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
        toast('章节保存成功（已降级为草稿状态）', 'success');
        close();
        loadData(function() {
          var container = document.getElementById('sm-main-content');
          if (container) drawUI(container);
        });
      }).catch(function(err) {
        toast('保存失败: ' + err.message, 'error');
      });
    });
  }

  function renderStateTimeline(contentEl) {
    var charCards = cardsCache.filter(function(c) { return c.type === 'character'; });
    var charOptions = charCards.map(function(c) {
      return { value: c.id, label: '👤 ' + c.name };
    });

    var filteredEvents = stateEventsCache.filter(function(se) {
      return !selectedTimelineCharId || se.entityId === selectedTimelineCharId;
    });

    var html = '<div class="sm-card">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">' +
        '<div style="font-weight:600;font-size:var(--font-base);">角色状态轨迹时间线</div>' +
        '<div style="width:200px;">' +
          renderCustomSelectHtml('sm-tl-char-wrap', 'sm-tl-char-select', charOptions, selectedTimelineCharId, null, 'width:100%;height:32px') +
        '</div>' +
      '</div>' +
      '<div style="margin-top:20px;">';

    if (filteredEvents.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:13px;padding:20px 0;text-align:center;">该角色暂无状态事件记录。在定稿章节时将自动抽取。</div>';
    } else {
      html += '<div class="sm-timeline">';
      for (var i = 0; i < filteredEvents.length; i++) {
        var ev = filteredEvents[i];
        var ch = chaptersCache.find(function(c) { return c.id === ev.chapterId; });
        var chLabel = ch ? ('第 ' + ch.Index + ' 章 ' + ch.Title) : '章节 ' + ev.chapterId;

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

  // Lifecycle
  window.storyRenderM5 = render;
  window.storyCleanupM5 = function() {};

})();
