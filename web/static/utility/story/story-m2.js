// web/static/utility/story/story-m2.js — M2 Entity Cards
// Dependency load order:
// vendor/diff.min.js -> utility/editor/editor.js -> editor_textreview_diff.js -> storymaker.js -> story-home.js -> story-m0.js -> story-m2.js

(function() {
  'use strict';

  var currentCtx = null;
  var currentAbort = null;
  var currentTab = 'cards'; // 'cards' | 'merge'
  var currentScope = 'project'; // 'all' | 'project'
  var currentTypeFilter = 'all';
  var searchKeyword = '';

  var textModel = { value: '', label: t('storySelectModel') };
  var imageModel = { value: '', label: t('storySelectImageModel') };

  var cardsCache = [];
  var mergeCandidatesCache = [];

  function getTypeLabels() {
    return {
      character: t('storyCardCharacter'),
      location: t('storyCardLocation'),
      item: t('storyCardItem'),
      skill: t('storyCardSkill'),
      faction: t('storyCardFaction')
    };
  }

  var TYPE_ICONS = {
    character: '👤',
    location: '🏰',
    item: '🗡️',
    skill: '⚡',
    faction: '🛡️'
  };

  var TYPE_TAG_CLASSES = {
    character: 'tag-blue',
    location: 'tag-green',
    item: 'tag-amber',
    skill: 'tag-purple',
    faction: 'tag-gray'
  };

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
    var bookId = currentScope === 'project' ? currentCtx.activeBookId : '';
    currentCtx.api.get('/cards?bookId=' + encodeURIComponent(bookId)).then(function(res) {
      cardsCache = (res && res.cards) || [];
      if (currentTab === 'merge') {
        return currentCtx.api.get('/merge-candidates').then(function(mRes) {
          mergeCandidatesCache = (mRes && mRes.mergeCandidates) || [];
          if (cb) cb();
        });
      } else {
        if (cb) cb();
      }
    }).catch(function(err) {
      console.warn('load cards error:', err);
      if (cb) cb();
    });
  }

  function pickModel(current, onPick, kindFilter) {
    var filter = kindFilter || 'text';
    if (typeof pgOpenModelPicker === 'function') {
      pgOpenModelPicker(current.value, function(res) {
        if (res && res.id) {
          onPick({ value: res.id, label: res.name || res.id });
        }
      }, { kindFilter: filter });
    } else {
      var m = prompt(t('assistantPickModel') + ' (provider/model):', current.value || '');
      if (m) onPick({ value: m, label: m });
    }
  }

  function drawUI(container) {
    var book = currentCtx.getActiveBook();
    var scopeOptions = [
      { value: 'project', label: t('storyM2CurProject') },
      { value: 'all', label: t('storyM2AllRef') }
    ];
    var typeOptions = [
      { value: 'all', label: t('storyAllTypes') },
      { value: 'character', label: t('storyCardCharacter') },
      { value: 'location', label: t('storyCardLocation') },
      { value: 'item', label: t('storyCardItem') },
      { value: 'skill', label: t('storyCardSkill') },
      { value: 'faction', label: t('storyCardFaction') }
    ];

    container.innerHTML = '' +
      '<div class="sm-page-container">' +
        '<div class="sm-page-header">' +
          '<div class="sm-page-title">' + escapeHtml(t('storyM2')) + ' <span style="font-size:14px;color:var(--text-secondary);font-weight:normal;">(' + escapeHtml(book.title) + ')</span></div>' +
          '<div class="sm-page-actions">' +
            '<button class="btn btn-ghost" type="button" id="sm-m2-btn-extract">' + escapeHtml(t('storyCardExtract')) + '</button>' +
            '<button class="btn btn-ghost" type="button" id="sm-m2-btn-batch">' + escapeHtml(t('storyCardBatch')) + '</button>' +
            '<button class="btn btn-primary" type="button" id="sm-m2-btn-create">' + escapeHtml(t('storyCardNew')) + '</button>' +
          '</div>' +
        '</div>' +

        // Filter Bar & Tabs
        '<div class="sm-card" style="padding:14px 20px;gap:12px;">' +
          '<div class="sm-tabs">' +
            '<button type="button" class="sm-tab-btn' + (currentTab === 'cards' ? ' active' : '') + '" data-tab="cards">' + escapeHtml(t('storyM2CardList')) + ' (' + cardsCache.length + ')</button>' +
            '<button type="button" class="sm-tab-btn' + (currentTab === 'merge' ? ' active' : '') + '" data-tab="merge">' + escapeHtml(t('storyM2MergeCandidates')) + ' (' + mergeCandidatesCache.length + ')</button>' +
          '</div>' +
          '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">' +
            '<div style="width:140px;">' + renderCustomSelectHtml('sm-m2-scope-wrap', 'sm-m2-scope-select', scopeOptions, currentScope, null, 'width:100%;height:32px') + '</div>' +
            '<div style="width:160px;">' + renderCustomSelectHtml('sm-m2-type-wrap', 'sm-m2-type-select', typeOptions, currentTypeFilter, null, 'width:100%;height:32px') + '</div>' +
            '<div style="flex:1;min-width:200px;">' +
              '<input type="text" class="input" id="sm-m2-search-input" placeholder="' + escapeAttr(t('storyM2SearchPlaceholder')) + '" value="' + escapeHtml(searchKeyword) + '">' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Main Tab Content
        '<div id="sm-m2-tab-content"></div>' +
      '</div>';

    // Bind filters & tabs
    container.querySelector('#sm-m2-scope-select')?.addEventListener('change', function(e) {
      currentScope = e.target.value;
      loadData(function() { drawUI(container); });
    });
    container.querySelector('#sm-m2-type-select')?.addEventListener('change', function(e) {
      currentTypeFilter = e.target.value;
      renderTabContent(container);
    });
    container.querySelector('#sm-m2-search-input')?.addEventListener('input', function(e) {
      searchKeyword = e.target.value.trim().toLowerCase();
      renderTabContent(container);
    });

    container.querySelectorAll('.sm-tab-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        currentTab = btn.dataset.tab;
        loadData(function() { drawUI(container); });
      });
    });

    container.querySelector('#sm-m2-btn-extract')?.addEventListener('click', openExtractModal);
    container.querySelector('#sm-m2-btn-batch')?.addEventListener('click', openBatchModal);
    container.querySelector('#sm-m2-btn-create')?.addEventListener('click', function() {
      openCardEditor(null);
    });

    renderTabContent(container);
  }

  function renderTabContent(container) {
    var contentEl = container.querySelector('#sm-m2-tab-content');
    if (!contentEl) return;
    if (currentTab === 'cards') {
      renderCardsGrid(contentEl);
    } else {
      renderMergeCandidates(contentEl);
    }
  }

  function renderCardsGrid(contentEl) {
    var filtered = cardsCache.filter(function(c) {
      if (currentTypeFilter !== 'all' && c.type !== currentTypeFilter) return false;
      if (searchKeyword) {
        var matchName = (c.name || '').toLowerCase().indexOf(searchKeyword) !== -1;
        var matchDesc = (c.description || '').toLowerCase().indexOf(searchKeyword) !== -1;
        var matchAliases = (c.aliases || []).some(function(a) { return a.toLowerCase().indexOf(searchKeyword) !== -1; });
        if (!matchName && !matchDesc && !matchAliases) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      contentEl.innerHTML = '<div class="sm-card">' +
        '<div class="sm-empty-state">' +
          '<div class="sm-empty-icon">🃏</div>' +
          '<p>' + escapeHtml(t('storyM2NoCardsYet')) + '</p>' +
          '<button class="btn btn-primary btn-sm" type="button" id="sm-m2-empty-create">' + escapeHtml(t('storyCardNew')) + '</button>' +
        '</div>' +
      '</div>';
      contentEl.querySelector('#sm-m2-empty-create')?.addEventListener('click', function() {
        openCardEditor(null);
      });
      return;
    }

    var typeLabels = getTypeLabels();
    var html = '<div class="sm-card-grid">';
    for (var i = 0; i < filtered.length; i++) {
      var c = filtered[i];
      var icon = TYPE_ICONS[c.type] || '📄';
      var tagClass = TYPE_TAG_CLASSES[c.type] || 'tag-gray';
      var typeLabel = typeLabels[c.type] || c.type;

      var thumbHtml = '';
      if (c.images && c.images.length > 0) {
        var imgUrl = c.images[0].url;
        var displayUrl = imgUrl.startsWith('http') ? ('/api/image-proxy?url=' + encodeURIComponent(imgUrl)) : imgUrl;
        thumbHtml = '<img src="' + escapeHtml(displayUrl) + '" alt="' + escapeHtml(c.name) + '" loading="lazy">';
      } else {
        thumbHtml = '<div class="sm-card-thumb-icon">' + icon + '</div>';
      }

      var aliasesHtml = '';
      if (c.aliases && c.aliases.length > 0) {
        aliasesHtml = '<div class="sm-card-tags">';
        for (var j = 0; j < Math.min(3, c.aliases.length); j++) {
          aliasesHtml += '<span class="tag tag-gray" style="font-size:10px;">' + escapeHtml(c.aliases[j]) + '</span>';
        }
        aliasesHtml += '</div>';
      }

      html += '<div class="sm-entity-card" data-id="' + escapeHtml(c.id) + '">' +
        '<div class="sm-card-thumb">' + thumbHtml + '</div>' +
        '<div class="sm-card-body">' +
          '<div class="sm-card-title-row">' +
            '<span class="sm-card-name" title="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) + '</span>' +
            '<span class="tag ' + tagClass + '" style="font-size:11px;">' + escapeHtml(typeLabel) + '</span>' +
          '</div>' +
          aliasesHtml +
          '<div class="sm-card-desc">' + escapeHtml(c.description || t('storyM2NoDescription')) + '</div>' +
        '</div>' +
        '<div class="sm-card-footer">' +
          '<button class="btn btn-ghost btn-sm sm-card-btn-img" data-id="' + escapeHtml(c.id) + '" type="button">' + escapeHtml(t('storyCardGenerateImage')) + '</button>' +
          '<button class="btn btn-ghost btn-sm sm-card-btn-edit" data-id="' + escapeHtml(c.id) + '" type="button">' + escapeHtml(t('storyM2ViewEdit')) + '</button>' +
          '<button class="btn btn-danger btn-sm sm-card-btn-del" data-id="' + escapeHtml(c.id) + '" type="button">' + escapeHtml(t('delete')) + '</button>' +
        '</div>' +
      '</div>';
    }
    html += '</div>';
    contentEl.innerHTML = html;

    // Events
    contentEl.querySelectorAll('.sm-card-btn-edit').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var card = cardsCache.find(function(x) { return x.id === btn.dataset.id; });
        if (card) openCardEditor(card);
      });
    });

    contentEl.querySelectorAll('.sm-card-btn-img').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var card = cardsCache.find(function(x) { return x.id === btn.dataset.id; });
        if (card) openImageModal(card);
      });
    });

    contentEl.querySelectorAll('.sm-card-btn-del').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.dataset.id;
        confirmModal({
          title: t('delete'),
          content: t('storyM2DeleteCardConfirm'),
          onOk: function() {
            currentCtx.api.del('/cards/' + encodeURIComponent(id)).then(function() {
              toast(t('storyM2CardDeleted'), 'success');
              loadData(function() {
                renderTabContent(container);
              });
            }).catch(function(err) {
              toast(t('storyDeleteFail') + ': ' + err.message, 'error');
            });
          }
        });
      });
    });
  }

  function renderMergeCandidates(contentEl) {
    if (mergeCandidatesCache.length === 0) {
      contentEl.innerHTML = '<div class="sm-card">' +
        '<div class="sm-empty-state">' +
          '<div class="sm-empty-icon">🤝</div>' +
          '<p>' + escapeHtml(t('storyM2NoCandidates')) + '</p>' +
        '</div>' +
      '</div>';
      return;
    }

    var html = '<div class="sm-card" style="padding:0;overflow:hidden;">' +
      '<table class="sm-table">' +
        '<thead>' +
          '<tr>' +
            '<th>' + escapeHtml(t('storyM2CardA')) + '</th>' +
            '<th>' + escapeHtml(t('storyM2CardB')) + '</th>' +
            '<th>' + escapeHtml(t('storyM2Similarity')) + '</th>' +
            '<th>' + escapeHtml(t('status')) + '</th>' +
            '<th style="text-align:right;">' + escapeHtml(t('actions')) + '</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>';

    for (var i = 0; i < mergeCandidatesCache.length; i++) {
      var mc = mergeCandidatesCache[i];
      var cardA = cardsCache.find(function(c) { return c.id === mc.cardAId; });
      var cardB = cardsCache.find(function(c) { return c.id === mc.cardBId; });

      html += '<tr>' +
        '<td><strong>' + escapeHtml(cardA ? cardA.name : mc.cardAId) + '</strong></td>' +
        '<td><strong>' + escapeHtml(cardB ? cardB.name : mc.cardBId) + '</strong></td>' +
        '<td>' + Math.round((mc.similarity || 0) * 100) + '%</td>' +
        '<td><span class="tag tag-amber">' + escapeHtml(mc.status || 'pending') + '</span></td>' +
        '<td style="text-align:right;">' +
          '<button class="btn btn-ghost btn-sm sm-mc-keep" data-id="' + escapeHtml(mc.id) + '" type="button">' + escapeHtml(t('storyM2KeepBoth')) + '</button> ' +
          '<button class="btn btn-primary btn-sm sm-mc-merge" data-id="' + escapeHtml(mc.id) + '" type="button">' + escapeHtml(t('storyM2MergeIntoA')) + '</button>' +
        '</td>' +
      '</tr>';
    }
    html += '</tbody></table></div>';
    contentEl.innerHTML = html;

    contentEl.querySelectorAll('.sm-mc-keep').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.dataset.id;
        var mc = mergeCandidatesCache.find(function(x) { return x.id === id; });
        if (!mc) return;
        mc.status = 'kept';
        currentCtx.api.post('/merge-candidates', mc).then(function() {
          toast(t('storyM2KeepBothSuccess'), 'success');
          loadData(function() { renderTabContent(contentEl.parentElement); });
        });
      });
    });

    contentEl.querySelectorAll('.sm-mc-merge').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.dataset.id;
        var mc = mergeCandidatesCache.find(function(x) { return x.id === id; });
        if (!mc) return;
        var cardA = cardsCache.find(function(c) { return c.id === mc.cardAId; });
        var cardB = cardsCache.find(function(c) { return c.id === mc.cardBId; });
        if (!cardA || !cardB) {
          toast(t('storyM2CardNotFound'), 'error');
          return;
        }
        // Merge B aliases into A
        var newAliases = (cardA.aliases || []).concat([cardB.name]).concat(cardB.aliases || []);
        cardA.aliases = Array.from(new Set(newAliases));
        if (!cardA.description && cardB.description) cardA.description = cardB.description;
        // Merge fields
        if (cardB.fields) {
          cardA.fields = Object.assign({}, cardB.fields, cardA.fields || {});
        }
        // Save A, delete B, mark mc merged
        currentCtx.api.post('/cards', cardA).then(function() {
          return currentCtx.api.del('/cards/' + encodeURIComponent(cardB.id));
        }).then(function() {
          mc.status = 'merged';
          return currentCtx.api.post('/merge-candidates', mc);
        }).then(function() {
          toast(t('storyM2MergeSuccess'), 'success');
          loadData(function() { renderTabContent(contentEl.parentElement); });
        }).catch(function(err) {
          toast(t('storyM2MergeFail') + ': ' + err.message, 'error');
        });
      });
    });
  }

  // --- ExtractModal ---
  function openExtractModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = '' +
      '<div class="modal-card" style="width:680px;max-width:95vw;">' +
        '<div class="modal-header">' +
          '<div class="modal-title">' + escapeHtml(t('storyM2ExtractModalTitle')) + '</div>' +
          '<button class="modal-close-btn">&times;</button>' +
        '</div>' +
        '<div class="modal-body" style="display:flex;flex-direction:column;gap:14px;max-height:75vh;overflow-y:auto;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span class="sm-field-label">' + escapeHtml(t('storySelectModel')) + ':</span>' +
            '<button type="button" class="sm-model-btn" id="sm-extract-model-btn">' +
              '<span>🤖</span><span id="sm-extract-model-label">' + escapeHtml(textModel.label) + '</span>' +
            '</button>' +
          '</div>' +
          '<div class="sm-field">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM2ExtractSelectChapters')) + '</span>' +
              '<div style="display:flex;gap:8px;">' +
                '<button type="button" class="btn btn-ghost btn-sm" id="sm-ch-select-all">' + escapeHtml(t('selectAll')) + '</button>' +
                '<button type="button" class="btn btn-ghost btn-sm" id="sm-ch-select-none">' + escapeHtml(t('deselectAll')) + '</button>' +
              '</div>' +
            '</div>' +
            '<div id="sm-extract-ch-list" style="max-height:160px;overflow-y:auto;border:1px solid var(--glass-border);border-radius:var(--radius-md);padding:8px;display:flex;flex-direction:column;gap:4px;">' +
              '<span style="color:var(--text-secondary);font-size:12px;">' + escapeHtml(t('storyM2ChaptersLoading')) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="sm-field" id="sm-extract-progress-wrap" style="display:none;">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM2Progress')) + '<span id="sm-extract-progress-text">0 / 0</span></span>' +
            '<div style="height:6px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;">' +
              '<div id="sm-extract-progress-bar" style="width:0%;height:100%;background:var(--accent);transition:width 0.2s ease;"></div>' +
            '</div>' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM2Preview')) + '</span>' +
            '<div id="sm-extract-results" style="min-height:120px;max-height:220px;overflow-y:auto;border:1px solid var(--glass-border);border-radius:var(--radius-md);padding:10px;font-size:12px;display:flex;flex-direction:column;gap:6px;">' +
              '<span style="color:var(--text-secondary);">' + escapeHtml(t('storyM2NotStarted')) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:10px;">' +
          '<button class="btn btn-ghost" type="button" id="sm-extract-cancel">' + escapeHtml(t('cancel')) + '</button>' +
          '<button class="btn btn-primary" type="button" id="sm-extract-start">' + escapeHtml(t('storyM2ExtractBtn')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var close = function() {
      if (currentAbort) {
        try { currentAbort.abort(); } catch (e) {}
        currentAbort = null;
      }
      overlay.remove();
    };
    overlay.querySelector('.modal-close-btn').addEventListener('click', close);
    overlay.querySelector('#sm-extract-cancel').addEventListener('click', close);

    overlay.querySelector('#sm-extract-model-btn').addEventListener('click', function() {
      pickModel(textModel, function(m) {
        textModel = m;
        overlay.querySelector('#sm-extract-model-label').textContent = m.label;
      }, 'text');
    });

    // Load chapters
    currentCtx.api.get('/chapters?bookId=' + encodeURIComponent(currentCtx.activeBookId)).then(function(res) {
      var chapters = (res && res.chapters) || [];
      var chListEl = overlay.querySelector('#sm-extract-ch-list');
      if (chapters.length === 0) {
        chListEl.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">' + escapeHtml(t('storyM2ExtractNoChapters')) + '</span>';
        return;
      }
      var chHtml = '';
      for (var i = 0; i < chapters.length; i++) {
        var ch = chapters[i];
        var chPrefix = (typeof getLang === 'function' && getLang() === 'en') ? ('Chapter ' + ch.Index + ': ') : ('第 ' + ch.Index + ' 章 ');
        chHtml += '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">' +
          '<input type="checkbox" class="sm-ch-cb" value="' + escapeHtml(ch.id) + '"> ' +
          '<span>' + chPrefix + escapeHtml(ch.Title) + '</span>' +
        '</label>';
      }
      chListEl.innerHTML = chHtml;
    });

    overlay.querySelector('#sm-ch-select-all').addEventListener('click', function() {
      overlay.querySelectorAll('.sm-ch-cb').forEach(function(cb) { cb.checked = true; });
    });
    overlay.querySelector('#sm-ch-select-none').addEventListener('click', function() {
      overlay.querySelectorAll('.sm-ch-cb').forEach(function(cb) { cb.checked = false; });
    });

    overlay.querySelector('#sm-extract-start').addEventListener('click', function() {
      if (!textModel.value) {
        toast(t('trModelRequired'), 'warning');
        return;
      }
      var selectedChIds = [];
      overlay.querySelectorAll('.sm-ch-cb:checked').forEach(function(cb) {
        selectedChIds.push(cb.value);
      });
      if (selectedChIds.length === 0) {
        toast(t('storyM2ExtractSelectChapterWarning'), 'warning');
        return;
      }

      var existingNames = cardsCache.map(function(c) { return c.name; });
      var progressWrap = overlay.querySelector('#sm-extract-progress-wrap');
      var progressBar = overlay.querySelector('#sm-extract-progress-bar');
      var progressText = overlay.querySelector('#sm-extract-progress-text');
      var resultsEl = overlay.querySelector('#sm-extract-results');
      var startBtn = overlay.querySelector('#sm-extract-start');

      progressWrap.style.display = 'flex';
      resultsEl.innerHTML = '';
      startBtn.disabled = true;
      startBtn.textContent = t('storyM2ExtractLoading');

      var total = selectedChIds.length;
      var newCardsCount = 0;

      currentAbort = currentCtx.api.sse('/extract-entities', {
        model: textModel.value,
        bookId: currentCtx.activeBookId,
        chapterIds: selectedChIds,
        existingCardNames: existingNames
      }, function(data) {
        if (typeof data === 'object') {
          if (data.stage === 'extracting') {
            var curr = data.current || 0;
            var pct = total > 0 ? Math.round((curr / total) * 100) : 0;
            progressBar.style.width = pct + '%';
            progressText.textContent = curr + ' / ' + total;
          } else if (data.name) {
            // New entity card extracted
            newCardsCount++;
            var tagClass = TYPE_TAG_CLASSES[data.type] || 'tag-gray';
            var div = document.createElement('div');
            div.style.padding = '4px 0';
            div.innerHTML = '<span class="tag ' + tagClass + '">' + escapeHtml(data.type) + '</span> ' +
              '<strong>' + escapeHtml(data.name) + '</strong>: ' + escapeHtml(data.description || '');
            resultsEl.appendChild(div);
            resultsEl.scrollTop = resultsEl.scrollHeight;

            // Automatically persist
            currentCtx.api.post('/cards', data).catch(function(e) { console.warn('auto save card error:', e); });
          }
        }
      }, function() {
        startBtn.disabled = false;
        startBtn.textContent = t('storyM2ExtractBtn');
        toast(t('storyM2ExtractDone', [newCardsCount]), 'success');
        loadData(function() {
          var container = document.getElementById('sm-main-content');
          if (container) drawUI(container);
        });
      }, function(err) {
        startBtn.disabled = false;
        startBtn.textContent = t('storyM2ExtractBtn');
        toast(t('failed') + ': ' + err.message, 'error');
      });
    });
  }

  // --- CardEditorModal (Create / Edit / AI Enrich) ---
  function openCardEditor(initialCard) {
    var card = initialCard ? JSON.parse(JSON.stringify(initialCard)) : {
      id: '',
      bookId: currentCtx.activeBookId,
      type: 'character',
      name: '',
      aliases: [],
      fields: {},
      description: '',
      styleNote: '',
      styleExamples: []
    };

    var overlay = document.createElement('div');
    overlay.className = 'sm-drawer-overlay';
    overlay.innerHTML = '' +
      '<div class="sm-drawer">' +
        '<div class="sm-drawer-header">' +
          '<div class="modal-title">' + (card.id ? escapeHtml(t('storyM2CardEditModalTitle')) : escapeHtml(t('storyM2CardNewModalTitle'))) + '</div>' +
          '<button class="modal-close-btn">&times;</button>' +
        '</div>' +
        '<div class="sm-drawer-body">' +
          // AI Assistant Panel
          '<details class="sm-prompt-details" open>' +
            '<summary class="sm-prompt-summary">✨ ' + escapeHtml(t('storyM2AiHelper')) + '</summary>' +
            '<div style="display:flex;flex-direction:column;gap:10px;margin-top:10px;">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<span class="sm-field-label">' + escapeHtml(t('storySelectModel')) + ':</span>' +
                '<button type="button" class="sm-model-btn" id="sm-card-ai-model-btn">' +
                  '<span>🤖</span><span id="sm-card-ai-model-label">' + escapeHtml(textModel.label) + '</span>' +
                '</button>' +
              '</div>' +
              '<div style="display:flex;gap:10px;align-items:center;">' +
                '<label style="font-size:12px;display:flex;align-items:center;gap:4px;">' +
                  '<input type="radio" name="sm-card-ai-mode" value="create"' + (!card.id ? ' checked' : '') + '> ' + escapeHtml(t('storyM2AiFromScratch')) +
                '</label>' +
                '<label style="font-size:12px;display:flex;align-items:center;gap:4px;">' +
                  '<input type="radio" name="sm-card-ai-mode" value="enrich"' + (card.id ? ' checked' : '') + '> ' + escapeHtml(t('storyM2AiEnrich')) +
                '</label>' +
              '</div>' +
              '<input type="text" class="input" id="sm-card-ai-inst" placeholder="' + escapeAttr(t('storyM2AiInstPlaceholder')) + '">' +
              '<button type="button" class="btn btn-ghost btn-sm" id="sm-card-ai-gen-btn">' + escapeHtml(t('storyM2AiGenBtn')) + '</button>' +
            '</div>' +
          '</details>' +

          // Basic fields
          '<div class="sm-form-grid">' +
            '<div class="sm-field">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM2CardNameLabel')) + '</span>' +
              '<input type="text" class="input" id="sm-card-name" value="' + escapeHtml(card.name) + '">' +
            '</div>' +
            '<div class="sm-field">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM2CardTypeLabel')) + '</span>' +
              '<select class="select" id="sm-card-type">' +
                '<option value="character"' + (card.type === 'character' ? ' selected' : '') + '>' + escapeHtml(t('storyCardCharacter')) + '</option>' +
                '<option value="location"' + (card.type === 'location' ? ' selected' : '') + '>' + escapeHtml(t('storyCardLocation')) + '</option>' +
                '<option value="item"' + (card.type === 'item' ? ' selected' : '') + '>' + escapeHtml(t('storyCardItem')) + '</option>' +
                '<option value="skill"' + (card.type === 'skill' ? ' selected' : '') + '>' + escapeHtml(t('storyCardSkill')) + '</option>' +
                '<option value="faction"' + (card.type === 'faction' ? ' selected' : '') + '>' + escapeHtml(t('storyCardFaction')) + '</option>' +
              '</select>' +
            '</div>' +
          '</div>' +

          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM2CardAliasesLabel')) + '</span>' +
            '<input type="text" class="input" id="sm-card-aliases" value="' + escapeHtml((card.aliases || []).join(', ')) + '">' +
          '</div>' +

          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM2CardDescLabel')) + '</span>' +
            '<textarea class="sm-textarea" id="sm-card-desc" rows="4">' + escapeHtml(card.description || '') + '</textarea>' +
          '</div>' +

          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM2CardStyleNoteLabel')) + '</span>' +
            '<input type="text" class="input" id="sm-card-style-note" placeholder="' + escapeAttr(t('storyM2CardStyleNotePlaceholder')) + '" value="' + escapeHtml(card.styleNote || '') + '">' +
          '</div>' +

          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM2CardStyleExamplesLabel')) + '</span>' +
            '<textarea class="sm-textarea" id="sm-card-style-examples" rows="2" placeholder="' + escapeAttr(t('storyM2CardStyleExamplesPlaceholder')) + '">' + escapeHtml((card.styleExamples || []).join('\n')) + '</textarea>' +
          '</div>' +

          // Custom key-value fields
          '<div class="sm-field">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM2CardFieldsLabel')) + '</span>' +
              '<button type="button" class="btn btn-ghost btn-sm" id="sm-card-add-field">' + escapeHtml(t('storyM2CardAddFieldBtn')) + '</button>' +
            '</div>' +
            '<div id="sm-card-fields-wrap" style="display:flex;flex-direction:column;gap:6px;"></div>' +
          '</div>' +
        '</div>' +

        '<div class="sm-drawer-footer">' +
          '<button class="btn btn-ghost" type="button" id="sm-card-cancel">' + escapeHtml(t('cancel')) + '</button>' +
          '<button class="btn btn-primary" type="button" id="sm-card-save">' + escapeHtml(t('storyM2CardSaveBtn')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var close = function() { overlay.remove(); };
    overlay.querySelector('.modal-close-btn').addEventListener('click', close);
    overlay.querySelector('#sm-card-cancel').addEventListener('click', close);

    overlay.querySelector('#sm-card-ai-model-btn').addEventListener('click', function() {
      pickModel(textModel, function(m) {
        textModel = m;
        overlay.querySelector('#sm-card-ai-model-label').textContent = m.label;
      }, 'text');
    });

    // Render custom fields
    var fieldsWrap = overlay.querySelector('#sm-card-fields-wrap');
    function renderFields() {
      fieldsWrap.innerHTML = '';
      var keys = Object.keys(card.fields || {});
      if (keys.length === 0) {
        fieldsWrap.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">' + escapeHtml(t('storyM2CardNoFields')) + '</span>';
        return;
      }
      keys.forEach(function(k) {
        var row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '8px';
        row.innerHTML = '' +
          '<input type="text" class="input sm-field-k" style="width:120px;" placeholder="' + escapeAttr(t('storyM2CardFieldKeyPlaceholder')) + '" value="' + escapeHtml(k) + '">' +
          '<input type="text" class="input sm-field-v" style="flex:1;" placeholder="' + escapeAttr(t('storyM2CardFieldValPlaceholder')) + '" value="' + escapeHtml(card.fields[k] || '') + '">' +
          '<button type="button" class="btn btn-danger btn-sm sm-field-del">&times;</button>';
        row.querySelector('.sm-field-del').addEventListener('click', function() {
          delete card.fields[k];
          renderFields();
        });
        row.querySelector('.sm-field-k').addEventListener('change', function(e) {
          var newK = e.target.value.trim();
          var v = card.fields[k];
          delete card.fields[k];
          if (newK) card.fields[newK] = v;
        });
        row.querySelector('.sm-field-v').addEventListener('change', function(e) {
          card.fields[k] = e.target.value;
        });
        fieldsWrap.appendChild(row);
      });
    }
    renderFields();

    overlay.querySelector('#sm-card-add-field').addEventListener('click', function() {
      if (!card.fields) card.fields = {};
      var count = Object.keys(card.fields).length + 1;
      card.fields['attr_' + count] = '';
      renderFields();
    });

    // AI Generate Card
    overlay.querySelector('#sm-card-ai-gen-btn').addEventListener('click', function() {
      if (!textModel.value) {
        toast(t('trModelRequired'), 'warning');
        return;
      }
      var mode = overlay.querySelector('input[name="sm-card-ai-mode"]:checked')?.value || 'create';
      var instruction = overlay.querySelector('#sm-card-ai-inst').value.trim();
      var type = overlay.querySelector('#sm-card-type').value;

      var genBtn = overlay.querySelector('#sm-card-ai-gen-btn');
      genBtn.disabled = true;
      genBtn.textContent = t('storyM2AiGenLoading');

      var existingCardStr = '';
      if (mode === 'enrich') {
        existingCardStr = '名称：' + (overlay.querySelector('#sm-card-name').value || card.name) + '\n' +
          '描述：' + overlay.querySelector('#sm-card-desc').value;
      }

      currentCtx.api.post('/generate-card', {
        model: textModel.value,
        type: type,
        mode: mode,
        instruction: instruction,
        existingCard: existingCardStr
      }).then(function(res) {
        genBtn.disabled = false;
        genBtn.textContent = t('storyM2AiGenBtn');
        var generated = res && res.card;
        if (!generated) {
          toast(t('storyM2AiGenEmpty'), 'error');
          return;
        }
        if (generated.name) overlay.querySelector('#sm-card-name').value = generated.name;
        if (generated.description) overlay.querySelector('#sm-card-desc').value = generated.description;
        if (generated.aliases && Array.isArray(generated.aliases)) {
          overlay.querySelector('#sm-card-aliases').value = generated.aliases.join(', ');
        }
        if (generated.styleNote) overlay.querySelector('#sm-card-style-note').value = generated.styleNote;
        if (generated.styleExamples && Array.isArray(generated.styleExamples)) {
          overlay.querySelector('#sm-card-style-examples').value = generated.styleExamples.join('\n');
        }
        if (generated.fields && typeof generated.fields === 'object') {
          card.fields = Object.assign({}, card.fields, generated.fields);
          renderFields();
        }
        toast(t('storyM2AiGenDone'), 'success');
      }).catch(function(err) {
        genBtn.disabled = false;
        genBtn.textContent = t('storyM2AiGenBtn');
        toast(t('failed') + ': ' + err.message, 'error');
      });
    });

    // Save Card
    overlay.querySelector('#sm-card-save').addEventListener('click', function() {
      var name = overlay.querySelector('#sm-card-name').value.trim();
      if (!name) {
        toast(t('storyM2CardInputNameWarning'), 'warning');
        return;
      }
      card.name = name;
      card.type = overlay.querySelector('#sm-card-type').value;
      var aliasesStr = overlay.querySelector('#sm-card-aliases').value.trim();
      card.aliases = aliasesStr ? aliasesStr.split(/[,，\s]+/).filter(Boolean) : [];
      card.description = overlay.querySelector('#sm-card-desc').value.trim();
      card.styleNote = overlay.querySelector('#sm-card-style-note').value.trim();
      var examplesStr = overlay.querySelector('#sm-card-style-examples').value.trim();
      card.styleExamples = examplesStr ? examplesStr.split('\n').filter(Boolean) : [];

      currentCtx.api.post('/cards', card).then(function(saved) {
        toast(t('storyM2CardSaved'), 'success');
        close();
        loadData(function() {
          var container = document.getElementById('sm-main-content');
          if (container) drawUI(container);
        });
      }).catch(function(err) {
        toast(t('storySaveFail') + ': ' + err.message, 'error');
      });
    });
  }

  // --- BatchCardModal ---
  function openBatchModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = '' +
      '<div class="modal-card" style="width:600px;max-width:95vw;">' +
        '<div class="modal-header">' +
          '<div class="modal-title">' + escapeHtml(t('storyM2BatchModalTitle')) + '</div>' +
          '<button class="modal-close-btn">&times;</button>' +
        '</div>' +
        '<div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span class="sm-field-label">' + escapeHtml(t('storySelectModel')) + ':</span>' +
            '<button type="button" class="sm-model-btn" id="sm-batch-model-btn">' +
              '<span>🤖</span><span id="sm-batch-model-label">' + escapeHtml(textModel.label) + '</span>' +
            '</button>' +
          '</div>' +
          '<div class="sm-form-grid">' +
            '<div class="sm-field">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM2CardTypeLabel')) + '</span>' +
              '<select class="select" id="sm-batch-type">' +
                '<option value="character">' + escapeHtml(t('storyCardCharacter')) + '</option>' +
                '<option value="location">' + escapeHtml(t('storyCardLocation')) + '</option>' +
                '<option value="item">' + escapeHtml(t('storyCardItem')) + '</option>' +
                '<option value="skill">' + escapeHtml(t('storyCardSkill')) + '</option>' +
                '<option value="faction">' + escapeHtml(t('storyCardFaction')) + '</option>' +
              '</select>' +
            '</div>' +
            '<div class="sm-field">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM2BatchCountLabel')) + '</span>' +
              '<div style="width:120px;">' + renderStepperHtml('sm-batch-count', 3, 1, 8) + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM2BatchThemeLabel')) + '</span>' +
            '<textarea class="sm-textarea" id="sm-batch-inst" rows="3" placeholder="' + escapeAttr(t('storyM2BatchThemePlaceholder')) + '"></textarea>' +
          '</div>' +
          '<div id="sm-batch-profiles-wrap" style="display:none;flex-direction:column;gap:8px;">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM2BatchProfilesLabel')) + '</span>' +
            '<div id="sm-batch-profiles-list" style="max-height:180px;overflow-y:auto;border:1px solid var(--glass-border);border-radius:var(--radius-md);padding:8px;display:flex;flex-direction:column;gap:6px;"></div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:10px;">' +
          '<button class="btn btn-ghost" type="button" id="sm-batch-cancel">' + escapeHtml(t('cancel')) + '</button>' +
          '<button class="btn btn-ghost" type="button" id="sm-batch-step1">' + escapeHtml(t('storyM2BatchStep1Btn')) + '</button>' +
          '<button class="btn btn-primary" type="button" id="sm-batch-step2" style="display:none;">' + escapeHtml(t('storyM2BatchStep2Btn')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var close = function() { overlay.remove(); };
    overlay.querySelector('.modal-close-btn').addEventListener('click', close);
    overlay.querySelector('#sm-batch-cancel').addEventListener('click', close);

    overlay.querySelector('#sm-batch-model-btn').addEventListener('click', function() {
      pickModel(textModel, function(m) {
        textModel = m;
        overlay.querySelector('#sm-batch-model-label').textContent = m.label;
      }, 'text');
    });

    var profilesCache = [];

    overlay.querySelector('#sm-batch-step1').addEventListener('click', function() {
      if (!textModel.value) {
        toast(t('trModelRequired'), 'warning');
        return;
      }
      var type = overlay.querySelector('#sm-batch-type').value;
      var count = parseInt(overlay.querySelector('#sm-batch-count')?.value || '3', 10);
      var instruction = overlay.querySelector('#sm-batch-inst').value.trim();

      var s1Btn = overlay.querySelector('#sm-batch-step1');
      s1Btn.disabled = true;
      s1Btn.textContent = t('storyM2BatchStep1Loading');

      currentCtx.api.post('/card-profiles', {
        model: textModel.value,
        type: type,
        count: count,
        instruction: instruction
      }).then(function(res) {
        s1Btn.disabled = false;
        s1Btn.textContent = t('storyM2BatchStep1Regen');
        profilesCache = (res && res.profiles) || [];
        if (profilesCache.length === 0) {
          toast(t('storyM2BatchEmpty'), 'warning');
          return;
        }

        var wrap = overlay.querySelector('#sm-batch-profiles-wrap');
        var list = overlay.querySelector('#sm-batch-profiles-list');
        var s2Btn = overlay.querySelector('#sm-batch-step2');

        wrap.style.display = 'flex';
        s2Btn.style.display = 'inline-flex';

        var pRows = '';
        for (var i = 0; i < profilesCache.length; i++) {
          var p = profilesCache[i];
          pRows += '<div style="padding:6px;background:rgba(255,255,255,0.03);border-radius:4px;font-size:12px;">' +
            '<strong>' + escapeHtml(p.name) + '</strong>: ' + escapeHtml(p.brief) +
          '</div>';
        }
        list.innerHTML = pRows;
        toast(t('storyM2BatchStep1Success'), 'success');
      }).catch(function(err) {
        s1Btn.disabled = false;
        s1Btn.textContent = t('storyM2BatchStep1Btn');
        toast(t('failed') + ': ' + err.message, 'error');
      });
    });

    overlay.querySelector('#sm-batch-step2').addEventListener('click', function() {
      var type = overlay.querySelector('#sm-batch-type').value;
      var instruction = overlay.querySelector('#sm-batch-inst').value.trim();
      var s2Btn = overlay.querySelector('#sm-batch-step2');
      s2Btn.disabled = true;
      s2Btn.textContent = t('storyM2BatchStep2Loading');

      currentCtx.api.post('/generate-cards-batch', {
        model: textModel.value,
        type: type,
        profiles: profilesCache,
        instruction: instruction
      }).then(function(res) {
        var cards = (res && res.cards) || [];
        if (cards.length === 0) {
          toast(t('storyM2BatchEmpty'), 'warning');
          s2Btn.disabled = false;
          return;
        }
        // Save cards into database
        var savePromises = cards.map(function(c) {
          c.bookId = currentCtx.activeBookId;
          c.type = type;
          return currentCtx.api.post('/cards', c);
        });
        return Promise.all(savePromises);
      }).then(function() {
        toast(t('storyM2BatchDone'), 'success');
        close();
        loadData(function() {
          var container = document.getElementById('sm-main-content');
          if (container) drawUI(container);
        });
      }).catch(function(err) {
        s2Btn.disabled = false;
        s2Btn.textContent = t('storyM2BatchStep2Btn');
        toast(t('failed') + ': ' + err.message, 'error');
      });
    });
  }

  // --- ImageModal (AI Image generation & proxy hook) ---
  function openImageModal(card) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = '' +
      '<div class="modal-card" style="width:620px;max-width:95vw;">' +
        '<div class="modal-header">' +
          '<div class="modal-title">' + escapeHtml(t('storyM2ImageModalTitle', [card.name])) + '</div>' +
          '<button class="modal-close-btn">&times;</button>' +
        '</div>' +
        '<div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span class="sm-field-label">' + escapeHtml(t('storySelectImageModel')) + ':</span>' +
            '<button type="button" class="sm-model-btn" id="sm-img-model-btn">' +
              '<span>🖼️</span><span id="sm-img-model-label">' + escapeHtml(imageModel.label) + '</span>' +
            '</button>' +
          '</div>' +

          '<div class="sm-field">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM2ImageIntentLabel')) + '</span>' +
              '<button type="button" class="btn btn-ghost btn-sm" id="sm-img-gen-prompts">' + escapeHtml(t('storyM2ImagePromptGenBtn')) + '</button>' +
            '</div>' +
            '<input type="text" class="input" id="sm-img-intent" value="' + escapeAttr(t('storyM2ImageIntentDefault')) + '">' +
          '</div>' +

          '<div id="sm-img-prompt-candidates" style="display:none;flex-direction:column;gap:6px;">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM2ImageSuggestionsLabel')) + '</span>' +
            '<div id="sm-img-prompts-list" style="display:flex;flex-direction:column;gap:6px;"></div>' +
          '</div>' +

          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM2ImageFinalPromptLabel')) + '</span>' +
            '<textarea class="sm-textarea" id="sm-img-final-prompt" rows="3"></textarea>' +
          '</div>' +

          '<div class="sm-field" style="width:140px;">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM2ImageCountLabel')) + '</span>' +
            renderStepperHtml('sm-img-count', 1, 1, 4) +
          '</div>' +

          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM2ImageExistingLabel', [((card.images && card.images.length) || 0)])) + '</span>' +
            '<div id="sm-img-gallery" style="display:flex;gap:10px;overflow-x:auto;padding:8px;border:1px solid var(--glass-border);border-radius:var(--radius-md);min-height:90px;align-items:center;">' +
              ((card.images && card.images.length) ? '' : '<span style="color:var(--text-secondary);font-size:12px;">' + escapeHtml(t('storyM2ImageNoExisting')) + '</span>') +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="modal-footer" style="display:flex;justify-content:space-between;align-items:center;">' +
          '<button class="btn btn-ghost btn-sm" type="button" id="sm-img-manual-add">' + escapeHtml(t('storyM2ImageAddUrlBtn')) + '</button>' +
          '<div style="display:flex;gap:10px;">' +
            '<button class="btn btn-ghost" type="button" id="sm-img-cancel">' + escapeHtml(t('close')) + '</button>' +
            '<button class="btn btn-primary" type="button" id="sm-img-start-task">' + escapeHtml(t('storyM2ImageStartBtn')) + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var close = function() { overlay.remove(); };
    overlay.querySelector('.modal-close-btn').addEventListener('click', close);
    overlay.querySelector('#sm-img-cancel').addEventListener('click', close);

    overlay.querySelector('#sm-img-model-btn').addEventListener('click', function() {
      pickModel(imageModel, function(m) {
        imageModel = m;
        overlay.querySelector('#sm-img-model-label').textContent = m.label;
      }, 'image');
    });

    // Render current gallery
    var galleryEl = overlay.querySelector('#sm-img-gallery');
    function renderGallery() {
      if (!card.images || card.images.length === 0) {
        galleryEl.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">' + escapeHtml(t('storyM2ImageNoExisting')) + '</span>';
        return;
      }
      var gHtml = '';
      for (var i = 0; i < card.images.length; i++) {
        var im = card.images[i];
        var src = im.url.startsWith('http') ? ('/api/image-proxy?url=' + encodeURIComponent(im.url)) : im.url;
        gHtml += '<div style="position:relative;width:75px;height:75px;flex-shrink:0;border-radius:4px;overflow:hidden;border:1px solid var(--glass-border);">' +
          '<img src="' + escapeHtml(src) + '" style="width:100%;height:100%;object-fit:cover;">' +
          '<button type="button" class="btn btn-danger btn-sm sm-img-del-one" data-idx="' + i + '" style="position:absolute;top:2px;right:2px;padding:1px 4px;font-size:10px;line-height:1;">&times;</button>' +
        '</div>';
      }
      galleryEl.innerHTML = gHtml;
      galleryEl.querySelectorAll('.sm-img-del-one').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var idx = parseInt(btn.dataset.idx, 10);
          card.images.splice(idx, 1);
          currentCtx.api.post('/cards', card).then(function() {
            renderGallery();
            var container = document.getElementById('sm-main-content');
            if (container) drawUI(container);
          });
        });
      });
    }
    renderGallery();

    // Fill initial prompt
    overlay.querySelector('#sm-img-final-prompt').value = (card.name + '，' + (card.description || '')).slice(0, 150);

    // AI derive image prompts
    overlay.querySelector('#sm-img-gen-prompts').addEventListener('click', function() {
      if (!textModel.value) {
        toast(t('storyM2InferPromptTextModelWarning'), 'warning');
        return;
      }
      var intent = overlay.querySelector('#sm-img-intent').value.trim();
      var pBtn = overlay.querySelector('#sm-img-gen-prompts');
      pBtn.disabled = true;
      pBtn.textContent = t('storyM2ImagePromptInferring');

      currentCtx.api.post('/card-image-prompts', {
        model: textModel.value,
        cardDescription: card.name + '：' + (card.description || ''),
        intent: intent,
        count: 3
      }).then(function(res) {
        pBtn.disabled = false;
        pBtn.textContent = t('storyM2ImagePromptGenBtn');
        var prompts = (res && res.prompts) || [];
        if (prompts.length === 0) {
          toast(t('storyM2InferPromptEmpty'), 'warning');
          return;
        }
        var candWrap = overlay.querySelector('#sm-img-prompt-candidates');
        var candList = overlay.querySelector('#sm-img-prompts-list');
        candWrap.style.display = 'flex';
        var html = '';
        for (var i = 0; i < prompts.length; i++) {
          var p = prompts[i];
          html += '<button type="button" class="btn btn-ghost btn-sm sm-img-pick-p" style="text-align:left;white-space:normal;height:auto;padding:6px 10px;" data-p="' + escapeHtml(p.prompt) + '">' +
            '<strong>[' + escapeHtml(p.label || 'Candidate') + ']</strong> ' + escapeHtml(p.prompt) +
          '</button>';
        }
        candList.innerHTML = html;
        candList.querySelectorAll('.sm-img-pick-p').forEach(function(b) {
          b.addEventListener('click', function() {
            overlay.querySelector('#sm-img-final-prompt').value = b.dataset.p;
          });
        });
      }).catch(function(err) {
        pBtn.disabled = false;
        pBtn.textContent = t('storyM2ImagePromptGenBtn');
        toast(t('failed') + ': ' + err.message, 'error');
      });
    });

    // Manual add URL
    overlay.querySelector('#sm-img-manual-add').addEventListener('click', function() {
      var url = prompt(t('storyM2ImagePromptUrlTitle'));
      if (url && url.trim()) {
        if (!card.images) card.images = [];
        card.images.push({
          id: 'img_' + Date.now(),
          url: url.trim(),
          prompt: 'manual',
          createdAt: new Date().toISOString()
        });
        currentCtx.api.post('/cards', card).then(function() {
          toast(t('storyM2ImageAddedSuccess'), 'success');
          renderGallery();
          var container = document.getElementById('sm-main-content');
          if (container) drawUI(container);
        }).catch(function(e) { toast(t('storySaveFail') + ': ' + e.message, 'error'); });
      }
    });

    // Submit image generation task via pgTaskEnqueue
    overlay.querySelector('#sm-img-start-task').addEventListener('click', function() {
      var promptText = overlay.querySelector('#sm-img-final-prompt').value.trim();
      if (!promptText) {
        toast(t('storyM2ImageInputPromptWarning'), 'warning');
        return;
      }
      if (!imageModel.value) {
        toast(t('storyM2ImageSelectModelWarning'), 'warning');
        return;
      }
      var count = parseInt(overlay.querySelector('#sm-img-count')?.value || '1', 10);

      var btn = overlay.querySelector('#sm-img-start-task');
      btn.disabled = true;
      btn.textContent = t('storyM2ImageSubmitting');

      if (typeof pgTaskEnqueue === 'function') {
        try {
          var activeWin = (typeof pgState !== 'undefined' && pgState.activeWin !== undefined) ? pgState.activeWin : 0;
          pgTaskEnqueue(activeWin, promptText, {
            protocol: 'openai',
            model: imageModel.value,
            params: { imgSubmitCount: count }
          });
          toast(t('storyM2ImageTaskEnqueued'), 'success');
          btn.disabled = false;
          btn.textContent = t('storyM2ImageStartBtn');
        } catch (e) {
          btn.disabled = false;
          btn.textContent = t('storyM2ImageStartBtn');
          toast(t('failed') + ': ' + e.message, 'error');
        }
      } else {
        // Fallback: direct call
        fetch('/v1/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: imageModel.value,
            prompt: promptText,
            n: count
          })
        }).then(function(resp) { return resp.json(); }).then(function(data) {
          btn.disabled = false;
          btn.textContent = t('storyM2ImageStartBtn');
          var urls = (data && data.data) || [];
          if (urls.length > 0) {
            if (!card.images) card.images = [];
            for (var u = 0; u < urls.length; u++) {
              if (urls[u].url) {
                card.images.push({
                  id: 'img_' + Date.now() + '_' + u,
                  url: urls[u].url,
                  prompt: promptText,
                  createdAt: new Date().toISOString()
                });
              }
            }
            return currentCtx.api.post('/cards', card).then(function() {
              toast(t('storyM2ImageDoneAttached'), 'success');
              renderGallery();
              var container = document.getElementById('sm-main-content');
              if (container) drawUI(container);
            });
          } else {
            toast(t('storyM2NoValidImageData'), 'warning');
          }
        }).catch(function(err) {
          btn.disabled = false;
          btn.textContent = t('storyM2ImageStartBtn');
         toast(t('failed') + ': ' + err.message, 'error');
       });
      }
    });
  }

  // Lifecycle
  window.storyRenderM2 = render;
  window.storyCleanupM2 = function() {
    if (currentAbort) {
      try { currentAbort.abort(); } catch (e) {}
      currentAbort = null;
    }
  };

})();
