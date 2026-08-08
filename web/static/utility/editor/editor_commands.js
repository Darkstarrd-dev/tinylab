// editor_commands.js — local Markdown commands for the Utility editor.
// Classic script: intentionally framework-free and safe to load more than once.
(function (root) {
  'use strict';

  var MAX_HISTORY = 100;
  var MERGE_WINDOW = 700;
  var hasWeakMap = typeof WeakMap === 'function';
  var histories = hasWeakMap ? new WeakMap() : [];

  function isTextarea(ta) {
    return !!ta && typeof ta.value === 'string';
  }

  function snapshot(ta) {
    var value = String(ta.value == null ? '' : ta.value);
    var start = typeof ta.selectionStart === 'number' ? ta.selectionStart : value.length;
    var end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : start;
    return {
      value: value,
      start: Math.max(0, Math.min(value.length, start)),
      end: Math.max(0, Math.min(value.length, end))
    };
  }

  function sameSnapshot(a, b) {
    return !!a && !!b && a.value === b.value && a.start === b.start && a.end === b.end;
  }

  function findFallback(ta) {
    for (var i = 0; i < histories.length; i++) {
      if (histories[i].ta === ta) return histories[i].history;
    }
    return null;
  }

  function putHistory(ta, history) {
    if (hasWeakMap) histories.set(ta, history);
    else histories.push({ ta: ta, history: history });
  }

  function getHistory(ta) {
    if (!isTextarea(ta)) return null;
    var history = hasWeakMap ? histories.get(ta) : findFallback(ta);
    if (history) return history;
    history = {
      entries: [snapshot(ta)],
      index: 0,
      lastRecordAt: 0,
      suppress: false,
      listening: false
    };
    putHistory(ta, history);
    // Recording input events here gives callers a useful history even when they
    // only call record() once (for example, when the editor receives focus).
    if (typeof ta.addEventListener === 'function') {
      history.listening = true;
      ta.addEventListener('input', function () {
        if (!history.suppress) record(ta);
      });
    }
    return history;
  }

  function recordSnapshot(history, state, merge) {
    var now = Date.now();
    var current = history.entries[history.index];
    if (sameSnapshot(current, state)) {
      history.lastRecordAt = now;
      return false;
    }
    if (history.index < history.entries.length - 1) {
      history.entries = history.entries.slice(0, history.index + 1);
    }
    if (merge && history.entries.length > 1 && now - history.lastRecordAt <= MERGE_WINDOW) {
      history.entries[history.index] = state;
    } else {
      history.entries.push(state);
      history.index = history.entries.length - 1;
      if (history.entries.length > MAX_HISTORY) {
        history.entries.shift();
        history.index--;
      }
    }
    history.lastRecordAt = now;
    return true;
  }

  function record(ta) {
    var history = getHistory(ta);
    if (!history || history.suppress) return false;
    return recordSnapshot(history, snapshot(ta), true);
  }

  function syncCurrent(ta, history) {
    var current = snapshot(ta);
    if (!sameSnapshot(history.entries[history.index], current)) {
      recordSnapshot(history, current, false);
    }
    return current;
  }

  function dispatchInput(ta) {
    if (!ta || typeof ta.dispatchEvent !== 'function') return;
    var event = null;
    try {
      if (root && typeof root.Event === 'function') event = new root.Event('input', { bubbles: true });
      else if (typeof Event === 'function') event = new Event('input', { bubbles: true });
    } catch (e) { event = null; }
    if (!event && typeof document !== 'undefined' && document.createEvent) {
      try {
        event = document.createEvent('Event');
        event.initEvent('input', true, true);
      } catch (e2) { event = null; }
    }
    if (event) {
      try { ta.dispatchEvent(event); } catch (e3) {}
    }
  }

  function applySnapshot(ta, state) {
    if (!isTextarea(ta) || !state) return false;
    var history = getHistory(ta);
    var changed = ta.value !== state.value || ta.selectionStart !== state.start || ta.selectionEnd !== state.end;
    if (!changed) return false;
    history.suppress = true;
    ta.value = state.value;
    try {
      if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(state.start, state.end);
      else {
        ta.selectionStart = state.start;
        ta.selectionEnd = state.end;
      }
    } catch (e) {}
    dispatchInput(ta);
    history.suppress = false;
    return true;
  }

  function mutate(ta, value, start, end) {
    if (!isTextarea(ta)) return false;
    value = String(value == null ? '' : value);
    var old = snapshot(ta);
    start = typeof start === 'number' ? start : old.start;
    end = typeof end === 'number' ? end : old.end;
    start = Math.max(0, Math.min(value.length, start));
    end = Math.max(start, Math.min(value.length, end));
    if (old.value === value && old.start === start && old.end === end) return false;
    var history = getHistory(ta);
    // Make the pre-edit state undoable, then explicitly commit the result. The
    // input listener is suppressed so undo/redo cannot accidentally clear redo.
    syncCurrent(ta, history);
    history.suppress = true;
    ta.value = value;
    try {
      if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(start, end);
      else { ta.selectionStart = start; ta.selectionEnd = end; }
    } catch (e) {}
    dispatchInput(ta);
    history.suppress = false;
    recordSnapshot(history, snapshot(ta), false);
    return true;
  }

  function selected(ta) {
    var state = snapshot(ta);
    return { state: state, text: state.value.slice(state.start, state.end) };
  }

  function wrapSelection(ta, before, after, placeholder) {
    if (!isTextarea(ta)) return false;
    before = String(before == null ? '' : before);
    after = String(after == null ? before : after);
    var picked = selected(ta);
    var text = picked.text;
    var inner = text || String(placeholder == null ? '' : placeholder);
    var replacement = before + inner + after;
    var start = picked.state.start + before.length;
    var end = start + inner.length;
    if (!text && placeholder == null) end = start;
    return mutate(ta, picked.state.value.slice(0, picked.state.start) + replacement + picked.state.value.slice(picked.state.end), start, end);
  }

  function lineRange(value, start, end) {
    var first = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    var last = value.indexOf('\n', end);
    if (last < 0) last = value.length;
    return { start: first, end: last };
  }

  function mapPrefixPosition(pos, changes) {
    var mapped = pos;
    for (var i = 0; i < changes.length; i++) {
      var c = changes[i];
      if (c.add) {
        if (pos >= c.at) mapped += c.amount;
      } else if (pos >= c.at + c.amount) {
        mapped -= c.amount;
      } else if (pos > c.at) {
        mapped = c.at;
      }
    }
    return Math.max(0, mapped);
  }

  function toggleLinePrefix(ta, prefix) {
    if (!isTextarea(ta)) return false;
    prefix = String(prefix == null ? '' : prefix);
    if (!prefix) return false;
    var picked = selected(ta);
    var value = picked.state.value;
    var range = lineRange(value, picked.state.start, picked.state.end);
    var lines = value.slice(range.start, range.end).split('\n');
    var allHave = true;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(prefix) !== 0) { allHave = false; break; }
    }
    var changes = [];
    for (var j = 0; j < lines.length; j++) {
      var at = range.start;
      for (var k = 0; k < j; k++) at += lines[k].length + 1;
      if (allHave) {
        lines[j] = lines[j].slice(prefix.length);
        changes.push({ at: at, amount: prefix.length, add: false });
      } else if (lines[j].indexOf(prefix) !== 0) {
        lines[j] = prefix + lines[j];
        changes.push({ at: at, amount: prefix.length, add: true });
      }
    }
    var replacement = lines.join('\n');
    var next = value.slice(0, range.start) + replacement + value.slice(range.end);
    return mutate(ta, next, mapPrefixPosition(picked.state.start, changes), mapPrefixPosition(picked.state.end, changes));
  }

  function replaceLinePrefix(ta, prefixPattern, replacement) {
    var picked = selected(ta);
    var value = picked.state.value;
    var start = value.lastIndexOf('\n', Math.max(0, picked.state.start - 1)) + 1;
    var end = value.indexOf('\n', picked.state.start);
    if (end < 0) end = value.length;
    var line = value.slice(start, end);
    var match = line.match(prefixPattern);
    var oldLength = match ? match[0].length : 0;
    var nextLine = replacement + line.slice(oldLength);
    var next = value.slice(0, start) + nextLine + value.slice(end);
    function map(pos) {
      if (pos <= start + oldLength) return start + replacement.length;
      return pos + replacement.length - oldLength;
    }
    return mutate(ta, next, map(picked.state.start), map(picked.state.end));
  }

  function promptValue(message, fallback) {
    if (root && typeof root.prompt === 'function') {
      var value = root.prompt(message, fallback || '');
      return value == null ? null : String(value);
    }
    return null;
  }

  function cleanUrl(url) {
    url = String(url == null ? '' : url).trim().replace(/[<>"']/g, '');
    if (/^(?:javascript|data|vbscript):/i.test(url)) return '';
    return url.replace(/\)/g, '%29');
  }

  function linkArgs(ta, arg, extra) {
    var out = {};
    if (arg && typeof arg === 'object') {
      out.text = typeof arg.text === 'string' ? arg.text : (typeof arg.label === 'string' ? arg.label : undefined);
      out.url = typeof arg.url === 'string' ? arg.url : (typeof arg.href === 'string' ? arg.href : undefined);
    } else {
      if (typeof arg === 'string') out.text = arg;
      if (typeof extra === 'string') out.url = extra;
    }
    var picked = selected(ta);
    if (out.text === undefined && picked.text) out.text = picked.text;
    var promptedText = false;
    if (out.text === undefined) {
      out.text = promptValue('Link text', '');
      promptedText = out.text !== null;
    }
    if (out.text === null || out.text === undefined) return null;
    if (out.url === undefined && promptedText) out.url = promptValue('Link URL', 'https://');
    if (out.url === null || out.url === undefined) out.url = '';
    return { text: out.text.replace(/]/g, '\\]'), url: cleanUrl(out.url), picked: picked };
  }

  function insertLink(ta, textOrOptions, url) {
    if (!isTextarea(ta)) return false;
    var args = linkArgs(ta, textOrOptions, url);
    if (!args) return false;
    var state = args.picked.state;
    var text = args.text || 'text';
    var replacement = '[' + text + '](' + args.url + ')';
    var start = state.start + 1;
    var end = start + text.length;
    var value = state.value.slice(0, state.start) + replacement + state.value.slice(state.end);
    return mutate(ta, value, start, end);
  }

  function insertImage(ta, altOrOptions, url) {
    if (!isTextarea(ta)) return false;
    var options = altOrOptions && typeof altOrOptions === 'object' ? altOrOptions : {};
    var picked = selected(ta);
    var alt = typeof altOrOptions === 'string' ? altOrOptions : (typeof options.alt === 'string' ? options.alt : picked.text);
    var src = typeof url === 'string' ? url : (typeof options.url === 'string' ? options.url : (typeof options.src === 'string' ? options.src : undefined));
    var promptedAlt = false;
    if (!alt) {
      alt = promptValue('Image description', '');
      promptedAlt = alt !== null;
    }
    if (alt === null || alt === undefined) return false;
    if (src === undefined && promptedAlt) src = promptValue('Image URL', 'https://');
    if (src === null || src === undefined) src = '';
    alt = String(alt).replace(/]/g, '\\]');
    src = cleanUrl(src);
    var replacement = '![' + alt + '](' + src + ')';
    var start = picked.state.start + 2;
    var end = start + alt.length;
    var value = picked.state.value.slice(0, picked.state.start) + replacement + picked.state.value.slice(picked.state.end);
    return mutate(ta, value, start, end);
  }

  function insertTable(ta, rows, columns) {
    if (!isTextarea(ta)) return false;
    if (rows && typeof rows === 'object') {
      columns = rows.columns;
      rows = rows.rows;
    }
    rows = Math.max(1, Math.min(10, parseInt(rows, 10) || 1));
    columns = Math.max(1, Math.min(10, parseInt(columns, 10) || 2));
    var header = [], separator = [], blank = [];
    for (var i = 0; i < columns; i++) {
      header.push('Header ' + (i + 1));
      separator.push('---');
      blank.push('');
    }
    var table = '| ' + header.join(' | ') + ' |\n| ' + separator.join(' | ') + ' |';
    for (var r = 0; r < rows; r++) table += '\n| ' + blank.join(' | ') + ' |';
    var picked = selected(ta);
    var value = picked.state.value.slice(0, picked.state.start) + table + picked.state.value.slice(picked.state.end);
    var caret = picked.state.start + table.length;
    return mutate(ta, value, caret, caret);
  }

  function format(ta, command) {
    if (!isTextarea(ta)) return false;
    command = String(command == null ? '' : command).toLowerCase().replace(/^format[-_:]/, '');
    switch (command) {
      case 'bold': return wrapSelection(ta, '**', '**', 'bold text');
      case 'italic': return wrapSelection(ta, '*', '*', 'italic text');
      case 'strike': case 'strikethrough': return wrapSelection(ta, '~~', '~~', 'struck text');
      case 'code': return wrapSelection(ta, '`', '`', 'code');
      case 'heading': return replaceLinePrefix(ta, /^#{1,6}\s+/, function () { return ''; });
      case 'ul': case 'unordered': return toggleLinePrefix(ta, '- ');
      case 'ol': case 'ordered': return toggleLinePrefix(ta, '1. ');
      case 'checklist': return toggleLinePrefix(ta, '- [ ] ');
      case 'quote': return toggleLinePrefix(ta, '> ');
      case 'table': return insertTable(ta);
      case 'link': return insertLink(ta);
      case 'image': return insertImage(ta);
      default: return false;
    }
  }

  function heading(ta) {
    if (!isTextarea(ta)) return false;
    var picked = selected(ta);
    var value = picked.state.value;
    var start = value.lastIndexOf('\n', Math.max(0, picked.state.start - 1)) + 1;
    var end = value.indexOf('\n', picked.state.start);
    if (end < 0) end = value.length;
    var line = value.slice(start, end);
    var match = line.match(/^(#{1,6})\s+/);
    var level = match ? match[1].length + 1 : 1;
    if (level > 6) level = 0;
    var replacement = level ? new Array(level + 1).join('#') + ' ' : '';
    return replaceLinePrefix(ta, /^#{1,6}\s+/, replacement);
  }

  function undo(ta) {
    var history = getHistory(ta);
    if (!history) return false;
    syncCurrent(ta, history);
    if (history.index <= 0) return false;
    history.index--;
    return applySnapshot(ta, history.entries[history.index]);
  }

  function redo(ta) {
    var history = getHistory(ta);
    if (!history || history.index >= history.entries.length - 1) return false;
    history.index++;
    return applySnapshot(ta, history.entries[history.index]);
  }

  function canUndo(ta) {
    var history = getHistory(ta);
    if (!history) return false;
    return history.index > 0 || !sameSnapshot(history.entries[history.index], snapshot(ta));
  }

  function canRedo(ta) {
    var history = getHistory(ta);
    return !!history && history.index < history.entries.length - 1;
  }

  function clear(ta) {
    if (!isTextarea(ta)) return false;
    return mutate(ta, '', 0, 0);
  }

  var api = {
    wrapSelection: wrapSelection,
    toggleLinePrefix: toggleLinePrefix,
    format: function (ta, command) {
      if (String(command).toLowerCase() === 'heading') return heading(ta);
      return format(ta, command);
    },
    insertLink: insertLink,
    insertImage: insertImage,
    insertTable: insertTable,
    record: record,
    undo: undo,
    redo: redo,
    canUndo: canUndo,
    canRedo: canRedo,
    clear: clear
  };

  var existing = root.EditorCommands && typeof root.EditorCommands === 'object' ? root.EditorCommands : {};
  for (var key in api) {
    if (typeof existing[key] !== 'function') existing[key] = api[key];
  }
  root.EditorCommands = existing;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this)));
