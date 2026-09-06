/**
 * Editor V2 Layout - DOM Scaffolding and Component Construction
 */
(() => {
  'use strict';

  function createLayout(container) {
    container.innerHTML = `
      <div class="ed2-root" id="ed2-root">
        <!-- Top Compact Menubar -->
        <div class="ed2-menubar" id="ed2-menubar" role="menubar">
          <div class="ed2-menubar-item" data-menu="file">
            <button class="ed2-menubar-btn" id="ed2-menu-btn-file" role="menuitem" aria-haspopup="true">${typeof window.t === 'function' ? window.t('ed2MenuFile') : 'File'}</button>
            <div class="ed2-menu-dropdown" id="ed2-menu-file" role="menu"></div>
          </div>
          <div class="ed2-menubar-item" data-menu="edit">
            <button class="ed2-menubar-btn" id="ed2-menu-btn-edit" role="menuitem" aria-haspopup="true">${typeof window.t === 'function' ? window.t('ed2MenuEdit') : 'Edit'}</button>
            <div class="ed2-menu-dropdown" id="ed2-menu-edit" role="menu"></div>
          </div>
          <div class="ed2-menubar-item" data-menu="selection">
            <button class="ed2-menubar-btn" id="ed2-menu-btn-selection" role="menuitem" aria-haspopup="true">${typeof window.t === 'function' ? window.t('ed2MenuSelection') : 'Selection'}</button>
            <div class="ed2-menu-dropdown" id="ed2-menu-selection" role="menu"></div>
          </div>
        </div>

        <!-- Workbench Body -->
        <div class="ed2-workbench" id="ed2-workbench">
          <!-- Left Explorer Tree -->
          <div class="ed2-explorer" id="ed2-explorer">
            <div class="ed2-explorer-header">
              <span id="ed2-explorer-title">Explorer</span>
              <div class="ed2-explorer-actions">
                <button class="ed2-icon-btn" id="ed2-tree-new-file" data-tooltip="New File" aria-label="New File">
                  <i class="codicon codicon-new-file"></i>
                </button>
                <button class="ed2-icon-btn" id="ed2-tree-new-folder" data-tooltip="New Folder" aria-label="New Folder">
                  <i class="codicon codicon-new-folder"></i>
                </button>
                <button class="ed2-icon-btn" id="ed2-tree-refresh" data-tooltip="Refresh" aria-label="Refresh">
                  <i class="codicon codicon-refresh"></i>
                </button>
                <button class="ed2-icon-btn" id="ed2-tree-collapse" data-tooltip="Collapse Explorer" aria-label="Collapse Explorer">
                  <i class="codicon codicon-chevron-left"></i>
                </button>
              </div>
            </div>
            <div class="ed2-tree-container" id="ed2-tree-container"></div>
          </div>

          <!-- Main Area (Tabs + Toolbar + Monaco/Preview/Diff) -->
          <div class="ed2-main-area" id="ed2-main-area">
            <!-- Tabs Bar -->
            <div class="ed2-tabs-bar" id="ed2-tabs-bar">
              <button class="ed2-tabs-new-btn" id="ed2-btn-new-tab" data-tooltip="New Text File (Alt+N)" aria-label="New Text File">
                <i class="codicon codicon-plus"></i>
              </button>
            </div>

            <!-- Format & Action Toolbar -->
            <div class="ed2-toolbar" id="ed2-toolbar">
              <div class="ed2-toolbar-group" id="ed2-md-toolbar-group">
                <!-- Undo / Redo -->
                <button class="ed2-icon-btn" id="ed2-tb-undo" data-action="undo" data-tooltip="Undo (Ctrl+Z)"><i class="codicon codicon-discard"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-redo" data-action="redo" data-tooltip="Redo (Ctrl+Y)"><i class="codicon codicon-redo"></i></button>
                <div class="ed2-toolbar-separator"></div>
                <!-- Markdown basic formatters -->
                <button class="ed2-icon-btn" id="ed2-tb-bold" data-action="bold" data-tooltip="Bold (Ctrl+B)"><i class="codicon codicon-bold"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-italic" data-action="italic" data-tooltip="Italic (Ctrl+I)"><i class="codicon codicon-italic"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-heading" data-action="heading" data-tooltip="Heading Cycle"><i class="codicon codicon-heading"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-strikethrough" data-action="strikethrough" data-tooltip="Strikethrough"><i class="codicon codicon-clear-all"></i></button>
                <div class="ed2-toolbar-separator"></div>
                <button class="ed2-icon-btn" id="ed2-tb-ul" data-action="unordered-list" data-tooltip="Bulleted List"><i class="codicon codicon-list-unordered"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-ol" data-action="ordered-list" data-tooltip="Numbered List"><i class="codicon codicon-list-ordered"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-task" data-action="task-list" data-tooltip="Task List"><i class="codicon codicon-checklist"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-quote" data-action="quote" data-tooltip="Blockquote"><i class="codicon codicon-quote"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-code" data-action="code" data-tooltip="Inline Code"><i class="codicon codicon-code"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-fenced-code" data-action="fenced-code" data-tooltip="Code Block"><i class="codicon codicon-file-code"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-table" data-action="table" data-tooltip="Insert Table"><i class="codicon codicon-table"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-link" data-action="link" data-tooltip="Insert Link"><i class="codicon codicon-link"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-image" data-action="image" data-tooltip="Insert Image"><i class="codicon codicon-file-media"></i></button>
                <div class="ed2-toolbar-separator"></div>
                <button class="ed2-icon-btn" id="ed2-tb-ai" data-action="ai" data-tooltip="AI Assistant"><i class="codicon codicon-sparkle"></i></button>
              </div>

              <div class="ed2-toolbar-group" id="ed2-view-toolbar-group">
                <button class="ed2-icon-btn" id="ed2-tb-diff" data-action="open-diff" data-tooltip="Compare Diff"><i class="codicon codicon-diff"></i></button>
                <div class="ed2-toolbar-separator"></div>
                <button class="ed2-icon-btn" id="ed2-tb-mode-edit" data-view="edit" data-tooltip="Edit Mode"><i class="codicon codicon-edit"></i></button>
                <button class="ed2-icon-btn active" id="ed2-tb-mode-split" data-view="split" data-tooltip="Split View"><i class="codicon codicon-split-horizontal"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-mode-reader" data-view="reader" data-tooltip="Reader Mode"><i class="codicon codicon-book"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-toggle-html" data-action="toggle-html" data-tooltip="HTML Preview"><i class="codicon codicon-browser"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-toggle-toc" data-action="toggle-toc" data-tooltip="Toggle TOC"><i class="codicon codicon-list-tree"></i></button>
                <button class="ed2-icon-btn" id="ed2-tb-focus" data-action="toggle-focus" data-tooltip="Focus Mode"><i class="codicon codicon-screen-full"></i></button>
              </div>
            </div>

            <!-- Content Split (Monaco + Preview + TOC) -->
            <div class="ed2-content-split" id="ed2-content-split">
              <div class="ed2-monaco-host" id="ed2-monaco-host"></div>
              <div class="ed2-preview-host" id="ed2-preview-host"></div>
              <div class="ed2-toc-panel hidden" id="ed2-toc-panel"></div>
            </div>

            <!-- Status Bar -->
            <div class="ed2-statusbar" id="ed2-statusbar">
              <div class="ed2-status-group" id="ed2-status-left">
                <span class="ed2-status-item" id="ed2-status-pos">Ln 1, Col 1</span>
                <span class="ed2-status-item" id="ed2-status-lines">0 lines</span>
                <span class="ed2-status-item" id="ed2-status-stats">0 words, 0 chars</span>
              </div>
              <div class="ed2-status-group" id="ed2-status-right">
                <span class="ed2-status-item" id="ed2-status-wrap" title="Toggle Word Wrap">Wrap: On</span>
                <span class="ed2-status-item" id="ed2-status-eol">LF</span>
                <span class="ed2-status-item" id="ed2-status-encoding">UTF-8</span>
                <span class="ed2-status-item" id="ed2-status-lang">Plain Text</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    return {
      root: container.querySelector('#ed2-root'),
      menubar: container.querySelector('#ed2-menubar'),
      workbench: container.querySelector('#ed2-workbench'),
      explorer: container.querySelector('#ed2-explorer'),
      treeContainer: container.querySelector('#ed2-tree-container'),
      mainArea: container.querySelector('#ed2-main-area'),
      tabsBar: container.querySelector('#ed2-tabs-bar'),
      btnNewTab: container.querySelector('#ed2-btn-new-tab'),
      toolbar: container.querySelector('#ed2-toolbar'),
      contentSplit: container.querySelector('#ed2-content-split'),
      monacoHost: container.querySelector('#ed2-monaco-host'),
      previewHost: container.querySelector('#ed2-preview-host'),
      tocPanel: container.querySelector('#ed2-toc-panel'),
      statusbar: container.querySelector('#ed2-statusbar'),
      statusPos: container.querySelector('#ed2-status-pos'),
      statusLines: container.querySelector('#ed2-status-lines'),
      statusStats: container.querySelector('#ed2-status-stats'),
      statusWrap: container.querySelector('#ed2-status-wrap'),
      statusEol: container.querySelector('#ed2-status-eol'),
      statusEncoding: container.querySelector('#ed2-status-encoding'),
      statusLang: container.querySelector('#ed2-status-lang'),
    };
  }

  window.EditorV2Layout = {
    createLayout,
  };
})();
