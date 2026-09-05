// web/static/utility/story/story-home.js — Book Overview Page
(function() {
  'use strict';

  var currentCtx = null;
  var filterType = 'all';

  function render(container, ctx) {
    currentCtx = ctx;
    ctx.refreshBooks(function() {
      drawUI(container);
    });
  }

  function drawUI(container) {
    var books = currentCtx.books || [];
    var filtered = books.filter(function(b) {
      if (filterType === 'all') return true;
      return b.type === filterType;
    });

    var typeFilterOptions = [
      { value: 'all', label: t('storyAllTypes') },
      { value: 'project', label: t('storyProjectOpt') },
      { value: 'reference', label: t('storyReferenceOpt') }
    ];

    container.innerHTML = '' +
      '<div class="sm-page-container">' +
        '<div class="sm-page-header">' +
          '<div class="sm-page-title">' + escapeHtml(t('storyHome')) + '</div>' +
          '<div class="sm-page-actions">' +
            '<div style="width:160px;height:36px;">' +
              renderCustomSelectHtml('sm-filter-type-wrap', 'sm-filter-type-select', typeFilterOptions, filterType, null, 'width:100%;height:36px;') +
            '</div>' +
            '<button class="btn btn-primary" type="button" id="sm-btn-create-book">' + escapeHtml(t('storyNewBook')) + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="sm-card" style="padding:0;overflow:hidden;">' +
          '<div class="sm-table-wrap" style="border:none;border-radius:0;">' +
            '<table class="sm-table">' +
              '<thead>' +
                '<tr>' +
                  '<th>' + escapeHtml(t('storyTitle')) + '</th>' +
                  '<th>' + escapeHtml(t('storyType')) + '</th>' +
                  '<th>' + escapeHtml(t('storyAuthor')) + '</th>' +
                  '<th>' + escapeHtml(t('storyPlatform')) + '</th>' +
                  '<th>' + escapeHtml(t('createdAt')) + '</th>' +
                  '<th style="text-align:right;">' + escapeHtml(t('actions')) + '</th>' +
                '</tr>' +
              '</thead>' +
              '<tbody id="sm-books-tbody"></tbody>' +
            '</table>' +
          '</div>' +
        '</div>' +
      '</div>';

    var tbody = container.querySelector('#sm-books-tbody');
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-secondary);">' +
        escapeHtml(t('storyNoBooks')) + '</td></tr>';
    } else {
      var rowsHtml = '';
      for (var i = 0; i < filtered.length; i++) {
        var b = filtered[i];
        var isCurrent = b.id === currentCtx.activeBookId;
        var highlight = isCurrent ? ' style="background:var(--accent-subtle);"' : '';
        rowsHtml += '<tr' + highlight + '>' +
          '<td><strong>' + escapeHtml(b.title) + '</strong>' + (isCurrent ? ' <span style="font-size:11px;color:var(--accent);font-weight:normal;">(' + escapeHtml(t('storyCurrentSelected')) + ')</span>' : '') + '</td>' +
          '<td>' + (b.type === 'project' ? '<span class="tag tag-blue">' + escapeHtml(t('storyProject')) + '</span>' : '<span class="tag tag-gray">' + escapeHtml(t('storyReference')) + '</span>') + '</td>' +
          '<td>' + escapeHtml(b.author || '—') + '</td>' +
          '<td>' + escapeHtml(b.platform || '—') + '</td>' +
          '<td style="color:var(--text-secondary);">' + escapeHtml((b.createdAt || '').slice(0, 10)) + '</td>' +
          '<td style="text-align:right;white-space:nowrap;">' +
            '<button class="btn btn-ghost btn-sm sm-action-select" data-id="' + b.id + '" type="button">' + escapeHtml(t('storySelect')) + '</button> ' +
            '<button class="btn btn-ghost btn-sm sm-action-edit" data-id="' + b.id + '" type="button">' + escapeHtml(t('edit')) + '</button> ' +
            '<button class="btn btn-ghost btn-sm sm-action-export" data-id="' + b.id + '" type="button">' + escapeHtml(t('storyExportTxt')) + '</button> ' +
            '<button class="btn btn-danger btn-sm sm-action-delete" data-id="' + b.id + '" type="button">' + escapeHtml(t('delete')) + '</button>' +
          '</td>' +
        '</tr>';
      }
      tbody.innerHTML = rowsHtml;
    }

    // Bind events
    container.querySelector('#sm-filter-type-select')?.addEventListener('change', function(e) {
      filterType = e.target.value;
      drawUI(container);
    });

    container.querySelector('#sm-btn-create-book')?.addEventListener('click', function() {
      openCreateBookModal();
    });

    container.querySelectorAll('.sm-action-select').forEach(function(btn) {
      btn.addEventListener('click', function() {
        currentCtx.setActiveBookId(btn.dataset.id);
        drawUI(container);
      });
    });

    container.querySelectorAll('.sm-action-export').forEach(function(btn) {
      btn.addEventListener('click', function() {
        window.open('/api/storymaker/books/' + encodeURIComponent(btn.dataset.id) + '/export?format=txt', '_blank');
      });
    });

    container.querySelectorAll('.sm-action-edit').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var b = currentCtx.books.find(function(x) { return x.id === btn.dataset.id; });
        if (b) openEditBookModal(b);
      });
    });

    container.querySelectorAll('.sm-action-delete').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.dataset.id;
        confirmModal({
          title: t('storyDeleteConfirm'),
          content: t('storyDeleteBookConfirm'),
          onOk: function() {
            currentCtx.api.del('/books/' + encodeURIComponent(id)).then(function() {
              toast(t('storyBookDeleted'), 'success');
              if (currentCtx.activeBookId === id) {
                currentCtx.setActiveBookId('');
              }
              currentCtx.refreshBooks(function() {
                drawUI(container);
              });
            }).catch(function(err) {
              toast(t('storyDeleteFail') + ': ' + err.message, 'error');
            });
          }
        });
      });
    });
  }

  function openCreateBookModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    var typeOptions = [
      { value: 'project', label: t('storyProjectCreateOpt') },
      { value: 'reference', label: t('storyReferenceCreateOpt') }
    ];
    overlay.innerHTML = '' +
      '<div class="modal modal-card" style="width:400px;">' +
        '<div class="modal-title">' + escapeHtml(t('storyNewBook')) + '</div>' +
        '<div class="modal-body" style="display:flex;flex-direction:column;gap:14px;overflow:visible;">' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyTitle')) + ' *</span>' +
            '<input type="text" class="input" id="sm-new-title" placeholder="' + escapeAttr(t('storyTitlePlaceholder')) + '" />' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyType')) + '</span>' +
            renderCustomSelectHtml('sm-new-type-wrap', 'sm-new-type', typeOptions, 'project', null, 'width:100%;height:36px;') +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyAuthor')) + '</span>' +
            '<input type="text" class="input" id="sm-new-author" placeholder="' + escapeAttr(t('storyAuthorPlaceholder')) + '" />' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyPlatform')) + '</span>' +
            '<input type="text" class="input" id="sm-new-platform" placeholder="' + escapeAttr(t('storyPlatformPlaceholder')) + '" />' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-ghost modal-cancel-btn" type="button">' + escapeHtml(t('cancel')) + '</button>' +
          '<button class="btn btn-primary" id="sm-new-confirm" type="button">' + escapeHtml(t('confirm')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) close();
    });
    var cancelBtn = overlay.querySelector('.modal-cancel-btn');
    if (cancelBtn) cancelBtn.onclick = close;
    var closeBtn = overlay.querySelector('.modal-close-btn');
    if (closeBtn) closeBtn.onclick = close;
    overlay.querySelector('#sm-new-confirm').onclick = function() {
      var title = overlay.querySelector('#sm-new-title').value.trim();
      var type = overlay.querySelector('#sm-new-type').value;
      var author = overlay.querySelector('#sm-new-author').value.trim();
      var platform = overlay.querySelector('#sm-new-platform').value.trim();
      if (!title) {
        toast(t('storyInputTitlePrompt'), 'error');
        return;
      }
      currentCtx.api.post('/books', { title: title, type: type, author: author, platform: platform }).then(function(res) {
        toast(t('storyCreateSuccess'), 'success');
        currentCtx.setActiveBookId(res.id);
        close();
        currentCtx.refreshBooks(function() {
          var container = document.getElementById('sm-main-content');
          if (container) drawUI(container);
        });
      }).catch(function(err) {
        toast(t('storyCreateFail') + ': ' + err.message, 'error');
      });
    };
  }

  function openEditBookModal(b) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = '' +
      '<div class="modal modal-card" style="width:400px;">' +
        '<div class="modal-title">' + escapeHtml(t('storyEditBookModalTitle')) + '</div>' +
        '<div class="modal-body" style="display:flex;flex-direction:column;gap:14px;overflow:visible;">' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyTitle')) + '</span>' +
            '<input type="text" class="input" id="sm-edit-title" value="' + escapeAttr(b.title) + '" />' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyAuthor')) + '</span>' +
            '<input type="text" class="input" id="sm-edit-author" value="' + escapeAttr(b.author || '') + '" />' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyPlatform')) + '</span>' +
            '<input type="text" class="input" id="sm-edit-platform" value="' + escapeAttr(b.platform || '') + '" />' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-ghost modal-cancel-btn" type="button">' + escapeHtml(t('cancel')) + '</button>' +
          '<button class="btn btn-primary" id="sm-edit-confirm" type="button">' + escapeHtml(t('save')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) close();
    });
    var cancelBtn = overlay.querySelector('.modal-cancel-btn');
    if (cancelBtn) cancelBtn.onclick = close;
    var closeBtn = overlay.querySelector('.modal-close-btn');
    if (closeBtn) closeBtn.onclick = close;
    overlay.querySelector('#sm-edit-confirm').onclick = function() {
      var title = overlay.querySelector('#sm-edit-title').value.trim();
      var author = overlay.querySelector('#sm-edit-author').value.trim();
      var platform = overlay.querySelector('#sm-edit-platform').value.trim();
      currentCtx.api.patch('/books/' + encodeURIComponent(b.id), { title: title, author: author, platform: platform }).then(function() {
        toast(t('storySaved'), 'success');
        close();
        currentCtx.refreshBooks(function() {
          var container = document.getElementById('sm-main-content');
          if (container) drawUI(container);
        });
      }).catch(function(err) {
        toast(t('storySaveFail') + ': ' + err.message, 'error');
      });
    };
  }

  window.storyRenderHome = render;
  window.storyCleanupHome = function() {};
})();
