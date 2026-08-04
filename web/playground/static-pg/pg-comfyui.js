// pg-comfyui.js
// ----- ComfyUI protocol for Playground Image mode --------------------------
// Connects to a locally running ComfyUI (127.0.0.1:{port}), discovers its
// models/workflow templates from the ComfyUI API, renders a dynamic parameter
// panel from the selected workflow, submits it via POST /prompt, polls
// /history for completion, and returns the generated images as base64 data
// URLs (reusing the standard image-save + bubble rendering pipeline).
//
// HTTP calls go through the TinyRouter same-origin proxy POST /api/comfyui/proxy
// (the browser cannot read cross-origin responses from 127.0.0.1 without
// ComfyUI CORS being enabled). Polling also avoids ComfyUI browser Origin
// checks, so the integration does not require CORS or a direct WebSocket.
// ===========================================================================

// ----- Same-origin proxy call --------------------------------------------
// Returns a Promise<Response>; non-2xx responses reject with the proxy's
// error message.
function pgComfyCall(cfg, method, path, body, query) {
  var port = parseInt(cfg.imgComfyPort, 10) || 8188;
  return fetch('/api/comfyui/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      port: port,
      method: method,
      path: path,
      query: query || '',
      body: (body === undefined || body === null) ? null : body,
    }),
  }).then(function(resp) {
    if (resp.ok) return resp;
    return resp.json().then(function(j) {
      var msg = (j && j.error && j.error.message) ? j.error.message
              : (j && j.error) ? String(j.error)
              : ('HTTP ' + resp.status);
      throw new Error(msg);
    }).catch(function(e) {
      if (e instanceof Error) throw e;
      throw new Error('HTTP ' + resp.status);
    });
  });
}

function pgComfyUuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  var s = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  return s.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    var v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function pgComfyDeepCopy(o) { return JSON.parse(JSON.stringify(o)); }

function pgComfyBufToDataUrl(buf, mime) {
  var bytes = new Uint8Array(buf);
  var bin = '';
  var chunk = 0x8000;
  for (var i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return 'data:' + (mime || 'image/png') + ';base64,' + btoa(bin);
}

// ----- Connection: probe ComfyUI and cache models/templates ----------------
function pgComfyConnect() {
  var w = pgWin();
  if (!w) return;
  var cfg = w.config;
  var port = parseInt(cfg.imgComfyPort, 10);
  if (!port || port < 1 || port > 65535) { pgToast(pgT('pgComfyPortInvalid'), 'warning'); return; }
  if (w.streaming) return;

  pgState.comfy = {
    connected: false, connecting: true, error: '',
    version: '', models: {}, samplers: [], schedulers: [], templates: [],
  };
  pgRenderSidebar();

  var calls = [
    { p: '/system_stats', key: 'stats' },
    { p: '/models/diffusion_models', key: 'diffusion_models' },
    { p: '/models/text_encoders', key: 'text_encoders' },
    { p: '/models/vae', key: 'vae' },
    { p: '/models/checkpoints', key: 'checkpoints' },
    { p: '/object_info/KSampler', key: 'sampler' },
    { p: '/history', key: 'history' },
  ];
  var results = {};
  var chain = Promise.resolve();
  calls.forEach(function(c) {
    chain = chain.then(function() {
      return pgComfyCall(cfg, 'GET', c.p)
        .then(function(resp) { return resp.json(); })
        .then(function(j) { results[c.key] = j; })
        .catch(function(err) { results[c.key] = { __error: err.message }; });
    });
  });

  chain.then(function() {
    var st = results.stats;
    if (!st || !st.system) {
      pgState.comfy.connecting = false;
      pgState.comfy.connected = false;
      pgState.comfy.error = pgT('pgComfyConnectFailed',
        [(results.stats && results.stats.__error) || 'no response']);
      pgRenderSidebar();
      pgToast(pgState.comfy.error, 'error');
      return;
    }

    var models = {};
    ['diffusion_models', 'text_encoders', 'vae', 'checkpoints'].forEach(function(k) {
      var v = results[k];
      models[k] = (Array.isArray(v) ? v : [])
        .map(function(x) { return typeof x === 'string' ? x : (x && x.name) || ''; })
        .filter(Boolean);
    });

    var samplers = [], schedulers = [];
    var si = results.sampler && results.sampler.KSampler;
    if (si && si.input && si.input.required) {
      var rq = si.input.required;
      if (rq.sampler_name && rq.sampler_name[0]) samplers = rq.sampler_name[0].slice();
      if (rq.scheduler && rq.scheduler[0]) schedulers = rq.scheduler[0].slice();
    }

    // Workflow templates = recently executed successful prompts from /history.
    var templates = [];
    var hist = results.history;
    if (hist && typeof hist === 'object') {
      Object.keys(hist).forEach(function(pid) {
        var h = hist[pid];
        if (!h || !h.prompt || !h.prompt[2]) return;
        if (h.status && h.status.status_str !== 'success') return;
        templates.push({ prompt_id: pid, workflow: h.prompt[2], title: pgComfyTemplateTitle(h.prompt[2], pid) });
      });
    }

    pgState.comfy = {
      connected: true, connecting: false, error: '',
      version: st.system.comfyui_version || '',
      models: models, samplers: samplers, schedulers: schedulers, templates: templates,
    };
    cfg.imgComfyConnected = true;

    // Auto-select the first template when nothing usable is selected yet.
    if (!cfg.imgComfyWorkflow) {
      if (templates.length > 0) {
        cfg.imgComfyTemplateId = templates[0].prompt_id;
        cfg.imgComfyWorkflow = pgComfyDeepCopy(templates[0].workflow);
      } else {
        cfg.imgComfyTemplateId = '';
        cfg.imgComfyWorkflow = null;
      }
    }
    pgSave();
    pgRenderSidebar();
    var modelCount = Object.keys(models).reduce(function(n, k) { return n + models[k].length; }, 0);
    pgToast(pgT('pgComfyConnectedInfo', [pgState.comfy.version, modelCount, templates.length]), 'success');
  });
}

function pgComfyTemplateTitle(wf, pid) {
  var prefix = '';
  var firstText = '';
  for (var id in wf) {
    var n = wf[id];
    if (!n || !n.class_type || !n.inputs) continue;
    if (n.class_type === 'SaveImage' && n.inputs.filename_prefix) prefix = n.inputs.filename_prefix;
    if (!firstText && n.class_type === 'CLIPTextEncode' && typeof n.inputs.text === 'string' && n.inputs.text) {
      firstText = n.inputs.text.replace(/\s+/g, ' ').slice(0, 60);
    }
  }
  var base = prefix || firstText || ('workflow ' + pid.slice(0, 8));
  return base + ' [' + pid.slice(0, 8) + ']';
}

// ----- Sidebar panel --------------------------------------------------------
function pgRenderComfyPanel(cfg) {
  var s = pgState.comfy || {};
  var html = '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgComfyProtocol')) + '</div>';
  html += '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('pgComfyPort')) + '</label>' +
    '<input type="number" min="1" max="65535" value="' + pgEscapeAttr(cfg.imgComfyPort || '8188') + '" onchange="pgOnParam(\'imgComfyPort\', this.value)" style="flex:0 0 88px">' +
    '<button class="pg-btn" onclick="pgComfyConnect()"' + (s.connecting ? ' disabled' : '') + '>' +
    pgEscapeHtml(s.connecting ? pgT('pgComfyConnecting') : (s.connected ? pgT('pgComfyReconnect') : pgT('pgComfyConnect'))) +
    '</button></div>';
  if (s.connecting) html += '<div class="pg-comfy-hint">' + pgEscapeHtml(pgT('pgComfyConnecting')) + '</div>';
  if (s.error) html += '<div class="pg-comfy-error">' + pgEscapeHtml(s.error) + '</div>';
  if (s.connected) {
    var modelCount = Object.keys(s.models).reduce(function(n, k) { return n + s.models[k].length; }, 0);
    html += '<div class="pg-comfy-hint">' + pgEscapeHtml(pgT('pgComfyConnectedInfo', [s.version, modelCount, s.templates.length])) + '</div>';
  }
  html += '</div>';
  if (!s.connected) return html;

  // Template selector
  html += '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgComfyTemplate')) + '</div>';
  var tplOpts;
  if (s.templates.length) {
    tplOpts = s.templates.map(function(t) { return { value: t.prompt_id, label: t.title }; });
  } else {
    tplOpts = [{ value: '', label: pgT('pgComfyTemplateNone') }];
  }
  tplOpts.push({ value: '__paste__', label: pgT('pgComfyTemplatePaste') });
  var tSel = tplOpts.map(function(o) {
    return '<option value="' + pgEscapeAttr(o.value) + '"' + (cfg.imgComfyTemplateId === o.value ? ' selected' : '') + '>' + pgEscapeHtml(o.label) + '</option>';
  }).join('');
  html += '<select class="pg-param-select" onchange="pgComfySelectTemplate(this.value)" style="width:100%">' + tSel + '</select>';
  if (cfg.imgComfyTemplateId === '__paste__') {
    html += '<textarea class="pg-comfy-paste" placeholder="' + pgEscapeAttr(pgT('pgComfyPastePlaceholder')) + '" oninput="pgOnParam(\'imgComfyPasteJson\', this.value)" style="width:100%;height:110px;margin-top:6px">' + pgEscapeHtml(cfg.imgComfyPasteJson || '') + '</textarea>';
    html += '<button class="pg-btn" style="width:100%;margin-top:6px" onclick="pgComfyApplyPaste()">' + pgEscapeHtml(pgT('pgComfyApplyPaste')) + '</button>';
  }
  html += '</div>';

  // Dynamic workflow parameter panel
  if (cfg.imgComfyWorkflow) {
    html += pgRenderComfyWorkflowParams(cfg);
  } else {
    html += '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgComfyParams')) + '</div>' +
      '<div class="pg-comfy-hint">' + pgEscapeHtml(pgT('pgComfyNoWorkflow')) + '</div></div>';
  }
  return html;
}

function pgComfySelectTemplate(id) {
  var w = pgWin();
  if (!w) return;
  w.config.imgComfyTemplateId = id;
  w.config.imgComfyWorkflow = null;
  if (id && id !== '__paste__') {
    var s = pgState.comfy || {};
    for (var i = 0; i < s.templates.length; i++) {
      if (s.templates[i].prompt_id === id) {
        w.config.imgComfyWorkflow = pgComfyDeepCopy(s.templates[i].workflow);
        break;
      }
    }
  }
  pgSave();
  pgRenderSidebar();
}

function pgComfyApplyPaste() {
  var w = pgWin();
  if (!w) return;
  var raw = (w.config.imgComfyPasteJson || '').trim();
  if (!raw) return;
  var obj;
  try { obj = JSON.parse(raw); } catch (e) { pgToast(pgT('pgCustomJsonError', [e.message]), 'error'); return; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { pgToast(pgT('pgComfyPasteInvalid'), 'error'); return; }
  w.config.imgComfyWorkflow = obj;
  pgSave();
  pgRenderSidebar();
}

// ----- Dynamic parameter panel generation ---------------------------------
// Recognizes the built-in nodes commonly present in ComfyUI workflows and maps
// their inputs to selects/numbers/text inputs. Unknown nodes keep their values.
function pgRenderComfyWorkflowParams(cfg) {
  var wf = cfg.imgComfyWorkflow;
  var s = pgState.comfy || {};
  var html = '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgComfyParams')) + '</div>';
  var any = false;
  Object.keys(wf).forEach(function(nodeId) {
    var n = wf[nodeId];
    if (!n || !n.class_type || !n.inputs) return;
    var t = n.class_type;
    var title = (n._meta && n._meta.title) ? String(n._meta.title) : '';
    if (t === 'UNETLoader' || t === 'DiffusionModelLoader') {
      html += pgComfyGroupLabel(nodeId, title);
      html += pgComfySelectRow(nodeId, 'unet_name', n.inputs.unet_name, pgComfyOpts(s.models.diffusion_models), pgT('pgComfyModel'));
      any = true;
    } else if (t === 'CLIPLoader') {
      html += pgComfyGroupLabel(nodeId, title);
      html += pgComfySelectRow(nodeId, 'clip_name', n.inputs.clip_name, pgComfyOpts(s.models.text_encoders), 'CLIP');
      any = true;
    } else if (t === 'VAELoader') {
      html += pgComfyGroupLabel(nodeId, title);
      html += pgComfySelectRow(nodeId, 'vae_name', n.inputs.vae_name, pgComfyOpts(s.models.vae), 'VAE');
      any = true;
    } else if (t === 'CheckpointLoaderSimple') {
      html += pgComfyGroupLabel(nodeId, title);
      html += pgComfySelectRow(nodeId, 'ckpt_name', n.inputs.ckpt_name, pgComfyOpts(s.models.checkpoints), pgT('pgComfyModel'));
      any = true;
    } else if (t === 'KSampler' || t === 'KSamplerAdvanced') {
      html += pgComfyGroupLabel(nodeId, title);
      html += pgComfyNumberRow(nodeId, 'seed', n.inputs.seed, 1, 1e15, 1);
      html += pgComfyNumberRow(nodeId, 'steps', n.inputs.steps, 1, 200, 1);
      html += pgComfyNumberRow(nodeId, 'cfg', n.inputs.cfg, 0, 100, 0.5);
      html += pgComfyNumberRow(nodeId, 'denoise', n.inputs.denoise, 0, 1, 0.05);
      html += pgComfySelectRow(nodeId, 'sampler_name', n.inputs.sampler_name, pgComfyOpts(s.samplers), pgT('pgComfySampler'));
      html += pgComfySelectRow(nodeId, 'scheduler', n.inputs.scheduler, pgComfyOpts(s.schedulers), pgT('pgComfyScheduler'));
      any = true;
    } else if (t === 'EmptyLatentImage') {
      html += pgComfyGroupLabel(nodeId, title);
      html += pgComfyNumberRow(nodeId, 'width', n.inputs.width, 16, 4096, 16);
      html += pgComfyNumberRow(nodeId, 'height', n.inputs.height, 16, 4096, 16);
      html += pgComfyNumberRow(nodeId, 'batch_size', n.inputs.batch_size, 1, 64, 1);
      any = true;
    } else if (t === 'CLIPTextEncode') {
      html += pgComfyGroupLabel(nodeId, title);
      html += pgComfyTextRow(nodeId, 'text', n.inputs.text, title || pgT('pgComfyPrompt'));
      any = true;
    } else if (t === 'SaveImage') {
      html += pgComfyGroupLabel(nodeId, title);
      html += pgComfyTextRow(nodeId, 'filename_prefix', n.inputs.filename_prefix, pgT('pgComfyPrefix'));
      any = true;
    }
  });
  if (!any) html += '<div class="pg-comfy-hint">' + pgEscapeHtml(pgT('pgComfyNoKnownNodes')) + '</div>';
  html += '</div>';
  return html;
}

function pgComfyOpts(arr) {
  return (arr || []).map(function(v) { return { value: v, label: v }; });
}

function pgComfyGroupLabel(nodeId, title) {
  if (!title) return '';
  return '<div class="pg-comfy-group">' + pgEscapeHtml(title) + ' <span class="pg-comfy-nodeid">#' + pgEscapeHtml(nodeId) + '</span></div>';
}

function pgComfySelectRow(nodeId, field, val, opts, label) {
  var arr = [{ value: '', label: pgT('pgComfySelectDefault') }].concat(opts || []);
  var o = arr.map(function(opt) {
    return '<option value="' + pgEscapeAttr(opt.value) + '"' + (String(val) === String(opt.value) ? ' selected' : '') + '>' + pgEscapeHtml(opt.label) + '</option>';
  }).join('');
  return '<div class="pg-param-row"><label>' + pgEscapeHtml(label || field) + '</label>' +
    '<select onchange="pgComfySetParam(\'' + pgEscapeAttr(nodeId) + '\',\'' + pgEscapeAttr(field) + '\', this.value)" style="flex:1">' + o + '</select></div>';
}

function pgComfyNumberRow(nodeId, field, val, min, max, step) {
  var num = (typeof val === 'number' && isFinite(val)) ? val : 0;
  return '<div class="pg-param-row"><label>' + pgEscapeHtml(field) + '</label>' +
    '<input type="number" min="' + min + '" max="' + max + '" step="' + step + '" value="' + num + '"' +
    ' onchange="pgComfySetNum(\'' + pgEscapeAttr(nodeId) + '\',\'' + pgEscapeAttr(field) + '\', this.value)" style="flex:0 0 88px"></div>';
}

function pgComfyTextRow(nodeId, field, val, label) {
  return '<div class="pg-param-row"><label>' + pgEscapeHtml(label || field) + '</label>' +
    '<input type="text" value="' + pgEscapeAttr(String(val == null ? '' : val)) + '"' +
    ' oninput="pgComfySetParam(\'' + pgEscapeAttr(nodeId) + '\',\'' + pgEscapeAttr(field) + '\', this.value)" style="flex:1"></div>';
}

// ----- Dynamic param writers (wired from generated controls) ---------------
function pgComfySetParam(nodeId, field, v) {
  var w = pgWin();
  if (!w || !w.config.imgComfyWorkflow) return;
  if (!w.config.imgComfyWorkflow[nodeId]) return;
  w.config.imgComfyWorkflow[nodeId].inputs[field] = v;
  pgSave();
}

function pgComfySetNum(nodeId, field, v) {
  var num = parseFloat(v);
  if (isNaN(num)) num = 0;
  pgComfySetParam(nodeId, field, num);
}
function pgComfyPromptFromMessage(content) {
  if (typeof pgTextContent === 'function') return pgTextContent(content);
  return typeof content === 'string' ? content : '';
}

function pgComfyWorkflowForPrompt(workflow, prompt) {
  var run = pgComfyDeepCopy(workflow);
  if (!prompt) return run;
  var fallback = null;
  Object.keys(run).forEach(function(nodeId) {
    var node = run[nodeId];
    if (!node || node.class_type !== 'CLIPTextEncode' || !node.inputs || typeof node.inputs.text !== 'string') return;
    var title = node._meta && node._meta.title ? String(node._meta.title).toLowerCase() : '';
    if (title.indexOf('negative') >= 0 || title.indexOf('负') >= 0) return;
    if (!fallback) fallback = node;
    if (title.indexOf('positive') >= 0 || title.indexOf('正') >= 0 || title.indexOf('prompt') >= 0 || title.indexOf('提示') >= 0) fallback = node;
  });
  if (fallback) fallback.inputs.text = prompt;
  return run;
}

function pgSendComfyImage(i, assistantIdx) {
  var w = pgWinAt(i);
  var cfg = w.config;
  var workflow = cfg.imgComfyWorkflow;
  if (!workflow) { pgFail(i, assistantIdx, pgT('pgComfyNoWorkflow')); return; }
  var userPrompt = w.messages[assistantIdx - 1] ? pgComfyPromptFromMessage(w.messages[assistantIdx - 1].content) : '';
  var runWorkflow = pgComfyWorkflowForPrompt(workflow, userPrompt);
  var clientId = pgComfyUuid();

  w.streaming = true;
  w.abortCtrl = new AbortController();
  w.sseEvents = [];
  w.lastProvider = 'comfyui';
  w.lastKey = '';
  w.pendingContent = '';
  w.debugRequest = JSON.stringify({ prompt: runWorkflow, client_id: clientId }, null, 2);
  w.debugResponse = '';
  w.debugTimestamp = new Date().toISOString();
  pgUpdateInputBar();

  var msg = w.messages[assistantIdx];
  msg.startedAt = msg.startedAt || Date.now();
  msg.status = 'streaming';

  // HTTP polling avoids browser Origin restrictions on ComfyUI's WebSocket.
  // All calls stay same-origin through /api/comfyui/proxy.
  var cleanup = function() {};
  pgComfyCall(cfg, 'POST', '/prompt', { prompt: runWorkflow, client_id: clientId })
    .then(function(resp) { return resp.json(); })
    .then(function(j) {
      if (j.error) throw new Error(pgT('pgComfyPromptError', [JSON.stringify(j.error).slice(0, 300)]));
      var pid = j.prompt_id;
      if (!pid) throw new Error(pgT('pgComfyNoPromptId'));
      w.sseEvents.push('prompt_id: ' + pid);
      return pgComfyWaitHistory(cfg, pid, 300000, w.abortCtrl.signal).then(function() { return pid; });
    })
    .then(function(pid) {
      return pgComfyCall(cfg, 'GET', '/history/' + pid)
        .then(function(resp) { return resp.json(); })
        .then(function(h) {
          var hist = h[pid];
          if (!hist) throw new Error(pgT('pgComfyNoHistory', [pid]));
          var imgs = [];
          Object.keys(hist.outputs || {}).forEach(function(nid) {
            (hist.outputs[nid].images || []).forEach(function(img) {
              imgs.push({ nodeId: nid, img: img });
            });
          });
          if (!imgs.length) throw new Error(pgT('pgComfyNoImages'));
          w.sseEvents.push(JSON.stringify(hist, null, 2));
          var dl = imgs.map(function(it) {
            var qs = new URLSearchParams();
            qs.set('filename', it.img.filename);
            qs.set('subfolder', it.img.subfolder || '');
            qs.set('type', it.img.type || 'output');
            return pgComfyCall(cfg, 'GET', '/view', null, qs.toString())
              .then(function(resp) {
                return resp.arrayBuffer().then(function(buf) {
                  var ct = resp.headers.get('Content-Type') || 'image/png';
                  return { url: pgComfyBufToDataUrl(buf, ct), nodeId: it.nodeId };
                });
              });
          });
          return Promise.all(dl);
        });
    })
    .then(function(urls) {
      cleanup();
      msg.completedAt = Date.now();
      msg.durationMs = msg.completedAt - msg.startedAt;
      msg.status = 'complete';
      msg.content = urls.map(function(u) { return { type: 'image_url', image_url: { url: u.url } }; });
      urls.forEach(function(u) { pgAutoSaveImageArtifact(u.url, { url: u.url }); });
      w.debugResponse = 'downloaded ' + urls.length + ' image(s) from ComfyUI';
      w.streaming = false;
      w.abortCtrl = null;
      pgRenderBubble(i, assistantIdx);
      pgRenderDebug();
      pgSave();
      pgUpdateInputBar();
    })
    .catch(function(err) {
      cleanup();
      var ec = (w.messages[assistantIdx] && w.messages[assistantIdx].errorCode) || null;
      pgFail(i, assistantIdx, err && err.message ? err.message : String(err), ec);
    });
}
function pgComfyWaitHistory(cfg, pid, timeoutMs, signal) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var started = Date.now();
    var timer = null;
    function finish(err, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    }
    function poll() {
      if (signal && signal.aborted) { finish(new Error('Request aborted')); return; }
      if (Date.now() - started > timeoutMs) { finish(new Error(pgT('pgComfyTimeout'))); return; }
      pgComfyCall(cfg, 'GET', '/history/' + pid)
        .then(function(resp) { return resp.json(); })
        .then(function(all) {
          var h = all && all[pid];
          if (!h) { timer = setTimeout(poll, 500); return; }
          var status = h.status || {};
          var statusText = String(status.status_str || '').toLowerCase();
          if (statusText === 'error' || statusText === 'failed') {
            finish(new Error(pgT('pgComfyExecError', [JSON.stringify(status).slice(0, 300)])));
            return;
          }
          if (status.completed || statusText === 'success' || Object.keys(h.outputs || {}).length > 0) {
            finish(null, h);
            return;
          }
          timer = setTimeout(poll, 500);
        })
        .catch(function(err) { finish(err); });
    }
    poll();
  });
}
