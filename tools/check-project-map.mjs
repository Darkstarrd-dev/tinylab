#!/usr/bin/env node
// tools/check-project-map.mjs — verify that every backtick-quoted path
// referenced in PROJECT_MAP.md exists on disk. Prints phantom paths as
// `file:line path` and exits 1 when any are found (silent on success).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAP = path.join(ROOT, 'PROJECT_MAP.md');

const src = fs.readFileSync(MAP, 'utf8');
const lines = src.split('\n');
function inTable(ln) {
  // A line is part of a markdown table when the previous non-empty line starts
  // with '|' or the line itself starts with '|' (file-list rows use `| file |`).
  for (let i = ln; i >= 0 && lines[i].trim() !== ''; i--) {
    if (lines[i].trimStart().startsWith('|')) return true;
    return false;
  }
  return false;
}

// Path-like tokens inside backticks. Two shapes are checked:
//   1. rooted paths: internal/…, web/…, cmd/…, docs/…, tools/…, ref/…
//   2. package-relative file rows inside the §1–§21 file-list tables: bare
//      `name.go`/`name.js` tokens that sit in a table row starting with a
//      backtick (the doc's file-list convention). Bare tokens in prose
//      (bullet/paragraph text) are skipped — they may reference symbols or
//      files of sibling sections and would drown the signal.
const PATH_RE = /`([^`]+)`/g;
const ROOTISH = /^(internal|web|cmd|docs|tools|ref)\/.+/;

const phantoms = [];
const seen = new Set();

function hasGlob(p) {
  return /[*{?]/.test(p);
}

function exists(p) {
  // Strip symbol anchors (path.go:Symbol / path.go#L12 / path.go→summary /
  // parenthesised annotations) before testing the file part.
  const clean = p.replace(/\.(go|js|ts|md|mjs)\b[\s\S]*$/i, '.$1');
  // package.Symbol (internal/app.New) — the package dir is the referent.
  if (!/\.[a-z]+$/.test(clean) && clean.includes('.')) {
    try { return fs.existsSync(path.join(ROOT, clean)); } catch { return true; }
  }
  if (clean.includes(':') && /\.[a-z]+:/i.test(clean)) {
    // pkg/file.go:Symbol — file part before the colon.
    const file = clean.split(':')[0];
    try { return fs.existsSync(path.join(ROOT, file)); } catch { return true; }
  }
  if (clean === '' || clean.endsWith('/')) return true; // directory shorthand
  if (hasGlob(clean)) {
    // Brace/glob shorthand: expand a single * or {a,b} group and test the
    // first candidate — enough to catch renamed directories (the real bug).
    const dir = path.dirname(clean.replace(/\*.*/, 'x'));
    try { return fs.existsSync(path.join(ROOT, dir)); } catch { return true; }
  }
  try { return fs.existsSync(path.join(ROOT, clean)); } catch { return true; }
}

for (let ln = 0; ln < lines.length; ln++) {
  const line = lines[ln];
  let m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(line))) {
    const tok = m[1].trim();
    if (tok.includes(' ') || tok.includes('\n')) continue; // prose, not a path
    if (!ROOTISH.test(tok)) continue;
    // Bare filenames only count inside table rows (the § file-list convention).
    const isBareFile = /^[^/]+\.(go|js|html|css|md|mjs|ps1)$/.test(tok);
    if (!isBareFile && !ROOTISH.test(tok)) continue;
    if (isBareFile && !ROOTISH.test(tok) && !inTable(ln)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    if (!exists(tok)) phantoms.push({ line: ln + 1, path: tok });
  }
}

if (phantoms.length === 0) {
  console.log('PROJECT_MAP: 0 phantoms');
  process.exit(0);
}
for (const p of phantoms) console.log(`PROJECT_MAP.md:${p.line}  ${p.path}`);
console.log(`PROJECT_MAP: ${phantoms.length} phantoms`);
process.exit(1);
