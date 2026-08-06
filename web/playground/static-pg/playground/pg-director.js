// pg-director.js — Director / Narrator subsystem (Phase B)
// =====================================================================
// Depends on: pg-state (pgState, pgSaveAutoChat), pg-autochat (pgAutoChatAppendTimeline,
//   pgAutoChatProcessWindowInbox, pgAutoChatModelWindows, pgUpdateAutoChatUI,
//   pgGcRefreshModalIncremental), pg-core (pgToast, pgEscapeHtml)
// =====================================================================

// ----- Module-level state -----------------------------------------------

var pgDirRepliesSinceEval = 0;
var pgDirNarrationCount = 0;
var pgDirEvalInFlight = false;
var pgDirNarratorPending = false;
var pgDirFinalChanceUsed = false;
var pgDirEvalAbort = null;
var pgDirNarrAbort = null;
var pgDirLastNarration = '';
var pgDirLastReason = '';
var pgDirEvalTimer = null;
var pgDirNarrTimer = null;

// ----- Director prompt (§5.2, verbatim) --------------------------------

var PG_DIRECTOR_SYSTEM_PROMPT =
  '你是群聊角色扮演的「剧情导演」。你会周期性收到一段多角色对话的近况，\n' +
  '你的唯一职责是判断：此刻是否需要一次旁白介入来推进剧情。\n' +
  '\n' +
  '## 判断标准（按优先级）\n' +
  '1. 停滞：角色们在原地寒暄、互相重复、礼貌性空转，超过约 3 轮没有新信息。\n' +
  '2. 连续 <pass/>：多个角色相继选择不发言（输出 <pass/>），表明无话可说或无人接话——需要旁白投放新刺激。这是比寒暄更强的停滞信号。\n' +
  '3. 收敛过快：冲突刚起就要和解、谜题刚抛出就被解决——需要投放阻碍或反转。\n' +
  '4. 偏轨：对话严重偏离场景核心矛盾（若提供了剧情大纲，以大纲为准）。\n' +
  '5. 节奏良好：角色间张力上升、信息持续更新——此时【不要】介入，让对话继续。\n' +
  '\n' +
  '## 介入方式的克制原则\n' +
  '- 宁少勿多。连续两次评估都判 advance 是异常信号，第二次应倾向 continue。\n' +
  '- 推进方向只给「发生了什么」的一句话指令，不写正文（正文由旁白执笔者完成）。\n' +
  '- 方向必须是环境/事件层面的（有人闯入、传来消息、场景突变、时限逼近），\n' +
  '  不得替任何角色决定其想法或台词。\n' +
  '\n' +
  '## 输入\n' +
  '你将收到：场景背景、剧情大纲（可能为空）、最近的对话记录（其中角色选择不发言的 `<pass/>` 显示为『<角色名> 选择不发言』）、\n' +
  '已进行的旁白次数与上次旁白内容（可能为空）。\n' +
  '\n' +
  '## 输出格式（严格遵守，只输出以下 JSON，不要围栏、不要解释）\n' +
  '{"decision":"advance"或"continue","reason":"一句话理由","direction":"仅当 advance 时给出的一句话推进指令，否则空字符串"}';

// ----- Narrator prompt (§5.4, verbatim) --------------------------------

var PG_NARRATOR_SYSTEM_PROMPT_TEMPLATE =
  '你是群聊角色扮演的「旁白执笔者」。导演已决定推进剧情，指令是：{direction}\n' +
  '\n' +
  '## 写作要求\n' +
  '- 以第三人称全知视角写一段 50-150 字的旁白：环境变化、突发事件或场景转换。\n' +
  '- 只描写「世界发生了什么」，绝不替任何角色说话、行动或下决定。\n' +
  '- 与场景基调一致：{scenario.tone}。承接最近的对话情境，不突兀、不重复已有信息。\n' +
  '- 结尾应留下让角色们不得不回应的钩子（一个新事实、一声异响、一个抉择时刻）。\n' +
  '\n' +
  '## 输出\n' +
  '直接输出旁白正文，不要任何前缀、引号、解释或格式标记。';

// ----- Helpers -----------------------------------------------------------

function pgDirectorSerializeTimelineTail(n) {
  var timeline = pgState.autoChat.timeline;
  var lines = [];
  var count = 0;
  for (var i = timeline.length - 1; i >= 0 && count < n; i--) {
    var e = timeline[i];
    if (e.status === 'error') continue;
    count++;
    if (e.senderType === 'agent') {
      if (e.status === 'pass') {
        lines.unshift(e.sender + ' 选择不发言');
      } else {
        lines.unshift(e.sender + ': ' + e.content);
      }
    } else if (e.senderType === 'user') {
      lines.unshift(e.sender + ': ' + e.content);
    } else if (e.senderType === 'system') {
      lines.unshift(e.content);
    } else if (e.senderType === 'narrator') {
      lines.unshift('旁白: ' + e.content);
    } else {
      lines.unshift('[' + e.sender + ']: ' + e.content);
    }
  }
  return lines.join('\n');
}

function pgDirectorExtractJson(raw) {
  if (!raw) return null;
  var s = raw.trim();
  // Remove ```json or ``` fences.
  s = s.replace(/^```(?:json)?\s*/i, '');
  s = s.replace(/\s*```\s*$/, '');
  s = s.trim();
  // Find the first balanced { ... }.
  var start = s.indexOf('{');
  if (start < 0) return null;
  var depth = 0;
  var inStr = false;
  var escape = false;
  for (var i = start; i < s.length; i++) {
    var ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) {
      try {
        return JSON.parse(s.substring(start, i + 1));
      } catch (e) {
        return null;
      }
    }
  }
  return null;
}

function pgDirectorResolveModel(prefer) {
  if (prefer) return prefer;
  var wins = pgAutoChatModelWindows();
  if (wins.length > 0) {
    var w = pgWinAt(wins[0]);
    if (w && w.config.model) return w.config.model;
  }
  return '';
}

// ----- Director evaluation (triggered by pgDirectorOnAgentReply) --------

function pgDirectorBuildUserMessage() {
  var scenario = pgState.autoChat.scenario;
  var bgText = '';
  var outlineText = '';

  if (scenario && scenario.scenario) {
    var s = scenario.scenario;
    bgText = (s.coreSeed || '') + ' ' + (s.world || '');
    outlineText = (scenario.director && scenario.director.plotOutline) || '（无）';
  } else {
    // Fallback: collect system prompts from all windows.
    var excerpts = [];
    for (var i = 0; i < pgState.splitCount; i++) {
      var w = pgWinAt(i);
      if (w && w.config.systemPrompt) {
        excerpts.push(w.config.systemPrompt.substring(0, 200));
      }
    }
    bgText = excerpts.join('\n') || '（无场景档案）';
    outlineText = '（无）';
  }

  var recent = pgDirectorSerializeTimelineTail(20);
  var lines = [];
  lines.push('场景背景：' + bgText);
  lines.push('剧情大纲：' + outlineText);
  lines.push('最近的对话记录：');
  lines.push(recent);
  lines.push('已进行的旁白次数：' + pgDirNarrationCount);
  lines.push('上次旁白内容：' + (pgDirLastNarration || '（无）'));
  return lines.join('\n');
}

function pgDirectorOnAgentReply(winIdx) {
  pgDirRepliesSinceEval++;
  var d = pgState.autoChat.director;
  if (!d.enabled) return;
  if (pgDirRepliesSinceEval < d.everyNReplies) return;
  if (pgDirEvalInFlight) return;

  // Resolve model
  var model = pgDirectorResolveModel(d.directorModel);
  if (!model) {
    pgToast(pgT('pgDirectorNoModel'), 'warning');
    return;
  }

  pgDirEvalInFlight = true;
  var capturedSession = pgState.autoChat.session;

  var userContent = pgDirectorBuildUserMessage();
  var body = {
    model: model,
    messages: [
      { role: 'system', content: PG_DIRECTOR_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    stream: false,
  };

  pgDirEvalAbort = new AbortController();
  var timer = setTimeout(function() {
    if (pgDirEvalAbort) pgDirEvalAbort.abort();
  }, 30000);
  pgDirEvalTimer = timer;

  fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: pgDirEvalAbort.signal,
  }).then(function(resp) {
    return resp.json();
  }).then(function(j) {
    if (capturedSession !== pgState.autoChat.session) return;
    if (!pgState.autoChat.isRunning || pgState.autoChat.abortFlag) return;

    var content = (j.choices && j.choices[0] && j.choices[0].message)
      ? j.choices[0].message.content : '';
    if (!content) return;

    var parsed = pgDirectorExtractJson(content);
    if (!parsed) return;

    var decision = parsed.decision || 'continue';
    var reason = parsed.reason || '';
    var direction = parsed.direction || '';

    pgDirRepliesSinceEval = 0;
    pgDirEvalInFlight = false;
    pgDirLastReason = reason;

    if (decision === 'advance') {
      var maxN = d.maxNarrations;
      if (maxN === 0 || pgDirNarrationCount < maxN) {
        pgDirectorRunNarrator(direction);
      }
    }
  }).catch(function(e) {
    // Silent — timeout or network error, skip this evaluation cycle.
  }).finally(function() {
    pgDirEvalInFlight = false;
    if (pgDirEvalTimer) {
      clearTimeout(pgDirEvalTimer);
      pgDirEvalTimer = null;
    }
  });
}

// ----- Narrator generation ----------------------------------------------

function pgDirectorRunNarrator(direction) {
  pgDirNarratorPending = true;
  if (typeof pgUpdateAutoChatUI === 'function') pgUpdateAutoChatUI();

  var d = pgState.autoChat.director;
  var model = pgDirectorResolveModel(d.narratorModel || d.directorModel);
  if (!model) {
    pgDirNarratorPending = false;
    pgToast(pgT('pgDirectorNoModel'), 'warning');
    return;
  }

  var scenario = pgState.autoChat.scenario;
  var tone = (scenario && scenario.scenario && scenario.scenario.tone) || '默认';

  var systemPrompt = PG_NARRATOR_SYSTEM_PROMPT_TEMPLATE
    .replace('{direction}', direction || '自由推进')
    .replace('{scenario.tone}', tone);

  // Build user message: direction + recent context
  var recentLines = pgDirectorSerializeTimelineTail(10);
  var userMsg = (direction || '自由推进') + '\n\n最近的对话情境：\n' + recentLines;

  var body = {
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ],
    stream: false,
  };

  pgDirNarrAbort = new AbortController();
  var timer = setTimeout(function() {
    if (pgDirNarrAbort) pgDirNarrAbort.abort();
  }, 60000);
  pgDirNarrTimer = timer;

  var capturedSession = pgState.autoChat.session;

  fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: pgDirNarrAbort.signal,
  }).then(function(resp) {
    return resp.json();
  }).then(function(j) {
    if (capturedSession !== pgState.autoChat.session) return;
    if (!pgState.autoChat.isRunning || pgState.autoChat.abortFlag) return;

    var content = (j.choices && j.choices[0] && j.choices[0].message)
      ? j.choices[0].message.content : '';
    if (!content) return;

    // Strip surrounding quotes / fences if present.
    content = content.trim();
    content = content.replace(/^```(?:json)?\s*/i, '');
    content = content.replace(/\s*```\s*$/, '');
    content = content.replace(/^["']|["']$/g, '');

    pgAutoChatAppendTimeline('旁白', 'narrator', -1, content, 'complete');
    pgDirNarrationCount++;
    pgDirLastNarration = content;
    pgDirNarratorPending = false;

    if (typeof pgUpdateAutoChatUI === 'function') pgUpdateAutoChatUI();
    if (typeof pgGcRefreshModalIncremental === 'function') pgGcRefreshModalIncremental();

    // Broadcast to wake all model windows.
    var wins = pgAutoChatModelWindows();
    for (var k = 0; k < wins.length; k++) {
      if (typeof pgAutoChatProcessWindowInbox === 'function') {
        pgAutoChatProcessWindowInbox(wins[k]);
      }
    }
  }).catch(function(e) {
    // Silent — timeout or network error, skip this narration.
  }).finally(function() {
    pgDirNarratorPending = false;
    if (pgDirNarrTimer) {
      clearTimeout(pgDirNarrTimer);
      pgDirNarrTimer = null;
    }
  });
}

// ----- OnBeforeFinish (final chance evaluation) -------------------------

function pgDirectorOnBeforeFinish() {
  var d = pgState.autoChat.director;
  if (!d.enabled) return false;
  if (pgDirFinalChanceUsed) return false;
  if (d.maxNarrations > 0 && pgDirNarrationCount >= d.maxNarrations) return false;

  // Check if any window can still continue (under iteration limit).
  var wins = pgAutoChatModelWindows();
  var canContinue = wins.some(function(i) {
    var w = pgWinAt(i);
    return w && !w.autoChatDone;
  });
  if (!canContinue) return false;

  pgDirFinalChanceUsed = true;

  // Asynchronously issue a final judgment. Return true immediately to pause finish.
  var model = pgDirectorResolveModel(d.directorModel);
  if (!model) {
    // No model — let finish proceed.
    if (typeof pgAutoChatCheckAllDone === 'function') pgAutoChatCheckAllDone();
    return false;
  }

  var capturedSession = pgState.autoChat.session;
  var userContent = pgDirectorBuildUserMessage() +
    '\n\n对话即将自然结束——若剧情尚未到达合理收束点，请给出推进指令';

  var body = {
    model: model,
    messages: [
      { role: 'system', content: PG_DIRECTOR_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    stream: false,
  };

  pgDirEvalAbort = new AbortController();
  var timer = setTimeout(function() {
    if (pgDirEvalAbort) pgDirEvalAbort.abort();
  }, 30000);
  pgDirEvalTimer = timer;

  fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: pgDirEvalAbort.signal,
  }).then(function(resp) {
    return resp.json();
  }).then(function(j) {
    if (capturedSession !== pgState.autoChat.session) return;
    if (!pgState.autoChat.isRunning || pgState.autoChat.abortFlag) return;

    var content = (j.choices && j.choices[0] && j.choices[0].message)
      ? j.choices[0].message.content : '';
    if (!content) return;

    var parsed = pgDirectorExtractJson(content);
    if (!parsed) return;

    var decision = parsed.decision || 'continue';
    var direction = parsed.direction || '';

    if (decision === 'advance') {
      var maxN = d.maxNarrations;
      if (maxN === 0 || pgDirNarrationCount < maxN) {
        pgDirectorRunNarrator(direction);
        return;
      }
    }

    // If we get here, decision is continue or no narration budget left.
    if (typeof pgAutoChatCheckAllDone === 'function') pgAutoChatCheckAllDone();
  }).catch(function(e) {
    // Silent — let finish proceed.
    if (typeof pgAutoChatCheckAllDone === 'function') pgAutoChatCheckAllDone();
  }).finally(function() {
    if (pgDirEvalTimer) {
      clearTimeout(pgDirEvalTimer);
      pgDirEvalTimer = null;
    }
  });

  return true;
}

// ----- Config setters (called from pg-ui.js Director panel) -------------

function pgDirectorToggle(v) {
  pgState.autoChat.director.enabled = !!v;
  pgSaveAutoChat();
  if (typeof pgUpdateAutoChatUI === 'function') pgUpdateAutoChatUI();
}

function pgDirectorSetDirectorModel(v) {
  pgState.autoChat.director.directorModel = v || '';
  pgSaveAutoChat();
}

function pgDirectorSetNarratorModel(v) {
  pgState.autoChat.director.narratorModel = v || '';
  pgSaveAutoChat();
}

function pgDirectorSetEveryNReplies(v) {
  var n = parseInt(v, 10);
  if (n > 0) {
    pgState.autoChat.director.everyNReplies = n;
    pgSaveAutoChat();
  }
}

function pgDirectorSetMaxNarrations(v) {
  var n = Math.max(0, parseInt(v, 10) || 0);
  pgState.autoChat.director.maxNarrations = n;
  pgSaveAutoChat();
}

// ----- Lifecycle --------------------------------------------------------

function pgDirectorReset() {
  pgDirRepliesSinceEval = 0;
  pgDirNarrationCount = 0;
  pgDirEvalInFlight = false;
  pgDirNarratorPending = false;
  pgDirFinalChanceUsed = false;
  pgDirLastNarration = '';
  pgDirLastReason = '';

  if (pgDirEvalAbort) {
    try { pgDirEvalAbort.abort(); } catch (e) {}
    pgDirEvalAbort = null;
  }
  if (pgDirNarrAbort) {
    try { pgDirNarrAbort.abort(); } catch (e) {}
    pgDirNarrAbort = null;
  }
  if (pgDirEvalTimer) {
    clearTimeout(pgDirEvalTimer);
    pgDirEvalTimer = null;
  }
  if (pgDirNarrTimer) {
    clearTimeout(pgDirNarrTimer);
    pgDirNarrTimer = null;
  }
}

function pgDirectorEvalInFlight() {
  return pgDirEvalInFlight;
}

function pgDirectorNarratorPending() {
  return pgDirNarratorPending;
}