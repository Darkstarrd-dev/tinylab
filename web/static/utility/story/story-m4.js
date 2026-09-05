// web/static/utility/story/story-m4.js — M4 Chapter Generation
// Dependency load order:
// vendor/diff.min.js -> utility/editor/editor.js -> editor_textreview_diff.js -> storymaker.js -> story-home.js -> story-m0.js -> story-m2.js -> story-m3.js -> story-m4.js

(function() {
  'use strict';

  var currentCtx = null;
  var currentAbort = null;
  var draftModel = { value: '', label: '' };

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
      var isEn = currentLang() === 'en';
      var m = prompt(isEn ? 'Enter Model ID (e.g. provider/model-name):' : '请输入模型 ID (例如 provider/model-name):', current.value || '');
      if (m) onPick({ value: m, label: m });
    }
  }

  function drawUI(container) {
    var book = currentCtx.getActiveBook();
    var isEn = currentLang() === 'en';
    var nodeOptions = outlineNodes.map(function(n) {
      var prefix = isEn ? ('Chapter ' + n.order + ' ') : ('第 ' + n.order + ' 章 ');
      var untitled = isEn ? 'Untitled' : '未命名';
      return { value: String(n.order), label: prefix + (n.title || untitled) };
    });
    if (nodeOptions.length === 0) {
      nodeOptions = [{ value: '1', label: t('storyM4NoOutline', [1]) }];
    }

    var chTitle = isEn ? ('Chapter ' + selectedChapterIndex + ' Draft') : ('第 ' + selectedChapterIndex + ' 章正文');

    container.innerHTML = '' +
      '<div class="sm-page-container">' +
        '<div class="sm-page-header">' +
          '<div class="sm-page-title">' + escapeHtml(t('storyM4')) + ' <span style="font-size:14px;color:var(--text-secondary);font-weight:normal;">(' + escapeHtml(book.title) + ')</span></div>' +
          '<div class="sm-page-actions">' +
            '<button class="btn btn-primary" type="button" id="sm-m4-btn-save">💾 ' + escapeHtml(t('storyM4SaveChapter')) + '</button>' +
          '</div>' +
        '</div>' +

        // Controls Card
        '<div class="sm-card">' +
          '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">' +
            '<div style="flex:1;min-width:220px;">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM4TargetOutline')) + '</span>' +
              renderCustomSelectHtml('sm-m4-node-wrap', 'sm-m4-node-select', nodeOptions, String(selectedChapterIndex), null, 'width:100%;height:32px') +
            '</div>' +
            '<div style="width:130px;">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM4TargetWords')) + '</span>' +
              renderStepperHtml('sm-m4-word-count', targetWordCount, 1000, 10000, 500) +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:4px;">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM4DraftModel')) + '</span>' +
              '<button type="button" class="sm-model-btn" id="sm-m4-model-btn">' +
                '<span>🤖</span><span id="sm-m4-model-label">' + escapeHtml(draftModel.label || t('storySelectModel')) + '</span>' +
              '</button>' +
            '</div>' +
            '<div style="padding-top:20px;">' +
              '<button class="btn btn-primary" type="button" id="sm-m4-btn-generate" style="padding:8px 20px;">✍️ ' + escapeHtml(t('storyM4GenDraft')) + '</button>' +
            '</div>' +
          '</div>' +

          // Blueprint details
          (currentOutlineNode ? '' +
            '<div style="background:rgba(255,255,255,0.02);padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--glass-border);font-size:12px;display:flex;flex-direction:column;gap:4px;">' +
              '<div><strong>' + escapeHtml(t('storyM4ChapterBlueprint')) + ' </strong>' + escapeHtml(currentOutlineNode.summary || t('storyM4NoSummary')) + '</div>' +
              '<div style="color:var(--text-secondary);display:flex;gap:16px;flex-wrap:wrap;">' +
                '<span>' + escapeHtml(t('storyM4PosLabel')) + ' ' + escapeHtml(currentOutlineNode.positioning || '—') + '</span>' +
                '<span>' + escapeHtml(t('storyM4RoleLabel')) + ' ' + escapeHtml(currentOutlineNode.role || '—') + '</span>' +
                '<span>' + escapeHtml(t('storyM4SuspenseLabel')) + ' ' + escapeHtml(currentOutlineNode.suspenseDensity || '—') + '</span>' +
                '<span>' + escapeHtml(t('storyM4TwistLabel')) + ' ' + '★'.repeat(currentOutlineNode.twistLevel || 0) + '</span>' +
              '</div>' +
            '</div>' : '') +

          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM4Guidance')) + '</span>' +
            '<textarea class="sm-textarea" id="sm-m4-user-guidance" rows="2" placeholder="' + escapeHtml(t('storyM4GuidancePlaceholder')) + '">' + escapeHtml(userGuidance) + '</textarea>' +
          '</div>' +

          // Adopted Fragments Hard Constraint
          '<details class="sm-prompt-details" ' + (allFragments.length > 0 ? 'open' : '') + '>' +
            '<summary class="sm-prompt-summary">🔗 ' + escapeHtml(t('storyM4FragmentsConstraint', [selectedFragmentIds.length, allFragments.length])) + '</summary>' +
            '<div id="sm-m4-frag-checkboxes" style="margin-top:10px;display:flex;flex-direction:column;gap:6px;max-height:160px;overflow-y:auto;">' +
              (allFragments.length === 0 ? '<span style="color:var(--text-secondary);font-size:12px;">' + escapeHtml(t('storyM4NoFragments')) + '</span>' : '') +
            '</div>' +
          '</details>' +

          // Prompt Override
          '<details class="sm-prompt-details">' +
            '<summary class="sm-prompt-summary">⚙️ ' + escapeHtml(t('storyM4PromptPreset')) + '</summary>' +
            '<div class="sm-prompt-editor">' +
              '<textarea class="sm-textarea" id="sm-m4-prompt-textarea" rows="4">' + escapeHtml(promptOverride) + '</textarea>' +
              '<button type="button" class="btn btn-ghost btn-sm" id="sm-m4-save-prompt" style="align-self:flex-end;">' + escapeHtml(t('storyM4SavePrompt')) + '</button>' +
            '</div>' +
          '</details>' +
        '</div>' +

        // Content Area (Diff view or Editor)
        '<div class="sm-card" style="min-height:400px;display:flex;flex-direction:column;gap:12px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="font-weight:600;font-size:var(--font-base);display:flex;align-items:center;gap:10px;">' +
              '<span>' + escapeHtml(chTitle) + '</span>' +
              (isGenerating ? '<span class="tag tag-blue" style="font-size:11px;">' + escapeHtml(t('storyM4Generating')) + '</span>' : '') +
              (currentChapter ? '<span class="tag tag-gray" style="font-size:11px;">' + escapeHtml(t('storyM4HasDraft', [(currentChapter.Content || '').length])) + '</span>' : '<span class="tag tag-amber" style="font-size:11px;">' + escapeHtml(t('storyM4NewChapter')) + '</span>') +
            '</div>' +
            '<div id="sm-m4-word-stats" style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(t('storyM4WordStats', [0])) + '</div>' +
          '</div>' +

          '<div id="sm-m4-diff-container" style="display:none;" class="sm-diff-container">' +
            '<div class="sm-diff-pane">' +
              '<div class="sm-diff-header">' + escapeHtml(t('storyM4OldDraft')) + '</div>' +
              '<div class="sm-diff-body" id="sm-m4-diff-old"></div>' +
            '</div>' +
            '<div class="sm-diff-pane">' +
              '<div class="sm-diff-header" style="display:flex;justify-content:space-between;align-items:center;">' +
                '<span>' + escapeHtml(t('storyM4NewGenerated')) + '</span>' +
                '<button type="button" class="btn btn-primary btn-sm" id="sm-m4-apply-new" style="font-size:11px;">' + escapeHtml(t('storyM4AdoptNewDraft')) + '</button>' +
              '</div>' +
              '<div class="sm-diff-body" id="sm-m4-diff-new"></div>' +
            '</div>' +
          '</div>' +

          '<textarea class="sm-textarea" id="sm-m4-content-editor" style="flex:1;min-height:360px;font-family:monospace;font-size:14px;line-height:1.6;" placeholder="' + escapeHtml(t('storyM4DraftPlaceholder')) + '">' +
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
        var fragPrefix = isEn ? 'Deduction Fragment #' : '推演片段 #';
        fHtml += '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;padding:4px;border-radius:4px;background:rgba(255,255,255,0.02);">' +
          '<input type="checkbox" class="sm-m4-frag-cb" value="' + escapeHtml(frag.id) + '"' + (isChecked ? ' checked' : '') + ' style="margin-top:2px;">' +
          '<div style="display:flex;flex-direction:column;gap:2px;">' +
            '<strong>[' + fragPrefix + frag.order + ']</strong>' +
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
        toast(t('storySaved'), 'success');
      });
    });

    var editor = container.querySelector('#sm-m4-content-editor');
    var wordStats = container.querySelector('#sm-m4-word-stats');
    function updateWordStats() {
      if (editor && wordStats) {
        wordStats.textContent = t('storyM4WordStats', [(editor.value || '').length]);
      }
    }
    editor?.addEventListener('input', updateWordStats);
    updateWordStats();

    // Start Draft Generation
    container.querySelector('#sm-m4-btn-generate')?.addEventListener('click', function() {
      if (!draftModel.value) {
        toast(isEn ? 'Please select a generation model first' : '请先选择生成模型', 'warning');
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
        toast(t('storyM4GenDone'), 'success');

        // Show diff if old text exists
        if (oldText && oldText.trim()) {
          showDiffView(container, oldText, generatedDraft);
        }
      }, function(err) {
        isGenerating = false;
        genBtn.disabled = false;
        toast((isEn ? 'Generation failed: ' : '生成失败: ') + err.message, 'error');
      });
    });

    // Save Chapter
    container.querySelector('#sm-m4-btn-save')?.addEventListener('click', function() {
      var content = editor.value.trim();
      if (!content) {
        toast(t('storyM4ContentEmptyWarning'), 'warning');
        return;
      }

      var defaultChTitle = isEn ? ('Chapter ' + selectedChapterIndex) : ('第 ' + selectedChapterIndex + ' 章');
      var chapterTitle = (currentOutlineNode && currentOutlineNode.title) || defaultChTitle;
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
        toast(t('storyM4ChapterSaved'), 'success');
        currentChapter = saved;
        loadData(function() {
          drawUI(container);
        });
      }).catch(function(err) {
        toast((isEn ? 'Save failed: ' : '保存失败: ') + err.message, 'error');
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
        toast(t('storyM4AdoptNewDraftSuccess'), 'success');
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
