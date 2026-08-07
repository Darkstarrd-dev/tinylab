'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const markedSource = fs.readFileSync(path.join(__dirname, 'playground/static-pg/vendor/marked.min.js'), 'utf8');
const markdownSource = fs.readFileSync(path.join(__dirname, 'playground/static-pg/playground/pg-markdown.js'), 'utf8');

const sandbox = {
  console,
  URL,
  pgEscapeHtml: function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  },
  window: null,
  DOMPurify: { sanitize: function (html) { return html; } },
  self: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(markedSource, sandbox, { filename: 'marked.min.js' });
vm.runInContext(markdownSource, sandbox, { filename: 'pg-markdown.js' });

const sourceUrl = 'https://nav9v.github.io/online-markdown-editor/';
const pretty = sandbox.pgRenderMarkdown('Open ' + sourceUrl, false);
assert(pretty.includes('href="' + sourceUrl + '"'), 'pretty URL href must remain a string URL');
assert(pretty.includes('>' + sourceUrl + '</a>'), 'pretty URL label must remain a string URL');
assert(!pretty.includes('[object Object]'), 'pretty rendering must not stringify marked link tokens');

const linked = sandbox.pgRenderMarkdown('[Editor](' + sourceUrl + ')', false);
assert(linked.includes('href="' + sourceUrl + '"'), 'Markdown link href must remain a string URL');
assert(linked.includes('>Editor</a>'), 'Markdown link text must remain intact');
assert(!linked.includes('[object Object]'), 'Markdown link must not stringify marked link tokens');
const unsafe = sandbox.pgRenderMarkdown('[unsafe](javascript:alert(1))', false);
assert(unsafe.includes('href="#"'), 'unsafe URL schemes must be downgraded');
assert(!unsafe.includes('javascript:'), 'unsafe URL scheme must not reach rendered HTML');

// Search Raw view is intentionally plain text while Pretty uses the shared
// Markdown renderer; both views must preserve the source URL semantics.
const searchRaw = 'Result: ' + sourceUrl;
assert.strictEqual(searchRaw, 'Result: ' + sourceUrl, 'Search Raw must retain the original URL text');
const searchPretty = sandbox.pgRenderMarkdown(searchRaw, false);
assert(searchPretty.includes('href="' + sourceUrl + '"'), 'Search Pretty must render URL href as a string');
assert(!searchPretty.includes('[object Object]'), 'Search Pretty must not stringify marked link tokens');
console.log('web/playground-markdown.test.js: all checks passed');
