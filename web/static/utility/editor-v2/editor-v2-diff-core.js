/**
 * Editor V2 - Diff Core (Pure tokenization, line-alignment, and decision assembly)
 * UMD wrapper: works in browser, Web Worker, and Node.js / Bun.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EditorV2DiffCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Splits text into line tokens preserving the exact line endings (LF, CRLF, CR, or none at EOF).
   * @param {string} text
   * @returns {Array<{ text: string, eol: string, raw: string }>}
   */
  function tokenize(text) {
    if (!text && text !== '') return [];
    if (text === '') return [];

    const lines = [];
    let cursor = 0;
    const len = text.length;

    while (cursor < len) {
      let lineEnd = cursor;
      let eol = '';
      while (lineEnd < len) {
        const ch = text[lineEnd];
        if (ch === '\r') {
          if (lineEnd + 1 < len && text[lineEnd + 1] === '\n') {
            eol = '\r\n';
          } else {
            eol = '\r';
          }
          break;
        } else if (ch === '\n') {
          eol = '\n';
          break;
        }
        lineEnd++;
      }

      const lineContent = text.slice(cursor, lineEnd);
      lines.push({
        text: lineContent,
        eol: eol,
        raw: lineContent + eol,
      });

      cursor = lineEnd + eol.length;
    }

    return lines;
  }

  /**
   * Compares two text documents and produces aligned rows with word-level diffs for modified lines.
   * Empty lines are never skipped to prevent cross-paragraph misalignment.
   *
   * @param {string} oldText - Left / original document (A)
   * @param {string} newText - Right / revised document (B)
   * @param {object} [diffLib] - JsDiff instance (defaults to globalThis.Diff)
   * @returns {Array<DiffRow>}
   */
  function compare(oldText, newText, diffLib) {
    const diff = diffLib || (typeof globalThis !== 'undefined' ? globalThis.Diff : null);
    if (!diff || typeof diff.diffLines !== 'function') {
      throw new Error('JsDiff library (diffLines) is required for DiffCore.compare');
    }

    if (oldText === newText) {
      const tokens = tokenize(oldText);
      return tokens.map((tok, idx) => ({
        id: idx,
        type: 'context',
        left: { num: idx + 1, text: tok.text, eol: tok.eol },
        right: { num: idx + 1, text: tok.text, eol: tok.eol },
      }));
    }

    const changes = diff.diffLines(oldText, newText);
    const rows = [];
    let ln = 1;
    let rn = 1;
    let rowId = 0;
    let i = 0;

    while (i < changes.length) {
      const c = changes[i];

      if (!c.added && !c.removed) {
        const ctxLines = tokenize(c.value);
        for (let k = 0; k < ctxLines.length; k++) {
          rows.push({
            id: rowId++,
            type: 'context',
            left: { num: ln++, text: ctxLines[k].text, eol: ctxLines[k].eol },
            right: { num: rn++, text: ctxLines[k].text, eol: ctxLines[k].eol },
          });
        }
        i += 1;
        continue;
      }

      if (c.removed) {
        // Only pair with immediate adjacent added block (do not cross empty lines)
        const nextC = i + 1 < changes.length ? changes[i + 1] : null;
        if (nextC && nextC.added) {
          const delLines = tokenize(c.value);
          const addLines = tokenize(nextC.value);
          const maxCount = Math.max(delLines.length, addLines.length);

          for (let k = 0; k < maxCount; k++) {
            const l = k < delLines.length ? delLines[k] : null;
            const r = k < addLines.length ? addLines[k] : null;

            if (l !== null && r !== null) {
              let leftParts = [];
              let rightParts = [];

              if (typeof diff.diffWordsWithSpace === 'function') {
                const parts = diff.diffWordsWithSpace(l.text, r.text);
                leftParts = parts.filter(p => !p.added).map(p => ({ text: p.value, removed: !!p.removed }));
                rightParts = parts.filter(p => !p.removed).map(p => ({ text: p.value, added: !!p.added }));
              } else {
                leftParts = [{ text: l.text, removed: true }];
                rightParts = [{ text: r.text, added: true }];
              }

              rows.push({
                id: rowId++,
                type: 'mod',
                left: { num: ln++, text: l.text, eol: l.eol },
                right: { num: rn++, text: r.text, eol: r.eol },
                leftParts: leftParts,
                rightParts: rightParts,
              });
            } else if (l !== null) {
              rows.push({
                id: rowId++,
                type: 'del',
                left: { num: ln++, text: l.text, eol: l.eol },
                right: null,
              });
            } else {
              rows.push({
                id: rowId++,
                type: 'add',
                left: null,
                right: { num: rn++, text: r.text, eol: r.eol },
              });
            }
          }

          i += 2;
          continue;
        }

        // Unpaired removed block
        const rmLines = tokenize(c.value);
        for (let k = 0; k < rmLines.length; k++) {
          rows.push({
            id: rowId++,
            type: 'del',
            left: { num: ln++, text: rmLines[k].text, eol: rmLines[k].eol },
            right: null,
          });
        }
        i += 1;
        continue;
      }

      if (c.added) {
        // Unpaired added block
        const addLines = tokenize(c.value);
        for (let k = 0; k < addLines.length; k++) {
          rows.push({
            id: rowId++,
            type: 'add',
            left: null,
            right: { num: rn++, text: addLines[k].text, eol: addLines[k].eol },
          });
        }
        i += 1;
        continue;
      }
    }

    return rows;
  }

  /**
   * Assembles aligned rows into final text according to per-row decisions.
   * Default decision for any row is 'accept' (adopt B / newText).
   *
   * Decision mapping:
   * - context: always output right line
   * - mod:
   *     accept -> output right line
   *     reject -> output left line
   * - add:
   *     accept -> output right line
   *     reject -> do not output
   * - del:
   *     accept -> do not output
   *     reject -> output left line
   *
   * @param {Array<DiffRow>} alignedRows
   * @param {Map<number, 'accept'|'reject'>|Object<number, 'accept'|'reject'>} decisions
   * @returns {string}
   */
  function assemble(alignedRows, decisions) {
    if (!alignedRows || alignedRows.length === 0) return '';

    const pieces = [];
    const getDec = (id) => {
      if (!decisions) return 'accept';
      if (typeof decisions.get === 'function') {
        return decisions.get(id) || 'accept';
      }
      return decisions[id] || 'accept';
    };

    for (let idx = 0; idx < alignedRows.length; idx++) {
      const row = alignedRows[idx];
      const decision = getDec(row.id != null ? row.id : idx);

      switch (row.type) {
        case 'context':
          if (row.right) {
            pieces.push(row.right.text + (row.right.eol != null ? row.right.eol : ''));
          } else if (row.left) {
            pieces.push(row.left.text + (row.left.eol != null ? row.left.eol : ''));
          }
          break;

        case 'mod':
          if (decision === 'reject') {
            if (row.left) pieces.push(row.left.text + (row.left.eol != null ? row.left.eol : ''));
          } else {
            if (row.right) pieces.push(row.right.text + (row.right.eol != null ? row.right.eol : ''));
          }
          break;

        case 'add':
          if (decision === 'accept') {
            if (row.right) pieces.push(row.right.text + (row.right.eol != null ? row.right.eol : ''));
          }
          break;

        case 'del':
          if (decision === 'reject') {
            if (row.left) pieces.push(row.left.text + (row.left.eol != null ? row.left.eol : ''));
          }
          break;
      }
    }

    return pieces.join('');
  }

  return {
    tokenize,
    compare,
    assemble,
  };
});
