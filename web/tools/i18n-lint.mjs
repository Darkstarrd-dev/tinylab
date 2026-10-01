#!/usr/bin/env node
// i18n-lint.mjs — TinyLab i18n static checker & pruner (no deps).
//
// Modes:
//   node web/tools/i18n-lint.mjs check          Report issues; exit 1 on
//                                               dup-keys / keyset-diff /
//                                               placeholder-mismatch / empty.
//                                               Unused keys are reported but
//                                               do not fail (pruned in Phase B).
//   node web/tools/i18n-lint.mjs --prune        Delete zero-reference keys from
//                                               both dictionaries, then verify
//                                               with `node --check`.
//
// Dictionaries:
//   web/static/i18n.js                          const L = { en: {...}, cn: {...} }
//   web/playground/static-pg/playground/pg-i18n.js   window.PG_I18N = { en: {...}, cn: {...} }
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DICTS = [
  {
    file: 'web/static/i18n.js',
    label: 'host',
    // top-level locale block: newline + exactly-2-space indent + `en:`/`cn:`
    localeRe: (loc) => new RegExp('\\n  ' + loc + ':\\s*\\{'),
  },
  {
    file: 'web/playground/static-pg/playground/pg-i18n.js',
    label: 'pg',
    localeRe: (loc) => new RegExp('\\n  ' + loc + ':\\s*\\{'),
  },
];

// Keys referenced only via dynamic concatenation — treat as used.
const DYNAMIC_PREFIXES = ['demoSub', 'assistantStateGroup'];

// ---------------------------------------------------------------- scanning
// Locale blocks contain ONLY flat string entries (verified); values are
// single-line quoted strings (no template literals). Scanner walks the block,
// skips comments/whitespace, and records exact file offsets so --prune can
// splice entries out safely even with several keys per line.

function findLocaleBlock(src, re) {
  const m = src.match(re);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  let depth = 0, inStr = null, esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { start: open, end: i }; }
  }
  return null;
}

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

function scanEntries(src, block) {
  const entries = [];
  let i = block.start + 1;
  const identRe = /[A-Za-z_$][A-Za-z0-9_$]*/y;
  const readString = (start) => {
    const q = src[start];
    let k = start + 1, esc2 = false;
    while (k < block.end) {
      const ch = src[k];
      if (esc2) esc2 = false;
      else if (ch === '\\') esc2 = true;
      else if (ch === q) break;
      k++;
    }
    if (k >= block.end) throw new Error(`unterminated string at offset ${start}`);
    return { text: src.slice(start + 1, k), end: k + 1 };
  };
  while (i < block.end) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? block.end : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i); i = e < 0 ? block.end : e + 2; continue; }
    let key, keyEnd;
    if (c === "'" || c === '"') {
      const s = readString(i);
      key = s.text;
      keyEnd = s.end;
    } else {
      identRe.lastIndex = i;
      const m = identRe.exec(src);
      if (!m) throw new Error(`unexpected char ${JSON.stringify(c)} at offset ${i}`);
      key = m[0];
      keyEnd = identRe.lastIndex;
    }
    let j = keyEnd;
    while (j < block.end && /\s/.test(src[j])) j++;
    if (src[j] !== ':') throw new Error(`expected ':' after key ${key} at offset ${j}`);
    j++;
    while (j < block.end && /\s/.test(src[j])) j++;
    if (src[j] !== "'" && src[j] !== '"') throw new Error(`expected quote for value of ${key} at offset ${j}`);
    const v = readString(j);
    entries.push({ key, value: v.text, keyStart: i, valEnd: v.end, line: lineOf(src, i) });
    i = v.end;
  }
  return entries;
}

function loadDict(spec) {
  const abs = path.join(ROOT, spec.file);
  const src = fs.readFileSync(abs, 'utf8');
  const dict = { spec, abs, src, locales: {} };
  for (const loc of ['en', 'cn']) {
    const block = findLocaleBlock(src, spec.localeRe(loc));
    if (!block) throw new Error(`${spec.file}: locale block '${loc}' not found`);
    const entries = scanEntries(src, block);
    dict.locales[loc] = { block, entries };
  }
  return dict;
}

// ------------------------------------------------------------ reference scan
function walk(dir, acc, skipVendor = true) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of list) {
    if (skipVendor && /vendor|node_modules|\.git/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc, skipVendor);
    else acc.push(p);
  }
  return acc;
}

function buildCorpus(dictFiles) {
  const jsHtml = walk(path.join(ROOT, 'web'), []).filter((f) => /\.(js|html)$/.test(f));
  const go = walk(path.join(ROOT, 'internal'), []).filter((f) => /\.go$/.test(f));
  const skip = new Set(dictFiles.map((f) => path.join(ROOT, f)));
  const blob = [];
  for (const f of [...jsHtml, ...go]) {
    if (skip.has(f)) continue;
    try { blob.push(fs.readFileSync(f, 'utf8')); } catch { /* ignore */ }
  }
  return blob.join('\n');
}

// ------------------------------------------------------------------- checks
function check(pruneAfter) {
  const dicts = DICTS.map(loadDict);
  const corpus = buildCorpus(DICTS.map((d) => d.file));
  let failures = 0;

  for (const d of dicts) {
    for (const loc of ['en', 'cn']) {
      const seen = new Map();
      for (const e of d.locales[loc].entries) {
        if (!seen.has(e.key)) seen.set(e.key, []);
        seen.get(e.key).push(e);
      }
      for (const [key, list] of seen) {
        if (list.length > 1) {
          failures++;
          for (const e of list) console.log(`DUP  ${d.spec.file}:${e.line}  ${loc}.${key} = ${JSON.stringify(e.value.slice(0, 60))}`);
        }
        if (list[0].value.trim() === '') {
          failures++;
          console.log(`EMPTY ${d.spec.file}:${list[0].line}  ${loc}.${key}`);
        }
      }
    }
  }

  // keyset diff + placeholder mismatch (per dictionary)
  const ph = /\{\d+\}/g;
  for (const d of dicts) {
    const en = new Map(d.locales.en.entries.map((e) => [e.key, e]));
    const cn = new Map(d.locales.cn.entries.map((e) => [e.key, e]));
    for (const [k, e] of en) {
      if (!cn.has(k)) { failures++; console.log(`MISSING-CN ${d.spec.file}:${e.line}  ${k} = ${JSON.stringify(e.value.slice(0, 60))}`); continue; }
      const a = (e.value.match(ph) || []).sort().join(',');
      const b = (cn.get(k).value.match(ph) || []).sort().join(',');
      if (a !== b) {
        failures++;
        console.log(`PH-MISMATCH ${d.spec.file}:${e.line}/${cn.get(k).line}  ${k}  en[${a}] cn[${b}]`);
      }
    }
    for (const [k, e] of cn) {
      if (!en.has(k)) { failures++; console.log(`MISSING-EN ${d.spec.file}:${e.line}  ${k} = ${JSON.stringify(e.value.slice(0, 60))}`); }
    }
  }

  // zero-reference keys
  const unusedByFile = new Map();
  for (const d of dicts) {
    const all = new Set();
    for (const loc of ['en', 'cn']) for (const e of d.locales[loc].entries) all.add(e.key);
    const unused = [...all].filter((k) => {
      if (DYNAMIC_PREFIXES.some((p) => k.startsWith(p))) return false;
      return !corpus.includes(`'${k}'`) && !corpus.includes(`"${k}"`) && !corpus.includes('`' + k + '`');
    });
    unusedByFile.set(d, new Set(unused));
    console.log(`UNUSED ${d.spec.label}: ${unused.length}`);
    if (process.argv.includes('-v')) for (const k of unused) {
      const e = d.locales.en.entries.find((x) => x.key === k) || d.locales.cn.entries.find((x) => x.key === k);
      console.log(`  ${d.spec.file}:${e ? e.line : '?'}  ${k}`);
    }
  }

  if (pruneAfter) {
    for (const d of dicts) {
      const unused = unusedByFile.get(d);
      const spans = [];
      for (const loc of ['en', 'cn']) {
        for (const e of d.locales[loc].entries) {
          if (!unused.has(e.key)) continue;
          // extend span through trailing comma if present
          let end = e.valEnd;
          let j = end;
          while (j < d.src.length && /\s/.test(d.src[j])) j++;
          if (d.src[j] === ',') end = j + 1;
          spans.push([e.keyStart, end]);
        }
      }
      spans.sort((a, b) => b[0] - a[0]);
      let out = d.src;
      for (const [s, e] of spans) out = out.slice(0, s) + out.slice(e);
      // drop lines that became whitespace-only due to removal
      const removedSet = new Set();
      for (const [s] of spans) {
        removedSet.add(lineOf(d.src, s));
      }
      const lines = out.split('\n');
      // lines whose original content was fully removed: recompute by checking
      // each line that now is blank AND intersects a removed span
      const keep = [];
      const removedLineIdx = new Set([...removedSet].map((l) => l - 1));
      for (let idx = 0; idx < lines.length; idx++) {
        const blank = lines[idx].trim() === '';
        if (blank && removedLineIdx.has(idx)) continue;
        keep.push(lines[idx]);
      }
      fs.writeFileSync(d.abs, keep.join('\n'));
      console.log(`PRUNED ${d.spec.file}: removed ${spans.length} entries`);
      execFileSync(process.execPath, ['--check', d.abs], { stdio: 'inherit' });
      console.log(`SYNTAX-OK ${d.spec.file}`);
    }
  }

  return failures;
}

const mode = process.argv[2] || 'check';
if (mode === 'check') {
  const f = check(false);
  console.log(f === 0 ? 'CHECK OK (0 failures)' : `CHECK FAILED: ${f} failures`);
  process.exit(f === 0 ? 0 : 1);
} else if (mode === '--prune') {
  const f = check(true);
  process.exit(0);
} else {
  console.error('usage: node web/tools/i18n-lint.mjs check | --prune [-v]');
  process.exit(2);
}
