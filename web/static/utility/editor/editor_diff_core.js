// editor_diff_core.js — aligned-diff core extracted from the former editor.js.
// editor_shell.js wraps the editor page (legacyCleanup/legacySuspend chain,
// renderLegacyEditor save path); this file keeps only the live surface of the
// old monolith: edToLines/editorAlignedDiff (+edDiffStats helper, kept for
// parity) and the window.editorAlignedDiff export. Source bodies are copied
// verbatim from editor.js @ 0cdc4cc — do not reformat.

'use strict';

// ===================== aligned diff (ported from novelhelper) =====================

function edToLines(value) {
  var arr = value.split('\n');
  if (arr.length > 0 && arr[arr.length - 1] === '') arr.pop();
  return arr;
}

/**
 * Line-aligned diff: adjacent delete/add blocks are pair-matched as "mod" rows
 * with char-level highlighting via Diff.diffChars.
 * Exposed as window.editorAlignedDiff.
 */
function editorAlignedDiff(oldText, newText) {
  if (typeof Diff === 'undefined' || !Diff.diffLines) {
    return [{ type:'context', left:{num:1,text:oldText}, right:{num:1,text:newText} }];
  }
  var changes = Diff.diffLines(oldText, newText);
  var rows = [];
  var ln = 1;
  var rn = 1;
  var i = 0;
  while (i < changes.length) {
    var c = changes[i];
    if (!c.added && !c.removed) {
      var ctxLines = edToLines(c.value);
      for (var ci = 0; ci < ctxLines.length; ci++) {
        rows.push({ type:'context', left:{num:ln++, text:ctxLines[ci]}, right:{num:rn++, text:ctxLines[ci]} });
      }
      i += 1;
      continue;
    }
    if (c.removed) {
      // Look ahead for an added block, skipping over empty-line context blocks.
      // This pairs del+add as mod even when separated by blank lines (common in
      // novel text where paragraphs are separated by empty lines).
      var skipCtx = [];
      var addIdx = -1;
      for (var j = i + 1; j < changes.length; j++) {
        if (changes[j].added) { addIdx = j; break; }
        if (changes[j].removed) { addIdx = -1; break; } // another removed: abort pairing
        var ctxLs = edToLines(changes[j].value);
        var allEmpty = true;
        for (var ce = 0; ce < ctxLs.length; ce++) { if (ctxLs[ce] !== '') { allEmpty = false; break; } }
        if (!allEmpty) { addIdx = -1; break; }
        skipCtx = skipCtx.concat(ctxLs);
      }
      if (addIdx > 0) {
        // Emit skipped empty context lines first
        for (var si = 0; si < skipCtx.length; si++) {
          rows.push({ type:'context', left:{num:ln++, text:skipCtx[si]}, right:{num:rn++, text:skipCtx[si]} });
        }
        // Pair removed + added as mod rows with char-level diff
        var delLines = edToLines(c.value);
        var addLines = edToLines(changes[addIdx].value);
        var n = Math.max(delLines.length, addLines.length);
        for (var k = 0; k < n; k++) {
          var l = k < delLines.length ? delLines[k] : null;
          var r = k < addLines.length ? addLines[k] : null;
          if (l !== null && r !== null) {
            var parts = Diff.diffChars(l, r);
            rows.push({
              type: 'mod',
              left: {num:ln++, text:l},
              right: {num:rn++, text:r},
              leftParts: parts.filter(function(p) { return !p.added; }).map(function(p) { return {text:p.value, removed:p.removed}; }),
              rightParts: parts.filter(function(p) { return !p.removed; }).map(function(p) { return {text:p.value, added:p.added}; })
            });
          } else if (l !== null) {
            rows.push({ type:'del', left:{num:ln++, text:l}, right:null });
          } else {
            rows.push({ type:'add', left:null, right:{num:rn++, text:r} });
          }
        }
        i = addIdx + 1;
        continue;
      }
      // No added block found: emit as del
      var rmLines = edToLines(c.value);
      for (var ri = 0; ri < rmLines.length; ri++) {
        rows.push({ type:'del', left:{num:ln++, text:rmLines[ri]}, right:null });
      }
      i += 1;
      continue;
    }
    if (c.added) {
      var addLines2 = edToLines(c.value);
      for (var ai = 0; ai < addLines2.length; ai++) {
        rows.push({ type:'add', left:null, right:{num:rn++, text:addLines2[ai]} });
      }
      i += 1;
      continue;
    }
  }
  return rows;
}

function edDiffStats(rows) {
  var stats = { del:0, add:0, mod:0 };
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].type === 'del') stats.del++;
    else if (rows[i].type === 'add') stats.add++;
    else if (rows[i].type === 'mod') stats.mod++;
  }
  return stats;
}

// ===================== exported API =====================

window.editorAlignedDiff = editorAlignedDiff;
