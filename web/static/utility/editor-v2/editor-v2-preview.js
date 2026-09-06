/**
 * Editor V2 Preview - Debounced Markdown & HTML Sandbox Preview with Source-Line Scroll Sync
 */
(() => {
  'use strict';

  let layoutRefs = null;
  let activeEditor = null;
  let renderTimer = null;
  let currentTabId = null;
  let currentModelVersion = 0;
  let mountGen = 0;
  let isComposition = false;
  let isSyncingScroll = false;
  let currentPreviewMode = 'split'; // 'edit' | 'split' | 'reader'
  let isHtmlMode = false;
  let activePreviewBlobUrls = [];

  function revokePreviewBlobs() {
    if (activePreviewBlobUrls.length > 0) {
      activePreviewBlobUrls.forEach(url => URL.revokeObjectURL(url));
      activePreviewBlobUrls = [];
    }
  }

  window.addEventListener('compositionstart', () => { isComposition = true; }, true);
  window.addEventListener('compositionend', () => {
    isComposition = false;
    const tab = window.EditorV2 ? window.EditorV2.getActiveTab() : null;
    if (tab) scheduleUpdate(tab);
  }, true);

  function scheduleUpdate(tab) {
    if (!tab || !tab.model) return;
    if (isComposition) return;
    if (currentPreviewMode === 'edit') return; // Preview hidden, skip expensive render

    clearTimeout(renderTimer);
    const delay = (tab.htmlPreview || tab.name.endsWith('.html') || tab.name.endsWith('.htm')) ? 1200 : 300;

    renderTimer = setTimeout(() => {
      renderPreview(tab);
    }, delay);
  }

  async function renderPreview(tab) {
    if (!layoutRefs || !tab || !tab.model) return;
    const host = layoutRefs.previewHost;
    if (!host) return;

    revokePreviewBlobs();

    const myGen = ++mountGen;
    const tabId = tab.id;
    const modelVersion = tab.model.getAlternativeVersionId();
    const content = tab.model.getValue();
    const lineCount = tab.model.getLineCount();
    const isLarge = lineCount > 1500 || content.length > 150000;

    // Check if HTML document
    const isHtml = tab.htmlPreview || tab.name.endsWith('.html') || tab.name.endsWith('.htm');
    isHtmlMode = isHtml;

    if (isHtml) {
      renderHtmlIframe(content, host, myGen);
      return;
    }

    // Check if non-markdown plaintext/code file: fallback to simple pre
    const isMarkdown = tab.name.endsWith('.md') || tab.name.endsWith('.markdown') || tab.untitled;
    if (!isMarkdown) {
      host.innerHTML = `<pre class="ed2-raw-fallback" style="padding:16px;white-space:pre-wrap;font-family:monospace;">${escapeHtml(content)}</pre>`;
      return;
    }

    // Markdown rendering using EditorMarkdown
    const em = window.EditorMarkdown;
    if (!em) {
      host.innerHTML = `<pre class="ed2-raw-fallback">${escapeHtml(content)}</pre>`;
      return;
    }

    // Process temporary asset URLs for preview
    let previewContent = content;
    if (tab.assets && tab.assets.size > 0) {
      for (const [rel, blob] of tab.assets.entries()) {
        const cleanRel = rel.startsWith('./') ? rel.slice(2) : rel;
        const tempUrl = URL.createObjectURL(blob);
        activePreviewBlobUrls.push(tempUrl);
        // Replace relative URL with blob URL in memory for preview (scoped to Markdown/HTML image syntax)
        const escapedRel = cleanRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mdImgRegex = new RegExp(`(!\\[[^\\]]*\\]\\()(\\.\\/)?${escapedRel}(\\))`, 'g');
        const htmlImgRegex = new RegExp(`(<img\\b[^>]*\\bsrc=["'])(\\.\\/)?${escapedRel}(["'])`, 'gi');
        previewContent = previewContent.replace(mdImgRegex, `$1${tempUrl}$3`);
        previewContent = previewContent.replace(htmlImgRegex, `$1${tempUrl}$3`);
      }
    }

    // Replace saved relative images with /api/editor/file-image proxy URL
    if (tab.target && (tab.target.fileId || tab.target.pathGrantId)) {
      const q = tab.target.pathGrantId
        ? `pathGrantId=${encodeURIComponent(tab.target.pathGrantId)}`
        : `fileId=${encodeURIComponent(tab.target.fileId)}`;
      previewContent = previewContent.replace(/(!\[[^\]]*\]\()(\.\/[^)\s]+|\b[a-zA-Z0-9_\-.]+_imgs\/[^)\s]+)(\))/g, (m, p1, p2, p3) => {
        const cleanRel = p2.replace(/^\.\//, '');
        return `${p1}/api/editor/file-image?${q}&rel=${encodeURIComponent(cleanRel)}${p3}`;
      });
    }

    // 1. Initial safe render
    const renderedHtml = em.renderMarkdown(previewContent, { safe: true });
    const cleanHtml = em.sanitize(renderedHtml);

    // Annotate top-level elements with source lines if markdown-it token.map available
    host.innerHTML = cleanHtml;
    annotateSourceLines(host, previewContent);

    // Build TOC
    buildToc(host, tab);

    // 2. Syntax highlighting and mermaid (guarded by mountGen)
    if (myGen !== mountGen) return;

    try {
      em.highlightCode(host, document, { skipHeavy: isLarge });
    } catch (e) {
      console.warn('highlightCode failed:', e);
    }
  }

  function annotateSourceLines(host, markdownText) {
    if (typeof window.markdownit !== 'function') return;
    try {
      const md = window.markdownit();
      const tokens = md.parse(markdownText, {});
      const children = Array.from(host.children);
      let childIdx = 0;

      for (const t of tokens) {
        if (t.map && t.level === 0 && childIdx < children.length) {
          const el = children[childIdx++];
          if (el) {
            el.dataset.sourceLine = t.map[0] + 1; // 1-based line number
          }
        }
      }
    } catch (_) {}
  }

  function renderHtmlIframe(htmlContent, host, myGen) {
    host.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', ''); // Zero-privilege sandbox
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.background = '#ffffff';

    // Sanitize with DOMPurify if available
    let safeHtml = htmlContent;
    if (window.DOMPurify) {
      safeHtml = window.DOMPurify.sanitize(htmlContent, { WHOLE_DOCUMENT: true });
    }

    iframe.srcdoc = safeHtml;
    host.appendChild(iframe);

    // Build TOC from detached DOM parser
    try {
      const parser = new DOMParser();
      const detachedDoc = parser.parseFromString(safeHtml, 'text/html');
      buildToc(detachedDoc.body, null);
    } catch (_) {}
  }

  function buildToc(sourceRoot, tab) {
    if (!layoutRefs || !layoutRefs.tocPanel) return;
    const tocPanel = layoutRefs.tocPanel;
    tocPanel.innerHTML = '<div class="ed2-toc-header" style="font-size:11px;font-weight:600;padding:4px 12px;text-transform:uppercase;color:var(--text-muted);">Outline</div>';

    const headings = sourceRoot.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (headings.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px;color:var(--text-muted);padding:8px 12px;';
      empty.textContent = 'No headings found';
      tocPanel.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'ed2-toc-list';

    headings.forEach((h, idx) => {
      const level = parseInt(h.tagName.substring(1), 10);
      const item = document.createElement('div');
      item.className = 'ed2-toc-item';
      item.style.cssText = `padding: 4px 12px 4px ${12 + (level - 1) * 10}px; font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text);`;
      item.textContent = h.textContent.trim() || `Heading ${level}`;

      item.addEventListener('click', () => {
        // Reveal in editor
        if (h.dataset.sourceLine && activeEditor) {
          const line = parseInt(h.dataset.sourceLine, 10);
          activeEditor.revealLineInCenter(line);
          activeEditor.setPosition({ lineNumber: line, column: 1 });
          activeEditor.focus();
        }
        // Reveal in preview
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });

      list.appendChild(item);
    });

    tocPanel.appendChild(list);
  }

  function setPreviewMode(mode) {
    currentPreviewMode = mode;
    if (!layoutRefs) return;

    // Update button states
    ['edit', 'split', 'reader'].forEach(m => {
      const btn = layoutRefs.toolbar.querySelector(`#ed2-tb-mode-${m}`);
      if (btn) btn.classList.toggle('active', m === mode);
    });

    if (mode === 'edit') {
      layoutRefs.monacoHost.style.display = 'block';
      layoutRefs.previewHost.classList.add('hidden');
    } else if (mode === 'reader') {
      layoutRefs.monacoHost.style.display = 'none';
      layoutRefs.previewHost.classList.remove('hidden');
      const tab = window.EditorV2 ? window.EditorV2.getActiveTab() : null;
      if (tab) renderPreview(tab);
    } else {
      // Split
      layoutRefs.monacoHost.style.display = 'block';
      layoutRefs.previewHost.classList.remove('hidden');
      const tab = window.EditorV2 ? window.EditorV2.getActiveTab() : null;
      if (tab) renderPreview(tab);
    }

    if (activeEditor && mode !== 'reader') {
      activeEditor.layout();
    }
  }

  function toggleHtmlPreview() {
    const tab = window.EditorV2 ? window.EditorV2.getActiveTab() : null;
    if (!tab) return;
    tab.htmlPreview = !tab.htmlPreview;
    renderPreview(tab);
  }

  function setupScrollSync() {
    if (!activeEditor || !layoutRefs) return;

    // Editor -> Preview Sync
    activeEditor.onDidScrollChange((e) => {
      if (isSyncingScroll || isHtmlMode || currentPreviewMode !== 'split') return;
      isSyncingScroll = true;

      try {
        const ranges = activeEditor.getVisibleRanges();
        if (ranges && ranges.length > 0) {
          const topVisibleLine = ranges[0].startLineNumber;
          const host = layoutRefs.previewHost;
          const blocks = Array.from(host.querySelectorAll('[data-source-line]'));
          if (blocks.length > 0) {
            // Find closest block
            let closest = blocks[0];
            let minDiff = Infinity;
            for (const b of blocks) {
              const line = parseInt(b.dataset.sourceLine, 10);
              const diff = Math.abs(line - topVisibleLine);
              if (diff < minDiff) {
                minDiff = diff;
                closest = b;
              }
            }
            if (closest) {
              host.scrollTop = closest.offsetTop - 20;
            }
          }
        }
      } finally {
        setTimeout(() => { isSyncingScroll = false; }, 50);
      }
    });

    // Preview -> Editor Sync
    layoutRefs.previewHost.addEventListener('scroll', () => {
      if (isSyncingScroll || isHtmlMode || currentPreviewMode !== 'split') return;
      isSyncingScroll = true;

      try {
        const host = layoutRefs.previewHost;
        const blocks = Array.from(host.querySelectorAll('[data-source-line]'));
        if (blocks.length > 0) {
          const topY = host.scrollTop + 40;
          let matched = blocks[0];
          for (const b of blocks) {
            if (b.offsetTop <= topY) {
              matched = b;
            } else {
              break;
            }
          }
          if (matched && matched.dataset.sourceLine) {
            const line = parseInt(matched.dataset.sourceLine, 10);
            activeEditor.revealLine(line);
          }
        }
      } finally {
        setTimeout(() => { isSyncingScroll = false; }, 50);
      }
    });
  }

  function updateFontScale(scale) {
    if (!layoutRefs || !layoutRefs.previewHost) return;
    layoutRefs.previewHost.style.fontSize = `calc(14px * ${scale})`;
  }

  function onTabSwitched(tab) {
    revokePreviewBlobs();
    scheduleUpdate(tab);
  }

  function init(refs, editor) {
    layoutRefs = refs;
    activeEditor = editor;
    setupScrollSync();
  }

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  window.EditorV2Preview = {
    init,
    scheduleUpdate,
    renderPreview,
    setPreviewMode,
    toggleHtmlPreview,
    updateFontScale,
    onTabSwitched,
    revokePreviewBlobs,
  };
})();
