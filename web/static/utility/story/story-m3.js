// web/static/utility/story/story-m3.js — M3 Character Simulation
// Dependency load order:
// vendor/diff.min.js -> utility/editor/editor.js -> editor_textreview_diff.js -> storymaker.js -> story-home.js -> story-m0.js -> story-m2.js -> story-m3.js

(function() {
  'use strict';

  var currentCtx = null;
  var currentAbort = null;
  var simModel = { value: '', label: '选择模型' };

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
      var m = prompt('请输入模型 ID (例如 provider/model-name):', current.value || '');
      if (m) onPick({ value: m, label: m });
    }
  }

  function drawUI(container) {
    var book = currentCtx.getActiveBook();
    var sceneOptions = scenesCache.map(function(s) {
      return { value: s.id, label: '🎬 ' + (s.desc || '未命名场景').slice(0, 24) };
    });
    if (sceneOptions.length === 0) {
      sceneOptions = [{ value: '', label: '暂无场景，请先新建' }];
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
      charOptions = [{ value: '', label: '当前场景无在场角色' }];
    }

    container.innerHTML = '' +
      '<div class="sm-page-container">' +
        '<div class="sm-page-header">' +
          '<div class="sm-page-title">' + escapeHtml(t('storyM3')) + ' <span style="font-size:14px;color:var(--text-secondary);font-weight:normal;">(' + escapeHtml(book.title) + ')</span></div>' +
          '<div class="sm-page-actions">' +
            '<button class="btn btn-primary" type="button" id="sm-m3-btn-new-scene">＋ 新建场景</button>' +
          '</div>' +
        '</div>' +

        // Scene & Target Character Control Card
        '<div class="sm-card">' +
          '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">' +
            '<div style="flex:1;min-width:240px;">' +
              '<span class="sm-field-label">当前推演场景：</span>' +
              renderCustomSelectHtml('sm-m3-scene-wrap', 'sm-m3-scene-select', sceneOptions, activeSceneId, null, 'width:100%;height:32px') +
            '</div>' +
            '<div style="flex:1;min-width:200px;">' +
              '<span class="sm-field-label">目标推演角色：</span>' +
              renderCustomSelectHtml('sm-m3-target-char-wrap', 'sm-m3-target-char-select', charOptions, selectedTargetCharId, null, 'width:100%;height:32px') +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:4px;">' +
              '<span class="sm-field-label">推演模型：</span>' +
              '<button type="button" class="sm-model-btn" id="sm-m3-model-btn">' +
                '<span>🤖</span><span id="sm-m3-model-label">' + escapeHtml(simModel.label) + '</span>' +
              '</button>' +
            '</div>' +
            '<div style="padding-top:20px;">' +
              '<button class="btn btn-primary" type="button" id="sm-m3-btn-simulate" style="padding:8px 20px;">🎭 开始角色推演</button>' +
            '</div>' +
          '</div>' +

          // Scene Details & Foldables
          (activeScene ? '' +
            '<div style="display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:1px solid var(--glass-border);">' +
              '<div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">' +
                '<div><strong>环境描述：</strong>' + escapeHtml(activeScene.desc || '—') + '</div>' +
                '<div><strong>推进目标：</strong>' + escapeHtml(activeScene.goal || '—') + '</div>' +
                '<div><strong>前情提要：</strong>' + escapeHtml(activeScene.prevSummary || '—') + '</div>' +
              '</div>' +
            '</div>' : '') +

          '<details class="sm-prompt-details">' +
            '<summary class="sm-prompt-summary">⚙️ 推演 Prompt 设定 (系统预设)</summary>' +
            '<div class="sm-prompt-editor">' +
              '<textarea class="sm-textarea" id="sm-m3-prompt-textarea" rows="4">' + escapeHtml(promptOverride) + '</textarea>' +
              '<button type="button" class="btn btn-ghost btn-sm" id="sm-m3-save-prompt" style="align-self:flex-end;">保存 Prompt 覆盖</button>' +
            '</div>' +
          '</details>' +
        '</div>' +

        // Candidates Comparison Card
        '<div class="sm-card" id="sm-m3-candidates-card">' +
          '<div style="font-weight:600;font-size:var(--font-base);display:flex;justify-content:space-between;align-items:center;">' +
            '<span>双路候选推演结果</span>' +
            (isSimulating ? '<span class="tag tag-blue" style="font-size:11px;">推演中...</span>' : '') +
          '</div>' +
          '<div class="sm-diff-container" style="min-height:180px;">' +
            '<div class="sm-diff-pane">' +
              '<div class="sm-diff-header" style="display:flex;justify-content:space-between;align-items:center;">' +
                '<span>候选 A</span>' +
                '<button type="button" class="btn btn-primary btn-sm" id="sm-m3-adopt-a" style="font-size:11px;">采纳候选 A</button>' +
              '</div>' +
              '<div class="sm-diff-body" id="sm-m3-cand-a">' + (candidates[0] ? escapeHtml(candidates[0]) : '<span style="color:var(--text-secondary);">尚未生成候选 A。</span>') + '</div>' +
            '</div>' +
            '<div class="sm-diff-pane">' +
              '<div class="sm-diff-header" style="display:flex;justify-content:space-between;align-items:center;">' +
                '<span>候选 B</span>' +
                '<button type="button" class="btn btn-primary btn-sm" id="sm-m3-adopt-b" style="font-size:11px;">采纳候选 B</button>' +
              '</div>' +
              '<div class="sm-diff-body" id="sm-m3-cand-b">' + (candidates[1] ? escapeHtml(candidates[1]) : '<span style="color:var(--text-secondary);">尚未生成候选 B。</span>') + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Adopted Fragments Sequence
        '<div class="sm-card">' +
          '<div style="font-weight:600;font-size:var(--font-base);">本场景已采纳推演片段序列 (将作为 M4 章节生成硬约束)</div>' +
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
        toast('Prompt 覆盖已保存', 'success');
      });
    });

    // Simulate Trigger
    container.querySelector('#sm-m3-btn-simulate')?.addEventListener('click', function() {
      if (!activeSceneId) {
        toast('请先选择或新建场景', 'warning');
        return;
      }
      if (!selectedTargetCharId) {
        toast('请选择目标推演角色', 'warning');
        return;
      }
      if (!simModel.value) {
        toast('请先选择推演模型', 'warning');
        return;
      }

      candidates = ['', ''];
      isSimulating = true;
      var candAEl = container.querySelector('#sm-m3-cand-a');
      var candBEl = container.querySelector('#sm-m3-cand-b');
      candAEl.textContent = '推演中...';
      candBEl.textContent = '推演中...';

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
        toast('角色推演完成！', 'success');
      }, function(err) {
        isSimulating = false;
        simBtn.disabled = false;
        toast('推演失败: ' + err.message, 'error');
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
      toast('候选内容为空，无法采纳', 'warning');
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
      toast('片段已采纳并编入序列', 'success');
      var container = document.getElementById('sm-main-content');
      if (container) renderFragmentsList(container);
    }).catch(function(err) {
      toast('采纳失败: ' + err.message, 'error');
    });
  }

  function renderFragmentsList(container) {
    var listEl = container.querySelector('#sm-m3-fragments-list');
    if (!listEl) return;
    if (!activeSceneId) {
      listEl.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">请先选择场景</span>';
      return;
    }

    currentCtx.api.get('/fragments?sceneId=' + encodeURIComponent(activeSceneId)).then(function(res) {
      var fragments = (res && res.fragments) || [];
      if (fragments.length === 0) {
        listEl.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:12px 0;">当前场景尚未采纳任何推演片段。</div>';
        return;
      }

      var html = '';
      for (var i = 0; i < fragments.length; i++) {
        var f = fragments[i];
        var charCard = characterCards.find(function(c) { return c.id === f.characterId; });
        var charName = charCard ? charCard.name : '未知角色';

        html += '<div class="sm-card" style="padding:12px 16px;gap:8px;background:rgba(255,255,255,0.02);">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;">' +
              '<span class="tag tag-blue">片段 #' + f.order + '</span>' +
              '<span>' + escapeHtml(charName) + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:6px;">' +
              '<button type="button" class="btn btn-ghost btn-sm sm-frag-up" data-idx="' + i + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
              '<button type="button" class="btn btn-ghost btn-sm sm-frag-down" data-idx="' + i + '"' + (i === fragments.length - 1 ? ' disabled' : '') + '>↓</button>' +
              '<button type="button" class="btn btn-danger btn-sm sm-frag-del" data-id="' + escapeHtml(f.id) + '">删除</button>' +
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
            toast('已删除片段', 'success');
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
          '<div class="modal-title">🎬 新建推演场景</div>' +
          '<button class="modal-close-btn">&times;</button>' +
        '</div>' +
        '<div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">场景环境描述 *</span>' +
            '<textarea class="sm-textarea" id="sm-sc-desc" rows="3" placeholder="例如：夜色苍茫的荒废酒馆内，壁炉火光微弱..."></textarea>' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">本场景推进目标 *</span>' +
            '<input type="text" class="input" id="sm-sc-goal" placeholder="例如：主角试图套取刺客组织的接头暗号，但对方心生怀疑">' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">前情提要 / 历史摘要</span>' +
            '<textarea class="sm-textarea" id="sm-sc-prev" rows="2" placeholder="发生在此场景之前的前情提要..."></textarea>' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">在场角色选择 (从人物设定卡片中勾选)：</span>' +
            '<div id="sm-sc-chars-list" style="max-height:140px;overflow-y:auto;border:1px solid var(--glass-border);border-radius:var(--radius-md);padding:8px;display:flex;flex-direction:column;gap:4px;"></div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:10px;">' +
          '<button class="btn btn-ghost" type="button" id="sm-sc-cancel">取消</button>' +
          '<button class="btn btn-primary" type="button" id="sm-sc-save">创建场景</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var close = function() { overlay.remove(); };
    overlay.querySelector('.modal-close-btn').addEventListener('click', close);
    overlay.querySelector('#sm-sc-cancel').addEventListener('click', close);

    var charsWrap = overlay.querySelector('#sm-sc-chars-list');
    if (characterCards.length === 0) {
      charsWrap.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">当前作品尚无人物卡片，请先在 M2 创建人物。</span>';
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
        toast('请填写场景描述和推进目标', 'warning');
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
        toast('场景创建成功', 'success');
        activeSceneId = saved.id;
        close();
        loadData(function() {
          var container = document.getElementById('sm-main-content');
          if (container) drawUI(container);
        });
      }).catch(function(err) {
        toast('创建失败: ' + err.message, 'error');
      });
    });
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
