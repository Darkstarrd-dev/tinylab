// pg-image-model.js — Manual Canvas state, protocol adapters, and actions.
(function () {
  'use strict';

  function uid(prefix) { return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }
  function imageState(w) {
    if (!w.image) w.image = { mode: 'manual', phase: 'empty', draftPrompt: '', submittedPrompt: '', activeAssetIndex: -1, generations: [], activeRequestId: '', error: '', abortCtrl: null, timer: null };
    return w.image;
  }
  window.pgImageState = imageState;

  window.pgImageNormalizeResult = function (payload, protocol) {
    var data = payload && Array.isArray(payload.data) ? payload.data : [];
    if (!data.length && payload && Array.isArray(payload.images)) data = payload.images;
    if (!data.length && payload && Array.isArray(payload.output_images)) data = payload.output_images;
    if (!data.length && payload && payload.output && Array.isArray(payload.output.images)) data = payload.output.images;
    if (!data.length && payload && payload.image_url) data = [{ image_url: payload.image_url }];
    var assets = [], revised = '';
    data.forEach(function (item) {
      if (typeof item === 'string') item = { url: item };
      item = item || {};
      var imageURL = item.url || item.image_url;
      if (imageURL && typeof imageURL === 'object') imageURL = imageURL.url || imageURL.href || '';
      var url = imageURL || (item.b64_json ? 'data:image/png;base64,' + item.b64_json : '') || (item.base64 ? 'data:image/png;base64,' + item.base64 : '');
      if (!url) return;
      if (item.revised_prompt) revised = item.revised_prompt;
      assets.push({ id: uid('asset'), url: url, savedPath: item.savedPath || '', savedFilename: item.savedFilename || '', mime: item.mime || (url.indexOf('data:image/') === 0 ? url.slice(5, url.indexOf(';')) : ''), width: item.width || 0, height: item.height || 0, bytes: item.bytes || 0, meta: item.meta || null });
    });
    return { assets: assets, revisedPrompt: revised || (payload && payload.revised_prompt) || '', provider: payload && payload.provider || protocol || '', key: payload && payload.key || '' };
  };

  function cfgParams(cfg) {
    var p = {};
    ['imgSize', 'imgQuality', 'imgBackground', 'imgModeration', 'imgAspectRatio', 'imgResolution', 'imgN', 'imgResponseFormat', 'imgOutputFormat', 'imgOutputCompression', 'imgUser', 'imgNegativePrompt', 'imgSteps', 'imgGuidance', 'imgSeed'].forEach(function (key) {
      if (cfg[key] !== '' && cfg[key] !== 0 && cfg[key] != null) p[key] = cfg[key];
    });
    return p;
  }
  function imageBody(w, prompt, snapshot) {
    var cfg = w.config || {}, model = snapshot && snapshot.model || cfg.model;
    var proto = snapshot && snapshot.protocol || (typeof pgGetImgProtocol === 'function' ? pgGetImgProtocol(model) : 'gpt');
    var savedParams = snapshot && snapshot.params, params = savedParams || cfgParams(cfg);
    if (!savedParams && typeof pgBuildImageBody === 'function') {
      var old = w.messages;
      w.messages = [{ role: 'user', content: prompt }];
      try {
        var built = pgBuildImageBody(w === pgWin() ? pgState.activeWin : pgState.windows.indexOf(w));
        w.messages = old;
        return { body: built || { model: model, prompt: prompt }, protocol: proto, params: params, endpoint: snapshot && snapshot.endpoint || (cfg.imgEndpoint === 'edits' ? 'edits' : 'generations') };
      } catch (e) { w.messages = old; }
    }
    var body = { model: model, prompt: prompt };
    var mappedKeys = { imgSize: 'size', imgQuality: 'quality', imgBackground: 'background', imgModeration: 'moderation', imgN: 'n', imgResponseFormat: 'response_format', imgOutputFormat: 'output_format', imgOutputCompression: 'output_compression', imgUser: 'user', imgAspectRatio: 'aspect_ratio', imgResolution: 'resolution', imgNegativePrompt: 'negative_prompt', imgSteps: 'steps', imgGuidance: 'guidance', imgSeed: 'seed' };
    Object.keys(params).forEach(function (key) { if (mappedKeys[key]) body[mappedKeys[key]] = params[key]; });
    return { body: body, protocol: proto, params: params, endpoint: snapshot && snapshot.endpoint || (cfg.imgEndpoint === 'edits' ? 'edits' : 'generations') };
  }

  function comfyResult(w, prompt, signal, snapshot) {
    var cfg = Object.assign({}, w.config || {}), params = snapshot && snapshot.params || {};
    if (params.port != null) cfg.imgComfyPort = params.port;
    if (params.workflow) cfg.imgComfyWorkflow = params.workflow;
    var workflow = cfg.imgComfyWorkflow;
    if (!workflow || typeof pgComfyCall !== 'function' || typeof pgComfyWaitHistory !== 'function') return Promise.reject(new Error(pgT('pgComfyNoWorkflow')));
    var runWorkflow = typeof pgComfyWorkflowForPrompt === 'function' ? pgComfyWorkflowForPrompt(workflow, prompt) : workflow;
    var clientID = typeof pgComfyUuid === 'function' ? pgComfyUuid() : uid('client');
    return pgComfyCall(cfg, 'POST', '/prompt', { prompt: runWorkflow, client_id: clientID }).then(function (resp) { return resp.json(); }).then(function (queued) {
      if (queued && queued.error) throw new Error(pgT('pgComfyPromptError', [JSON.stringify(queued.error).slice(0, 300)]));
      if (!queued || !queued.prompt_id) throw new Error(pgT('pgComfyNoPromptId'));
      return pgComfyWaitHistory(cfg, queued.prompt_id, 300000, signal).then(function (history) { return { id: queued.prompt_id, history: history, cfg: cfg }; });
    }).then(function (done) {
      var hist = done.history && done.history[done.id] || done.history || {}, images = [];
      Object.keys(hist.outputs || {}).forEach(function (nodeID) { (hist.outputs[nodeID].images || []).forEach(function (img) { images.push({ nodeID: nodeID, image: img }); }); });
      if (!images.length) throw new Error(pgT('pgComfyNoImages'));
      return Promise.all(images.map(function (entry) {
        var query = new URLSearchParams();
        query.set('filename', entry.image.filename); query.set('subfolder', entry.image.subfolder || ''); query.set('type', entry.image.type || 'output');
        return pgComfyCall(done.cfg, 'GET', '/view', null, query.toString()).then(function (resp) { return resp.arrayBuffer(); }).then(function (buf) {
          return { url: pgComfyBufToDataUrl(buf, 'image/png'), nodeID: entry.nodeID, meta: { promptID: done.id, nodeID: entry.nodeID, filename: entry.image.filename, subfolder: entry.image.subfolder || '', type: entry.image.type || 'output' } };
        });
      }));
    }).then(function (items) { return { data: items }; });
  }

  window.pgImageGenerate = function (i, prompt, snapshot) {
    var w = pgWinAt(i), st = w && imageState(w);
    if (!w || !prompt || (st && st.phase === 'generating')) return Promise.reject(new Error(pgT('pgSelectModel')));
    var cfg = w.config || {}, protocol = snapshot && snapshot.protocol || (typeof pgEffectiveProtocol === 'function' ? pgEffectiveProtocol(cfg) : '');
    var isComfy = protocol === 'comfyui';
    if (!isComfy && !cfg.model && !(snapshot && snapshot.model)) return Promise.reject(new Error(pgT('pgSelectModel')));
    var req = isComfy ? { body: null, protocol: 'comfyui', params: Object.assign({}, snapshot && snapshot.params || cfgParams(cfg), { port: snapshot && snapshot.params && snapshot.params.port || cfg.imgComfyPort, workflow: snapshot && snapshot.params && snapshot.params.workflow || cfg.imgComfyWorkflow }), endpoint: 'comfyui' } : imageBody(w, prompt, snapshot);
    var generation = { id: uid('generation'), status: 'generating', prompt: prompt, promptFormat: snapshot && snapshot.promptFormat || 'natural', promptObject: snapshot && snapshot.promptObject || null, revisedPrompt: '', createdAt: Date.now(), completedAt: null, durationMs: 0, model: snapshot && snapshot.model || cfg.model || 'comfyui', protocol: req.protocol, endpoint: req.endpoint, params: req.params, assets: [] };
    st.phase = 'generating'; st.error = ''; st.submittedPrompt = prompt; st.activeRequestId = generation.id; st.generations.push(generation); st.activeAssetIndex = -1; st.abortCtrl = new AbortController();
    if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(i);
    var started = generation.createdAt;
    var request = isComfy ? comfyResult(w, prompt, st.abortCtrl.signal, generation) : fetch(req.endpoint === 'edits' ? '/v1/images/edits' : '/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TinyRouter-Source': 'playground' }, body: JSON.stringify(req.body), signal: st.abortCtrl.signal }).then(function (resp) { return resp.json().then(function (json) { if (!resp.ok || (json && json.error)) throw new Error((json && json.error && (json.error.message || json.error)) || 'HTTP ' + resp.status); return json; }); });
    return request.then(function (payload) {
      if (st.activeRequestId !== generation.id) return generation;
      var norm = window.pgImageNormalizeResult(payload, req.protocol);
      generation.assets = norm.assets; generation.revisedPrompt = norm.revisedPrompt; generation.status = norm.assets.length ? 'ready' : 'error'; generation.completedAt = Date.now(); generation.durationMs = generation.completedAt - started; generation.provider = norm.provider; generation.key = norm.key;
      st.phase = generation.status; st.activeAssetIndex = generation.assets.length ? (st.generations.reduce(function (n, item) { return n + (item.assets ? item.assets.length : 0); }, 0) - generation.assets.length) : -1; st.activeRequestId = ''; st.abortCtrl = null; if (!norm.assets.length) st.error = pgT('pgImgNoResult');
      norm.assets.forEach(function (asset) { if (typeof pgAutoSaveImageArtifact === 'function') pgAutoSaveImageArtifact(asset.url, asset, generation.id, asset.id); });
      if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(i); if (typeof pgSave === 'function') pgSave(); return generation;
    }).catch(function (err) {
      if (st.activeRequestId !== generation.id) return generation;
      var canceled = (err && err.name === 'AbortError') || (st.abortCtrl && st.abortCtrl.signal.aborted);
      generation.status = canceled ? 'canceled' : 'error'; st.phase = generation.status; st.error = canceled ? '' : (err.message || String(err)); st.activeRequestId = ''; st.abortCtrl = null; generation.completedAt = Date.now(); generation.durationMs = generation.completedAt - started;
      if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(i); if (typeof pgSave === 'function') pgSave(); if (canceled) return generation; throw err;
    });
  };
  window.pgImageStop = function (i) { var w = pgWinAt(i), st = w && imageState(w); if (st && st.abortCtrl) st.abortCtrl.abort(); };
  window.pgImageClear = function (i) { var w = pgWinAt(i), st = w && imageState(w); if (!st || st.phase === 'generating') return; st.phase = 'empty'; st.error = ''; st.generations = []; st.activeAssetIndex = -1; st.submittedPrompt = ''; if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(i); if (typeof pgSave === 'function') pgSave(); };
  window.pgImageDeleteAsset = function (i, gi, ai) {
    var w = pgWinAt(i), st = w && imageState(w), generation = st && st.generations[gi];
    if (!generation || !generation.assets[ai]) return;
    var flatBefore = typeof pgImageFlatAssets === 'function' ? pgImageFlatAssets(st) : [], target = -1;
    flatBefore.forEach(function (entry, index) { if (entry.gi === gi && entry.ai === ai) target = index; });
    generation.assets.splice(ai, 1);
    if (!generation.assets.length) generation.status = 'canceled';
    var flatAfter = typeof pgImageFlatAssets === 'function' ? pgImageFlatAssets(st) : [];
    st.activeAssetIndex = flatAfter.length ? Math.min(Math.max(0, target), flatAfter.length - 1) : -1;
    if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(i); if (typeof pgSave === 'function') pgSave();
  };
  window.pgImageRegenerate = function (i, gi) { var w = pgWinAt(i), st = w && imageState(w), generation = st && st.generations[gi]; if (!generation || st.phase === 'generating') return; pgImageGenerate(i, generation.prompt, generation).catch(function () {}); };
})();
