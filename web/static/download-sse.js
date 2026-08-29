// web/static/download-sse.js
// SSE lifecycle for TinyRouter Download.
// Extracted from download.js (P2-05): EventSource + reconnect + suspend/resume.
// Depends on download.js globals: downloadEventSource, downloadReconnectTimer, downloadActivePredicate, downloadTasksMap, downloadTaskEls, isDownloadActive via download.js or own definition

function isDownloadActive() {
  if (typeof downloadActivePredicate === 'function') return !!downloadActivePredicate();
  if (typeof window !== 'undefined' && typeof window.utilityIsToolActive === 'function') {
    return !!window.utilityIsToolActive('download');
  }
  return true;
}

function scheduleDownloadReconnect() {
  if (downloadReconnectTimer || !isDownloadActive()) return;
  downloadReconnectTimer = setTimeout(function () {
    downloadReconnectTimer = null;
    if (isDownloadActive()) connectDownloadSSE();
  }, 3000);
}

// connectDownloadSSE subscribes to the download event stream with auto-reconnect.
function connectDownloadSSE() {
  if (!isDownloadActive()) return;
  if (downloadReconnectTimer) {
    clearTimeout(downloadReconnectTimer);
    downloadReconnectTimer = null;
  }
  if (downloadEventSource) { downloadEventSource.close(); downloadEventSource = null; }
  var source;
  try {
    source = new EventSource('/api/downloads/stream');
    downloadEventSource = source;
  } catch (e) {
    scheduleDownloadReconnect();
    return;
  }
  source.onmessage = function(event) {
    if (source !== downloadEventSource || !event || !event.data || !isDownloadActive()) return;
    var evt;
    try { evt = JSON.parse(event.data); } catch (e) { return; }
    if (evt && evt.type === 'task-updated' && evt.task) updateDownloadTask(evt.task);
  };
  source.onerror = function() {
    if (source !== downloadEventSource) return;
    source.close();
    downloadEventSource = null;
    // P1-02a: re-sync full state on reconnect so burst/missed events don't leave UI stale
    try{ loadDownloadTasks(); }catch(e){}
    scheduleDownloadReconnect();
  };
}

function suspendDownload() {
  if (downloadReconnectTimer) {
    clearTimeout(downloadReconnectTimer);
    downloadReconnectTimer = null;
  }
  if (downloadEventSource) { downloadEventSource.close(); downloadEventSource = null; }
}

function resumeDownload() {
  if (isDownloadActive()) connectDownloadSSE();
}

function setDownloadActivePredicate(predicate) {
  downloadActivePredicate = typeof predicate === 'function' ? predicate : null;
}

window.suspendDownload = suspendDownload;
window.resumeDownload = resumeDownload;
window.setDownloadActivePredicate = setDownloadActivePredicate;
