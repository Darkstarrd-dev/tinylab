// pg-image-model.js — Manual Canvas state, protocol adapters, and actions.
(function () {
  'use strict';

  function uid(prefix) { return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }
  function imageState(w) {
    if (!w.image) w.image = { mode: 'manual', phase: 'empty', draftPrompt: '', submittedPrompt: '', activeAssetIndex: -1, generations: [], activeRequestId: '', error: '', abortCtrl: null, timer: null };
    return w.image;
  }
  window.pgImageState = imageState;

  function detectBase64ImagePrefix(b64, itemMime) {
    if (!b64) return 'data:image/png;base64,';
    if (b64.indexOf('data:') === 0) return '';
    var mime = itemMime || '';
    if (!mime) {
      if (b64.indexOf('UklGR') === 0) mime = 'image/webp';
      else if (b64.indexOf('/9j/') === 0) mime = 'image/jpeg';
      else if (b64.indexOf('iVBOR') === 0) mime = 'image/png';
      else if (b64.indexOf('R0lGO') === 0) mime = 'image/gif';
      else if (b64.indexOf('Qk') === 0) mime = 'image/bmp';
      else mime = 'image/png';
    }
    return 'data:' + mime + ';base64,';
  }

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
      var b64 = item.b64_json || item.base64 || '';
      var b64Prefix = b64 ? detectBase64ImagePrefix(b64, item.mime || item.content_type) : '';
      var url = imageURL || (b64 ? (b64.indexOf('data:') === 0 ? b64 : b64Prefix + b64) : '');
      if (!url) return;
      if (item.revised_prompt) revised = item.revised_prompt;
      assets.push({ id: uid('asset'), url: url, savedPath: item.savedPath || '', savedFilename: item.savedFilename || '', mime: item.mime || (url.indexOf('data:image/') === 0 ? url.slice(5, url.indexOf(';')) : ''), width: item.width || 0, height: item.height || 0, bytes: item.bytes || 0, meta: item.meta || null });
    });
    return { assets: assets, revisedPrompt: revised || (payload && payload.revised_prompt) || '', provider: payload && payload.provider || protocol || '', key: payload && payload.key || '' };
  };

  function cfgParams(cfg) {
    var p = {};
    ['imgSize', 'imgQuality', 'imgBackground', 'imgModeration', 'imgAspectRatio', 'imgResolution', 'imgN', 'imgResponseFormat', 'imgOutputFormat', 'imgOutputCompression', 'imgUser', 'imgNegativePrompt', 'imgSteps', 'imgGuidance', 'imgSeed', 'snWatermark', 'snPromptExtend'].forEach(function (key) {
      if (cfg[key] !== '' && cfg[key] !== 0 && cfg[key] != null) p[key] = cfg[key];
    });
    return p;
  }
  function resolveImageEndpoint(cfg, snapshot) {
    if (snapshot && snapshot.endpoint) return snapshot.endpoint;
    var hasImages = cfg && cfg.imageEnabled && Array.isArray(cfg.imageUrls) && cfg.imageUrls.some(function (u) { return u && u.trim(); });
    return hasImages ? 'edits' : 'generations';
  }

  function imageBody(w, prompt, snapshot) {
    var cfg = w.config || {}, model = snapshot && snapshot.model || cfg.model;
    var proto = snapshot && snapshot.protocol || (typeof pgGetImgProtocol === 'function' ? pgGetImgProtocol(model) : 'gpt');
    var savedParams = snapshot && snapshot.params, params = savedParams || cfgParams(cfg);
    var endpoint = resolveImageEndpoint(cfg, snapshot);
    if (!savedParams && typeof pgBuildImageBody === 'function') {
      var old = w.messages;
      w.messages = [{ role: 'user', content: prompt }];
      try {
        var built = pgBuildImageBody(w === pgWin() ? pgState.activeWin : pgState.windows.indexOf(w));
        w.messages = old;
        return { body: built || { model: model, prompt: prompt }, protocol: proto, params: params, endpoint: endpoint };
      } catch (e) { w.messages = old; }
    }
    var body = { model: model, prompt: prompt };
    var mappedKeys = { imgSize: 'size', imgQuality: 'quality', imgBackground: 'background', imgModeration: 'moderation', imgN: 'n', imgResponseFormat: 'response_format', imgOutputFormat: 'output_format', imgOutputCompression: 'output_compression', imgUser: 'user', imgAspectRatio: 'aspect_ratio', imgResolution: 'resolution', imgNegativePrompt: 'negative_prompt', imgSteps: 'steps', imgGuidance: 'guidance', imgSeed: 'seed' };
    Object.keys(params).forEach(function (key) { if (mappedKeys[key]) body[mappedKeys[key]] = params[key]; });
    if (params.snWatermark === 'false') body.watermark = false;
    if (params.snPromptExtend === 'false') body.prompt_extend = false;
    return { body: body, protocol: proto, params: params, endpoint: endpoint };
  }

  function comfyResult(w, prompt, signal, snapshot, seedOverride) {
    var cfg = Object.assign({}, w.config || {}), params = snapshot && snapshot.params || {};
    if (params.port != null) cfg.imgComfyPort = params.port;
    if (params.workflow) cfg.imgComfyWorkflow = params.workflow;
    var workflow = cfg.imgComfyWorkflow;
    if (!workflow || typeof pgComfyCall !== 'function' || typeof pgComfyWaitHistory !== 'function') return Promise.reject(new Error(pgT('pgComfyNoWorkflow')));
    var runWorkflow = typeof pgComfyWorkflowForPrompt === 'function' ? pgComfyWorkflowForPrompt(workflow, prompt, seedOverride) : workflow;
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

  // ModelScope image generation is asynchronous end-to-end: the submit call
  // returns task_id immediately and image URLs only appear after polling
  // /v1/tasks/{taskId}. Mirrors the pre-canvas pgPollModelScopeTask contract
  // (GET + X-ModelScope-Task-Type header; task_status / output_images fields)
  // and additionally tolerates DashScope-style wrappers (status/task_status
  // nested under output; results/output_images in either place). The poll
  // response's status decides the outcome: success -> finish with the images,
  // failure -> surface the error, anything else -> keep the generating timer.
  var MODELSCOPE_POLL_MS = 2000;
  var MODELSCOPE_RETRY_MS = 3000;
  var MODELSCOPE_MAX_POLLS = 60; // ~2 min at 2s interval (matches old flow)
  var MODELSCOPE_ATTEMPT_TIMEOUT_MS = 10000; // per-attempt cap so a hung GET cannot freeze the timer forever
  function modelscopeTaskStatus(j) {
    if (!j) return '';
    return String(j.task_status || j.status || (j.output && (j.output.task_status || j.output.status)) || (j.data && j.data[0] && j.data[0].task_status) || '').toUpperCase();
  }
  function modelscopeStatusDecision(st) {
    if (/SUCCEED|SUCCESS|COMPLETE|DONE/.test(st)) return 'done';
    if (/FAIL|ERROR|CANCEL/.test(st)) return 'failed';
    return 'pending';
  }
  function modelscopeStatusMessage(j) {
    if (!j) return '';
    var e = j.error;
    var msg = j.message || j.msg || (typeof e === 'string' ? e : e && (e.message || e.code)) || (j.output && (j.output.message || j.output.msg)) || '';
    return typeof msg === 'string' ? msg : '';
  }
  function modelscopeResultUrls(j) {
    if (!j) return [];
    var urls = [], lists = [];
    if (Array.isArray(j.output_images)) lists.push(j.output_images);
    if (Array.isArray(j.data)) lists.push(j.data);
    if (Array.isArray(j.results)) lists.push(j.results);
    if (j.output && Array.isArray(j.output.output_images)) lists.push(j.output.output_images);
    if (j.output && Array.isArray(j.output.results)) lists.push(j.output.results);
    if (j.output && Array.isArray(j.output.images)) lists.push(j.output.images);
    for (var li = 0; li < lists.length; li++) {
      var list = lists[li];
      for (var di = 0; di < list.length; di++) {
        var item = list[di];
        if (typeof item === 'string') { if (item) urls.push(item); continue; }
        if (!item) continue;
        var u = item.url || item.image_url || item.oss_url;
        if (u && typeof u === 'object') u = u.url || u.href || '';
        if (u) { urls.push(u); continue; }
        if (item.b64_json) urls.push('data:image/png;base64,' + item.b64_json);
        else if (item.base64) urls.push('data:image/png;base64,' + item.base64);
      }
    }
    if (!urls.length && j.image_url) urls.push(j.image_url);
    if (!urls.length && j.output && j.output.image_url) urls.push(j.output.image_url);
    return urls;
  }
  // modelscopeCanonical re-shapes any known ModelScope result payload into the
  // {data:[{url}]} form the canvas normalize path understands; null when no
  // usable image was found.
  function modelscopeCanonical(j) {
    var urls = modelscopeResultUrls(j);
    if (!urls.length) return null;
    var revised = (Array.isArray(j.data) && j.data[0] && j.data[0].revised_prompt) || j.revised_prompt || '';
    var out = { data: [], revised_prompt: revised, provider: j.provider || '', key: j.key || '' };
    for (var ui = 0; ui < urls.length; ui++) out.data.push({ url: urls[ui] });
    return out;
  }
  function modelscopePoll(taskId, model, signal) {
    var pollUrl = '/v1/tasks/' + encodeURIComponent(taskId) + '?model=' + encodeURIComponent(model);
    var attempts = 0;
    function delayThen(ms, fn) {
      return new Promise(function (resolve) { setTimeout(function () { resolve(fn()); }, ms); });
    }
    function attempt() {
      attempts++;
      if (attempts > MODELSCOPE_MAX_POLLS) return Promise.reject(new Error(pgT('pgModelscopeTimeout')));
      return new Promise(function (resolve, reject) {
        var t = setTimeout(function () { resolve(delayThen(MODELSCOPE_RETRY_MS, attempt)); }, MODELSCOPE_ATTEMPT_TIMEOUT_MS);
        fetch(pollUrl, {
          method: 'GET',
          headers: { 'X-ModelScope-Task-Type': 'image_generation', 'X-TinyRouter-Source': 'playground' },
          signal: signal,
        }).then(function (resp) {
          return resp.json();
        }).then(function (j) {
          clearTimeout(t);
          var decision = modelscopeStatusDecision(modelscopeTaskStatus(j));
          if (decision === 'done') { resolve(modelscopeCanonical(j) || j); return; }
          if (decision === 'failed') {
            var failErr = new Error(pgT('pgModelscopeTaskFailed', [modelscopeStatusMessage(j) || modelscopeTaskStatus(j)]));
            failErr.terminal = true;
            reject(failErr);
            return;
          }
          resolve(delayThen(MODELSCOPE_POLL_MS, attempt));
        }, function (err) {
          clearTimeout(t);
          if (err && err.name === 'AbortError') { reject(err); return; }
          resolve(delayThen(MODELSCOPE_RETRY_MS, attempt));
        });
      });
    }
    return attempt();
  }

  // imageSeedBase returns the base seed for a sequential multi-image
  // submission (ModelScope body seed / ComfyUI sampler seed). With a user-set
  // base seed (imgSeed > 0) it is used as-is, mirroring the Batch seedMode
  // "increment" convention; without one a random base is drawn once per
  // submission so the N images still differ. The base is drawn a single time
  // per submission — per-image seeds are base + index (0-based), so the first
  // image of a user-seeded run keeps exactly the base seed.
  function imageSeedBase(params) {
    return (params && params.imgSeed > 0) ? params.imgSeed : (Math.floor(Math.random() * 2147483646) + 1);
  }

  // finalizeImageAssets attaches the per-asset metadata (non-ComfyUI) and
  // autosaves the assets; shared by the success tail and the partial-success
  // catch path so both behave like the existing single-request lifecycle.
  function finalizeImageAssets(assets, generation, isComfy) {
    if (!isComfy) {
      assets.forEach(function (asset) {
        asset.meta = {
          prompt: generation.prompt,
          model: generation.model,
          protocol: generation.protocol,
          params: generation.params,
          revised_prompt: generation.revisedPrompt,
          created_at: generation.createdAt,
          duration_ms: generation.durationMs,
          provider: generation.provider,
          generator: 'TinyRouter Playground'
        };
      });
    }
    assets.forEach(function (asset) { if (typeof pgAutoSaveImageArtifact === 'function') pgAutoSaveImageArtifact(asset.url, asset, generation.id, asset.id); });
  }
  window.finalizeImageAssets = finalizeImageAssets;

  // remoteSubmit performs one remote image request (the pre-existing single
  // path): POST /v1/images/{generations|edits}, then for ModelScope an async
  // submit is polled via /v1/tasks/{id} until the images are ready. Resolves
  // with the canonical payload the normalize path understands.
  function remoteSubmit(body, signal, req, generation) {
    var reqHeaders = { 'Content-Type': 'application/json', 'X-TinyRouter-Source': 'playground' };
    // ModelScope submits image tasks asynchronously; the header tells the
    // upstream to return task_id immediately instead of blocking for the
    // whole generation (the old pgSendImage flow did the same).
    if (req.protocol === 'modelscope') reqHeaders['X-Modelscope-Async-Mode'] = 'true';
    return fetch(req.endpoint === 'edits' ? '/v1/images/edits' : '/v1/images/generations', { method: 'POST', headers: reqHeaders, body: JSON.stringify(body), signal: signal })
      .then(function (resp) { return resp.json().then(function (json) { if (!resp.ok || (json && json.error)) throw new Error((json && json.error && (json.error.message || json.error)) || 'HTTP ' + resp.status); return json; }); })
      .then(function (json) {
        // ModelScope async: a 2xx submit response carries only a task id —
        // poll /v1/tasks/{id} until the poll status says done (or failed)
        // and return the completed payload so the normalize path shows the
        // images; a submit that already carries results is used directly.
        if (req.protocol === 'modelscope' && json) {
          var taskId = json.task_id || (json.output && json.output.task_id) || (json.result && json.result.task_id) || json.request_id || (json.data && json.data[0] && json.data[0].task_id) || '';
          var canon = modelscopeCanonical(json);
          if (taskId && !canon) return modelscopePoll(taskId, generation.model, signal);
          if (canon) return canon;
        }
        return json;
      });
  }

  window.pgImageBuildRequest = function (w, prompt, snapshot) {
    if (!w || !prompt) throw new Error(pgT('pgSelectModel'));
    var cfg = w.config || {}, protocol = snapshot && snapshot.protocol || (typeof pgEffectiveProtocol === 'function' ? pgEffectiveProtocol(cfg) : '');
    var isComfy = protocol === 'comfyui';
    if (!isComfy && !cfg.model && !(snapshot && snapshot.model)) throw new Error(pgT('pgSelectModel'));
    var req = isComfy ? { body: null, protocol: 'comfyui', params: Object.assign({}, snapshot && snapshot.params || cfgParams(cfg), { port: snapshot && snapshot.params && snapshot.params.port || cfg.imgComfyPort, workflow: snapshot && snapshot.params && snapshot.params.workflow || cfg.imgComfyWorkflow }), endpoint: 'comfyui' } : imageBody(w, prompt, snapshot);
    var count = Math.max(1, Math.min(99, (snapshot && snapshot.params && snapshot.params.imgSubmitCount) || (typeof pgGetImageSubmitCount === 'function' ? pgGetImageSubmitCount() : 1)));
    req.params = Object.assign({}, req.params, { imgSubmitCount: count });
    return { req: req, count: count };
  };

  window.pgImagePlanUnits = function (req, count) {
    var seedBase = imageSeedBase(req.params);
    var isComfy = req.protocol === 'comfyui';
    if (count <= 1) {
      return [{ body: req.body, seed: null }];
    }
    var units = [];
    if (isComfy) {
      for (var k = 0; k < count; k++) {
        units.push({ body: null, seed: seedBase + k });
      }
    } else if (req.protocol === 'gpt' || req.protocol === 'xai') {
      var nCap = req.protocol === 'gpt' ? 5 : 10;
      var nRuns = Math.ceil(count / nCap);
      for (var k = 0; k < nRuns; k++) {
        var runBody = Object.assign({}, req.body);
        runBody.n = Math.min(nCap, count - k * nCap);
        units.push({ body: runBody, seed: null });
      }
    } else if (req.protocol === 'modelscope') {
      for (var k = 0; k < count; k++) {
        var runBody = Object.assign({}, req.body);
        delete runBody.n;
        runBody.seed = seedBase + k;
        units.push({ body: runBody, seed: null });
      }
    } else if (req.protocol === 'sensenova') {
      for (var k = 0; k < count; k++) {
        var runBody = Object.assign({}, req.body);
        delete runBody.n;
        units.push({ body: runBody, seed: null });
      }
    } else {
      for (var k = 0; k < count; k++) {
        units.push({ body: Object.assign({}, req.body), seed: null });
      }
    }
    return units;
  };

  window.pgImageExecUnit = function (w, prompt, req, unit, signal, generation) {
    var p;
    if (req.protocol === 'comfyui') {
      p = comfyResult(w, prompt, signal, generation, unit ? unit.seed : null);
    } else {
      p = remoteSubmit(unit ? unit.body : req.body, signal, req, generation);
    }
    return p.then(function (payload) {
      return window.pgImageNormalizeResult(payload, req.protocol);
    });
  };

  window.pgImageClear = function (i) {
    var w = pgWinAt(i), st = w && imageState(w);
    if (!st) return;
    if (typeof pgTaskWindowBusy === 'function' && pgTaskWindowBusy(i)) {
      if (typeof pgToast === 'function') pgToast(pgT('pgTaskQueueBusy'), 'warning');
      return;
    }
    st.phase = 'empty';
    st.error = '';
    st.generations = [];
    st.activeAssetIndex = -1;
    st.submittedPrompt = '';
    if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(i);
    if (typeof pgSave === 'function') pgSave();
  };

  window.pgImageDeleteAsset = function (i, gi, ai) {
    var src = typeof pgImageViewSource === 'function' ? pgImageViewSource(i) : null;
    var w = pgWinAt(i), st = w && imageState(w);
    var generation = (src && src.generations && src.generations[gi]) || (st && st.generations && st.generations[gi]);
    if (!generation || !generation.assets[ai]) return;
    var flatBefore = typeof pgImageFlatAssets === 'function' ? pgImageFlatAssets(src || st) : [], target = -1;
    flatBefore.forEach(function (entry, index) { if (entry.gi === gi && entry.ai === ai) target = index; });
    generation.assets.splice(ai, 1);
    if (!generation.assets.length) generation.status = 'canceled';
    var flatAfter = typeof pgImageFlatAssets === 'function' ? pgImageFlatAssets(src || st) : [];
    var newIdx = flatAfter.length ? Math.min(Math.max(0, target), flatAfter.length - 1) : -1;
    if (src) src.activeAssetIndex = newIdx;
    if (st) st.activeAssetIndex = newIdx;
    if (typeof pgImageRenderCanvas === 'function') pgImageRenderCanvas(i);
    if (typeof pgSave === 'function') pgSave();
  };

  window.pgImageRegenerate = function (i, gi) {
    var src = typeof pgImageViewSource === 'function' ? pgImageViewSource(i) : (pgWinAt(i) && imageState(pgWinAt(i)));
    var generation = src && src.generations && src.generations[gi];
    if (!generation) return;
    try {
      if (typeof pgTaskEnqueue === 'function') {
        pgTaskEnqueue(i, generation.prompt, generation);
      }
    } catch (e) {}
  };
})();
