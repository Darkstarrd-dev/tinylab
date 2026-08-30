// pg-core.js
// =====================================================================
// Playground — interactive chat testing UI.
// Talks directly to /v1/chat/completions (OpenAI-compatible SSE passthrough).
// Config + parameterEnabled + messages persist to localStorage (v2 schema).
// Features: parameterEnabled toggles, seed, image_url multimodal, role
// toggle (user/assistant/system), system prompt, reasoning duration,
// sources rendering, show-source/preview, HTML iframe preview, mermaid,
// message timing, error retry/edit-prompt actions, v2 localStorage.
// Multi-window: split panes (1-4), each with independent conversation.
// =====================================================================

// ----- Module 1: State management -----------------------------------
// localStorage v2 schema (hard cut from v1; v1 data is ignored entirely).
var PG_CFG_KEY = 'tinyrouter.playground.cfg.v2';
var PG_MSG_KEY = 'tinyrouter.playground.msg.v2';
var PG_PARAM_KEY = 'tinyrouter.playground.params.v2';

var PG_DEFAULT_CFG = {
  model: '',
  temperature: 0.8,
  topP: 1,
  maxTokens: 0,
  frequencyPenalty: 0,
  presencePenalty: 0,
  seed: '',
  stream: true,
  useCustomBody: false,
  customBody: '',
  // Custom endpoint (bypass TinyRouter proxy, direct fetch to arbitrary URL)
  useCustomEndpoint: false,
  customEndpoint: '',
  customEndpointKey: '',
  // Multimodal
  imageEnabled: false,
  imageUrls: [],
  // System prompt (sent as first message when non-empty)
  systemPrompt: '',
  // Agent nickname (group-chat identity); empty => "Agent N"
  agentName: '',
  contextLimit: 8000,
  thinkingBudget: 4096,
  // OpenAI reasoning effort (normal mode): off | minimal | low | medium | high | xhigh | max
  reasoningEffort: 'medium',
  // Google Native parameters
  topK: 40,
  thinkingLevel: 'medium', // minimal | low | medium | high
  maxOutputTokens: 2048,
  stopSequences: '',
  candidateCount: 1,
  responseMimeType: 'text/plain', // text/plain | application/json
  responseSchema: '',
  safetyHarassment: 'BLOCK_NONE',
  safetyHateSpeech: 'BLOCK_NONE',
  safetySexuallyExplicit: 'BLOCK_NONE',
  safetyDangerousContent: 'BLOCK_NONE',
  safetyCivicIntegrity: 'BLOCK_NONE',
  // Manual Image Canvas prompt helper model (text model only)
  imgPromptModel: '',
  imgSize: '',
  imgQuality: '',
  imgBackground: '',
  imgModeration: '',
  imgAspectRatio: '1:1',
  imgResolution: '2k',
  imgN: 1,
  // Manual Canvas images per prompt submission (client-side loop count only;
  // read via pgGetImageSubmitCount(), never sent in the API body, and
  // independent of Batch Planning quantity).
  imgSubmitCount: 1,
  // Per-provider maximum in-flight image requests (1..8)
  imgConcurrency: 1,
  // Prompt Inspire modal: user-editable instruction presets submitted to the
  // helper model (empty = built-in BUILTIN_PRESETS fallback)
  imgInspirePresets: [],
  // Prompt Inspire modal: currently selected preset instruction (empty =
  // first built-in). Stored as text; stale text falls back to the default.
  imgInspirePreset: '',
  // Endpoint control: 'generations' (default) or 'edits'
  imgEndpoint: 'generations',
  // GPT/image response/output format fields
  imgResponseFormat: '',
  imgOutputFormat: '',
  imgOutputCompression: 0,
  imgUser: '',
  // Protocol filter for image model selector
  imgProtocolFilter: 'all',
  // ModelScope params
  imgNegativePrompt: '',
  imgSteps: 0,
  imgGuidance: 0,
  imgSeed: 0,
  // SenseNova params
  snWatermark: '',
  snPromptExtend: '',
  // ComfyUI protocol (Playground Image mode)
  imgComfyPort: '8188',
  imgComfyConnected: false,
  imgComfyTemplateId: '',
  imgComfyWorkflow: null,
  imgComfyPasteJson: '',
};

// parameterEnabled mirrors new-api defaults: max_tokens + seed off.
var PG_DEFAULT_PARAMS = {
  temperature: true,
  topP: true,
  maxTokens: false,
  frequencyPenalty: true,
  presencePenalty: true,
  seed: false,
  thinkingBudget: false,
  reasoningEffort: false,
  // Google Native toggles
  topK: false,
  thinkingLevel: true,
  maxOutputTokens: false,
  stopSequences: false,
  candidateCount: false,
  responseMimeType: false,
  responseSchema: false,
  safetySettings: false,
};

// OpenAI reasoning_effort wire values: UI level -> JSON body field value.
// 'off' (UI "Off") maps to the wire disable value "none" (per omp mapping:
// reasoning_effort:"none" disables reasoning on supporting models).
var PG_REASONING_EFFORT_WIRE = {
  off: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max'
};

var PG_ICON_COPY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
var PG_ICON_SRC = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>';
var PG_ICON_REGEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';
var PG_ICON_EDIT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
var PG_ICON_DELETE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path></svg>';
var PG_ICON_RETRY = PG_ICON_REGEN;
var PG_ICON_ROLE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><path d="M20 8v6M23 11h-6"></path></svg>';
var PG_ICON_DEBUG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="6" width="8" height="14" rx="4"></rect><path d="M19 7l-3 2"></path><path d="M19 11l-3 0"></path><path d="M19 15l-3-2"></path><path d="M8 8H5"></path><path d="M8 12H4"></path><path d="M8 16H5"></path><path d="M12 6V4"></path></svg>';
var PG_ICON_SAVE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>';
var PG_ICON_RESET = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>';
// Text-only zoom (−/reset/+): font-size zoom affecting pg input + bubble text.
var PG_ICON_ZOOM_OUT  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"></path></svg>';
var PG_ICON_ZOOM_RESET= '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-1.5-5"></path><path d="M21 3v6h-6"></path><path d="M10 8l-2 4 2 4M14 8l2 4-2 4"></path></svg>';
var PG_ICON_ZOOM_IN   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>';

async function pgSaveMarkdownFile(content, filename) {
  if (!content) return;
  filename = filename || ('search_result_' + Date.now() + '.md');
  if (!filename.endsWith('.md')) filename += '.md';
  try {
    var saved = await FsApi.saveFile(content, filename, 'text/markdown');
    if (saved) pgToast(pgT('pgSaveSuccess'), 'success');
  } catch (e) {
    pgToast(pgT('pgError'), 'error');
  }
}

// =====================================================================
// Adapter contract — 宿主可以注入 PG_HOST 来覆盖默认全局函数。
// 不注入时, fallback 到现有全局 (apiGet/toast/pgEscapeHtml/copyToClipboard/t),
// 保持 TinyRouter 宿主原行为不变; 外部宿主可通过 window.PG_HOST = {...}
// 替换为自身实现, 实现模块的零侵入移植。
// =====================================================================
var PG_HOST = (typeof window !== 'undefined' && window.PG_HOST) ? window.PG_HOST : null;
function pgApiGet(p)         { return PG_HOST && PG_HOST.apiGet ? PG_HOST.apiGet(p) : apiGet(p); }
function pgApiPost(p, b)     { return PG_HOST && PG_HOST.apiPost ? PG_HOST.apiPost(p, b) : apiPost(p, b); }
function pgApiPatch(p, b)    { return PG_HOST && PG_HOST.apiPatch ? PG_HOST.apiPatch(p, b) : apiPatch(p, b); }
function pgToast(m, ty)      { return PG_HOST && PG_HOST.toast ? PG_HOST.toast(m, ty) : toast(m, ty); }
function pgEscapeHtml(s)     {
  if (PG_HOST && PG_HOST.escapeHtml) return PG_HOST.escapeHtml(s);
  if (typeof escapeHtml === 'function') return escapeHtml(s);
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function pgEscapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function pgCopyToClipboard(tx, lb) { return PG_HOST && PG_HOST.copyToClipboard ? PG_HOST.copyToClipboard(tx, lb) : copyToClipboard(tx, lb); }
function pgT(k, ar) {
  if (PG_HOST && PG_HOST.t) return PG_HOST.t(k, ar);
  if (typeof window !== 'undefined' && window.PG_I18N) {
    var lang = document.documentElement.getAttribute('data-lang') || (localStorage && localStorage.getItem('lang')) || 'en';
    var dict = window.PG_I18N[lang] || window.PG_I18N['en'] || {};
    var s = dict[k];
    if (s != null) {
      if (ar && ar.length) {
        return s.replace(/\{(\d+)\}/g, function(_, i) { return ar[+i] != null ? ar[+i] : ''; });
      }
      return s;
    }
  }
  if (typeof t === 'function') return t(k, ar);
  return k;
}

// Storage limits (mirrors new-api storage.ts constraints)
var PG_MAX_MSGS = 100;
var PG_MAX_MSGS_BYTES = 1024 * 1024;       // 1MB raw string cap
var PG_MAX_MSG_CHARS = 40000;              // single message content cap
var PG_MAX_MSGS_CHARS = 120000;            // total loaded content cap

// ----- Media helpers (PDF / Video / Audio / Image) -----------------
function pgGetMediaType(url) {
  if (!url || typeof url !== 'string') return 'image';
  var clean = url.trim().toLowerCase();
  if (clean.indexOf('data:') === 0) {
    if (clean.indexOf('data:application/pdf') === 0) return 'pdf';
    if (clean.indexOf('data:video/') === 0) return 'video';
    if (clean.indexOf('data:audio/') === 0) return 'audio';
    if (clean.indexOf('data:image/') === 0) return 'image';
  }
  var pathPart = clean.split('?')[0].split('#')[0];
  if (/\.pdf$/i.test(pathPart)) return 'pdf';
  if (/\.(mp4|webm|mov|mkv|avi|flv|wmv|m4v|3gp|ogv)$/i.test(pathPart)) return 'video';
  if (/\.(mp3|wav|ogg|aac|flac|m4a|wma|opus|oga|weba)$/i.test(pathPart)) return 'audio';
  return 'image';
}

function pgGetMediaSvg(type, size) {
  size = size || 24;
  if (type === 'pdf') {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="currentColor" fill-opacity="0.12"/>' +
      '<polyline points="14 2 14 8 20 8"/>' +
      '<path d="M10 13v4M10 13h1.8a1.6 1.6 0 0 0 0-3.2H10" stroke-width="1.6"/>' +
      '<path d="M14 9.8v7.2M14 9.8h1.6a2.2 2.2 0 0 1 0 4.4H14" stroke-width="1.6"/>' +
    '</svg>';
  }
  if (type === 'video') {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2" y="4" width="20" height="16" rx="3.5" fill="currentColor" fill-opacity="0.12"/>' +
      '<polygon points="10 8.5 16 12 10 15.5 10 8.5" fill="currentColor" stroke-linejoin="round"/>' +
      '<line x1="2" y1="8" x2="6" y2="8"/>' +
      '<line x1="18" y1="8" x2="22" y2="8"/>' +
      '<line x1="2" y1="16" x2="6" y2="16"/>' +
      '<line x1="18" y1="16" x2="22" y2="16"/>' +
    '</svg>';
  }
  if (type === 'audio') {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M9 18V5l12-2v13" stroke-width="2"/>' +
      '<circle cx="6" cy="18" r="3" fill="currentColor" fill-opacity="0.2" stroke-width="1.8"/>' +
      '<circle cx="18" cy="16" r="3" fill="currentColor" fill-opacity="0.2" stroke-width="1.8"/>' +
      '<path d="M6 8v3M3 9.5v0M9 9.5v0" stroke-width="1.5" stroke-linecap="round"/>' +
    '</svg>';
  }
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="3" width="18" height="18" rx="3" fill="currentColor" fill-opacity="0.12"/>' +
    '<circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/>' +
    '<polyline points="21 15 16 10 5 21"/>' +
  '</svg>';
}