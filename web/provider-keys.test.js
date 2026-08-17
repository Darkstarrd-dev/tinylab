'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSource = fs.readFileSync(path.join(__dirname, 'static/app.js'), 'utf8');
const providersSource = fs.readFileSync(path.join(__dirname, 'static/providers.js'), 'utf8');

const elementMap = {};
function createMockElement(id) {
  const el = {
    id: id,
    innerHTML: '',
    textContent: '',
    classList: {
      _classes: new Set(),
      add: function (c) { this._classes.add(c); },
      remove: function (c) { this._classes.delete(c); },
      contains: function (c) { return this._classes.has(c); },
      toggle: function (c, force) {
        if (force !== undefined) {
          if (force) this._classes.add(c); else this._classes.delete(c);
        } else {
          if (this._classes.has(c)) this._classes.delete(c); else this._classes.add(c);
        }
      }
    },
    attributes: {},
    getAttribute: function (k) { return this.attributes[k]; },
    setAttribute: function (k, v) { this.attributes[k] = String(v); }
  };
  elementMap[id] = el;
  return el;
}

const sandbox = {
  console,
  document: {
    getElementById: function (id) {
      if (!elementMap[id]) createMockElement(id);
      return elementMap[id];
    },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {}
  },
  window: {
    addEventListener: function () {},
    removeEventListener: function () {}
  },
  t: function (k, args) {
    if (k === 'keysTitle') return 'Keys';
    if (k === 'addKey') return 'Add Key';
    if (k === 'bulkAdd') return 'Bulk Add';
    if (k === 'keyName') return 'Name';
    if (k === 'actions') return 'Actions';
    if (k === 'key') return 'Key';
    if (k === 'priority') return 'Priority';
    if (k === 'status') return 'Status';
    if (k === 'test') return 'Test';
    if (k === 'pause') return 'Pause';
    if (k === 'resume') return 'Resume';
    if (k === 'delete') return 'Delete';
    if (k === 'clickToCopy') return 'Click to copy';
    if (k === 'noKeys') return 'No keys';
    if (k === 'active') return 'Active';
    return k;
  },
  escapeHtml: function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  },
  escapeAttr: function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  },
  escapeForJsString: function (v) {
    return String(v == null ? '' : v).replace(/['\\]/g, '\\$&');
  },
  emptyState: function (msg) { return '<div class="empty">' + msg + '</div>'; },
  renderStepperHtml: function () { return '<input>'; },
  toast: function () {},
  currentProviderId: null,
  providerDetailCache: null,
  providersCache: []
};

sandbox.globalThis = sandbox;

vm.createContext(sandbox);

// Run subset of app.js maskKey and providers.js
vm.runInContext(appSource, sandbox, { filename: 'app.js' });
vm.runInContext(providersSource, sandbox, { filename: 'providers.js' });

// 1. Test maskKey logic:
assert.strictEqual(sandbox.maskKey(''), '***', 'empty key returns ***');
assert.strictEqual(sandbox.maskKey('12345678'), '***', '8-char key returns ***');
assert.strictEqual(sandbox.maskKey('sk-1234567890abcdef'), 'sk-1****cdef', 'shows head 4 + **** + tail 4');
assert.strictEqual(sandbox.maskKey('sk-abcdefghij'), 'sk-a****ghij', 'shows head 4 + **** + tail 4');

// 2. Test renderDetailKeys output
const testProvider = {
  id: 'prov-1',
  name: 'Test Provider',
  keys: [
    { id: 'k1', name: 'Main', key: 'sk-1234567890abcdef', priority: 1, isActive: true }
  ]
};

const detailKeysEl = createMockElement('detail-keys');
sandbox.renderDetailKeys(testProvider);

assert(detailKeysEl.innerHTML.includes('sk-1****cdef'), 'should render masked key by default');
assert(detailKeysEl.innerHTML.includes('data-copy="sk-1234567890abcdef"'), 'data-copy must contain the real full key');
assert(detailKeysEl.innerHTML.includes('toggleKeyReveal'), 'should include reveal toggle button');

// 3. Test toggleKeyReveal
const dispEl = createMockElement('k-disp-k1');
dispEl.setAttribute('data-masked', 'sk-1****cdef');
dispEl.setAttribute('data-raw', 'sk-1234567890abcdef');
dispEl.setAttribute('data-showing-raw', 'false');
dispEl.textContent = 'sk-1****cdef';

const mockBtn = { style: { opacity: '0.75' } };

// Reveal raw key
sandbox.toggleKeyReveal(mockBtn, 'k1');
assert.strictEqual(dispEl.textContent, 'sk-1234567890abcdef', 'revealed text must be the raw full key');
assert.strictEqual(dispEl.getAttribute('data-showing-raw'), 'true');
assert.strictEqual(mockBtn.style.opacity, '1');

// Hide raw key back to masked
sandbox.toggleKeyReveal(mockBtn, 'k1');
assert.strictEqual(dispEl.textContent, 'sk-1****cdef', 'masked text must be head 4 + **** + tail 4');
assert.strictEqual(dispEl.getAttribute('data-showing-raw'), 'false');
assert.strictEqual(mockBtn.style.opacity, '0.75');

console.log('web/provider-keys.test.js: all checks passed');
