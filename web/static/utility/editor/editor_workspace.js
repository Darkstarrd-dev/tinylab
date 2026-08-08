'use strict';

(function (global) {
  var DB_NAME = 'tinyrouter-editor-workspace';
  var DB_VERSION = 1;
  var NODE_STORE = 'nodes';
  var CONTENT_STORE = 'contents';
  var META_STORE = 'meta';
  var TRASH_ID = 'system:trash';
  var TEMP_ID = 'system:temp';
  var WELCOME_ID = 'file:welcome';
  var WELCOME_TEXT = 'Welcome to TinyRouter Editor.\n\nCreate a file to get started.';

  var db = null;
  var memoryMode = false;
  var memory = { nodes: Object.create(null), contents: Object.create(null), meta: Object.create(null) };
  var readyPromise = null;
  var idCounter = 0;

  function clone(value) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(clone);
    var result = {};
    Object.keys(value).forEach(function (key) { result[key] = clone(value[key]); });
    return result;
  }

  function now() { return Date.now(); }

  function makeId(prefix) {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return prefix + ':' + global.crypto.randomUUID();
    idCounter += 1;
    return prefix + ':' + now().toString(36) + ':' + idCounter.toString(36);
  }

  function makeNode(id, name, type, parentId, extra) {
    var node = {
      id: id,
      name: name,
      type: type,
      parentId: parentId === undefined ? null : parentId,
      deleted: false,
      createdAt: now(),
      updatedAt: now()
    };
    if (extra) Object.keys(extra).forEach(function (key) { node[key] = clone(extra[key]); });
    return node;
  }

  function resetMemory() {
    memory = { nodes: Object.create(null), contents: Object.create(null), meta: Object.create(null) };
  }

  function seedMemory() {
    if (!memory.nodes[TRASH_ID]) memory.nodes[TRASH_ID] = makeNode(TRASH_ID, 'Trash', 'folder', null, { system: 'trash' });
    if (!memory.nodes[TEMP_ID]) memory.nodes[TEMP_ID] = makeNode(TEMP_ID, 'Temp', 'folder', null, { system: 'temp' });
    if (!memory.nodes[WELCOME_ID]) memory.nodes[WELCOME_ID] = makeNode(WELCOME_ID, 'Welcome.md', 'file', null, { system: 'welcome' });
    if (!Object.prototype.hasOwnProperty.call(memory.contents, WELCOME_ID)) memory.contents[WELCOME_ID] = WELCOME_TEXT;
    if (!Array.isArray(memory.meta.expandedIds)) memory.meta.expandedIds = [TEMP_ID];
    if (!Object.prototype.hasOwnProperty.call(memory.meta, 'currentFileId')) memory.meta.currentFileId = WELCOME_ID;
  }

  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB request failed')); };
    });
  }

  function transactionDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction failed')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
    });
  }

  function openDatabase() {
    if (memoryMode || !global.indexedDB) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
      var request;
      try { request = global.indexedDB.open(DB_NAME, DB_VERSION); } catch (error) { reject(error); return; }
      request.onupgradeneeded = function () {
        var upgradeDb = request.result;
        if (!upgradeDb.objectStoreNames.contains(NODE_STORE)) upgradeDb.createObjectStore(NODE_STORE, { keyPath: 'id' });
        if (!upgradeDb.objectStoreNames.contains(CONTENT_STORE)) upgradeDb.createObjectStore(CONTENT_STORE, { keyPath: 'id' });
        if (!upgradeDb.objectStoreNames.contains(META_STORE)) upgradeDb.createObjectStore(META_STORE, { keyPath: 'key' });
      };
      request.onsuccess = function () {
        var opened = request.result;
        opened.onversionchange = function () { opened.close(); };
        resolve(opened);
      };
      request.onerror = function () { reject(request.error || new Error('IndexedDB open failed')); };
      request.onblocked = function () { reject(new Error('IndexedDB open blocked')); };
    });
  }

  function getAll(store) { return requestResult(store.getAll()); }

  function loadFromDatabase(opened) {
    var tx = opened.transaction([NODE_STORE, CONTENT_STORE, META_STORE], 'readonly');
    return Promise.all([
      getAll(tx.objectStore(NODE_STORE)),
      getAll(tx.objectStore(CONTENT_STORE)),
      getAll(tx.objectStore(META_STORE)),
      transactionDone(tx)
    ]).then(function (values) {
      resetMemory();
      (values[0] || []).forEach(function (node) { if (node && node.id) memory.nodes[node.id] = node; });
      (values[1] || []).forEach(function (content) { if (content && content.id) memory.contents[content.id] = typeof content.text === 'string' ? content.text : ''; });
      (values[2] || []).forEach(function (item) { if (item && item.key) memory.meta[item.key] = clone(item.value); });
    });
  }

  function persistMemory() {
    if (memoryMode || !db) return Promise.resolve();
    var tx;
    try {
      tx = db.transaction([NODE_STORE, CONTENT_STORE, META_STORE], 'readwrite');
      var nodes = tx.objectStore(NODE_STORE);
      var contents = tx.objectStore(CONTENT_STORE);
      var meta = tx.objectStore(META_STORE);
      nodes.clear();
      contents.clear();
      meta.clear();
      Object.keys(memory.nodes).forEach(function (id) { nodes.put(clone(memory.nodes[id])); });
      Object.keys(memory.contents).forEach(function (id) { contents.put({ id: id, text: memory.contents[id] }); });
      Object.keys(memory.meta).forEach(function (key) { meta.put({ key: key, value: clone(memory.meta[key]) }); });
    } catch (error) {
      memoryMode = true;
      return Promise.resolve();
    }
    return transactionDone(tx).catch(function () { memoryMode = true; });
  }

  function initialize() {
    if (readyPromise) return readyPromise;
    readyPromise = openDatabase().then(function (opened) {
      if (!opened) {
        memoryMode = true;
        resetMemory();
        seedMemory();
        return true;
      }
      db = opened;
      return loadFromDatabase(opened).then(function () {
        var before = JSON.stringify(memory);
        seedMemory();
        if (before !== JSON.stringify(memory)) return persistMemory();
      }).then(function () { return true; });
    }).catch(function () {
      if (db) { try { db.close(); } catch (ignored) {} }
      db = null;
      memoryMode = true;
      resetMemory();
      seedMemory();
      return true;
    });
    return readyPromise;
  }

  function withReady(action) {
    return initialize().then(function () {
      try { return Promise.resolve(action()); } catch (error) { return null; }
    });
  }

  function allNodes() { return Object.keys(memory.nodes).map(function (id) { return memory.nodes[id]; }); }
  function isFolder(node) { return !!node && node.type === 'folder'; }
  function hasName(name, parentId, exceptId) {
    return allNodes().some(function (node) { return node.id !== exceptId && !node.deleted && node.parentId === parentId && node.name === name; });
  }
  function normalizeName(name) { return typeof name === 'string' ? name.trim() : ''; }
  function getNodeInternal(id) { return id && memory.nodes[id] ? memory.nodes[id] : null; }
  function parentIsValid(parentId, exceptId) {
    if (parentId === null || parentId === undefined || parentId === '') return true;
    var parent = getNodeInternal(parentId);
    return !!parent && parent.id !== exceptId && isFolder(parent) && !parent.deleted;
  }
  function wouldCycle(id, parentId) {
    var seen = Object.create(null);
    var current = parentId;
    while (current !== null && current !== undefined) {
      if (current === id || seen[current]) return true;
      seen[current] = true;
      var node = getNodeInternal(current);
      if (!node) return false;
      current = node.parentId;
    }
    return false;
  }
  function copyNode(node) { return node ? clone(node) : null; }

  function putNode(node, content) {
    memory.nodes[node.id] = node;
    if (node.type === 'file') memory.contents[node.id] = typeof content === 'string' ? content : '';
    return persistMemory().then(function () { return copyNode(node); });
  }

  function putFile(name, text, parentId, meta) {
    return withReady(function () {
      var normalized = normalizeName(name);
      var parent = parentId === undefined ? null : parentId;
      if (!normalized || !parentIsValid(parent, null) || hasName(normalized, parent, null)) return null;
      var node = makeNode(makeId('file'), normalized, 'file', parent, meta && typeof meta === 'object' ? meta : null);
      return putNode(node, typeof text === 'string' ? text : (text == null ? '' : String(text)));
    });
  }

  function putFolder(name, parentId) {
    return withReady(function () {
      var normalized = normalizeName(name);
      var parent = parentId === undefined ? null : parentId;
      if (!normalized || !parentIsValid(parent, null) || hasName(normalized, parent, null)) return null;
      return putNode(makeNode(makeId('folder'), normalized, 'folder', parent));
    });
  }

  function updateNode(id, patch) {
    return withReady(function () {
      var node = getNodeInternal(id);
      if (!node || node.deleted || !patch || typeof patch !== 'object' || node.system === 'trash' || node.system === 'temp') return null;
      var next = clone(node);
      if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
        next.name = normalizeName(patch.name);
        if (!next.name || hasName(next.name, next.parentId, id)) return null;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'parentId')) {
        var parent = patch.parentId === undefined || patch.parentId === '' ? null : patch.parentId;
        if (!parentIsValid(parent, id) || wouldCycle(id, parent) || hasName(next.name, parent, id)) return null;
        next.parentId = parent;
      }
      if (patch.meta && typeof patch.meta === 'object') Object.keys(patch.meta).forEach(function (key) { next[key] = clone(patch.meta[key]); });
      var nextContent = node.type === 'file' ? memory.contents[id] : null;
      if (node.type === 'file' && Object.prototype.hasOwnProperty.call(patch, 'content')) nextContent = typeof patch.content === 'string' ? patch.content : (patch.content == null ? '' : String(patch.content));
      if (node.type === 'file' && Object.prototype.hasOwnProperty.call(patch, 'text')) nextContent = typeof patch.text === 'string' ? patch.text : (patch.text == null ? '' : String(patch.text));
      next.updatedAt = now();
      return putNode(next, nextContent);
    });
  }

  function descendantsOf(id) {
    var result = [];
    var changed = true;
    while (changed) {
      changed = false;
      allNodes().forEach(function (node) {
        if (result.indexOf(node.id) >= 0 || node.id === id) return;
        if (node.parentId === id || result.some(function (childId) {
          return memory.nodes[childId] && memory.nodes[childId].id === node.parentId;
        })) {
          result.push(node.id);
          changed = true;
        }
      });
    }
    return result;
  }

  function deleteNode(id) {
    return withReady(function () {
      var node = getNodeInternal(id);
      if (!node || node.deleted || node.system) return null;
      var ids = [id].concat(descendantsOf(id));
      ids.forEach(function (itemId) {
        var current = memory.nodes[itemId];
        if (!current || current.system) return;
        if (!current.deleted) current.originalParentId = current.parentId;
        current.parentId = itemId === id ? TRASH_ID : current.parentId;
        current.deleted = true;
        current.deletedAt = now();
        current.updatedAt = now();
      });
      return persistMemory().then(function () { return copyNode(memory.nodes[id]); });
    });
  }

  function restoreNode(id) {
    return withReady(function () {
      var node = getNodeInternal(id);
      if (!node || !node.deleted || node.system) return null;
      var targetParent = node.originalParentId;
      var parent = getNodeInternal(targetParent);
      if (!parent || !isFolder(parent) || parent.deleted) targetParent = null;
      if (hasName(node.name, targetParent, id)) return null;
      var ids = [id].concat(node.type === 'folder' ? descendantsOf(id) : []);
      node.parentId = targetParent;
      node.deleted = false;
      delete node.deletedAt;
      node.updatedAt = now();
      ids.forEach(function (childId) {
        if (childId === id) return;
        var child = memory.nodes[childId];
        if (!child || !child.deleted) return;
        var childParent = child.originalParentId;
        var childParentNode = getNodeInternal(childParent);
        if (!childParentNode || childParentNode.deleted || !isFolder(childParentNode) || hasName(child.name, childParent, child.id)) return;
        child.parentId = childParent;
        child.deleted = false;
        delete child.deletedAt;
        child.updatedAt = now();
      });
      return persistMemory().then(function () { return copyNode(node); });
    });
  }

  function clearTrash() {
    return withReady(function () {
      var removed = [];
      allNodes().forEach(function (node) {
        if (node.deleted) {
          removed.push(node.id);
          delete memory.nodes[node.id];
          delete memory.contents[node.id];
        }
      });
      return persistMemory().then(function () { return removed.length; });
    });
  }

  function listNodes(options) {
    return withReady(function () {
      var includeDeleted = !!options && options.includeDeleted === true;
      return allNodes().filter(function (node) { return includeDeleted || !node.deleted; }).map(copyNode);
    });
  }
  function getNode(id) { return withReady(function () { return copyNode(getNodeInternal(id)); }); }
  function getContent(id) {
    return withReady(function () {
      var node = getNodeInternal(id);
      if (!node || node.type !== 'file') return null;
      return Object.prototype.hasOwnProperty.call(memory.contents, id) ? memory.contents[id] : '';
    });
  }
  function setCurrentFile(id) {
    return withReady(function () {
      if (id !== null && id !== undefined) {
        var node = getNodeInternal(id);
        if (!node || node.type !== 'file' || node.deleted) return null;
        memory.meta.currentFileId = id;
      } else memory.meta.currentFileId = null;
      return persistMemory().then(function () { return memory.meta.currentFileId; });
    });
  }
  function getCurrentFileId() {
    return withReady(function () {
      var id = memory.meta.currentFileId;
      var node = getNodeInternal(id);
      return node && node.type === 'file' && !node.deleted ? id : null;
    });
  }
  function getExpandedIds() {
    return withReady(function () { return Array.isArray(memory.meta.expandedIds) ? memory.meta.expandedIds.slice() : []; });
  }
  function setExpandedIds(ids) {
    return withReady(function () {
      var list = Array.isArray(ids) ? ids.filter(function (id, index, all) {
        var node = getNodeInternal(id);
        return typeof id === 'string' && all.indexOf(id) === index && node && isFolder(node) && !node.deleted;
      }) : [];
      memory.meta.expandedIds = list;
      return persistMemory().then(function () { return list.slice(); });
    });
  }

  global.EditorWorkspace = {
    init: initialize,
    listNodes: listNodes,
    getNode: getNode,
    getContent: getContent,
    putFile: putFile,
    putFolder: putFolder,
    updateNode: updateNode,
    deleteNode: deleteNode,
    restoreNode: restoreNode,
    clearTrash: clearTrash,
    setCurrentFile: setCurrentFile,
    getCurrentFileId: getCurrentFileId,
    getExpandedIds: getExpandedIds,
    setExpandedIds: setExpandedIds
  };
}(window));
