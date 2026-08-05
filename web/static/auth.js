// ===================== Auth / Login =====================

async function checkAuthStatus() {
  try {
    var resp = await fetch('/api/auth/status');
    var data = await resp.json();
    var enabled = !!(data.passwordEnabled || data.authEnabled);
    var authenticated = !!(data.authenticated || data.loggedIn);
    return {
      passwordEnabled: enabled,
      authEnabled: enabled,
      authenticated: authenticated,
      loggedIn: authenticated
    };
  } catch(e) {
    return { passwordEnabled: false, authEnabled: false, authenticated: true, loggedIn: true };
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
  initTheme();
  initFontSize();
  initLang();
  initHeaderStats();
  setupHeaderResponsive();
  document.querySelectorAll('.nav-item').forEach(function(el) {
    el.addEventListener('click', function() {
      var page = el.dataset.page;
      if (page === 'gallery') {
        gotoGalleryToggle();
      } else if (page) {
        navigateTo(page);
      }
    });
  });
  navigateTo('endpoint');
}