// pg-request.js
// ----- Module 4: Content helpers (text / images) ------------------
function pgTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(function(p) { return p.type === 'text'; })
      .map(function(p) { return p.text || ''; }).join('');
  }
  return '';
}

function pgImageParts(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(function(p) { return p.type === 'image_url' && p.image_url && p.image_url.url; });
}

// ----- Module 5: SSE streaming request -----------------------------
function pgParseSSELine(line) {
  if (!line || line.indexOf('data:') !== 0) return null;
  var payload = line.slice(5).trim();
  if (payload === '[DONE]') return { done: true };
  try { return JSON.parse(payload); } catch (e) { return null; }
}

function pgMergeChunk(current, next) {
  if (!current || !next) return (current || '') + (next || '');
  // Total-replacement chunk: next contains the full accumulated text from the start
  if (next.indexOf(current) === 0) return next;
  // Incremental delta: append to accumulated text
  return current + next;
}

function pgParseErrorDetails(text) {
  if (!text) return { errorMessage: 'Request error occurred', errorCode: null };
  try {
    var parsed = JSON.parse(text);
    if (parsed && parsed.error) {
      return { errorMessage: parsed.error.message || text, errorCode: parsed.error.code || null };
    }
    if (parsed && parsed.message) {
      return { errorMessage: parsed.message, errorCode: parsed.error_code || null };
    }
  } catch (e) { /* not JSON */ }
  return { errorMessage: text, errorCode: null };
}

function pgBuildBodyForWin(i) {
  var w = pgWinAt(i);
  if (w.config.useCustomBody && w.config.customBody) {
    try { return JSON.parse(w.config.customBody); } catch (e) {
      throw new Error('Invalid custom body JSON');
    }
  }
  var en = w.parameterEnabled;
  var cfg = w.config;
  var messages = w.messages
    .filter(function(m) {
      if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') return false;
      if (m.role === 'assistant' && m.error) return false;
      if (m.role === 'assistant' && m.status === 'loading') return false;
      return true;
    })
    .map(function(m) {
      return { role: m.role, content: m.content };
    });
  var body = {
    model: cfg.model,
    messages: messages,
    stream: cfg.stream,
  };
  if (en.temperature) body.temperature = cfg.temperature;
  if (en.topP) body.top_p = cfg.topP;
  if (en.maxTokens && cfg.maxTokens > 0) body.max_tokens = cfg.maxTokens;
  if (en.frequencyPenalty) body.frequency_penalty = cfg.frequencyPenalty;
  if (en.presencePenalty) body.presence_penalty = cfg.presencePenalty;
  if (en.seed && cfg.seed !== '' && cfg.seed !== null) {
    var seedNum = Number(cfg.seed);
    body.seed = isNaN(seedNum) ? cfg.seed : seedNum;
  }
  if (en.thinkingBudget && cfg.thinkingBudget > 0) body.thinking = { type: 'enabled', budget_tokens: cfg.thinkingBudget };
  return body;
}

function pgBuildBody() {
  return pgBuildBodyForWin(pgState.activeWin);
}

function pgFinalizeBodyForSend(body, lastUserMessage, i) {
  var w = pgWinAt(i);
  if (w.config.systemPrompt && w.config.systemPrompt.trim()) {
    var hasSystem = (body.messages || []).some(function(m) { return m.role === 'system'; });
    if (!hasSystem) {
      body.messages = [{ role: 'system', content: w.config.systemPrompt }].concat(body.messages);
    }
  }
  if (w.config.imageEnabled && Array.isArray(w.config.imageUrls)) {
    var urls = w.config.imageUrls.filter(function(u) { return u && u.trim(); });
    if (urls.length > 0 && lastUserMessage) {
      var text = (typeof lastUserMessage.content === 'string')
        ? lastUserMessage.content
        : pgTextContent(lastUserMessage.content);
      var parts = [];
      if (text) parts.push({ type: 'text', text: text });
      urls.forEach(function(u) {
        parts.push({ type: 'image_url', image_url: { url: u } });
      });
      lastUserMessage.content = parts;
    }
  }
  return body;
}

function pgBuildImageBody(i) {
  var w = pgWinAt(i);
  var cfg = w.config;
  if (!cfg.model) return null;
  // Extract prompt from last user message
  var prompt = '';
  for (var j = w.messages.length - 1; j >= 0; j--) {
    if (w.messages[j].role === 'user') {
      prompt = pgTextContent(w.messages[j].content);
      break;
    }
  }
  if (!prompt) return null;
  var proto = (typeof pgGetImgProtocol === 'function') ? pgGetImgProtocol(cfg.model) : 'gpt';
  var body = { model: cfg.model, prompt: prompt };
  if (proto === 'gpt') {
    if (cfg.imgSize) body.size = cfg.imgSize;
    if (cfg.imgQuality) body.quality = cfg.imgQuality;
    if (cfg.imgBackground) body.background = cfg.imgBackground;
    if (cfg.imgModeration) body.moderation = cfg.imgModeration;
    // n constrained 1..5 for GPT
    if ((cfg.imgN || 1) !== 1) body.n = Math.min(5, Math.max(1, cfg.imgN || 1));
    // response_format: url or b64_json
    if (cfg.imgResponseFormat) body.response_format = cfg.imgResponseFormat;
    // output_format: png, jpeg, or webp
    if (cfg.imgOutputFormat) body.output_format = cfg.imgOutputFormat;
    // output_compression: 0..100, only for jpeg/webp; preserve explicit 0
    if (cfg.imgOutputFormat === 'jpeg' || cfg.imgOutputFormat === 'webp') {
      var comp = cfg.imgOutputCompression;
      if (typeof comp === 'number' && isFinite(comp)) {
        body.output_compression = Math.min(100, Math.max(0, comp));
      }
    }
    // user field
    if (cfg.imgUser) body.user = cfg.imgUser;
  } else if (proto === 'xai') {
    body.n = cfg.imgN || 1;
    body.response_format = 'b64_json';
    body.aspect_ratio = cfg.imgAspectRatio || '1:1';
    body.resolution = cfg.imgResolution || '2k';
  } else if (proto === 'modelscope') {
    if (cfg.imgSize) body.size = cfg.imgSize;
    if (cfg.imgNegativePrompt) body.negative_prompt = cfg.imgNegativePrompt;
    if (cfg.imgSteps > 0) body.steps = cfg.imgSteps;
    if (cfg.imgGuidance > 0) body.guidance = cfg.imgGuidance;
    if (cfg.imgSeed > 0) body.seed = cfg.imgSeed;
  }
  // Input image(s) for image-edit / image-to-image models (e.g. ModelScope
  // FireRed-Image-Edit). Single image -> string; multiple -> array, matching
  // the ModelScope /v1/images/generations image_url field.
  if (cfg.imageEnabled && cfg.imageUrls) {
    var imgUrls = cfg.imageUrls.filter(function(u) { return u && u.trim(); });
    if (imgUrls.length > 0) {
      body.image_url = imgUrls.length === 1 ? imgUrls[0] : imgUrls;
    }
  }
  return body;
}