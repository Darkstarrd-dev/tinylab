// web/static/utility/story/story-m0.js — M0 Architecture & Blueprint
(function() {
  'use strict';

  var currentCtx = null;
  var currentAbort = null;
  var archModel = { value: '', label: t('storySelectModel') };
  var bpModel = { value: '', label: t('storySelectModel') };

  var state = {
    topic: '',
    genre: '',
    chapters: 30,
    guidance: '',
    archOutput: '',
    seed: '',
    characterDynamics: '',
    worldBuilding: '',
    plotStructure: '',
    blueprintOutput: '',
    parsedBlueprint: []
  };

  function render(container, ctx) {
    currentCtx = ctx;
    var book = ctx.getActiveBook();
    if (!book) {
      ctx.showEmptyBookState(container);
      return;
    }
    // Load existing architecture for active book if available
    ctx.api.get('/books').then(function() {
      drawUI(container);
    });
  }

  function parseArchSections(text) {
    var seed = '', cd = '', wb = '', ps = '';
    var sections = text.split(/\n(?=##\s+)/);
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i].trim();
      if (!s) continue;
      if (s.startsWith('## 核心种子') || s.startsWith('## 种子')) {
        seed = s.replace(/^##[^\n]+\n?/, '').trim();
      } else if (s.startsWith('## 角色动力学') || s.startsWith('## 角色动态')) {
        cd = s.replace(/^##[^\n]+\n?/, '').trim();
      } else if (s.startsWith('## 世界观') || s.startsWith('## 世界构建')) {
        wb = s.replace(/^##[^\n]+\n?/, '').trim();
      } else if (s.startsWith('## 三幕式情节') || s.startsWith('## 三幕式') || s.startsWith('## 情节架构')) {
        ps = s.replace(/^##[^\n]+\n?/, '').trim();
      } else if (!seed) {
        seed = s;
      }
    }
    return { seed: seed, characterDynamics: cd, worldBuilding: wb, plotStructure: ps };
  }

  function parseBlueprint(text) {
    var chunks = text.split(/\n(?=第\s*\d+\s*章)/);
    var list = [];
    for (var i = 0; i < chunks.length; i++) {
      var chunk = chunks[i].trim();
      if (!chunk.startsWith('第')) continue;
      var lines = chunk.split('\n');
      var titleLine = lines[0] || '';
      var numMatch = titleLine.match(/第\s*(\d+)\s*章\s*(.*)/);
      var order = numMatch ? parseInt(numMatch[1], 10) : (i + 1);
      var title = numMatch ? numMatch[2].replace(/^\[|\]$/g, '').trim() : titleLine;

      var getField = function(name) {
        for (var j = 1; j < lines.length; j++) {
          if (lines[j].startsWith(name + '：') || lines[j].startsWith(name + ':')) {
            return lines[j].replace(/^[^：:]+[：:]/, '').trim();
          }
        }
        return '';
      };

      var twistStr = getField('认知颠覆');
      var starCount = (twistStr.match(/★/g) || []).length;

      list.push({
        id: 'bp_' + Date.now() + '_' + order,
        order: order,
        volume: (typeof currentLang === 'function' && currentLang() === 'en') ? 'Volume 1' : '第一卷',
        title: title || t('editorUntitled'),
        positioning: getField('定位'),
        role: getField('核心作用'),
        suspenseDensity: getField('悬念密度'),
        foreshadow: getField('伏笔'),
        twistLevel: starCount,
        summary: getField('简述')
      });
    }
    return list;
  }

  function pickModel(current, onPick) {
    if (typeof pgOpenModelPicker === 'function') {
      pgOpenModelPicker(current.value, function(res) {
        if (res && res.id) {
          onPick({ value: res.id, label: res.name || res.id });
        }
      }, { kindFilter: 'text' });
    } else {
      var m = prompt(t('assistantPickModel') + ' (provider/model):', current.value || '');
      if (m) onPick({ value: m, label: m });
    }
  }

  function drawUI(container) {
    var book = currentCtx.getActiveBook();
    container.innerHTML = '' +
      '<div class="sm-page-container">' +
        '<div class="sm-page-header">' +
          '<div class="sm-page-title">' + escapeHtml(t('storyM0')) + ' <span style="font-size:14px;color:var(--text-secondary);font-weight:normal;">(' + escapeHtml(book.title) + ')</span></div>' +
        '</div>' +

        // Inputs Card
        '<div class="sm-card">' +
          '<div style="font-weight:600;font-size:calc(var(--font-base) + 1px);">' + escapeHtml(t('storyM0Step1Title')) + '</div>' +
          '<div class="sm-form-grid">' +
            '<div class="sm-field">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM0TopicLabel')) + '</span>' +
              '<input type="text" class="input" id="sm-m0-topic" value="' + escapeAttr(state.topic) + '" placeholder="' + escapeAttr(t('storyM0TopicPlaceholder')) + '" />' +
            '</div>' +
            '<div class="sm-field">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM0GenreLabel')) + '</span>' +
              '<input type="text" class="input" id="sm-m0-genre" value="' + escapeAttr(state.genre) + '" placeholder="' + escapeAttr(t('storyM0GenrePlaceholder')) + '" />' +
            '</div>' +
            '<div class="sm-field">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM0ChapterCountLabel')) + '</span>' +
              renderStepperHtml('sm-m0-chapters', state.chapters, 1, 300, 1) +
            '</div>' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM0GuidanceLabel')) + '</span>' +
            '<textarea class="sm-textarea" id="sm-m0-guidance" style="min-height:60px;" placeholder="' + escapeAttr(t('storyM0GuidancePlaceholder')) + '">' + escapeHtml(state.guidance) + '</textarea>' +
          '</div>' +
          '<div style="display:flex;gap:10px;align-items:center;">' +
            '<button class="btn btn-ghost" type="button" id="sm-m0-btn-brainstorm">' + escapeHtml(t('storyM0BrainstormBtn')) + '</button>' +
            '<button class="btn btn-primary" type="button" id="sm-m0-btn-gen-arch">' + escapeHtml(t('storyM0GenArchBtn')) + '</button>' +
            '<button class="sm-model-btn" type="button" id="sm-m0-model-arch">🤖 <span>' + escapeHtml(archModel.label) + '</span></button>' +
          '</div>' +
        '</div>' +

        // Architecture Editor Card
        '<div class="sm-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="font-weight:600;font-size:calc(var(--font-base) + 1px);">' + escapeHtml(t('storyM0Step2Title')) + '</div>' +
            '<button class="btn btn-ghost btn-sm" type="button" id="sm-m0-adopt-arch">' + escapeHtml(t('storyM0AdoptArchBtn')) + '</button>' +
          '</div>' +
          '<div class="sm-form-grid">' +
            '<div class="sm-field">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM0SeedLabel')) + '</span>' +
              '<textarea class="sm-textarea" id="sm-m0-seed">' + escapeHtml(state.seed) + '</textarea>' +
            '</div>' +
            '<div class="sm-field">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM0CharDynLabel')) + '</span>' +
              '<textarea class="sm-textarea" id="sm-m0-cd">' + escapeHtml(state.characterDynamics) + '</textarea>' +
            '</div>' +
            '<div class="sm-field">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM0WorldLabel')) + '</span>' +
              '<textarea class="sm-textarea" id="sm-m0-wb">' + escapeHtml(state.worldBuilding) + '</textarea>' +
            '</div>' +
            '<div class="sm-field">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM0PlotLabel')) + '</span>' +
              '<textarea class="sm-textarea" id="sm-m0-ps">' + escapeHtml(state.plotStructure) + '</textarea>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Blueprint Generator Card
        '<div class="sm-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="font-weight:600;font-size:calc(var(--font-base) + 1px);">' + escapeHtml(t('storyM0Step3Title')) + '</div>' +
            '<div style="display:flex;gap:10px;">' +
              '<button class="sm-model-btn" type="button" id="sm-m0-model-bp">🤖 <span>' + escapeHtml(bpModel.label) + '</span></button>' +
              '<button class="btn btn-primary" type="button" id="sm-m0-btn-gen-bp">' + escapeHtml(t('storyM0GenBpBtn')) + '</button>' +
              '<button class="btn btn-ghost" type="button" id="sm-m0-adopt-bp" ' + (state.parsedBlueprint.length === 0 ? 'disabled' : '') + '>' + escapeHtml(t('storyM0AdoptBpBtn')) + '</button>' +
            '</div>' +
          '</div>' +
          '<div id="sm-m0-bp-preview" style="max-height:360px;overflow-y:auto;">' +
            renderBlueprintTableHtml(state.parsedBlueprint) +
          '</div>' +
        '</div>' +

        // Prompt Override Foldable
        '<details class="sm-prompt-details">' +
          '<summary class="sm-prompt-summary">⚙️ ' + escapeHtml(t('storyPromptOverride')) + ' (M0)</summary>' +
          '<div class="sm-prompt-editor" id="sm-m0-prompts-wrap">' + escapeHtml(t('loading')) + '</div>' +
        '</details>' +
      '</div>';

    bindEvents(container);
    loadPrompts(container);
  }

  function renderBlueprintTableHtml(items) {
    if (!items || items.length === 0) {
      return '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:13px;">' + escapeHtml(t('storyM0NoBpYet')) + '</div>';
    }
    var html = '<table class="sm-table"><thead><tr>' +
      '<th>#</th>' +
      '<th>' + escapeHtml(t('storyTitle')) + '</th>' +
      '<th>' + escapeHtml(t('storyM0ColPos')) + '</th>' +
      '<th>' + escapeHtml(t('storyM0ColRole')) + '</th>' +
      '<th>' + escapeHtml(t('storyM0ColSuspense')) + '</th>' +
      '<th>' + escapeHtml(t('storyM0ColTwist')) + '</th>' +
      '<th>' + escapeHtml(t('storyM0ColSummary')) + '</th>' +
    '</tr></thead><tbody>';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      html += '<tr>' +
        '<td>' + item.order + '</td>' +
        '<td><strong>' + escapeHtml(item.title) + '</strong></td>' +
        '<td>' + escapeHtml(item.positioning || '—') + '</td>' +
        '<td>' + escapeHtml(item.role || '—') + '</td>' +
        '<td>' + escapeHtml(item.suspenseDensity || '—') + '</td>' +
        '<td>' + '★'.repeat(item.twistLevel || 0) + '☆'.repeat(5 - (item.twistLevel || 0)) + '</td>' +
        '<td>' + escapeHtml(item.summary || '—') + '</td>' +
      '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  function bindEvents(container) {
    container.querySelector('#sm-m0-topic')?.addEventListener('input', function(e) { state.topic = e.target.value; });
    container.querySelector('#sm-m0-genre')?.addEventListener('input', function(e) { state.genre = e.target.value; });
    container.querySelector('#sm-m0-guidance')?.addEventListener('input', function(e) { state.guidance = e.target.value; });
    container.querySelector('#sm-m0-chapters')?.addEventListener('change', function(e) { state.chapters = parseInt(e.target.value, 10) || 30; });

    container.querySelector('#sm-m0-seed')?.addEventListener('input', function(e) { state.seed = e.target.value; });
    container.querySelector('#sm-m0-cd')?.addEventListener('input', function(e) { state.characterDynamics = e.target.value; });
    container.querySelector('#sm-m0-wb')?.addEventListener('input', function(e) { state.worldBuilding = e.target.value; });
    container.querySelector('#sm-m0-ps')?.addEventListener('input', function(e) { state.plotStructure = e.target.value; });

    container.querySelector('#sm-m0-model-arch')?.addEventListener('click', function() {
      pickModel(archModel, function(m) {
        archModel = m;
        container.querySelector('#sm-m0-model-arch span').textContent = m.label;
      });
    });

    container.querySelector('#sm-m0-model-bp')?.addEventListener('click', function() {
      pickModel(bpModel, function(m) {
        bpModel = m;
        container.querySelector('#sm-m0-model-bp span').textContent = m.label;
      });
    });

    // Brainstorm
    container.querySelector('#sm-m0-btn-brainstorm')?.addEventListener('click', function() {
      if (!archModel.value) {
        toast(t('trModelRequired'), 'error');
        return;
      }
      var btn = this;
      btn.disabled = true;
      btn.textContent = t('storyM0Brainstorming');
      var full = '';
      currentAbort = currentCtx.api.sse('/arch-input', {
        model: archModel.value,
        topic: state.topic,
        genre: state.genre,
        chapters: state.chapters,
        guidance: state.guidance
      }, function(delta) {
        full += delta;
      }, function() {
        btn.disabled = false;
        btn.textContent = t('storyM0BrainstormBtn');
        try {
          var cleaned = full.trim().replace(/^```json\s*/, '').replace(/```$/, '');
          var res = JSON.parse(cleaned);
          if (res.topic) state.topic = res.topic;
          if (res.genre) state.genre = res.genre;
          if (res.guidance) state.guidance = res.guidance;
          drawUI(container);
          toast(t('storyM0BrainstormDone'), 'success');
        } catch (e) {
          toast(t('failed') + ': ' + e.message, 'error');
        }
      }, function(err) {
        btn.disabled = false;
        btn.textContent = t('storyM0BrainstormBtn');
        toast(t('failed') + ': ' + err.message, 'error');
      });
    });

    // Generate Architecture
    container.querySelector('#sm-m0-btn-gen-arch')?.addEventListener('click', function() {
      if (!archModel.value) {
        toast(t('trModelRequired'), 'error');
        return;
      }
      if (!state.topic.trim()) {
        toast(t('storyM0TopicLabel'), 'error');
        return;
      }
      var btn = this;
      btn.disabled = true;
      btn.textContent = t('storyM0ArchGenerating');
      state.archOutput = '';
      currentAbort = currentCtx.api.sse('/arch', {
        model: archModel.value,
        topic: state.topic,
        genre: state.genre,
        chapters: state.chapters,
        guidance: state.guidance
      }, function(delta) {
        state.archOutput += delta;
        var p = parseArchSections(state.archOutput);
        state.seed = p.seed;
        state.characterDynamics = p.characterDynamics;
        state.worldBuilding = p.worldBuilding;
        state.plotStructure = p.plotStructure;

        var elSeed = container.querySelector('#sm-m0-seed');
        var elCd = container.querySelector('#sm-m0-cd');
        var elWb = container.querySelector('#sm-m0-wb');
        var elPs = container.querySelector('#sm-m0-ps');
        if (elSeed) elSeed.value = state.seed;
        if (elCd) elCd.value = state.characterDynamics;
        if (elWb) elWb.value = state.worldBuilding;
        if (elPs) elPs.value = state.plotStructure;
      }, function() {
        btn.disabled = false;
        btn.textContent = t('storyM0GenArchBtn');
        toast(t('storyM0ArchGenDone'), 'success');
      }, function(err) {
        btn.disabled = false;
        btn.textContent = t('storyM0GenArchBtn');
        toast(t('failed') + ': ' + err.message, 'error');
      });
    });

    // Adopt Architecture
    container.querySelector('#sm-m0-adopt-arch')?.addEventListener('click', function() {
      var book = currentCtx.getActiveBook();
      if (!book) return;
      var arch = {
        id: book.id,
        bookId: book.id,
        seed: state.seed,
        characterDynamics: state.characterDynamics,
        worldBuilding: state.worldBuilding,
        plotStructure: state.plotStructure,
        updatedAt: new Date().toISOString()
      };
      currentCtx.api.post('/books', { title: book.title, type: book.type }).then(function() {
        toast(t('storyM0ArchSaved'), 'success');
      }).catch(function(err) {
        toast(t('storySaveFail') + ': ' + err.message, 'error');
      });
    });

    // Generate Blueprint
    container.querySelector('#sm-m0-btn-gen-bp')?.addEventListener('click', function() {
      if (!bpModel.value) {
        toast(t('trModelRequired'), 'error');
        return;
      }
      var combinedArch = '## 核心种子\n' + state.seed + '\n## 角色动力学\n' + state.characterDynamics + '\n## 世界观\n' + state.worldBuilding + '\n## 三幕式情节\n' + state.plotStructure;
      if (!combinedArch.trim()) {
        toast(t('storyM0ArchEmpty'), 'error');
        return;
      }
      var btn = this;
      btn.disabled = true;
      btn.textContent = t('storyM0BpGenerating');
      state.blueprintOutput = '';
      currentAbort = currentCtx.api.sse('/blueprint', {
        model: bpModel.value,
        architecture: combinedArch,
        totalChapters: state.chapters,
        startChapter: 1
      }, function(delta) {
        state.blueprintOutput += delta;
        state.parsedBlueprint = parseBlueprint(state.blueprintOutput);
        var preview = container.querySelector('#sm-m0-bp-preview');
        if (preview) preview.innerHTML = renderBlueprintTableHtml(state.parsedBlueprint);
      }, function() {
        btn.disabled = false;
        btn.textContent = t('storyM0GenBpBtn');
        var adoptBtn = container.querySelector('#sm-m0-adopt-bp');
        if (adoptBtn) adoptBtn.disabled = state.parsedBlueprint.length === 0;
        toast(t('storyM0BpGenDone'), 'success');
      }, function(err) {
        btn.disabled = false;
        btn.textContent = t('storyM0GenBpBtn');
        toast(t('failed') + ': ' + err.message, 'error');
      });
    });

    // Adopt Blueprint to Outline
    container.querySelector('#sm-m0-adopt-bp')?.addEventListener('click', function() {
      var book = currentCtx.getActiveBook();
      if (!book || state.parsedBlueprint.length === 0) return;
      currentCtx.api.post('/outline:append', {
        bookId: book.id,
        nodes: state.parsedBlueprint
      }).then(function() {
        toast(t('storyM0BpAppended', [state.parsedBlueprint.length]), 'success');
      }).catch(function(err) {
        toast(t('failed') + ': ' + err.message, 'error');
      });
    });
  }

  function loadPrompts(container) {
    var wrap = container.querySelector('#sm-m0-prompts-wrap');
    if (!wrap) return;
    var keys = ['m0-arch-input', 'm0-arch', 'm0-blueprint'];
    var html = '';
    keys.forEach(function(k) {
      html += '<div style="margin-bottom:12px;">' +
        '<div style="font-weight:600;font-size:12px;margin-bottom:4px;color:var(--text-secondary);">' + k + '</div>' +
        '<textarea class="sm-textarea" id="sm-prompt-' + k + '" style="min-height:80px;"></textarea>' +
        '<button class="btn btn-ghost btn-sm sm-save-prompt" data-key="' + k + '" style="margin-top:4px;">' + escapeHtml(t('storyM0SavePrompt')) + '</button>' +
      '</div>';
    });
    wrap.innerHTML = html;

    keys.forEach(function(k) {
      currentCtx.api.get('/prompts/' + k).then(function(res) {
        var el = wrap.querySelector('#sm-prompt-' + k);
        if (el && res && res.content) el.value = res.content;
      });
    });

    wrap.querySelectorAll('.sm-save-prompt').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var k = btn.dataset.key;
        var val = (wrap.querySelector('#sm-prompt-' + k) || {}).value || '';
        currentCtx.api.put('/prompts/' + k, { content: val }).then(function() {
          toast(t('storyM0PromptSaved'), 'success');
        }).catch(function(err) {
          toast(t('storySaveFail') + ': ' + err.message, 'error');
        });
      });
    });
  }

  window.storyRenderM0 = render;
  window.storyCleanupM0 = function() {
    if (currentAbort) {
      try { currentAbort.abort(); } catch (e) {}
      currentAbort = null;
    }
  };
})();
