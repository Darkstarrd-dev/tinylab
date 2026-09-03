// web/static/download-list.js
// Task list render + multi-select for TinyLab Download.
// Extracted from download.js (P2-05): list render, update, selection, row HTML, clear.
// Depends on download.js globals: downloadTasksMap, downloadTaskEls, selectedTaskId, selectedTaskIds, DL_STATUS_KEYS etc; detail globals for renderTaskDetail/updateSelectedTaskView

function renderDownloadTask(task, _replaceEmpty) {
  var listEl = document.getElementById('dl-task-list');
  if (!listEl || !task || !task.id) return;
  downloadTasksMap[task.id] = task;

  var existing = downloadTaskEls[task.id];
  var itemHtml = taskListItemHtml(task);
  if (existing) {
    existing.outerHTML = itemHtml;
  } else {
    var tmp = document.createElement('div');
    tmp.innerHTML = itemHtml;
    var node = tmp.firstElementChild;
    // Keep list order aligned with insertion order (newest appended).
    listEl.appendChild(node);
  }
  downloadTaskEls[task.id] = document.getElementById('dl-task-item-' + task.id);

  var itemEl = downloadTaskEls[task.id];
  if (itemEl) {
    itemEl.classList.toggle('selected', selectedTaskIds.indexOf(task.id) >= 0);
  }

  // Default selection to the first task ever rendered.
  if (!selectedTaskId) {
    selectTask(null, task.id);
  } else if (task.id === selectedTaskId) {
    renderTaskDetail();
  }
}

// updateDownloadTask reconciles an incoming task update from the SSE stream.
function updateDownloadTask(task) {
  if (!task || !task.id) return;
  downloadTasksMap[task.id] = task;
  var existing = downloadTaskEls[task.id];
  if (!existing) {
    renderDownloadTask(task, true);
    return;
  }
  // Refresh the list item in place.
  existing.outerHTML = taskListItemHtml(task);
  downloadTaskEls[task.id] = document.getElementById('dl-task-item-' + task.id);

  var itemEl = downloadTaskEls[task.id];
  if (itemEl) {
    itemEl.classList.toggle('selected', selectedTaskIds.indexOf(task.id) >= 0);
  }

  // Refresh the detail panel if this is the selected task. Live phases
  // patch progress in place; status transitions re-render (actions change).
  if (task.id === selectedTaskId) {
    updateSelectedTaskView(task);
  }
}


// selectTask updates the selected task id, highlights the left list items and
// refreshes the right-hand detail panel. Supports Ctrl and Shift multi-select.
function selectTask(event, taskId) {
  var listEl = document.getElementById('dl-task-list');
  if (!listEl) return;

  var allItems = Array.prototype.slice.call(listEl.querySelectorAll('.dl-task-item'));
  var allIds = allItems.map(function(el) { return el.getAttribute('data-task-id'); });

  var isCtrl = event && (event.ctrlKey || event.metaKey);
  var isShift = event && event.shiftKey;

  if (isShift && selectedTaskId && selectedTaskIds.length > 0) {
    var startIdx = allIds.indexOf(selectedTaskId);
    var endIdx = allIds.indexOf(taskId);
    if (startIdx >= 0 && endIdx >= 0) {
      var min = Math.min(startIdx, endIdx);
      var max = Math.max(startIdx, endIdx);
      var rangeIds = allIds.slice(min, max + 1);

      rangeIds.forEach(function(id) {
        if (selectedTaskIds.indexOf(id) < 0) {
          selectedTaskIds.push(id);
        }
      });
    }
    selectedTaskId = taskId;
  } else if (isCtrl) {
    var idx = selectedTaskIds.indexOf(taskId);
    if (idx >= 0) {
      if (selectedTaskIds.length > 1) {
        selectedTaskIds.splice(idx, 1);
      }
    } else {
      selectedTaskIds.push(taskId);
    }
    selectedTaskId = taskId;
  } else {
    selectedTaskIds = [taskId];
    selectedTaskId = taskId;
  }

  allItems.forEach(function(el) {
    var tid = el.getAttribute('data-task-id');
    el.classList.toggle('selected', selectedTaskIds.indexOf(tid) >= 0);
  });

  renderTaskDetail();
}


function taskListItemHtml(task) {
  var p = task.progress || {};
  var percent = typeof p.percent === 'number' ? p.percent : 0;
  if (percent < 0) percent = 0;
  if (percent > 1) percent = 1;
  var pctText = formatProgress(percent);

  var status = task.status || 'pending';
  var title = task.title || task.url || task.id;
  var tid = escapeAttr(task.id);
  var isSelected = task.id === selectedTaskId ? ' selected' : '';

  var pctHtml = '';
  if (status === 'downloading' || status === 'processing' || status === 'pending') {
    pctHtml = '<span class="dl-task-item-pct">' + escapeHtml(pctText) + '</span>';
  }

  return '' +
    '<div class="dl-task-item' + isSelected + '" id="dl-task-item-' + tid + '" data-task-id="' + tid + '" onclick="selectTask(event, \'' + escapeForJsString(task.id) + '\')">' +
      '<span class="dl-status-dot ' + escapeAttr('dl-status-' + status) + '"></span>' +
      '<span class="dl-task-item-title" data-tooltip="' + escapeAttr(title) + '">' + escapeHtml(title) + '</span>' +
      pctHtml +
    '</div>';
}

// taskDetailHtml returns the right-side detail panel HTML for a task.

async function clearCompletedDownloads() {
  var res = await apiPost('/downloads/clear-completed', {});
  if (res && res.error) {
    toast(t('downloadFailed', [res.error]), 'error');
    return;
  }
  loadDownloadTasks();
}

// openDownloadDir requests the server to open the downloaded file's folder in the system file manager.
