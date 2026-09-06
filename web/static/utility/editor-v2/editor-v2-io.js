/**
 * Editor V2 IO - Server Communication, Path Capabilities, and Tree Explorer
 */
(() => {
  'use strict';

  let treeData = [];
  let expandedFolders = new Set();
  let selectedFolder = ''; // docDir relative path
  let filterText = '';

  function showModalAlert(msg) {
    if (window.toast) {
      window.toast(msg, 'error');
    } else if (typeof window.confirmModal === 'function') {
      window.confirmModal(msg);
    } else {
      console.error(msg);
    }
  }

  async function showModalPrompt(title, defaultValue, placeholder) {
    if (typeof window.promptModal === 'function') {
      return await window.promptModal(title, defaultValue, placeholder);
    }
    return null;
  }

  async function showModalConfirm(message) {
    if (typeof window.confirmModal === 'function') {
      return await window.confirmModal(message);
    }
    return false;
  }

  let activeTreeContextMenu = null;
  function closeTreeContextMenu() {
    if (activeTreeContextMenu) {
      activeTreeContextMenu.remove();
      activeTreeContextMenu = null;
    }
  }
  document.addEventListener('click', closeTreeContextMenu);
  document.addEventListener('contextmenu', (e) => {
    if (activeTreeContextMenu && !activeTreeContextMenu.contains(e.target)) {
      closeTreeContextMenu();
    }
  });
  window.addEventListener('blur', closeTreeContextMenu);

  async function request(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) {
      let errText = res.statusText;
      let json = null;
      try {
        json = await res.json();
        if (json.error) errText = json.error;
      } catch (_) {}
      const err = new Error(errText);
      err.status = res.status;
      err.data = json;
      throw err;
    }
    return res.json();
  }

  // GET /api/editor/tree
  async function fetchTree() {
    const data = await request('/api/editor/tree');
    treeData = data.files || [];
    return treeData;
  }

  // POST /api/editor/open
  async function openFile({ fileId, pathGrantId, strictText = true } = {}) {
    const res = await fetch('/api/editor/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, pathGrantId, strictText }),
    });

    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = await res.json();
        if (j.error) msg = j.error;
      } catch (_) {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    if (data.cancelled) return null;
    return data; // { fileId, name, size, content, pathGrantId?, unsupported? }
  }

  // POST /api/editor/create
  async function createFile({ fileId, kind }) {
    return request('/api/editor/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, kind }),
    });
  }

  // POST /api/editor/save-document (multipart)
  async function saveDocument(tab) {
    if (!tab || !tab.model) return false;
    if (tab.savePending) return false;

    // Snapshot
    tab.savePending = true;
    if (window.EditorV2Extras && window.EditorV2Extras.prepareSaveAsAssets) {
      try {
        await window.EditorV2Extras.prepareSaveAsAssets(tab);
      } catch (e) {
        tab.savePending = false;
        showModalAlert(e.message);
        return false;
      }
    }
    const snapshotVersion = tab.model.getAlternativeVersionId();
    const snapshotContent = tab.model.getValue();
    const assets = tab.assets || new Map();

    const fd = new FormData();
    fd.append('content', snapshotContent);

    const assetManifest = [];
    let assetIdx = 0;
    for (const [rel, blob] of assets.entries()) {
      const cleanRel = rel.startsWith('./') ? rel.slice(2) : rel;
      const field = `asset_${assetIdx++}`;
      assetManifest.push({ rel: cleanRel, field });
      fd.append(field, blob, cleanRel.split('/').pop());
    }

    const meta = {
      target: {
        fileId: (tab.target && tab.target.fileId) || '',
        pathGrantId: (tab.target && tab.target.pathGrantId) || '',
      },
      createOnly: false,
      assets: assetManifest,
    };
    fd.append('meta', JSON.stringify(meta));

    try {
      const res = await fetch('/api/editor/save-document', {
        method: 'POST',
        body: fd,
      });

      if (!res.ok) {
        let msg = res.statusText;
        try {
          const j = await res.json();
          if (j.error) msg = j.error;
        } catch (_) {}
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      tab.savedText = snapshotContent;
      tab.savedAlternativeVersion = snapshotVersion;
      if (tab.model.getAlternativeVersionId() === snapshotVersion) {
        tab.dirty = false;
      }
      if (data.name) tab.name = data.name;
      if (data.fileId) {
        tab.target = { fileId: data.fileId };
      }
      if (data.pathGrantId) {
        tab.target = { pathGrantId: data.pathGrantId };
      }
      window.EditorV2.renderTabs();
      window.EditorV2.updateStatus();
      if (window.showToast) window.showToast(`Saved ${tab.name}`, 'success');
      return true;
    } finally {
      tab.savePending = false;
    }
  }

  // POST /api/editor/save-as (multipart)
  async function saveAs(tab) {
    if (!tab || !tab.model) return false;
    if (tab.savePending) return false;

    tab.savePending = true;
    if (window.EditorV2Extras && window.EditorV2Extras.prepareSaveAsAssets) {
      try {
        await window.EditorV2Extras.prepareSaveAsAssets(tab);
      } catch (e) {
        tab.savePending = false;
        showModalAlert(e.message);
        return false;
      }
    }
    const snapshotVersion = tab.model.getAlternativeVersionId();
    const snapshotContent = tab.model.getValue();
    const assets = tab.assets || new Map();

    const fd = new FormData();
    fd.append('content', snapshotContent);

    const assetManifest = [];
    let assetIdx = 0;
    for (const [rel, blob] of assets.entries()) {
      const cleanRel = rel.startsWith('./') ? rel.slice(2) : rel;
      const field = `asset_${assetIdx++}`;
      assetManifest.push({ rel: cleanRel, field });
      fd.append(field, blob, cleanRel.split('/').pop());
    }

    const meta = {
      source: tab.target ? {
        fileId: tab.target.fileId || undefined,
        pathGrantId: tab.target.pathGrantId || undefined,
      } : undefined,
      name: tab.name.endsWith('.txt') || tab.name.endsWith('.md') ? tab.name : tab.name + '.md',
      assets: assetManifest,
    };
    fd.append('meta', JSON.stringify(meta));

    try {
      const res = await fetch('/api/editor/save-as', {
        method: 'POST',
        body: fd,
      });

      if (!res.ok) {
        let msg = res.statusText;
        let isWritten = false;
        try {
          const j = await res.json();
          if (j.error) msg = j.error;
          if (j.written) isWritten = true;
        } catch (_) {}

        if (isWritten) {
          showModalAlert(`File was written to disk, but capability binding failed: ${msg}. Please reopen target file.`);
          return false;
        }

        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      if (data.cancelled) return null;

      if (data.unsupported) {
        // Fallback for platforms without native picker: save to docDir relative path
        return await fallbackSaveAsDocDir(tab, snapshotContent, assets);
      }

      // Rebind tab to new target without clearing undo stack
      tab.name = data.name;
      tab.target = { pathGrantId: data.pathGrantId, fileId: '' };
      tab.untitled = false;
      tab.savedText = snapshotContent;
      tab.savedAlternativeVersion = snapshotVersion;
      if (tab.model.getAlternativeVersionId() === snapshotVersion) {
        tab.dirty = false;
      }

      // Update model language based on new filename
      const lang = window.EditorV2Engine.getLanguageForFilename(data.name);
      if (window.Ed2Monaco) {
        window.Ed2Monaco.editor.setModelLanguage(tab.model, lang);
      }

      window.EditorV2.renderTabs();
      window.EditorV2.updateStatus();
      if (window.showToast) window.showToast(`Saved as ${tab.name}`, 'success');
      return true;
    } finally {
      tab.savePending = false;
    }
  }

  async function fallbackSaveAsDocDir(tab, content, assets) {
    const filename = await showModalPrompt('Enter filename to save in docs directory:', tab.name || 'document.md', 'document.md');
    if (!filename) return null;

    const fd = new FormData();
    fd.append('content', content);
    const meta = {
      target: { fileId: filename },
      createOnly: true,
      assets: [],
    };
    fd.append('meta', JSON.stringify(meta));

    let res = await fetch('/api/editor/save-document', { method: 'POST', body: fd });
    if (res.status === 409) {
      const ok = await showModalConfirm(`File "${filename}" already exists. Overwrite?`);
      if (!ok) {
        return null;
      }
      meta.createOnly = false;
      const fd2 = new FormData();
      fd2.append('content', content);
      fd2.append('meta', JSON.stringify(meta));
      res = await fetch('/api/editor/save-document', { method: 'POST', body: fd2 });
    }

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || 'Failed to save file');
    }

    const data = await res.json();
    tab.name = data.name;
    tab.target = { fileId: data.fileId };
    tab.untitled = false;
    tab.dirty = false;
    window.EditorV2.renderTabs();
    window.EditorV2.updateStatus();
    return true;
  }

  // POST /api/editor/rename
  async function renameFile(target, newName) {
    return request('/api/editor/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: target.fileId,
        pathGrantId: target.pathGrantId,
        newName,
      }),
    });
  }

  // POST /api/editor/delete
  async function deleteFile(target) {
    return request('/api/editor/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: target.fileId,
        pathGrantId: target.pathGrantId,
      }),
    });
  }

  // Open file into an Editor tab
  async function openIntoTab(fileParam) {
    try {
      const opened = await openFile(fileParam);
      if (!opened) return null; // Cancelled

      // Check if already open by fileId or pathGrantId
      const tabs = window.EditorV2.getTabs();
      const existing = tabs.find(t => {
        if (!t.target) return false;
        if (opened.pathGrantId && t.target.pathGrantId === opened.pathGrantId) return true;
        if (opened.fileId && t.target.fileId === opened.fileId) return true;
        return false;
      });

      if (existing) {
        window.EditorV2.switchTab(existing.id);
        return existing;
      }

      // Check if current tab is clean untitled with 0 length
      const currentTab = window.EditorV2.getActiveTab();
      let tabToUse = null;
      if (currentTab && currentTab.untitled && !currentTab.dirty && currentTab.model.getValue().length === 0) {
        tabToUse = currentTab;
      }

      const lang = window.EditorV2Engine.getLanguageForFilename(opened.name);
      if (tabToUse) {
        tabToUse.name = opened.name;
        tabToUse.target = { fileId: opened.fileId, pathGrantId: opened.pathGrantId };
        tabToUse.untitled = false;
        tabToUse.savedText = opened.content;
        tabToUse.model.setValue(opened.content);
        tabToUse.savedAlternativeVersion = tabToUse.model.getAlternativeVersionId();
        tabToUse.dirty = false;
        tabToUse.eol = opened.content.includes('\r\n') ? 'CRLF' : 'LF';
        if (window.Ed2Monaco) {
          window.Ed2Monaco.editor.setModelLanguage(tabToUse.model, lang);
        }
        window.EditorV2.renderTabs();
        window.EditorV2.updateStatus();
        return tabToUse;
      }

      // Create new tab
      const id = 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const uri = window.Ed2Monaco.Uri.parse(`inmemory://editor-v2/${id}/${encodeURIComponent(opened.name)}`);
      const model = window.Ed2Monaco.editor.createModel(opened.content, lang, uri);

      const newTab = {
        id,
        kind: 'document',
        name: opened.name,
        target: { fileId: opened.fileId, pathGrantId: opened.pathGrantId },
        model,
        viewState: null,
        savedText: opened.content,
        savedAlternativeVersion: model.getAlternativeVersionId(),
        dirty: false,
        untitled: false,
        assets: new Map(),
        savePending: false,
        previewMode: 'split',
        htmlPreview: false,
        eol: opened.content.includes('\r\n') ? 'CRLF' : 'LF',
      };

      model.onDidChangeContent(() => {
        const isClean = model.getAlternativeVersionId() === newTab.savedAlternativeVersion;
        const wasDirty = newTab.dirty;
        newTab.dirty = !isClean;
        if (wasDirty !== newTab.dirty) window.EditorV2.renderTabs();
        window.EditorV2.updateStatus();
        if (window.EditorV2Store && window.EditorV2Store.scheduleDraftSave) {
          window.EditorV2Store.scheduleDraftSave(newTab);
        }
        if (window.EditorV2Preview && window.EditorV2Preview.scheduleUpdate) {
          window.EditorV2Preview.scheduleUpdate(newTab);
        }
      });

      tabs.push(newTab);
      window.EditorV2.switchTab(newTab.id);
      return newTab;
    } catch (e) {
      showModalAlert(e.message);
      return null;
    }
  }

  async function readDocument(target) {
    if (!target) return null;
    try {
      return await openFile({ fileId: target.fileId, pathGrantId: target.pathGrantId, strictText: true });
    } catch (err) {
      console.warn('[EditorV2IO] readDocument failed:', err);
      return null;
    }
  }

  // Render Explorer Tree with folding, filtering, and rename/delete actions
  function renderExplorerTree(container) {
    if (!container) return;
    container.innerHTML = '';

    // Search filter input at top
    let filterBar = container.querySelector('.ed2-tree-filter-bar');
    if (!filterBar) {
      filterBar = document.createElement('div');
      filterBar.className = 'ed2-tree-filter-bar';
      filterBar.style.padding = '4px 8px 6px 8px';
      filterBar.innerHTML = `
        <div style="position:relative;display:flex;align-items:center;">
          <input type="text" class="input ed2-tree-filter-input" placeholder="${typeof window.t === 'function' ? (window.t('filter') || 'Search files…') : 'Search files…'}" style="width:100%;height:24px;font-size:12px;padding:2px 20px 2px 6px;border-radius:3px;box-sizing:border-box;">
          <i class="codicon codicon-search" style="position:absolute;right:6px;font-size:12px;opacity:0.6;pointer-events:none;"></i>
        </div>
      `;
      const inputEl = filterBar.querySelector('.ed2-tree-filter-input');
      inputEl.value = filterText;
      inputEl.addEventListener('input', (e) => {
        filterText = (e.target.value || '').trim().toLowerCase();
        renderExplorerTree(container);
      });
      container.appendChild(filterBar);
    }

    const rootList = document.createElement('div');
    rootList.className = 'ed2-tree-root';

    // Group & sort items
    const sortedItems = [...treeData].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.relPath.localeCompare(b.relPath);
    });

    // Auto expand directories on first load
    if (expandedFolders.size === 0 && treeData.length > 0) {
      sortedItems.filter(i => i.isDir).forEach(i => expandedFolders.add(i.fileId));
    }

    // Filter items if search query exists
    const visibleItems = sortedItems.filter(item => {
      if (!filterText) return true;
      return item.relPath.toLowerCase().includes(filterText) || item.name.toLowerCase().includes(filterText);
    });

    visibleItems.forEach(item => {
      // Check folder folding hierarchy (only when not filtering)
      if (!filterText && item.relPath.includes('/')) {
        const parts = item.relPath.split('/');
        let cur = '';
        let hiddenByParent = false;
        for (let i = 0; i < parts.length - 1; i++) {
          cur = cur ? `${cur}/${parts[i]}` : parts[i];
          if (!expandedFolders.has(cur)) {
            hiddenByParent = true;
            break;
          }
        }
        if (hiddenByParent) return;
      }

      const node = document.createElement('div');
      node.className = 'ed2-tree-node' + (selectedFolder === item.fileId ? ' selected' : '');
      node.dataset.fileId = item.fileId;
      node.dataset.isDir = item.isDir ? 'true' : 'false';

      const depth = item.relPath.split('/').length - 1;
      node.style.paddingLeft = `${8 + depth * 14}px`;
      node.style.display = 'flex';
      node.style.alignItems = 'center';
      node.style.justifyContent = 'space-between';
      node.style.cursor = 'pointer';
      node.style.height = '24px';
      node.style.lineHeight = '24px';
      node.style.userSelect = 'none';

      const leftSpan = document.createElement('div');
      leftSpan.style.display = 'flex';
      leftSpan.style.alignItems = 'center';
      leftSpan.style.overflow = 'hidden';
      leftSpan.style.textOverflow = 'ellipsis';
      leftSpan.style.whiteSpace = 'nowrap';

      // Folder chevron toggle or leaf icon
      if (item.isDir) {
        const isExp = expandedFolders.has(item.fileId);
        const chevron = document.createElement('i');
        chevron.className = `codicon codicon-chevron-${isExp ? 'down' : 'right'}`;
        chevron.style.marginRight = '4px';
        chevron.style.fontSize = '12px';
        chevron.style.opacity = '0.7';
        leftSpan.appendChild(chevron);

        const icon = document.createElement('i');
        icon.className = `codicon codicon-folder${isExp ? '-opened' : ''}`;
        icon.style.marginRight = '6px';
        leftSpan.appendChild(icon);
      } else {
        const icon = document.createElement('i');
        icon.className = 'codicon codicon-file';
        icon.style.marginRight = '6px';
        icon.style.marginLeft = '16px';
        leftSpan.appendChild(icon);
      }

      const label = document.createElement('span');
      label.textContent = item.name;
      label.title = item.fileId;
      leftSpan.appendChild(label);
      node.appendChild(leftSpan);

      async function triggerRename() {
        const newName = await showModalPrompt('Rename to:', item.name, item.name);
        if (!newName || !newName.trim() || newName.trim() === item.name) return;
        try {
          await renameFile({ fileId: item.fileId }, newName.trim());
          // Sync open tabs
          const tabs = window.EditorV2 ? window.EditorV2.getTabs() : [];
          tabs.forEach(t => {
            if (t.target && t.target.fileId === item.fileId) {
              const dir = item.fileId.includes('/') ? item.fileId.slice(0, item.fileId.lastIndexOf('/')) : '';
              t.target.fileId = dir ? `${dir}/${newName.trim()}` : newName.trim();
              t.name = newName.trim();
            }
          });
          if (window.EditorV2) window.EditorV2.renderTabs();
          await reloadExplorerTree();
        } catch (err) {
          showModalAlert('Rename failed: ' + err.message);
        }
      }

      async function triggerDelete() {
        const confirmed = await showModalConfirm(`Delete "${item.name}" permanently?`);
        if (!confirmed) return;
        try {
          await deleteFile({ fileId: item.fileId });
          // Close corresponding open tabs
          const tabs = window.EditorV2 ? window.EditorV2.getTabs() : [];
          const matched = tabs.find(t => t.target && t.target.fileId === item.fileId);
          if (matched && window.EditorV2) {
            window.EditorV2.closeTab(matched.id);
          }
          await reloadExplorerTree();
        } catch (err) {
          showModalAlert('Delete failed: ' + err.message);
        }
      }

      // Node Actions: Rename & Delete (visible on hover)
      const actionsSpan = document.createElement('div');
      actionsSpan.className = 'ed2-tree-node-actions';
      actionsSpan.style.display = 'flex';
      actionsSpan.style.gap = '2px';
      actionsSpan.style.marginRight = '6px';

      const renameBtn = document.createElement('button');
      renameBtn.className = 'ed2-icon-btn';
      renameBtn.innerHTML = '<i class="codicon codicon-edit"></i>';
      renameBtn.title = 'Rename';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerRename();
      });
      actionsSpan.appendChild(renameBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'ed2-icon-btn';
      deleteBtn.innerHTML = '<i class="codicon codicon-trash"></i>';
      deleteBtn.title = 'Delete';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerDelete();
      });
      actionsSpan.appendChild(deleteBtn);

      node.appendChild(actionsSpan);

      // Node Context Menu (Right click)
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeTreeContextMenu();

        const menu = document.createElement('div');
        menu.className = 'ed2-tab-context-menu ed2-menu-dropdown open';
        menu.style.position = 'fixed';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.style.zIndex = '999999';
        menu.style.display = 'block';

        const t = window.t || ((k, _, f) => f);
        const menuActions = [];
        if (!item.isDir) {
          menuActions.push({
            id: 'open',
            label: t('ed2MenuOpenFile', null, 'Open'),
            run: () => openIntoTab(item),
          });
        }
        menuActions.push(
          { id: 'rename', label: t('ed2MenuRename', null, 'Rename'), run: triggerRename },
          { id: 'delete', label: t('ed2MenuDelete', null, 'Delete'), run: triggerDelete }
        );

        menuActions.forEach(action => {
          const btn = document.createElement('button');
          btn.className = 'ed2-menu-item';
          btn.textContent = action.label;
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            closeTreeContextMenu();
            action.run();
          });
          menu.appendChild(btn);
        });

        document.body.appendChild(menu);
        activeTreeContextMenu = menu;
      });

      node.addEventListener('click', () => {
        if (item.isDir) {
          if (expandedFolders.has(item.fileId)) {
            expandedFolders.delete(item.fileId);
          } else {
            expandedFolders.add(item.fileId);
          }
          selectedFolder = item.fileId;
          renderExplorerTree(container);
        } else {
          selectedFolder = item.fileId.includes('/') ? item.fileId.slice(0, item.fileId.lastIndexOf('/')) : '';
          openIntoTab({ fileId: item.fileId });
        }
      });

      rootList.appendChild(node);
    });

    container.appendChild(rootList);
  }

  let activeTreeContainer = null;
  async function reloadExplorerTree() {
    try {
      await fetchTree();
      if (activeTreeContainer) {
        renderExplorerTree(activeTreeContainer);
      }
    } catch (err) {
      console.warn('Failed to load explorer tree:', err);
    }
  }

  // Explorer Toolbar and Actions initialization
  function init(layoutElements) {
    if (!layoutElements) return;
    activeTreeContainer = layoutElements.treeContainer;

    if (layoutElements.root.querySelector('#ed2-tree-refresh')) {
      layoutElements.root.querySelector('#ed2-tree-refresh').addEventListener('click', reloadExplorerTree);
    }

    // Collapse tree toggle
    if (layoutElements.root.querySelector('#ed2-tree-collapse')) {
      layoutElements.root.querySelector('#ed2-tree-collapse').addEventListener('click', () => {
        layoutElements.explorer.classList.toggle('collapsed');
      });
    }

    // New File in Explorer
    if (layoutElements.root.querySelector('#ed2-tree-new-file')) {
      layoutElements.root.querySelector('#ed2-tree-new-file').addEventListener('click', async () => {
        const name = await showModalPrompt('New file name (relative to current folder):', '', 'e.g. note.md');
        if (!name || !name.trim()) return;
        const targetRel = selectedFolder ? `${selectedFolder}/${name.trim()}` : name.trim();
        try {
          await createFile({ fileId: targetRel, kind: 'file' });
          await reloadExplorerTree();
          await openIntoTab({ fileId: targetRel });
        } catch (e) {
          showModalAlert('Failed to create file: ' + e.message);
        }
      });
    }

    // New Folder in Explorer
    if (layoutElements.root.querySelector('#ed2-tree-new-folder')) {
      layoutElements.root.querySelector('#ed2-tree-new-folder').addEventListener('click', async () => {
        const name = await showModalPrompt('New folder name:', '', 'e.g. subfolder');
        if (!name || !name.trim()) return;
        const targetRel = selectedFolder ? `${selectedFolder}/${name.trim()}` : name.trim();
        try {
          await createFile({ fileId: targetRel, kind: 'directory' });
          await reloadExplorerTree();
        } catch (e) {
          showModalAlert('Failed to create folder: ' + e.message);
        }
      });
    }

    reloadExplorerTree();
  }

  window.EditorV2IO = {
    init,
    fetchTree,
    openFile,
    createFile,
    save: saveDocument,
    saveAs,
    renameFile,
    deleteFile,
    openIntoTab,
    readDocument,
    getSelectedFolder: () => selectedFolder,
    reloadTree: reloadExplorerTree,
  };
})();
