/**
 * Editor V2 Commands - Menu Definitions, Command Dispatcher, and Markdown Range Edits
 */
(() => {
  'use strict';

  let currentCodeEditor = null;
  let layoutRefs = null;

  // Command registry
  const commands = new Map();

  function registerCommand(cmd) {
    commands.set(cmd.id, cmd);
  }

  function getCommand(id) {
    return commands.get(id);
  }

  async function runCommand(id) {
    const cmd = commands.get(id);
    if (!cmd) {
      console.warn(`Command not found: ${id}`);
      return;
    }
    if (cmd.enabled && !cmd.enabled()) {
      return;
    }
    if (currentCodeEditor && !cmd.keepMenuFocus) {
      currentCodeEditor.focus();
    }
    try {
      await cmd.run();
    } catch (e) {
      console.error(`Error running command ${id}:`, e);
      if (window.showToast) window.showToast(e.message, 'error');
    }
  }

  // --- Monaco Native Action Trigger Helper ---
  function triggerMonacoAction(actionId) {
    if (!currentCodeEditor) return;
    currentCodeEditor.focus();
    const action = currentCodeEditor.getAction(actionId);
    if (action && action.isSupported()) {
      action.run();
      return;
    }
    currentCodeEditor.trigger('commands', actionId, null);
  }

  // --- Markdown Edit Range Helpers (Native Monaco executeEdits) ---

  function applySurroundEdit(prefix, suffix) {
    if (!currentCodeEditor) return;
    const model = currentCodeEditor.getModel();
    if (!model) return;
    const selections = currentCodeEditor.getSelections();
    if (!selections || selections.length === 0) return;

    const edits = [];
    const newSelections = [];

    selections.forEach(sel => {
      const text = model.getValueInRange(sel);
      if (text.startsWith(prefix) && text.endsWith(suffix) && text.length >= prefix.length + suffix.length) {
        // Unwrap
        const inner = text.slice(prefix.length, text.length - suffix.length);
        edits.push({ range: sel, text: inner, forceMoveMarkers: true });
      } else {
        // Wrap
        const wrapped = `${prefix}${text}${suffix}`;
        edits.push({ range: sel, text: wrapped, forceMoveMarkers: true });
      }
    });

    currentCodeEditor.pushUndoStop();
    currentCodeEditor.executeEdits('markdown-format', edits);
    currentCodeEditor.pushUndoStop();
    currentCodeEditor.focus();
  }

  function getAffectedLogicalLines(model, selections) {
    const lines = new Set();
    selections.forEach(sel => {
      let startLine = sel.startLineNumber;
      let endLine = sel.endLineNumber;
      // Guard: If selection end is at column 1 of next line, do not include that line
      if (sel.endColumn === 1 && endLine > startLine) {
        endLine--;
      }
      for (let l = startLine; l <= endLine; l++) {
        lines.add(l);
      }
    });
    return Array.from(lines).sort((a, b) => a - b);
  }

  function applyLinePrefixToggle(prefix) {
    if (!currentCodeEditor) return;
    const model = currentCodeEditor.getModel();
    if (!model) return;
    const selections = currentCodeEditor.getSelections();
    if (!selections) return;

    const lines = getAffectedLogicalLines(model, selections);
    if (lines.length === 0) return;

    // Check if all affected lines already start with prefix
    const allHave = lines.every(lineNum => {
      const lineContent = model.getLineContent(lineNum);
      return lineContent.trimStart().startsWith(prefix);
    });

    const edits = [];
    lines.forEach(lineNum => {
      const lineContent = model.getLineContent(lineNum);
      if (allHave) {
        // Remove prefix
        const idx = lineContent.indexOf(prefix);
        if (idx >= 0) {
          const range = new window.Ed2Monaco.Range(lineNum, idx + 1, lineNum, idx + 1 + prefix.length);
          edits.push({ range, text: '' });
        }
      } else {
        // Add prefix at column 1
        const range = new window.Ed2Monaco.Range(lineNum, 1, lineNum, 1);
        edits.push({ range, text: prefix });
      }
    });

    currentCodeEditor.pushUndoStop();
    currentCodeEditor.executeEdits('markdown-prefix-toggle', edits);
    currentCodeEditor.pushUndoStop();
    currentCodeEditor.focus();
  }

  function cycleHeading() {
    if (!currentCodeEditor) return;
    const model = currentCodeEditor.getModel();
    if (!model) return;
    const selections = currentCodeEditor.getSelections();
    if (!selections) return;

    const lines = getAffectedLogicalLines(model, selections);
    if (lines.length === 0) return;

    const edits = [];
    lines.forEach(lineNum => {
      const content = model.getLineContent(lineNum);
      const match = content.match(/^(#{1,6})\s/);
      if (!match) {
        // No heading -> # Heading
        edits.push({
          range: new window.Ed2Monaco.Range(lineNum, 1, lineNum, 1),
          text: '# ',
        });
      } else {
        const hashes = match[1].length;
        const fullPrefixLen = match[0].length;
        if (hashes < 6) {
          // Increase level: e.g. # -> ##
          const newPrefix = '#'.repeat(hashes + 1) + ' ';
          edits.push({
            range: new window.Ed2Monaco.Range(lineNum, 1, lineNum, 1 + fullPrefixLen),
            text: newPrefix,
          });
        } else {
          // Level 6 -> remove heading
          edits.push({
            range: new window.Ed2Monaco.Range(lineNum, 1, lineNum, 1 + fullPrefixLen),
            text: '',
          });
        }
      }
    });

    currentCodeEditor.pushUndoStop();
    currentCodeEditor.executeEdits('markdown-heading-cycle', edits);
    currentCodeEditor.pushUndoStop();
    currentCodeEditor.focus();
  }

  function insertTable() {
    if (!currentCodeEditor) return;
    const model = currentCodeEditor.getModel();
    if (!model) return;
    const sel = currentCodeEditor.getSelection();
    const tableTemplate = '\n| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n';

    currentCodeEditor.pushUndoStop();
    currentCodeEditor.executeEdits('insert-table', [{
      range: sel,
      text: tableTemplate,
      forceMoveMarkers: true,
    }]);
    currentCodeEditor.pushUndoStop();
    currentCodeEditor.focus();
  }

  function insertFencedCode() {
    if (!currentCodeEditor) return;
    const model = currentCodeEditor.getModel();
    if (!model) return;
    const sel = currentCodeEditor.getSelection();
    const text = model.getValueInRange(sel);
    const replacement = `\n\`\`\`\n${text}\n\`\`\`\n`;

    currentCodeEditor.pushUndoStop();
    currentCodeEditor.executeEdits('fenced-code', [{
      range: sel,
      text: replacement,
      forceMoveMarkers: true,
    }]);
    currentCodeEditor.pushUndoStop();
    currentCodeEditor.focus();
  }

  async function insertLink() {
    if (!currentCodeEditor) return;
    const model = currentCodeEditor.getModel();
    if (!model) return;
    const sel = currentCodeEditor.getSelection();
    const selectedText = model.getValueInRange(sel);

    const promptFn = (typeof window.promptModal === 'function')
      ? window.promptModal
      : async () => null;

    const url = await promptFn(window.t ? window.t('ed2InsertLinkUrl', null, 'Enter URL:') : 'Enter URL:', 'https://');
    if (!url) return;

    let label = selectedText;
    if (!label) {
      label = await promptFn(window.t ? window.t('ed2InsertLinkText', null, 'Enter link text:') : 'Enter link text:', url);
    }
    label = label || url;
    const mdLink = `[${label}](${url})`;

    currentCodeEditor.pushUndoStop();
    currentCodeEditor.executeEdits('insert-link', [{
      range: sel,
      text: mdLink,
      forceMoveMarkers: true,
    }]);
    currentCodeEditor.pushUndoStop();
    currentCodeEditor.focus();
  }

  // --- Register All Commands ---

  function initCommands() {
    // 1. File Group
    registerCommand({
      id: 'file.newFile',
      labelKey: 'ed2MenuNewFile',
      label: 'New File…',
      shortcut: 'Ctrl+Alt+N',
      enabled: () => true,
      run: async () => {
        const promptFn = (typeof window.promptModal === 'function')
          ? window.promptModal
          : async () => null;
        const folder = (window.EditorV2IO && window.EditorV2IO.getSelectedFolder) ? window.EditorV2IO.getSelectedFolder() : '';
        const defaultVal = folder ? `${folder}/` : '';
        const name = await promptFn(window.t ? window.t('ed2NewFileName', null, 'New File name:') : 'New File name:', defaultVal, 'e.g. note.md');
        if (!name || !name.trim()) return;
        let targetRel = name.trim();
        if (folder && !targetRel.startsWith(folder + '/') && !targetRel.includes('/')) {
          targetRel = `${folder}/${targetRel}`;
        }
        await window.EditorV2IO.createFile({ fileId: targetRel, kind: 'file' });
        await window.EditorV2IO.fetchTree();
        await window.EditorV2IO.openIntoTab({ fileId: targetRel });
      }
    });

    registerCommand({
      id: 'file.newTextFile',
      labelKey: 'ed2MenuNewTextFile',
      label: 'New Text File',
      shortcut: 'Alt+N',
      enabled: () => true,
      run: () => { window.EditorV2.createUntitledTab(); }
    });

    registerCommand({
      id: 'file.open',
      labelKey: 'ed2MenuOpenFile',
      label: 'Open…',
      shortcut: 'Ctrl+O',
      enabled: () => true,
      run: async () => { await window.EditorV2IO.openIntoTab({}); }
    });

    registerCommand({
      id: 'file.save',
      labelKey: 'ed2MenuSave',
      label: 'Save',
      shortcut: 'Ctrl+S',
      enabled: () => {
        const tab = window.EditorV2.getActiveTab();
        return tab && tab.kind === 'document' && !tab.savePending;
      },
      run: async () => {
        const tab = window.EditorV2.getActiveTab();
        if (!tab || tab.savePending) return;
        if (!tab.target || tab.untitled) {
          await window.EditorV2IO.saveAs(tab);
        } else {
          await window.EditorV2IO.save(tab);
        }
      }
    });

    registerCommand({
      id: 'file.saveAs',
      labelKey: 'ed2MenuSaveAs',
      label: 'Save As…',
      shortcut: 'Ctrl+Shift+S',
      enabled: () => {
        const tab = window.EditorV2.getActiveTab();
        return tab && tab.kind === 'document' && !tab.savePending;
      },
      run: async () => {
        const tab = window.EditorV2.getActiveTab();
        if (tab && !tab.savePending) await window.EditorV2IO.saveAs(tab);
      }
    });

    registerCommand({
      id: 'file.saveAll',
      labelKey: 'ed2MenuSaveAll',
      label: 'Save All',
      shortcut: '',
      enabled: () => window.EditorV2.getTabs().some(t => t.dirty && !t.savePending),
      run: async () => {
        const tabs = window.EditorV2.getTabs();
        for (const tab of tabs) {
          if (tab.dirty && tab.kind === 'document' && !tab.savePending) {
            const ok = (tab.untitled || !tab.target)
              ? await window.EditorV2IO.saveAs(tab)
              : await window.EditorV2IO.save(tab);
            if (!ok) break; // Abort on cancel/failure
          }
        }
      }
    });

    registerCommand({
      id: 'file.close',
      labelKey: 'ed2MenuClose',
      label: 'Close',
      shortcut: 'Alt+W',
      enabled: () => {
        const tab = window.EditorV2.getActiveTab();
        return tab !== null && !tab.savePending;
      },
      run: async () => {
        const tab = window.EditorV2.getActiveTab();
        if (tab && !tab.savePending) await window.EditorV2.closeTab(tab.id);
      }
    });

    registerCommand({
      id: 'file.closeAll',
      labelKey: 'ed2MenuCloseAll',
      label: 'Close All',
      shortcut: 'Ctrl+Alt+W',
      enabled: () => window.EditorV2.getTabs().length > 0,
      run: async () => {
        const tabs = [...window.EditorV2.getTabs()];
        for (const t of tabs) {
          if (t.savePending) continue;
          const closed = await window.EditorV2.closeTab(t.id);
          if (!closed) break;
        }
      }
    });

    // 2. Edit Group
    registerCommand({
      id: 'edit.undo',
      labelKey: 'ed2MenuUndo',
      label: 'Undo',
      shortcut: 'Ctrl+Z',
      enabled: () => currentCodeEditor !== null,
      run: () => { triggerMonacoAction('undo'); }
    });

    registerCommand({
      id: 'edit.redo',
      labelKey: 'ed2MenuRedo',
      label: 'Redo',
      shortcut: 'Ctrl+Y',
      enabled: () => currentCodeEditor !== null,
      run: () => { triggerMonacoAction('redo'); }
    });

    registerCommand({
      id: 'edit.cut',
      labelKey: 'ed2MenuCut',
      label: 'Cut',
      shortcut: 'Ctrl+X',
      enabled: () => currentCodeEditor && !currentCodeEditor.getSelection()?.isEmpty(),
      run: () => { triggerMonacoAction('editor.action.clipboardCutAction'); }
    });

    registerCommand({
      id: 'edit.copy',
      labelKey: 'ed2MenuCopy',
      label: 'Copy',
      shortcut: 'Ctrl+C',
      enabled: () => currentCodeEditor && !currentCodeEditor.getSelection()?.isEmpty(),
      run: () => { triggerMonacoAction('editor.action.clipboardCopyAction'); }
    });

    registerCommand({
      id: 'edit.paste',
      labelKey: 'ed2MenuPaste',
      label: 'Paste',
      shortcut: 'Ctrl+V',
      enabled: () => currentCodeEditor !== null,
      run: () => { triggerMonacoAction('editor.action.clipboardPasteAction'); }
    });

    registerCommand({
      id: 'edit.find',
      labelKey: 'ed2MenuFind',
      label: 'Find',
      shortcut: 'Ctrl+F',
      enabled: () => currentCodeEditor !== null,
      run: () => { triggerMonacoAction('actions.find'); }
    });

    registerCommand({
      id: 'edit.replace',
      labelKey: 'ed2MenuReplace',
      label: 'Replace',
      shortcut: 'Ctrl+H',
      enabled: () => currentCodeEditor !== null,
      run: () => { triggerMonacoAction('editor.action.startFindReplaceAction'); }
    });

    registerCommand({
      id: 'edit.gotoLine',
      labelKey: 'ed2MenuGoToLine',
      label: 'Go to Line…',
      shortcut: 'Ctrl+G',
      enabled: () => currentCodeEditor !== null,
      run: () => { triggerMonacoAction('editor.action.gotoLine'); }
    });

    registerCommand({
      id: 'edit.toggleLineComment',
      labelKey: 'ed2MenuToggleLineComment',
      label: 'Toggle Line Comment',
      shortcut: 'Ctrl+/',
      enabled: () => currentCodeEditor !== null,
      run: () => { triggerMonacoAction('editor.action.commentLine'); }
    });

    registerCommand({
      id: 'edit.toggleBlockComment',
      labelKey: 'ed2MenuToggleBlockComment',
      label: 'Toggle Block Comment',
      shortcut: 'Shift+Alt+A',
      enabled: () => currentCodeEditor !== null,
      run: () => { triggerMonacoAction('editor.action.blockComment'); }
    });

    registerCommand({
      id: 'edit.indent',
      labelKey: 'ed2MenuIndent',
      label: 'Indent',
      shortcut: 'Tab',
      enabled: () => currentCodeEditor !== null,
      run: () => { triggerMonacoAction('editor.action.indentLines'); }
    });

    registerCommand({
      id: 'edit.outdent',
      labelKey: 'ed2MenuOutdent',
      label: 'Outdent',
      shortcut: 'Shift+Tab',
      enabled: () => currentCodeEditor !== null,
      run: () => { triggerMonacoAction('editor.action.outdentLines'); }
    });

    // 3. Selection Group (Theia MenubarSelectionMenu 1:1)
    const selectionActions = [
      { id: 'selection.selectAll', action: 'editor.action.selectAll', labelKey: 'ed2MenuSelectAll', label: 'Select All', shortcut: 'Ctrl+A' },
      { id: 'selection.expand', action: 'editor.action.smartSelect.expand', labelKey: 'ed2MenuExpandSelection', label: 'Expand Selection', shortcut: 'Shift+Alt+Right' },
      { id: 'selection.shrink', action: 'editor.action.smartSelect.shrink', labelKey: 'ed2MenuShrinkSelection', label: 'Shrink Selection', shortcut: 'Shift+Alt+Left' },
      { id: 'selection.separator1', separator: true },
      { id: 'selection.copyLineUp', action: 'editor.action.copyLinesUpAction', labelKey: 'ed2MenuCopyLineUp', label: 'Copy Line Up', shortcut: 'Shift+Alt+Up' },
      { id: 'selection.copyLineDown', action: 'editor.action.copyLinesDownAction', labelKey: 'ed2MenuCopyLineDown', label: 'Copy Line Down', shortcut: 'Shift+Alt+Down' },
      { id: 'selection.moveLineUp', action: 'editor.action.moveLinesUpAction', labelKey: 'ed2MenuMoveLineUp', label: 'Move Line Up', shortcut: 'Alt+Up' },
      { id: 'selection.moveLineDown', action: 'editor.action.moveLinesDownAction', labelKey: 'ed2MenuMoveLineDown', label: 'Move Line Down', shortcut: 'Alt+Down' },
      { id: 'selection.duplicate', action: 'editor.action.duplicateSelection', labelKey: 'ed2MenuDuplicateSelection', label: 'Duplicate Selection', shortcut: '' },
      { id: 'selection.separator2', separator: true },
      { id: 'selection.addCursorAbove', action: 'editor.action.insertCursorAbove', labelKey: 'ed2MenuAddCursorAbove', label: 'Add Cursor Above', shortcut: 'Ctrl+Alt+Up' },
      { id: 'selection.addCursorBelow', action: 'editor.action.insertCursorBelow', labelKey: 'ed2MenuAddCursorBelow', label: 'Add Cursor Below', shortcut: 'Ctrl+Alt+Down' },
      { id: 'selection.addCursorsToLineEnds', action: 'editor.action.insertCursorAtEndOfEachLineSelected', labelKey: 'ed2MenuAddCursorsToLineEnds', label: 'Add Cursors to Line Ends', shortcut: 'Shift+Alt+I' },
      { id: 'selection.addNextOccurrence', action: 'editor.action.addSelectionToNextFindMatch', labelKey: 'ed2MenuAddNextOccurrence', label: 'Add Next Occurrence', shortcut: 'Ctrl+D' },
      { id: 'selection.addPreviousOccurrence', action: 'editor.action.addSelectionToPreviousFindMatch', labelKey: 'ed2MenuAddPreviousOccurrence', label: 'Add Previous Occurrence', shortcut: '' },
      { id: 'selection.selectAllOccurrences', action: 'editor.action.selectHighlights', labelKey: 'ed2MenuSelectAllOccurrences', label: 'Select All Occurrences', shortcut: 'Ctrl+Shift+L' },
    ];

    selectionActions.forEach(item => {
      if (item.separator) {
        registerCommand({ id: item.id, separator: true });
        return;
      }
      registerCommand({
        id: item.id,
        labelKey: item.labelKey,
        label: item.label,
        shortcut: item.shortcut,
        enabled: () => currentCodeEditor !== null,
        run: () => { triggerMonacoAction(item.action); }
      });
    });

    // 4. Markdown Toolbar commands
    registerCommand({ id: 'md.bold', run: () => applySurroundEdit('**', '**') });
    registerCommand({ id: 'md.italic', run: () => applySurroundEdit('*', '*') });
    registerCommand({ id: 'md.heading', run: () => cycleHeading() });
    registerCommand({ id: 'md.strikethrough', run: () => applySurroundEdit('~~', '~~') });
    registerCommand({ id: 'md.ul', run: () => applyLinePrefixToggle('- ') });
    registerCommand({ id: 'md.ol', run: () => applyLinePrefixToggle('1. ') });
    registerCommand({ id: 'md.task', run: () => applyLinePrefixToggle('- [ ] ') });
    registerCommand({ id: 'md.quote', run: () => applyLinePrefixToggle('> ') });
    registerCommand({ id: 'md.code', run: () => applySurroundEdit('`', '`') });
    registerCommand({ id: 'md.fencedCode', run: () => insertFencedCode() });
    registerCommand({ id: 'md.table', run: () => insertTable() });
    registerCommand({ id: 'md.link', run: () => insertLink() });
  }

  // --- Menubar Rendering and Popups ---

  const MENU_STRUCTURE = {
    file: [
      'file.newFile',
      'file.newTextFile',
      'file.open',
      '---',
      'file.save',
      'file.saveAs',
      'file.saveAll',
      '---',
      'file.close',
      'file.closeAll',
    ],
    edit: [
      'edit.undo',
      'edit.redo',
      '---',
      'edit.cut',
      'edit.copy',
      'edit.paste',
      '---',
      'edit.find',
      'edit.replace',
      'edit.gotoLine',
      '---',
      'edit.toggleLineComment',
      'edit.toggleBlockComment',
      'edit.indent',
      'edit.outdent',
    ],
    selection: [
      'selection.selectAll',
      'selection.expand',
      'selection.shrink',
      '---',
      'selection.copyLineUp',
      'selection.copyLineDown',
      'selection.moveLineUp',
      'selection.moveLineDown',
      'selection.duplicate',
      '---',
      'selection.addCursorAbove',
      'selection.addCursorBelow',
      'selection.addCursorsToLineEnds',
      'selection.addNextOccurrence',
      'selection.addPreviousOccurrence',
      'selection.selectAllOccurrences',
    ]
  };

  let activeOpenMenu = null;

  function closeAllMenus() {
    if (!layoutRefs) return;
    layoutRefs.menubar.querySelectorAll('.ed2-menu-dropdown').forEach(d => d.classList.remove('open'));
    layoutRefs.menubar.querySelectorAll('.ed2-menubar-btn').forEach(b => b.classList.remove('active'));
    activeOpenMenu = null;
  }

  function renderMenuDropdown(menuName, container) {
    container.innerHTML = '';
    const items = MENU_STRUCTURE[menuName] || [];

    items.forEach(itemKey => {
      if (itemKey === '---') {
        const sep = document.createElement('div');
        sep.className = 'ed2-menu-separator';
        container.appendChild(sep);
        return;
      }

      const cmd = getCommand(itemKey);
      if (!cmd) return;

      const btn = document.createElement('button');
      btn.className = 'ed2-menu-item';
      btn.setAttribute('role', 'menuitem');

      const isEnabled = !cmd.enabled || cmd.enabled();
      btn.disabled = !isEnabled;

      // Label with i18n support
      const labelText = (window.t && cmd.labelKey) ? window.t(cmd.labelKey, null, cmd.label) : (cmd.label || itemKey);
      const textSpan = document.createElement('span');
      textSpan.textContent = labelText;
      btn.appendChild(textSpan);

      // Shortcut
      if (cmd.shortcut) {
        const scSpan = document.createElement('span');
        scSpan.className = 'ed2-menu-shortcut';
        scSpan.textContent = cmd.shortcut;
        btn.appendChild(scSpan);
      }

      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeAllMenus();
        await runCommand(cmd.id);
      });

      container.appendChild(btn);
    });
  }

  function renderMenubarLabels() {
    if (!layoutRefs || !layoutRefs.menubar) return;
    const t = window.t || ((k, _, f) => f);
    const fileBtn = layoutRefs.menubar.querySelector('#ed2-menu-btn-file');
    const editBtn = layoutRefs.menubar.querySelector('#ed2-menu-btn-edit');
    const selBtn = layoutRefs.menubar.querySelector('#ed2-menu-btn-selection');
    if (fileBtn) fileBtn.textContent = t('ed2MenuFile', null, 'File');
    if (editBtn) editBtn.textContent = t('ed2MenuEdit', null, 'Edit');
    if (selBtn) selBtn.textContent = t('ed2MenuSelection', null, 'Selection');
  }

  let menubarKeydownHandler = null;
  let globalKeydownHandler = null;

  function setupMenubar(refs) {
    layoutRefs = refs;
    const menubar = refs.menubar;

    renderMenubarLabels();

    ['file', 'edit', 'selection'].forEach(menuName => {
      const btn = menubar.querySelector(`#ed2-menu-btn-${menuName}`);
      const dropdown = menubar.querySelector(`#ed2-menu-${menuName}`);
      if (!btn || !dropdown) return;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.contains('open');
        closeAllMenus();
        if (!isOpen) {
          renderMenuDropdown(menuName, dropdown);
          dropdown.classList.add('open');
          btn.classList.add('active');
          activeOpenMenu = menuName;
          const firstItem = dropdown.querySelector('.ed2-menu-item:not(:disabled)');
          if (firstItem) firstItem.focus();
        }
      });

      btn.addEventListener('mouseenter', () => {
        if (activeOpenMenu && activeOpenMenu !== menuName) {
          closeAllMenus();
          renderMenuDropdown(menuName, dropdown);
          dropdown.classList.add('open');
          btn.classList.add('active');
          activeOpenMenu = menuName;
        }
      });
    });

    const docClickHandler = (e) => {
      if (!menubar.contains(e.target)) {
        closeAllMenus();
      }
    };
    document.addEventListener('click', docClickHandler);

    menubarKeydownHandler = (e) => {
      if (!activeOpenMenu) return;
      const dropdown = menubar.querySelector(`#ed2-menu-${activeOpenMenu}`);
      const menuBtn = menubar.querySelector(`#ed2-menu-btn-${activeOpenMenu}`);
      if (!dropdown) return;

      const items = Array.from(dropdown.querySelectorAll('.ed2-menu-item:not(:disabled)'));
      const currentIndex = items.indexOf(document.activeElement);

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeAllMenus();
        if (menuBtn) menuBtn.focus();
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const nextIdx = (currentIndex + 1) % items.length;
        if (items[nextIdx]) items[nextIdx].focus();
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const prevIdx = (currentIndex - 1 + items.length) % items.length;
        if (items[prevIdx]) items[prevIdx].focus();
        return;
      }

      if (e.key === 'Home') {
        e.preventDefault();
        e.stopPropagation();
        if (items[0]) items[0].focus();
        return;
      }

      if (e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        if (items[items.length - 1]) items[items.length - 1].focus();
        return;
      }
    };
    document.addEventListener('keydown', menubarKeydownHandler);
  }

  function bindKeyboardShortcuts(rootEl, editor) {
    if (globalKeydownHandler) {
      window.removeEventListener('keydown', globalKeydownHandler, true);
      globalKeydownHandler = null;
    }

    globalKeydownHandler = (e) => {
      if (!rootEl || !document.body.contains(rootEl)) return;
      if (rootEl.offsetParent === null && rootEl.offsetWidth === 0) return;

      const isMod = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;
      const isAlt = e.altKey;
      const key = e.key;

      // 1. Alt+W: Close Tab
      if (isAlt && !isMod && !isShift && (key === 'w' || key === 'W')) {
        e.preventDefault();
        e.stopPropagation();
        runCommand('file.close');
        return;
      }

      // 2. Ctrl+Alt+W: Close All Tabs
      if (isMod && isAlt && (key === 'w' || key === 'W')) {
        e.preventDefault();
        e.stopPropagation();
        runCommand('file.closeAll');
        return;
      }

      // 3. Alt+N: New Text File
      if (isAlt && !isMod && !isShift && (key === 'n' || key === 'N')) {
        e.preventDefault();
        e.stopPropagation();
        runCommand('file.newTextFile');
        return;
      }

      // 4. Ctrl+Alt+N: New File
      if (isMod && isAlt && !isShift && (key === 'n' || key === 'N')) {
        e.preventDefault();
        e.stopPropagation();
        runCommand('file.newFile');
        return;
      }

      // 5. Ctrl+S / Ctrl+Shift+S (Prevent browser save)
      if (isMod && !isAlt && (key === 's' || key === 'S')) {
        e.preventDefault();
        e.stopPropagation();
        if (isShift) {
          runCommand('file.saveAs');
        } else {
          runCommand('file.save');
        }
        return;
      }

      // 6. Ctrl+O: Open File (Prevent browser open file)
      if (isMod && !isAlt && !isShift && (key === 'o' || key === 'O')) {
        e.preventDefault();
        e.stopPropagation();
        runCommand('file.open');
        return;
      }

      // 7. Alt+PageUp / Alt+PageDown: switch tabs
      if (isAlt && !isMod && !isShift && key === 'PageUp') {
        e.preventDefault();
        e.stopPropagation();
        if (window.EditorV2 && window.EditorV2.prevTab) window.EditorV2.prevTab();
        return;
      }
      if (isAlt && !isMod && !isShift && key === 'PageDown') {
        e.preventDefault();
        e.stopPropagation();
        if (window.EditorV2 && window.EditorV2.nextTab) window.EditorV2.nextTab();
        return;
      }

      // 8. Ctrl+F / Ctrl+H / Ctrl+G
      if (isMod && !isAlt && !isShift) {
        if (key === 'f' || key === 'F') {
          e.preventDefault();
          e.stopPropagation();
          runCommand('edit.find');
          return;
        }
        if (key === 'h' || key === 'H') {
          e.preventDefault();
          e.stopPropagation();
          runCommand('edit.replace');
          return;
        }
        if (key === 'g' || key === 'G') {
          e.preventDefault();
          e.stopPropagation();
          runCommand('edit.gotoLine');
          return;
        }
      }

      // 9. Move & Copy lines (Alt+Up/Down, Shift+Alt+Up/Down)
      if (isAlt && !isMod) {
        if (key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          runCommand(isShift ? 'selection.copyLineUp' : 'selection.moveLineUp');
          return;
        }
        if (key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          runCommand(isShift ? 'selection.copyLineDown' : 'selection.moveLineDown');
          return;
        }
      }

      // 10. Multi-cursor (Ctrl+Alt+Up/Down)
      if (isMod && isAlt && !isShift) {
        if (key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          runCommand('selection.addCursorAbove');
          return;
        }
        if (key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          runCommand('selection.addCursorBelow');
          return;
        }
      }
    };

    window.addEventListener('keydown', globalKeydownHandler, true);
  }

  function setupToolbar(refs) {
    // Undo / Redo
    refs.toolbar.querySelector('#ed2-tb-undo')?.addEventListener('click', () => runCommand('edit.undo'));
    refs.toolbar.querySelector('#ed2-tb-redo')?.addEventListener('click', () => runCommand('edit.redo'));

    // Markdown formats
    refs.toolbar.querySelector('#ed2-tb-bold')?.addEventListener('click', () => runCommand('md.bold'));
    refs.toolbar.querySelector('#ed2-tb-italic')?.addEventListener('click', () => runCommand('md.italic'));
    refs.toolbar.querySelector('#ed2-tb-heading')?.addEventListener('click', () => runCommand('md.heading'));
    refs.toolbar.querySelector('#ed2-tb-strikethrough')?.addEventListener('click', () => runCommand('md.strikethrough'));
    refs.toolbar.querySelector('#ed2-tb-ul')?.addEventListener('click', () => runCommand('md.ul'));
    refs.toolbar.querySelector('#ed2-tb-ol')?.addEventListener('click', () => runCommand('md.ol'));
    refs.toolbar.querySelector('#ed2-tb-task')?.addEventListener('click', () => runCommand('md.task'));
    refs.toolbar.querySelector('#ed2-tb-quote')?.addEventListener('click', () => runCommand('md.quote'));
    refs.toolbar.querySelector('#ed2-tb-code')?.addEventListener('click', () => runCommand('md.code'));
    refs.toolbar.querySelector('#ed2-tb-fenced-code')?.addEventListener('click', () => runCommand('md.fencedCode'));
    refs.toolbar.querySelector('#ed2-tb-table')?.addEventListener('click', () => runCommand('md.table'));
    refs.toolbar.querySelector('#ed2-tb-link')?.addEventListener('click', () => runCommand('md.link'));

    // Image & AI buttons
    refs.toolbar.querySelector('#ed2-tb-image')?.addEventListener('click', () => {
      if (window.EditorV2Extras && window.EditorV2Extras.showImageModal) {
        window.EditorV2Extras.showImageModal();
      }
    });
    refs.toolbar.querySelector('#ed2-tb-ai')?.addEventListener('click', () => {
      if (window.EditorV2Extras && window.EditorV2Extras.showAiModal) {
        window.EditorV2Extras.showAiModal();
      }
    });

    // Diff button
    refs.toolbar.querySelector('#ed2-tb-diff')?.addEventListener('click', () => {
      if (window.EditorV2Diff && window.EditorV2Diff.openDiffModal) {
        window.EditorV2Diff.openDiffModal();
      }
    });

    // View modes
    refs.toolbar.querySelector('#ed2-tb-mode-edit')?.addEventListener('click', () => {
      if (window.EditorV2Preview) window.EditorV2Preview.setPreviewMode('edit');
    });
    refs.toolbar.querySelector('#ed2-tb-mode-split')?.addEventListener('click', () => {
      if (window.EditorV2Preview) window.EditorV2Preview.setPreviewMode('split');
    });
    refs.toolbar.querySelector('#ed2-tb-mode-reader')?.addEventListener('click', () => {
      if (window.EditorV2Preview) window.EditorV2Preview.setPreviewMode('reader');
    });
    refs.toolbar.querySelector('#ed2-tb-toggle-html')?.addEventListener('click', () => {
      if (window.EditorV2Preview) window.EditorV2Preview.toggleHtmlPreview();
    });
    refs.toolbar.querySelector('#ed2-tb-toggle-toc')?.addEventListener('click', () => {
      refs.tocPanel.classList.toggle('hidden');
    });
    refs.toolbar.querySelector('#ed2-tb-focus')?.addEventListener('click', () => {
      refs.root.classList.toggle('focus-mode');
      refs.explorer.classList.toggle('collapsed');
    });
  }

  function init(refs, editor) {
    layoutRefs = refs;
    currentCodeEditor = editor;
    initCommands();
    setupMenubar(refs);
    setupToolbar(refs);
    bindKeyboardShortcuts(refs.root, editor);
  }

  function suspend() {
    if (globalKeydownHandler) {
      window.removeEventListener('keydown', globalKeydownHandler, true);
      globalKeydownHandler = null;
    }
    if (menubarKeydownHandler) {
      document.removeEventListener('keydown', menubarKeydownHandler);
      menubarKeydownHandler = null;
    }
    closeAllMenus();
  }

  window.EditorV2Commands = {
    init,
    suspend,
    run: runCommand,
    getCommand,
    triggerMonacoAction,
    closeAllMenus,
    renderMenubarLabels,
  };
})();
