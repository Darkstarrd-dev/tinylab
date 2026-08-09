// ===================== Auth / Login / Setup =====================

// Session-bound CSRF token store + automatic injection. The token is set from
// /api/auth/status (boot / page refresh), the login response, the setup
// response, or a settings password-change response. Every same-origin
// state-changing fetch then carries X-CSRF-Token automatically — including
// the ~100 direct fetch() call sites across the SPA that bypass the api.js
// helpers (gallery uploads, editor saves, archive packs, SSE job starts).
(function installCsrfFetchWrapper() {
  var origFetch = window.fetch;
  var csrfToken = '';
  window.__setCsrfToken = function(t) { csrfToken = t || ''; };
  window.__getCsrfToken = function() { return csrfToken; };
  window.fetch = function(input, init) {
    init = init || {};
    var method = (init.method || 'GET').toUpperCase();
    var isStateChanging = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    if (!csrfToken || !isStateChanging) return origFetch(input, init);
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var sameOrigin = url.indexOf('://') < 0 || url.indexOf(location.origin) === 0;
    if (!sameOrigin) return origFetch(input, init);
    var headers = init.headers || {};
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', csrfToken);
    } else if (Array.isArray(headers)) {
      headers.push(['X-CSRF-Token', csrfToken]);
    } else {
      headers['X-CSRF-Token'] = csrfToken;
    }
    init.headers = headers;
    return origFetch(input, init);
  };
})();

async function checkAuthStatus() {
  try {
    var resp = await fetch('/api/auth/status');
    var data = await resp.json();
    var enabled = !!(data.passwordEnabled || data.authEnabled);
    var authenticated = !!(data.authenticated || data.loggedIn);
    if (data.csrfToken) window.__setCsrfToken(data.csrfToken);
    return {
      passwordEnabled: enabled,
      authEnabled: enabled,
      setupRequired: !!data.setupRequired,
      authenticated: authenticated,
      loggedIn: authenticated
    };
  } catch(e) {
    return { passwordEnabled: false, authEnabled: false, setupRequired: false, authenticated: true, loggedIn: true };
  }
}


function renderLoginScreen() {
  var appDiv = document.querySelector('.app');
  if (appDiv) appDiv.classList.add('auth-app-hidden');

  var loginOverlay = document.getElementById('login-overlay');
  if (!loginOverlay) {
    loginOverlay = document.createElement('div');
    loginOverlay.id = 'login-overlay';
    loginOverlay.className = 'login-overlay';
    document.body.appendChild(loginOverlay);
  }

  loginOverlay.innerHTML = '\
    <div class="login-card">\
      <div class="login-logo">\
        <img src="/logo-sm.png" alt="TinyRouter" width="48" height="48">\
        <h2>TinyRouter</h2>\
      </div>\
      <div class="login-form">\
        <input type="password" id="login-password" class="login-input" placeholder="' + t('enterPassword') + '" autocomplete="current-password">\
        <div class="login-actions">\
          <button type="button" class="btn btn-primary login-submit-btn" id="login-submit" onclick="handleLogin()">' + t('login') + '</button>\
          <button type="button" class="btn btn-ghost login-exit-btn" onclick="handleExitApp()">' + t('exitApp') + '</button>\
        </div>\
        <div class="login-error" id="login-error"></div>\
      </div>\
    </div>';

  setTimeout(function() {
    var input = document.getElementById('login-password');
    if (input) {
      input.focus();
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') handleLogin();
      });
    }
  }, 100);
}

function showLoginError(msg) {
  var errEl = document.getElementById('login-error');
  if (errEl) {
    errEl.textContent = msg;
    errEl.classList.add('login-error-visible');
  }
}

async function handleLogin() {
  var input = document.getElementById('login-password');
  if (!input) return;
  var password = input.value;
  if (!password) return;

  var btn = document.getElementById('login-submit');
  if (btn) { btn.disabled = true; btn.innerHTML = typeof getSpinnerHtml === 'function' ? getSpinnerHtml() : '<span class="btn-spinner"></span>'; }

  try {
    var resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password })
    });
    var data = await resp.json();
    if (data.success) {
      if (data.csrfToken) window.__setCsrfToken(data.csrfToken);
      var overlay = document.getElementById('login-overlay');
      if (overlay) overlay.remove();
      var appDiv = document.querySelector('.app');
      if (appDiv) appDiv.classList.remove('auth-app-hidden');
      initApp();
    } else {
      showLoginError(t('wrongPassword'));
      if (btn) { btn.disabled = false; btn.textContent = t('login'); }
      input.value = '';
      input.focus();
    }
  } catch(e) {
    showLoginError(t('wrongPassword'));
    if (btn) { btn.disabled = false; btn.textContent = t('login'); }
    input.value = '';
    input.focus();
  }
}

// renderSetupScreen shows the first-run bootstrap: no password is configured
// yet, so the management API is locked (setup-required) and the user must
// create the initial password before anything else works.
function renderSetupScreen() {
  var appDiv = document.querySelector('.app');
  if (appDiv) appDiv.classList.add('auth-app-hidden');

  var overlay = document.getElementById('login-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'login-overlay';
    overlay.className = 'login-overlay';
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = '\
    <div class="login-card">\
      <div class="login-logo">\
        <img src="/logo-sm.png" alt="TinyRouter" width="48" height="48">\
        <h2>TinyRouter</h2>\
      </div>\
      <div class="login-form">\
        <p class="muted" style="text-align:center;margin-bottom:12px">' + t('setupRequiredDesc') + '</p>\
        <input type="password" id="setup-password" class="login-input" placeholder="' + t('newPassword') + '" autocomplete="new-password">\
        <input type="password" id="setup-password2" class="login-input" placeholder="' + t('confirmPassword') + '" autocomplete="new-password">\
        <div class="login-actions">\
          <button type="button" class="btn btn-primary login-submit-btn" id="setup-submit" onclick="handleSetup()">' + t('setupSubmit') + '</button>\
        </div>\
        <div class="login-error" id="login-error"></div>\
      </div>\
    </div>';

  setTimeout(function() {
    var input = document.getElementById('setup-password');
    if (input) {
      input.focus();
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') handleSetup();
      });
      var input2 = document.getElementById('setup-password2');
      if (input2) input2.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') handleSetup();
      });
    }
  }, 100);
}

async function handleSetup() {
  var pw = document.getElementById('setup-password');
  var pw2 = document.getElementById('setup-password2');
  if (!pw || !pw2) return;
  if (!pw.value) { showLoginError(t('enterPassword')); return; }
  if (pw.value !== pw2.value) { showLoginError(t('passwordMismatch')); return; }

  var btn = document.getElementById('setup-submit');
  if (btn) { btn.disabled = true; btn.innerHTML = typeof getSpinnerHtml === 'function' ? getSpinnerHtml() : '<span class="btn-spinner"></span>'; }

  try {
    var resp = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw.value })
    });
    var data = await resp.json();
    if (data.success) {
      if (data.csrfToken) window.__setCsrfToken(data.csrfToken);
      var overlay = document.getElementById('login-overlay');
      if (overlay) overlay.remove();
      var appDiv = document.querySelector('.app');
      if (appDiv) appDiv.classList.remove('auth-app-hidden');
      initApp();
    } else {
      showLoginError(data.error || t('failed', ['setup']));
      if (btn) { btn.disabled = false; btn.textContent = t('setupSubmit'); }
    }
  } catch(e) {
    showLoginError(t('failed', [e.message || 'setup']));
    if (btn) { btn.disabled = false; btn.textContent = t('setupSubmit'); }
  }
}

async function handleExitApp() {
  try { await fetch('/api/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch(e) {}
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2>TinyRouter</h2><p class="muted">Stopped</p></div></div>';
}

function setupHeaderResponsive() {
  var header = document.querySelector('.top-header');
  if (!header) return;

  var brand = header.querySelector('.top-header-brand');
  var nav = header.querySelector('.top-header-nav');
  var quickslot = document.getElementById('quickslot-header') || header.querySelector('.top-header-stats');
  var shutdown = header.querySelector('.top-header-shutdown');

  function calculateAndApply() {
    if (shutdown) shutdown.style.display = '';
    if (brand) brand.style.display = '';
    if (quickslot) quickslot.style.display = '';

    var containerWidth = header.clientWidth;
    var style = window.getComputedStyle(header);
    var padLeft = parseFloat(style.paddingLeft) || 0;
    var padRight = parseFloat(style.paddingRight) || 0;
    var availWidth = containerWidth - padLeft - padRight;

    var wNav = nav ? nav.offsetWidth : 0;
    var wBrand = brand ? brand.offsetWidth : 0;
    var wQuickslot = (quickslot && quickslot.children && quickslot.children.length > 0 && quickslot.offsetWidth > 0) ? quickslot.offsetWidth : 0;
    var wShutdown = shutdown ? shutdown.offsetWidth : 0;

    var gap = 12;

    var count4 = (wNav > 0 ? 1 : 0) + (wBrand > 0 ? 1 : 0) + (wQuickslot > 0 ? 1 : 0) + (wShutdown > 0 ? 1 : 0);
    var need4 = wNav + wBrand + wQuickslot + wShutdown + Math.max(0, count4 - 1) * gap;

    if (availWidth >= need4) {
      if (shutdown) shutdown.style.display = '';
      if (brand) brand.style.display = '';
      if (quickslot) quickslot.style.display = '';
      return;
    }

    // Step 1: Hide Shutdown button
    if (shutdown) shutdown.style.display = 'none';
    var count3 = (wNav > 0 ? 1 : 0) + (wBrand > 0 ? 1 : 0) + (wQuickslot > 0 ? 1 : 0);
    var need3 = wNav + wBrand + wQuickslot + Math.max(0, count3 - 1) * gap;

    if (availWidth >= need3) {
      if (brand) brand.style.display = '';
      if (quickslot) quickslot.style.display = '';
      return;
    }

    // Step 2: Hide Brand container (Logo + Title + theme btn)
    if (brand) brand.style.display = 'none';
    var count2 = (wNav > 0 ? 1 : 0) + (wQuickslot > 0 ? 1 : 0);
    var need2 = wNav + wQuickslot + Math.max(0, count2 - 1) * gap;

    if (availWidth >= need2) {
      if (quickslot) quickslot.style.display = '';
      return;
    }

    // Step 3: Hide Quickslot / Stats
    if (quickslot) quickslot.style.display = 'none';
  }

  if (typeof ResizeObserver !== 'undefined') {
    var ro = new ResizeObserver(function() {
      calculateAndApply();
    });
    ro.observe(header);
  }
  window.addEventListener('resize', calculateAndApply);
  setTimeout(calculateAndApply, 50);
  setTimeout(calculateAndApply, 300);
  calculateAndApply();
}

function initApp() {
  if (window.__tinyRouterAppInitialized) return;
  window.__tinyRouterAppInitialized = true;
  // Active utility state is intentionally memory-only; default to editor.
  sessionStorage.removeItem('trUtilityTool');
  if (typeof utilityActiveTool !== 'undefined') utilityActiveTool = null;
  initTheme();
  initFontSize();
  initLang();
  initHeaderStats();
  setupHeaderResponsive();
  if (typeof renderHeaderQuickSlots === 'function') {
    renderHeaderQuickSlots();
  }
  document.querySelectorAll('.nav-item').forEach(function(el) {
    el.addEventListener('click', function() {
      var page = el.dataset.page;
      if (page === 'utility') {
        if (currentPage !== 'utility' && !isUtilityTool(currentPage)) {
          navigateTo('utility');
        } else {
          toggleUtilityMenu();
        }
        return;
      }
      if (page === 'gallery') { navigateTo('gallery'); return; }
      if (page) navigateTo(page);
    });
  });
  var menu = document.getElementById('utility-menu');
  if (menu) {
    menu.addEventListener('click', function(e) {
      var item = e.target.closest('[data-utility-tool]');
      if (item && !item.disabled) selectUtilityTool(item.dataset.utilityTool);
    });
    menu.addEventListener('keydown', function(e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('[data-utility-tool]:not([disabled])'));
      var index = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) {
          if (index < 0) {
            var activeItem = menu.querySelector('[aria-current="page"]') || items[0];
            activeItem.focus();
          } else {
            items[(index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
          }
        }
      } else if (e.key === 'Enter' && index >= 0) {
        e.preventDefault(); selectUtilityTool(items[index].dataset.utilityTool);
      } else if (e.key === 'Escape') {
        e.preventDefault(); closeUtilityMenu();
        var button = document.querySelector('.nav-item[data-page="utility"]');
        if (button) button.focus();
      }
    });
  }
  document.addEventListener('click', function(e) {
    if (utilityMenuOpen && !e.target.closest('.utility-nav-wrap')) closeUtilityMenu();
  });
  navigateTo('monitor');
}