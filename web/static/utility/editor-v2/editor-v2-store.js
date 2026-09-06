/**
 * Editor V2 Store - Independent IndexedDB Storage for Documents, Drafts, and Workspace
 */
(() => {
  'use strict';

  const DB_NAME = 'tinylab-editor-v2';
  const DB_VERSION = 1;

  let dbInstance = null;
  let dbPromise = null;
  const draftTimers = new Map(); // tabId -> timer
  const draftGenerations = new Map(); // tabId -> generation counter
  let isComposition = false;

  // Track composition events on document level to avoid flushing incomplete IME text
  window.addEventListener('compositionstart', () => { isComposition = true; }, true);
  window.addEventListener('compositionend', () => { isComposition = false; }, true);

  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('documents')) {
          db.createObjectStore('documents', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('assets')) {
          db.createObjectStore('assets', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('workspace')) {
          db.createObjectStore('workspace', { keyPath: 'id' });
        }
      };

      req.onsuccess = (e) => {
        dbInstance = e.target.result;
        resolve(dbInstance);
      };

      req.onerror = (e) => {
        dbPromise = null;
        reject(e.target.error);
      };
    });

    return dbPromise;
  }

  async function getStore(storeName, mode = 'readonly') {
    const db = await openDB();
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  // --- Document Drafts ---

  async function putDocument(record) {
    const store = await getStore('documents', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function getDocument(id) {
    const store = await getStore('documents', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteDocument(id) {
    const store = await getStore('documents', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function loadAllDocuments() {
    const store = await getStore('documents', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // --- Assets ---

  async function putAsset(id, blob) {
    const store = await getStore('assets', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put({ id, blob, updatedAt: Date.now() });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAsset(id) {
    const store = await getStore('assets', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteAsset(id) {
    const store = await getStore('assets', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // --- Workspace ---

  async function saveWorkspace(state) {
    const store = await getStore('workspace', 'readwrite');
    const payload = {
      id: 'workspace',
      tabOrder: state.tabOrder || [],
      activeTabId: state.activeTabId || null,
      expandedFolders: Array.from(state.expandedFolders || []),
      explorerVisible: state.explorerVisible !== false,
      tocVisible: !!state.tocVisible,
      focusMode: !!state.focusMode,
      sync: state.sync !== false,
      wrap: state.wrap || 'on',
      fontScale: state.fontScale || 1.0,
      aiModel: state.aiModel || '',
      updatedAt: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const req = store.put(payload);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function loadWorkspace() {
    const store = await getStore('workspace', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get('workspace');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  // --- Debounced Draft Saving ---

  function scheduleDraftSave(tab) {
    if (!tab || !tab.model) return;
    const tabId = tab.id;

    if (draftTimers.has(tabId)) {
      clearTimeout(draftTimers.get(tabId));
    }

    const currentGen = (draftGenerations.get(tabId) || 0) + 1;
    draftGenerations.set(tabId, currentGen);

    const timer = setTimeout(async () => {
      draftTimers.delete(tabId);
      if (isComposition) {
        // Postpone if user is actively in IME composition
        scheduleDraftSave(tab);
        return;
      }
      if (draftGenerations.get(tabId) !== currentGen) {
        return;
      }

      await flushSingleTab(tab, currentGen);
    }, 800);

    draftTimers.set(tabId, timer);
  }

  async function flushSingleTab(tab, expectedGen) {
    if (!tab || !tab.model) return;
    try {
      const record = {
        id: tab.id,
        kind: tab.kind || 'document',
        name: tab.name,
        target: tab.target,
        content: tab.model.getValue(),
        savedText: tab.savedText || '',
        dirty: !!tab.dirty,
        untitled: !!tab.untitled,
        viewState: tab.viewState,
        previewMode: tab.previewMode || 'split',
        htmlPreview: !!tab.htmlPreview,
        eol: tab.eol || 'LF',
        decisions: tab.decisions || null, // For diff tabs
        diffSource: tab.diffSource || null,
        generation: expectedGen,
        updatedAt: Date.now(),
      };
      await putDocument(record);
    } catch (err) {
      console.warn('Failed to save document draft into IndexedDB:', err);
    }
  }

  async function flushDrafts() {
    const tabs = window.EditorV2 ? window.EditorV2.getTabs() : [];
    for (const [tabId, timer] of draftTimers.entries()) {
      clearTimeout(timer);
      const tab = tabs.find(t => t.id === tabId);
      if (tab) {
        const gen = draftGenerations.get(tabId) || 0;
        await flushSingleTab(tab, gen);
      }
    }
    draftTimers.clear();
  }

  window.EditorV2Store = {
    openDB,
    putDocument,
    getDocument,
    deleteDocument,
    loadAllDocuments,
    putAsset,
    getAsset,
    deleteAsset,
    saveWorkspace,
    loadWorkspace,
    scheduleDraftSave,
    flushDrafts,
  };
})();
