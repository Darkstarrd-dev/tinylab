// web/static/utility/story/story-m3.js — M3 Character Simulation
// Dependency load order:
// vendor/diff.min.js -> utility/editor/editor.js -> editor_textreview_diff.js -> storymaker.js -> story-home.js -> story-m0.js -> story-m2.js -> story-m3.js

(function() {
  'use strict';

  var currentCtx = null;
  var currentAbort = null;
  var simModel = { value: '', label: t('storySelectModel') };

  var scenesCache = [];
  var activeSceneId = '';
  var activeScene = null;
  var characterCards = [];
  var selectedTargetCharId = '';

  var candidates = ['', ''];
  var isSimulating = false;
  var promptOverride = '';

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
      currentCtx.api.get('/scenes?bookId=' + encodeURIComponent(bookId)),
      currentCtx.api.get('/cards?bookId=' + encodeURIComponent(bookId)),
      currentCtx.api.get('/prompts/m3-simulate')
    ]).then(function(results) {
      scenesCache = (results[0] && results[0].scenes) || [];
      var allCards = (results[1] && results[1].cards) || [];
      characterCards = allCards.filter(function(c) { return c.type === 'character'; });
      promptOverride = (results[2] && results[2].content) || '';

      if (!activeSceneId && scenesCache.length > 0) {
        activeSceneId = scenesCache[0].id;
      }
      activeScene = scenesCache.find(function(s) { return s.id === activeSceneId; }) || null;
      if (activeScene && activeScene.presentCharacterIds && activeScene.presentCharacterIds.length > 0) {
        if (!selectedTargetCharId || !activeScene.presentCharacterIds.includes(selectedTargetCharId)) {
          selectedTargetCharId = activeScene.presentCharacterIds[0];
        }
      }
      if (cb) cb();
    }).catch(function(err) {
      console.warn('load m3 data error:', err);
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
      var m = prompt(t('assistantPickModel') + ' (provider/model):', current.value || '');
      if (m) onPick({ value: m, label: m });
    }
  }

  function drawUI(container) {
    var book = currentCtx.getActiveBook();
    var sceneOptions = scenesCache.map(function(s) {
      return { value: s.id, label: '🎬 ' + (s.desc || t('editorUntitled')).slice(0, 24) };
    });
    if (sceneOptions.length === 0) {
      sceneOptions = [{ value: '', label: t('storyM3NoScenes') }];
    }

    var charOptions = [];
    if (activeScene && activeScene.presentCharacterIds) {
      activeScene.presentCharacterIds.forEach(function(cid) {
        var card = characterCards.find(function(c) { return c.id === cid; });
        if (card) {
          charOptions.push({ value: card.id, label: '👤 ' + card.name });
        }
      });
    }
    if (charOptions.length === 0) {
      charOptions = [{ value: '', label: t('storyM3NoChars') }];
    }

    container.innerHTML = '' +
      '<div class="sm-page-container">' +
        '<div class="sm-page-header">' +
          '<div class="sm-page-title">' + escapeHtml(t('storyM3')) + ' <span style="font-size:14px;color:var(--text-secondary);font-weight:normal;">(' + escapeHtml(book.title) + ')</span></div>' +
          '<div class="sm-page-actions">' +
            '<button class="btn btn-primary" type="button" id="sm-m3-btn-new-scene">' + escapeHtml(t('storyM3NewScene')) + '</button>' +
          '</div>' +
        '</div>' +

        // Scene & Target Character Control Card
        '<div class="sm-card">' +
          '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">' +
            '<div style="flex:1;min-width:240px;">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM3CurrentScene')) + '</span>' +
              renderCustomSelectHtml('sm-m3-scene-wrap', 'sm-m3-scene-select', sceneOptions, activeSceneId, null, 'width:100%;height:32px') +
            '</div>' +
            '<div style="flex:1;min-width:200px;">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM3TargetChar')) + '</span>' +
              renderCustomSelectHtml('sm-m3-target-char-wrap', 'sm-m3-target-char-select', charOptions, selectedTargetCharId, null, 'width:100%;height:32px') +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:4px;">' +
              '<span class="sm-field-label">' + escapeHtml(t('storyM3SimModel')) + '</span>' +
              '<button type="button" class="sm-model-btn" id="sm-m3-model-btn">' +
                '<span>🤖</span><span id="sm-m3-model-label">' + escapeHtml(simModel.label) + '</span>' +
              '</button>' +
            '</div>' +
            '<div style="padding-top:20px;">' +
              '<button class="btn btn-primary" type="button" id="sm-m3-btn-simulate" style="padding:8px 20px;">🎭 ' + escapeHtml(t('storyM3StartSim')) + '</button>' +
            '</div>' +
          '</div>' +

          // Scene Details & Foldables
          (activeScene ? '' +
            '<div style="display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:1px solid var(--glass-border);">' +
              '<div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">' +
                '<div><strong>' + escapeHtml(t('storyM3EnvDesc')) + '</strong>' + escapeHtml(activeScene.desc || '—') + '</div>' +
                '<div><strong>' + escapeHtml(t('storyM3Goal')) + '</strong>' + escapeHtml(activeScene.goal || '—') + '</div>' +
                '<div><strong>' + escapeHtml(t('storyM3PrevSummary')) + '</strong>' + escapeHtml(activeScene.prevSummary || '—') + '</div>' +
              '</div>' +
            '</div>' : '') +

          '<details class="sm-prompt-details">' +
            '<summary class="sm-prompt-summary">⚙️ ' + escapeHtml(t('storyM3PromptSettings')) + '</summary>' +
            '<div class="sm-prompt-editor">' +
              '<textarea class="sm-textarea" id="sm-m3-prompt-textarea" rows="4">' + escapeHtml(promptOverride) + '</textarea>' +
              '<button type="button" class="btn btn-ghost btn-sm" id="sm-m3-save-prompt" style="align-self:flex-end;">' + escapeHtml(t('storyM3SavePrompt')) + '</button>' +
            '</div>' +
          '</details>' +
        '</div>' +

        // Candidates Comparison Card
        '<div class="sm-card" id="sm-m3-candidates-card">' +
          '<div style="font-weight:600;font-size:var(--font-base);display:flex;justify-content:space-between;align-items:center;">' +
            '<span>' + escapeHtml(t('storyM3DualCandidates')) + '</span>' +
            (isSimulating ? '<span class="tag tag-blue" style="font-size:11px;">' + escapeHtml(t('storyM3Simulating')) + '</span>' : '') +
          '</div>' +
          '<div class="sm-diff-container" style="min-height:180px;">' +
            '<div class="sm-diff-pane">' +
              '<div class="sm-diff-header" style="display:flex;justify-content:space-between;align-items:center;">' +
                '<span>' + escapeHtml(t('storyM3CandidateA')) + '</span>' +
                '<button type="button" class="btn btn-primary btn-sm" id="sm-m3-adopt-a" style="font-size:11px;">' + escapeHtml(t('storyM3AdoptA')) + '</button>' +
              '</div>' +
              '<div class="sm-diff-body" id="sm-m3-cand-a">' + (candidates[0] ? escapeHtml(candidates[0]) : '<span style="color:var(--text-secondary);">' + escapeHtml(t('storyM3NoCandidateA')) + '</span>') + '</div>' +
            '</div>' +
            '<div class="sm-diff-pane">' +
              '<div class="sm-diff-header" style="display:flex;justify-content:space-between;align-items:center;">' +
                '<span>' + escapeHtml(t('storyM3CandidateB')) + '</span>' +
                '<button type="button" class="btn btn-primary btn-sm" id="sm-m3-adopt-b" style="font-size:11px;">' + escapeHtml(t('storyM3AdoptB')) + '</button>' +
              '</div>' +
              '<div class="sm-diff-body" id="sm-m3-cand-b">' + (candidates[1] ? escapeHtml(candidates[1]) : '<span style="color:var(--text-secondary);">' + escapeHtml(t('storyM3NoCandidateB')) + '</span>') + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Adopted Fragments Sequence
        '<div class="sm-card">' +
          '<div style="font-weight:600;font-size:var(--font-base);">' + escapeHtml(t('storyM3FragmentSequenceTitle')) + '</div>' +
          '<div id="sm-m3-fragments-list" style="display:flex;flex-direction:column;gap:10px;"></div>' +
        '</div>' +
      '</div>';

    // Bind events
    container.querySelector('#sm-m3-scene-select')?.addEventListener('change', function(e) {
      activeSceneId = e.target.value;
      activeScene = scenesCache.find(function(s) { return s.id === activeSceneId; }) || null;
      if (activeScene && activeScene.presentCharacterIds && activeScene.presentCharacterIds.length > 0) {
        selectedTargetCharId = activeScene.presentCharacterIds[0];
      } else {
        selectedTargetCharId = '';
      }
      drawUI(container);
    });

    container.querySelector('#sm-m3-target-char-select')?.addEventListener('change', function(e) {
      selectedTargetCharId = e.target.value;
    });

    container.querySelector('#sm-m3-model-btn')?.addEventListener('click', function() {
      pickModel(simModel, function(m) {
        simModel = m;
        container.querySelector('#sm-m3-model-label').textContent = m.label;
      });
    });

    container.querySelector('#sm-m3-btn-new-scene')?.addEventListener('click', openNewSceneModal);

    container.querySelector('#sm-m3-save-prompt')?.addEventListener('click', function() {
      var val = container.querySelector('#sm-m3-prompt-textarea').value.trim();
      currentCtx.api.put('/prompts/m3-simulate', { content: val }).then(function() {
        promptOverride = val;
        toast(t('storyM3PromptSaved'), 'success');
      });
    });

    // Simulate Trigger
    container.querySelector('#sm-m3-btn-simulate')?.addEventListener('click', function() {
      if (!activeSceneId) {
        toast(t('storyM3SelectSceneWarning'), 'warning');
        return;
      }
      if (!selectedTargetCharId) {
        toast(t('storyM3SelectCharWarning'), 'warning');
        return;
      }
      if (!simModel.value) {
        toast(t('trModelRequired'), 'warning');
        return;
      }

      candidates = ['', ''];
      isSimulating = true;
      var candAEl = container.querySelector('#sm-m3-cand-a');
      var candBEl = container.querySelector('#sm-m3-cand-b');
      candAEl.textContent = t('storyM3Simulating');
      candBEl.textContent = t('storyM3Simulating');

      var simBtn = container.querySelector('#sm-m3-btn-simulate');
      simBtn.disabled = true;

      currentAbort = currentCtx.api.sse('/simulate', {
        model: simModel.value,
        context: {
          bookId: currentCtx.activeBookId,
          sceneId: activeSceneId,
          targetCharacterId: selectedTargetCharId
        },
        candidateCount: 2,
        systemPrompt: promptOverride
      }, function(data) {
        if (typeof data === 'object' && data.candidateIdx !== undefined) {
          var idx = data.candidateIdx;
          candidates[idx] = (candidates[idx] || '') + (data.delta || '');
          if (idx === 0) candAEl.textContent = candidates[0];
          else if (idx === 1) candBEl.textContent = candidates[1];
        }
      }, function() {
        isSimulating = false;
        simBtn.disabled = false;
        toast(t('storyM3SimDone'), 'success');
      }, function(err) {
        isSimulating = false;
        simBtn.disabled = false;
        toast(t('failed') + ': ' + err.message, 'error');
      });
    });

    // Adopt buttons
    container.querySelector('#sm-m3-adopt-a')?.addEventListener('click', function() {
      adoptCandidate(candidates[0]);
    });
    container.querySelector('#sm-m3-adopt-b')?.addEventListener('click', function() {
      adoptCandidate(candidates[1]);
    });

    renderFragmentsList(container);
  }

  function adoptCandidate(text) {
    if (!text || !text.trim()) {
      toast(t('storyM3CandidateEmptyWarning'), 'warning');
      return;
    }
    if (!activeSceneId) return;

    currentCtx.api.get('/fragments?sceneId=' + encodeURIComponent(activeSceneId)).then(function(res) {
      var fragments = (res && res.fragments) || [];
      var nextOrder = fragments.length + 1;
      var frag = {
        id: 'frag_' + Date.now(),
        sceneId: activeSceneId,
        characterId: selectedTargetCharId,
        candidates: [
          { id: 'c1', text: candidates[0] },
          { id: 'c2', text: candidates[1] }
        ],
        adoptedText: text.trim(),
        order: nextOrder
      };
      return currentCtx.api.post('/fragments', frag);
    }).then(function() {
      toast(t('storyM3FragmentAdopted'), 'success');
      var container = document.getElementById('sm-main-content');
      if (container) renderFragmentsList(container);
    }).catch(function(err) {
      toast(t('failed') + ': ' + err.message, 'error');
    });
  }

  function renderFragmentsList(container) {
    var listEl = container.querySelector('#sm-m3-fragments-list');
    if (!listEl) return;
    if (!activeSceneId) {
      listEl.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">' + escapeHtml(t('storyM3SelectSceneWarning')) + '</span>';
      return;
    }

    currentCtx.api.get('/fragments?sceneId=' + encodeURIComponent(activeSceneId)).then(function(res) {
      var fragments = (res && res.fragments) || [];
      if (fragments.length === 0) {
        listEl.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:12px 0;">' + escapeHtml(t('storyM3FragmentEmpty')) + '</div>';
        return;
      }

      var html = '';
      for (var i = 0; i < fragments.length; i++) {
        var f = fragments[i];
        var charCard = characterCards.find(function(c) { return c.id === f.characterId; });
        var charName = charCard ? charCard.name : (t('assistantGroupOther') || 'Unknown');

        html += '<div class="sm-card" style="padding:12px 16px;gap:8px;background:rgba(255,255,255,0.02);">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;">' +
              '<span class="tag tag-blue">#' + f.order + '</span>' +
              '<span>' + escapeHtml(charName) + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:6px;">' +
              '<button type="button" class="btn btn-ghost btn-sm sm-frag-up" data-idx="' + i + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
              '<button type="button" class="btn btn-ghost btn-sm sm-frag-down" data-idx="' + i + '"' + (i === fragments.length - 1 ? ' disabled' : '') + '>↓</button>' +
              '<button type="button" class="btn btn-danger btn-sm sm-frag-del" data-id="' + escapeHtml(f.id) + '">' + escapeHtml(t('delete')) + '</button>' +
            '</div>' +
          '</div>' +
          '<div style="font-size:13px;line-height:1.5;color:var(--text);white-space:pre-wrap;">' + escapeHtml(f.adoptedText) + '</div>' +
        '</div>';
      }
      listEl.innerHTML = html;

      // Event bindings for order / delete
      listEl.querySelectorAll('.sm-frag-del').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var id = btn.dataset.id;
          currentCtx.api.del('/fragments/' + encodeURIComponent(id)).then(function() {
            toast(t('storyM3FragmentDeleted'), 'success');
            renderFragmentsList(container);
          });
        });
      });

      listEl.querySelectorAll('.sm-frag-up').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var idx = parseInt(btn.dataset.idx, 10);
          if (idx > 0) {
            var temp = fragments[idx].order;
            fragments[idx].order = fragments[idx - 1].order;
            fragments[idx - 1].order = temp;
            Promise.all([
              currentCtx.api.post('/fragments', fragments[idx]),
              currentCtx.api.post('/fragments', fragments[idx - 1])
            ]).then(function() {
              renderFragmentsList(container);
            });
          }
        });
      });

      listEl.querySelectorAll('.sm-frag-down').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var idx = parseInt(btn.dataset.idx, 10);
          if (idx < fragments.length - 1) {
            var temp = fragments[idx].order;
            fragments[idx].order = fragments[idx + 1].order;
            fragments[idx + 1].order = temp;
            Promise.all([
              currentCtx.api.post('/fragments', fragments[idx]),
              currentCtx.api.post('/fragments', fragments[idx + 1])
            ]).then(function() {
              renderFragmentsList(container);
            });
          }
        });
      });
    });
  }

  // New Scene Modal
  function openNewSceneModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = '' +
      '<div class="modal-card" style="width:540px;max-width:95vw;">' +
        '<div class="modal-header">' +
          '<div class="modal-title">' + escapeHtml(t('storyM3SceneModalTitle')) + '</div>' +
          '<button class="modal-close-btn">&times;</button>' +
        '</div>' +
        '<div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM3SceneDescLabel')) + '</span>' +
            '<textarea class="sm-textarea" id="sm-sc-desc" rows="3" placeholder="' + escapeAttr(t('storyM3SceneDescPlaceholder')) + '"></textarea>' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM3SceneGoalLabel')) + '</span>' +
            '<input type="text" class="input" id="sm-sc-goal" placeholder="' + escapeAttr(t('storyM3SceneGoalPlaceholder')) + '">' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM3ScenePrevLabel')) + '</span>' +
            '<textarea class="sm-textarea" id="sm-sc-prev" rows="2" placeholder="' + escapeAttr(t('storyM3ScenePrevPlaceholder')) + '"></textarea>' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyM3SceneCharsLabel')) + '</span>' +
            '<div id="sm-sc-chars-list" style="max-height:140px;overflow-y:auto;border:1px solid var(--glass-border);border-radius:var(--radius-md);padding:8px;display:flex;flex-direction:column;gap:4px;"></div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:10px;">' +
          '<button class="btn btn-ghost" type="button" id="sm-sc-cancel">' + escapeHtml(t('cancel')) + '</button>' +
          '<button class="btn btn-primary" type="button" id="sm-sc-save">' + escapeHtml(t('storyM3CreateSceneBtn')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var close = function() { overlay.remove(); };
    overlay.querySelector('.modal-close-btn').addEventListener('click', close);
    overlay.querySelector('#sm-sc-cancel').addEventListener('click', close);

    var charsWrap = overlay.querySelector('#sm-sc-chars-list');
    if (characterCards.length === 0) {
      charsWrap.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">' + escapeHtml(t('storyM3NoCardWarning')) + '</span>';
    } else {
      var cHtml = '';
      for (var i = 0; i < characterCards.length; i++) {
        var card = characterCards[i];
        cHtml += '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">' +
          '<input type="checkbox" class="sm-sc-char-cb" value="' + escapeHtml(card.id) + '"> ' +
          '<span>👤 ' + escapeHtml(card.name) + '</span>' +
        '</label>';
      }
      charsWrap.innerHTML = cHtml;
    }

    overlay.querySelector('#sm-sc-save').addEventListener('click', function() {
      var desc = overlay.querySelector('#sm-sc-desc').value.trim();
      var goal = overlay.querySelector('#sm-sc-goal').value.trim();
      if (!desc || !goal) {
        toast(t('storyM3SceneFillWarning'), 'warning');
        return;
      }
      var prev = overlay.querySelector('#sm-sc-prev').value.trim();
      var presentIds = [];
      overlay.querySelectorAll('.sm-sc-char-cb:checked').forEach(function(cb) {
        presentIds.push(cb.value);
      });

      var newScene = {
        bookId: currentCtx.activeBookId,
        desc: desc,
        goal: goal,
        prevSummary: prev,
        presentCharacterIds: presentIds
      };

      currentCtx.api.post('/scenes', newScene).then(function(saved) {
        toast(t('storyM3SceneCreated'), 'success');
        activeSceneId = saved.id;
        close();
        loadData(function() {
          var container = document.getElementById('sm-main-content');
          if (container) drawUI(container);
        });
      }).catch(function(err) {
        toast(t('storyCreateFail') + ': ' + err.message, 'error');
      });
    });
  }
  }

  // Lifecycle
  window.storyRenderM3 = render;
  window.storyCleanupM3 = function() {
    if (currentAbort) {
      try { currentAbort.abort(); } catch (e) {}
      currentAbort = null;
    }
  };

})();
