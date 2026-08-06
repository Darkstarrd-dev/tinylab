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

function pgComfyRuntime(w) {
  w = w || (typeof pgWin === 'function' ? pgWin() : null);
  if (!w) return (typeof pgState !== 'undefined' && pgState.comfy) || {};
  if (!w.comfy) w.comfy = { connected: false, connecting: false, error: '', version: '', models: {}, samplers: [], schedulers: [], templates: [] };
  return w.comfy;
}

// ----- Connection: probe ComfyUI and cache models/templates ----------------
function pgComfyConnect() {
  var w = pgWin();
  if (!w) return;
  var cfg = w.config;
  var port = parseInt(cfg.imgComfyPort, 10);
  if (!port || port < 1 || port > 65535) { pgToast(pgT('pgComfyPortInvalid'), 'warning'); return; }
  if (w.streaming) return;

  w.comfy = {
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
    // Saved workflows in the ComfyUI user directory (user/default/workflows).
    { p: '/userdata', key: 'saved_workflows', query: 'dir=workflows&recurse=true&split=false&full_info=true' },
  ];
  var results = {};
  var activeTabPromise = fetch('/api/comfyui/active', {
    headers: { 'Accept': 'application/json' },
  }).then(function(resp) {
    if (!resp.ok) return null;
    return resp.json();
  }).catch(function() { return null; });

  var chain = Promise.resolve();
  calls.forEach(function(c) {
    chain = chain.then(function() {
      return pgComfyCall(cfg, 'GET', c.p, null, c.query)
        .then(function(resp) { return resp.json(); })
        .then(function(j) { results[c.key] = j; })
        .catch(function(err) { results[c.key] = { __error: err.message }; });
    });
  });

  chain.then(function() { return activeTabPromise; }).then(function(activeTab) {
    var st = results.stats;
    if (!st || !st.system) {
      w.comfy.connecting = false;
      w.comfy.connected = false;
      w.comfy.error = pgT('pgComfyConnectFailed',
        [(results.stats && results.stats.__error) || 'no response']);
      if (pgWin() === w) pgRenderSidebar();
      pgToast(w.comfy.error, 'error');
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

    // Tab Select candidates: saved workflows and history are merged by workflow
    // id/signature; this prevents one option per generated image.
    var histTemplates = [];
    var hist = results.history;
    if (hist && typeof hist === 'object') {
      Object.keys(hist).forEach(function(pid) {
        var h = hist[pid];
        if (!h || !h.prompt || !h.prompt[2]) return;
        if (h.status && h.status.status_str !== 'success') return;
        var graph = h.prompt[3] && h.prompt[3].extra_pnginfo && h.prompt[3].extra_pnginfo.workflow;
        histTemplates.push({
          prompt_id: 'history:' + pid,
          workflow: h.prompt[2],
          workflowId: graph && graph.id ? String(graph.id) : '',
          title: pgComfyTemplateTitle(h.prompt[2]),
          kind: 'tab', source: 'history-fallback',
          signature: pgComfyWorkflowSignature(h.prompt[2]),
        });
      });
    }

    function pgComfyFinalize(savedTabs) {
      // The Desktop bridge marks the currently open tab; keep it first so a
      // fresh connection selects the same workflow the user is viewing.
      var tabs = pgComfyDeduplicateTemplates(savedTabs.concat(histTemplates));
      w.comfy = {
        connected: true, connecting: false, error: '',
        version: st.system.comfyui_version || '',
        models: models, samplers: samplers, schedulers: schedulers, templates: tabs,
      };
      cfg.imgComfyConnected = true;

      var active = tabs.filter(function(t) { return t.active; })[0];
      var preferred = active || tabs[0];
      if (preferred && (active || !cfg.imgComfyWorkflow)) {
        cfg.imgComfyTemplateId = preferred.prompt_id;
        cfg.imgComfyWorkflow = pgComfyDeepCopy(preferred.workflow);
      } else if (!preferred && !cfg.imgComfyWorkflow) {
        cfg.imgComfyTemplateId = '';
        cfg.imgComfyWorkflow = null;
      }
      pgSave();
      if (pgWin() === w) pgRenderSidebar();
      var modelCount = Object.keys(models).reduce(function(n, k) { return n + models[k].length; }, 0);
      pgToast(pgT('pgComfyConnectedInfo', [w.comfy.version, modelCount, tabs.length]), 'success');
    }

    // Load saved workflows from the ComfyUI user directory and convert the
    // UI-format graphs to API-format prompts (subgraph nodes are expanded).
    var savedList = results.saved_workflows;
    var savedGraphs = [];
    var activePath = activeTab && activeTab.path ? String(activeTab.path).replace(/\\/g, '/') : '';
    var activeGraph = activeTab && activeTab.graph && typeof activeTab.graph === 'object' ? activeTab.graph : null;
    var loadChain = Promise.resolve();
    if (activePath && !activeGraph) {
      loadChain = loadChain.then(function() {
        return pgComfyCall(cfg, 'GET', '/userdata/workflows%2F' + encodeURIComponent(activePath))
          .then(function(resp) { return resp.json(); })
          .then(function(g) { activeGraph = g; })
          .catch(function(err) { console.warn('[pg-comfyui] active workflow load failed:', activePath, err.message); });
      });
    }
    if (Array.isArray(savedList)) {
      savedList.forEach(function(entry) {
        var path = entry && entry.path;
        if (!path || path.slice(-5) !== '.json') return;
        loadChain = loadChain.then(function() {
          return pgComfyCall(cfg, 'GET', '/userdata/workflows%2F' + encodeURIComponent(path))
            .then(function(resp) { return resp.json(); })
            .then(function(g) { savedGraphs.push({ path: path, modified: entry.modified || 0, graph: g }); })
            .catch(function(err) { console.warn('[pg-comfyui] load saved workflow failed:', path, err.message); });
        });
      });
    }
    loadChain
      .then(function() {
        if (activeGraph && activePath) {
          savedGraphs = savedGraphs.filter(function(item) { return item.path !== activePath; });
          savedGraphs.unshift({ path: activePath, modified: Date.now(), graph: activeGraph, active: true });
        }
        return pgComfySavedTemplates(cfg, savedGraphs);
      })
      .then(function(savedTemplates) { pgComfyFinalize(savedTemplates); })
      .catch(function(err) {
        console.warn('[pg-comfyui] saved workflow import failed:', err && err.message);
        pgComfyFinalize([]);
      });

  });
}
// Normalize API-format workflow data for same-workflow grouping. Runtime values
// such as seeds and filename prefixes may change on every execution; node
// numbers and prompt IDs must not make equivalent tabs separate options.
function pgComfyWorkflowSignature(workflow) {
  var nodes = workflow && typeof workflow === 'object' ? workflow : {};
  var ids = Object.keys(nodes).sort(function(a, b) { return Number(a) - Number(b) || a.localeCompare(b); });
  var remap = {}, next = 0;
  ids.forEach(function(id) { remap[id] = String(next++); });
  var dynamicInputs = {
    seed: true, noise_seed: true, random_seed: true, filename_prefix: true,
  };
  var normalized = ids.map(function(id) {
    var node = nodes[id] || {};
    var inputs = {};
    Object.keys(node.inputs || {}).sort().forEach(function(name) {
      if (dynamicInputs[name]) return;
      var value = node.inputs[name];
      if (Array.isArray(value) && value.length >= 2 && typeof value[0] !== 'object') {
        var sourceId = String(value[0]);
        value = [remap[sourceId] !== undefined ? remap[sourceId] : sourceId, value[1]];
      }
      inputs[name] = value;
    });
    return { class_type: node.class_type || '', inputs: inputs };
  });
  return JSON.stringify(normalized);
}

function pgComfyTemplateNameKey(item) {
  var title = String(item && item.title || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  if (!title || title === String(pgT('pgComfyTabUntitled')).toLocaleLowerCase()) return '';
  return title;
}

function pgComfyDeduplicateTemplates(templates) {
  var seenNames = {};
  var seenSignatures = {};
  var out = [];
  (templates || []).forEach(function(item) {
    var sig = item.signature || pgComfyWorkflowSignature(item.workflow);
    var nameKey = pgComfyTemplateNameKey(item);
    if ((nameKey && seenNames[nameKey]) || (!nameKey && sig && seenSignatures[sig])) return;
    item.signature = sig;
    if (nameKey) seenNames[nameKey] = true;
    if (sig) seenSignatures[sig] = true;
    out.push(item);
  });
  return out;
}
function pgComfyTemplateTitle(wf) {
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
  return prefix || firstText || pgT('pgComfyTabUntitled');
}
// Collect /object_info classes from a saved graph and nested subgraphs.
function pgComfyCollectClasses(graph, classes, seen) {
  var defs = (graph.definitions && Array.isArray(graph.definitions.subgraphs)) ? graph.definitions.subgraphs : [];
  var defById = {};
  defs.forEach(function(d) { defById[d.id] = d; });
  function walk(nodes) {
    (nodes || []).forEach(function(n) {
      if (!n || !n.type) return;
      var t = n.type;
      if (t === 'Note' || t === 'MarkdownNote' || t === 'Reroute') return;
      if (defById[t]) { walk(defById[t].nodes); return; }
      if (!seen[t]) { seen[t] = true; classes.push(t); }
    });
  }
  walk(graph.nodes);
}


// Loads /object_info schemas for saved graphs, converts UI graphs to API
// prompts, and returns one option per distinct workflow signature.
function pgComfySavedTemplates(cfg, graphs) {
  var classes = [];
  var seen = {};
  graphs.forEach(function(item) { pgComfyCollectClasses(item.graph, classes, seen); });
  var objInfo = {};
  var chain = Promise.resolve();
  classes.slice(0, 80).forEach(function(c) {
    chain = chain.then(function() {
      return pgComfyCall(cfg, 'GET', '/object_info/' + encodeURIComponent(c))
        .then(function(resp) { return resp.json(); })
        .then(function(j) {
          var nd = j && j[c];
          if (!nd || !nd.input) return;
          var names = [], cag = {};
          var req = nd.input.required || {}, opt = nd.input.optional || {};
          Object.keys(req).forEach(function(k) {
            names.push(k);
            if (req[k] && req[k][1] && req[k][1].control_after_generate) cag[k] = true;
          });
          Object.keys(opt).forEach(function(k) {
            names.push(k);
            if (opt[k] && opt[k][1] && opt[k][1].control_after_generate) cag[k] = true;
          });
          objInfo[c] = { names: names, cag: cag };
        })
        .catch(function() {});
    });
  });
  return chain.then(function() {
    var out = [];
    graphs.forEach(function(item) {
      try {
        var workflow = pgComfyGraphToPrompt(item.graph, objInfo);
        out.push({
          prompt_id: 'tab:' + item.path,
          workflowId: item.graph && item.graph.id ? String(item.graph.id) : '',
          title: item.active ? pgT('pgComfyCurrentTab') : item.path.replace(/\.json$/i, ''),
          modified: item.modified,
          workflow: workflow,
          kind: 'tab', source: item.active ? 'active' : 'saved', active: !!item.active,
          path: item.path,
          signature: pgComfyWorkflowSignature(workflow),
        });
      } catch (e) {
        console.warn('[pg-comfyui] workflow convert failed:', item.path, e && e.message);
      }
    });
    out.sort(function(a, b) { return (b.modified || 0) - (a.modified || 0); });
    return pgComfyDeduplicateTemplates(out);
  });
}

function pgComfyLinkMap(graph) {
  var m = {};
  (graph.links || []).forEach(function(l) {
    if (Array.isArray(l)) {
      m[l[0]] = { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] };
    } else if (l && l.id != null) {
      m[l.id] = l;
    }
  });
  return m;
}

function pgComfyGraphToPrompt(graph, objInfo) {
  var defs = (graph.definitions && Array.isArray(graph.definitions.subgraphs)) ? graph.definitions.subgraphs : [];
  var defById = {};
  defs.forEach(function(d) { defById[d.id] = d; });
  var idState = { next: 1000000 };
  return pgComfyConvertLevel(graph, { defById: defById, objInfo: objInfo || {} }, idState).prompt;
}

function pgComfyConvertLevel(graph, ctx, idState) {
  var links = pgComfyLinkMap(graph);
  var prompt = {};
  var idMap = {};
  var outMap = {};
  var pending = [];
  var rerouteIn = {};

  (graph.nodes || []).forEach(function(n) {
    if (n.type !== 'Reroute') return;
    var inLink = null;
    (n.inputs || []).forEach(function(i) { if (i.link != null) inLink = i.link; });
    if (inLink != null) {
      var l = links[inLink];
      if (l) rerouteIn[n.id] = { src: l.origin_id, slot: l.origin_slot };
    }
  });
  function resolveSrc(src, slot) {
    var s = src, guard = 0;
    while (rerouteIn[s] !== undefined && guard++ < 64) s = rerouteIn[s].src;
    return [s, slot];
  }

  (graph.nodes || []).forEach(function(n) {
    var t = n.type;
    if (!t || t === 'Note' || t === 'MarkdownNote' || t === 'Reroute') return;
    if (n.mode === 3 || n.mode === 4) return; // NEVER / BYPASS are not submitted
    var nodeId = String(idState.next++);
    idMap[n.id] = nodeId;

    if (ctx.defById[t]) {
      // Subgraph node: expand recursively, then rewire consumers via outMap.
      var outerInputs = {};
      var wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
      var ptr = 0;
      (n.inputs || []).forEach(function(inp) {
        if (inp.link == null && inp.widget) {
          if (ptr < wv.length) outerInputs[inp.name] = wv[ptr];
          ptr++;
        }
      });
      var def = ctx.defById[t];
      var sub = pgComfyConvertLevel(def, {
        links: pgComfyLinkMap(def),
        ports: def.inputs || [],
        outerInputs: outerInputs,
        defById: ctx.defById,
        objInfo: ctx.objInfo,
      }, idState);
      for (var k in sub.prompt) prompt[k] = sub.prompt[k];
      var outL = pgComfyLinkMap(def);
      (def.outputs || []).forEach(function(p, i) {
        var mapped = null;
        (p.linkIds || []).forEach(function(lid) {
          if (mapped) return;
          var l = outL[lid];
          if (l && l.target_id === -20 && l.origin_id !== -10) {
            var r = resolveSrc(l.origin_id, l.origin_slot);
            var inner = sub.idMap[r[0]];
            if (inner !== undefined) mapped = { id: inner, slot: r[1] };
          }
        });
        if (mapped) outMap[nodeId + ':' + i] = mapped;
      });
      return;
    }

    // Classic node.
    var schema = ctx.objInfo ? ctx.objInfo[t] : null;
    var inputs = {};
    var wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
    var ptr = 0;
    (n.inputs || []).forEach(function(inp) {
      var nm = inp.name;
      var inSchema = !schema || schema.names.indexOf(nm) >= 0;
      if (inp.link != null) {
        var l = links[inp.link];
        if (l) {
          if (l.origin_id === -10 && ctx.ports) {
            // Port of the enclosing subgraph: inject the outer node's value.
            var pname = ctx.ports[l.origin_slot] && ctx.ports[l.origin_slot].name;
            if (pname !== undefined && ctx.outerInputs && ctx.outerInputs[pname] !== undefined) inputs[nm] = ctx.outerInputs[pname];
          } else if (l.origin_id !== -10 && l.origin_id !== -20) {
            pending.push([nodeId, nm, l.origin_id, l.origin_slot]);
          }
        }
        // Link-connected widget inputs still occupy a widgets_values slot.
        if (inp.widget) { ptr++; if (schema && schema.cag[nm]) ptr++; }
      } else if (inp.widget) {
        if (inSchema && ptr < wv.length) inputs[nm] = wv[ptr];
        ptr++;
        if (schema && schema.cag[nm]) ptr++;
      }
    });
    prompt[nodeId] = { class_type: t, inputs: inputs };
    if (n.title) prompt[nodeId]._meta = { title: n.title };
  });

  pending.forEach(function(p) {
    var entry = prompt[p[0]];
    if (!entry) return;
    var r = resolveSrc(p[2], p[3]);
    var sub = outMap[idMap[r[0]] + ':' + r[1]];
    if (sub) entry.inputs[p[1]] = [sub.id, sub.slot];
    else if (idMap[r[0]] !== undefined) entry.inputs[p[1]] = [idMap[r[0]], r[1]];
  });
  return { prompt: prompt, idMap: idMap, outMap: outMap };
}

// ----- Sidebar panel --------------------------------------------------------
function pgRenderComfyPanel(cfg) {
  var s = pgComfyRuntime(pgWin());
  var html = '<div class="pg-panel"><div class="pg-panel-title"><span>' + pgEscapeHtml(pgT('pgComfyProtocol')) + '</span><button class="pg-btn pg-comfy-back" type="button" onclick="pgComfyBackToProtocol()" title="' + pgEscapeAttr(pgT('pgComfyBack')) + '">← ' + pgEscapeHtml(pgT('pgComfyBack')) + '</button></div>';
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
    var s = pgComfyRuntime(w);
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

function pgComfyBackToProtocol() {
  var w = pgWin();
  if (!w) return;
  w.comfy = { connected: false, connecting: false, error: '', version: '', models: {}, samplers: [], schedulers: [], templates: [] };
  w.config.imgProtocolFilter = 'all';
  w.config.model = '';
  w.config.imgComfyConnected = false;
  w.config.imgComfyTemplateId = '';
  w.config.imgComfyWorkflow = null;
  w.config.imgComfyPasteJson = '';
  pgSave();
  pgRenderSidebar();
  pgRenderPanes();
  pgUpdateInputBar();
}

// ----- Dynamic parameter panel generation ---------------------------------
// Recognizes the built-in nodes commonly present in ComfyUI workflows and maps
// their inputs to selects/numbers/text inputs. Unknown nodes keep their values.
function pgRenderComfyWorkflowParams(cfg) {
  var wf = cfg.imgComfyWorkflow;
  var s = pgComfyRuntime(pgWin());
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
