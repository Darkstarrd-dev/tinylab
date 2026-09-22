// web/pg-code-block.test.js
// Contract test for the bubble code-block / preview affordances:
//   - every code block gets a copy button whose click copies the block's text
//   - the copy button lives in a wrapper AROUND `pre`, never inside it: `pre`
//     scrolls horizontally, and an absolutely positioned child would be dragged
//     away from the corner by `scrollLeft`
//   - an HTML/SVG block still renders the inline preview, whose header carries
//     the expand button that opens the (sandboxed, no-script) preview modal
//
// Run:  node web/pg-code-block.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log('  ok  ' + name);
  }).catch((err) => {
    failures++;
    console.error('  FAIL ' + name + ': ' + (err && (err.stack || err.message || err)));
  });
}

// --- minimal DOM -----------------------------------------------------------
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    attrs: {},
    children: [],
    parentNode: null,
    listeners: {},
    classList: {
      add(c) { if (!el.className.split(/\s+/).includes(c)) el.className = (el.className + ' ' + c).trim(); },
      remove(c) { el.className = el.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
      contains(c) { return el.className.split(/\s+/).includes(c); },
      toggle(c) { el.classList.contains(c) ? el.classList.remove(c) : el.classList.add(c); },
    },
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      const idx = ref ? el.children.indexOf(ref) : -1;
      child.parentNode = el;
      if (idx < 0) el.children.push(child); else el.children.splice(idx, 0, child);
      return child;
    },
    querySelector(sel) { const all = el.querySelectorAll(sel); return all.length ? all[0] : null; },
    querySelectorAll(sel) {
      const out = [];
      const matches = (node) => sel.startsWith('.')
        ? node.classList.contains(sel.slice(1))
        : node.tagName === sel.toUpperCase();
      (function walk(node) {
        node.children.forEach((c) => { if (matches(c)) out.push(c); walk(c); });
      })(el);
      return out;
    },
  };
  return el;
}

function makeEnv() {
  const overlay = makeEl('div');
  const sandbox = {
    console, setTimeout, clearTimeout, Set, Map, Array, Object, JSON, String, Number, RegExp, Math, Date, Promise, isNaN, parseInt, parseFloat,
    document: {
      createElement: (tag) => makeEl(tag),
      getElementById: (id) => (id === 'pg-modal-overlay' ? overlay : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: makeEl('body'),
    },
    requestAnimationFrame: (cb) => cb(),
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  const files = [
    'web/playground/static-pg/playground/pg-core.js',
    'web/playground/static-pg/playground/pg-render.js',
  ];
  for (const f of files) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }
  const copied = [];
  const modals = [];
  sandbox.pgCopyToClipboard = (text, msg) => { copied.push({ text, msg }); };
  sandbox.pgShowModal = (html, cardClass) => { modals.push({ html, cardClass }); };
  sandbox.pgT = (k, a) => (a && a.length ? k + ':' + a.join(',') : k);
  sandbox.pgEscapeHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  sandbox.pgEscapeAttr = sandbox.pgEscapeHtml;
  sandbox.pgHighlight = () => {};
  sandbox.pgRenderMermaid = () => {};
  if (typeof sandbox.PG_ICON_EXPAND === 'undefined') sandbox.PG_ICON_EXPAND = '<svg class="expand-icon"></svg>';
  return { sandbox, copied, modals, overlay };
}

// A container holding one `pre > code` block, like a rendered bubble body.
function makeContainer(env, { lang, code }) {
  const container = makeEl('div');
  const pre = makeEl('pre');
  const codeEl = makeEl('code');
  if (lang) codeEl.className = 'language-' + lang;
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  container.appendChild(pre);
  return { container, pre, codeEl };
}

async function runAll() {
  console.log('playground code-block / preview affordances');

  await check('code block: wrapped with a copy button that is not inside `pre`', () => {
    const env = makeEnv();
    const { container, pre } = makeContainer(env, { lang: 'js', code: 'const a = 1;\n' });
    env.sandbox.pgPostProcessCode(container, false);
    const block = container.querySelector('.pg-code-block');
    assert.ok(block, 'code block wrapper missing');
    assert.strictEqual(pre.parentNode, block, 'pre must be moved into the wrapper');
    const btn = container.querySelector('.pg-code-copy');
    assert.ok(btn, 'copy button missing');
    assert.strictEqual(btn.parentNode, block, 'copy button must sit in the wrapper, beside pre');
    assert.ok(!pre.querySelectorAll('.pg-code-copy').includes(btn), 'copy button must not be inside the scrolling pre');
    assert.strictEqual(btn.getAttribute('data-tooltip'), 'pgCopyCode');
  });

  await check('code block: clicking the copy button copies the code text', () => {
    const env = makeEnv();
    const { container } = makeContainer(env, { lang: 'js', code: 'const a = 1;\n' });
    env.sandbox.pgPostProcessCode(container, false);
    const btn = container.querySelector('.pg-code-copy');
    assert.strictEqual(btn.listeners.click.length, 1, 'copy button must have exactly one click handler');
    btn.listeners.click[0]();
    assert.strictEqual(env.copied.length, 1);
    assert.strictEqual(env.copied[0].text, 'const a = 1;\n');
    assert.strictEqual(env.copied[0].msg, 'pgCodeCopied');
  });

  await check('code block: a second pass does not wrap the block twice', () => {
    const env = makeEnv();
    const { container } = makeContainer(env, { lang: 'js', code: 'x' });
    env.sandbox.pgPostProcessCode(container, false);
    env.sandbox.pgPostProcessCode(container, false);
    assert.strictEqual(container.querySelectorAll('.pg-code-block').length, 1);
    assert.strictEqual(container.querySelectorAll('.pg-code-copy').length, 1);
  });

  await check('html block: preview header carries the expand button, and no copy button is lost', () => {
    const env = makeEnv();
    const raw = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    const { container, pre } = makeContainer(env, { lang: 'html', code: raw });
    env.sandbox.pgPostProcessCode(container, false);
    const preview = container.querySelector('.pg-html-preview');
    assert.ok(preview, 'inline preview missing');
    assert.strictEqual(preview.parentNode, container, 'preview must be inserted next to the code block');
    const title = preview.querySelector('.pg-html-preview-title');
    assert.ok(title, 'preview header missing');
    const label = title.querySelector('.pg-html-preview-label');
    assert.strictEqual(label.textContent, 'pgHtmlPreview');
    const expand = title.querySelector('.pg-html-preview-expand');
    assert.ok(expand, 'expand button missing from the preview header');
    assert.strictEqual(expand.getAttribute('data-tooltip'), 'pgHtmlPreviewExpand');
    assert.strictEqual(expand.innerHTML, env.sandbox.PG_ICON_EXPAND, 'expand button must use PG_ICON_EXPAND');
    assert.ok(container.querySelector('.pg-code-copy'), 'the html block keeps its copy button');
    assert.strictEqual(pre.parentNode.classList.contains('pg-code-block'), true);
  });

  await check('html block: the expand button opens a sandboxed modal with the raw markup', () => {
    const env = makeEnv();
    const raw = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    const { container } = makeContainer(env, { lang: 'html', code: raw });
    env.sandbox.pgPostProcessCode(container, false);
    const expand = container.querySelector('.pg-html-preview-expand');
    assert.strictEqual(expand.listeners.click.length, 1);
    expand.listeners.click[0]();
    assert.strictEqual(env.modals.length, 1, 'expand must open exactly one modal');
    const { html, cardClass } = env.modals[0];
    assert.strictEqual(cardClass, 'pg-modal pg-html-preview-modal');
    assert.ok(html.indexOf('<iframe class="pg-html-preview-frame" sandbox=""') >= 0, 'modal frame must keep the sandbox');
    assert.ok(html.indexOf('srcdoc="&lt;svg') >= 0, 'modal frame must carry the escaped raw markup');
    assert.ok(html.indexOf('onclick="pgCloseModal()"') >= 0, 'modal needs its close button');
  });

  await check('plain code blocks get no preview', () => {
    const env = makeEnv();
    const { container } = makeContainer(env, { lang: 'python', code: 'print(1)' });
    env.sandbox.pgPostProcessCode(container, false);
    assert.strictEqual(container.querySelectorAll('.pg-html-preview').length, 0);
    assert.ok(container.querySelector('.pg-code-copy'), 'copy button still expected');
  });

  console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

runAll();
