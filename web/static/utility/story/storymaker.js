// web/static/utility/story/storymaker.js — Story Maker Shell and Navigation
// Dependency load order:
// vendor/diff.min.js -> utility/editor/editor.js -> editor_textreview_diff.js -> storymaker.js -> story sub-pages

(function() {
  'use strict';

  var currentTab = 'home';
  var activeBookId = '';
  var activeBooksCache = [];
  var currentCleanupFn = null;
  var rootContainer = null;
  var abortControllers = [];

  // Story Maker API Client
  var storyApi = {
    get: function(endpoint) {
      return apiGet('/storymaker' + endpoint);
    },
    post: function(endpoint, data) {
      return apiPost('/storymaker' + endpoint, data);
    },
    patch: function(endpoint, data) {
      return apiPatch('/storymaker' + endpoint, data);
    },
    del: function(endpoint) {
      return apiDelete('/storymaker' + endpoint);
    },
    sse: function(endpoint, data, onDelta, onDone, onError) {
      var ac = new AbortController();
      abortControllers.push(ac);
      fetch('/api/storymaker' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: ac.signal
      }).then(function(resp) {
        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status);
        }
        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        function pump() {
          return reader.read().then(function(res) {
            if (res.done) {
              if (onDone) onDone();
              return;
            }
            buffer += decoder.decode(res.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              if (!line || line.startsWith(':')) continue;
              if (line.startsWith('data:')) {
                var payload = line.slice(5).trim();
                if (payload === '[DONE]') {
                  if (onDone) onDone();
                  return;
                }
                try {
                  var json = JSON.parse(payload);
                  if (json.delta !== undefined && onDelta) {
                    onDelta(json.delta);
                  } else if (onDelta) {
                    onDelta(json);
                  }
                } catch (e) {
                  if (onDelta) onDelta(payload);
                }
              }
            }
            return pump();
          });
        }
        return pump();
      }).catch(function(err) {
        if (err.name === 'AbortError') return;
        if (onError) onError(err);
        else console.warn('story SSE error:', err);
      });
      return ac;
    }
  };

  var TABS = [
    { id: 'home', labelKey: 'storyHome' },
    { id: 'm0', labelKey: 'storyM0' },
    { id: 'm2', labelKey: 'storyM2' },
    { id: 'm3', labelKey: 'storyM3' },
    { id: 'm4', labelKey: 'storyM4' },
    { id: 'm5', labelKey: 'storyM5' },
    { id: 'batch', labelKey: 'storyBatch' },
    { id: 'rolechat', labelKey: 'storyRoleChat' }
  ];

  function refreshBookList(cb) {
    storyApi.get('/books').then(function(res) {
      activeBooksCache = (res && res.books) || [];
      if (!activeBookId && activeBooksCache.length > 0) {
        for (var i = 0; i < activeBooksCache.length; i++) {
          if (activeBooksCache[i].type === 'project') {
            activeBookId = activeBooksCache[i].id;
            break;
          }
        }
        if (!activeBookId && activeBooksCache.length > 0) {
          activeBookId = activeBooksCache[0].id;
        }
      }
      if (cb) cb();
    }).catch(function(err) {
      console.warn('load books failed:', err);
      if (cb) cb();
    });
  }

  function renderShell(container) {
    rootContainer = container;
    container.innerHTML = '' +
      '<div class="sm-layout">' +
        '<div class="sm-sidebar">' +
          '<div class="sm-sidebar-header">' +
            '<div class="sm-sidebar-title">' +
              '<span>' + escapeHtml(t('storyMaker')) + '</span>' +
            '</div>' +
            '<div class="sm-book-selector-wrap" id="sm-book-selector"></div>' +
          '</div>' +
          '<nav class="sm-nav-list" id="sm-nav-list"></nav>' +
        '</div>' +
        '<div class="sm-content" id="sm-main-content"></div>' +
      '</div>';

    renderSidebarNav();
    updateBookSelector();
    switchToTab(currentTab);
  }

  function renderSidebarNav() {
    var navList = document.getElementById('sm-nav-list');
    if (!navList) return;
    var html = '';
    for (var i = 0; i < TABS.length; i++) {
      var tab = TABS[i];
      var active = tab.id === currentTab ? ' active' : '';
      var aria = tab.id === currentTab ? ' aria-current="page"' : '';
      html += '<button type="button" class="sm-nav-item' + active + '"' + aria + ' data-tab="' + tab.id + '">' +
        '<span>' + escapeHtml(t(tab.labelKey)) + '</span>' +
      '</button>';
    }
    navList.innerHTML = html;
    navList.querySelectorAll('.sm-nav-item').forEach(function(btn) {
      btn.addEventListener('click', function() {
        switchToTab(btn.dataset.tab);
      });
    });
  }

  function updateBookSelector() {
    var wrap = document.getElementById('sm-book-selector');
    if (!wrap) return;
    if (activeBooksCache.length === 0) {
      wrap.innerHTML = '<span style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(t('storyNoBooks')) + '</span>';
      return;
    }
    var options = activeBooksCache.map(function(b) {
      return { value: b.id, label: (b.type === 'project' ? (t('storyProject') + ': ') : (t('storyReference') + ': ')) + b.title };
    });
    var curBook = options.find(function(o) { return o.value === activeBookId; });
    var curVal = curBook ? curBook.value : (options[0] ? options[0].value : '');
    activeBookId = curVal;
    wrap.innerHTML = renderCustomSelectHtml('sm-active-book-wrap', 'sm-active-book-select', options, curVal, null, 'width:100%;height:36px;');
    var sel = wrap.querySelector('select');
    if (sel) {
      sel.addEventListener('change', function(e) {
        activeBookId = e.target.value;
        switchToTab(currentTab);
      });
    }
  }

  function switchToTab(tabId) {
    if (currentCleanupFn && typeof currentCleanupFn === 'function') {
      try { currentCleanupFn(); } catch (e) { console.warn('cleanup error:', e); }
      currentCleanupFn = null;
    }

    currentTab = tabId || 'home';
    renderSidebarNav();

    var contentEl = document.getElementById('sm-main-content');
    if (!contentEl) return;
    contentEl.innerHTML = '';

    var ctx = {
      api: storyApi,
      t: t,
      activeBookId: activeBookId,
      books: activeBooksCache,
      refreshBooks: function(cb) {
        refreshBookList(function() {
          updateBookSelector();
          if (cb) cb();
        });
      },
      setActiveBookId: function(id) {
        activeBookId = id;
        updateBookSelector();
      },
      getActiveBook: function() {
        for (var i = 0; i < activeBooksCache.length; i++) {
          if (activeBooksCache[i].id === activeBookId) return activeBooksCache[i];
        }
        return null;
      },
      showEmptyBookState: function(parentEl) {
        parentEl.innerHTML = '<div class="sm-empty-state">' +
          '<p>' + escapeHtml(t('storyNoBooks')) + '</p>' +
          '<button class="btn btn-primary" type="button" id="sm-empty-goto-home">' + escapeHtml(t('storyGoHome')) + '</button>' +
        '</div>';
        parentEl.querySelector('#sm-empty-goto-home')?.addEventListener('click', function() {
          switchToTab('home');
        });
      }
    };

    switch (currentTab) {
      case 'home':
        if (typeof window.storyRenderHome === 'function') {
          currentCleanupFn = window.storyCleanupHome;
          window.storyRenderHome(contentEl, ctx);
        }
        break;
      case 'm0':
        if (typeof window.storyRenderM0 === 'function') {
          currentCleanupFn = window.storyCleanupM0;
          window.storyRenderM0(contentEl, ctx);
        }
        break;
      case 'm2':
        if (typeof window.storyRenderM2 === 'function') {
          currentCleanupFn = window.storyCleanupM2;
          window.storyRenderM2(contentEl, ctx);
        }
        break;
      case 'm3':
        if (typeof window.storyRenderM3 === 'function') {
          currentCleanupFn = window.storyCleanupM3;
          window.storyRenderM3(contentEl, ctx);
        }
        break;
      case 'm4':
        if (typeof window.storyRenderM4 === 'function') {
          currentCleanupFn = window.storyCleanupM4;
          window.storyRenderM4(contentEl, ctx);
        }
        break;
      case 'm5':
        if (typeof window.storyRenderM5 === 'function') {
          currentCleanupFn = window.storyCleanupM5;
          window.storyRenderM5(contentEl, ctx);
        }
        break;
      case 'batch':
        if (typeof window.storyRenderBatch === 'function') {
          currentCleanupFn = window.storyCleanupBatch;
          window.storyRenderBatch(contentEl, ctx);
        }
        break;
      case 'rolechat':
        if (typeof window.storyRenderRoleChat === 'function') {
          currentCleanupFn = window.storyCleanupRoleChat;
          window.storyRenderRoleChat(contentEl, ctx);
        }
        break;
    }
  }

  // Exposed entry & lifecycle hooks
  window.renderStoryMaker = function(container) {
    refreshBookList(function() {
      renderShell(container);
    });
  };

  window.suspendStoryMaker = function() {
    for (var i = 0; i < abortControllers.length; i++) {
      try { abortControllers[i].abort(); } catch (e) {}
    }
    abortControllers = [];
    if (currentCleanupFn && typeof currentCleanupFn === 'function') {
      try { currentCleanupFn(); } catch (e) {}
    }
  };

  window.resumeStoryMaker = function() {
    // No-op boundary; retained sub-page DOM persists
  };

  window.cleanupStoryMaker = function() {
    window.suspendStoryMaker();
    currentCleanupFn = null;
    rootContainer = null;
  };

})();
