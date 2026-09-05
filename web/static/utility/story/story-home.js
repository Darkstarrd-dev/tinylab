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
      { value: 'all', label: '全部类型' },
      { value: 'project', label: '📙 作品 (Project)' },
      { value: 'reference', label: '📁 素材 (Reference)' }
    ];

    container.innerHTML = '' +
      '<div class="sm-page-container">' +
        '<div class="sm-page-header">' +
          '<div class="sm-page-title">' + escapeHtml(t('storyHome')) + '</div>' +
          '<div class="sm-page-actions">' +
            '<div style="width:160px;">' +
              renderCustomSelectHtml('sm-filter-type-wrap', 'sm-filter-type-select', typeFilterOptions, filterType, null, 'width:100%;height:32px') +
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
                  '<th>创建时间</th>' +
                  '<th style="text-align:right;">操作</th>' +
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
          '<td><strong>' + escapeHtml(b.title) + '</strong>' + (isCurrent ? ' <span style="font-size:11px;color:var(--accent);font-weight:normal;">(当前选中)</span>' : '') + '</td>' +
          '<td>' + (b.type === 'project' ? '<span class="tag tag-blue">作品</span>' : '<span class="tag tag-gray">素材</span>') + '</td>' +
          '<td>' + escapeHtml(b.author || '—') + '</td>' +
          '<td>' + escapeHtml(b.platform || '—') + '</td>' +
          '<td style="color:var(--text-secondary);">' + escapeHtml((b.createdAt || '').slice(0, 10)) + '</td>' +
          '<td style="text-align:right;white-space:nowrap;">' +
            '<button class="btn btn-ghost btn-sm sm-action-select" data-id="' + b.id + '" type="button">选定</button> ' +
            '<button class="btn btn-ghost btn-sm sm-action-edit" data-id="' + b.id + '" type="button">编辑</button> ' +
            '<button class="btn btn-ghost btn-sm sm-action-export" data-id="' + b.id + '" type="button">' + escapeHtml(t('storyExportTxt')) + '</button> ' +
            '<button class="btn btn-danger btn-sm sm-action-delete" data-id="' + b.id + '" type="button">删除</button>' +
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
          content: '删除后无法恢复，关联的章节、卡片和大纲将一并清理。',
          onOk: function() {
            currentCtx.api.del('/books/' + encodeURIComponent(id)).then(function() {
              toast('已删除作品', 'success');
              if (currentCtx.activeBookId === id) {
                currentCtx.setActiveBookId('');
              }
              currentCtx.refreshBooks(function() {
                drawUI(container);
              });
            }).catch(function(err) {
              toast('删除失败: ' + err.message, 'error');
            });
          }
        });
      });
    });
  }

  function openCreateBookModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = '' +
      '<div class="modal-card" style="width:400px;">' +
        '<div class="modal-header">' +
          '<div class="modal-title">' + escapeHtml(t('storyNewBook')) + '</div>' +
          '<button class="modal-close-btn">&times;</button>' +
        '</div>' +
        '<div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyTitle')) + ' *</span>' +
            '<input type="text" class="input" id="sm-new-title" placeholder="如：凡人修仙传" />' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyType')) + '</span>' +
            '<select class="select" id="sm-new-type">' +
              '<option value="project">作品 (Project - 可创作与生成)</option>' +
              '<option value="reference">素材 (Reference - 仅供参考拆解)</option>' +
            '</select>' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyAuthor')) + '</span>' +
            '<input type="text" class="input" id="sm-new-author" placeholder="作者名（选填）" />' +
          '</div>' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">' + escapeHtml(t('storyPlatform')) + '</span>' +
            '<input type="text" class="input" id="sm-new-platform" placeholder="首发平台（选填）" />' +
          '</div>' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost modal-cancel-btn">' + escapeHtml(t('cancel')) + '</button>' +
          '<button class="btn btn-primary" id="sm-new-confirm">' + escapeHtml(t('confirm')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    overlay.querySelector('.modal-close-btn').onclick = close;
    overlay.querySelector('.modal-cancel-btn').onclick = close;
    overlay.querySelector('#sm-new-confirm').onclick = function() {
      var title = overlay.querySelector('#sm-new-title').value.trim();
      var type = overlay.querySelector('#sm-new-type').value;
      var author = overlay.querySelector('#sm-new-author').value.trim();
      var platform = overlay.querySelector('#sm-new-platform').value.trim();
      if (!title) {
        toast('请输入书名', 'error');
        return;
      }
      currentCtx.api.post('/books', { title: title, type: type, author: author, platform: platform }).then(function(res) {
        toast('创建成功', 'success');
        currentCtx.setActiveBookId(res.id);
        close();
        currentCtx.refreshBooks(function() {
          var container = document.getElementById('sm-main-content');
          if (container) drawUI(container);
        });
      }).catch(function(err) {
        toast('创建失败: ' + err.message, 'error');
      });
    };
  }

  function openEditBookModal(b) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = '' +
      '<div class="modal-card" style="width:400px;">' +
        '<div class="modal-header">' +
          '<div class="modal-title">编辑作品属性</div>' +
          '<button class="modal-close-btn">&times;</button>' +
        '</div>' +
        '<div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">' +
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
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost modal-cancel-btn">' + escapeHtml(t('cancel')) + '</button>' +
          '<button class="btn btn-primary" id="sm-edit-confirm">' + escapeHtml(t('save')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    overlay.querySelector('.modal-close-btn').onclick = close;
    overlay.querySelector('.modal-cancel-btn').onclick = close;
    overlay.querySelector('#sm-edit-confirm').onclick = function() {
      var title = overlay.querySelector('#sm-edit-title').value.trim();
      var author = overlay.querySelector('#sm-edit-author').value.trim();
      var platform = overlay.querySelector('#sm-edit-platform').value.trim();
      currentCtx.api.patch('/books/' + encodeURIComponent(b.id), { title: title, author: author, platform: platform }).then(function() {
        toast('已保存修改', 'success');
        close();
        currentCtx.refreshBooks(function() {
          var container = document.getElementById('sm-main-content');
          if (container) drawUI(container);
        });
      }).catch(function(err) {
        toast('保存失败: ' + err.message, 'error');
      });
    };
  }

  window.storyRenderHome = render;
  window.storyCleanupHome = function() {};
})();
