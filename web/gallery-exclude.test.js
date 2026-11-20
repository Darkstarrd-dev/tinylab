'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function readRepoFile(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function makeElement(id) {
    const attributes = {};
    return {
        id: id || '',
        textContent: '',
        innerHTML: '',
        title: '',
        className: '',
        style: {},
        dataset: {},
        attributes,
        setAttribute(k, v) { attributes[String(k)] = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(attributes, k) ? attributes[k] : null; },
        removeAttribute(k) { delete attributes[String(k)]; },
        classList: {
            _set: new Set(),
            add(...cls) { cls.forEach(c => this._set.add(c)); },
            remove(...cls) { cls.forEach(c => this._set.delete(c)); },
            toggle(c, force) {
                if (force === undefined) {
                    if (this._set.has(c)) this._set.delete(c);
                    else this._set.add(c);
                } else if (force) {
                    this._set.add(c);
                } else {
                    this._set.delete(c);
                }
            },
            contains(c) { return this._set.has(c); }
        },
        listeners: {},
        addEventListener(ev, fn) {
            (this.listeners[ev] = this.listeners[ev] || []).push(fn);
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        appendChild() {},
        focus() {},
        remove() {}
    };
}

function testI18nAndScriptRegistration() {
    // 1. Evaluate i18n.js and ensure every galleryExclude* key used in gallery JS exists in both en and cn.
    const i18nSrc = readRepoFile('web/static/i18n.js');
    const i18nSandbox = {
        window: {},
        localStorage: { getItem: () => null, setItem: () => {} },
        document: { documentElement: {} },
        console
    };
    vm.runInNewContext(i18nSrc + '\n;window.__L = typeof L !== "undefined" ? L : window.L;', i18nSandbox, { filename: 'web/static/i18n.js' });
    const dict = i18nSandbox.window.__L;
    assert.ok(dict && dict.en && dict.cn, 'i18n dictionaries (en, cn) must be defined');

    const enKeys = Object.keys(dict.en).filter(k => k.startsWith('galleryExclude')).sort();
    const cnKeys = Object.keys(dict.cn).filter(k => k.startsWith('galleryExclude')).sort();
    assert.ok(enKeys.length >= 15, `expected galleryExclude* i18n keys, found ${enKeys.length}`);
    assert.deepStrictEqual(enKeys, cnKeys, 'en and cn galleryExclude* keys must match identically');
    for (const k of enKeys) {
        assert.strictEqual(typeof dict.en[k], 'string');
        assert.ok(dict.en[k].length > 0, `en.${k} must be non-empty`);
        assert.strictEqual(typeof dict.cn[k], 'string');
        assert.ok(dict.cn[k].length > 0, `cn.${k} must be non-empty`);
    }

    // Check every t('galleryExclude...') reference in gallery-exclude.js and gallery-tree.js resolves.
    for (const file of ['web/playground/static-pg/gallery/gallery-exclude.js', 'web/playground/static-pg/gallery/gallery-tree.js']) {
        const src = readRepoFile(file);
        const re = /\bt\(\s*['"](galleryExclude[^'"]+)['"]/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            const key = m[1];
            assert.ok(Object.prototype.hasOwnProperty.call(dict.en, key), `${file} references missing en key: ${key}`);
            assert.ok(Object.prototype.hasOwnProperty.call(dict.cn, key), `${file} references missing cn key: ${key}`);
        }
    }

    // 2. Check script registration order in web/static/index.html and internal/feature/feature.go.
    const indexHtml = readRepoFile('web/static/index.html');
    const treeTag = '<script src="/gallery/gallery-tree.js"></script>';
    const exTag = '<script src="/gallery/gallery-exclude.js"></script>';
    assert.ok(indexHtml.includes(exTag), 'web/static/index.html must include gallery/gallery-exclude.js');
    assert.ok(indexHtml.indexOf(treeTag) < indexHtml.indexOf(exTag), 'gallery-exclude.js must load after gallery-tree.js in index.html');

    const featureGo = readRepoFile('internal/feature/feature.go');
    const treeGoIdx = featureGo.indexOf('"gallery/gallery-tree.js"');
    const exGoIdx = featureGo.indexOf('"gallery/gallery-exclude.js"');
    assert.ok(exGoIdx !== -1, 'internal/feature/feature.go must embed gallery/gallery-exclude.js');
    assert.ok(treeGoIdx < exGoIdx, 'gallery/gallery-exclude.js must appear after gallery/gallery-tree.js in feature.go');
}

function testShortcutsPresetsAndMatching() {
    const shortcutsSrc = readRepoFile('web/static/shortcuts.js');
    const sandbox = {
        window: { addEventListener: () => {}, navigator: { platform: 'Win32' } },
        navigator: { platform: 'Win32' },
        document: { addEventListener: () => {}, activeElement: null },
        localStorage: { getItem: () => null, setItem: () => {} },
        T: (k) => k,
        console
    };
    sandbox.window.window = sandbox.window;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(shortcutsSrc, ctx, { filename: 'web/static/shortcuts.js' });

    const Shortcuts = sandbox.window.Shortcuts;
    assert.ok(Shortcuts, 'window.Shortcuts API must exist');

    const bExclude = Shortcuts.defaultBinding('gallery.exclude-hash');
    const bUnexclude = Shortcuts.defaultBinding('gallery.unexclude-hash');
    const bToggle = Shortcuts.defaultBinding('gallery.toggle-exclude');
    assert.ok(bExclude && bExclude.key === 'p' && !bExclude.alt && !bExclude.ctrlOrCmd, 'gallery.exclude-hash default must be P');
    assert.ok(bUnexclude && bUnexclude.key === 'p' && bUnexclude.alt === true && !bUnexclude.ctrlOrCmd, 'gallery.unexclude-hash default must be Alt+P');
    assert.ok(bToggle && bToggle.key === 'p' && bToggle.ctrlOrCmd === true && bToggle.alt === true, 'gallery.toggle-exclude default must be Ctrl+Alt+P');

    // No intra-region or cross-region conflicts for the three gallery exclude presets.
    assert.strictEqual(Shortcuts.findConflict('gallery.exclude-hash', bExclude), null);
    assert.strictEqual(Shortcuts.findConflict('gallery.unexclude-hash', bUnexclude), null);
    assert.strictEqual(Shortcuts.findConflict('gallery.toggle-exclude', bToggle), null);

    const evtP = { key: 'p', code: 'KeyP', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    const evtAltP = { key: 'π', code: 'KeyP', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false };
    const evtCtrlAltP = { key: 'p', code: 'KeyP', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false };

    assert.strictEqual(Shortcuts.matchEvent('gallery.exclude-hash', evtP), true, 'P should match gallery.exclude-hash');
    assert.strictEqual(Shortcuts.matchEvent('gallery.unexclude-hash', evtP), false, 'P must not match gallery.unexclude-hash');
    assert.strictEqual(Shortcuts.matchEvent('gallery.toggle-exclude', evtP), false, 'P must not match gallery.toggle-exclude');

    assert.strictEqual(Shortcuts.matchEvent('gallery.unexclude-hash', evtAltP), true, 'Alt+P (dead-key π with code=KeyP) should match gallery.unexclude-hash');
    assert.strictEqual(Shortcuts.matchEvent('gallery.exclude-hash', evtAltP), false, 'Alt+P must not match gallery.exclude-hash');
    assert.strictEqual(Shortcuts.matchEvent('gallery.toggle-exclude', evtAltP), false, 'Alt+P must not match gallery.toggle-exclude');

    assert.strictEqual(Shortcuts.matchEvent('gallery.toggle-exclude', evtCtrlAltP), true, 'Ctrl+Alt+P should match gallery.toggle-exclude');
    assert.strictEqual(Shortcuts.matchEvent('gallery.exclude-hash', evtCtrlAltP), false, 'Ctrl+Alt+P must not match gallery.exclude-hash');
    assert.strictEqual(Shortcuts.matchEvent('gallery.unexclude-hash', evtCtrlAltP), false, 'Ctrl+Alt+P must not match gallery.unexclude-hash');
}

function createGalleryExcludeSandbox(fetchHandler) {
    const elements = new Map();
    const getEl = (id) => {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
    };

    const calls = {
        updateDirStructure: 0,
        updateCurrentFolderItems: 0,
        renderThumbnails: 0,
        renderTreePanel: 0,
        renderActive: [],
        showMsg: [],
        pgShowModal: [],
        pgCloseModal: 0
    };

    function natCmp(a, b) {
        return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
    }

    const sandbox = {
        window: {},
        document: {
            getElementById: getEl,
            createElement: (tag) => makeElement(tag),
            querySelectorAll: () => [],
            addEventListener: () => {}
        },
        URL: {
            createObjectURL: (b) => 'blob:mock-' + Math.random().toString(36).slice(2),
            revokeObjectURL: () => {}
        },
        Blob: function MockBlob(parts) { this.parts = parts; },
        crypto: require('crypto').webcrypto,
        fetch: fetchHandler || (async () => ({ ok: true, json: async () => ({}) })),
        t: (k) => k,
        T: (k) => k,
        escapeHtml: (s) => String(s),
        showMsg: (msg, type) => calls.showMsg.push({ msg, type }),
        naturalComparePath: natCmp,
        getDirPath: (rel) => {
            if (rel && typeof rel === 'object' && rel.dirPath !== undefined) return rel.dirPath;
            const s = typeof rel === 'string' ? rel : ((rel && (rel.rel || rel.name)) || '');
            const idx = s.lastIndexOf('/');
            return idx >= 0 ? s.slice(0, idx) : '';
        },
        sortItems: (arr, key, dir) => [...arr].sort((a, b) => {
            const sign = dir === -1 ? -1 : 1;
            if (key === 'size') return sign * ((a.size || 0) - (b.size || 0));
            return sign * natCmp(a.name || a.rel, b.name || b.rel);
        }),
        pgShowModal: (opts) => calls.pgShowModal.push(opts),
        pgCloseModal: () => { calls.pgCloseModal++; },
        updateDirStructure: () => { calls.updateDirStructure++; },
        updateCurrentFolderItems: () => { calls.updateCurrentFolderItems++; },
        renderThumbnails: () => { calls.renderThumbnails++; },
        renderTreePanel: () => { calls.renderTreePanel++; },
        renderActive: (it) => { calls.renderActive.push(it); },
        getItemBlob: async (it) => ({
            size: it.size || 4,
            arrayBuffer: async () => Buffer.from(it.content || it.name || 'img')
        }),
        rehydrateZipSession: async () => false,
        console,
        setTimeout,
        clearTimeout,
        Map,
        Set,
        Promise,
        Array,
        Object,
        Math,
        Number,
        String,
        Boolean,
        JSON
    };
    sandbox.window = sandbox;

    const ctx = vm.createContext(sandbox);
    vm.runInContext(readRepoFile('web/playground/static-pg/gallery/gallery-state.js'), ctx, { filename: 'gallery-state.js' });
    vm.runInContext(readRepoFile('web/playground/static-pg/gallery/gallery-exclude.js'), ctx, { filename: 'gallery-exclude.js' });
    sandbox.showMsg = (msg, type) => calls.showMsg.push({ msg, type });
    ctx.showMsg = sandbox.showMsg;
    sandbox.galleryState = vm.runInContext('galleryState', ctx);

    return { sandbox, calls, elements };
}

function makePackItems(count, dirKey) {
    const items = [];
    for (let i = 1; i <= count; i++) {
        const num = String(i).padStart(2, '0');
        const rel = dirKey ? `${dirKey}/${num}.jpg` : `${num}.jpg`;
        items.push({
            id: `item-${i}`,
            name: `${num}.jpg`,
            path: rel,
            rel: rel,
            dirPath: dirKey || '',
            size: (count + 1 - i) * 1000, // deliberately inverse size vs natural name order
            kind: 'image'
        });
    }
    return items;
}

async function testPackExcludeSliceNaturalOrder() {
    const { sandbox } = createGalleryExcludeSandbox();
    const gs = sandbox.galleryState;

    // Deliberately store rawItems in shuffled order + set UI sort to descending by size.
    const items = makePackItems(20, 'packA');
    const shuffled = [...items].reverse();
    gs.rawItems = shuffled;
    gs.items = [...shuffled];
    gs.imageTreeSort = { key: 'size', dir: -1 };

    const allSlice = sandbox.getPackExcludeSlice('packA', { scope: 'all', count: 10 });
    assert.strictEqual(allSlice.length, 20);
    assert.strictEqual(allSlice[0].name, '01.jpg');
    assert.strictEqual(allSlice[19].name, '20.jpg');

    const headSlice = sandbox.getPackExcludeSlice('packA', { scope: 'head', count: 5 });
    assert.deepStrictEqual([...headSlice.map(x => x.name)], ['01.jpg', '02.jpg', '03.jpg', '04.jpg', '05.jpg']);

    const tailSlice = sandbox.getPackExcludeSlice('packA', { scope: 'tail', count: 5 });
    assert.deepStrictEqual([...tailSlice.map(x => x.name)], ['16.jpg', '17.jpg', '18.jpg', '19.jpg', '20.jpg']);

    // Even when imageTreeSort is name descending, getPackExcludeSlice still uses natural ascending order.
    gs.imageTreeSort = { key: 'name', dir: -1 };
    const tailSlice2 = sandbox.getPackExcludeSlice('packA', { scope: 'tail', count: 3 });
    assert.deepStrictEqual([...tailSlice2.map(x => x.name)], ['18.jpg', '19.jpg', '20.jpg']);
}

async function testApplyExcludeProjectionToggleAndCurItem() {
    const { sandbox, calls } = createGalleryExcludeSandbox();
    const gs = sandbox.galleryState;

    const items = makePackItems(20, 'packB');
    // Mark items 16..20 as excluded by hash.
    for (let i = 15; i < 20; i++) {
        items[i]._excludedByHash = true;
    }
    gs.rawItems = items;
    gs.items = [...items];
    gs.curDirPath = 'packB';
    gs.index = 2; // 03.jpg survives

    // Configure exclude enabled = true.
    gs.exclude.config.enabled = true;
    sandbox.applyExcludeProjection();
    assert.strictEqual(gs.items.length, 15, 'enabled exclude should project 20 rawItems down to 15 visible items');
    assert.strictEqual(gs.rawItems.length, 20, 'rawItems must remain untouched at 20');
    assert.strictEqual(gs.items[gs.index].id, 'item-3', 'surviving active item must stay selected');
    assert.strictEqual(calls.renderActive.length, 0, 'surviving active item should not force renderActive');

    // Now set active item to an excluded item (item-18) while toggling OFF then ON.
    gs.exclude.config.enabled = false;
    sandbox.applyExcludeProjection();
    assert.strictEqual(gs.items.length, 20, 'disabled exclude should restore all 20 items');
    assert.strictEqual(gs.items[17]._excludedByHash, true, '_excludedByHash badge flag must persist when disabled');

    gs.index = 17; // 18.jpg (excluded)
    calls.renderActive.length = 0;
    gs.exclude.config.enabled = true;
    sandbox.applyExcludeProjection();
    assert.strictEqual(gs.items.length, 15);
    assert.ok(gs.index >= 0 && gs.items[gs.index] && !gs.items[gs.index]._excludedByHash, 'active index should advance to a non-excluded item when current becomes hidden');
    assert.ok(calls.renderActive.length >= 1, 'advancing active item must invoke renderActive');
}

async function testExcludeAndUnexcludeCurrentImage() {
    const fetchCalls = [];
    const hashA = 'a'.repeat(64);
    const { sandbox } = createGalleryExcludeSandbox(async (url, opts) => {
        const body = opts && opts.body ? JSON.parse(opts.body) : null;
        fetchCalls.push({ url, method: (opts && opts.method) || 'GET', body });
        if (url === '/api/gallery/exclude-hashes' && (!opts || !opts.method || opts.method === 'GET')) {
            return {
                ok: true,
                json: async () => ({
                    config: { ...sandbox.galleryState.exclude.config },
                    count: 0,
                    sizes: [],
                    hasUnsized: false
                })
            };
        }
        if (url === '/api/gallery/exclude-hashes/add') {
            return {
                ok: true,
                json: async () => ({
                    added: true,
                    duplicate: false,
                    hash: hashA,
                    size: 4,
                    count: 1
                })
            };
        }
        if (url === '/api/gallery/exclude-hashes/remove') {
            return {
                ok: true,
                json: async () => ({
                    removed: true,
                    hash: hashA,
                    count: 0
                })
            };
        }
        return { ok: true, json: async () => ({}) };
    });

    const gs = sandbox.galleryState;
    const items = makePackItems(4, 'packC');
    gs.rawItems = items;
    gs.items = [...items];
    gs.curDirPath = 'packC';
    gs.index = 3;
    gs.exclude.config.enabled = true;
    gs.exclude.loaded = true;

    await sandbox.excludeCurrentImage();
    assert.strictEqual(fetchCalls.some(c => c.url === '/api/gallery/exclude-hashes/add'), true, 'must POST /api/gallery/exclude-hashes/add');
    assert.strictEqual(items[3]._excludedByHash, true, 'excluded item must be flagged _excludedByHash=true');
    assert.strictEqual(items[3]._excludedHash, hashA, 'excluded item must record _excludedHash');
    assert.strictEqual(gs.items.length, 3, 'when enabled, excludeCurrentImage must immediately hide the excluded item');
    assert.strictEqual(gs.rawItems.length, 4, 'rawItems must still contain all 4 items');

    // Now disable exclude so item-4 becomes visible again, select it, and unexclude via Alt+P path.
    gs.exclude.config.enabled = false;
    sandbox.applyExcludeProjection();
    assert.strictEqual(gs.items.length, 4);
    gs.index = 3;

    await sandbox.unexcludeCurrentImage();
    assert.strictEqual(fetchCalls.some(c => c.url === '/api/gallery/exclude-hashes/remove'), true, 'must POST /api/gallery/exclude-hashes/remove');
    assert.ok(!items[3]._excludedByHash, 'unexcludeCurrentImage must clear _excludedByHash');
    assert.ok(!items[3]._excludedHash, 'unexcludeCurrentImage must clear _excludedHash');
}

async function testToggleGalleryExcludeAndDuplicate() {
    let toggleCalls = 0;
    const hashB = 'b'.repeat(64);
    const { sandbox, calls } = createGalleryExcludeSandbox(async (url, opts) => {
        if (url === '/api/gallery/exclude-hashes' && (!opts || !opts.method || opts.method === 'GET')) {
            return {
                ok: true,
                json: async () => ({
                    config: { ...sandbox.galleryState.exclude.config },
                    count: 5,
                    sizes: [],
                    hasUnsized: true
                })
            };
        }
        if (url === '/api/settings') {
            toggleCalls++;
            const body = JSON.parse(opts.body);
            return { ok: true, json: async () => ({ galleryExclude: body.galleryExclude }) };
        }
        if (url === '/api/gallery/exclude-hashes/add') {
            return {
                ok: true,
                json: async () => ({
                    added: false,
                    duplicate: true,
                    hash: hashB,
                    size: 4,
                    count: 5
                })
            };
        }
        return { ok: true, json: async () => ({}) };
    });

    const gs = sandbox.galleryState;
    const items = makePackItems(5, 'packD');
    items[4]._excludedByHash = true;
    gs.rawItems = items;
    gs.items = [...items];
    gs.curDirPath = 'packD';
    gs.index = 0;
    gs.exclude.loaded = true;
    gs.exclude.config.enabled = true;
    gs.exclude.config.scope = 'tail';
    gs.exclude.config.count = 10;

    sandbox.applyExcludeProjection();
    assert.strictEqual(gs.items.length, 4);

    // Toggle OFF
    await sandbox.toggleGalleryExclude();
    assert.strictEqual(toggleCalls, 1);
    assert.strictEqual(gs.exclude.config.enabled, false);
    assert.strictEqual(gs.items.length, 5);

    // Trigger duplicate excludeCurrentImage while disabled -> item stays visible but marked.
    gs.index = 2;
    await sandbox.excludeCurrentImage();
    assert.strictEqual(items[2]._excludedByHash, true);
    assert.strictEqual(items[2]._excludedHash, hashB);
    assert.strictEqual(gs.items.length, 5, 'when exclude is disabled, marking item keeps it visible');
    assert.ok(calls.showMsg.length > 0, 'duplicate add must notify user via showMsg');
}

async function testCheckExcludeForDir() {
    const checkRequests = [];
    const hashC = 'c'.repeat(64);
    const hashD = 'd'.repeat(64);
    const { sandbox } = createGalleryExcludeSandbox(async (url, opts) => {
        if (url === '/api/gallery/exclude-hashes/check') {
            const body = JSON.parse(opts.body);
            checkRequests.push(body);
            return {
                ok: true,
                json: async () => ({
                    matched: ['packE/07.jpg', 'packE/08.jpg'],
                    matchedHashes: {
                        'packE/07.jpg': hashC,
                        'packE/08.jpg': hashD
                    }
                })
            };
        }
        return { ok: true, json: async () => ({}) };
    });

    const gs = sandbox.galleryState;
    const items = makePackItems(8, 'packE').map((it, idx) => ({
        ...it,
        kind: 'zip',
        sessionId: 's1',
        zipPath: `packE/${String(idx + 1).padStart(2, '0')}.jpg`
    }));
    // Deliberately store rawItems in reverse order & set size-desc UI sort.
    const reversed = [...items].reverse();
    gs.rawItems = reversed;
    gs.items = [...reversed];
    gs.curDirPath = 'packE';
    gs.index = 0;
    gs.imageTreeSort = { key: 'size', dir: -1 };
    gs.exclude.loaded = true;
    gs.exclude.count = 2;
    gs.exclude.config = { enabled: true, scope: 'tail', count: 3 };

    await sandbox.checkExcludeForDir('packE');

    assert.strictEqual(checkRequests.length, 1, 'checkExcludeForDir must POST /api/gallery/exclude-hashes/check once');
    assert.strictEqual(checkRequests[0].sessionId, 's1');
    assert.deepStrictEqual(checkRequests[0].entries, ['packE/06.jpg', 'packE/07.jpg', 'packE/08.jpg'], 'must check only tail N entries in natural ascending order');

    assert.strictEqual(items[6]._excludedByHash, true);
    assert.strictEqual(items[6]._excludedHash, hashC);
    assert.strictEqual(items[7]._excludedByHash, true);
    assert.strictEqual(items[7]._excludedHash, hashD);
    assert.strictEqual(items[5]._excludedByHash, false);
    assert.strictEqual(gs.items.length, 6, 'visible items must exclude the 2 matched entries');
    assert.strictEqual(gs.rawItems.length, 8, 'rawItems must retain all 8 entries');
}

async function main() {
    testI18nAndScriptRegistration();
    testShortcutsPresetsAndMatching();
    await testPackExcludeSliceNaturalOrder();
    await testApplyExcludeProjectionToggleAndCurItem();
    await testExcludeAndUnexcludeCurrentImage();
    await testToggleGalleryExcludeAndDuplicate();
    await testCheckExcludeForDir();
    console.log('ALL gallery-exclude tests passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
