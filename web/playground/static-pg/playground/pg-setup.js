// pg-setup.js
// =====================================================================
// Phase A: AI-assisted scenario generation for Playground group chat.
// Provides M1 (5-stage), M2 (2-step), and M3 (1-step) generation modes,
// character card management, client-side synthesis, and import/export.
// =====================================================================

// ----- Prompt constants (from request.md appendices & respond.md) -----

// Appendix-1: Direction creation
var PG_SETUP_APP1 = '创作方向你是创意写作教练。用户想写小说但可能缺乏灵感或只有一个模糊的方向。你的任务是与用户共创，脑暴出一个引人入胜的小说创作方向。\n\n## 工作方法\n\n1. 如果用户给了任何线索（类型、章节数、梗概），紧扣其展开；如果几乎为空，请自由发挥创意，给出一个有趣、有张力的创作方向。\n2. 设计一个**高冲突、有反转余地的核心矛盾**作为故事锚点。\n3. 主题（topic）必须是一句式钩子承诺——让读者产生"想知道接下来会发生什么"的冲动。\n4. 类型（genre）必须精准（如：仙侠/悬疑/都市/科幻/武侠/历史），可跨类混合但不超过 3 类。\n5. 梗概（guidance）用 2-3 句话勾勒核心设定、主要冲突与预期结局方向。\n\n## 输出格式（严格遵守，便于程序解析）\n\n你必须且只能输出以下 JSON 对象（不要 ```json``` 标记，不要任何解释文字）：\n\n{"topic":"一句式钩子承诺","genre":"精准的类型标签","guidance":"2-3句核心梗概"}\n\ntopic 是必填的，genre 和 guidance 也必须给出。即使完全没有用户输入，也要生成一个完整、有趣的创作方向。';

// Appendix-2: Novel architecture
var PG_SETUP_APP2 = '你是一位精通"雪花写作法"的资深小说架构师。你的目标是帮助用户从零构建一个逻辑严密、充满张力的长篇小说架构。\n\n## 工作方法（雪花法，依次思考）\n\n**第 1 步 核心种子**：用单句公式概括故事本质——"当[主角]遭遇[核心事件]，必须[关键行动]，否则[灾难后果]……"。必须包含显性冲突与潜在危机。\n\n**第 2 步 角色动力学**：设计 3–6 个核心角色。为每个角色定义驱动力三角（表面追求 / 深层渴望 / 灵魂需求），并构建关系网（冲突、合作、背叛）。\n\n**第 3 步 世界构建**：分三维度——物理维度（空间/时间/法则）、社会维度（权力结构/文化禁忌）、隐喻维度（视觉符号/主题映射）。\n\n**第 4 步 三幕式情节**：\n- 第一幕（触发）：日常打破 → 关键事件 → 错误抉择。\n- 第二幕（对抗）：压力升级 → 虚假胜利 → 灵魂黑夜。\n- 第三幕（解决）：代价显现 → 终极抉择 → 开放结局。\n\n## 输出格式（严格遵守，便于程序解析）\n\n你必须且只能输出以下四个二级标题分区，标题行原样照写，每区内容自由发挥：\n\n## 核心种子\n（单句公式 + 一两句扩展）\n\n## 角色动力学\n（各角色的驱动力三角与关系网）\n\n## 世界观\n（物理 / 社会 / 隐喻三维度）\n\n## 三幕式情节\n（第一幕 / 第二幕 / 第三幕）\n\n不要输出这四个分区之外的任何内容（不要前言、不要结语、不要解释）。如果用户给了主题/类型/梗概，紧扣其推导。';

// Appendix-3: Single character card create/enrich
var PG_SETUP_APP3 = '你是专业的小说设定设计师。你的任务是根据用户的描述，凭空创作一张结构完整、内容丰富的小说设定卡片（不依赖任何原文）。\n\n## 实体类型\n\n卡片属于以下五类之一（由用户指定 type）：character（人物）/ location（地点）/ item（物品）/ skill（技能·能力）/ faction（势力·组织）。\n\n## 两种模式\n\n- **create（新建）**：根据用户描述从零创作一张全新卡片。\n- **enrich（丰富）**：用户会提供一张「已有卡片」内容，你要在**保留原有信息**的前提下扩写、补全、深化——补充缺失的字段、丰富描述、增加细节，但不得推翻或矛盾于已有设定。\n\n## 创作原则\n\n- **贴合描述**：紧扣用户的指令意图（性格、定位、外貌、能力等）。\n- **结构化**：根据实体类型把关键属性整理进 fields 键值对（中文键名）。\n- **人物专属**：当 type=character 时，额外输出 styleNote（语言风格描述）与 styleExamples（2-4 句台词例句）；其他类型这两个字段省略或留空。\n- **自洽完整**：description 用一段连贯文字概括该实体（80-200 字）。\n\n## fields 字段示例（按类型）\n\n- character：appearance(外貌) / personality(性格) / ability(能力) / identity(身份) / motivation(动机)\n- location：type(类型) / environment(环境) / significance(意义)\n- item：type(类型) / effect(效果) / owner(持有者)\n- skill：type(类型) / effect(效果) / user(使用者)\n- faction：type(类型) / leader(领袖) / influence(势力范围)\n\n## 输出格式（严格遵守）\n\n只能输出**单个 JSON 对象**（不要 ```json``` 标记，直接输出 JSON），结构如下：\n\n{\n  "name": "实体名称",\n  "aliases": ["别名1", "别名2"],\n  "description": "一段连贯的概括描述",\n  "fields": { "外貌": "...", "性格": "..." },\n  "styleNote": "（仅 character）语言风格描述",\n  "styleExamples": ["（仅 character）台词例句1", "台词例句2"]\n}\n\n## 注意事项\n\n- 输出必须是合法 JSON，不附加任何解释文字、不加 markdown 围栏。\n- aliases 没有就给空数组 []；非人物类的 styleNote/styleExamples 可省略。\n- enrich 模式下：name 一般沿用已有卡片的 name（除非用户明确要求改名），其余字段在已有内容基础上扩充。';

// Appendix-4: Character card batch generation
var PG_SETUP_APP4 = '你是小说设定策划。根据用户给定的实体类型、数量与（可选）整体要求，构思一组**彼此区分、互不雷同**的简短侧写，供后续逐一扩写为完整设定卡片。\n\n## 输出格式（严格遵守）\n\n只输出**一个 JSON 对象**（不要 ```json``` 标记，直接输出 JSON）：\n\n{\n  "profiles": [\n    { "name": "名称", "brief": "一句话侧写（30-60字，点出定位/性格/核心特征）" }\n  ]\n}\n\n## 要求\n\n- profiles 数组长度必须等于用户指定的数量 count。\n- 每条侧写聚焦一个鲜明的核心设定，彼此**差异化**：避免重名、避免设定/定位重复。\n- 若用户提供了整体要求/主题，所有侧写都要贴合它；若未提供，自由发挥、追求新颖多样。\n- name 简洁；brief 用一句话概括，不展开。\n- 输出必须是合法 JSON，不附加任何解释文字、不加 markdown 围栏。';

// Appendix-5: Character profiling (batch expand)
var PG_SETUP_APP5_BASE = '你是专业的小说设定设计师。你会收到同一实体类型下的**一组侧写**，请把每条侧写各自扩写为一张结构完整、内容丰富的设定卡片（不依赖任何原文）。\n\n## 实体类型与字段\n\n卡片属于以下五类之一：character（人物）/ location（地点）/ item（物品）/ skill（技能·能力）/ faction（势力·组织）。\n- 用 fields 键值对（中文键名）整理关键属性。\n- 仅当 type=character 时额外输出 styleNote（语言风格）与 styleExamples（2-4 句台词例句），其它类型省略。\n- description 用一段连贯文字概括该实体（80-200 字）。\n\n## 输出格式（严格遵守）\n\n只输出**一个 JSON 数组**（不要 ```json``` 标记，直接输出 JSON），每个元素对应输入的一条侧写、**顺序一一对应**：\n\n[\n  {\n    "name": "实体名称",\n    "aliases": ["别名1"],\n    "description": "一段连贯的概括描述",\n    "fields": { "外貌": "...", "性格": "..." },\n    "styleNote": "（仅 character）语言风格描述",\n    "styleExamples": ["（仅 character）台词例句1", "台词例句2"]\n  }\n]\n\n## 要求\n\n- 数组长度必须等于输入侧写条数，顺序与输入一致。\n- 每张卡片自洽完整、彼此差异化；紧扣对应侧写的核心设定与用户的整体要求。\n- aliases 没有就给空数组 []；非人物类的 styleNote/styleExamples 省略。\n- 输出必须是合法 JSON，不附加任何解释文字、不加 markdown 围栏。';

// personaAxes appendix for Appendix-5 (added in M1 Stage 4 and M2 Step 2)
var PG_SETUP_PERSONA_AXES_NOTE = '每张卡片额外输出 personaAxes 对象：{"conventionality":0-10, "expressiveness":0-10, "verbosity":0-10}，各为 0-10 整数，分别表示性格的严谨克制程度、表达的跳脱奔放程度、话语的冗长程度。';

// M2 Step 1 merged prompt (§3.3 of respond.md)
var PG_SETUP_M2_PROMPT = '你是资深小说架构师兼设定策划。请一步完成：为一个 N 人群聊角色扮演场景，设计共享场景背景与 N 个彼此差异化的人物侧写。\n\n## 工作方法\n1. 若用户给了主题/类型/梗概/人物名，紧扣展开；若为空，自由发挥一个高冲突、有反转余地的方向。\n2. 用单句公式提炼核心种子——"当[主角们]遭遇[核心事件]，必须[关键行动]，否则[灾难后果]"。\n3. 世界观从物理/社会/隐喻三维度构思后浓缩为一段。\n4. 为 N 个人物各设计驱动力三角（表面追求/深层渴望/灵魂需求），并构建彼此的关系网（冲突、合作、背叛至少各一处，若人数允许）。\n5. 每个人物给出一句话侧写（30-60字），彼此定位/性格不得雷同。\n\n## 输出格式（严格遵守，只输出以下 JSON 对象，不要围栏、不要解释）\n{\n  "scenario": {\n    "coreSeed": "单句公式",\n    "world": "世界观浓缩（150字内）",\n    "tone": "类型与基调标签",\n    "openingSituation": "开场情境（50字内，可作为群聊第一条消息的素材）",\n    "relationships": "关系网概述（每对关键关系一句话）"\n  },\n  "profiles": [\n    { "name": "名称", "brief": "一句话侧写（含定位/性格/核心特征与驱动力暗示）" }\n  ]\n}\nprofiles 长度必须等于 N。';

// M3 one-step prompt (§3.4 of respond.md)
var PG_SETUP_M3_PROMPT = '你是资深小说架构师兼设定策划。请一次性完成：共享场景背景 + N 张完整人物卡片，用于 N 个 AI 在群聊中分别扮演一个角色。\n\n## 工作方法\n- 核心种子用单句公式（当…遭遇…必须…否则…）；世界观三维度浓缩；每个人物有驱动力三角与关系网位置；人物间高差异化。\n- 每张人物卡片必须包含 styleNote（该角色如何说话）与 styleExamples（2-4 句能立刻听出"是这个人"的台词）——这是最重要的字段。\n- 每张卡片输出 personaAxes：{conventionality, expressiveness, verbosity} 三个 0-10 整数（严谨克制度/跳脱奔放度/话痨度）。\n\n## 输出格式（严格遵守，只输出以下 JSON，不要围栏、不要解释）\n{\n  "scenario": { "coreSeed": "...", "world": "...", "tone": "...",\n                "openingSituation": "...", "relationships": "..." },\n  "characters": [\n    {\n      "name": "", "aliases": [],\n      "description": "80-200字概括",\n      "fields": { "外貌": "", "性格": "", "能力": "", "身份": "", "动机": "" },\n      "styleNote": "语言风格描述",\n      "styleExamples": ["台词1", "台词2"],\n      "relations": "与其他角色的关系一句话",\n      "personaAxes": { "conventionality": 5, "expressiveness": 5, "verbosity": 5 }\n    }\n  ]\n}\ncharacters 长度必须等于 N。';

// §4.1 systemPrompt template
var PG_SETUP_SYSPROMPT_TEMPLATE =
  '【场景】\n{coreSeed}\n{world}\n基调：{tone}\n人物关系：{relationships}\n\n【你的角色：{name}】\n{description}\n{fieldsText}\n与他人的关系：{relations}\n语言风格：{styleNote}\n你的说话方式示例（模仿其口吻，不要照抄）：\n{styleExamplesText}\n\n【群聊规则】\n1. 你正在一个多人群聊中扮演 {name}，始终以第一人称、保持角色口吻发言。\n2. 其他消息以 [名字]: 前缀出现；你的回复不要带任何名字前缀。\n3. 若当前没有值得你发言的内容，只回复 <pass/>。\n4. 对话中会出现「旁白」消息（以系统消息形式出现的场景描写/剧情推进）。它是环境与剧情的变化，不是提问——不要回答它、不要复述它，而是让你的下一次发言自然地体现这一变化。\n5. 每次发言保持在角色的自然长度内，推动对话而非独白。';

// ----- Global setup wizard state ---------------------------------------
var pgSetupState = {
  mode: null,          // 'M1','M2','M3'
  seed: { topic: '', genre: '', guidance: '', userNames: [] },
  stageResults: [],    // [{stageIndex, rawText, parsed}]
  currentStage: 0,     // 0-based index in the pipeline
  abortCtrl: null,     // AbortController for current LLM call
  scenario: null,      // built ScenarioProfile (after completion)
  characters: [],      // fully expanded character cards
  model: '',           // selected LLM model id for generation ('' = first window model)
};

// ----- Utility: robust JSON extraction --------------------------------

function pgSetupExtractJSON(text) {
  if (!text) return null;
  // Strip code fences (```json, ```, etc.)
  var cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
  // Try direct parse first
  try { return JSON.parse(cleaned); } catch (e) { /* fall through */ }
  // Find first balanced { ... } or [ ... ]
  var startBrace = cleaned.indexOf('{');
  var startBracket = cleaned.indexOf('[');
  var start = -1;
  var useBracket = false;
  if (startBrace >= 0 && (startBracket < 0 || startBrace < startBracket)) {
    start = startBrace;
    useBracket = false;
  } else if (startBracket >= 0) {
    start = startBracket;
    useBracket = true;
  }
  if (start < 0) return null;
  var openDelim = useBracket ? '[' : '{';
  var closeDelim = useBracket ? ']' : '}';
  var depth = 0;
  var inString = false;
  var escape = false;
  for (var i = start; i < cleaned.length; i++) {
    var ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openDelim) { depth++; continue; }
    if (ch === closeDelim) { depth--; if (depth === 0) {
      var candidate = cleaned.substring(start, i + 1);
      try { return JSON.parse(candidate); } catch (e2) { return null; }
    }}
  }
  return null;
}

// ----- Utility: LLM call (stream:false, AbortController + timeout) ----

function pgSetupCallLLM(systemPrompt, userContent, timeoutMs) {
  var model = pgSetupState.model || '';
  if (!model) {
    var modelWins = pgAutoChatModelWindows();
    if (!modelWins.length) {
      pgToast(pgT('pgSelectModel'), 'warning');
      return Promise.reject(new Error('no model'));
    }
    model = pgWinAt(modelWins[0]).config.model;
  }
  if (!model) {
    pgToast(pgT('pgSelectModel'), 'warning');
    return Promise.reject(new Error('no model'));
  }
  var abortCtrl = new AbortController();
  pgSetupState.abortCtrl = abortCtrl;
  var timer = setTimeout(function() { abortCtrl.abort(); }, timeoutMs || 60000);
  var body = {
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    stream: false,
  };
  return fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abortCtrl.signal,
  }).then(function(resp) {
    clearTimeout(timer);
    if (!resp.ok) { return resp.json().then(function(e) { throw new Error(e.error && e.error.message ? e.error.message : 'HTTP ' + resp.status); }); }
    return resp.json();
  }).then(function(j) {
    var content = (j.choices && j.choices[0] && j.choices[0].message) ? j.choices[0].message.content : '';
    if (!content) throw new Error(pgT('Empty response from model'));
    return content;
  }).catch(function(err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(pgT('Request timed out'));
    throw err;
  });
}

// ----- §4.2: Pure function: personaAxes -> params --------------------

function pgSetupMapAxesToParams(axes) {
  var c = typeof axes.conventionality === 'number' ? axes.conventionality : 5;
  var e = typeof axes.expressiveness === 'number' ? axes.expressiveness : 5;
  var v = typeof axes.verbosity === 'number' ? axes.verbosity : 5;
  // temperature: clamp(0.3 + e*0.09 - c*0.03, 0.2, 1.3), round to 0.05
  var raw = 0.3 + e * 0.09 - c * 0.03;
  raw = Math.max(0.2, Math.min(1.3, raw));
  var temp = Math.round(raw / 0.05) * 0.05;
  // topP: conventionality >= 7 ? 0.9 : 1.0
  var topP = c >= 7 ? 0.9 : 1.0;
  // maxTokens: verbosity tiers
  var maxTokens;
  if (v <= 3) maxTokens = 256;
  else if (v <= 6) maxTokens = 512;
  else maxTokens = 1024;
  // seed: random
  var seed = Math.floor(Math.random() * Math.pow(2, 31));
  // thinkingBudget: conventionality >= 7 → 4096; >= 5 && expressiveness <= 4 → 2048; else 0
  var thinkingBudget;
  if (c >= 7) thinkingBudget = 4096;
  else if (c >= 5 && e <= 4) thinkingBudget = 2048;
  else thinkingBudget = 0;
  // Rationale text
  var rationale = 'conventionality=' + c + '（' + (c >= 7 ? '严谨' : c >= 4 ? '适中' : '自由') + '）, ';
  rationale += 'expressiveness=' + e + '（' + (e >= 7 ? '奔放' : e >= 4 ? '适中' : '内敛') + '）, ';
  rationale += 'verbosity=' + v + '（' + (v <= 3 ? '简洁' : v <= 6 ? '适中' : '话痨') + '）';
  rationale += ' → temperature=' + temp.toFixed(2) + ', topP=' + topP + ', maxTokens=' + maxTokens + ', thinking=' + (thinkingBudget > 0 ? thinkingBudget : 'off');
  return {
    temperature: temp,
    topP: topP,
    maxTokens: maxTokens,
    seed: seed,
    thinkingBudget: thinkingBudget,
    rationale: rationale,
  };
}

// ----- §4.1: Build systemPrompt from character + scenario ------------

function pgSetupBuildSystemPrompt(char, scenario) {
  // Build fields text
  var fieldsText = '';
  if (char.fields) {
    var keys = Object.keys(char.fields);
    for (var fi = 0; fi < keys.length; fi++) {
      fieldsText += ' - ' + keys[fi] + '：' + (char.fields[keys[fi]] || '') + '\n';
    }
  }
  fieldsText = fieldsText.replace(/\n$/, '');
  // Build styleExamples text
  var styleExamplesText = '';
  if (char.styleExamples && char.styleExamples.length) {
    for (var si = 0; si < char.styleExamples.length; si++) {
      styleExamplesText += ' - "' + char.styleExamples[si] + '"\n';
    }
  }
  styleExamplesText = styleExamplesText.replace(/\n$/, '');
  var prompt = PG_SETUP_SYSPROMPT_TEMPLATE
    .replace(/{coreSeed}/g, scenario.coreSeed || '')
    .replace(/{world}/g, scenario.world || '')
    .replace(/{tone}/g, scenario.tone || '')
    .replace(/{relationships}/g, scenario.relationships || '')
    .replace(/{name}/g, char.name || '')
    .replace(/{description}/g, char.description || '')
    .replace(/{fieldsText}/g, fieldsText)
    .replace(/{relations}/g, char.relations || '')
    .replace(/{styleNote}/g, char.styleNote || '')
    .replace(/{styleExamplesText}/g, styleExamplesText);
  return prompt;
}

// ----- §4.3: Apply profile to windows --------------------------------

function pgSetupApplyProfile(profile) {
  if (!profile || !profile.characters || !profile.agents) {
    pgToast(pgT('Invalid profile'), 'error');
    return;
  }
  var modelWins = pgAutoChatModelWindows();
  var n = Math.min(modelWins.length, profile.agents.length);
  // Check for existing system prompts and confirm overwrite
  var hasExisting = false;
  for (var wi = 0; wi < n; wi++) {
    var w = pgWinAt(modelWins[wi]);
    if (w && w.config.systemPrompt && w.config.systemPrompt.trim()) {
      hasExisting = true;
      break;
    }
  }
  if (hasExisting) {
    var ok = confirm(pgT('Some windows already have system prompts. Overwrite?'));
    if (!ok) { pgToast(pgT('Apply cancelled'), 'info'); return; }
  }
  var hadPriorScenario = !!pgState.autoChat.scenario;
  for (var i = 0; i < n; i++) {
    var winIdx = modelWins[i];
    var w = pgWinAt(winIdx);
    if (!w) continue;
    var agent = profile.agents[i];
    if (!agent) continue;
    // paramsOverridden guard: only on RE-apply (a prior scenario existed) do we
    // compare current w.config.* vs the new params and prompt. On first apply
    // defaults naturally differ from generated values — nothing is "overridden".
    var isOverridden = false;
    if (hadPriorScenario) {
      if (agent.paramsOverridden) {
        isOverridden = true;
      } else {
        var p = agent.params;
        if (p) {
          if (w.config.temperature !== undefined && Math.abs(Number(w.config.temperature) - p.temperature) > 0.01) isOverridden = true;
          if (w.config.topP !== undefined && Number(w.config.topP) !== p.topP) isOverridden = true;
          if (w.config.maxTokens !== undefined && Number(w.config.maxTokens) !== p.maxTokens) isOverridden = true;
          if (w.config.seed !== undefined && Number(w.config.seed) !== p.seed) isOverridden = true;
        }
      }
    }
    if (isOverridden) {
      var keep = confirm(pgT('Window') + ' ' + (winIdx + 1) + ': ' + pgT('params have been modified. Keep current values?'));
      if (keep) continue;
    }
    // Apply agent config
    if (agent.agentName) w.config.agentName = agent.agentName;
    if (agent.systemPrompt) w.config.systemPrompt = agent.systemPrompt;
    if (agent.params) {
      w.config.temperature = agent.params.temperature;
      w.config.topP = agent.params.topP;
      w.config.maxTokens = agent.params.maxTokens;
      w.config.seed = agent.params.seed;
      w.config.thinkingBudget = agent.params.thinkingBudget || 0;
    }
    // Enable parameter overrides
    w.parameterEnabled.temperature = true;
    w.parameterEnabled.topP = true;
    w.parameterEnabled.maxTokens = true;
    w.parameterEnabled.seed = true;
    w.parameterEnabled.thinkingBudget = (agent.params && agent.params.thinkingBudget > 0) ? true : false;
  }
  // Persist scenario
  pgState.autoChat.scenario = profile;
  pgSaveScenario();
  pgSave();
  if (typeof pgRenderSidebar === 'function') pgRenderSidebar();
  if (typeof pgUpdateAutoChatUI === 'function') pgUpdateAutoChatUI();
  // Enable auto chat if splitCount >= 2
  if (pgState.splitCount >= 2 && typeof pgAutoChatToggle === 'function') {
    pgAutoChatToggle(true);
  }
  // Pre-fill openingSituation as suggested seed message
  var seedMsg = profile.scenario && profile.scenario.openingSituation;
  if (seedMsg) {
    var inputEl = document.getElementById('pg-input');
    if (inputEl) inputEl.value = seedMsg;
  }
  pgToast(pgT('Scenario applied'), 'success');
  pgCloseModal();
}

// ----- §4.4: Export ------------------------------------------------

function pgSetupExportProfile(profile) {
  var p = profile || pgState.autoChat.scenario;
  if (!p) {
    pgToast(pgT('No scenario to export'), 'warning');
    return;
  }
  // Build filename: scenario-{name片段}-{date}.json
  var nameFragment = 'export';
  if (p.characters && p.characters.length > 0 && p.characters[0].name) {
    nameFragment = p.characters[0].name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '').slice(0, 20);
  }
  var dateStr = new Date().toISOString().slice(0, 10);
  var filename = 'scenario-' + nameFragment + '-' + dateStr + '.json';
  var jsonStr = JSON.stringify(p, null, 2);
  FsApi.saveFile(jsonStr, filename, 'application/json').then(function(saved) {
    if (saved) pgToast(pgT('Scenario exported'), 'success');
  });
}

// ----- §4.4: Import ------------------------------------------------

function pgSetupImportProfile(file) {
  if (!file) {
    pgToast(pgT('No file selected'), 'warning');
    return;
  }
  var reader = new FileReader();
  reader.onload = function(e) {
    var text = e.target.result;
    var parsed;
    try { parsed = JSON.parse(text); } catch (err) {
      pgToast(pgT('Invalid JSON file'), 'error');
      return;
    }
    // Schema validation
    if (parsed.schema !== 'tr.playground.scenario') {
      pgToast(pgT('Not a valid scenario file') + ': ' + pgT('expected schema') + ' tr.playground.scenario', 'error');
      return;
    }
    // Version check
    if (parsed.version > 1) {
      pgToast(pgT('This scenario requires a newer version') + ' (v' + parsed.version + '). ' + pgT('Please update TinyRouter.'), 'error');
      return;
    }
    // Show preview in a confirmation dialog
    var previewHtml = pgSetupRenderImportPreview(parsed);
    var confirmHtml =
      '<div class="pg-modal-header">' +
        '<span class="pg-modal-title">' + pgEscapeHtml(pgT('Import Scenario')) + '</span>' +
        '<button class="pg-modal-close" onclick="pgCloseModal()">✕</button>' +
      '</div>' +
      '<div class="pg-modal-body" style="max-height:60vh;overflow-y:auto">' +
        previewHtml +
      '</div>' +
      '<div class="pg-modal-footer" style="padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="pg-btn" onclick="pgSetupDoImport(' + Date.now() + ')" style="background:var(--accent);color:#fff">' + pgEscapeHtml(pgT('Apply')) + '</button>' +
        '<button class="pg-btn" onclick="pgCloseModal()">' + pgEscapeHtml(pgT('Cancel')) + '</button>' +
      '</div>';
    // Store the parsed profile for later use by pgSetupDoImport
    pgSetupState._importProfile = parsed;
    // Override pgSetupDoImport to capture the correct profile reference
    window.pgSetupDoImport = function(ts) {
      var prof = pgSetupState._importProfile;
      if (!prof) return;
      pgSetupState._importProfile = null;
      pgCloseModal();
      pgSetupApplyProfile(prof);
    };
    pgShowModal(confirmHtml);
  };
  reader.readAsText(file);
}

function pgSetupRenderImportPreview(profile) {
  if (!profile) return '<p>' + pgEscapeHtml(pgT('Empty profile')) + '</p>';
  var html = '';
  var sc = profile.scenario || {};
  html += '<div style="margin-bottom:12px">';
  html += '<strong>' + pgEscapeHtml(pgT('Scenario')) + '</strong><br>';
  html += '<div style="font-size:13px;line-height:1.5">';
  if (sc.coreSeed) html += '<div><em>' + pgEscapeHtml(pgT('Core Seed')) + ':</em> ' + pgEscapeHtml(sc.coreSeed) + '</div>';
  if (sc.tone) html += '<div><em>' + pgEscapeHtml(pgT('Tone')) + ':</em> ' + pgEscapeHtml(sc.tone) + '</div>';
  if (sc.world) html += '<div><em>' + pgEscapeHtml(pgT('World')) + ':</em> ' + pgEscapeHtml(sc.world) + '</div>';
  html += '</div></div>';
  // Character list
  var chars = profile.characters || [];
  html += '<strong>' + pgEscapeHtml(pgT('Characters')) + ' (' + chars.length + ')</strong><br>';
  for (var ci = 0; ci < chars.length; ci++) {
    var c = chars[ci];
    html += '<div style="margin:6px 0;padding:8px;background:var(--bg2);border-radius:4px;font-size:13px">';
    html += '<strong>' + pgEscapeHtml(c.name || '?') + '</strong>';
    if (c.description) html += '<br><span style="opacity:0.8">' + pgEscapeHtml(c.description.slice(0, 100)) + '</span>';
    // Show params if agents exist
    if (profile.agents && profile.agents[ci] && profile.agents[ci].params) {
      var p = profile.agents[ci].params;
      html += '<div style="font-size:12px;opacity:0.7;margin-top:2px">temp=' + p.temperature + ' topP=' + p.topP + ' maxTokens=' + p.maxTokens + ' thinking=' + (p.thinkingBudget > 0 ? p.thinkingBudget : 'off') + '</div>';
    }
    html += '</div>';
  }
  return html;
}

// ----- Single character: regen / enrich (Appendix-3) ------------------

function pgSetupRegenCharacter(idx) {
  var profile = pgSetupState.scenario;
  if (!profile || !profile.characters || idx >= profile.characters.length) {
    pgToast(pgT('No character to regenerate'), 'warning');
    return Promise.reject(new Error('invalid index'));
  }
  var scenario = profile.scenario || {};
  // Build user message: current card JSON + scenario context + personaAxes requirement
  var existingCard = profile.characters[idx];
  var userMsg = '## 已有卡片（保持 type=character，重新生成）\n' + JSON.stringify(existingCard, null, 2) + '\n\n';
  userMsg += '## 场景上下文\n核心种子：' + (scenario.coreSeed || '') + '\n世界观：' + (scenario.world || '') + '\n基调：' + (scenario.tone || '') + '\n\n';
  userMsg += '## 额外要求\n' + PG_SETUP_PERSONA_AXES_NOTE;

  pgToast(pgT('Regenerating') + ' ' + (existingCard.name || idx) + '...', 'info');
  return pgSetupCallLLM(PG_SETUP_APP3, userMsg, 60000).then(function(content) {
    var parsed = pgSetupExtractJSON(content);
    if (!parsed) {
      pgToast(pgT('Failed to parse character card. Retry?'), 'warning');
      return;
    }
    // Preserve personaAxes from parsed or existing
    if (!parsed.personaAxes) {
      parsed.personaAxes = existingCard.personaAxes || { conventionality: 5, expressiveness: 5, verbosity: 5 };
    }
    // Replace character
    profile.characters[idx] = parsed;
    // Rebuild agents (client-side synthesis)
    pgSetupSynthesizeAgents(profile);
    // Persist
    pgState.autoChat.scenario = profile;
    pgSaveScenario();
    pgSetupRenderFinalReview();
    pgToast(pgT('Character regenerated'), 'success');
  }).catch(function(err) {
    pgToast(pgT('Regeneration failed') + ': ' + err.message, 'error');
  });
}

function pgSetupEnrichCharacter(idx) {
  var profile = pgSetupState.scenario;
  if (!profile || !profile.characters || idx >= profile.characters.length) {
    pgToast(pgT('No character to enrich'), 'warning');
    return Promise.reject(new Error('invalid index'));
  }
  var scenario = profile.scenario || {};
  var existingCard = profile.characters[idx];
  var userMsg = '## 模式\nenrich（丰富已有卡片）\n\n## 已有卡片\n' + JSON.stringify(existingCard, null, 2) + '\n\n';
  userMsg += '## 场景上下文\n核心种子：' + (scenario.coreSeed || '') + '\n世界观：' + (scenario.world || '') + '\n基调：' + (scenario.tone || '') + '\n\n';
  userMsg += '## 额外要求\n' + PG_SETUP_PERSONA_AXES_NOTE;

  pgToast(pgT('Enriching') + ' ' + (existingCard.name || idx) + '...', 'info');
  return pgSetupCallLLM(PG_SETUP_APP3, userMsg, 60000).then(function(content) {
    var parsed = pgSetupExtractJSON(content);
    if (!parsed) {
      pgToast(pgT('Failed to parse enriched card. Retry?'), 'warning');
      return;
    }
    if (!parsed.personaAxes) {
      parsed.personaAxes = existingCard.personaAxes || { conventionality: 5, expressiveness: 5, verbosity: 5 };
    }
    profile.characters[idx] = parsed;
    pgSetupSynthesizeAgents(profile);
    pgState.autoChat.scenario = profile;
    pgSaveScenario();
    pgSetupRenderFinalReview();
    pgToast(pgT('Character enriched'), 'success');
  }).catch(function(err) {
    pgToast(pgT('Enrich failed') + ': ' + err.message, 'error');
  });
}

// ----- Client-side synthesis (Stage 5 / M2 final / M3 final) ---------

function pgSetupSynthesizeAgents(profile) {
  if (!profile || !profile.characters || !profile.scenario) return;
  var scenario = profile.scenario;
  var agents = [];
  for (var ci = 0; ci < profile.characters.length; ci++) {
    var ch = profile.characters[ci];
    // Map axes to params
    var axes = ch.personaAxes || { conventionality: 5, expressiveness: 5, verbosity: 5 };
    var params = pgSetupMapAxesToParams(axes);
    // Build systemPrompt
    var systemPrompt = pgSetupBuildSystemPrompt(ch, scenario);
    // Get or preserve agentName
    var agentName = ch.name || ('Character ' + (ci + 1));
    // Check if existing agent has paramsOverridden
    var paramsOverridden = false;
    if (profile.agents && profile.agents[ci]) {
      var oldAgent = profile.agents[ci];
      if (oldAgent.paramsOverridden) {
        // Preserve user-modified params
        params = oldAgent.params;
        paramsOverridden = true;
      }
      if (oldAgent.agentName) agentName = oldAgent.agentName;
    }
    agents.push({
      agentName: agentName,
      systemPrompt: systemPrompt,
      params: params,
      paramsRationale: params.rationale,
      paramsOverridden: paramsOverridden,
    });
  }
  profile.agents = agents;
  return profile;
}

// ----- Build ScenarioProfile from pipeline results --------------------

function pgSetupBuildProfile() {
  var seed = pgSetupState.seed;
  var scenarioData = pgSetupState.scenario;
  if (!scenarioData) return null;
  var chars = pgSetupState.characters || [];
  if (!chars.length) return null;
  var profile = {
    schema: 'tr.playground.scenario',
    version: 1,
    createdAt: new Date().toISOString(),
    seedInput: {
      topic: seed.topic || '',
      genre: seed.genre || '',
      guidance: seed.guidance || '',
      userNames: seed.userNames || [],
    },
    scenario: {
      coreSeed: scenarioData.coreSeed || '',
      world: scenarioData.world || '',
      tone: scenarioData.tone || '',
      openingSituation: scenarioData.openingSituation || '',
      relationships: scenarioData.relationships || '',
    },
    characters: chars,
    agents: [],
    director: {
      plotOutline: scenarioData.plotOutline || '',
      suggestedEveryNReplies: 6,
    },
  };
  // Synthesize agents
  pgSetupSynthesizeAgents(profile);
  return profile;
}

// ----- Parse M1 Stage 2 text output (Appendix-2 sections) ------------

function pgSetupParseStage2Text(text) {
  if (!text) return {};
  var result = { coreSeed: '', world: '', relationships: '', plotOutline: '' };
  // Split on ## headers
  var sections = text.split(/^##\s+/m);
  for (var si = 0; si < sections.length; si++) {
    var sec = sections[si].trim();
    if (!sec) continue;
    var lines = sec.split('\n');
    var header = lines[0].trim();
    var body = lines.slice(1).join('\n').trim();
    if (header.indexOf('核心种子') >= 0 || header.indexOf('core seed') >= 0) {
      result.coreSeed = body;
    } else if (header.indexOf('角色动力学') >= 0) {
      result.relationships = body;
    } else if (header.indexOf('世界观') >= 0 || header.indexOf('world') >= 0) {
      result.world = body;
    } else if (header.indexOf('三幕') >= 0 || header.indexOf('plot') >= 0) {
      result.plotOutline = body;
    }
  }
  return result;
}

// =====================================================================
// WIZARD UI
// =====================================================================

// ----- pgOpenSetupWizard: entry point --------------------------------

function pgOpenSetupWizard() {
  var modelWins = pgAutoChatModelWindows();
  if (modelWins.length < 2) {
    pgToast(pgT('Need at least 2 windows with models for group chat'), 'warning');
    return;
  }
  var existing = pgState.autoChat.scenario || pgSetupState.scenario;
  if (existing && existing.characters && existing.characters.length > 0 && existing.scenario) {
    pgSetupState.scenario = existing;
    pgShowModal(
      '<div class="pg-modal-header">' +
        '<span class="pg-modal-title">' + pgEscapeHtml(pgT('AI Scenario Generator')) + '</span>' +
        '<button class="pg-modal-close" onclick="pgCloseModal()">✕</button>' +
      '</div>' +
      '<div class="pg-modal-body" style="max-height:70vh;overflow-y:auto">' +
        pgSetupBuildFinalReviewHTML(existing) +
      '</div>'
    );
    return;
  }
  var N = modelWins.length;

  // Build agent name inputs (one per window)
  var nameInputs = '';
  for (var ni = 0; ni < N; ni++) {
    var existingName = pgWinAt(modelWins[ni]).config.agentName || '';
    nameInputs += '<div style="margin:4px 0">' +
      '<span style="display:inline-block;width:60px;font-size:13px;opacity:0.8">' + pgEscapeHtml(pgT('Window') + ' ' + (ni + 1)) + ':</span>' +
      '<input type="text" id="pg-setup-name-' + ni + '" placeholder="' + pgEscapeHtml(pgT('Agent name (optional)')) + '" value="' + pgEscapeHtml(existingName) + '" style="width:200px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font-size:13px">' +
    '</div>';
  }

  var html =
    '<div class="pg-modal-header">' +
      '<span class="pg-modal-title">' + pgEscapeHtml(pgT('AI Scenario Generator')) + '</span>' +
      '<button class="pg-modal-close" onclick="pgCloseModal()">✕</button>' +
    '</div>' +
    '<div class="pg-modal-body" style="max-height:70vh;overflow-y:auto">' +
      '<style>' +
        '.pg-setup-section { margin-bottom:16px } ' +
        '.pg-setup-section h3 { font-size:14px;margin:0 0 8px 0;opacity:0.9 } ' +
        '.pg-setup-input { width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font-size:13px;box-sizing:border-box } ' +
        '.pg-setup-textarea { width:100%;min-height:60px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font-size:13px;font-family:monospace;box-sizing:border-box;resize:vertical } ' +
        '.pg-setup-card { margin:8px 0;padding:10px;background:var(--bg2);border-radius:6px;border:1px solid var(--border);font-size:13px;line-height:1.5 } ' +
        '.pg-setup-card h4 { margin:0 0 4px 0;font-size:14px } ' +
        '.pg-setup-rationale { font-size:12px;opacity:0.7;margin-top:4px;padding:4px;background:var(--bg);border-radius:3px } ' +
        '.pg-setup-btn-row { display:flex;gap:8px;margin-top:8px;flex-wrap:wrap } ' +
      '</style>' +

      // Mode selection
      '<div class="pg-setup-section">' +
        '<h3>' + pgEscapeHtml(pgT('Mode')) + '</h3>' +
        '<select id="pg-setup-mode" class="pg-setup-input" style="width:auto;min-width:160px">' +
          '<option value="M1">M1 - ' + pgEscapeHtml(pgT('5-stage (most control)')) + '</option>' +
          '<option value="M2" selected>M2 - ' + pgEscapeHtml(pgT('2-step (balanced)')) + '</option>' +
          '<option value="M3">M3 - ' + pgEscapeHtml(pgT('1-step (fastest)')) + '</option>' +
        '</select>' +
      '</div>' +

      // Seed inputs
      '<div class="pg-setup-section">' +
        '<h3>' + pgEscapeHtml(pgT('Seed Inputs')) + '</h3>' +
        '<div style="margin:4px 0"><input type="text" id="pg-setup-topic" class="pg-setup-input" placeholder="' + pgEscapeHtml(pgT('Topic (e.g. Sci-fi detective)')) + '"></div>' +
        '<div style="margin:4px 0"><input type="text" id="pg-setup-genre" class="pg-setup-input" placeholder="' + pgEscapeHtml(pgT('Genre (e.g. mystery/thriller)')) + '"></div>' +
        '<div style="margin:4px 0"><textarea id="pg-setup-guidance" class="pg-setup-textarea" placeholder="' + pgEscapeHtml(pgT('Guidance / plot outline (optional)')) + '"></textarea></div>' +
      '</div>' +

      // Agent names
      '<div class="pg-setup-section">' +
        '<h3>' + pgEscapeHtml(pgT('Agent Names')) + ' (' + N + ' ' + pgEscapeHtml(pgT('windows')) + ')</h3>' +
        nameInputs +
        '<div style="font-size:12px;opacity:0.6;margin-top:4px">' + pgEscapeHtml(pgT('Leave blank for AI-generated names')) + '</div>' +
      '</div>' +

      // Model selection
      '<div class="pg-setup-section">' +
        '<h3>' + pgEscapeHtml(pgT('Model')) + '</h3>' +
        '<button class="pg-btn pg-model-btn" id="pg-setup-model-btn" onclick="pgSetupOpenModelPicker()" style="width:100%;text-align:left;justify-content:flex-start">' + pgEscapeHtml(pgSetupState.model || pgT('Default (first window model)')) + ' <span style="float:right;opacity:0.5">▼</span></button>' +
      '</div>' +

      // Generate button
      '<button class="pg-btn" id="pg-setup-generate-btn" onclick="pgSetupGenerate()" style="width:100%;padding:10px;background:var(--accent);color:#fff;font-size:14px;font-weight:bold;border:none;border-radius:6px;cursor:pointer">' +
        pgEscapeHtml(pgT('Generate Scenario')) +
      '</button>' +

      // Stage area (replaced during generation)
      '<div id="pg-setup-stage-area" style="margin-top:12px"></div>' +
    '</div>';

  pgShowModal(html);
}

function pgSetupOpenModelPicker() {
  pgOpenModelPicker(pgSetupState.model, function(v) {
    pgSetupState.model = v;
    var btn = document.getElementById('pg-setup-model-btn');
    if (btn) btn.innerHTML = pgEscapeHtml(v || pgT('Default (first window model)')) + ' <span style="float:right;opacity:0.5">▼</span>';
  }, { allowEmpty: true });
}

function pgSetupReset() {
  pgSetupState.scenario = null;
  pgSetupState.characters = [];
  pgSetupState.stageResults = [];
  pgSetupState.currentStage = 0;
  pgSetupState._importProfile = null;
  pgState.autoChat.scenario = null;
  pgSaveScenario();
  pgCloseModal();
  pgOpenSetupWizard();
}

// ----- pgSetupGenerate: dispatch generation by mode -------------------

function pgSetupGenerate() {
  // Collect seed inputs
  var topicEl = document.getElementById('pg-setup-topic');
  var genreEl = document.getElementById('pg-setup-genre');
  var guidanceEl = document.getElementById('pg-setup-guidance');
  var modeEl = document.getElementById('pg-setup-mode');
  var topic = topicEl ? topicEl.value.trim() : '';
  var genre = genreEl ? genreEl.value.trim() : '';
  var guidance = guidanceEl ? guidanceEl.value.trim() : '';
  var mode = modeEl ? modeEl.value : 'M2';

  // Collect agent names
  var modelWins = pgAutoChatModelWindows();
  var userNames = [];
  for (var ni = 0; ni < modelWins.length; ni++) {
    var nameEl = document.getElementById('pg-setup-name-' + ni);
    userNames.push(nameEl ? nameEl.value.trim() : '');
  }

  pgSetupState.mode = mode;
  pgSetupState.seed = { topic: topic, genre: genre, guidance: guidance, userNames: userNames };
  pgSetupState.stageResults = [];
  pgSetupState.currentStage = 0;
  pgSetupState.scenario = null;
  pgSetupState.characters = [];
  pgSetupState._importProfile = null;

  // Disable generate button
  var genBtn = document.getElementById('pg-setup-generate-btn');
  if (genBtn) { genBtn.disabled = true; genBtn.style.opacity = '0.5'; }

  if (mode === 'M1') {
    pgSetupM1RunStage1();
  } else if (mode === 'M2') {
    pgSetupM2Step1();
  } else {
    pgSetupM3Step1();
  }
}

function pgSetupGenerateDone() {
  var genBtn = document.getElementById('pg-setup-generate-btn');
  if (genBtn) { genBtn.disabled = false; genBtn.style.opacity = '1'; }
}

// =====================================================================
// M1: 5-stage pipeline
// =====================================================================

function pgSetupM1RunStage1() {
  var seed = pgSetupState.seed;
  var userMsg = seed.topic || seed.genre || seed.guidance
    ? JSON.stringify({ topic: seed.topic, genre: seed.genre, guidance: seed.guidance })
    : pgT('No input, please be creative');
  pgSetupRenderStageUI(1, 5, pgT('Generating direction...'), false);
  pgSetupCallLLM(PG_SETUP_APP1, userMsg, 60000).then(function(content) {
    var parsed = pgSetupExtractJSON(content);
    if (!parsed) {
      pgSetupRenderStageError(pgT('Failed to parse direction JSON'), 'pgSetupM1RunStage1');
      return;
    }
    // Merge seed with AI-generated direction
    pgSetupState.seed.topic = parsed.topic || pgSetupState.seed.topic;
    pgSetupState.seed.genre = parsed.genre || pgSetupState.seed.genre;
    pgSetupState.seed.guidance = parsed.guidance || pgSetupState.seed.guidance;
    pgSetupState.stageResults[0] = { rawText: content, parsed: parsed };
    pgToast(pgT('Stage 1 complete'), 'success');
    pgSetupRenderStageUI(1, 5, content, true);
  }).catch(function(err) {
    pgSetupRenderStageError(pgT('Stage 1 failed') + ': ' + err.message, 'pgSetupM1RunStage1');
  });
}

function pgSetupM1RunStage2() {
  var seed = pgSetupState.seed;
  var N = pgAutoChatModelWindows().length;
  var userMsg = JSON.stringify({
    topic: seed.topic || '',
    genre: seed.genre || '',
    guidance: seed.guidance || '',
  }) + '\n\n核心角色数请贴近 ' + N + ' 个';
  pgSetupRenderStageUI(2, 5, pgT('Generating architecture...'), false);
  pgSetupCallLLM(PG_SETUP_APP2, userMsg, 60000).then(function(content) {
    var parsed = pgSetupParseStage2Text(content);
    pgSetupState.stageResults[1] = { rawText: content, parsed: parsed };
    pgToast(pgT('Stage 2 complete'), 'success');
    pgSetupRenderStageUI(2, 5, content, true);
  }).catch(function(err) {
    pgSetupRenderStageError(pgT('Stage 2 failed') + ': ' + err.message, 'pgSetupM1RunStage2');
  });
}

function pgSetupM1RunStage3() {
  var N = pgAutoChatModelWindows().length;
  var stage2 = pgSetupState.stageResults[1];
  var stage2Parsed = stage2 ? stage2.parsed : {};
  var seed = pgSetupState.seed;

  // Build overall requirement from stage 2 + user agent names
  var requirement = '核心种子：' + (stage2Parsed.coreSeed || '') + '\n世界观：' + (stage2Parsed.world || '');
  var nameHint = '';
  var userNames = seed.userNames || [];
  var filledNames = [];
  for (var ni = 0; ni < userNames.length; ni++) {
    if (userNames[ni]) filledNames.push(userNames[ni]);
  }
  if (filledNames.length) {
    nameHint = '\n请采用以下名称（顺序对应，数量=' + filledNames.length + '）：' + filledNames.join(', ');
  }
  requirement += nameHint;

  var userMsg = 'type=character, count=' + N + '\n\n整体要求：\n' + requirement;
  pgSetupRenderStageUI(3, 5, pgT('Generating character profiles...'), false);
  pgSetupCallLLM(PG_SETUP_APP4, userMsg, 60000).then(function(content) {
    var parsed = pgSetupExtractJSON(content);
    if (!parsed || !parsed.profiles) {
      pgSetupRenderStageError(pgT('Failed to parse profiles JSON'), 'pgSetupM1RunStage3');
      return;
    }
    pgSetupState.stageResults[2] = { rawText: content, parsed: parsed };
    pgToast(pgT('Stage 3 complete'), 'success');
    pgSetupRenderStageUI(3, 5, JSON.stringify(parsed.profiles, null, 2), true);
  }).catch(function(err) {
    pgSetupRenderStageError(pgT('Stage 3 failed') + ': ' + err.message, 'pgSetupM1RunStage3');
  });
}

function pgSetupM1RunStage4() {
  var stage3 = pgSetupState.stageResults[2];
  var profiles = stage3 ? stage3.parsed.profiles : [];
  if (!profiles.length) {
    pgToast(pgT('No profiles from stage 3'), 'warning');
    return;
  }
  var stage2 = pgSetupState.stageResults[1];
  var stage2Parsed = stage2 ? stage2.parsed : {};
  var requirement = '核心种子：' + (stage2Parsed.coreSeed || '') + '\n世界观：' + (stage2Parsed.world || '');

  // User message: profiles array + overall requirement + personaAxes追加
  var userMsg = 'type=character\n\n侧写列表：\n' + JSON.stringify(profiles, null, 2) + '\n\n';
  userMsg += '整体要求：\n' + requirement + '\n\n';
  userMsg += PG_SETUP_PERSONA_AXES_NOTE;

  // Build modified Appendix-5 with personaAxes追加
  var app5Modified = PG_SETUP_APP5_BASE + '\n\n## 追加要求\n' + PG_SETUP_PERSONA_AXES_NOTE;

  pgSetupRenderStageUI(4, 5, pgT('Expanding characters...'), false);
  pgSetupCallLLM(app5Modified, userMsg, 90000).then(function(content) {
    var parsed = pgSetupExtractJSON(content);
    if (!parsed || !Array.isArray(parsed)) {
      pgSetupRenderStageError(pgT('Failed to parse character cards'), 'pgSetupM1RunStage4');
      return;
    }
    pgSetupState.stageResults[3] = { rawText: content, parsed: parsed };
    // Ensure every card has personaAxes
    for (var ci = 0; ci < parsed.length; ci++) {
      if (!parsed[ci].personaAxes) {
        parsed[ci].personaAxes = { conventionality: 5, expressiveness: 5, verbosity: 5 };
      }
    }
    pgSetupState.characters = parsed;
    pgToast(pgT('Stage 4 complete'), 'success');
    pgSetupRenderStageUI(4, 5, JSON.stringify(parsed, null, 2), true);
  }).catch(function(err) {
    pgSetupRenderStageError(pgT('Stage 4 failed') + ': ' + err.message, 'pgSetupM1RunStage4');
  });
}

function pgSetupM1RunStage5() {
  // Client-side synthesis (no LLM)
  var stage2 = pgSetupState.stageResults[1];
  var stage2Parsed = stage2 ? stage2.parsed : {};
  var stage2Raw = stage2 ? stage2.rawText : '';
  var chars = pgSetupState.characters;
  if (!chars.length) {
    pgToast(pgT('No characters from stage 4'), 'warning');
    return;
  }

  // Build scenario from stage 2 + stage 1
  var stage1 = pgSetupState.stageResults[0];
  var stage1Parsed = stage1 ? stage1.parsed : {};
  var seed = pgSetupState.seed;

  var scenario = {
    coreSeed: stage2Parsed.coreSeed || '',
    world: stage2Parsed.world || '',
    tone: seed.genre || (stage1Parsed ? stage1Parsed.genre : '') || '',
    openingSituation: '',
    relationships: stage2Parsed.relationships || '',
    plotOutline: stage2Parsed.plotOutline || '',
  };

  // Generate openingSituation from tone + coreSeed
  if (scenario.coreSeed) {
    scenario.openingSituation = '【' + (scenario.tone || '故事') + '开始】' + scenario.coreSeed.split('，')[0] + '……';
  }

  pgSetupState.scenario = scenario;
  var profile = pgSetupBuildProfile();
  if (!profile) {
    pgToast(pgT('Synthesis failed'), 'error');
    return;
  }
  pgSetupState.scenario = profile;
  pgSetupState.stageResults[4] = { rawText: '', parsed: profile };

  // Show final review
  pgSetupRenderFinalReview();
  pgToast(pgT('Scenario ready'), 'success');
}

// =====================================================================
// M2: 2-step pipeline
// =====================================================================

function pgSetupM2Step1() {
  var seed = pgSetupState.seed;
  var N = pgAutoChatModelWindows().length;
  var prompt = PG_SETUP_M2_PROMPT.replace(/N/g, String(N));

  var userMsg = '';
  if (seed.topic || seed.genre || seed.guidance) {
    userMsg += '主题：' + (seed.topic || '') + '\n类型：' + (seed.genre || '') + '\n梗概：' + (seed.guidance || '') + '\n';
  }
  var userNames = seed.userNames || [];
  var filledNames = [];
  for (var ni = 0; ni < userNames.length; ni++) {
    if (userNames[ni]) filledNames.push(userNames[ni]);
  }
  if (filledNames.length) {
    userMsg += '人物名（请采用）：' + filledNames.join(', ') + '\n';
  }
  userMsg += '\n请为 ' + N + ' 个人物设计场景与侧写。';
  if (!seed.topic && !seed.genre && !seed.guidance) {
    userMsg = pgT('No input, please be creative') + ' (' + N + ' ' + pgT('characters') + ')';
  }

  pgSetupRenderStageUI(1, 2, pgT('Generating scenario & profiles...'), false);
  pgSetupCallLLM(prompt, userMsg, 90000).then(function(content) {
    var parsed = pgSetupExtractJSON(content);
    if (!parsed || !parsed.scenario || !parsed.profiles) {
      pgSetupRenderStageError(pgT('Failed to parse M2 output'), 'pgSetupM2Step1');
      return;
    }
    pgSetupState.stageResults[0] = { rawText: content, parsed: parsed };
    // Store scenario skeleton
    pgSetupState.scenario = parsed.scenario;
    pgToast(pgT('Step 1 complete'), 'success');
    pgSetupRenderStageUI(1, 2, JSON.stringify(parsed, null, 2), true);
  }).catch(function(err) {
    pgSetupRenderStageError(pgT('Step 1 failed') + ': ' + err.message, 'pgSetupM2Step1');
  });
}

function pgSetupM2Step2() {
  var stage1 = pgSetupState.stageResults[0];
  if (!stage1 || !stage1.parsed) {
    pgToast(pgT('No stage 1 results'), 'warning');
    return;
  }
  var scenarioObj = stage1.parsed.scenario || {};
  var profiles = stage1.parsed.profiles || [];
  if (!profiles.length) {
    pgToast(pgT('No profiles from step 1'), 'warning');
    return;
  }

  // Build user message: profiles + scenario context + personaAxes
  var requirement = '核心种子：' + (scenarioObj.coreSeed || '') + '\n世界观：' + (scenarioObj.world || '');
  var userMsg = 'type=character\n\n侧写列表：\n' + JSON.stringify(profiles, null, 2) + '\n\n';
  userMsg += '整体要求：\n' + requirement + '\n\n';
  userMsg += PG_SETUP_PERSONA_AXES_NOTE;

  var app5Modified = PG_SETUP_APP5_BASE + '\n\n## 追加要求\n' + PG_SETUP_PERSONA_AXES_NOTE;

  pgSetupRenderStageUI(2, 2, pgT('Expanding characters...'), false);
  pgSetupCallLLM(app5Modified, userMsg, 90000).then(function(content) {
    var parsed = pgSetupExtractJSON(content);
    if (!parsed || !Array.isArray(parsed)) {
      pgSetupRenderStageError(pgT('Failed to parse character cards'), 'pgSetupM2Step2');
      return;
    }
    // Ensure personaAxes
    for (var ci = 0; ci < parsed.length; ci++) {
      if (!parsed[ci].personaAxes) {
        parsed[ci].personaAxes = { conventionality: 5, expressiveness: 5, verbosity: 5 };
      }
    }
    pgSetupState.characters = parsed;
    pgSetupState.scenario = scenarioObj;
    pgSetupState.stageResults[1] = { rawText: content, parsed: parsed };

    // Build final profile
    var profile = pgSetupBuildProfile();
    if (!profile) {
      pgToast(pgT('Synthesis failed'), 'error');
      return;
    }
    pgSetupState.scenario = profile;

    pgSetupRenderFinalReview();
    pgToast(pgT('Scenario ready'), 'success');
  }).catch(function(err) {
    pgSetupRenderStageError(pgT('Step 2 failed') + ': ' + err.message, 'pgSetupM2Step2');
  });
}

// =====================================================================
// M3: 1-step pipeline
// =====================================================================

function pgSetupM3Step1() {
  var seed = pgSetupState.seed;
  var N = pgAutoChatModelWindows().length;
  var prompt = PG_SETUP_M3_PROMPT.replace(/N/g, String(N));

  var userMsg = '';
  if (seed.topic || seed.genre || seed.guidance) {
    userMsg += '主题：' + (seed.topic || '') + '\n类型：' + (seed.genre || '') + '\n梗概：' + (seed.guidance || '') + '\n';
  }
  var userNames = seed.userNames || [];
  var filledNames = [];
  for (var ni = 0; ni < userNames.length; ni++) {
    if (userNames[ni]) filledNames.push(userNames[ni]);
  }
  if (filledNames.length) {
    userMsg += '人物名（请采用）：' + filledNames.join(', ') + '\n';
  }
  userMsg += '\n请为 ' + N + ' 个人物一次性完成全部设定。';
  if (!seed.topic && !seed.genre && !seed.guidance) {
    userMsg = pgT('No input, please be creative') + ' (' + N + ' ' + pgT('characters') + ')';
  }

  pgSetupRenderStageUI(1, 1, pgT('Generating full scenario...'), false);
  pgSetupCallLLM(prompt, userMsg, 120000).then(function(content) {
    var parsed = pgSetupExtractJSON(content);
    if (!parsed || !parsed.scenario || !parsed.characters) {
      pgSetupRenderStageError(pgT('Failed to parse M3 output'), 'pgSetupM3Step1');
      return;
    }
    // Ensure personaAxes on each character
    var chars = parsed.characters || [];
    for (var ci = 0; ci < chars.length; ci++) {
      if (!chars[ci].personaAxes) {
        chars[ci].personaAxes = { conventionality: 5, expressiveness: 5, verbosity: 5 };
      }
    }
    pgSetupState.scenario = parsed.scenario;
    pgSetupState.characters = chars;
    pgSetupState.stageResults[0] = { rawText: content, parsed: parsed };

    // Build final profile
    var profile = pgSetupBuildProfile();
    if (!profile) {
      pgToast(pgT('Synthesis failed'), 'error');
      return;
    }
    pgSetupState.scenario = profile;

    pgSetupRenderFinalReview();
    pgToast(pgT('Scenario ready'), 'success');
  }).catch(function(err) {
    pgSetupRenderStageError(pgT('Generation failed') + ': ' + err.message, 'pgSetupM3Step1');
  });
}

// =====================================================================
// UI: Stage rendering
// =====================================================================

function pgSetupRenderStageError(msg, retryFn) {
  var area = document.getElementById('pg-setup-stage-area');
  if (!area) return;
  var html = '<div style="margin-top:8px;padding:10px;background:#3a1a1a;border-radius:6px;border:1px solid #c44">';
  html += '<div style="color:#e88;margin-bottom:8px">' + pgEscapeHtml(msg) + '</div>';
  html += '<button class="pg-btn" onclick="' + retryFn + '()">' + pgEscapeHtml(pgT('Retry')) + '</button>';
  html += '</div>';
  area.innerHTML = html;
  pgSetupGenerateDone();
}

function pgSetupGetStageFn(stageNum) {
  var mode = pgSetupState.mode;
  if (mode === 'M1') {
    var fns = ['pgSetupM1RunStage1', 'pgSetupM1RunStage2', 'pgSetupM1RunStage3', 'pgSetupM1RunStage4', 'pgSetupM1RunStage5'];
    return fns[stageNum - 1] || fns[0];
  } else if (mode === 'M2') {
    var fns2 = ['pgSetupM2Step1', 'pgSetupM2Step2'];
    return fns2[stageNum - 1] || fns2[0];
  } else {
    return 'pgSetupM3Step1';
  }
}

// =====================================================================
// UI: Final review
// =====================================================================

function pgSetupRenderFinalReview() {
  var area = document.getElementById('pg-setup-stage-area');
  var profile = pgSetupState.scenario;
  if (!profile || !profile.characters) {
    if (area) area.innerHTML = '<div style="color:#e88;padding:10px">' + pgEscapeHtml(pgT('Failed to build scenario')) + '</div>';
    pgSetupGenerateDone();
    return;
  }

  // Also render in the full modal body (replace the lower portion of the modal)
  var modalBody = document.querySelector('#pg-modal-overlay .pg-modal-body');
  if (modalBody) {
    // Keep the header portion but replace stage area with final review
    var fullHtml = pgSetupBuildFinalReviewHTML(profile);
    var headerHtml = '';
    var hdr = modalBody.querySelector('.pg-setup-section');
    if (hdr) { headerHtml = hdr.parentNode.innerHTML; }
    // Find the stage area and its siblings to reconstruct
    modalBody.innerHTML = fullHtml;
  }

  pgSetupGenerateDone();
}

function pgSetupBuildFinalReviewHTML(profile) {
  var sc = profile.scenario || {};
  var chars = profile.characters || [];
  var agents = profile.agents || [];

  var html =
    '<style>' +
      '.pg-setup-section { margin-bottom:16px } ' +
      '.pg-setup-section h3 { font-size:14px;margin:0 0 8px 0;opacity:0.9 } ' +
      '.pg-setup-card { margin:8px 0;padding:10px;background:var(--bg2);border-radius:6px;border:1px solid var(--border);font-size:13px;line-height:1.5 } ' +
      '.pg-setup-card h4 { margin:0 0 4px 0;font-size:14px } ' +
      '.pg-setup-rationale { font-size:12px;opacity:0.7;margin-top:4px;padding:4px;background:var(--bg);border-radius:3px } ' +
      '.pg-setup-btn-row { display:flex;gap:8px;margin-top:8px;flex-wrap:wrap } ' +
      '.pg-setup-prompt-preview { font-size:12px;background:var(--bg);padding:8px;border-radius:4px;max-height:120px;overflow-y:auto;white-space:pre-wrap;margin-top:4px;font-family:monospace } ' +
    '</style>' +

    // Scenario overview
    '<div class="pg-setup-section">' +
      '<h3>' + pgEscapeHtml(pgT('Scenario Overview')) + '</h3>' +
      '<div class="pg-setup-card">' +
        (sc.coreSeed ? '<div><strong>' + pgEscapeHtml(pgT('Core Seed')) + ':</strong> ' + pgEscapeHtml(sc.coreSeed) + '</div>' : '') +
        (sc.world ? '<div style="margin-top:4px"><strong>' + pgEscapeHtml(pgT('World')) + ':</strong> ' + pgEscapeHtml(sc.world.slice(0, 200)) + '</div>' : '') +
        (sc.tone ? '<div style="margin-top:4px"><strong>' + pgEscapeHtml(pgT('Tone')) + ':</strong> ' + pgEscapeHtml(sc.tone) + '</div>' : '') +
        (sc.relationships ? '<div style="margin-top:4px"><strong>' + pgEscapeHtml(pgT('Relationships')) + ':</strong> ' + pgEscapeHtml(sc.relationships.slice(0, 300)) + '</div>' : '') +
        (sc.openingSituation ? '<div style="margin-top:4px"><strong>' + pgEscapeHtml(pgT('Opening')) + ':</strong> ' + pgEscapeHtml(sc.openingSituation) + '</div>' : '') +
      '</div>' +
    '</div>' +

    // Character cards
    '<div class="pg-setup-section">' +
      '<h3>' + pgEscapeHtml(pgT('Characters')) + ' (' + chars.length + ')</h3>';

  for (var ci = 0; ci < chars.length; ci++) {
    var ch = chars[ci];
    var ag = agents[ci];
    html += '<div class="pg-setup-card" id="pg-setup-card-' + ci + '">';
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start">';
    html += '<h4>' + pgEscapeHtml(ch.name || pgT('Character') + ' ' + (ci + 1)) + '</h4>';
    html += '<div style="display:flex;gap:4px;flex-shrink:0">';
    html += '<button class="pg-btn" style="font-size:12px;padding:2px 8px" onclick="pgSetupRegenCharacter(' + ci + ')">' + pgEscapeHtml(pgT('Regen')) + '</button>';
    html += '<button class="pg-btn" style="font-size:12px;padding:2px 8px" onclick="pgSetupEnrichCharacter(' + ci + ')">' + pgEscapeHtml(pgT('Enrich')) + '</button>';
    html += '</div></div>';

    if (ch.description) {
      html += '<div style="margin-top:4px;font-size:13px">' + pgEscapeHtml(ch.description.slice(0, 200)) + '</div>';
    }

    // Persona axes
    var axes = ch.personaAxes || {};
    html += '<div style="margin-top:4px;font-size:12px;opacity:0.8">';
    html += 'C=' + (axes.conventionality != null ? axes.conventionality : '-') + ' ';
    html += 'E=' + (axes.expressiveness != null ? axes.expressiveness : '-') + ' ';
    html += 'V=' + (axes.verbosity != null ? axes.verbosity : '-');
    html += '</div>';

    // Params rationale
    if (ag && ag.paramsRationale) {
      html += '<div class="pg-setup-rationale">' + pgEscapeHtml(ag.paramsRationale) + '</div>';
    }

    // SystemPrompt preview (collapsible)
    if (ag && ag.systemPrompt) {
      html += '<div style="margin-top:4px">';
      html += '<button class="pg-btn" style="font-size:11px;padding:1px 6px" onclick="var e=document.getElementById(\'pg-setup-prompt-' + ci + '\');e.style.display=e.style.display===\'none\'?\'block\':\'none\'">' + pgEscapeHtml(pgT('Toggle prompt')) + '</button>';
      html += '<div class="pg-setup-prompt-preview" id="pg-setup-prompt-' + ci + '" style="display:none">' + pgEscapeHtml(ag.systemPrompt) + '</div>';
      html += '</div>';
    }

    html += '</div>';
  }

  // Action buttons
  html += '</div>' +
    '<div class="pg-setup-btn-row" style="margin-top:16px">' +
      '<button class="pg-btn" onclick="pgSetupApplyProfile(pgSetupState.scenario)" style="background:var(--accent);color:#fff;padding:8px 16px">' + pgEscapeHtml(pgT('Apply to Windows')) + '</button>' +
      '<button class="pg-btn" onclick="pgSetupExportProfile(pgSetupState.scenario)">' + pgEscapeHtml(pgT('Export')) + '</button>' +
      '<button class="pg-btn" onclick="document.getElementById(\'pg-setup-import-input\').click()">' + pgEscapeHtml(pgT('Import')) + '</button>' +
      '<input type="file" id="pg-setup-import-input" accept=".json" style="display:none" onchange="pgSetupImportProfile(this.files[0])">' +
      '<button class="pg-btn" onclick="pgSetupReset()">' + pgEscapeHtml(pgT('Reset')) + '</button>' +
    '</div>';

  return html;
}

// =====================================================================
// Helper: render M1/M2 stage content into modal
// =====================================================================

function pgSetupRenderStageUI(stageNum, totalStages, content, showNext) {
  var area = document.getElementById('pg-setup-stage-area');
  if (!area) return;
  var isLastStage = stageNum >= totalStages;
  var mode = pgSetupState.mode;

  var stageLabel = mode === 'M1' ? (pgT('Stage') + ' ' + stageNum + '/' + totalStages)
    : mode === 'M2' ? (pgT('Step') + ' ' + stageNum + '/' + totalStages)
    : (pgT('Step') + ' 1/1');

  var html = '<div style="margin-top:8px;padding:10px;background:var(--bg2);border-radius:6px;border:1px solid var(--border)">';
  html += '<div style="font-size:13px;font-weight:bold;margin-bottom:8px">' + pgEscapeHtml(stageLabel) + '</div>';

  if (typeof content === 'string' && content.length > 0 && content.indexOf(pgT('Generating')) !== 0 && content.indexOf(pgT('No input')) !== 0) {
    html += '<textarea class="pg-setup-textarea" id="pg-setup-stage-text" style="min-height:150px;font-size:12px" readonly>' + pgEscapeHtml(content) + '</textarea>';
  } else {
    html += '<div style="padding:20px;text-align:center;opacity:0.7">' + pgEscapeHtml(content) + '</div>';
  }

  if (showNext) {
    if (isLastStage) {
      // M1 stage 5 or last step - no "next" button, just retry
      html += '<div class="pg-setup-btn-row">';
      html += '<button class="pg-btn" onclick="' + pgSetupGetStageFn(stageNum) + '()">' + pgEscapeHtml(pgT('Retry')) + '</button>';
      html += '</div>';
    } else {
      var nextFn = pgSetupGetStageFn(stageNum + 1);
      html += '<div class="pg-setup-btn-row">';
      html += '<button class="pg-btn" onclick="' + nextFn + '()" style="background:var(--accent);color:#fff">' + pgEscapeHtml(pgT('Next')) + ' →</button>';
      html += '<button class="pg-btn" onclick="' + pgSetupGetStageFn(stageNum) + '()">' + pgEscapeHtml(pgT('Retry')) + '</button>';
      html += '</div>';
    }
  }

  html += '</div>';
  area.innerHTML = html;
  pgSetupGenerateDone();
}

// ----- Re-run the current stage (unified retry) -----------------------
// Each stage function is self-contained and re-runnable.
// pgSetupGetStageFn maps stage num to the correct function name.