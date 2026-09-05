// web/static/utility/story/story-m4.js — M4 Chapter Generation
// Dependency load order:
// vendor/diff.min.js -> utility/editor/editor.js -> editor_textreview_diff.js -> storymaker.js -> story-home.js -> story-m0.js -> story-m2.js -> story-m3.js -> story-m4.js

(function() {
  'use strict';

  var currentCtx = null;
  var currentAbort = null;
  var draftModel = { value: '', label: '选择模型' };

  var outlineNodes = [];
  var existingChapters = [];
  var allFragments = [];
  var selectedChapterIndex = 1;
  var currentOutlineNode = null;
  var currentChapter = null;

  var userGuidance = '';
  var targetWordCount = 3000;
  var selectedFragmentIds = [];
  var generatedDraft = '';
  var promptOverride = '';
  var isGenerating = false;

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
      currentCtx.api.get('/chapters?bookId=' + encodeURIComponent(bookId)),
      currentCtx.api.get('/scenes?bookId=' + encodeURIComponent(bookId)),
      currentCtx.api.get('/prompts/m4-draft')
    ]).then(function(results) {
      outlineNodes = (results[0] && results[0].outline) || [];
      existingChapters = (results[1] && results[1].chapters) || [];
      var scenes = (results[2] && results[2].scenes) || [];
      promptOverride = (results[3] && results[3].content) || '';

      // Collect all adopted fragments across all scenes
      var fragPromises = scenes.map(function(sc) {
        return currentCtx.api.get('/fragments?sceneId=' + encodeURIComponent(sc.id));
      });
      return Promise.all(fragPromises).then(function(fragResults) {
        allFragments = [];
        fragResults.forEach(function(r) {
          if (r && r.fragments) {
            allFragments = allFragments.concat(r.fragments);
          }
        });
        // Select all fragments by default
        selectedFragmentIds = allFragments.map(function(f) { return f.id; });

        if (outlineNodes.length > 0 && !currentOutlineNode) {
          selectedChapterIndex = outlineNodes[0].order || 1;
        }
        updateActiveNodeAndChapter();
        if (cb) cb();
      });
    }).catch(function(err) {
      console.warn('load m4 data error:', err);
      if (cb) cb();
    });
  }

  function updateActiveNodeAndChapter() {
    currentOutlineNode = outlineNodes.find(function(n) { return n.order === selectedChapterIndex; }) || null;
    currentChapter = existingChapters.find(function(c) { return c.Index === selectedChapterIndex; }) || null;
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
    var nodeOptions = outlineNodes.map(function(n) {
      return { value: String(n.order), label: '第 ' + n.order + ' 章 ' + (n.title || '未命名') };
    });
    if (nodeOptions.length === 0) {
      nodeOptions = [{ value: '1', label: '第 1 章 (暂无大纲蓝图)' }];
    }

    container.innerHTML = '' +
      '<div class="sm-page-container">' +
        '<div class="sm-page-header">' +
          '<div class="sm-page-title">' + escapeHtml(t('storyM4')) + ' <span style="font-size:14px;color:var(--text-secondary);font-weight:normal;">(' + escapeHtml(book.title) + ')</span></div>' +
          '<div class="sm-page-actions">' +
            '<button class="btn btn-primary" type="button" id="sm-m4-btn-save">💾 保存章节正文</button>' +
          '</div>' +
        '</div>' +

        // Controls Card
        '<div class="sm-card">' +
          '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">' +
            '<div style="flex:1;min-width:220px;">' +
              '<span class="sm-field-label">目标章节大纲：</span>' +
              renderCustomSelectHtml('sm-m4-node-wrap', 'sm-m4-node-select', nodeOptions, String(selectedChapterIndex), null, 'width:100%;height:32px') +
            '</div>' +
            '<div style="width:130px;">' +
              '<span class="sm-field-label">目标字数：</span>' +
              renderStepperHtml('sm-m4-word-count', targetWordCount, 1000, 10000, 500) +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:4px;">' +
              '<span class="sm-field-label">生成模型：</span>' +
              '<button type="button" class="sm-model-btn" id="sm-m4-model-btn">' +
                '<span>🤖</span><span id="sm-m4-model-label">' + escapeHtml(draftModel.label) + '</span>' +
              '</button>' +
            '</div>' +
            '<div style="padding-top:20px;">' +
              '<button class="btn btn-primary" type="button" id="sm-m4-btn-generate" style="padding:8px 20px;">✍️ 生成章节正文</button>' +
            '</div>' +
          '</div>' +

          // Blueprint details
          (currentOutlineNode ? '' +
            '<div style="background:rgba(255,255,255,0.02);padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--glass-border);font-size:12px;display:flex;flex-direction:column;gap:4px;">' +
              '<div><strong>本章蓝图：</strong>' + escapeHtml(currentOutlineNode.summary || '无简述') + '</div>' +
              '<div style="color:var(--text-secondary);display:flex;gap:16px;flex-wrap:wrap;">' +
                '<span>定位: ' + escapeHtml(currentOutlineNode.positioning || '—') + '</span>' +
                '<span>作用: ' + escapeHtml(currentOutlineNode.role || '—') + '</span>' +
                '<span>悬念: ' + escapeHtml(currentOutlineNode.suspenseDensity || '—') + '</span>' +
                '<span>颠覆指数: ' + '★'.repeat(currentOutlineNode.twistLevel || 0) + '</span>' +
              '</div>' +
            '</div>' : '') +

          '<div class="sm-field">' +
            '<span class="sm-field-label">额外写作指导 / 细节要求：</span>' +
            '<textarea class="sm-textarea" id="sm-m4-user-guidance" rows="2" placeholder="输入对本章剧情、文风、特殊桥段的额外指导...">' + escapeHtml(userGuidance) + '</textarea>' +
          '</div>' +

          // Adopted Fragments Hard Constraint
          '<details class="sm-prompt-details" ' + (allFragments.length > 0 ? 'open' : '') + '>' +
            '<summary class="sm-prompt-summary">🔗 包含已采纳推演片段作为硬约束 (已勾选 ' + selectedFragmentIds.length + ' / ' + allFragments.length + ')</summary>' +
            '<div id="sm-m4-frag-checkboxes" style="margin-top:10px;display:flex;flex-direction:column;gap:6px;max-height:160px;overflow-y:auto;">' +
              (allFragments.length === 0 ? '<span style="color:var(--text-secondary);font-size:12px;">暂无已采纳推演片段。可在 M3 采纳角色片段。</span>' : '') +
            '</div>' +
          '</details>' +

          // Prompt Override
          '<details class="sm-prompt-details">' +
            '<summary class="sm-prompt-summary">⚙️ 章节生成 Prompt 设定 (系统预设)</summary>' +
            '<div class="sm-prompt-editor">' +
              '<textarea class="sm-textarea" id="sm-m4-prompt-textarea" rows="4">' + escapeHtml(promptOverride) + '</textarea>' +
              '<button type="button" class="btn btn-ghost btn-sm" id="sm-m4-save-prompt" style="align-self:flex-end;">保存 Prompt 覆盖</button>' +
            '</div>' +
          '</details>' +
        '</div>' +

        // Content Area (Diff view or Editor)
        '<div class="sm-card" style="min-height:400px;display:flex;flex-direction:column;gap:12px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="font-weight:600;font-size:var(--font-base);display:flex;align-items:center;gap:10px;">' +
              '<span>第 ' + selectedChapterIndex + ' 章正文</span>' +
              (isGenerating ? '<span class="tag tag-blue" style="font-size:11px;">生成中...</span>' : '') +
              (currentChapter ? '<span class="tag tag-gray" style="font-size:11px;">已有草稿 (' + (currentChapter.Content || '').length + ' 字)</span>' : '<span class="tag tag-amber" style="font-size:11px;">新章节</span>') +
            '</div>' +
            '<div id="sm-m4-word-stats" style="font-size:12px;color:var(--text-secondary);">字数：0 字</div>' +
          '</div>' +

          '<div id="sm-m4-diff-container" style="display:none;" class="sm-diff-container">' +
            '<div class="sm-diff-pane">' +
              '<div class="sm-diff-header">旧版正文 (现有草稿)</div>' +
              '<div class="sm-diff-body" id="sm-m4-diff-old"></div>' +
            '</div>' +
            '<div class="sm-diff-pane">' +
              '<div class="sm-diff-header" style="display:flex;justify-content:space-between;align-items:center;">' +
                '<span>新生成正文</span>' +
                '<button type="button" class="btn btn-primary btn-sm" id="sm-m4-apply-new" style="font-size:11px;">采纳新版覆盖</button>' +
              '</div>' +
              '<div class="sm-diff-body" id="sm-m4-diff-new"></div>' +
            '</div>' +
          '</div>' +

          '<textarea class="sm-textarea" id="sm-m4-content-editor" style="flex:1;min-height:360px;font-family:monospace;font-size:14px;line-height:1.6;" placeholder="章节正文内容将在此实时生成，也可手动在此编辑...">' +
            escapeHtml(generatedDraft || (currentChapter ? currentChapter.Content : '')) +
          '</textarea>' +
        '</div>' +
      '</div>';

    // Populate fragment checkboxes
    var fragWrap = container.querySelector('#sm-m4-frag-checkboxes');
    if (fragWrap && allFragments.length > 0) {
      var fHtml = '';
      for (var fi = 0; fi < allFragments.length; fi++) {
        var frag = allFragments[fi];
        var isChecked = selectedFragmentIds.includes(frag.id);
        fHtml += '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;padding:4px;border-radius:4px;background:rgba(255,255,255,0.02);">' +
          '<input type="checkbox" class="sm-m4-frag-cb" value="' + escapeHtml(frag.id) + '"' + (isChecked ? ' checked' : '') + ' style="margin-top:2px;">' +
          '<div style="display:flex;flex-direction:column;gap:2px;">' +
            '<strong>[推演片段 #' + frag.order + ']</strong>' +
            '<span style="color:var(--text-secondary);">' + escapeHtml((frag.adoptedText || '').slice(0, 120)) + '...</span>' +
          '</div>' +
        '</label>';
      }
      fragWrap.innerHTML = fHtml;
      fragWrap.querySelectorAll('.sm-m4-frag-cb').forEach(function(cb) {
        cb.addEventListener('change', function() {
          selectedFragmentIds = [];
          fragWrap.querySelectorAll('.sm-m4-frag-cb:checked').forEach(function(c) {
            selectedFragmentIds.push(c.value);
          });
        });
      });
    }

    // Bind event listeners
    container.querySelector('#sm-m4-node-select')?.addEventListener('change', function(e) {
      selectedChapterIndex = parseInt(e.target.value, 10) || 1;
      updateActiveNodeAndChapter();
      generatedDraft = '';
      drawUI(container);
    });

    container.querySelector('#sm-m4-word-count')?.addEventListener('change', function(e) {
      targetWordCount = parseInt(e.target.value, 10) || 3000;
    });

    container.querySelector('#sm-m4-user-guidance')?.addEventListener('input', function(e) {
      userGuidance = e.target.value;
    });

    container.querySelector('#sm-m4-model-btn')?.addEventListener('click', function() {
      pickModel(draftModel, function(m) {
        draftModel = m;
        container.querySelector('#sm-m4-model-label').textContent = m.label;
      });
    });

    container.querySelector('#sm-m4-save-prompt')?.addEventListener('click', function() {
      var val = container.querySelector('#sm-m4-prompt-textarea').value.trim();
      currentCtx.api.put('/prompts/m4-draft', { content: val }).then(function() {
        promptOverride = val;
        toast('Prompt 覆盖已保存', 'success');
      });
    });

    var editor = container.querySelector('#sm-m4-content-editor');
    var wordStats = container.querySelector('#sm-m4-word-stats');
    function updateWordStats() {
      if (editor && wordStats) {
        wordStats.textContent = '字数：' + (editor.value || '').length + ' 字';
      }
    }
    editor?.addEventListener('input', updateWordStats);
    updateWordStats();

    // Start Draft Generation
    container.querySelector('#sm-m4-btn-generate')?.addEventListener('click', function() {
      if (!draftModel.value) {
        toast('请先选择生成模型', 'warning');
        return;
      }

      var genBtn = container.querySelector('#sm-m4-btn-generate');
      genBtn.disabled = true;
      isGenerating = true;

      var oldText = currentChapter ? currentChapter.Content : '';
      generatedDraft = '';
      editor.value = '';

      var diffContainer = container.querySelector('#sm-m4-diff-container');
      diffContainer.style.display = 'none';

      currentAbort = currentCtx.api.sse('/draft', {
        model: draftModel.value,
        context: {
          bookId: currentCtx.activeBookId,
          chapterIndex: selectedChapterIndex
        },
        userGuidance: userGuidance,
        targetWordCount: targetWordCount,
        systemPrompt: promptOverride
      }, function(delta) {
        if (typeof delta === 'string') {
          generatedDraft += delta;
          editor.value = generatedDraft;
          editor.scrollTop = editor.scrollHeight;
          updateWordStats();
        }
      }, function() {
        isGenerating = false;
        genBtn.disabled = false;
        toast('章节正文生成完成！', 'success');

        // Show diff if old text exists
        if (oldText && oldText.trim()) {
          showDiffView(container, oldText, generatedDraft);
        }
      }, function(err) {
        isGenerating = false;
        genBtn.disabled = false;
        toast('生成失败: ' + err.message, 'error');
      });
    });

    // Save Chapter
    container.querySelector('#sm-m4-btn-save')?.addEventListener('click', function() {
      var content = editor.value.trim();
      if (!content) {
        toast('章节正文为空，无法保存', 'warning');
        return;
      }

      var chapterTitle = (currentOutlineNode && currentOutlineNode.title) || ('第 ' + selectedChapterIndex + ' 章');
      var chapterId = currentChapter ? currentChapter.id : ('ch_' + Date.now());

      var payload = {
        id: chapterId,
        bookId: currentCtx.activeBookId,
        index: selectedChapterIndex,
        title: chapterTitle,
        content: content,
        status: 'draft',
        outlineNodeId: currentOutlineNode ? currentOutlineNode.id : ''
      };

      currentCtx.api.post('/chapters', payload).then(function(saved) {
        toast('章节保存成功！', 'success');
        currentChapter = saved;
        loadData(function() {
          drawUI(container);
        });
      }).catch(function(err) {
        toast('保存失败: ' + err.message, 'error');
      });
    });
  }

  function showDiffView(container, oldText, newText) {
    var diffContainer = container.querySelector('#sm-m4-diff-container');
    var oldEl = container.querySelector('#sm-m4-diff-old');
    var newEl = container.querySelector('#sm-m4-diff-new');
    if (!diffContainer || !oldEl || !newEl) return;

    diffContainer.style.display = 'flex';
    oldEl.textContent = oldText;
    newEl.textContent = newText;

    container.querySelector('#sm-m4-apply-new')?.addEventListener('click', function() {
      var editor = container.querySelector('#sm-m4-content-editor');
      if (editor) {
        editor.value = newText;
        diffContainer.style.display = 'none';
        toast('已采纳新版正文', 'success');
      }
    });
  }

  // Lifecycle
  window.storyRenderM4 = render;
  window.storyCleanupM4 = function() {
    if (currentAbort) {
      try { currentAbort.abort(); } catch (e) {}
      currentAbort = null;
    }
  };

})();
