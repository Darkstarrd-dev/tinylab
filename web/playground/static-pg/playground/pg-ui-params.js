// pg-ui-params.js — image protocol / model helpers + param panel renderers (split from pg-ui.js)
// Provides: pgGetModelInfo, pgGetImgProtocol, pgGetTextProtocol, pgOnModelSelectBackfill,
// pgEffectiveProtocol, pgImageProtocols, pgRenderCustomSelect, pgStepParam,
// pgImgParamSelect, pgImgParamNumber, pgImgSizeOptionsFor, pgImgParamSelectWithEdit,
// pgImgListContains, pgRenderImageParams
function pgGetModelInfo(modelId) {
  var models = pgState.models || [];
  for (var i = 0; i < models.length; i++) {
    if (models[i].id === modelId) return models[i];
  }
  return null;
}

// pgGetImgProtocol returns the imgProtocol for a model (gpt/xai/modelscope),
// defaulting to 'gpt' when the model is not an image kind or has no protocol.
// Used by request construction (pg-stream.js).
function pgGetImgProtocol(modelId) {
  var info = pgGetModelInfo(modelId);
  return (info && info.kind === 'image' && info.imgProtocol) ? info.imgProtocol : 'gpt';
}

function pgGetTextProtocol(modelId) {
  var info = pgGetModelInfo(modelId);
  if (!info) return '';
  if (info.textProtocol) return info.textProtocol;
  if (Array.isArray(info.protocols) && info.protocols.indexOf('google') !== -1) return 'google';
  return '';
}
// pgOnModelSelectBackfill sets the protocol filter to match the selected
// pgOnModelSelectBackfill sets the protocol filter to match the selected
// model's imgProtocol so the protocol picker stays coherent with the model.
// Called from the image-mode model <select> onchange after pgOnModelChange.
function pgOnModelSelectBackfill(modelId) {
  var w = pgWin();
  if (!w) return;
  if (!modelId) { w.config.imgProtocolFilter = 'all'; return; }
  var info = pgGetModelInfo(modelId);
  if (info && info.kind === 'image') {
    w.config.imgProtocolFilter = info.imgProtocol || 'gpt';
  } else {
    w.config.imgProtocolFilter = 'all';
  }
}

// pgEffectiveProtocol returns the protocol that governs the current image-mode
// parameter panel.  It prefers an explicit protocol filter (imgProtocolFilter)
// when one is active, then falls back to the selected model's imgProtocol,
// and finally to null.  This helper drives UI visibility and is also passed
// to pgRenderImageParams to determine which protocol's params panel to render.
function pgEffectiveProtocol(cfg) {
  // Prefer the selected model's imgProtocol first, then explicit filter.
  if (cfg.model) {
    var m = pgGetModelInfo(cfg.model);
    if (m && m.kind === 'image') return m.imgProtocol || 'gpt';
  }
  if (cfg.imgProtocolFilter && cfg.imgProtocolFilter !== 'all') {
    return cfg.imgProtocolFilter;
  }
  return null;
}

function pgImageProtocols() {
  return ['all', 'gpt', 'xai', 'modelscope', 'sensenova', 'comfyui'];
}

function pgRenderCustomSelect(wrapperId, selectId, options, selectedValue, onChangeCode, extraStyle) {
  if (typeof renderCustomSelectHtml === 'function') {
    return renderCustomSelectHtml(wrapperId, selectId, options, selectedValue, onChangeCode, extraStyle || 'flex:1;min-width:0');
  }
  var opts = options.map(function(o) {
    var val = typeof o === 'object' ? o.value : o;
    var label = typeof o === 'object' ? o.label : o;
    var isSel = String(val) === String(selectedValue);
    return '<option value="' + pgEscapeAttr(val) + '"' + (isSel ? ' selected' : '') + '>' + pgEscapeHtml(label) + '</option>';
  }).join('');
  return '<select id="' + selectId + '" class="pg-param-select" onchange="' + onChangeCode + '" style="' + (extraStyle || 'flex:1;min-width:0') + '">' + opts + '</select>';
}

function pgStepParam(key, delta, min, max, isFloat) {
  var w = pgWin();
  if (!w) return;
  var cur = isFloat ? (parseFloat(w.config[key]) || 0) : (parseInt(w.config[key], 10) || 0);
  var next = cur + delta;
  if (min != null && next < min) next = min;
  if (max != null && next > max) next = max;
  if (isFloat) next = Math.round(next * 100) / 100;
  w.config[key] = next;
  pgSave();
  pgRenderSidebar();
}

function pgImgParamSelect(key, labelKey, val, options) {
  var wrapId = 'pg-selwrap-' + key;
  var selId = 'pg-sel-' + key;
  var opts = options.map(function(o) {
    return { value: o.value, label: o.label };
  });
  return '<div class="pg-param-row">' +
    '<label>' + pgEscapeHtml(pgT(labelKey)) + '</label>' +
    pgRenderCustomSelect(wrapId, selId, opts, val || '', 'pgOnParam(\'' + key + '\', this.value)', 'flex:1;min-width:0') +
  '</div>';
}

function pgImgParamNumber(key, labelKey, val, min, max, step, isFloat) {
  var v = val != null ? val : (min || 0);
  var stp = step || 1;
  var flt = !!isFloat;
  return '<div class="pg-param-row">' +
    '<label>' + pgEscapeHtml(pgT(labelKey)) + '</label>' +
    '<div class="number-stepper" style="flex:1;min-width:0">' +
      '<button type="button" class="stepper-btn stepper-minus" onclick="pgStepParam(\'' + key + '\', -' + stp + ', ' + min + ', ' + max + ', ' + flt + ')">-</button>' +
      '<input type="number" class="stepper-input" min="' + min + '" max="' + max + '" step="' + stp + '" value="' + v + '" onchange="pgOnParam(\'' + key + '\', ' + (flt ? 'parseFloat(this.value)||0' : 'parseInt(this.value,10)||0') + ')">' +
      '<button type="button" class="stepper-btn stepper-plus" onclick="pgStepParam(\'' + key + '\', ' + stp + ', ' + min + ', ' + max + ', ' + flt + ')">+</button>' +
    '</div>' +
  '</div>';
}

// pgImgSizeOptionsFor returns the size option list for a model. If the model
// exposes a custom imgSizes list in pgState, use that; otherwise fall back to
// the built-in defaults for the given protocol ('gpt' or 'modelscope').
// The list never includes the ''/Default entry or the '__custom' sentinel —
// those are appended by pgImgParamSelectWithEdit so they always appear.
function pgImgSizeOptionsFor(proto, modelId, builtin) {
  var info = pgGetModelInfo(modelId);
  if (info && info.imgSizes && info.imgSizes.length) {
    var opts = [];
    for (var i = 0; i < info.imgSizes.length; i++) {
      var s = info.imgSizes[i];
      if (s) opts.push({ value: s, label: s });
    }
    return opts;
  }
  return builtin;
}

// pgImgParamSelectWithEdit renders a size select with:
//  - the options (Default + sizeOpts + a Custom... sentinel)
//  - clickable Size label button that opens the per-model resolutions editor modal
//  - a Custom Size text input below the select for ad-hoc WxH that bypasses
//    the saved list (writes directly to w.config.imgSize)
// `proto` is the image protocol ('gpt' or 'modelscope'); used to seed the
// editor modal with the right built-in defaults.
function pgImgParamSelectWithEdit(key, proto, modelId, cfg, builtinOpts) {
  var sizeOpts = pgImgSizeOptionsFor(proto, modelId, builtinOpts);
  var sel = pgEscapeHtml(pgT('pgImgSize'));
  var arr = [{value: '', label: pgT('pgImgSizeDefault')}];
  for (var i = 0; i < sizeOpts.length; i++) arr.push(sizeOpts[i]);
  // Sentinel '__custom' — selecting it reveals the custom input without
  // disturbing any saved list entry the user may have picked before.
  arr.push({value: '__custom', label: pgT('pgImgCustomSize') + '...'});
  var wrapId = 'pg-selwrap-size-' + proto;
  var selId = 'pg-sel-size-' + proto;
  var labelBtn = '<button type="button" class="pg-param-label-btn" onclick="pgOpenImgSizesModal()" data-tooltip="' + pgEscapeAttr(pgT('pgImgEditSizesTitle')) + '">' + sel + '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.65;margin-left:3px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>';
  var html = '<div class="pg-param-row">' +
    labelBtn +
    pgRenderCustomSelect(wrapId, selId, arr, cfg[key] || '', 'pgOnImgSizeSelect(this.value)', 'flex:1;min-width:0') +
  '</div>';
  var isCustom = cfg[key] && cfg[key] !== '__custom' && !pgImgListContains(sizeOpts, cfg[key]);
  var showCustom = (cfg[key] === '__custom') || isCustom;
  html += '<div class="pg-param-row pg-img-custom-row"' + (showCustom ? '' : ' style="display:none"') + '>' +
    '<label>' + pgEscapeHtml(pgT('pgImgCustomSize')) + '</label>' +
    '<input type="text" value="' + pgEscapeAttr(isCustom ? cfg[key] : '') + '" placeholder="' + pgEscapeAttr(pgT('pgImgCustomSizePlaceholder')) + '" oninput="pgOnParam(\'' + key + '\', this.value)" style="flex:1">' +
  '</div>';
  return html;
}

function pgImgListContains(opts, val) {
  for (var i = 0; i < opts.length; i++) {
    if (opts[i].value === val) return true;
  }
  return false;
}

function pgRenderImageParams(cfg, proto) {
  var html = '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgImageParams')) + '</div>';
  if (proto === 'gpt') {
    html += pgImgParamSelectWithEdit('imgSize', 'gpt', cfg.model, cfg, [
      {value: '', label: pgT('pgImgSizeDefault')},
      {value: 'auto', label: 'auto'},
      {value: '1:1', label: '1:1'},
      {value: '16:9', label: '16:9'},
      {value: '9:16', label: '9:16'},
      {value: '3:1', label: '3:1'},
      {value: '1024x1024', label: '1024x1024 (1:1)'},
      {value: '1200x675', label: '1200x675 (16:9)'},
      {value: '928x1664', label: '928x1664 (9:16)'},
      {value: '3000x1000', label: '3000x1000 (3:1)'},
    ]);
    html += pgImgParamSelect('imgQuality', 'pgImgQuality', cfg.imgQuality || '', [
      {value: '', label: pgT('pgImgQualityStandard')},
      {value: 'auto', label: pgT('pgImgQualityAuto')},
      {value: 'low', label: pgT('pgImgQualityLow')},
      {value: 'medium', label: pgT('pgImgQualityMedium')},
      {value: 'high', label: pgT('pgImgQualityHigh')},
    ]);
    html += pgImgParamSelect('imgBackground', 'pgImgBackground', cfg.imgBackground || '', [
      {value: '', label: pgT('pgImgBackgroundOpaque')},
      {value: 'transparent', label: pgT('pgImgBackgroundTransparent')},
    ]);
    html += pgImgParamSelect('imgModeration', 'pgImgModeration', cfg.imgModeration || '', [
      {value: '', label: pgT('pgImgModerationAuto')},
      {value: 'low', label: pgT('pgImgModerationLow')},
    ]);
    // n constrained 1..5 for GPT
    html += pgImgParamNumber('imgN', 'pgImgN', cfg.imgN || 1, 1, 5, 1);
    // response_format
    html += pgImgParamSelect('imgResponseFormat', 'pgImgResponseFormat', cfg.imgResponseFormat || '', [
      {value: '', label: pgT('pgImgResponseFormatUrl')},
      {value: 'b64_json', label: pgT('pgImgResponseFormatB64')},
    ]);
    // output_format
    html += pgImgParamSelect('imgOutputFormat', 'pgImgOutputFormat', cfg.imgOutputFormat || '', [
      {value: '', label: pgT('pgImgQualityStandard')},
      {value: 'png', label: pgT('pgImgOutputFormatPng')},
      {value: 'jpeg', label: pgT('pgImgOutputFormatJpeg')},
      {value: 'webp', label: pgT('pgImgOutputFormatWebp')},
    ]);
    // output_compression (shown only when output_format is set)
    html += '<div class="pg-param-row pg-img-output-compression-row"' + (cfg.imgOutputFormat && cfg.imgOutputFormat !== 'png' ? '' : ' style="display:none"') + '>' +
      '<label>' + pgEscapeHtml(pgT('pgImgOutputCompression')) + '</label>' +
      '<div class="number-stepper" style="flex:1;min-width:0">' +
        '<button type="button" class="stepper-btn stepper-minus" onclick="pgStepParam(\'imgOutputCompression\', -1, 0, 100, false)">-</button>' +
        '<input type="number" class="stepper-input" min="0" max="100" step="1" value="' + (cfg.imgOutputCompression || 0) + '" onchange="pgOnParam(\'imgOutputCompression\', parseInt(this.value,10)||0)">' +
        '<button type="button" class="stepper-btn stepper-plus" onclick="pgStepParam(\'imgOutputCompression\', 1, 0, 100, false)">+</button>' +
      '</div>' +
    '</div>';
    // user
    html += '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('pgImgUser')) + '</label>' +
      '<input type="text" value="' + pgEscapeAttr(cfg.imgUser || '') + '" oninput="pgOnParam(\'imgUser\', this.value)" style="flex:1">' +
    '</div>';
  } else if (proto === 'xai') {
    html += pgImgParamSelect('imgAspectRatio', 'pgImgAspectRatio', cfg.imgAspectRatio || '1:1', [
      {value: '1:1', label: '1:1'},
      {value: '3:2', label: '3:2'},
      {value: '4:3', label: '4:3'},
      {value: '16:9', label: '16:9'},
      {value: '21:9', label: '21:9'},
      {value: '9:16', label: '9:16'},
      {value: '2:3', label: '2:3'},
      {value: '3:4', label: '3:4'},
      {value: '2:1', label: '2:1'},
      {value: '1:2', label: '1:2'},
    ]);
    html += pgImgParamSelect('imgResolution', 'pgImgResolution', cfg.imgResolution || '2k', [
      {value: '1k', label: '1k'},
      {value: '2k', label: '2k'},
      {value: '4k', label: '4k'},
      {value: '8k', label: '8k'},
    ]);
    html += pgImgParamNumber('imgN', 'pgImgN', cfg.imgN || 1, 1, 10, 1);
  } else if (proto === 'modelscope') {
    html += pgImgParamSelectWithEdit('imgSize', 'modelscope', cfg.model, cfg, [
      {value: '1024x1024', label: '1024x1024'},
      {value: '1280x720', label: '1280x720'},
      {value: '720x1280', label: '720x1280'},
      {value: '1024x768', label: '1024x768'},
      {value: '768x1024', label: '768x1024'},
    ]);
    html += '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('pgImgNegativePrompt')) + '</label><input type="text" value="' + pgEscapeAttr(cfg.imgNegativePrompt || '') + '" oninput="pgOnParam(\'imgNegativePrompt\', this.value)" style="flex:1"></div>';
    html += pgImgParamNumber('imgSteps', 'pgImgSteps', cfg.imgSteps || 0, 0, 100, 1, false);
    html += pgImgParamNumber('imgGuidance', 'pgImgGuidance', cfg.imgGuidance || 0, 0, 20, 0.5, true);
    html += pgImgParamNumber('imgSeed', 'pgImgSeed', cfg.imgSeed || 0, 0, 999999, 1, false);
  } else if (proto === 'sensenova') {
    var mName = (cfg.model || '').toLowerCase();
    var isFast = mName.indexOf('fast') !== -1;
    var snSizes = isFast ? [
      {value: '2752x1536', label: '2752×1536 (16:9 默认)'},
      {value: '2048x2048', label: '2048×2048 (1:1)'},
      {value: '1536x2752', label: '1536×2752 (9:16)'},
      {value: '2496x1664', label: '2496×1664 (3:2)'},
      {value: '1664x2496', label: '1664×2496 (2:3)'},
      {value: '2368x1760', label: '2368×1760 (4:3)'},
      {value: '1760x2368', label: '1760×2368 (3:4)'},
      {value: '2272x1824', label: '2272×1824 (5:4)'},
      {value: '1824x2272', label: '1824×2272 (4:5)'},
      {value: '3072x1376', label: '3072×1376 (21:9)'},
      {value: '1344x3136', label: '1344×3136 (9:21)'},
    ] : [
      {value: 'auto', label: 'auto'},
      {value: '2048x2048', label: '2048×2048 (1:1 2K)'},
      {value: '2720x1536', label: '2720×1536 (16:9 2K)'},
      {value: '1536x2720', label: '1536×2720 (9:16 2K)'},
      {value: '1664x2496', label: '1664×2496 (2:3 2K)'},
      {value: '2496x1664', label: '2496×1664 (3:2 2K)'},
      {value: '4096x4096', label: '4096×4096 (1:1 4K)'},
    ];
    html += pgImgParamSelectWithEdit('imgSize', 'sensenova', cfg.model, cfg, snSizes);
    html += pgImgParamSelect('imgOutputFormat', 'pgImgOutputFormat', cfg.imgOutputFormat || '', [
      {value: '', label: pgT('pgImgSizeDefault')},
      {value: 'png', label: pgT('pgImgOutputFormatPng')},
      {value: 'jpeg', label: pgT('pgImgOutputFormatJpeg')},
      {value: 'webp', label: pgT('pgImgOutputFormatWebp')},
    ]);
    html += pgImgParamSelect('imgResponseFormat', 'pgImgResponseFormat', cfg.imgResponseFormat || '', [
      {value: '', label: pgT('pgImgResponseFormatB64')},
      {value: 'url', label: pgT('pgImgResponseFormatUrl')},
    ]);
    html += pgImgParamSelect('snWatermark', 'pgSnWatermark', cfg.snWatermark || '', [
      {value: '', label: pgT('pgSnWatermarkOn')},
      {value: 'false', label: pgT('pgSnWatermarkOff')},
    ]);
    html += pgImgParamSelect('snPromptExtend', 'pgSnPromptExtend', cfg.snPromptExtend || '', [
      {value: '', label: pgT('pgSnPromptExtendOn')},
      {value: 'false', label: pgT('pgSnPromptExtendOff')},
    ]);
  }
  html += '</div>';
  return html;
}
