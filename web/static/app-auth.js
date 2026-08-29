// app-auth.js — Session guard (boot auth check) + shutdown + skeleton placeholder.
// Extracted from app.js (P2-03). Load after app-i18n-boot.js (initTheme/initLang etc.) and auth.js
// (checkAuthStatus/renderLoginScreen/initApp). Also owns shutdownServer used by global shortcuts.
// This file is the P2-03 "login/session guard" split; auth.js retains CSRF + login form logic.
// Globals preserved: shutdownServer, showSkeleton (also used by non-auth pages as loading placeholder).
// Boot wiring: beforeunload console-stream cleanup + DOMContentLoaded auth gate.
window.addEventListener('beforeunload', () => {
    if (typeof closeConsoleStream === 'function') closeConsoleStream();
});
document.addEventListener('DOMContentLoaded', async function() {
  initTheme();
  ThemeSystem.init();
  initFontSize();
  initLang();
  var authStatus = await checkAuthStatus();
  var enabled = authStatus.passwordEnabled || authStatus.authEnabled;
  var authenticated = authStatus.authenticated || authStatus.loggedIn;
  if (enabled && !authenticated) renderLoginScreen();
  else initApp();
});

async function shutdownServer() {
  const ok = await confirmModal(t('confirmShutdown'));
  if (!ok) return;
  // Show "shutting down" UI immediately so the user is not left staring at a
  // frozen page even before the backend acknowledges. The desktop window will
  // be terminated by the backend shortly after; the fetch is best-effort.
  document.body.innerHTML = '\
    <div class="app" style="align-items:center;justify-content:center">\
      <div class="card" style="text-align:center;max-width:360px">\
        <div class="card-title">' + t('serverStopped') + '</div>\
        <p class="muted mt-12">' + t('serverStoppedDesc') + '</p>\
      </div>\
    </div>';
  try { await apiPost('/shutdown', {}); } catch (e) {}
  try { window.close(); } catch (e) {}
}

function showSkeleton(container, count) {
  if (count === undefined) count = 3;
  var cards = [];
  for (var i = 0; i < count; i++) {
    var s = document.createElement('div');
    s.className = 'skeleton skeleton-card';
    cards.push(s);
  }
  container.replaceChildren.apply(container, cards);
}

// Native OS file/directory dialogs must make the entire app modal. The page
// remains alive while the backend waits for the native dialog, so block both
// pointer and keyboard events until the picker returns.
