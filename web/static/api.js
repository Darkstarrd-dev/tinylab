const API = '/api';

function handleUnauthorizedResponse(r) {
  if (r && r.status === 401 && typeof checkAuthStatus === 'function' && typeof renderLoginScreen === 'function') {
    checkAuthStatus().then(function(auth) {
      if ((auth.passwordEnabled || auth.authEnabled) && !(auth.authenticated || auth.loggedIn)) {
        renderLoginScreen();
      }
    });
  }
}

async function apiGet(path, signal) {
  const r = await fetch(API + path, { signal: signal });
  var data;
  try { data = await r.json(); } catch(e) { return { error: 'HTTP ' + r.status + ' (non-JSON body)' }; }
  if (!r.ok) handleUnauthorizedResponse(r);
  if (!r.ok && !data.error) data.error = 'HTTP ' + r.status;
  return data;
}
async function apiPost(path, body, signal) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal
  });
  var data;
  try { data = await r.json(); } catch(e) { return { error: 'HTTP ' + r.status + ' (non-JSON body)' }; }
  if (!r.ok) handleUnauthorizedResponse(r);
  if (!r.ok && !data.error) data.error = 'HTTP ' + r.status;
  return data;
}
async function apiPatch(path, body, signal) {
  const r = await fetch(API + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal
  });
  var data;
  try { data = await r.json(); } catch(e) { data = { error: 'HTTP ' + r.status + ' (non-JSON body)' }; }
  if (!r.ok) handleUnauthorizedResponse(r);
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}
async function apiPut(path, body, signal) {
  const r = await fetch(API + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal
  });
  var data;
  try { data = await r.json(); } catch(e) { return { error: 'HTTP ' + r.status + ' (non-JSON body)' }; }
  if (!r.ok) handleUnauthorizedResponse(r);
  if (!r.ok && !data.error) data.error = 'HTTP ' + r.status;
  return data;
}
async function apiDelete(path, signal) {
  const r = await fetch(API + path, { method: 'DELETE', signal: signal });
  var data;
  try { data = await r.json(); } catch(e) { return { error: 'HTTP ' + r.status + ' (non-JSON body)' }; }
  if (!r.ok) handleUnauthorizedResponse(r);
  if (!r.ok && !data.error) data.error = 'HTTP ' + r.status;
  return data;
}
