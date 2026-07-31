// pg-render.js
// ----- Renderers ----------------------------------------------------

// pgSafeHref restricts an href to http/https protocols only.
// Unsafe schemes like javascript: or data: are downgraded to "#".
// Guard against XSS when LLM-sourced URLs are rendered as clickable links.
function pgSafeHref(href) {
  try {
    var u = new URL(href, window.location.origin);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.href;
    }
  } catch (e) {}
  return '#';
}

function pgScrollBottom(i, assistantIdx) {
  pgScrollBottomReasoning(i, assistantIdx, true);
  var box = document.getElementById('pg-messages-' + i);
  if (box) box.scrollTop = box.scrollHeight;
}

function pgScrollBottomReasoning(i, assistantIdx, streamingOnly) {
  var w = pgWinAt(i);
  if (!w) return;
  if (streamingOnly && !w.streaming) return;
  if (assistantIdx == null || !w.messages[assistantIdx]) return;
  try {
    var bub = document.getElementById('pg-bubble-' + i + '-' + assistantIdx);
    if (!bub) return;
    var bodies = bub.querySelectorAll('.pg-thinking-body');
    for (var k = 0; k < bodies.length; k++) {
      var b = bodies[k];
      var pp = b.parentElement;
      if (pp && pp.classList && !pp.classList.contains('collapsed')) {
        b.scrollTop = b.scrollHeight;
      }
    }
  } catch (e) {}
}

function pgFormatTime(ts) {
  if (!ts || typeof ts !== 'number') return '';
  var d = new Date(ts);
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function pgFormatDuration(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '';
  if (ms < 1000) return pgT('pgDurationMs', [Math.max(1, Math.round(ms))]);
  return pgT('pgDurationSec', [(ms / 1000).toFixed(2)]);
}

function pgRenderBubble(i, idx) {
  var w = pgWinAt(i);
  var wrap = document.getElementById('pg-bubble-' + i + '-' + idx);
  if (!wrap) return;
  var msg = w.messages[idx];
  if (!msg) return;
  var isSourceVisible = !!msg.sourceVisible;
  var html = pgMsgInnerHTML(i, idx, msg, isSourceVisible);
  wrap.innerHTML = html;
  try {
    var metaWrap = document.getElementById('pg-msg-' + i + '-' + idx);
    if (metaWrap) {
      var metaEl = metaWrap.querySelector('.pg-msg-meta');
      if (metaEl) {
        metaEl.innerHTML = pgMsgMetaInnerHTML(i, idx, msg);
      } else if (msg.role !== 'loading') {
        var meta = document.createElement('div');
        meta.className = 'pg-msg-meta' + (msg.role === 'assistant' && idx === w.messages.length - 1 ? ' always-show' : '');
        meta.innerHTML = pgMsgMetaInnerHTML(i, idx, msg);
        metaWrap.appendChild(meta);
      }
    }
  } catch (e) { /* meta 更新失败不影响气泡内容 */ }
  var isStreaming = msg.status === 'streaming' || msg.status === 'loading';
  pgHighlight(wrap);
  pgPostProcessCode(wrap, isStreaming);
  wrap.querySelectorAll('.pg-code-copy').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var codeEl = btn.parentElement && btn.parentElement.querySelector('code');
      pgCopyToClipboard(codeEl ? codeEl.textContent : '', pgT('pgCodeCopied'));
    });
  });
  wrap.querySelectorAll('.pg-mermaid').forEach(function(el) {
    el.addEventListener('click', function() { pgOpenMermaidSvg(el); });
  });
}

function pgPostProcessCode(container, isStreaming) {
  var pres = container.querySelectorAll('pre');
  pres.forEach(function(pre) {
    if (pre.dataset.pgPost === '1') return;
    pre.dataset.pgPost = '1';
    var codeEl = pre.querySelector('code');
    if (!codeEl) return;
    var cls = codeEl.className || '';
    var langMatch = cls.match(/language-(\w+)/);
    var lang = langMatch ? langMatch[1] : '';
    var raw = codeEl.textContent || '';
    if (lang === 'mermaid') {
      pgRenderMermaid(pre, raw, isStreaming);
    } else if (lang === 'html' || /^<!DOCTYPE/i.test(raw) || /^<svg/i.test(raw) || /^<\?xml/i.test(raw)) {
      pgRenderHtmlPreview(pre, raw);
    }
  });
}

function pgRenderMermaid(pre, code, isStreaming) {
  if (typeof window.mermaid === 'undefined') return;
  var placeholder = document.createElement('div');
  placeholder.className = 'pg-mermaid';
  placeholder.textContent = code;
  pre.parentNode.insertBefore(placeholder, pre.nextSibling);
  var cached = !isStreaming && PG_MERMAID_MAP[code];
  if (cached) {
    insertMermaidSvg(placeholder, cached);
    return;
  }
  placeholder.id = 'pg-mmd-' + (++PG_MERMAID_SEQ);
  pgMermaidQueue(function() {
    return window.mermaid.run({ nodes: [placeholder], suppressErrors: true }).then(function() {
      var svg = placeholder.querySelector('svg');
      if (svg && !isStreaming) {
        try { var s = new XMLSerializer().serializeToString(svg); if (Object.keys(PG_MERMAID_MAP).length >= PG_MERMAID_MAX) PG_MERMAID_MAP = Object.create(null); PG_MERMAID_MAP[code] = s; } catch (e) {}
      }
    }).catch(function(e) {
      placeholder.classList.add('mermaid-error');
      placeholder.textContent = '[mermaid] ' + (e && e.message ? e.message : String(e));
    });
  });
}

function insertMermaidSvg(placeholder, svgString) {
  try {
    placeholder.textContent = '';
    var tpl = document.createElement('template');
    tpl.innerHTML = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(svgString) : svgString;
    var svg = tpl.content.firstChild;
    if (svg) placeholder.appendChild(svg);
  } catch (e) {}
}

var PG_MERMAID_MAX = 50;
var PG_MERMAID_MAP = Object.create(null);
var PG_MERMAID_SEQ = 0;
var PG_MERMAID_QUEUE = Promise.resolve();
function pgMermaidQueue(task) {
  PG_MERMAID_QUEUE = PG_MERMAID_QUEUE.then(task, task);
  return PG_MERMAID_QUEUE;
}

function pgOpenMermaidSvg(el) {
  var svg = el.querySelector('svg');
  if (!svg) return;
  var text = new XMLSerializer().serializeToString(svg);
  var blob = new Blob([text], { type: 'image/svg+xml' });
  var url = FsApi.BlobTracker.create(blob);
  window.open(url, '_blank');
  setTimeout(function() { FsApi.BlobTracker.revoke(url); }, 5000);
}

function pgRenderHtmlPreview(pre, html) {
  if (pre.dataset.pgHtml === '1') return;
  pre.dataset.pgHtml = '1';
  var wrap = document.createElement('div');
  wrap.className = 'pg-html-preview';
  var title = document.createElement('div');
  title.className = 'pg-html-preview-title';
  title.textContent = pgT('pgHtmlPreview');
  var iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', '');
  iframe.setAttribute('srcDoc', html);
  iframe.style.height = '150px';
  iframe.addEventListener('load', function() {
    try {
      var doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      if (doc) {
        var h = Math.max(doc.documentElement.scrollHeight || 0, doc.body.scrollHeight || 0);
        iframe.style.height = Math.min(Math.max(h + 16, 60), 600) + 'px';
      }
    } catch (e) {}
  });
  wrap.appendChild(title);
  wrap.appendChild(iframe);
  pre.parentNode.insertBefore(wrap, pre.nextSibling);
}

function pgMsgInnerHTML(i, idx, msg, isSourceVisible) {
  var isSearch = pgState.mode === 'search';
  if (isSearch && msg.role === 'user') return '';

  if (isSearch) {
    // Left pane (win 0): Strategy & Raw Results
    if (i === 0) {
      var leftInner = '';
      if (msg.searchClassification) {
        leftInner += '<div class="pg-search-strategy">' +
          '<div class="pg-search-raw-head"><span class="pg-search-raw-title">' + pgEscapeHtml(pgT('pgSearchStrategy')) + '</span></div>' +
          '<div class="pg-search-raw-body"><pre>' + pgEscapeHtml(JSON.stringify(msg.searchClassification, null, 2)) + '</pre></div>' +
          '</div>';
      }
      if (msg.searchRaw) {
        var rawNormalized = typeof pgNormalizeSearchMarkdown === 'function' ? pgNormalizeSearchMarkdown(msg.searchRaw) : msg.searchRaw;
        var prettyHtml = pgRenderMarkdown(rawNormalized, false);
        leftInner += '<div class="pg-search-raw">' +
          '<div class="pg-search-raw-head">' +
            '<span class="pg-search-raw-title">' + pgEscapeHtml(pgT('pgSearchRawResults')) + '</span>' +
            '<span class="pg-search-toggle">' +
              '<button class="pg-search-toggle-btn pg-search-toggle-btn-active" data-view="pretty" onclick="event.stopPropagation();pgToggleSearchRaw(this,\'pretty\')">' + pgEscapeHtml(pgT('pgSearchPretty')) + '</button>' +
              '<button class="pg-search-toggle-btn" data-view="raw" onclick="event.stopPropagation();pgToggleSearchRaw(this,\'raw\')">' + pgEscapeHtml(pgT('pgSearchRaw')) + '</button>' +
            '</span>' +
          '</div>' +
          '<div class="pg-search-raw-body">' +
            '<div class="pg-search-pretty-view">' + prettyHtml + '</div>' +
            '<pre class="pg-search-raw-view" style="display:none">' + pgEscapeHtml(msg.searchRaw) + '</pre>' +
          '</div>' +
        '</div>';
      }
      if (!leftInner) {
        if (msg.status === 'loading') {
          var stepText = pgT('pgSearchSearching');
          if (msg.searchStep === 'classifying') stepText = pgT('pgSearchClassifying');
          var sec = msg.startedAt ? Math.max(0, Math.floor((Date.now() - msg.startedAt) / 1000)) : 0;
          pgEnsureWaitingTicker();
          return '<div class="pg-bubble"><span class="pg-toast-inline">⏳ ' + pgEscapeHtml(stepText) + ' <span class="pg-wait-sec" id="pg-wait-' + i + '-' + idx + '">' + sec + 's</span></span></div>';
        }
        return '<div class="pg-pane-empty">' + pgEscapeHtml(pgT('pgSearchRawResults')) + '</div>';
      }
      return leftInner;
    }

    // Right pane (win 1): Synthesized Result
    if (i === 1) {
      if (msg.status === 'loading' && !msg.content) {
        var sec2 = msg.startedAt ? Math.max(0, Math.floor((Date.now() - msg.startedAt) / 1000)) : 0;
        pgEnsureWaitingTicker();
        return '<div class="pg-bubble"><span class="pg-toast-inline">⏳ ' + pgEscapeHtml(pgT('pgSearchSynthesizing')) + ' <span class="pg-wait-sec" id="pg-wait-' + i + '-' + idx + '">' + sec2 + 's</span></span></div>';
      }
      var rightInner = '';
      if (msg.sources && msg.sources.length) {
        rightInner += '<div class="pg-sources collapsed" onclick="this.classList.toggle(\'collapsed\')">' +
          '<div class="pg-sources-head">' + pgEscapeHtml(pgT('pgSourcesCount', [msg.sources.length])) + ' ▾</div>' +
          '<div class="pg-sources-list">' +
            msg.sources.map(function(s, si) {
              return '<a class="pg-source-item" href="' + pgEscapeHtml(pgSafeHref(s.href)) + '" target="_blank" rel="noreferrer noopener">' +
                '<span class="pg-source-idx">[' + (si + 1) + ']</span>' +
                '<span>' + pgEscapeHtml(s.title || s.href) + '</span></a>';
            }).join('') +
          '</div></div>';
      }
      if (msg.reasoning) {
        var lbl;
        var streamingThink = msg.status === 'streaming' && msg.reasoningStartedAt && !msg.reasoningCompletedAt;
        if (streamingThink) {
          lbl = '<span class="pg-thinking-spinner"></span> ' + pgEscapeHtml(pgT('pgThinkingTitle')) + '...';
        } else if (msg.reasoningDurationMs != null) {
          var dstr = pgFormatDuration(msg.reasoningDurationMs);
          lbl = '💭 ' + (dstr ? pgEscapeHtml(pgT('pgThinkingSec', [dstr])) : pgEscapeHtml(pgT('pgThinkingDone')));
        } else {
          lbl = '💭 ' + pgEscapeHtml(pgT('pgThinkingDone'));
        }
        var thinkCls = streamingThink ? 'pg-thinking' : 'pg-thinking collapsed';
        rightInner += '<div class="' + thinkCls + '" onclick="this.classList.toggle(\'collapsed\')">' +
          '<div class="pg-thinking-head"><span class="pg-think-label">' + lbl + '</span>' +
          '<span class="pg-think-chev">▾</span></div>' +
          '<div class="pg-thinking-body">' + pgRenderMarkdown(msg.reasoning, false) + '</div>' +
        '</div>';
      }
      var isError2 = msg.status === 'error';
      var cls2 = 'pg-bubble' + (isError2 ? ' pg-bubble-error' : '');
      var bodyMd2;
      if (isError2) {
        bodyMd2 = msg.content ? pgRenderMarkdown(pgTextContent(msg.content), false) : '';
        if (msg.error) {
          bodyMd2 += (bodyMd2 ? '<br>' : '') + '<span style="color:#ffcdd2">[' + pgEscapeHtml(pgT('pgError')) + '] ' + pgEscapeHtml(msg.error) + '</span>';
        }
      } else if (isSourceVisible) {
        var rawSrc2 = pgTextContent(msg.content);
        bodyMd2 = '<pre><code class="language-markdown">' + pgEscapeHtml(rawSrc2) + '</code></pre>';
      } else {
        bodyMd2 = pgRenderMarkdown(pgTextContent(msg.content), false);
      }
      if (bodyMd2) {
        rightInner += '<div class="' + cls2 + '">' + bodyMd2 + '</div>';
      }
      return rightInner;
    }
  }

  if (msg.status === 'loading') {
    var sec = msg.startedAt ? Math.max(0, Math.floor((Date.now() - msg.startedAt) / 1000)) : 0;
    pgEnsureWaitingTicker();
    return '<div class="pg-bubble"><span class="pg-toast-inline">⏳ ' + pgEscapeHtml(pgT('pgWaiting')) + ' <span class="pg-wait-sec" id="pg-wait-' + i + '-' + idx + '">' + sec + 's</span></span></div>';
  }
  var inner = '';
  var isUser = msg.role === 'user';
  if (msg.role === 'assistant' && msg.sources && msg.sources.length) {
    inner += '<div class="pg-sources collapsed" onclick="this.classList.toggle(\'collapsed\')">' +
      '<div class="pg-sources-head">' + pgEscapeHtml(pgT('pgSourcesCount', [msg.sources.length])) + ' ▾</div>' +
      '<div class="pg-sources-list">' +
        msg.sources.map(function(s, si) {
          return '<a class="pg-source-item" href="' + pgEscapeHtml(pgSafeHref(s.href)) + '" target="_blank" rel="noreferrer noopener">' +
            '<span class="pg-source-idx">[' + (si + 1) + ']</span>' +
            '<span>' + pgEscapeHtml(s.title || s.href) + '</span></a>';
        }).join('') +
      '</div></div>';
  }
  if (msg.reasoning) {
    var lbl;
    var streamingThink = msg.status === 'streaming' && msg.reasoningStartedAt && !msg.reasoningCompletedAt;
    if (streamingThink) {
      lbl = '<span class="pg-thinking-spinner"></span> ' + pgEscapeHtml(pgT('pgThinkingTitle')) + '...';
    } else if (msg.reasoningDurationMs != null) {
      var dstr = pgFormatDuration(msg.reasoningDurationMs);
      lbl = '💭 ' + (dstr ? pgEscapeHtml(pgT('pgThinkingSec', [dstr])) : pgEscapeHtml(pgT('pgThinkingDone')));
    } else {
      lbl = '💭 ' + pgEscapeHtml(pgT('pgThinkingDone'));
    }
    var thinkCls = streamingThink ? 'pg-thinking' : 'pg-thinking collapsed';
    inner += '<div class="' + thinkCls + '" onclick="this.classList.toggle(\'collapsed\')">' +
      '<div class="pg-thinking-head"><span class="pg-think-label">' + lbl + '</span>' +
      '<span class="pg-think-chev">▾</span></div>' +
      '<div class="pg-thinking-body">' + pgRenderMarkdown(msg.reasoning, false) + '</div>' +
    '</div>';
  }
  if (msg.role === 'system') {
    inner += '<div class="pg-bubble" data-system-badge="' + pgEscapeHtml(pgT('pgSystemBadge')) + '">'
      + pgRenderMarkdown(pgTextContent(msg.content), false) + '</div>';
    return inner;
  }
  if (msg.searchClassification) {
    inner += '<div class="pg-search-strategy collapsed" onclick="event.stopPropagation();this.classList.toggle(\'collapsed\')">' +
      '<div class="pg-search-raw-head">' + pgEscapeHtml(pgT('pgSearchStrategy')) + ' <span class="pg-think-chev">▾</span></div>' +
      '<div class="pg-search-raw-body"><pre>' + pgEscapeHtml(JSON.stringify(msg.searchClassification, null, 2)) + '</pre></div>' +
      '</div>';
  }
  if (msg.searchRaw) {
    var canPretty = msg.status === 'complete';
    var prettyContent = '';
    if (msg.prettyRepairing) {
      prettyContent = '<div class="pg-pretty-status"><span class="pg-thinking-spinner"></span> ✨ AI 正在修复 Markdown 格式与结构...</div>' +
        (msg.prettyMarkdown ? pgRenderMarkdown(msg.prettyMarkdown, false) : '');
    } else if (msg.prettyRepairError) {
      prettyContent = '<div class="pg-pretty-error">格式修复失败: ' + pgEscapeHtml(msg.prettyRepairError) + ' <button class="pg-btn" style="margin-left:8px" onclick="pgRepairSearchMarkdownAI(' + i + ',' + idx + ')">重试</button></div>';
    } else if (msg.prettyMarkdown) {
      prettyContent = pgRenderMarkdown(msg.prettyMarkdown, false);
    } else {
      prettyContent = '<div class="pg-pretty-hint" style="color:var(--text-muted);font-size:12px;padding:8px 0">点击上面的 Pretty 按钮，将使用 AI 自动修复语法结构并完成标准 Markdown 渲染。</div>';
    }

    var btnDisabled = canPretty ? '' : ' disabled style="opacity:0.4;cursor:not-allowed;" data-tooltip="请等待搜索与总结完成"';
    inner += '<div class="pg-search-raw collapsed">' +
      '<div class="pg-search-raw-head" onclick="event.stopPropagation();this.parentElement.classList.toggle(\'collapsed\')">' +
        '<span class="pg-search-raw-title">' + pgEscapeHtml(pgT('pgSearchRawResults')) + '</span>' +
        '<span class="pg-search-toggle">' +
          '<button class="pg-search-toggle-btn pg-search-toggle-btn-active" data-view="raw" onclick="event.stopPropagation();pgToggleSearchRaw(this,\'raw\')">' + pgEscapeHtml(pgT('pgSearchRaw')) + '</button>' +
          '<button class="pg-search-toggle-btn' + (canPretty ? '' : ' disabled') + '" ' + btnDisabled + ' data-view="pretty" onclick="event.stopPropagation();pgToggleSearchRaw(this,\'pretty\')">' + pgEscapeHtml(pgT('pgSearchPretty')) + '</button>' +
        '</span>' +
        '<span class="pg-think-chev">▾</span>' +
      '</div>' +
      '<div class="pg-search-raw-body">' +
        '<pre class="pg-search-raw-view">' + pgEscapeHtml(msg.searchRaw) + '</pre>' +
        '<div class="pg-search-pretty-view" style="display:none">' + prettyContent + '</div>' +
      '</div>' +
    '</div>';
  }
  var isError = msg.status === 'error';
  var cls = 'pg-bubble' + (isError ? ' pg-bubble-error' : '');
  var imgs = pgImageParts(msg.content);
    inner += '<div class="pg-image-row">' + imgs.map(function(p) {
      var u = p.image_url.url;
      var sp = p.image_url.savedPath || '';
      var sf = p.image_url.savedFilename || '';
      return '<img class="pg-image-thumb" src="' + pgEscapeHtml(u) + '" alt="image" onclick="pgShowImageModal(\'' + pgEscapeAttr(u) + '\', \'' + pgEscapeAttr(sp) + '\', \'' + pgEscapeAttr(sf) + '\')">';
    }).join('') + '</div>';
  var bodyMd;
  if (isError) {
    bodyMd = msg.content ? pgRenderMarkdown(pgTextContent(msg.content), false) : '';
    if (msg.error) {
      bodyMd += (bodyMd ? '<br>' : '') + '<span style="color:#ffcdd2">[' + pgEscapeHtml(pgT('pgError')) + '] ' + pgEscapeHtml(msg.error) + '</span>';
    }
    if (msg.errorCode) {
      bodyMd += '<div class="pg-error-code">[' + pgEscapeHtml(pgT('pgErrorCode', [msg.errorCode])) + ']</div>';
    }
  } else if (isSourceVisible) {
    var rawSrc = pgTextContent(msg.content);
    bodyMd = '<pre><code class="language-markdown">' + pgEscapeHtml(rawSrc) + '</code></pre>';
  } else {
    bodyMd = pgRenderMarkdown(pgTextContent(msg.content), isUser);
  }
  // In image mode, show the edit-input image(s) above the prompt bubble,
  // sourced from the message's captured images (cleared from the input bar
  // after sending).
  if (isUser && pgState.mode === 'image' && msg.images && msg.images.length) {
    var eurls = msg.images.filter(function(u) { return u && u.trim(); });
    if (eurls.length) {
      inner += '<div class="pg-image-row">' + eurls.map(function(u) {
        return '<img class="pg-image-thumb" src="' + pgEscapeHtml(u) + '" alt="image" onclick="pgShowImageModal(\'' + pgEscapeAttr(u) + '\')">';
      }).join('') + '</div>';
    }
  }
  // Skip the text bubble when there is no text (e.g. image-only results),
  // otherwise an empty bubble is rendered below the image.
  if (bodyMd) {
    inner += '<div class="' + cls + '">' + bodyMd + '</div>';
  }
  return inner;
}

// Waiting counter for image generation/edit: while an assistant message is in
// the "loading" state (POST accepted, no error returned yet), tick every
// second and show elapsed seconds since the request started.
//
// SAFETY NET: when the playground tab/page loses focus (e.g. user switches to
// the Console page or the WebView2 window is backgrounded), Chromium throttles
// or aborts pending fetch() calls. The fetch promise often never settles in
// that case, so pgFail is never invoked and the UI would otherwise wait
// forever showing a ticking timer with the Stop button stuck. The safety net
// forces a failure after pgSafetyNetMs so the user can re-send. The threshold
// covers all real image-generation latencies (2k ~60s, 4k ~4min) with margin,
// so it only fires for genuinely stuck (aborted) requests.
var pgSafetyNetMs = 300000; // 5 minutes — covers 4k (~4min) with buffer, fails only really-stuck fetches
var pgWaitingTimer = null;
function pgTickWaiting() {
  var now = Date.now();
  var any = false;
  for (var i = 0; i < pgState.splitCount; i++) {
    var w = pgWinAt(i);
    if (!w) continue;
    for (var idx = 0; idx < w.messages.length; idx++) {
      var m = w.messages[idx];
      if (m.status !== 'loading') continue;
      // Safety net: auto-fail if loading for too long. Handles the case where
      // fetch() never settles (e.g. tab backgrounded → Chromium aborts fetch
      // without rejecting the promise) and pgFail is never called. After the
      // safety net the Send button becomes usable again.
      if (m.startedAt && (now - m.startedAt) > pgSafetyNetMs) {
        pgFail(i, idx, 'Request timed out (' + (pgSafetyNetMs/1000) + 's safety net)', null);
        continue;
      }
      any = true;
      // Re-render the loading bubble so the elapsed seconds are always
      // correct even if the bubble was re-rendered for another reason.
      pgRenderBubble(i, idx);
    }
  }
  if (!any && pgWaitingTimer) { clearInterval(pgWaitingTimer); pgWaitingTimer = null; }
}
function pgEnsureWaitingTicker() {
  if (!pgWaitingTimer) pgWaitingTimer = setInterval(pgTickWaiting, 1000);
}

function pgSaveActiveSearchResultMarkdown() {
  var s = pgActiveSearch();
  if (!s) return;
  var msg = s.messages && s.messages[s.messages.length - 1];
  var content = msg ? (msg.content || '') : '';
  if (!content) {
    pgToast(pgT('pgError'), 'warning');
    return;
  }
  var query = s.query || 'search_result';
  var cleanQuery = query.replace(/[\\/:*?"<>|]/g, '_').trim();
  if (cleanQuery.length > 30) cleanQuery = cleanQuery.substring(0, 30);
  var filename = (cleanQuery || 'search_result') + '.md';
  pgSaveMarkdownFile(content, filename);
}

function pgSaveActiveSearchRawMarkdown() {
  var s = pgActiveSearch();
  if (!s) return;
  var msg = s.messages && s.messages[s.messages.length - 1];
  var raw = msg ? (msg.searchRaw || '') : '';
  if (!raw) {
    pgToast(pgT('pgError'), 'warning');
    return;
  }
  var query = s.query || 'search_raw';
  var cleanQuery = query.replace(/[\\/:*?"<>|]/g, '_').trim();
  if (cleanQuery.length > 30) cleanQuery = cleanQuery.substring(0, 30);
  var filename = (cleanQuery || 'search_raw') + '_raw.md';
  pgSaveMarkdownFile(raw, filename);
}

function pgMsgMetaInnerHTML(i, idx, msg) {
  var isSearch = pgState.mode === 'search';
  var metaTime = pgFormatTime(msg.createdAt || msg.completedAt || msg.startedAt);
  var metaLines = '';
  if (msg.role === 'assistant' && msg.durationMs != null) {
    var dur = pgFormatDuration(msg.durationMs);
    if (metaTime && dur) {
      metaLines = pgEscapeHtml(metaTime) + ' · ' + pgEscapeHtml(pgT('pgMetaResponse', [dur]));
    } else if (dur) {
      metaLines = pgEscapeHtml(pgT('pgMetaResponse', [dur]));
    } else {
      metaLines = pgEscapeHtml(metaTime);
    }
  } else if (metaTime) {
    metaLines = pgEscapeHtml(metaTime);
  }
  var html = '<span>' + metaLines + '</span>';
  html += '<div class="pg-msg-actions">';
  if (msg.role === 'assistant' && msg.status !== 'loading') {
    html += '<button class="pg-action" onclick="pgActionCopy(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgCopy')) + '">' + PG_ICON_COPY + '</button>';
    if (!isSearch || i === 1) {
      html += '<button class="pg-action" onclick="pgToggleSource(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(msg.sourceVisible ? pgT('pgShowPreview') : pgT('pgShowSource')) + '">' + PG_ICON_SRC + '</button>';
    }
    if (isSearch && i === 0) {
      html += '<button class="pg-action" onclick="pgSaveActiveSearchRawMarkdown()" data-tooltip="' + pgEscapeHtml(pgT('pgSaveMarkdown')) + '">' + PG_ICON_SAVE + '</button>';
    }
    if (isSearch && i === 1) {
      html += '<button class="pg-action" onclick="pgSaveActiveSearchResultMarkdown()" data-tooltip="' + pgEscapeHtml(pgT('pgSaveMarkdown')) + '">' + PG_ICON_SAVE + '</button>';
    }
    if (!isSearch) {
      html += '<button class="pg-action" onclick="pgRegenerate(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgRegenerate')) + '">' + PG_ICON_REGEN + '</button>';
    }
    if (msg.status === 'error') {
      html += '<button class="pg-action" onclick="pgRetryError(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgRetry')) + '">' + PG_ICON_RETRY + '</button>';
      html += '<button class="pg-action" onclick="pgEditPromptForError(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgEditPrompt')) + '">' + PG_ICON_EDIT + '</button>';
    }
    if (!isSearch) {
      html += '<button class="pg-action danger" onclick="pgActionDelete(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgDelete')) + '">' + PG_ICON_DELETE + '</button>';
    }
  } else if (!isSearch && msg.role === 'user') {
    html += '<button class="pg-action" onclick="pgActionCopy(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgCopy')) + '">' + PG_ICON_COPY + '</button>';
    html += '<button class="pg-action" onclick="pgToggleRole(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgToggleRole')) + '">' + PG_ICON_ROLE + '</button>';
    html += '<button class="pg-action" onclick="pgBeginEdit(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgEdit')) + '">' + PG_ICON_EDIT + '</button>';
    html += '<button class="pg-action danger" onclick="pgActionDelete(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgDelete')) + '">' + PG_ICON_DELETE + '</button>';
  } else if (!isSearch && msg.role === 'system') {
    html += '<button class="pg-action" onclick="pgToggleRole(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgToggleRole')) + '">' + PG_ICON_ROLE + '</button>';
    html += '<button class="pg-action" onclick="pgBeginEdit(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgEdit')) + '">' + PG_ICON_EDIT + '</button>';
    html += '<button class="pg-action danger" onclick="pgActionDelete(' + i + ',' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgDelete')) + '">' + PG_ICON_DELETE + '</button>';
  }
  html += '</div>';
  return html;
}

function pgRenderMessages(i) {
  var w = pgWinAt(i);
  var box = document.getElementById('pg-messages-' + i);
  if (!box) return;
  if (!w.messages.length) {
    box.innerHTML = '<div class="pg-pane-empty">' + pgEscapeHtml(pgT('pgEmptyState')) + '</div>';
    return;
  }
  var html = '';
  w.messages.forEach(function(msg, idx) {
    var side = msg.role === 'user' ? 'user' : (msg.role === 'system' ? 'system' : 'assistant');
    var errCls = msg.status === 'error' ? ' error' : '';
    html += '<div class="pg-msg ' + side + errCls + '" id="pg-msg-' + i + '-' + idx + '">';
    html += '<div class="pg-bubble-slot" id="pg-bubble-' + i + '-' + idx + '">' + pgMsgInnerHTML(i, idx, msg, !!msg.sourceVisible) + '</div>';
    if (msg.role !== 'loading') {
      html += '<div class="pg-msg-meta' + (msg.role === 'assistant' && idx === w.messages.length - 1 ? ' always-show' : '') + '">' + pgMsgMetaInnerHTML(i, idx, msg) + '</div>';
    }
    html += '</div>';
  });
  box.innerHTML = html;
  w.messages.forEach(function(_, idx) { pgRenderBubble(i, idx); });
  pgScrollBottom(i);
}

function pgActionCopy(i, idx) {
  var w = pgWinAt(i);
  var msg = w.messages[idx];
  if (!msg) return;
  var txt;
  if (pgState.mode === 'search' && i === 0) {
    txt = msg.searchRaw || '';
  } else {
    txt = pgTextContent(msg.content);
  }
  if (!txt) { pgToast(pgT('pgCopy'), 'warning'); return; }
  pgCopyToClipboard(txt, pgT('pgCopiedMsg'));
}
function pgActionDelete(i, idx) {
  if (!confirm(pgT('pgClearConfirm'))) return;
  pgDeleteMessage(i, idx);
}

function pgToggleSource(i, idx) {
  var w = pgWinAt(i);
  var msg = w.messages[idx];
  if (!msg) return;
  msg.sourceVisible = !msg.sourceVisible;
  pgRenderBubble(i, idx);
}

function pgCodeViewer(content, title) {
  var formatted = '';
  if (content) {
    if (typeof content === 'object') {
      try { formatted = JSON.stringify(content, null, 2); } catch (e) { formatted = String(content); }
    } else if (typeof content === 'string') {
      try { var p = JSON.parse(content); formatted = JSON.stringify(p, null, 2); } catch (e) { formatted = content; }
    } else {
      formatted = String(content);
    }
  }
  if (!formatted) {
    var ph = title === 'preview' ? pgT('pgDebugNoPreview') : (title === 'request' ? pgT('pgDebugNoRequest') : pgT('pgDebugNoResponse'));
    return '<div class="pg-code-empty">' + pgEscapeHtml(ph) + '</div>';
  }
  var MAX_DISPLAY = 50000;
  var PREVIEW_LEN = 5000;
  var isLarge = formatted.length > MAX_DISPLAY;
  var display = isLarge ? formatted.substring(0, PREVIEW_LEN) + '\n\n' + pgT('pgCodeTruncated') : formatted;
  var warning = isLarge ? '<div class="pg-code-warning">⚡ ' + pgEscapeHtml(pgT('pgCodeLargeContent')) + '</div>' : '';
  var highlighted = pgEscapeHtml(display);
  if (typeof hljs !== 'undefined') {
    try {
      var tmp = document.createElement('code');
      tmp.className = 'language-json';
      tmp.textContent = display;
      hljs.highlightElement(tmp);
      highlighted = tmp.innerHTML;
    } catch (e) { highlighted = pgEscapeHtml(display); }
  }
  var expandBtn = isLarge ? '<button class="pg-code-expand-btn" onclick="pgCodeToggleExpand(this)">' + pgEscapeHtml(pgT('pgCodeShowFull')) + '</button>' : '';
  return '<div class="pg-code-viewer" data-full="' + pgEscapeHtml(formatted) + '" data-large="' + (isLarge ? '1' : '0') + '">' + warning +
    '<button class="pg-code-copy-btn" onclick="pgCodeCopy(this)">' + pgEscapeHtml(pgT('pgCopy')) + '</button>' +
    '<pre>' + highlighted + '</pre>' + expandBtn + '</div>';
}

function pgCodeCopy(btn) {
  var viewer = btn.closest('.pg-code-viewer');
  var pre = viewer ? viewer.querySelector('pre') : null;
  var text = pre ? pre.textContent : '';
  pgCopyToClipboard(text, pgT('pgCodeCopiedClipboard'));
}

function pgCodeToggleExpand(btn) {
  var viewer = btn.closest('.pg-code-viewer');
  if (!viewer) return;
  var isExpanded = btn.dataset.expanded === '1';
  var full = viewer.getAttribute('data-full') || '';
  var pre = viewer.querySelector('pre');
  if (!pre) return;
  if (isExpanded) {
    var truncated = full.substring(0, 5000) + '\n\n' + pgT('pgCodeTruncated');
    pre.textContent = truncated;
    if (typeof hljs !== 'undefined') { try { hljs.highlightElement(pre); } catch(e){} }
    btn.textContent = pgT('pgCodeShowFull');
    btn.dataset.expanded = '0';
  } else {
    pre.textContent = full;
    if (typeof hljs !== 'undefined') { try { hljs.highlightElement(pre); } catch(e){} }
    btn.textContent = pgT('pgCodeCollapse');
    btn.dataset.expanded = '1';
  }
}

function pgSSEViewer(events) {
  if (!events || !events.length) {
    return '<div class="pg-sse-empty">' + pgEscapeHtml(pgT('pgSSEEmpty')) + '</div>';
  }
  var parsed = events.map(function(item, index) {
    var isDone = false, parsedObj = null, error = null;
    var payload = item;
    if (item.indexOf('data:') === 0) payload = item.slice(5).trim();
    if (payload === '[DONE]') { isDone = true; }
    else if (item.indexOf('[ERROR]') === 0) { error = item.slice(7).trim(); }
    else {
      try { parsedObj = JSON.parse(payload); } catch (e) { error = e.message; }
    }
    return { index: index, raw: item, parsed: parsedObj, error: error, isDone: isDone };
  });
  var total = parsed.length;
  var errors = parsed.filter(function(p) { return p.error; }).length;
  var done = parsed.filter(function(p) { return p.isDone; }).length;
  var valid = total - errors - done;

  var items = parsed.map(function(p) {
    var header = '';
    var body = '';
    if (p.isDone) {
      header = '<span class="pg-sse-badge idx">#' + (p.index + 1) + '</span> <span style="color:#4ade80">[DONE]</span>';
      body = '<div class="pg-sse-item-done">✓ ' + pgEscapeHtml(pgT('pgSSEComplete')) + '</div>';
    } else if (p.error) {
      header = '<span class="pg-sse-badge idx">#' + (p.index + 1) + '</span> <span style="color:var(--danger)">' + pgEscapeHtml(pgT('pgSSEParseError')) + '</span>';
      body = '<div class="pg-sse-item-error">✕ ' + pgEscapeHtml(p.error) + '<pre>' + pgEscapeHtml(p.raw) + '</pre></div>';
    } else {
      var id = p.parsed.id || p.parsed.object || pgT('pgSSEEvent');
      var deltaKeys = '';
      if (p.parsed.choices && p.parsed.choices[0] && p.parsed.choices[0].delta) {
        var d = p.parsed.choices[0].delta;
        deltaKeys = Object.keys(d).filter(function(k) { return d[k]; }).join(', ');
      }
      header = '<span class="pg-sse-badge idx">#' + (p.index + 1) + '</span> ' + pgEscapeHtml(id);
      if (deltaKeys) header += ' <span style="color:var(--text-muted);font-size:10px">• ' + pgEscapeHtml(deltaKeys) + '</span>';
      var summary = '';
      if (p.parsed.choices && p.parsed.choices[0]) {
        var ch = p.parsed.choices[0];
        if (ch.delta && ch.delta.content) summary += '<span class="pg-sse-badge content">' + pgEscapeHtml(pgT('pgSSEContent')) + ': "' + pgEscapeHtml(String(ch.delta.content).substring(0, 20)) + '..."</span>';
        if (ch.delta && ch.delta.reasoning_content) summary += '<span class="pg-sse-badge reasoning">' + pgEscapeHtml(pgT('pgSSEReasoning')) + '</span>';
        if (ch.finish_reason) summary += '<span class="pg-sse-badge finish">' + pgEscapeHtml(pgT('pgSSEFinish')) + ': ' + pgEscapeHtml(ch.finish_reason) + '</span>';
      }
      if (p.parsed.usage) summary += '<span class="pg-sse-badge usage">' + pgEscapeHtml(pgT('pgSSETokens')) + ': ' + (p.parsed.usage.prompt_tokens || 0) + '/' + (p.parsed.usage.completion_tokens || 0) + '</span>';
      var jsonStr = JSON.stringify(p.parsed, null, 2);
      body = '<div class="pg-sse-item-body"><pre>' + pgEscapeHtml(jsonStr) + '</pre>' +
        (summary ? '<div class="pg-sse-item-summary">' + summary + '</div>' : '') + '</div>';
    }
    return '<div class="pg-sse-item">' +
      '<div class="pg-sse-item-header" onclick="pgSSEToggle(this)">' + header + '</div>' +
      body + '</div>';
  }).join('');

  return '<div class="pg-sse-viewer">' +
    '<div class="pg-sse-header">' +
      '<div class="pg-sse-header-left">⚡ ' + pgEscapeHtml(pgT('pgSSEDataFlow')) + ' <span class="pg-sse-badge idx">' + total + '</span>' +
        (errors > 0 ? ' <span class="pg-sse-badge content" style="background:rgba(239,68,68,.2);color:var(--danger)">' + errors + ' ' + pgEscapeHtml(pgT('pgSSEErrors')) + '</span>' : '') +
      '</div>' +
      '<div class="pg-sse-header-actions">' +
        '<button class="pg-sse-action" onclick="pgSSECopyAll()">' + pgEscapeHtml(pgT('pgSSECopyAll')) + '</button>' +
        '<button class="pg-sse-action" onclick="pgSSEToggleAll()">' + pgEscapeHtml(pgT('pgSSEExpandAll')) + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="pg-sse-list" id="pg-sse-list">' + items + '</div>' +
  '</div>';
}

function pgSSEToggle(header) {
  var body = header.nextElementSibling;
  if (body) body.style.display = (body.style.display === 'none' ? '' : 'none');
}

function pgSSEToggleAll() {
  var list = document.getElementById('pg-sse-list');
  if (!list) return;
  var bodies = list.querySelectorAll('.pg-sse-item-body');
  var allHidden = Array.prototype.every.call(bodies, function(b) { return b.style.display === 'none'; });
  bodies.forEach(function(b) { b.style.display = allHidden ? '' : 'none'; });
}

function pgSSECopyAll() {
  var w = pgWin();
  if (w) {
    var text = w.sseEvents.join('\n\n');
    pgCopyToClipboard(text, pgT('pgSSECopiedAll'));
  }
}

var pgPreviewTimer = null;
function pgSchedulePreview() {
  if (pgPreviewTimer) clearTimeout(pgPreviewTimer);
  pgPreviewTimer = setTimeout(function() {
    pgPreviewTimer = null;
    var w = pgWin();
    if (!w) return;
    var preview = null;
    try {
      if (w.config.useCustomBody && w.config.customBody) {
        preview = JSON.parse(w.config.customBody);
      } else {
        preview = pgBuildBody();
      }
    } catch (e) { preview = null; }
    w.debugPreview = preview ? JSON.stringify(preview, null, 2) : '';
    w.debugPreviewTimestamp = new Date().toISOString();
    if (w.debugTab === 'preview') pgRenderDebugContent();
  }, 300);
}

function pgRenderDebugContent() {
  var container = document.getElementById('pg-debug-content');
  if (!container) return;
  var w = pgWin();
  if (!w) return;
  var html = '';
  var tab = w.debugTab;
  if (tab === 'preview') {
    html = pgCodeViewer(w.debugPreview, 'preview');
  } else if (tab === 'request') {
    html = pgCodeViewer(w.debugRequest, 'request');
  } else if (tab === 'response') {
    if (w.sseEvents && w.sseEvents.length) {
      html = pgSSEViewer(w.sseEvents);
    } else {
      html = pgCodeViewer(w.debugResponse, 'response');
    }
  }
  container.innerHTML = html;
  var footer = document.getElementById('pg-debug-footer');
  if (footer) {
    var ts = (tab === 'preview') ? w.debugPreviewTimestamp : w.debugTimestamp;
    if (ts) {
      var label = (tab === 'preview') ? pgT('pgDebugPreviewUpdated') : pgT('pgDebugLastRequest');
      footer.textContent = label + ': ' + new Date(ts).toLocaleString();
    } else {
      footer.textContent = '';
    }
  }
}

function pgSetDebugTab(tab) {
  var w = pgWin();
  if (!w) return;
  w.debugTab = tab;
  var tabs = document.querySelectorAll('.pg-tab');
  tabs.forEach(function(el) { el.classList.toggle('active', el.dataset.tab === tab); });
  pgRenderDebugContent();
}