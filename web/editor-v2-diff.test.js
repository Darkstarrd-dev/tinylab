/**
 * Unit tests for Editor V2 Diff Core (Tokenize, Compare, Assemble, CRLF, EOF)
 * Run with Node.js or Bun: node web/editor-v2-diff.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

const Diff = require('./static/vendor/diff.min.js');
const DiffCore = require('./static/utility/editor-v2/editor-v2-diff-core.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.stack || err.message}`);
    failed++;
  }
}

console.log('--- Running Editor V2 Diff Core Tests ---');

// 1. Tokenize Tests
test('tokenize: empty string', () => {
  const tokens = DiffCore.tokenize('');
  assert.strictEqual(tokens.length, 0);
});

test('tokenize: single line without trailing newline (EOF preserved)', () => {
  const tokens = DiffCore.tokenize('hello world');
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0].text, 'hello world');
  assert.strictEqual(tokens[0].eol, '');
  assert.strictEqual(tokens[0].raw, 'hello world');
});

test('tokenize: single line with LF', () => {
  const tokens = DiffCore.tokenize('hello\n');
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0].text, 'hello');
  assert.strictEqual(tokens[0].eol, '\n');
  assert.strictEqual(tokens[0].raw, 'hello\n');
});

test('tokenize: single line with CRLF', () => {
  const tokens = DiffCore.tokenize('hello\r\n');
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0].text, 'hello');
  assert.strictEqual(tokens[0].eol, '\r\n');
  assert.strictEqual(tokens[0].raw, 'hello\r\n');
});

test('tokenize: multi-line mixed CRLF and LF with no trailing newline', () => {
  const text = 'line1\r\nline2\nline3';
  const tokens = DiffCore.tokenize(text);
  assert.strictEqual(tokens.length, 3);
  assert.strictEqual(tokens[0].raw, 'line1\r\n');
  assert.strictEqual(tokens[1].raw, 'line2\n');
  assert.strictEqual(tokens[2].raw, 'line3');
  assert.strictEqual(tokens.map(t => t.raw).join(''), text);
});

test('tokenize: consecutive empty lines', () => {
  const text = '\n\r\n\n';
  const tokens = DiffCore.tokenize(text);
  assert.strictEqual(tokens.length, 3);
  assert.strictEqual(tokens[0].raw, '\n');
  assert.strictEqual(tokens[1].raw, '\r\n');
  assert.strictEqual(tokens[2].raw, '\n');
  assert.strictEqual(tokens.map(t => t.raw).join(''), text);
});

// 2. Compare Tests
test('compare: identical text produces pure context rows', () => {
  const text = 'line 1\nline 2\nline 3\n';
  const rows = DiffCore.compare(text, text, Diff);
  assert.strictEqual(rows.length, 3);
  for (let i = 0; i < rows.length; i++) {
    assert.strictEqual(rows[i].type, 'context');
    assert.strictEqual(rows[i].left.num, i + 1);
    assert.strictEqual(rows[i].right.num, i + 1);
    assert.strictEqual(rows[i].left.text, `line ${i + 1}`);
  }
});

test('compare: complete insertion (empty to new)', () => {
  const oldText = '';
  const newText = 'new line 1\nnew line 2\n';
  const rows = DiffCore.compare(oldText, newText, Diff);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].type, 'add');
  assert.strictEqual(rows[0].left, null);
  assert.strictEqual(rows[0].right.text, 'new line 1');
  assert.strictEqual(rows[1].type, 'add');
  assert.strictEqual(rows[1].right.text, 'new line 2');
});

test('compare: complete deletion (old to empty)', () => {
  const oldText = 'old line 1\nold line 2\n';
  const newText = '';
  const rows = DiffCore.compare(oldText, newText, Diff);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].type, 'del');
  assert.strictEqual(rows[0].left.text, 'old line 1');
  assert.strictEqual(rows[0].right, null);
  assert.strictEqual(rows[1].type, 'del');
  assert.strictEqual(rows[1].left.text, 'old line 2');
  assert.strictEqual(rows[1].right, null);
});

test('compare: modified lines pair adjacent del and add with word-level diff', () => {
  const oldText = 'const a = 1;\n';
  const newText = 'const a = 2;\n';
  const rows = DiffCore.compare(oldText, newText, Diff);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].type, 'mod');
  assert.strictEqual(rows[0].left.text, 'const a = 1;');
  assert.strictEqual(rows[0].right.text, 'const a = 2;');
  assert(rows[0].leftParts.length > 0);
  assert(rows[0].rightParts.length > 0);
  // Word diff should highlight "1;" vs "2;"
  const removedPart = rows[0].leftParts.find(p => p.removed);
  const addedPart = rows[0].rightParts.find(p => p.added);
  assert(removedPart, 'should have removed word part');
  assert(addedPart, 'should have added word part');
});

test('compare: empty line between changes prevents false cross-paragraph pairing', () => {
  const oldText = 'paragraph 1 old\n\nparagraph 2\n';
  const newText = 'paragraph 1 new\n\nparagraph 2 modified\n';
  const rows = DiffCore.compare(oldText, newText, Diff);
  // Row 0: mod (para 1)
  // Row 1: context (empty line)
  // Row 2: mod (para 2)
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].type, 'mod');
  assert.strictEqual(rows[1].type, 'context');
  assert.strictEqual(rows[1].left.text, '');
  assert.strictEqual(rows[1].right.text, '');
  assert.strictEqual(rows[2].type, 'mod');
});

test('compare: large identical document (5000 lines) completes quickly', () => {
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(`function test${i}() { return ${i}; }`);
  const text = lines.join('\n') + '\n';
  const t0 = Date.now();
  const rows = DiffCore.compare(text, text, Diff);
  const elapsed = Date.now() - t0;
  assert.strictEqual(rows.length, 5000);
  assert(elapsed < 2000, `Comparison took too long: ${elapsed}ms`);
});

// 3. Assemble & Decisions Tests
test('assemble: default decisions adopt all revisions (equals newText)', () => {
  const oldText = 'hello old world\nline 2 unchanged\nline 3 will be deleted\n';
  const newText = 'hello new world\nline 2 unchanged\nline 3 inserted\n';
  const rows = DiffCore.compare(oldText, newText, Diff);
  const assembled = DiffCore.assemble(rows, new Map());
  assert.strictEqual(assembled, newText);
});

test('assemble: all reject decisions preserve original (equals oldText)', () => {
  const oldText = 'hello old world\nline 2 unchanged\nline 3 will be deleted\n';
  const newText = 'hello new world\nline 2 unchanged\nline 3 inserted\n';
  const rows = DiffCore.compare(oldText, newText, Diff);
  const decisions = new Map();
  for (const r of rows) {
    decisions.set(r.id, 'reject');
  }
  const assembled = DiffCore.assemble(rows, decisions);
  assert.strictEqual(assembled, oldText);
});

test('assemble: CRLF line endings preserved exactly', () => {
  const oldText = 'row1\r\nrow2\r\n';
  const newText = 'row1\r\nrow2_modified\r\n';
  const rows = DiffCore.compare(oldText, newText, Diff);
  const assembled = DiffCore.assemble(rows, new Map());
  assert.strictEqual(assembled, newText);
  assert(assembled.includes('\r\n'));
  assert(!assembled.includes('\n\n'));
});

test('assemble: EOF without trailing newline preserved exactly', () => {
  const oldText = 'row1\nrow2'; // No trailing \n
  const newText = 'row1\nrow2_mod'; // No trailing \n
  const rows = DiffCore.compare(oldText, newText, Diff);
  const assembled = DiffCore.assemble(rows, new Map());
  assert.strictEqual(assembled, newText);
  assert.strictEqual(assembled.endsWith('row2_mod'), true);
  assert.strictEqual(assembled.endsWith('\n'), false);
});

test('assemble: selective row decisions (accept mod, reject add, reject del)', () => {
  const oldText = 'line1\nline2_del\nline3\n';
  const newText = 'line1_mod\nline3\nline4_add\n';
  const rows = DiffCore.compare(oldText, newText, Diff);

  // decisions:
  // mod: accept -> adopt line1_mod
  // del: reject -> keep line2_del
  // add: reject -> drop line4_add
  const decisions = new Map();
  for (const r of rows) {
    if (r.type === 'mod') decisions.set(r.id, 'accept');
    if (r.type === 'del') decisions.set(r.id, 'reject'); // Keep deleted line
    if (r.type === 'add') decisions.set(r.id, 'reject'); // Drop added line
  }

  const assembled = DiffCore.assemble(rows, decisions);
  const expected = 'line1_mod\nline2_del\nline3\n';
  assert.strictEqual(assembled, expected);
});

// 5. Diff UI Scope and Constant Checks
test('diff ui: ROW_HEIGHT is defined at module scope and not shadowed in renderRowsVirtual', () => {
  const fs = require('fs');
  const diffJsPath = path.join(__dirname, 'static/utility/editor-v2/editor-v2-diff.js');
  const content = fs.readFileSync(diffJsPath, 'utf8');

  // Verify ROW_HEIGHT declaration near the top of the file
  assert.ok(/const\s+ROW_HEIGHT\s*=\s*\d+;/.test(content), 'ROW_HEIGHT must be declared');
  const matches = content.match(/const\s+ROW_HEIGHT\s*=\s*\d+;/g);
  assert.strictEqual(matches.length, 1, 'ROW_HEIGHT should only be declared once at top closure scope');

  // Verify renderRowsVirtual doesn't shadow ROW_HEIGHT
  const renderRowsMatch = content.match(/function\s+renderRowsVirtual\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(renderRowsMatch, 'renderRowsVirtual must exist');
  assert.ok(!renderRowsMatch[1].includes('const ROW_HEIGHT'), 'renderRowsVirtual should not shadow ROW_HEIGHT');
});

console.log(`\nDiff Core Test Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
