/**
 * Editor V2 Engine - Monaco Editor 0.56.0 Loader and Wrappers
 */
(() => {
  'use strict';

  let monacoPromise = null;
  let themeObserver = null;
  let currentThemeName = 'ed2-theme';

  // File extension to Monaco language ID map
  const EXT_MAP = {
    'md': 'markdown',
    'markdown': 'markdown',
    'mdown': 'markdown',
    'mkdn': 'markdown',
    'json': 'json',
    'toml': 'ini',
    'env': 'ini',
    'cfg': 'ini',
    'conf': 'ini',
    'ini': 'ini',
    'properties': 'ini',
    'js': 'javascript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'mts': 'typescript',
    'cts': 'typescript',
    'tsx': 'typescript',
    'go': 'go',
    'yaml': 'yaml',
    'yml': 'yaml',
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'xml': 'xml',
    'svg': 'xml',
    'py': 'python',
    'rs': 'rust',
    'c': 'cpp',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'h': 'cpp',
    'hpp': 'cpp',
    'java': 'java',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'sql': 'sql',
    'lua': 'lua',
    'php': 'php',
    'rb': 'ruby',
    'swift': 'swift',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'dart': 'dart',
    'txt': 'plaintext',
    'log': 'plaintext',
  };

  function getLanguageForFilename(filename) {
    if (!filename) return 'plaintext';
    const clean = filename.split(/[?#]/)[0].trim();
    const leaf = clean.split('/').pop().split('\\').pop();
    if (leaf.startsWith('.env')) return 'ini';
    const dotIdx = leaf.lastIndexOf('.');
    if (dotIdx < 0 || dotIdx === leaf.length - 1) return 'plaintext';
    const ext = leaf.slice(dotIdx + 1).toLowerCase();
    return EXT_MAP[ext] || 'plaintext';
  }

  function getRootComputedColor(varName, fallback) {
    const val = getComputedStyle(document.documentElement).getPropertyValue(varName);
    return (val && val.trim()) ? val.trim() : fallback;
  }

  function syncMonacoTheme() {
    if (!window.Ed2Monaco) return;
    const monaco = window.Ed2Monaco;
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    // Flat (non-gradient) surfaces: --bg is a radial-gradient in every theme,
    // so editors use --panel-sticky-bg (flat per-variant) with --code-surface fallback.
    // NOTE: --code-surface is only defined in base dark/light (never per-variant),
    // so editor/gutter/widget backgrounds use `bg` (--panel-sticky-bg) to follow variants.
    const bg = getRootComputedColor('--panel-sticky-bg', getRootComputedColor('--code-surface', isDark ? '#1e1e1e' : '#ffffff'));
    const text = getRootComputedColor('--text', isDark ? '#d4d4d4' : '#333333');
    const textMuted = getRootComputedColor('--text-muted', isDark ? '#858585' : '#717171');
    const accent = getRootComputedColor('--accent', '#007acc');
    const danger = getRootComputedColor('--danger', isDark ? '#f44336' : '#dc2626');
    const accentGlow = getRootComputedColor('--accent-glow', isDark ? 'rgba(79,195,247,0.30)' : 'rgba(14,165,233,0.20)');
    const dangerGlow = getRootComputedColor('--danger-glow', isDark ? 'rgba(239,83,80,0.25)' : 'rgba(220,38,38,0.2)');
    const glassBorder = getRootComputedColor('--glass-border', isDark ? '#3c3c3c' : '#e0e0e0');
    const lineHighlight = isDark ? '#ffffff0a' : '#0000000a';
    const selection = isDark ? '#264f78' : '#add6ff';

    const themeBase = isDark ? 'vs-dark' : 'vs';
    currentThemeName = isDark ? 'ed2-dark' : 'ed2-light';

    monaco.editor.defineTheme(currentThemeName, {
      base: themeBase,
      inherit: true,
      rules: [],
      colors: {
        'editor.background': bg,
        'editor.foreground': text,
        'editorLineNumber.foreground': textMuted,
        'editorLineNumber.activeForeground': text,
        'editor.lineHighlightBackground': lineHighlight,
        'editor.selectionBackground': selection,
        'editorGutter.background': bg,
        'editorCursor.foreground': accent,
        'editorWhitespace.foreground': textMuted,
        'editorWidget.background': bg,
        'editorWidget.border': glassBorder,
        'input.background': bg,
        'input.foreground': text,
        'input.border': glassBorder,
        // DiffEditor inserted/removed line + char colors follow the theme.
        'diffEditor.insertedTextBackground': accentGlow,
        'diffEditor.removedTextBackground': dangerGlow,
        'diffEditor.insertedLineBackground': accentGlow,
        'diffEditor.removedLineBackground': dangerGlow,
        'diffEditorGutter.insertedLineBackground': accentGlow,
        'diffEditorGutter.removedLineBackground': dangerGlow,
        'diffEditorOverview.insertedForeground': accent,
        'diffEditorOverview.removedForeground': danger,
        'editorOverviewRuler.insertedForeground': accent,
        'editorOverviewRuler.removedForeground': danger,
      }
    });

    monaco.editor.setTheme(currentThemeName);
  }

  function setupThemeObserver() {
    if (themeObserver) return;
    themeObserver = new MutationObserver((mutations) => {
      let needsUpdate = false;
      for (const m of mutations) {
        if (m.type === 'attributes' && (
          m.attributeName === 'data-theme' ||
          m.attributeName === 'data-theme-variant' ||
          m.attributeName === 'data-theme-style' ||
          m.attributeName === 'data-font-size'
        )) {
          needsUpdate = true;
          break;
        }
      }
      if (needsUpdate) {
        syncMonacoTheme();
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-theme-variant', 'data-theme-style', 'data-font-size']
    });
  }

  function getBaseCodeFontSize() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--font-code');
    const parsed = parseFloat(raw);
    return (parsed && parsed > 0) ? parsed : 13;
  }

  function loadEngine() {
    if (monacoPromise) return monacoPromise;

    monacoPromise = new Promise((resolve, reject) => {
      // 1. Ensure MonacoEnvironment worker configuration
      window.MonacoEnvironment = window.MonacoEnvironment || {};
      window.MonacoEnvironment.getWorker = function (_workerId, _label) {
        return new Worker('/vendor/monaco/editor.worker.js');
      };

      // 2. Load CSS if not loaded
      if (!document.getElementById('ed2-monaco-css')) {
        const link = document.createElement('link');
        link.id = 'ed2-monaco-css';
        link.rel = 'stylesheet';
        link.href = '/vendor/monaco/ed2monaco.css';
        document.head.appendChild(link);
      }

      // 3. If Ed2Monaco already loaded
      if (window.Ed2Monaco) {
        syncMonacoTheme();
        setupThemeObserver();
        return resolve(window.Ed2Monaco);
      }

      // 4. Load ed2monaco.js script
      const script = document.createElement('script');
      script.id = 'ed2-monaco-js';
      script.src = '/vendor/monaco/ed2monaco.js';
      script.async = true;
      script.onload = () => {
        if (!window.Ed2Monaco) {
          monacoPromise = null;
          return reject(new Error('Ed2Monaco global not found after loading ed2monaco.js'));
        }
        syncMonacoTheme();
        setupThemeObserver();
        resolve(window.Ed2Monaco);
      };
      script.onerror = () => {
        monacoPromise = null;
        reject(new Error('Failed to load Monaco Editor V2 bundle (/vendor/monaco/ed2monaco.js)'));
      };
      document.head.appendChild(script);
    });

    return monacoPromise;
  }

  window.EditorV2Engine = {
    load: loadEngine,
    getLanguageForFilename,
    syncMonacoTheme,
    getBaseCodeFontSize,
    getCurrentThemeName: () => currentThemeName,
  };
})();
