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
  // Image generation params
  imgSize: '',
  imgQuality: '',
  imgBackground: '',
  imgModeration: '',
  imgAspectRatio: '1:1',
  imgResolution: '2k',
  imgN: 1,
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
function pgEscapeHtml(s)     { return PG_HOST && PG_HOST.escapeHtml ? PG_HOST.escapeHtml(s) : escapeHtml(s); }
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