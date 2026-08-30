// demo-designer.js — Game Designer: games-scoped editor + Phaser preview.
// Consumes: EditorLayout (editor_layout.js), edFileExt (editor-state.js),
// __dgames.{idRe,registry,makeHost,loadPhaser,injectScript} (demo-games.js),
// promptModal/confirmModal (app-modal.js), toast/t (api.js+i18n.js),
// global EditorCommands + editor_shell showAiModal reference (for AI) when
// available. The AI path reuses the existing Utility Editor helper that posts
// to /v1/chat/completions, so no new proxy logic is needed here.

(function (global) {
  'use strict';
  if (!global || !global.document) return;
  if (!global.EditorLayout || typeof global.EditorLayout.create !== 'function') return;

  var dgn = {
    layoutRoot: null,
    tree: [],
    selectedId: null,
    current: null,      // {fileId, original}
    originalById: {},
    preview: null,      // {id, handle}
    keyHandler: null,
    ignoreInput: false,
    previewFocused: false,
    previewFsKey: null,
    previewFocusKey: null,
    previewClick: null
  };

  var DGN_SVG = {
    fullscreen: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    folderPlus: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2m-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
    ai: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2L14.39 7.61L20 10L14.39 12.39L12 18L9.61 12.39L4 10L9.61 7.61L12 2ZM6 15l1.19 2.81L10 19l-2.81 1.19L6 23l-1.19-2.81L2 19l2.81-1.19L6 15z"/></svg>',
    example: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 6h8v2H8V6m0 4h8v2H8v-2m0 4h5v2H8v-2M6 4h12c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2m0 2v12h12V6H6z"/></svg>'
  };

  // i18n helper — edT already falls back to window.t.
  function tr(key, fallback) {
    var v;
    try {
      if (typeof global.edT === 'function') v = global.edT(key);
      else if (typeof global.t === 'function') v = global.t(key);
    } catch (e) { v = null; }
    return v || fallback;
  }
  function tstr(key, fallback) { return tr(key, fallback); }

  // Root-param API helper: all editor calls go through ?root=games.
  function edFetch(path, opts) {
    return fetch(path + (path.indexOf('?') >= 0 ? '&' : '?') + 'root=games', opts);
  }

  // Template for a brand-new project (<id>/main.js).
  function mainTemplate(id) {
    return [
      "// " + id + " — minimal game plugin (classic script)",
      "// Host injection: host.container / host.width / host.height / host.phaser / host.saveState / host.loadState",
      "(function () {",
      "  'use strict';",
      "  window.TRGames.register({",
      "    id: '" + id.replace(/'/g, "\\'") + "',",
      "    title: '" + id.replace(/'/g, "\\'") + "',",
      "    launch: function (host) {",
      "      var Phaser = host.phaser;",
      "      if (!Phaser) throw new Error('Phaser not loaded');",
      "      var container = host.container;",
      "      var S = Phaser.Scene;",
      "      var scene = new S('Main');",
      "      scene.init = function () {};",
      "      scene.preload = function () {",
      "        // generateTexture — no external assets required",
      "        var g = this.add.graphics();",
      "        g.fillStyle(0x00d1ff, 1); g.fillRect(0, 0, 28, 28);",
      "        g.generateTexture('box', 28, 28);",
      "        g.destroy();",
      "      };",
      "      scene.create = function () {",
      "        this.player = this.physics.add.sprite(this.scale.width / 2, this.scale.height / 2, 'box');",
      "        this.player.setCollideWorldBounds(true);",
      "        this.cursors = this.input.keyboard.createCursorKeys();",
      "        this.wasd = this.input.keyboard.addKeys('W,A,S,D');",
      "        this._getState = function () {",
      "          return { id: '" + id.replace(/'/g, "\\'") + "', running: true };",
      "        };",
      "        window.__trgame = { game: this.game, getState: this._getState.bind(this) };",
      "      };",
      "      scene.update = function () {",
      "        if (!this.player) return;",
      "        var vx = 0, vy = 0, speed = 220;",
      "        if (this.cursors.left.isDown || this.wasd.A.isDown) vx -= speed;",
      "        if (this.cursors.right.isDown || this.wasd.D.isDown) vx += speed;",
      "        if (this.cursors.up.isDown || this.wasd.W.isDown) vy -= speed;",
      "        if (this.cursors.down.isDown || this.wasd.S.isDown) vy += speed;",
      "        this.player.setVelocity(vx, vy);",
      "      };",
      "      var game = new Phaser.Game({",
      "        type: Phaser.AUTO,",
      "        parent: container,",
      "        width: host.width || 800,",
      "        height: host.height || 450,",
      "        backgroundColor: '#0f172a',",
      "        physics: { default: 'arcade', arcade: { gravity: { y: 0 } } },",
      "        scene: [scene]",
      "      });",
      "      return game;",
      "    }",
      "  };",
      "})();",
      ""
    ].join('\n');
  }

  // Status line helper (both toast and inline).
  function dgnStatus(msg) {
    if (dgn.layoutRoot) {
      var s = dgn.layoutRoot.querySelector('.dgn-status');
      if (s) s.textContent = msg || '';
    }
  }
  function toastInfo(msg) {
    if (typeof global.toast === 'function') global.toast(msg, 'info');
  }
  function toastError(msg) {
    if (typeof global.toast === 'function') global.toast(msg, 'error');
  }

  function escapeHtml(s) {
    if (typeof global.escapeHtml === 'function') return global.escapeHtml(s);
    if (typeof global.edEscapeHtml === 'function') return global.edEscapeHtml(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function inputEl() { return dgn.layoutRoot && dgn.layoutRoot.querySelector('#ed-main-input'); }
  function gutterEl() { return dgn.layoutRoot && dgn.layoutRoot.querySelector('#ed-line-gutter'); }
  function previewHost() { return dgn.layoutRoot && dgn.layoutRoot.querySelector('#ed-main-preview'); }
  function stageEl() { return dgn.layoutRoot && dgn.layoutRoot.querySelector('.dgn-stage'); }

  // Fullscreen: mirror demo-games.js/.ademo same chrome used by Demo→games.
  function dgnIsFullscreen() { return document.body.classList.contains('demo-stage-fullscreen'); }
  function dgnSetFullscreen(on) {
    var will = !!on;
    if (typeof ademoSetFullscreen === 'function') { ademoSetFullscreen(will); return; }
    document.body.classList.toggle('demo-stage-fullscreen', will);
    if (dgn.layoutRoot) dgn.layoutRoot.classList.toggle('dgn-fullscreen', will);
    var stage = stageEl();
    if (stage) stage.classList.toggle('dgn-fullscreen-stage', will);
    if (typeof window.toggleNativeFullscreen === 'function') { try { window.toggleNativeFullscreen(will); } catch (e0) {} }
    try { window.dispatchEvent(new Event('resize')); } catch (e1) {}
  }
  function dgnToggleFullscreen() { dgnSetFullscreen(!dgnIsFullscreen()); }

  // Preview focus: when focused, block other project shortcuts until Esc.
  function enterPreviewFocus() {
    if (dgn.previewFocused) return;
    dgn.previewFocused = true;
    // No layout mutation: focus is a pure input gate. Stage is not moved
    // and body is not overflow-hidden. Only the capture handlers change.
    dgnStatus(tstr('designerPreviewFocused', 'Preview focused — Esc to exit'));
  }
  function exitPreviewFocus() {
    if (!dgn.previewFocused) return;
    dgn.previewFocused = false;
    dgnStatus('');
  }

  // Example bundle — on-demand creation of staged demo projects.
  var EXAMPLE_UNITS = [
    { id: 'Unit01', title: 'Unit01 — Hello Phaser', entry: 'main.js',
      // Minimal Phaser launch; mirrors lessons 01-game-config + 02-scenes.
      main: '/* Unit01 — Hello Phaser */\n/* lesson refs: 01-game-config, 02-scenes, 03-sprites */\n/* open this file, change the color/text below and click Run */\n(function(){\n  \"use strict\";\n  window.TRGames.register({ id: \"Unit01\", title: \"Unit01 — Hello Phaser\", launch: function(host){\n    var Phaser = host.phaser;\n    var S = new (Phaser.Scene)(\"Hello\");\n    S.create = function(){ var w=this.scale.width,h=this.scale.height; this.add.text(w/2,h/2,\"Hello Phaser — edit me\",{fontFamily:\"monospace\",fontSize:\"18px\",color:\"#e8e8e8\"}).setOrigin(0.5); this.add.text(w/2,h/2+22,\"See C:/omp/Phaser lessons 01-03\",{fontFamily:\"monospace\",fontSize:\"11px\",color:\"#8b949e\"}).setOrigin(0.5); };\n    return new Phaser.Game({type:Phaser.AUTO,parent:host.container,width:host.width,height:host.height,backgroundColor:\"#0d1117\",scene:[S]});\n  }});\n})();\n' },
    { id: 'Unit02', title: 'Unit02 — Input & Arcade', entry: 'main.js',
      main: '/* Unit02 — Input & Arcade Physics */\n/* lesson refs: 06-input, 05-physics-arcade, 04-loading */\n(function(){\n  \"use strict\";\n  window.TRGames.register({ id: \"Unit02\", title: \"Unit02 — Input & Arcade\", launch: function(host){\n    var Phaser = host.phaser;\n    var S = Phaser.Scene;\n    var scene = new S(\"Arcade\");\n    scene.create = function(){\n      var w=this.scale.width,h=this.scale.height;\n      this.player=this.physics.add.sprite(w/2,h/2,\"__DEFAULT\");\n      /* generate a texture similar to survivor\\\'s buildTextures */\n      try{ var g=this.add.graphics(); g.fillStyle(0x22c55e,1); g.fillCircle(0,0,14); g.generateTexture(\"__DOT\",28,28); g.destroy(); this.player.setTexture(\"__DOT\"); }catch(e){}\n      this.player.setCollideWorldBounds(true);\n      this.cursors=this.input.keyboard.createCursorKeys();\n      this.wasd=this.input.keyboard.addKeys(\"W,A,S,D\");\n      this.add.text(w/2,14,\"WASD / arrows — see lessons 05, 06\",{fontFamily:\"monospace\",fontSize:\"11px\",color:\"#8b949e\"}).setOrigin(0.5,0);\n    };\n    scene.update=function(){\n      if(!this.player) return;\n      var dx=0,dy=0,sp=220;\n      if(this.cursors.left.isDown||this.wasd.A.isDown) dx-=1;\n      if(this.cursors.right.isDown||this.wasd.D.isDown) dx+=1;\n      if(this.cursors.up.isDown||this.wasd.W.isDown) dy-=1;\n      if(this.cursors.down.isDown||this.wasd.S.isDown) dy+=1;\n      var len=Math.sqrt(dx*dx+dy*dy)||1; this.player.setVelocity(dx/len*sp, dy/len*sp);\n    };\n    return new Phaser.Game({type:Phaser.AUTO,parent:host.container,width:host.width,height:host.height,backgroundColor:\"#0d1117\",physics:{default:\"arcade\",arcade:{gravity:{y:0}}},scene:[scene]});\n  }});\n})();\n' },
    { id: 'Unit03', title: 'Unit03 — Sprites & Tweens', entry: 'main.js',
      main: '/* Unit03 — Sprites, Text, Tweens */\n/* lesson refs: 03-sprites, 07-tweens, 11-text, 18-filters */\n(function(){\n  \"use strict\";\n  window.TRGames.register({ id: \"Unit03\", title: \"Unit03 — Sprites & Tweens\", launch: function(host){\n    var Phaser=host.phaser;\n    var S=new (Phaser.Scene)(\"Tweens\");\n    S.create=function(){ var w=this.scale.width,h=this.scale.height, g=this.add.graphics(); g.fillStyle(0x60a5fa,1); g.fillRect(0,0,28,28); g.generateTexture(\"box\",28,28); g.destroy(); var sp=this.add.sprite(w/2,h/2,\"box\"); this.tweens.add({targets:sp, y:h/2-40, duration:700, yoyo:true, repeat:-1, ease:\"Sine.inOut\"}); this.add.text(w/2,14,\"Tweens — lessons 07, 03, 11\",{fontFamily:\"monospace\",fontSize:\"11px\",color:\"#8b949e\"}).setOrigin(0.5,0); };\n    return new Phaser.Game({type:Phaser.AUTO,parent:host.container,width:host.width,height:host.height,backgroundColor:\"#0d1117\",scene:[S]});\n  }});\n})();\n' },
    { id: 'Unit04', title: 'Unit04 — Particles & Time', entry: 'main.js',
      main: '/* Unit04 — Particles, Time, Events */\n/* lesson refs: 08-particles, 14-time, 15-events */\n(function(){\n  \"use strict\";\n  window.TRGames.register({ id: \"Unit04\", title: \"Unit04 — Particles & Time\", launch: function(host){\n    var Phaser=host.phaser;\n    var S=new (Phaser.Scene)(\"X\");\n    S.create=function(){ var w=this.scale.width,h=this.scale.height; this.add.text(w/2,14,\"Particles & timers — lessons 08, 14, 15\",{fontFamily:\"monospace\",fontSize:\"11px\",color:\"#8b949e\"}).setOrigin(0.5,0); this.time.addEvent({delay:900, loop:true, callback:function(){ try{ var g=this.add.graphics(); g.fillStyle(0xf59e0b,1); g.fillCircle(0,0,4); g.generateTexture(\"p\"+Date.now(),8,8); g.destroy(); var s=this.add.sprite(Phaser.Math.Between(20,w-20),Phaser.Math.Between(30,h-20),\"p\"+(Date.now()-1)); this.tweens.add({targets:s, alpha:0, duration:900, onComplete:function(){ s.destroy(); }});}catch(e){} }, callbackScope:this}); };\n    return new Phaser.Game({type:Phaser.AUTO,parent:host.container,width:host.width,height:host.height,backgroundColor:\"#0d1117\",scene:[S]});\n  }});\n})();\n' },
    { id: 'Unit05', title: 'Unit05 — Scale & Cameras', entry: 'main.js',
      main: '/* Unit05 — Scale & Cameras */\n/* lesson refs: 17-scale, 09-cameras, 12-graphics, 13-groups */\n(function(){\n  \"use strict\";\n  window.TRGames.register({ id: \"Unit05\", title: \"Unit05 — Scale & Cameras\", launch: function(host){\n    var Phaser=host.phaser;\n    var S=new (Phaser.Scene)(\"Cam\");\n    S.create=function(){ var w=this.scale.width,h=this.scale.height; this.cameras.main.setBackgroundColor(\"#111827\"); this.add.rectangle(w/2,h/2,Math.min(w,h)-40,Math.min(w,h)-40,0x1f2937).setStrokeStyle(2,0x4b5563); this.add.text(w/2,14,\"Scale & cameras — lessons 17, 09\",{fontFamily:\"monospace\",fontSize:\"11px\",color:\"#8b949e\"}).setOrigin(0.5,0); };\n    return new Phaser.Game({type:Phaser.AUTO,parent:host.container,width:host.width,height:host.height,backgroundColor:\"#0d1117\",scene:[S]});\n  }});\n})();\n' }
  ];
  function createExampleUnits() {
    var created = 0, skipped = 0, failed = 0;
    // Serialize to keep game.json before main.js per unit (manifest must exist for list).
    var chain = Promise.resolve();
    EXAMPLE_UNITS.forEach(function (u) {
      chain = chain.then(function () {
        return edFetch('/api/editor/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: u.id + '/game.json', content: JSON.stringify({ id: u.id, title: u.title, version: '0.1.0', entry: u.entry }, null, 2) }) })
          .then(function (r) {
            // 200 even if already exists (handler just overwrites); but we skip if file was already present to avoid clobber.
            // Check via tree: we already serialize, so always write — user can delete from explorer.
            return edFetch('/api/editor/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: u.id + '/' + u.entry, content: u.main }) });
          })
          .then(function (r) {
            if (r.ok) created++; else failed++;
          })
          .catch(function () { failed++; });
      });
    });
    return chain.then(function () {
      toastInfo('Example units: ' + created + ' written' + (failed ? ' (' + failed + ' failed)' : ''));
      return dgnLoadTree().then(function () {
        if (dgn.tree && dgn.tree.length) { var first = EXAMPLE_UNITS[0].id + '/' + EXAMPLE_UNITS[0].entry; selectFileOrDir(first); }
      });
    });
  }
  function isInputFocusGlobally() {
    var tag = document.activeElement ? document.activeElement.tagName : '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable);
  }

  // Reuse the existing AI assist from the Utility editor shell when available.
  // Falls back to a minimal prompt→/v1/chat/completions path shared with editor_shell.
  function runAiAssist() {
    var ta = inputEl();
    if (!ta) { toastInfo(tstr('designerSelectProject', 'Select a project first')); return; }
    // Prefer the canonical editor shell's modal if it was loaded (hidden in Designer,
    // the layout hides its button, but the JS is still on the page).
    var hit = false;
    try {
      var overlay = document.getElementById('modal-overlay');
      // editor_shell exposes no global showAiModal; probe known leaf
      if (typeof global.EditorCommands !== 'undefined' && typeof global.EditorCommands.replaceSelection === 'function' && overlay) {
        // Dispatch the same toolbar action the shell uses — action 'ai' is the
        // AI entry; we synthesize it via a transient shell root if needed.
        // Prefer dispatching on the designer input itself: the shell's overlay
        // only reads currentInput().value/selection, so faking that surface is enough.
        // The simplest real reuse: delegate to the hidden shell state when present.
        if (typeof global.showAiModal === 'function') { global.showAiModal(); hit = true; }
      }
    } catch (e) {}
    if (hit) return;
    // Fallback: minimal AI flow (prompt → /v1/chat/completions → insert)
    var selStart = ta.selectionStart || 0, selEnd = ta.selectionEnd || 0;
    var selText = ta.value.slice(selStart, selEnd);
    var isSel = !!(selText && selText.trim());
    var selectedModel = localStorage.getItem('tinyrouter_editor_ai_model') || '';
    // Use the project's model picker if available, else prompt for model once
    if (!selectedModel && typeof window.openModelPickerModal === 'function') {
      window.openModelPickerModal('', function (m) {
        if (m) {
          localStorage.setItem('tinyrouter_editor_ai_model', m);
          runAiAssist();
        } else { toastError(tstr('designerAiNoModel', 'Select a model first')); }
      });
      return;
    }
    if (!selectedModel) { toastError(tstr('designerAiNoModel', 'Select a model first')); return; }
    var prompt = window.prompt(isSel ? tstr('designerAiPromptSel', 'Instruction for selected text:') : tstr('designerAiPrompt', 'AI prompt:'), '');
    if (prompt === null) return;
    prompt = String(prompt).trim();
    if (!prompt) { toastInfo(tstr('designerAiEmpty', 'Prompt is empty')); return; }
    var msgs;
    if (isSel) {
      msgs = [
        { role: 'system', content: '你是一个专业的代码与写作助手。只输出对【选中内容】按【用户指令】修改后的最终文本，不要附加解释。' },
        { role: 'user', content: '【指令】\n' + prompt + '\n\n【选中内容】\n' + selText }
      ];
    } else {
      msgs = [
        { role: 'system', content: '你是一个智能助手。只输出按【用户指令】生成的最终文本。' },
        { role: 'user', content: prompt }
      ];
    }
    dgnStatus(tstr('demoGamesLoading', 'Loading…'));
    fetch('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: selectedModel, messages: msgs, stream: false }) })
      .then(function (r) { if (!r.ok) throw new Error('AI ' + r.status); return r.json(); })
      .then(function (data) {
        var reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!reply) throw new Error('No content');
        if (typeof global.EditorCommands !== 'undefined' && typeof global.EditorCommands.replaceSelection === 'function') {
          global.EditorCommands.replaceSelection(ta, reply);
        } else {
          var before = ta.value.slice(0, selStart), after = ta.value.slice(isSel ? selEnd : selStart);
          var inserted = reply;
          ta.value = before + inserted + after;
          var caret = before.length + inserted.length;
          try { ta.selectionStart = ta.selectionEnd = caret; } catch (e2) {}
        }
        try { if (typeof global.EditorCommands !== 'undefined') global.EditorCommands.record && global.EditorCommands.record(ta); } catch (e3) {}
        updateGutterInner(); updateStatusBar();
        dgnStatus(tstr('designerAiDone', 'AI inserted'));
        toastInfo(tstr('designerAiDone', 'AI inserted'));
      })
      .catch(function (err) { dgnStatus(tstr('designerPreviewError', 'Preview error') + ': ' + (err && err.message || err)); toastError(String(err && err.message || err)); });
  }
  function titleName() {
    if (dgn.current && dgn.current.fileId) {
      var parts = dgn.current.fileId.split('/');
      return parts[parts.length - 1];
    }
    if (dgn.selectedId && dgn.selectedId.indexOf('/') < 0) return dgn.selectedId;
    return null;
  }

  function updateTitle() {
    var name = titleName() || tstr('design', 'Design');
    var dirty = !!dgn.current && dgn.current.original !== (inputEl() ? inputEl().value : '');
    if (global.EditorLayout && typeof global.EditorLayout.updateTitle === 'function') global.EditorLayout.updateTitle(dgn.layoutRoot, name, dirty);
  }

  function updateStatusBar() {
    var ta = inputEl();
    var text = ta ? ta.value : '';
    var pos = 0;
    var line = 1, col = 0;
    if (ta) {
      pos = ta.selectionStart || 0;
      var before = text.slice(0, pos);
      var segments = before.split(/\r?\n/);
      line = segments.length;
      col = segments[segments.length - 1].length;
    }
    var lines = text ? text.split(/\r?\n/).length : 1;
    if (global.EditorLayout && typeof global.EditorLayout.updateStatus === 'function') {
      global.EditorLayout.updateStatus(dgn.layoutRoot, { bytes: text.length, lines: lines, words: 0, line: line, column: col });
    }
    var isDirty = !!(dgn.current && text !== dgn.current.original);
    updateTitle();
    var leftSel = dgn.layoutRoot && dgn.layoutRoot.querySelector('.ed-status-left .ed-status-selection');
    if (leftSel) leftSel.hidden = !isDirty;
  }

  function updateGutterInner() {
    var ta = inputEl(), g = gutterEl();
    if (!g || !ta) return;
    var lines = ta.value.split(/\r?\n/);
    var html = '';
    for (var i = 1; i <= lines.length; i++) html += '<span>' + i + '</span>\n';
    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) html = '<span>1</span>\n';
    g.innerHTML = html;
    g.scrollTop = ta.scrollTop;
  }

  function onInput() {
    if (dgn.ignoreInput) return;
    updateGutterInner();
    updateStatusBar();
  }

  // Tree: build nested nodes from flat /api/editor/tree items (relPath segments).
  function buildNested(items) {
    var folderMap = Object.create(null); // relPath → node
    var roots = [];
    var fileNodes = [];
    (items || []).forEach(function (it) {
      if (!it || !it.relPath) return;
      var rel = String(it.relPath).replace(/\\/g, '/').replace(/^\.\//, '');
      if (!rel || rel.indexOf('..') >= 0) return;
      if (it.isDir) {
        // Directories are represented as folder nodes; expand defaults ON.
        var node = { id: rel, name: it.name || rel.split('/').pop(), type: 'folder', children: [], expanded: true };
        folderMap[rel] = node;
      } else {
        fileNodes.push({ rel: rel, name: it.name || rel.split('/').pop(), size: it.size });
      }
    });
    // Ensure parents for fileNodes exist even if directory entry missing.
    fileNodes.forEach(function (fn) {
      var parts = fn.rel.split('/');
      var dirParts = parts.slice(0, parts.length - 1);
      var cur = '';
      dirParts.forEach(function (seg) {
        cur = cur ? cur + '/' + seg : seg;
        if (!folderMap[cur]) folderMap[cur] = { id: cur, name: seg, type: 'folder', children: [], expanded: true };
      });
    });
    // Parent-link folders.
    var folderRels = Object.keys(folderMap).sort();
    folderRels.forEach(function (rel) {
      var node = folderMap[rel];
      var slash = rel.lastIndexOf('/');
      var parentRel = slash >= 0 ? rel.slice(0, slash) : null;
      if (parentRel && folderMap[parentRel]) folderMap[parentRel].children.push(node);
      else roots.push(node);
    });
    // Insert files under their parent folder.
    fileNodes.forEach(function (fn) {
      var slash = fn.rel.lastIndexOf('/');
      var parentRel = slash >= 0 ? fn.rel.slice(0, slash) : null;
      var fileNode = { id: fn.rel, name: fn.name, type: 'file', size: fn.size };
      if (parentRel && folderMap[parentRel]) folderMap[parentRel].children.push(fileNode);
      else roots.push(fileNode);
    });
    // Sort: folders first inside each level, alphabetical.
    function sortNode(node) {
      if (!node.children) return;
      node.children.sort(function (a, b) {
        var fa = a.type === 'folder' ? 0 : 1, fb = b.type === 'folder' ? 0 : 1;
        if (fa !== fb) return fa - fb;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
      node.children.forEach(sortNode);
    }
    roots.sort(function (a, b) {
      var fa = a.type === 'folder' ? 0 : 1, fb = b.type === 'folder' ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    roots.forEach(sortNode);
    return roots;
  }

  function dgnLoadTree() {
    return edFetch('/api/editor/tree', { method: 'GET' })
      .then(function (r) { if (!r.ok) throw new Error('tree -> ' + r.status); return r.json(); })
      .then(function (data) {
        var files = (data && (data.files || data.docs)) || [];
        dgn.tree = buildNested(files);
        var treeEl = dgn.layoutRoot && dgn.layoutRoot.querySelector('#ed-file-tree');
        if (treeEl && global.EditorLayout && typeof global.EditorLayout.renderTree === 'function') {
          global.EditorLayout.renderTree(treeEl, dgn.tree, { selectedId: dgn.selectedId }, hooksRef);
        }
      })
      .catch(function (e) { dgnStatus(tstr('designerPreviewError', 'Load error') + ': ' + (e && e.message || e)); });
  }

  var hooksRef = {};

  function selectFileOrDir(fileId) {
    var isDir = false;
    // Quick dir check: no dot in last segment or node type in tree is folder.
    // Also: has no extension and isn't selecting a known file.
    (function findDir(nodes) {
      for (var i = 0; i < (nodes || []).length; i++) {
        if (nodes[i].id === fileId && nodes[i].type === 'folder') { isDir = true; return; }
        if (nodes[i].children) findDir(nodes[i].children);
      }
    })(dgn.tree);
    // Fallback: extension heuristic
    if (!isDir) {
      var last = fileId.split('/').pop();
      if (last.indexOf('.') < 0) {
        // Check flat membership without dot — treat as folder if no exact file node.
        var hasExactFile = false;
        (function findFile(nodes) {
          for (var i = 0; i < (nodes || []).length; i++) {
            if (nodes[i].id === fileId && nodes[i].type === 'file') hasExactFile = true;
            if (nodes[i].children) findFile(nodes[i].children);
          }
        })(dgn.tree);
        if (!hasExactFile) isDir = true;
      }
    }
    dgn.selectedId = fileId;
    var treeEl = dgn.layoutRoot && dgn.layoutRoot.querySelector('#ed-file-tree');
    if (treeEl && global.EditorLayout && typeof global.EditorLayout.renderTree === 'function') {
      global.EditorLayout.renderTree(treeEl, dgn.tree, { selectedId: fileId }, hooksRef);
    }
    if (isDir) {
      dgnStatus('');
      updateTitle();
      return;
    }
    return dgnOpen(fileId);
  }

  function dgnOpen(fileId) {
    dgnStatus('');
    return edFetch('/api/editor/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: fileId }) })
      .then(function (r) {
        if (!r.ok) throw new Error('open -> ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.not_found) { dgnStatus(tstr('designerPreviewError', 'Not found')); return; }
        var content = data && typeof data.content === 'string' ? data.content : '';
        var fid = (data && data.fileId) || fileId;
        dgn.current = { fileId: fid, original: content };
        dgn.originalById[fid] = content;
        dgn.selectedId = fid;
        var treeEl = dgn.layoutRoot && dgn.layoutRoot.querySelector('#ed-file-tree');
        if (treeEl && global.EditorLayout && typeof global.EditorLayout.renderTree === 'function') {
          global.EditorLayout.renderTree(treeEl, dgn.tree, { selectedId: fid }, hooksRef);
        }
        var ta = inputEl();
        if (ta) {
          dgn.ignoreInput = true;
          ta.value = content;
          ta.focus();
          dgn.ignoreInput = false;
        }
        updateGutterInner();
        updateStatusBar();
        updateTitle();
      })
      .catch(function (e) { dgnStatus(tstr('designerPreviewError', 'Error') + ': ' + (e && e.message || e)); });
  }

  function dgnSave() {
    if (!dgn.current || !dgn.current.fileId) {
      dgnStatus(tstr('designerSelectProject', 'Select a file first'));
      toastInfo(tstr('designerSelectProject', 'Select a file first'));
      return Promise.resolve();
    }
    var ta = inputEl();
    var content = ta ? ta.value : '';
    var fid = dgn.current.fileId;
    return edFetch('/api/editor/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: fid, content: content }) })
      .then(function (r) {
        if (!r.ok) throw new Error('save -> ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.ok === false) throw new Error((data && data.error) || 'save failed');
        dgn.current.original = content;
        dgn.originalById[fid] = content;
        updateTitle();
        updateStatusBar();
        dgnStatus(tstr('designerSaved', 'Saved'));
        toastInfo(tstr('designerSaved', 'Saved'));
      })
      .catch(function (e) { dgnStatus(tstr('designerPreviewError', 'Error') + ': ' + (e && e.message || e)); toastError(String(e && e.message || e)); });
  }

  function dgnNewFile() {
    var dir = null;
    if (dgn.current && dgn.current.fileId) dir = dgn.current.fileId.split('/').slice(0, 1).join('/');
    if (!dir && dgn.selectedId) {
      var s = dgn.selectedId;
      dir = s.indexOf('/') >= 0 ? s.split('/')[0] : s;
    }
    if (!dir) { dgnStatus(tstr('designerSelectProject', 'Select a project first')); toastInfo(tstr('designerSelectProject', 'Select a project first')); return; }
    var prompt = global.promptModal || function () { return Promise.resolve(null); };
    return prompt(tstr('designerFileNamePrompt', 'File name (e.g. assets/foo.js)'), '', 'main.js').then(function (name) {
      if (!name) return;
      name = String(name).trim();
      if (!name || name === '.' || name === '..' || /[\\:*?"<>|]/.test(name)) {
        toastError(tstr('designerPreviewError', 'Invalid filename'));
        return;
      }
      // Allow subpaths like assets/x.js — reject traversal.
      if (name.indexOf('..') >= 0 || name.indexOf('//') >= 0 || name.replace(/^\//, '') !== name) {
        toastError(tstr('designerPreviewError', 'Invalid path'));
        return;
      }
      var fileId = dir + '/' + name.replace(/^\.?\//, '');
      return edFetch('/api/editor/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: fileId, content: '' }) })
        .then(function (r) {
          if (!r.ok) throw new Error('create file -> ' + r.status);
          return r.json();
        })
        .then(function () { return dgnLoadTree().then(function () { return dgnOpen(fileId); }); })
        .catch(function (e) { toastError(String(e && e.message || e)); });
    });
  }

  function dgnNewProject() {
    var prompt = global.promptModal || function () { return Promise.resolve(null); };
    return prompt(tstr('designerProjectIdPrompt', 'Game id (a-z, 0-9, -, _)'), '', '').then(function (id) {
      if (!id) return;
      id = String(id).trim();
      var re = (global.__dgames && global.__dgames.idRe) || /^[A-Za-z0-9_-]{1,64}$/;
      if (!re.test(id)) { toastError(tstr('designerPreviewError', 'Invalid id: ' + id)); return; }
      var manifest = JSON.stringify({ id: id, title: id, version: '0.1.0', entry: 'main.js' }, null, 2);
      var mainSrc = mainTemplate(id);
      return edFetch('/api/editor/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: id + '/game.json', content: manifest }) })
        .then(function (r) {
          if (!r.ok) throw new Error('create game.json -> ' + r.status);
          return r.json();
        })
        .then(function () {
          return edFetch('/api/editor/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: id + '/main.js', content: mainSrc }) });
        })
        .then(function (r) {
          if (!r.ok) throw new Error('create main.js -> ' + r.status);
          return r.json();
        })
        .then(function () {
          if (typeof global.toast === 'function') global.toast(tstr('designerSaved', 'Created'), 'success');
          return dgnLoadTree().then(function () { return dgnOpen(id + '/main.js'); });
        })
        .catch(function (e) { toastError(String(e && e.message || e)); dgnLoadTree(); });
    });
  }

  function dgnDelete() {
    if (!dgn.selectedId) { toastInfo(tstr('designerSelectProject', 'Select a file or project')); return Promise.resolve(); }
    var id = dgn.selectedId;
    var isProject = false;
    (function find(nodes) {
      for (var i = 0; i < (nodes || []).length; i++) {
        if (nodes[i].id === id && nodes[i].type === 'folder') isProject = true;
        if (nodes[i].children) find(nodes[i].children);
      }
    })(dgn.tree);
    // Empty games/ edge: top-level dir may not be in tree as folder node if probe failed; fallback on slash heuristic.
    if (!isProject && id.indexOf('/') < 0) {
      // No slash → treat as project dir probe.
      isProject = true;
    }
    var confirm = global.confirmModal || function () { return Promise.resolve(false); };
    var msgKey = isProject ? 'designerDeleteProjectConfirm' : 'designerDeleteFileConfirm';
    var msg = tstr(msgKey, isProject ? 'Delete project ' + id + ' and all its files?' : 'Delete file ' + id + '?');
    return confirm(msg).then(function (ok) {
      if (!ok) return;
      // If deleting the currently previewed project, stop preview first.
      if (dgn.preview && dgn.preview.id === id.split('/')[0]) dgnPreviewStop();
      return edFetch('/api/editor/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: id }) })
        .then(function (r) {
          if (!r.ok) throw new Error('delete -> ' + r.status);
          return r.json();
        })
        .then(function (data) {
          if (data && data.ok === false) throw new Error((data && data.error) || 'delete failed');
          if (dgn.current && dgn.current.fileId === id) {
            dgn.current = null;
            var ta = inputEl();
            if (ta) { dgn.ignoreInput = true; ta.value = ''; dgn.ignoreInput = false; updateGutterInner(); updateStatusBar(); updateTitle(); }
          }
          if (dgn.current && dgn.current.fileId && dgn.current.fileId.indexOf(id + '/') === 0) {
            dgn.current = null;
            var ta2 = inputEl();
            if (ta2) { dgn.ignoreInput = true; ta2.value = ''; dgn.ignoreInput = false; updateGutterInner(); updateStatusBar(); updateTitle(); }
          }
          dgn.selectedId = null;
          dgnStatus('');
          return dgnLoadTree();
        })
        .catch(function (e) { toastError(String(e && e.message || e)); });
    });
  }

  // Phaser preview.
  function currentProjectId() {
    if (dgn.current && dgn.current.fileId) return dgn.current.fileId.split('/')[0];
    if (dgn.selectedId) return dgn.selectedId.split('/')[0];
    return null;
  }

  function dgnPreviewStop() {
    if (!dgn.preview) return;
    var h = dgn.preview.handle;
    dgn.preview = null;
    try {
      if (h && typeof h.destroy === 'function') h.destroy(true);
      else if (h && typeof h.dispose === 'function') h.dispose();
    } catch (e) {}
    var st = stageEl();
    if (st) st.innerHTML = '';
    dgnStatus('');
  }

  function dgnPreviewRun() {
    var id = currentProjectId();
    if (!id) { dgnStatus(tstr('designerSelectProject', 'Select a project first')); toastInfo(tstr('designerSelectProject', 'Select a project first')); return Promise.resolve(); }
    var seam = global.__dgames;
    if (!seam || typeof seam.loadPhaser !== 'function' || typeof seam.injectScript !== 'function' || typeof seam.makeHost !== 'function') {
      dgnStatus(tstr('designerPreviewError', 'Game host not available'));
      return Promise.resolve();
    }
    var ta = inputEl();
    var currentTextById = dgn.current ? dgn.originalById : null;
    // Resolve manifest entry and source — prefer in-memory textarea values for the entry being edited.
    var entryName = 'main.js';
    var entrySrcPromise;
    // Try to resolve entry: if game.json open, parse it; else fetch it from disk.
    var gameJsonId = id + '/game.json';
    var manifestEntry = null;
    if (dgn.current && dgn.current.fileId === gameJsonId && ta && dgn.current.original !== undefined) {
      try {
        var parsed = JSON.parse(ta.value);
        if (parsed && typeof parsed.entry === 'string' && parsed.entry) manifestEntry = parsed.entry;
      } catch (ignored) {}
    }
    if (manifestEntry) entryName = manifestEntry;
    else {
      // No manifest entry from in-memory; probing disk (will be used after).
    }
    var entryId = id + '/' + entryName;
    var hasEntryOpen = dgn.current && dgn.current.fileId === entryId;
    if (hasEntryOpen && ta) {
      entrySrcPromise = Promise.resolve(ta.value);
    } else if (!manifestEntry) {
      // Fetch manifest from disk to learn entry, then fetch entry file.
      entrySrcPromise = fetch('/games/' + encodeURIComponent(id) + '/game.json', { cache: 'no-store' })
        .then(function (r) {
          if (r.ok) return r.json().then(function (j) { entryName = (j && j.entry) || 'main.js'; entryId = id + '/' + entryName; return null; }).catch(function () { return null; });
          return null;
        })
        .then(function () {
          if (dgn.current && dgn.current.fileId === entryId && ta) return ta.value;
          return fetch('/games/' + encodeURIComponent(id) + '/' + entryName.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('entry fetch -> ' + r.status); return r.text(); });
        });
    } else {
      entrySrcPromise = fetch('/games/' + encodeURIComponent(id) + '/' + entryName.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('entry fetch -> ' + r.status); return r.text(); });
    }

    dgnStatus(tstr('demoGamesLoading', 'Loading\u2026'));
    return entrySrcPromise
      .then(function (src) {
        if (!src || !String(src).trim()) throw new Error('entry is empty');
        return seam.loadPhaser().then(function () { return src; });
      })
      .then(function (src) {
        // Delete prior registry entry (reload semantics — mirrors dg-reload flow).
        if (seam.registry && seam.registry[id]) delete seam.registry[id];
        // Prefer disk reload when the entry was not being edited in-memory;
        // disk URLs are CSP-safe and avoid blob: edge cases.
        var isInMemory = hasEntryOpen;
        if (!isInMemory) {
          var v = Date.now();
          var diskSrc = '/games/' + encodeURIComponent(id) + '/' + entryName.split('/').map(encodeURIComponent).join('/') + '?v=' + v;
          return seam.injectScript(diskSrc).then(function () {
            if (!seam.registry || !seam.registry[id]) throw new Error('game "' + id + '" did not call TRGames.register');
            var def = seam.registry[id].def;
            dgnPreviewStop();
            var stage = stageEl();
            if (!stage) throw new Error('preview stage not rendered');
            stage.innerHTML = '';
            var handle = def.launch(seam.makeHost(id, stage));
            dgn.preview = { id: id, handle: handle || null };
            dgnStatus('');
          });
        }
        // In-memory edit: inject via Blob URL (CSP now allows blob:) with
        // inline text fallback if the blob script fails to parse/load.
        var blob = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        return seam.injectScript(blob).then(function () {
          try { URL.revokeObjectURL(blob); } catch (ignored) {}
          if (!seam.registry || !seam.registry[id]) throw new Error('game "' + id + '" did not call TRGames.register');
          var def = seam.registry[id].def;
          dgnPreviewStop();
          var stage = stageEl();
          if (!stage) throw new Error('preview stage not rendered');
          stage.innerHTML = '';
          var handle = def.launch(seam.makeHost(id, stage));
          dgn.preview = { id: id, handle: handle || null };
          dgnStatus('');
        }, function (blobErr) {
          try { URL.revokeObjectURL(blob); } catch (ignored) {}
          // Blob blocked or parse error: fall back to inline evaluation.
          try {
            // eslint-disable-next-line no-eval
            (1, eval)(src + '\n//# sourceURL=designer-preview://' + id + '/' + entryName);
            if (!seam.registry || !seam.registry[id]) throw new Error('game "' + id + '" did not call TRGames.register');
            var def2 = seam.registry[id].def;
            dgnPreviewStop();
            var stage2 = stageEl();
            if (!stage2) throw new Error('preview stage not rendered');
            stage2.innerHTML = '';
            var handle2 = def2.launch(seam.makeHost(id, stage2));
            dgn.preview = { id: id, handle: handle2 || null };
            dgnStatus('');
            return;
          } catch (evalErr) {
            throw blobErr;
          }
        });
      })
      .catch(function (err) {
        dgnStatus(tstr('designerPreviewError', 'Preview error') + ': ' + (err && err.message || String(err)));
      });
  }

  function render(container) {
    cleanup();
    if (!container) return;
    if (!global.EditorLayout || typeof global.EditorLayout.create !== 'function') {
      container.innerHTML = '<div style="padding:12px;color:var(--danger)">EditorLayout not available</div>';
      return;
    }

    hooksRef = {
      action: function (action) {
        if (action === 'save') dgnSave();
        else if (action === 'new-file') dgnNewFile();
        else if (action === 'new-folder') dgnNewProject();
      },
      open: function () {
        // Header Open is hidden via CSS (.ed-action-open); disable picker flow.
        toastInfo(tstr('designerSelectProject', 'Select a project or file in the tree'));
      },
      save: function () { dgnSave(); },
      selectFile: function (fileId) { selectFileOrDir(fileId); },
      toggleTree: function (nodeId) {
        // Toggle expanded on matching folder; re-render.
        (function toggle(nodes) {
          for (var i = 0; i < (nodes || []).length; i++) {
            if (nodes[i].id === nodeId) { nodes[i].expanded = !nodes[i].expanded; return true; }
            if (nodes[i].children && toggle(nodes[i].children)) return true;
          }
          return false;
        })(dgn.tree);
        var treeEl = dgn.layoutRoot && dgn.layoutRoot.querySelector('#ed-file-tree');
        if (treeEl && global.EditorLayout && typeof global.EditorLayout.renderTree === 'function') {
          global.EditorLayout.renderTree(treeEl, dgn.tree, { selectedId: dgn.selectedId }, hooksRef);
        }
      },
      toggle: function (name) {
        if (name === 'preview' && global.EditorLayout && typeof global.EditorLayout.setPreview === 'function') {
          var on = !dgn.layoutRoot.classList.contains('is-preview');
          global.EditorLayout.setPreview(dgn.layoutRoot, on);
        } else if (name === 'reader' && global.EditorLayout && typeof global.EditorLayout.setReader === 'function') {
          var on2 = !dgn.layoutRoot.classList.contains('is-reader');
          global.EditorLayout.setReader(dgn.layoutRoot, on2);
        } else if (name === 'explorer' && global.EditorLayout && typeof global.EditorLayout.setExplorer === 'function') {
          var hidden = dgn.layoutRoot.classList.contains('is-explorer-hidden');
          global.EditorLayout.setExplorer(dgn.layoutRoot, hidden);
          if (typeof global.EditorLayout.updateExplorerToggleIcon === 'function') {
            try { global.EditorLayout.updateExplorerToggleIcon(dgn.layoutRoot, !hidden); } catch (e) {}
          }
        }
      }
    };

    dgn.layoutRoot = global.EditorLayout.create(container, { tree: dgn.tree }, hooksRef);
    if (!dgn.layoutRoot) return;
    dgn.layoutRoot.classList.add('dgn-root');
    // Ensure Toggle Explorer icon reflects initial (expanded) state.
    if (typeof global.EditorLayout.updateExplorerToggleIcon === 'function') {
      try { global.EditorLayout.updateExplorerToggleIcon(dgn.layoutRoot, true); } catch (e0) {}
    }

    // Transform preview surface into Phaser stage.
    var preview = previewHost();
    if (preview) {
      preview.innerHTML = '<div class="dgn-stage"></div><div class="dgn-status"></div><button type="button" class="dgn-preview-fs" aria-label="' + escapeHtml(tstr('demoEnterFullscreen', 'Enter fullscreen')) + '" data-tooltip="' + escapeHtml(tstr('demoEnterFullscreen', 'Enter fullscreen')) + '">' + DGN_SVG.fullscreen + '</button><button type="button" class="dgn-preview-focus" data-tooltip="' + escapeHtml(tstr('designerPreviewFocus', 'Focus preview')) + '" aria-label="' + escapeHtml(tstr('designerPreviewFocus', 'Focus preview')) + '">⛶</button>';
    }
    // Default split view.
    if (global.EditorLayout && typeof global.EditorLayout.setPreview === 'function') {
      global.EditorLayout.setPreview(dgn.layoutRoot, true);
    }
    // Retext status tags.
    var leftTag = dgn.layoutRoot.querySelector('.ed-status-left .ed-status-tag');
    if (leftTag) leftTag.textContent = 'JS';
    var hide = dgn.layoutRoot.querySelector('.ed-status-right');
    if (hide) hide.style.display = 'none';

    // Append extra explorer buttons (SVG + tooltip, like the main toolbar).
    var expActions = dgn.layoutRoot.querySelector('.ed-explorer-actions');
    if (expActions) {
      function svgBtn(svg, tipKey, fallback, cls) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ed-button ed-button-icon-only ' + cls;
        var tip = tstr(tipKey, fallback);
        b.setAttribute('aria-label', tip);
        b.setAttribute('data-tooltip', tip);
        var sp = document.createElement('span');
        sp.className = 'ed-button-icon';
        sp.innerHTML = svg;
        b.appendChild(sp);
        return b;
      }
      var newProjectBtn = svgBtn(DGN_SVG.folderPlus, 'designerNewProject', 'New Project', 'dgn-new-project');
      newProjectBtn.addEventListener('click', dgnNewProject);
      expActions.appendChild(newProjectBtn);
      var deleteBtn = svgBtn(DGN_SVG.trash, 'designerDelete', 'Delete', 'dgn-delete');
      deleteBtn.addEventListener('click', dgnDelete);
      expActions.appendChild(deleteBtn);
    }

    // Append preview controls into navigation actions.
    var navActions = dgn.layoutRoot.querySelector('.ed-navigation-actions') || dgn.layoutRoot.querySelector('.ed-navigation');
    if (navActions) {
      var ctrl = document.createElement('div');
      ctrl.className = 'dgn-controls';
      ['Run', 'Stop', 'Reload'].forEach(function (label) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn' + (label === 'Run' ? ' dgn-run' : (label === 'Stop' ? ' btn-ghost dgn-stop' : ' btn-ghost dgn-reload'));
        if (label === 'Run') b.textContent = tstr('designerRun', 'Run');
        else if (label === 'Stop') b.textContent = tstr('designerStop', 'Stop');
        else b.textContent = tstr('designerReload', 'Reload');
        if (label === 'Run') b.addEventListener('click', dgnPreviewRun);
        else if (label === 'Stop') b.addEventListener('click', dgnPreviewStop);
        else b.addEventListener('click', dgnPreviewRun);
        ctrl.appendChild(b);
      });
      navActions.appendChild(ctrl);
    }

    // AI Assist alongside Collapse Explorer — main text-editor header (view actions row).
      viewActions = dgn.layoutRoot.querySelector('.ed-view-actions');
    if (viewActions) {
      (function addHeaderButtons() {
        function headerIconBtn(svg, tipKey, fallback, cls, handler) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'ed-button ed-button-icon-only ' + cls;
          var tip = tstr(tipKey, fallback);
          b.setAttribute('aria-label', tip);
          b.setAttribute('data-tooltip', tip);
          var sp = document.createElement('span');
          sp.className = 'ed-button-icon';
          sp.innerHTML = svg;
          b.appendChild(sp);
          b.addEventListener('click', handler);
          viewActions.appendChild(b);
    }
        headerIconBtn(DGN_SVG.example, 'designerExampleUnits', 'Example units', 'dgn-example-units', createExampleUnits);
        headerIconBtn(DGN_SVG.ai, 'editorAI', 'AI Assist', 'dgn-ai-header', runAiAssist);
      })();
    }

    // Preview chrome handlers: fullscreen + focus.
    var fsBtn = preview && preview.querySelector('.dgn-preview-fs');
    if (fsBtn) fsBtn.addEventListener('click', function () { dgnToggleFullscreen(); this.blur(); });
    var focusBtn = preview && preview.querySelector('.dgn-preview-focus');
    if (focusBtn) focusBtn.addEventListener('click', function () { if (dgn.previewFocused) exitPreviewFocus(); else enterPreviewFocus(); this.blur(); });
    var stage = stageEl();
    if (stage) {
      dgn.previewClick = function () { enterPreviewFocus(); };
      stage.addEventListener('click', dgn.previewClick);
      // Double-click the stage also toggles focus.
      stage.addEventListener('dblclick', function () { if (dgn.previewFocused) exitPreviewFocus(); else enterPreviewFocus(); });
    }

    // Bind editor inputs.
    var ta = inputEl();
    if (ta) {
      ta.addEventListener('input', onInput);
      ta.addEventListener('keyup', function () { updateStatusBar(); });
      ta.addEventListener('click', function () { updateStatusBar(); });
      ta.addEventListener('scroll', function () { var g = gutterEl(); if (g) g.scrollTop = ta.scrollTop; });
      // Ctrl+S save + Ctrl+ + fullscreen. Keep focus isolation: when preview is focused,
      // Esc must exit focus first before any other shortcut fires.
      dgn.keyHandler = function (e) {
        if (dgn.previewFocused) {
          if (e.key === 'Escape') {
            e.preventDefault(); e.stopImmediatePropagation();
            exitPreviewFocus();
            return;
          }
          // In focus, suppress project shortcuts; let game keys through to canvas
          // by returning without handling (capture game listeners still run).
          return;
        }
        if (dgnIsFullscreen()) {
          if (e.key === 'Escape') {
            e.preventDefault(); e.stopImmediatePropagation();
            dgnSetFullscreen(false);
            return;
          }
          var isCtrlF = (e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
          if (isCtrlF) {
            e.preventDefault(); e.stopImmediatePropagation();
            dgnSetFullscreen(false);
            return;
          }
          // Let game keys pass; suppress project nav below by returning.
          return;
        }
        var isCtrlPlus = (e.key === '+' || e.key === '=' || (e.code && e.code === 'Equal')) && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
        if (isCtrlPlus) {
          e.preventDefault(); e.stopImmediatePropagation();
          // Ignore when typing
          var tag = document.activeElement && document.activeElement.tagName;
          var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable);
          if (typing) return;
          dgnToggleFullscreen();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
          e.preventDefault();
          e.stopPropagation();
          dgnSave();
        }
      };
      document.addEventListener('keydown', dgn.keyHandler, true);
      // Separate capture for Esc when focus is on the stage element itself.
      dgn.previewFocusKey = function (e) {
        if (dgn.previewFocused && e.key === 'Escape') {
          e.preventDefault(); e.stopImmediatePropagation();
          exitPreviewFocus();
        }
      };
      document.addEventListener('keydown', dgn.previewFocusKey, true);
      dgn.previewFsKey = function (e) {
        var isCtrlPlus = (e.key === '+' || e.key === '=' || (e.code && e.code === 'Equal')) && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
        if (!isCtrlPlus) return;
        var tag = document.activeElement && document.activeElement.tagName;
        var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable);
        if (typing) return;
        if (dgn.previewFocused || dgnIsFullscreen()) return; // already handled above
        e.preventDefault(); e.stopImmediatePropagation();
        dgnToggleFullscreen();
      };
      document.addEventListener('keydown', dgn.previewFsKey);
      updateGutterInner();
      updateStatusBar();
    }

    // Title.
    if (global.EditorLayout && typeof global.EditorLayout.updateTitle === 'function') {
      global.EditorLayout.updateTitle(dgn.layoutRoot, tstr('design', 'Design'), false);
    }

    dgnStatus('');
    dgnLoadTree();
  }

  function cleanup() {
    if (dgn.previewFsKey) { try { document.removeEventListener('keydown', dgn.previewFsKey); } catch (e0) {} dgn.previewFsKey = null; }
    if (dgn.previewFocusKey) { try { document.removeEventListener('keydown', dgn.previewFocusKey, true); } catch (e1) {} dgn.previewFocusKey = null; }
    if (dgn.keyHandler) {
      document.removeEventListener('keydown', dgn.keyHandler, true);
      dgn.keyHandler = null;
    }
    var stage = stageEl();
    if (stage && dgn.previewClick) { try { stage.removeEventListener('click', dgn.previewClick); } catch (e2) {} dgn.previewClick = null; }
    if (dgn.previewFocused) { dgn.previewFocused = false; document.body.classList.remove('dgn-preview-focus'); }
    if (dgnIsFullscreen()) { try { dgnSetFullscreen(false); } catch (e3) {} }
    dgnPreviewStop();
    if (dgn.layoutRoot && global.EditorLayout && typeof global.EditorLayout.destroy === 'function') {
      try { global.EditorLayout.destroy(dgn.layoutRoot); } catch (e) {}
    }
    dgn.layoutRoot = null;
    dgn.tree = [];
    dgn.selectedId = null;
    dgn.current = null;
  }

  global.GameDesigner = { render: render, cleanup: cleanup };
  global.renderGameDesigner = render;
  global.cleanupGameDesigner = cleanup;
})(typeof window !== 'undefined' ? window : this);
