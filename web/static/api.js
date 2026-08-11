const API = '/api';

function handleUnauthorizedResponse(r) {
  if (!r || (r.status !== 401 && r.status !== 403)) return;
  if (typeof checkAuthStatus !== 'function') return;
  checkAuthStatus().then(function(auth) {
    if ((auth.passwordEnabled || auth.authEnabled) && !(auth.authenticated || auth.loggedIn) && typeof renderLoginScreen === 'function') {
      renderLoginScreen();
    }
    // A 403 with a live session normally means the CSRF token changed;
    // checkAuthStatus refreshes the token for the next request.
  });
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

function redactTraceValue(val) {
  if (val == null) return val;
  if (typeof val === 'string') {
    if (/^data:image\/[a-zA-Z]+;base64,/.test(val)) return '[redacted data URL]';
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(function(item) { return redactTraceValue(item); });
  }
  if (typeof val === 'object') {
    var copy = {};
    var sensitiveKeys = /^(authorization|cookie|set-cookie|api_?key|token|secret|password|credential)$/i;
    Object.keys(val).forEach(function(k) {
      if (sensitiveKeys.test(k)) {
        copy[k] = '[redacted]';
      } else {
        copy[k] = redactTraceValue(val[k]);
      }
    });
    return copy;
  }
  return val;
}

async function apiPostTrace(path, body, signal, hooks) {
  hooks = hooks || {};
  const MAX_BYTES = 256 * 1024;
  const startTime = Date.now();
  var truncated = false;

  var reqBodyScrubbed = redactTraceValue(body);
  var reqBodyStr = typeof reqBodyScrubbed === 'string' ? reqBodyScrubbed : JSON.stringify(reqBodyScrubbed || {});
  if (reqBodyStr && reqBodyStr.length > MAX_BYTES) {
    reqBodyStr = reqBodyStr.substring(0, MAX_BYTES) + '... [truncated]';
    truncated = true;
  }

  const trace = {
    method: 'POST',
    url: API + path,
    requestHeaders: redactTraceValue({ 'Content-Type': 'application/json' }),
    requestBody: reqBodyScrubbed,
    requestBodyText: reqBodyStr,
    responseStatus: null,
    responseHeaders: null,
    responseBody: null,
    responseRawBody: null,
    durationMs: 0,
    loading: true,
    error: null,
    truncated: truncated
  };

  if (typeof hooks.onRequest === 'function') {
    try { hooks.onRequest(trace); } catch(e) {}
  }

  try {
    const r = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal
    });

    trace.durationMs = Date.now() - startTime;
    trace.responseStatus = r.status;

    var respHdrs = {};
    if (r.headers && typeof r.headers.forEach === 'function') {
      r.headers.forEach(function(val, key) { respHdrs[key] = val; });
    }
    trace.responseHeaders = redactTraceValue(respHdrs);

    var rawText = '';
    try { rawText = await r.text(); } catch(e) { rawText = ''; }

    if (rawText.length > MAX_BYTES) {
      trace.responseRawBody = rawText.substring(0, MAX_BYTES) + '... [truncated]';
      trace.truncated = true;
    } else {
      trace.responseRawBody = rawText;
    }

    var data = null;
    try {
      data = JSON.parse(rawText);
    } catch(e) {
      data = { error: 'HTTP ' + r.status + ' (non-JSON body)' };
    }

    trace.responseBody = redactTraceValue(data);
    trace.loading = false;

    if (!r.ok) {
      handleUnauthorizedResponse(r);
      if (typeof data === 'object' && data && !data.error) {
        data.error = 'HTTP ' + r.status;
      }
      trace.error = (data && data.error) || ('HTTP ' + r.status);
    }

    if (typeof hooks.onResponse === 'function') {
      try { hooks.onResponse(trace); } catch(e) {}
    }

    return data;
  } catch(err) {
    trace.durationMs = Date.now() - startTime;
    trace.loading = false;
    trace.error = err.message || 'Network error';
    if (typeof hooks.onResponse === 'function') {
      try { hooks.onResponse(trace); } catch(e) {}
    }
    return { error: trace.error };
  }
}

