/**
 * Editor V2 - Core Controller & Single Namespace
 */
(() => {
  'use strict';

  // State
  let monaco = null;
  let codeEditor = null;
  let layoutElements = null;
  let resizeObserver = null;
  let isSuspended = false;
  let untitledCounter = 1;
  let activeTabId = null;
  let tabs = []; // Array of DocumentTab
  let fontScale = 1.0;
  let wordWrap = 'on';
  let mountGen = 0;
  let statsTimer = null;
  let activeContextMenu = null;

  /**
   * DocumentTab Structure:
   * {
   *   id: string,
   *   kind: 'document' | 'diff',
   *   name: string,
   *   target: null | { fileId?: string, pathGrantId?: string },
   *   model: ITextModel,
   *   viewState: ICodeEditorViewState | null,
   *   savedText: string,
   *   savedAlternativeVersion: number,
   *   dirty: boolean,
   *   untitled: boolean,
   *   assets: Map<string, Blob>,
   *   savePending: boolean,
   *   previewMode: 'split' | 'edit' | 'reader',
   *   htmlPreview: boolean,
   *   eol: 'LF' | 'CRLF',
   * }
   */

  function getActiveTab() {
    return tabs.find(t => t.id === activeTabId) || null;
  }

  function getTabById(id) {
    return tabs.find(t => t.id === id) || null;
  }

  function computeFontSizeAndLineHeight() {
    const base = window.EditorV2Engine ? window.EditorV2Engine.getBaseCodeFontSize() : 13;
    const fontSize = Math.max(8, Math.min(48, Math.round(base * fontScale)));
    const lineHeight = Math.round(fontSize * 1.5);
    return { fontSize, lineHeight };
  }

  function updateEditorMetrics() {
    if (!codeEditor) return;
    const { fontSize, lineHeight } = computeFontSizeAndLineHeight();
    codeEditor.updateOptions({
      fontSize,
      lineHeight,
      wordWrap,
    });
    // Trigger preview font scale if preview module available
    if (window.EditorV2Preview && window.EditorV2Preview.updateFontScale) {
      window.EditorV2Preview.updateFontScale(fontScale);
    }
  }

  function updateStatus(fastOnly = false) {
    if (!layoutElements || !codeEditor) return;
    const tab = getActiveTab();
    if (!tab || !tab.model) {
      layoutElements.statusPos.textContent = 'Ln 0, Col 0';
      layoutElements.statusLines.textContent = '0 lines';
      layoutElements.statusStats.textContent = '0 words, 0 chars';
      layoutElements.statusLang.textContent = 'Plain Text';
      layoutElements.statusEol.textContent = 'LF';
      return;
    }

    const pos = codeEditor.getPosition() || { lineNumber: 1, column: 1 };
    const lineCount = tab.model.getLineCount();
    const sel = codeEditor.getSelection();

    let selText = '';
    if (sel && !sel.isEmpty()) {
      selText = tab.model.getValueInRange(sel);
    }

    layoutElements.statusPos.textContent = sel && !sel.isEmpty()
      ? `Ln ${pos.lineNumber}, Col ${pos.column} (${selText.length} selected)`
      : `Ln ${pos.lineNumber}, Col ${pos.column}`;
    layoutElements.statusLines.textContent = `${lineCount} line${lineCount === 1 ? '' : 's'}`;

    const langId = tab.model.getLanguageId();
    layoutElements.statusLang.textContent = langId ? (langId.charAt(0).toUpperCase() + langId.slice(1)) : 'Plain Text';
    layoutElements.statusWrap.textContent = `Wrap: ${wordWrap === 'on' ? 'On' : 'Off'}`;
    layoutElements.statusEol.textContent = tab.eol || 'LF';

    // Expensive stats calculation: debounced for large documents
    if (fastOnly) {
      clearTimeout(statsTimer);
      statsTimer = setTimeout(() => {
        updateStatsText(tab);
      }, 300);
    } else {
      updateStatsText(tab);
    }
  }

  function updateStatsText(tab) {
    if (!layoutElements || !tab || !tab.model) return;
    const fullText = tab.model.getValue();
    const chars = fullText.length;
    const words = (fullText.trim().match(/\S+/g) || []).length;
    layoutElements.statusStats.textContent = `${words} words, ${chars} chars`;
  }

  function closeContextMenu() {
    if (activeContextMenu) {
      activeContextMenu.remove();
      activeContextMenu = null;
    }
  }

  document.addEventListener('click', closeContextMenu);
  window.addEventListener('blur', closeContextMenu);

  function openTabContextMenu(x, y, targetTab) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ed2-tab-context-menu ed2-menu-dropdown open';
    menu.style.position = 'fixed';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.zIndex = '999999';
    menu.style.display = 'block';

    const t = window.t || ((k, _, f) => f);

    const menuActions = [
      { id: 'close', label: t('ed2MenuClose', null, 'Close Tab'), run: () => closeTab(targetTab.id) },
      { id: 'closeOthers', label: t('ed2MenuCloseOthers', null, 'Close Others'), run: () => closeOthers(targetTab.id) },
      { id: 'closeToTheRight', label: t('ed2MenuCloseToTheRight', null, 'Close to the Right'), run: () => closeToTheRight(targetTab.id) },
      { id: 'closeSaved', label: t('ed2MenuCloseSaved', null, 'Close Saved'), run: () => closeSaved() },
      { id: 'closeAll', label: t('ed2MenuCloseAll', null, 'Close All'), run: () => closeAllTabs() },
    ];

    menuActions.forEach(action => {
      const btn = document.createElement('button');
      btn.className = 'ed2-menu-item';
      btn.textContent = action.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextMenu();
        action.run();
      });
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    activeContextMenu = menu;
  }

  function renderTabs() {
    if (!layoutElements) return;
    const bar = layoutElements.tabsBar;
    const newBtn = layoutElements.btnNewTab;

    // Remove existing tab elements
    const existingTabs = bar.querySelectorAll('.ed2-tab');
    existingTabs.forEach(el => el.remove());

    tabs.forEach(tab => {
      const tabEl = document.createElement('div');
      tabEl.className = 'ed2-tab' + (tab.id === activeTabId ? ' active' : '') + (tab.dirty ? ' dirty' : '');
      tabEl.dataset.tabId = tab.id;
      tabEl.setAttribute('role', 'tab');
      tabEl.setAttribute('aria-selected', tab.id === activeTabId ? 'true' : 'false');
      tabEl.setAttribute('draggable', 'true');

      // Title & tooltip
      const titleSpan = document.createElement('span');
      titleSpan.className = 'ed2-tab-title';
      titleSpan.textContent = tab.name;
      tabEl.appendChild(titleSpan);

      // Tooltip handling: target relative path or external file
      if (tab.target && tab.target.fileId) {
        tabEl.title = tab.target.fileId;
      } else if (tab.target && tab.target.pathGrantId) {
        tabEl.title = 'External File';
      } else {
        tabEl.title = tab.name;
      }

      // Dirty indicator dot
      const dot = document.createElement('span');
      dot.className = 'ed2-tab-dirty-dot';
      tabEl.appendChild(dot);

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.className = 'ed2-icon-btn ed2-tab-close';
      closeBtn.setAttribute('aria-label', 'Close Tab');
      closeBtn.innerHTML = '<i class="codicon codicon-close"></i>';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      tabEl.appendChild(closeBtn);

      // Switch tab on click
      tabEl.addEventListener('click', () => {
        if (tab.id !== activeTabId) {
          switchTab(tab.id);
        }
      });

      // Middle click to close tab
      tabEl.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(tab.id);
        }
      });

      // Right-click context menu
      tabEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openTabContextMenu(e.clientX, e.clientY, tab);
      });

      // Drag and Drop reordering
      tabEl.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', tab.id);
        e.dataTransfer.effectAllowed = 'move';
        tabEl.classList.add('dragging');
      });

      tabEl.addEventListener('dragend', () => {
        tabEl.classList.remove('dragging');
      });

      tabEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tabEl.classList.add('drag-over');
      });

      tabEl.addEventListener('dragleave', () => {
        tabEl.classList.remove('drag-over');
      });

      tabEl.addEventListener('drop', (e) => {
        e.preventDefault();
        tabEl.classList.remove('drag-over');
        const sourceId = e.dataTransfer.getData('text/plain');
        if (!sourceId || sourceId === tab.id) return;

        const fromIdx = tabs.findIndex(t => t.id === sourceId);
        const toIdx = tabs.findIndex(t => t.id === tab.id);
        if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
          const [moved] = tabs.splice(fromIdx, 1);
          tabs.splice(toIdx, 0, moved);
          renderTabs();
          persistWorkspace();
        }
      });

      bar.insertBefore(tabEl, newBtn);
    });
  }

  async function persistWorkspace() {
    if (!window.EditorV2Store || !window.EditorV2Store.saveWorkspace) return;
    try {
      await window.EditorV2Store.saveWorkspace({
        tabOrder: tabs.map(t => t.id),
        activeTabId: activeTabId,
        wrap: wordWrap,
        fontScale: fontScale,
      });
    } catch (e) {
      console.warn('[EditorV2] persistWorkspace failed:', e);
    }
  }

  function switchTab(newTabId) {
    if (activeTabId === newTabId) return;

    const currentTab = getActiveTab();
    if (currentTab && codeEditor && currentTab.model) {
      currentTab.viewState = codeEditor.saveViewState();
    }

    const nextTab = getTabById(newTabId);
    if (!nextTab) return;

    activeTabId = newTabId;

    if (nextTab.kind === 'diff') {
      // Show diff tab view
      if (layoutElements.monacoHost) layoutElements.monacoHost.style.display = 'none';
      if (layoutElements.previewHost) layoutElements.previewHost.style.display = 'none';
      if (window.EditorV2Diff && window.EditorV2Diff.renderDiffTab) {
        window.EditorV2Diff.renderDiffTab(nextTab, layoutElements.contentSplit);
      }
    } else {
      // Normal document tab
      if (layoutElements.monacoHost) layoutElements.monacoHost.style.display = 'block';
      if (layoutElements.previewHost) layoutElements.previewHost.style.display = '';
      if (window.EditorV2Diff && window.EditorV2Diff.hideDiffTab) {
        window.EditorV2Diff.hideDiffTab();
      }

      if (codeEditor && nextTab.model) {
        codeEditor.setModel(nextTab.model);
        if (nextTab.viewState) {
          codeEditor.restoreViewState(nextTab.viewState);
        }
        codeEditor.focus();
      }

      // Sync preview if preview module is loaded
      if (window.EditorV2Preview && window.EditorV2Preview.onTabSwitched) {
        window.EditorV2Preview.onTabSwitched(nextTab);
      }
    }

    renderTabs();
    updateStatus();
    persistWorkspace();
  }

  function prevTab() {
    if (tabs.length <= 1) return;
    const curIdx = tabs.findIndex(t => t.id === activeTabId);
    const prevIdx = (curIdx - 1 + tabs.length) % tabs.length;
    switchTab(tabs[prevIdx].id);
  }

  function nextTab() {
    if (tabs.length <= 1) return;
    const curIdx = tabs.findIndex(t => t.id === activeTabId);
    const nextIdx = (curIdx + 1) % tabs.length;
    switchTab(tabs[nextIdx].id);
  }

  function createTextModel(content, filename) {
    const lang = window.EditorV2Engine ? window.EditorV2Engine.getLanguageForFilename(filename) : 'plaintext';
    // Uri fixed scheme inmemory://editor-v2/<id>/<name>
    const id = 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const uri = monaco.Uri.parse(`inmemory://editor-v2/${id}/${encodeURIComponent(filename)}`);
    const model = monaco.editor.createModel(content, lang, uri);

    // Initial EOL detection
    const eol = content.includes('\r\n') ? 'CRLF' : 'LF';
    return { id, model, eol };
  }

  function bindModelEvents(tab) {
    if (!tab || !tab.model) return;
    tab.model.onDidChangeContent(() => {
      const isClean = tab.model.getAlternativeVersionId() === tab.savedAlternativeVersion;
      const wasDirty = tab.dirty;
      tab.dirty = !isClean;
      if (wasDirty !== tab.dirty) {
        renderTabs();
      }
      updateStatus(true);
      // Notify auto-draft store if store module is loaded
      if (window.EditorV2Store && window.EditorV2Store.scheduleDraftSave) {
        window.EditorV2Store.scheduleDraftSave(tab);
      }
      // Schedule preview update if preview module is loaded
      if (window.EditorV2Preview && window.EditorV2Preview.scheduleUpdate) {
        window.EditorV2Preview.scheduleUpdate(tab);
      }
    });
  }

  function createUntitledTab(suggestedContent = '') {
    const name = `Untitled-${untitledCounter++}`;
    const { id, model, eol } = createTextModel(suggestedContent, name + '.txt');

    const newTab = {
      id,
      kind: 'document',
      name,
      target: null,
      model,
      viewState: null,
      savedText: '',
      savedAlternativeVersion: model.getAlternativeVersionId(),
      dirty: suggestedContent.length > 0,
      untitled: true,
      assets: new Map(),
      savePending: false,
      previewMode: 'split',
      htmlPreview: false,
      eol,
    };

    bindModelEvents(newTab);
    tabs.push(newTab);
    switchTab(newTab.id);
    return newTab;
  }

  async function closeTab(tabId) {
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex < 0) return true;
    const tab = tabs[tabIndex];

    if (tab.dirty && !tab.untitled) {
      // Saved file that is dirty
      const choice = await promptCloseDirtyTab(tab);
      if (choice === 'cancel') return false;
      if (choice === 'save') {
        const saved = await window.EditorV2IO.save(tab);
        if (!saved) return false;
      }
    } else if (tab.dirty && tab.untitled && tab.model && tab.model.getValue().trim().length > 0) {
      // Untitled with content
      const choice = await promptCloseDirtyTab(tab);
      if (choice === 'cancel') return false;
      if (choice === 'save') {
        const saved = await window.EditorV2IO.saveAs(tab);
        if (!saved) return false;
      }
    }

    // Dispose model
    if (tab.model) {
      tab.model.dispose();
      tab.model = null;
    }

    // Remove from IndexedDB
    if (window.EditorV2Store && window.EditorV2Store.deleteDocument) {
      window.EditorV2Store.deleteDocument(tabId);
    }

    // Remove from tab list
    tabs.splice(tabIndex, 1);

    // Switch to adjacent tab or create untitled if empty
    if (activeTabId === tabId) {
      if (tabs.length > 0) {
        const nextIdx = Math.min(tabIndex, tabs.length - 1);
        switchTab(tabs[nextIdx].id);
      } else {
        createUntitledTab();
      }
    } else {
      renderTabs();
    }

    persistWorkspace();
    return true;
  }

  async function closeAllTabs() {
    const toClose = [...tabs];
    for (const t of toClose) {
      if (t.savePending) continue;
      const closed = await closeTab(t.id);
      if (!closed) break;
    }
  }

  async function closeOthers(targetId) {
    const toClose = tabs.filter(t => t.id !== targetId);
    for (const t of toClose) {
      if (t.savePending) continue;
      const closed = await closeTab(t.id);
      if (!closed) break;
    }
  }

  async function closeToTheRight(targetId) {
    const idx = tabs.findIndex(t => t.id === targetId);
    if (idx < 0) return;
    const toClose = tabs.slice(idx + 1);
    for (const t of toClose) {
      if (t.savePending) continue;
      const closed = await closeTab(t.id);
      if (!closed) break;
    }
  }

  async function closeSaved() {
    const toClose = tabs.filter(t => !t.dirty);
    for (const t of toClose) {
      if (t.savePending) continue;
      await closeTab(t.id);
    }
  }

  async function promptCloseDirtyTab(tab) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay open';
      overlay.style.zIndex = '99999';

      const t = window.t || ((k, _, f) => f);

      overlay.innerHTML = `
        <div class="modal modal-card" role="dialog" style="max-width: 420px;">
          <div class="modal-header">
            <h3>${escapeHtml(t('saveChangesTitle', null, 'Save Changes?'))}</h3>
          </div>
          <div class="modal-body" style="padding: 16px 0;">
            <p>${escapeHtml(t('saveChangesPrompt', null, 'Do you want to save changes to'))} <strong>${escapeHtml(tab.name)}</strong>?</p>
            <p style="color: var(--text-muted); font-size: 12px; margin-top: 8px;">${escapeHtml(t('saveChangesWarning', null, 'Your changes will be lost if you don\'t save them.'))}</p>
          </div>
          <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 8px;">
            <button class="btn btn-primary" id="ed2-modal-save">${escapeHtml(t('save', null, 'Save'))}</button>
            <button class="btn btn-secondary" id="ed2-modal-dont-save">${escapeHtml(t('dontSave', null, 'Don\'t Save'))}</button>
            <button class="btn btn-ghost" id="ed2-modal-cancel">${escapeHtml(t('cancel', null, 'Cancel'))}</button>
          </div>
        </div>
      `;

      function cleanup() {
        overlay.remove();
      }

      overlay.querySelector('#ed2-modal-save').onclick = () => { cleanup(); resolve('save'); };
      overlay.querySelector('#ed2-modal-dont-save').onclick = () => { cleanup(); resolve('dont-save'); };
      overlay.querySelector('#ed2-modal-cancel').onclick = () => { cleanup(); resolve('cancel'); };
      document.body.appendChild(overlay);
    });
  }

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  async function renderEditorV2(container) {
    isSuspended = false;
    const currentMountGen = ++mountGen;

    // 1. Build layout scaffold
    layoutElements = window.EditorV2Layout.createLayout(container);

    // 2. Load Monaco Editor Engine with error boundary
    try {
      monaco = await window.EditorV2Engine.load();
    } catch (err) {
      if (currentMountGen !== mountGen || isSuspended) return;
      layoutElements.monacoHost.innerHTML = `
        <div class="ed2-engine-error" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);gap:12px;padding:24px;text-align:center;">
          <i class="codicon codicon-error" style="font-size:32px;color:var(--error-color,#f44336);"></i>
          <h3>${typeof window.t === 'function' ? (window.t('editorEngineLoadFailed') || '编辑器引擎加载失败') : '编辑器引擎加载失败'}</h3>
          <p style="font-size:13px;max-width:400px;">${escapeHtml(err.message || '无法加载 Monaco 编辑器核心资源')}</p>
          <button class="btn btn-primary" id="ed2-engine-retry">${typeof window.t === 'function' ? (window.t('retry') || '重试') : '重试'}</button>
        </div>
      `;
      const retryBtn = layoutElements.monacoHost.querySelector('#ed2-engine-retry');
      if (retryBtn) {
        retryBtn.onclick = () => {
          renderEditorV2(container);
        };
      }
      return;
    }

    if (currentMountGen !== mountGen || isSuspended) return;

    // 3. Load workspace state from IndexedDB
    let savedWs = null;
    if (window.EditorV2Store && window.EditorV2Store.loadWorkspace) {
      try {
        savedWs = await window.EditorV2Store.loadWorkspace();
      } catch (err) {
        console.warn('[EditorV2] loadWorkspace error:', err);
      }
    }
    if (currentMountGen !== mountGen || isSuspended) return;

    if (savedWs) {
      if (savedWs.wrap) wordWrap = savedWs.wrap;
      if (savedWs.fontScale) fontScale = savedWs.fontScale;
    }

    // 4. Create standalone editor instance if not exists
    const { fontSize, lineHeight } = computeFontSizeAndLineHeight();
    codeEditor = monaco.editor.create(layoutElements.monacoHost, {
      value: '',
      language: 'plaintext',
      lineNumbers: 'on',
      wordWrap: wordWrap,
      wrappingIndent: 'none',
      glyphMargin: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      folding: true,
      stickyScroll: { enabled: false },
      automaticLayout: false,
      mouseWheelZoom: false,
      tabSize: 2,
      insertSpaces: true,
      fontSize: fontSize,
      lineHeight: lineHeight,
      theme: window.EditorV2Engine.getCurrentThemeName(),
      renderWhitespace: 'selection',
    });

    // 5. Setup ResizeObserver on Monaco container
    resizeObserver = new ResizeObserver(() => {
      if (codeEditor && !isSuspended && layoutElements.monacoHost.offsetWidth > 0) {
        codeEditor.layout();
      }
    });
    resizeObserver.observe(layoutElements.monacoHost);

    // 6. Cursor and selection event listeners
    codeEditor.onDidChangeCursorPosition(() => updateStatus(true));
    codeEditor.onDidChangeCursorSelection(() => updateStatus(true));

    // 7. Bind Tabs events
    layoutElements.btnNewTab.addEventListener('click', () => {
      createUntitledTab();
    });

    // 8. Bind wrap toggle in statusbar
    layoutElements.statusWrap.addEventListener('click', () => {
      wordWrap = wordWrap === 'on' ? 'off' : 'on';
      updateEditorMetrics();
      updateStatus();
      persistWorkspace();
    });

    // 9. If commands module is available, bind commands
    if (window.EditorV2Commands && window.EditorV2Commands.init) {
      window.EditorV2Commands.init(layoutElements, codeEditor);
    }

    // 10. If preview module is available, bind preview
    if (window.EditorV2Preview && window.EditorV2Preview.init) {
      window.EditorV2Preview.init(layoutElements, codeEditor);
    }

    // 11. If IO module is available, bind tree and explorer
    if (window.EditorV2IO && window.EditorV2IO.init) {
      window.EditorV2IO.init(layoutElements);
    }

    // 12. If extras module is available, bind extras
    if (window.EditorV2Extras && window.EditorV2Extras.init) {
      window.EditorV2Extras.init(layoutElements, codeEditor);
    }

    // 13. Restore Document Tabs
    if (tabs.length === 0) {
      let restoredDocs = [];
      if (window.EditorV2Store && window.EditorV2Store.loadAllDocuments) {
        try {
          restoredDocs = await window.EditorV2Store.loadAllDocuments();
        } catch (err) {
          console.warn('[EditorV2] loadAllDocuments failed:', err);
        }
      }
      if (currentMountGen !== mountGen || isSuspended) return;

      if (restoredDocs && restoredDocs.length > 0) {
        if (savedWs && Array.isArray(savedWs.tabOrder) && savedWs.tabOrder.length > 0) {
          const orderMap = new Map(savedWs.tabOrder.map((id, idx) => [id, idx]));
          restoredDocs.sort((a, b) => {
            const idxA = orderMap.has(a.id) ? orderMap.get(a.id) : 9999;
            const idxB = orderMap.has(b.id) ? orderMap.get(b.id) : 9999;
            return idxA - idxB;
          });
        }

        for (const rec of restoredDocs) {
          let textContent = rec.content || '';
          let isDirty = !!rec.dirty;
          let isUntitled = !!rec.untitled;
          let target = rec.target || null;
          let name = rec.name || 'Untitled';

          // Clean file-backed document: try rereading from disk
          if (!isDirty && target && (target.fileId || target.pathGrantId) && window.EditorV2IO && window.EditorV2IO.readDocument) {
            try {
              const diskDoc = await window.EditorV2IO.readDocument(target);
              if (diskDoc && typeof diskDoc.content === 'string') {
                textContent = diskDoc.content;
                name = diskDoc.name || name;
                isDirty = false;
              }
            } catch (err) {
              console.warn('[EditorV2] Failed to reread clean doc from disk, fallback to draft:', err);
            }
          }

          const lang = window.EditorV2Engine ? window.EditorV2Engine.getLanguageForFilename(name) : 'plaintext';
          const uri = monaco.Uri.parse(`inmemory://editor-v2/${rec.id}/${encodeURIComponent(name)}`);
          const model = monaco.editor.createModel(textContent, lang, uri);

          const restoredTab = {
            id: rec.id,
            kind: rec.kind || 'document',
            name: name,
            target: target,
            model: model,
            viewState: rec.viewState || null,
            savedText: isDirty ? (rec.savedText || '') : textContent,
            savedAlternativeVersion: model.getAlternativeVersionId(),
            dirty: isDirty,
            untitled: isUntitled,
            assets: new Map(),
            savePending: false,
            previewMode: rec.previewMode || 'split',
            htmlPreview: !!rec.htmlPreview,
            eol: rec.eol || (textContent.includes('\r\n') ? 'CRLF' : 'LF'),
          };

          bindModelEvents(restoredTab);
          tabs.push(restoredTab);
        }
      }

      if (tabs.length === 0) {
        createUntitledTab();
      } else {
        const targetTabId = (savedWs && savedWs.activeTabId && tabs.some(t => t.id === savedWs.activeTabId))
          ? savedWs.activeTabId
          : tabs[0].id;
        activeTabId = null;
        switchTab(targetTabId);
      }
    } else {
      const targetTab = getActiveTab() || tabs[0];
      activeTabId = null;
      switchTab(targetTab.id);
    }

    renderTabs();
    updateStatus();
    persistWorkspace();
  }

  function suspendEditorV2() {
    isSuspended = true;
    const currentTab = getActiveTab();
    if (currentTab && codeEditor && currentTab.model) {
      currentTab.viewState = codeEditor.saveViewState();
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (codeEditor) {
      codeEditor.dispose();
      codeEditor = null;
    }
    persistWorkspace();
    // Flush draft if store is loaded
    if (window.EditorV2Store && window.EditorV2Store.flushDrafts) {
      window.EditorV2Store.flushDrafts();
    }
  }

  async function cleanupEditorV2() {
    if (window.EditorV2Store && window.EditorV2Store.flushDrafts) {
      await window.EditorV2Store.flushDrafts();
    }
    suspendEditorV2();
    // Dispose all models
    for (const tab of tabs) {
      if (tab.model) {
        tab.model.dispose();
        tab.model = null;
      }
    }
    tabs = [];
    activeTabId = null;
  }

  function setFontScale(scale) {
    fontScale = Math.max(0.5, Math.min(3.0, scale));
    localStorage.setItem('tr-editor-v2-text-zoom', fontScale.toString());
    updateEditorMetrics();
    persistWorkspace();
  }

  function getFontScale() {
    const saved = localStorage.getItem('tr-editor-v2-text-zoom');
    if (saved) {
      const parsed = parseFloat(saved);
      if (parsed >= 0.5 && parsed <= 3.0) return parsed;
    }
    return 1.0;
  }

  // Load persisted fontScale
  fontScale = getFontScale();

  window.EditorV2 = {
    renderEditorV2,
    suspendEditorV2,
    cleanupEditorV2,
    getActiveTab,
    getTabById,
    getTabs: () => tabs,
    createUntitledTab,
    switchTab,
    prevTab,
    nextTab,
    closeTab,
    closeAllTabs,
    closeOthers,
    closeToTheRight,
    closeSaved,
    getCodeEditor: () => codeEditor,
    setFontScale,
    getFontScale: () => fontScale,
    updateStatus,
    renderTabs,
    persistWorkspace,
  };

  window.renderEditorV2 = renderEditorV2;
  window.suspendEditorV2 = suspendEditorV2;
  window.cleanupEditorV2 = cleanupEditorV2;
})();
