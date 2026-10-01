// core-util.js — 全局基础工具（必须在 i18n.js 之前加载）。
// Single source for the HTML escaper, byte formatter, and SSE reconnect
// backoff shared by the host UI and playground frontends.

'use strict';

// escapeHtml escapes the five HTML-significant characters. The canonical
// implementation; every other copy in web/ delegates here.
window.escapeHtml = function (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

// formatBytes renders a byte count in 1024-base units with one decimal place
// (e.g. "1.5 MB", "0 B", "12.0 KB"). Canonical form taken from download.js.
window.formatBytes = function (bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i < 0) i = 0;
  if (i >= units.length) i = units.length - 1;
  var value = bytes / Math.pow(1024, i);
  return (i === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[i];
};

// sseBackoff schedules reconnects with jitter and exponential growth.
// state = { delay: <next delay ms>, timer: <timer id|null> }.
//   schedule(fn, state)  arms the next attempt: delay = min(delay*2, 30000)
//                        with 0.8–1.2 jitter; resets to 1000 on success.
window.sseBackoff = {
  BASE: 1000,
  CAP: 30000,
  reset: function (state) {
    state.delay = this.BASE;
    clearTimeout(state.timer);
    state.timer = null;
  },
  schedule: function (fn, state) {
    if (!state.delay) state.delay = this.BASE;
    var jitter = 0.8 + Math.random() * 0.4;
    var d = Math.round(state.delay * jitter);
    state.delay = Math.min(state.delay * 2, this.CAP);
    clearTimeout(state.timer);
    state.timer = setTimeout(fn, d);
  },
};
