// pg-autochat.js
// =====================================================================
// Auto Chat (群聊) mode — multi-window independent-iteration conversation.
//
// Each window has its OWN reply counter. When a window finishes a reply,
// it immediately broadcasts to other windows' inboxes and checks its own
// inbox. If it has pending messages and hasn't hit the iteration limit,
// it starts a new reply right away — without waiting for slower windows.
//
// An optional random delay (base ± 50%) is applied before each reply
// so that fast and slow models stagger naturally, like real chat.
//
// The conversation ends when ALL windows are either done (hit iteration
// limit) or idle with empty inboxes.
// =====================================================================

// ----- Toggle / config setters --------------------------------------

function pgAutoChatToggle(enabled) {
  if (enabled && pgState.splitCount < 2) {
    pgState.splitCount = 2;
    if (pgState.modeSplitCounts) pgState.modeSplitCounts.autochat = 2;
    while (pgState.windows.length < 2) {
      if (typeof makeWin === 'function') pgState.windows.push(makeWin());
    }
  }
  var wasRunning = pgState.autoChat.isRunning;
  pgState.autoChat.enabled = enabled;
  if (enabled) {
    pgState.mode = 'autochat';
  }
  pgRenderSidebar();
  pgRenderPanes();
  pgRenderInputBar();
  if (!enabled && wasRunning) {
    pgAutoChatStop();
  }
}

function pgAutoChatSetIterations(v) {
  pgState.autoChat.iterations = Math.max(0, parseInt(v, 10) || 0);
  pgSaveAutoChat();
  pgUpdateAutoChatUI();
}

function pgAutoChatSetUserName(v) {
  pgState.autoChat.userName = (v && v.trim()) ? v.trim() : 'User';
  pgSaveAutoChat();
}

function pgAutoChatSetDelay(v) {
  pgState.autoChat.delaySeconds = Math.max(0, parseFloat(v) || 0);
  pgSaveAutoChat();
}

function pgOnAgentName(v) {
  var w = pgWin();
  if (w) {
    w.config.agentName = v || '';
    pgSave();
    pgRenderPanes();
  }
}

// ----- Default group-chat system prompt -------------------------------

// Default rules injected when a window's systemPrompt is empty. Tells agents
// they are in a group chat and may choose not to speak (output <pass/>).
var PG_AUTOCHAT_DEFAULT_SYSTEM_PROMPT =
  'You are a participant in a group chat. ' +
  'Multiple AI agents and a human user are discussing together. ' +
  'Messages from others are prefixed with [name]:. ' +
  'Do NOT add any [name]: prefix to your own replies — just speak directly. ' +
  'If you have nothing meaningful to add at this moment, ' +
  'reply with exactly <pass/> and nothing else. ' +
  'Use <pass/> when others are still discussing a topic you have no strong opinion on.';

// ----- Helpers -------------------------------------------------------

// Strip leading [name]: prefix from model replies (models often mimic the
// input format and prepend their own or others' name in brackets).
function pgAutoChatStripPrefix(content) {
  if (!content) return content;
  return content.replace(/^\s*\[[^\]]+\]\s*:\s*/, '');
}

function pgAutoChatGetAgentName(winIdx) {
  var w = pgWinAt(winIdx);
  var cfgName = w && w.config.agentName ? w.config.agentName : '';
  return cfgName || ('Agent ' + (winIdx + 1));
}

// ----- Shared timeline (single source of truth) ----------------------

// Append an entry to the shared timeline and return it.
function pgAutoChatAppendTimeline(sender, senderType, winIdx, content, status) {
  pgState.autoChat.timelineId++;
  var entry = {
    id: pgState.autoChat.timelineId,
    sender: sender,
    senderType: senderType,
    winIdx: winIdx,
    content: content,
    ts: Date.now(),
    status: status || 'complete',
  };
  pgState.autoChat.timeline.push(entry);
  return entry;
}

// Build the per-window messages perspective from the shared timeline.
// Rules:
//   - own previous replies -> role:assistant (no prefix)
//   - other senders (user / other agents) -> role:user with [sender]: prefix
//   - system entries -> role:system
//   - systemPrompt empty -> inject PG_AUTOCHAT_DEFAULT_SYSTEM_PROMPT
function pgAutoChatRenderPerspective(winIdx) {
  var w = pgWinAt(winIdx);
  var myName = pgAutoChatGetAgentName(winIdx);
  var msgs = [];

  // User-defined systemPrompt takes priority; otherwise inject the default
  // group-chat prompt so agents understand the multi-party context + pass rule.
  var sysPrompt = (w.config.systemPrompt && w.config.systemPrompt.trim())
    ? w.config.systemPrompt
    : PG_AUTOCHAT_DEFAULT_SYSTEM_PROMPT;
  msgs.push({ role: 'system', content: sysPrompt });

  for (var i = 0; i < pgState.autoChat.timeline.length; i++) {
    var entry = pgState.autoChat.timeline[i];

    if (entry.senderType === 'system') {
      msgs.push({ role: 'system', content: entry.content });
    } else if (entry.senderType === 'agent' && entry.winIdx === winIdx) {
      msgs.push({ role: 'assistant', content: entry.content });
    } else if (entry.senderType === 'narrator') {
      msgs.push({ role: 'system', content: '【旁白】' + entry.content });
    } else {
      msgs.push({ role: 'user', content: '[' + entry.sender + ']: ' + entry.content });
    }
  }

  return msgs;
}

// Send using the perspective already rebuilt into w.messages by pgAutoChatDoSend.
function pgAutoChatSendWithPerspective(winIdx, perspectiveMsgs, lastIdx) {
  pgSend(winIdx, lastIdx);
}

// Indices of windows that currently have a model selected.
function pgAutoChatModelWindows() {
  var idx = [];
  for (var i = 0; i < pgState.splitCount; i++) {
    if (pgWinAt(i).config.model) idx.push(i);
  }
  return idx;
}

// Can this window still reply in auto-chat?
function pgAutoChatCanReply(winIdx) {
  var w = pgWinAt(winIdx);
  if (!w || !w.config.model) return false;
  if (w.streaming) return false;
  if (w.autoChatPending) return false;
  if (w.autoChatDone) return false;
  var iters = pgState.autoChat.iterations;
  if (iters > 0 && w.replyCount >= iters) return false;
  return true;
}

// ----- Start ---------------------------------------------------------

function pgAutoChatStart(text) {
  if (typeof pgDirectorReset === 'function') pgDirectorReset();
  var modelWins = pgAutoChatModelWindows();
  if (!modelWins.length) {
    pgToast(pgT('pgSelectModel'), 'warning');
    return;
  }
  pgState.autoChat.session++;
  pgState.autoChat.isRunning = true;
  pgState.autoChat.abortFlag = false;
  pgState.autoChat.timeline = [];        // reset shared timeline
  pgState.autoChat.timelineId = 0;
  pgAutoChatRetryCount = {};             // reset retry counters

  // User message appended to the shared timeline (single source of truth).
  pgAutoChatAppendTimeline(
    pgState.autoChat.userName || 'User',
    'user', -1, text, 'complete'
  );

  // Reset every model window's per-window state.
  modelWins.forEach(function(i) {
    var w = pgWinAt(i);
    w.replyCount = 0;
    w.autoChatDone = false;
    w.autoChatPending = false;
    w.lastReadTimelineId = 0;            // reset read cursor
    if (w.autoChatDelayTimer) { clearTimeout(w.autoChatDelayTimer); w.autoChatDelayTimer = null; }
    w.inbox = [];                        // deprecated field, kept for serialization
    w.messages = [];                     // rebuilt from timeline on each send
  });

  pgSave();
  if (pgState.activeWin < pgState.splitCount) pgRenderSidebar();
  pgRenderInputBar();

  // Kick off all windows that can reply.
  modelWins.forEach(function(i) {
    pgAutoChatProcessWindowInbox(i);
  });
  pgUpdateAutoChatUI();
}

// Schedule a reply for a single window. If a delay is configured, the
// actual send is deferred by a random duration (base ± 50%). Messages
// arriving during the delay accumulate in the inbox and are merged when
// the timer fires.
function pgAutoChatProcessWindowInbox(winIdx) {
  if (!pgAutoChatCanReply(winIdx)) return;
  var w = pgWinAt(winIdx);
  // Unread check is against the shared timeline (replaces the old inbox).
  var hasUnread = pgState.autoChat.timeline.some(function(e) {
    return e.id > w.lastReadTimelineId;
  });
  if (!hasUnread) return;

  var baseDelay = pgState.autoChat.delaySeconds || 0;

  // If the most recent unread timeline message mentions this window by name,
  // shorten its reaction delay to 30% so it responds promptly.
  var myName = pgAutoChatGetAgentName(winIdx);
  var mentioned = false;
  for (var i = pgState.autoChat.timeline.length - 1; i >= 0; i--) {
    var entry = pgState.autoChat.timeline[i];
    if (entry.id <= w.lastReadTimelineId) break;
    if (entry.content && entry.content.indexOf('@' + myName) >= 0) {
      mentioned = true;
      break;
    }
  }
  if (mentioned && baseDelay > 0) {
    baseDelay = baseDelay * 0.3;
  }

  if (baseDelay <= 0) {
    pgAutoChatDoSend(winIdx);
    return;
  }

  // Random delay: base * [0.5, 1.5] in milliseconds.
  var minMs = baseDelay * 500;
  var maxMs = baseDelay * 1500;
  var delay = minMs + Math.random() * (maxMs - minMs);

  w.autoChatPending = true;
  pgUpdateAutoChatUI();

  var capturedSession = pgState.autoChat.session;
  w.autoChatDelayTimer = setTimeout(function() {
    w.autoChatDelayTimer = null;
    w.autoChatPending = false;
    if (capturedSession !== pgState.autoChat.session) return;
    if (pgState.autoChat.abortFlag || !pgState.autoChat.isRunning) return;
    pgAutoChatDoSend(winIdx);
  }, delay);
}

// Actually render the window's perspective from the timeline and send (no delay).
function pgAutoChatDoSend(winIdx) {
  if (!pgAutoChatCanReply(winIdx)) return;
  var w = pgWinAt(winIdx);

  // Unread check against the shared timeline.
  var hasUnread = pgState.autoChat.timeline.some(function(e) {
    return e.id > w.lastReadTimelineId;
  });
  if (!hasUnread) {
    pgAutoChatCheckAllDone();
    return;
  }

  // Rebuild this window's messages view from the timeline.
  var perspectiveMsgs = pgAutoChatRenderPerspective(winIdx);

  // Advance the read cursor to the latest timeline entry.
  var lastEntry = pgState.autoChat.timeline[pgState.autoChat.timeline.length - 1];
  w.lastReadTimelineId = lastEntry ? lastEntry.id : w.lastReadTimelineId;

  // Rebuild the messages render-cache.
  w.messages = perspectiveMsgs.map(function(m) {
    return { role: m.role, content: m.content, status: 'complete' };
  });

  // Append the assistant placeholder that will receive the reply.
  var now = Date.now();
  w.messages.push({ role: 'assistant', content: '', reasoning: '', status: 'loading', startedAt: now });
  var lastIdx = w.messages.length - 1;
  pgRenderMessages(winIdx);

  pgAutoChatSendWithPerspective(winIdx, perspectiveMsgs, lastIdx);
}

// ----- Finish hook (called from pgFinish / pgFail) -------------------

function pgAutoChatOnFinish(winIdx) {
  if (!pgState.autoChat || !pgState.autoChat.isRunning) return;
  if (pgState.autoChat.abortFlag) return;
  var w = pgWinAt(winIdx);
  if (!w) return;

  // Clear this window's retry counter: the reply attempt has completed
  // (success OR pass), so any pending retry state is now stale. This runs
  // regardless of pass vs. normal reply.
  pgAutoChatRetryCount[winIdx] = 0;

  // Read the final reply content (strip leading [name]: prefix).
  var rawContent = pgTextContent(w.messages[w.messages.length - 1].content);
  var content = pgAutoChatStripPrefix(rawContent);

  // Detect a deliberate pass: the agent chose not to speak.
  var isPass = /^\s*<pass\s*\/>\s*$/i.test(content);

  if (isPass) {
    // Pass: record a pass entry on the timeline (visible in the modal) but do
    // NOT count it as a reply and do NOT mark the window done.
    pgAutoChatAppendTimeline(
      pgAutoChatGetAgentName(winIdx), 'agent', winIdx, '', 'pass'
    );
    // Mark the pass entry as read so this window does not re-trigger on itself.
    w.lastReadTimelineId = pgState.autoChat.timelineId;

    if (typeof pgUpdateAutoChatUI === 'function') pgUpdateAutoChatUI();
    if (typeof pgGcRefreshModalIncremental === 'function') pgGcRefreshModalIncremental();

    // Process own inbox + trigger other windows (they may now have unread).
    pgAutoChatProcessWindowInbox(winIdx);
    for (var k = 0; k < pgState.splitCount; k++) {
      if (k === winIdx) continue;
      pgAutoChatProcessWindowInbox(k);
    }

    // A pass does not advance the conversation; still let the done-check run
    // (e.g. everyone passed -> natural end). Pass does NOT trigger summarization.
    pgAutoChatCheckAllDone();

    // Director hook: a pass is a stronger stagnation signal — count it too (guarded).
    if (typeof pgDirectorOnAgentReply === 'function' && pgState.autoChat.isRunning) pgDirectorOnAgentReply(winIdx);
    return;
  }

  // Normal reply: count this reply toward the iteration limit.
  w.replyCount++;

  // Check iteration limit.
  var iters = pgState.autoChat.iterations;
  if (iters > 0 && w.replyCount >= iters) {
    w.autoChatDone = true;
  }

  // Append this window's reply to the shared timeline (replaces broadcast).
  var sender = pgAutoChatGetAgentName(winIdx);
  var replyContent = (content && content.trim()) ? content : pgT('(no response)');
  pgAutoChatAppendTimeline(sender, 'agent', winIdx, replyContent, 'complete');

  // Mark own reply as read so this window does not re-trigger on itself.
  w.lastReadTimelineId = pgState.autoChat.timelineId;

  if (typeof pgUpdateAutoChatUI === 'function') pgUpdateAutoChatUI();
  if (typeof pgGcRefreshModalIncremental === 'function') pgGcRefreshModalIncremental();

  // Try to process this window's own timeline (may have new messages).
  pgAutoChatProcessWindowInbox(winIdx);

  // Try to process other idle windows (they just received our timeline entry).
  for (var k = 0; k < pgState.splitCount; k++) {
    if (k === winIdx) continue;
    pgAutoChatProcessWindowInbox(k);
  }

  // Rolling summarization (only after a real reply, not a pass).
  if (typeof pgAutoChatMaybeSummarize === 'function') pgAutoChatMaybeSummarize();

  // Director hook: count this reply toward periodic plot-evaluation (guarded).
  if (typeof pgDirectorOnAgentReply === 'function' && pgState.autoChat.isRunning) pgDirectorOnAgentReply(winIdx);

  // Check if the entire auto-chat should end.
  pgAutoChatCheckAllDone();
}

function pgAutoChatCheckAllDone() {
  if (!pgState.autoChat.isRunning) return;
  if (typeof pgDirectorEvalInFlight === 'function' && (pgDirectorEvalInFlight() || (typeof pgDirectorNarratorPending === 'function' && pgDirectorNarratorPending()))) return;
  var modelWins = pgAutoChatModelWindows();
  var anyActive = false;
  var allHitLimit = true;
  var stalled = [];
  modelWins.forEach(function(i) {
    var w = pgWinAt(i);
    if (w.streaming || w.autoChatPending) { anyActive = true; allHitLimit = false; return; }
    if (w.autoChatDone) return;
    allHitLimit = false;
    var hasUnread = pgState.autoChat.timeline.some(function(e) {
      return e.id > w.lastReadTimelineId;
    });
    if (hasUnread) { anyActive = true; return; }
    stalled.push(i);
  });
  if (anyActive) return;
  if (allHitLimit) {
    if (typeof pgDirectorOnBeforeFinish === 'function' && pgDirectorOnBeforeFinish()) return;
    pgAutoChatFinish();
    return;
  }
  var iters = pgState.autoChat.iterations;
  if (iters > 0 && stalled.length > 0) {
    stalled.sort(function(a, b) { return pgWinAt(a).replyCount - pgWinAt(b).replyCount; });
    var w = pgWinAt(stalled[0]);
    w.lastReadTimelineId = 0;
    pgAutoChatProcessWindowInbox(stalled[0]);
    return;
  }
  if (typeof pgDirectorOnBeforeFinish === 'function' && pgDirectorOnBeforeFinish()) return;
  pgAutoChatFinish();
}

// ----- Stop / finish -------------------------------------------------

function pgAutoChatClearWindowTimers() {
  for (var i = 0; i < pgState.splitCount; i++) {
    var w = pgWinAt(i);
    if (!w) continue;
    if (w.autoChatDelayTimer) { clearTimeout(w.autoChatDelayTimer); w.autoChatDelayTimer = null; }
    w.autoChatPending = false;
  }
}

function pgAutoChatStop() {
  if (typeof pgDirectorReset === 'function') pgDirectorReset();
  pgState.autoChat.abortFlag = true;
  pgState.autoChat.session++;
  pgState.autoChat.isRunning = false;
  pgAutoChatClearWindowTimers();
  if (typeof pgStop === 'function') pgStop();
  for (var i = 0; i < pgState.splitCount; i++) {
    var w = pgWinAt(i);
    if (!w) continue;
    w.inbox = [];
    w.autoChatDone = false;
    w.replyCount = 0;
    w.lastReadTimelineId = 0;
  }
  pgAutoChatRetryCount = {};
  // Append a system message explaining why the chat stopped (only if there
  // was actual conversation in the timeline). Timeline is kept so the user
  // can still read the transcript (it is reset on the next start).
  if (pgState.autoChat.timeline.length > 0) {
    pgAutoChatAppendTimeline('', 'system', -1, pgT('pgAutoChatStopped'), 'complete');
  }
  pgSave();
  pgRenderSidebar();
  pgRenderInputBar();
  pgUpdateAutoChatUI();
  pgGcRefreshModalIncremental();
  pgToast(pgT('pgAutoChatStopped'), 'info');
}

function pgAutoChatFinish() {
  if (typeof pgDirectorReset === 'function') pgDirectorReset();
  pgState.autoChat.isRunning = false;
  pgState.autoChat.abortFlag = false;
  pgAutoChatClearWindowTimers();
  var totalReplies = 0;
  for (var i = 0; i < pgState.splitCount; i++) {
    var w = pgWinAt(i);
    if (!w) continue;
    w.inbox = [];
    w.autoChatDone = false;
    totalReplies += w.replyCount;
    w.replyCount = 0;
    w.lastReadTimelineId = 0;
  }
  // Append a system message describing the end reason.
  var reason;
  if (pgState.autoChat.iterations > 0) {
    reason = pgT('pgAutoChatFinishedReason', [totalReplies]);
  } else {
    reason = pgT('pgAutoChatNoNewContent');
  }
  pgAutoChatAppendTimeline('', 'system', -1, reason, 'complete');
  pgAutoChatRetryCount = {};
  pgSave();
  pgRenderSidebar();
  pgRenderInputBar();
  pgUpdateAutoChatUI();
  pgGcRefreshModalIncremental();
  pgToast(reason, 'success');
}

// ----- User send during auto chat -----------------------------------

function pgAutoChatUserSend(text) {
  if (pgState.autoChat.isRunning) {
    // Parse @mentions to support directed speech.
    var mentions = pgAutoChatParseMentions(text);

    // Append the user's message to the shared timeline.
    pgAutoChatAppendTimeline(
      pgState.autoChat.userName || 'User',
      'user', -1, text, 'complete'
    );

    // Directed delivery: only the mentioned windows respond; otherwise all.
    if (mentions && mentions.length) {
      mentions.forEach(function(i) { pgAutoChatProcessWindowInbox(i); });
    } else {
      var modelWins = pgAutoChatModelWindows();
      modelWins.forEach(function(i) {
        pgAutoChatProcessWindowInbox(i);
      });
    }

    if (typeof pgUpdateAutoChatUI === 'function') pgUpdateAutoChatUI();
    if (typeof pgGcRefreshModalIncremental === 'function') pgGcRefreshModalIncremental();
  } else {
    pgAutoChatStart(text);
  }
}

// Parse @name mentions from a message. Returns an array of window indices that
// were mentioned, or null if none. Matches against config.agentName first, then
// the "Agent N" fallback name. @name contains no whitespace.
function pgAutoChatParseMentions(text) {
  var matches = text.match(/@(\S+)/g);
  if (!matches) return null;

  var mentionedWindows = [];
  matches.forEach(function(m) {
    var name = m.slice(1); // drop the leading @
    for (var i = 0; i < pgState.splitCount; i++) {
      var w = pgWinAt(i);
      var agentName = pgAutoChatGetAgentName(i);
      if (agentName === name || (w && w.config && w.config.agentName === name)) {
        if (mentionedWindows.indexOf(i) < 0) mentionedWindows.push(i);
        break;
      }
    }
  });

  return mentionedWindows.length ? mentionedWindows : null;
}

// ----- UI sync -------------------------------------------------------

function pgUpdateAutoChatUI() {
  var stopBtn = document.getElementById('pg-autochat-stop-btn');
  if (stopBtn) {
    if (pgState.autoChat.isRunning) stopBtn.classList.add('running');
    else stopBtn.classList.remove('running');
  }
  var hint = document.getElementById('pg-autochat-iterations-hint');
  if (hint) {
    if (!pgState.autoChat.isRunning) {
      hint.textContent = pgState.autoChat.iterations === 0
        ? pgT('pgAutoChatInfiniteWarn')
        : '';
    } else {
      // Build per-window progress string: "W1:3 W2:5 / 10"
      var parts = [];
      var modelWins = pgAutoChatModelWindows();
      var iters = pgState.autoChat.iterations;
      modelWins.forEach(function(i) {
        var w = pgWinAt(i);
        var suffix = w.autoChatPending ? '~' : (w.streaming ? '…' : '');
        parts.push('W' + (i + 1) + ':' + w.replyCount + suffix);
      });
      var limit = iters > 0 ? (' / ' + iters) : ' / ∞';
      hint.textContent = parts.join(' ') + limit;
    }
  }
  // Lightweight update of each pane header's typing indicator (no full re-render).
  for (var i = 0; i < pgState.splitCount; i++) {
    var w = pgWinAt(i);
    var span = document.querySelector('.pg-pane[data-win="' + i + '"] .pg-pane-typing');
    if (!span) continue;
    if (pgState.autoChat.isRunning && w.autoChatPending) {
      span.textContent = pgT('pgTyping');
      span.style.display = 'inline';
    } else if (pgState.autoChat.isRunning && w.streaming) {
      span.textContent = pgT('pgStreaming');
      span.style.display = 'inline';
    } else {
      span.style.display = 'none';
    }
  }
}

// ----- Group chat modal (live-refreshing) ---------------------------

var pgGcRefreshTimer = null;

function pgGetGroupChatMessages() {
  // The shared timeline is the single source of truth — no dedup needed.
  return pgState.autoChat.timeline.map(function(entry) {
    return {
      id: entry.id,
      sender: entry.sender,
      content: entry.content,
      reasoning: '',
      timestamp: entry.ts,
      winIdx: entry.winIdx,
      isUser: entry.senderType === 'user',
      isSystem: entry.senderType === 'system',
      status: entry.status,
    };
  });
}

function pgRenderGroupChatMessagesHtml(msgs) {
  return msgs.map(function(m) {
    var timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
    var cls = m.isSystem ? 'pg-gc-msg system' : (m.isUser ? 'pg-gc-msg user' : 'pg-gc-msg agent');
    return '<div class="' + cls + '"' + (m.id ? (' data-gc-id="' + m.id + '"') : '') + '>' +
      '<div class="pg-gc-sender">' + pgEscapeHtml(m.sender) +
      '<span class="pg-gc-time">' + timeStr + '</span></div>' +
      '<div class="pg-gc-content">' + pgRenderMarkdown(m.content) + '</div>' +
    '</div>';
  }).join('');
}

// ----- Incremental group chat modal rendering -------------------------

// Rendered timeline ids (avoid re-rendering existing nodes).
var pgGcRenderedIds = {};
// Currently-streaming DOM node managed by pgGcOnStreamChunk.
var pgGcStreamingNode = null;
// Timeline id currently streaming (kept for API parity; our timeline has no
// streaming entries — live nodes are tracked by class streaming-agent-N).
var pgGcStreamingId = 0;
// Whether to follow the conversation to the bottom automatically.
var pgGcAutoScroll = true;

// Deprecated full re-render — kept as a thin alias for backward compatibility.
function pgRefreshGroupChatModal() {
  pgGcRefreshModalIncremental();
}

function pgGcUnreadCount() {
  var total = pgState.autoChat.timeline.length;
  var rendered = 0;
  for (var k in pgGcRenderedIds) {
    if (pgGcRenderedIds.hasOwnProperty(k)) rendered++;
  }
  return Math.max(0, total - rendered);
}

function pgGcScrollToBottom() {
  var msgBox = document.getElementById('pg-gc-messages');
  if (!msgBox) return;
  msgBox.scrollTop = msgBox.scrollHeight;
  pgGcAutoScroll = true;
  var newMsgBtn = document.getElementById('pg-gc-new-msgs');
  if (newMsgBtn) newMsgBtn.style.display = 'none';
}

// Append newly arrived timeline entries to the modal without re-rendering the
// whole list. Also manages the live typing indicator and the "new messages"
// button.
function pgGcRefreshModalIncremental() {
  var msgBox = document.getElementById('pg-gc-messages');
  if (!msgBox) return;

  // Remove stale streaming-agent temp nodes for windows that are no longer
  // streaming (their real timeline entry is now rendered). Keep nodes for
  // windows still streaming so live content is preserved between hook calls.
  var tempNodes = msgBox.querySelectorAll('[class*="streaming-agent-"]');
  for (var t = 0; t < tempNodes.length; t++) {
    var tn = tempNodes[t];
    var m = tn.className.match(/streaming-agent-(\d+)/);
    var wi = m ? parseInt(m[1], 10) : -1;
    var ww = pgWinAt(wi);
    if (!m || !ww || !ww.streaming) tn.remove();
  }

  var msgs = pgGetGroupChatMessages();
  var newHtml = '';
  for (var i = 0; i < msgs.length; i++) {
    var msg = msgs[i];
    if (pgGcRenderedIds[msg.id]) continue;
    pgGcRenderedIds[msg.id] = true;
    // A pass entry is rendered specially (no content bubble).
    if (msg.status === 'pass') {
      newHtml += '<div class="pg-gc-msg pass" data-gc-id="' + msg.id + '">' +
        '<span class="pg-gc-pass-icon">👀</span> ' +
        pgEscapeHtml(msg.sender) + ' ' + pgEscapeHtml(pgT('pgPassHint')) +
        '</div>';
      continue;
    }
    var timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
    var cls = msg.isSystem ? 'pg-gc-msg system' : (msg.isUser ? 'pg-gc-msg user' : 'pg-gc-msg agent');
    if (msg.status === 'summary') cls += ' summary';
    newHtml += '<div class="' + cls + '" data-gc-id="' + msg.id + '">' +
      '<div class="pg-gc-sender">' + pgEscapeHtml(msg.sender) +
      '<span class="pg-gc-time">' + timeStr + '</span></div>' +
      '<div class="pg-gc-content">' + pgRenderMarkdown(msg.content) + '</div>' +
    '</div>';
  }

  if (newHtml) {
    var tempDiv = document.createElement('div');
    tempDiv.innerHTML = newHtml;
    while (tempDiv.firstChild) {
      msgBox.appendChild(tempDiv.firstChild);
    }
    if (pgGcAutoScroll) msgBox.scrollTop = msgBox.scrollHeight;
  }

  pgGcUpdateTypingIndicator(msgBox);

  // Update the "new messages" button for when the user has scrolled up.
  if (!pgGcAutoScroll) {
    var newBtn = document.getElementById('pg-gc-new-msgs');
    var unread = pgGcUnreadCount();
    if (newBtn && unread > 0) {
      newBtn.textContent = pgT('pgGcNewMsgs', [unread]);
      newBtn.style.display = 'block';
    } else if (newBtn) {
      newBtn.style.display = 'none';
    }
  }

  // Keep the token-usage water-level bar in sync.
  if (typeof pgGcUpdateTokenBar === 'function') pgGcUpdateTokenBar();
}

function pgGcUpdateTypingIndicator(msgBox) {
  var old = msgBox.querySelector('.pg-gc-typing');
  if (old) old.remove();
  if (!pgState.autoChat.isRunning) return;
  var typingAgents = [];
  for (var i = 0; i < pgState.splitCount; i++) {
    var w = pgWinAt(i);
    if (!w.config.model || w.autoChatDone) continue;
    if (w.autoChatPending || w.streaming) typingAgents.push(pgAutoChatGetAgentName(i));
  }
  if (typingAgents.length) {
    var div = document.createElement('div');
    div.className = 'pg-gc-typing';
    div.innerHTML = pgEscapeHtml(typingAgents.join(', ') + pgT('pgTypingPlural')) +
      '<span class="pg-gc-typing-dots"></span>';
    msgBox.appendChild(div);
    if (pgGcAutoScroll) msgBox.scrollTop = msgBox.scrollHeight;
  }
}

// ----- Token estimation & rolling summary ----------------------------

// Rough token estimate: Chinese ~1.5 chars/token, other text ~4 chars/token.
function pgAutoChatEstimateTokens(text) {
  if (!text) return 0;
  var cnChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  var otherChars = text.length - cnChars;
  return Math.ceil(cnChars * 1.5 + otherChars / 4);
}

// Estimate the token footprint of a window's current perspective (its full
// effective context window).
function pgAutoChatEstimateWindowTokens(winIdx) {
  var msgs = pgAutoChatRenderPerspective(winIdx);
  var total = 0;
  msgs.forEach(function(m) {
    total += pgAutoChatEstimateTokens(m.content);
  });
  return total;
}

// Rolling summarization thresholds and guard flags.
var pgAutoChatSummaryThreshold = 30; // trigger when timeline exceeds this count
var pgAutoChatSummaryKeep = 10;      // keep this many most-recent entries
var pgAutoChatIsSummarizing = false;

// Summarize the oldest portion of the shared timeline into a single system
// entry, keeping the conversation within the model's context budget. Runs
// asynchronously and never blocks the conversation.
function pgAutoChatMaybeSummarize() {
  if (pgAutoChatIsSummarizing) return;
  if (pgState.autoChat.timeline.length < pgAutoChatSummaryThreshold) return;

  // Capture the session so a stale response after stop/restart is ignored.
  var capturedSession = pgState.autoChat.session;

  pgAutoChatIsSummarizing = true;

  // Oldest entries to summarize; keep the most recent pgAutoChatSummaryKeep.
  var toSummarize = pgState.autoChat.timeline.slice(0,
    pgState.autoChat.timeline.length - pgAutoChatSummaryKeep);

  if (!toSummarize.length) {
    pgAutoChatIsSummarizing = false;
    return;
  }

  var summaryText = toSummarize.map(function(e) {
    if (e.senderType === 'narrator') {
      return '旁白: ' + e.content;
    }
    return '[' + e.sender + ']: ' + e.content;
  }).join('\n');

  // Use window 0's model for the summary (simplified; ideally a configured
  // small model). Guard against a missing model.
  var summaryWin = pgWinAt(0);
  var summaryModel = summaryWin && summaryWin.config ? summaryWin.config.model : '';
  if (!summaryModel) {
    pgAutoChatIsSummarizing = false;
    return;
  }

  var summaryBody = {
    model: summaryModel,
    messages: [
      { role: 'system', content: 'Summarize the following group chat conversation as a brief narrative (2-3 sentences). Do not use [name]: prefixes. Write in third person.' },
      { role: 'user', content: summaryText },
    ],
    stream: false,
  };

  fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(summaryBody),
  }).then(function(resp) {
    return resp.json();
  }).then(function(j) {
    // Ignore if the auto-chat session changed while the request was in flight.
    if (capturedSession !== pgState.autoChat.session) return;
    var summary = (j.choices && j.choices[0] && j.choices[0].message)
      ? j.choices[0].message.content : '';
    if (!summary) return;

    var prefix = (typeof pgT === 'function') ? pgT('pgAutoChatSummaryPrefix') : '[Summary] ';
    var summaryEntry = {
      id: ++pgState.autoChat.timelineId,
      sender: '',
      senderType: 'system',
      winIdx: -1,
      content: prefix + summary,
      ts: toSummarize[toSummarize.length - 1].ts,
      status: 'summary',
    };

    // Atomically replace the old entries with the summary entry.
    var kept = pgState.autoChat.timeline.slice(toSummarize.length);
    pgState.autoChat.timeline = [summaryEntry].concat(kept);

    // The timeline changed shape; reset every window's read cursor so the
    // summary becomes part of everyone's rebuilt perspective.
    for (var i = 0; i < pgState.splitCount; i++) {
      var w = pgWinAt(i);
      if (w) w.lastReadTimelineId = 0;
    }

    // The old entries were collapsed into the summary, so drop the previously
    // rendered DOM nodes and re-render from the new timeline (this avoids
    // orphaned/duplicate messages). Streaming temp nodes are left intact.
    var msgBox = document.getElementById('pg-gc-messages');
    if (msgBox) {
      var rendered = msgBox.querySelectorAll('[data-gc-id]');
      for (var r = 0; r < rendered.length; r++) rendered[r].remove();
    }
    pgGcRenderedIds = {};

    if (typeof pgGcRefreshModalIncremental === 'function') pgGcRefreshModalIncremental();
  }).catch(function(e) {
    // Summary failure must not disturb the ongoing conversation.
  }).finally(function() {
    pgAutoChatIsSummarizing = false;
  });
}

// Render the per-window token usage water-level bar. No-op if the modal's bar
// element is not present (modal closed).
function pgGcUpdateTokenBar() {
  var bar = document.getElementById('pg-gc-token-bar');
  if (!bar) return;

  var title = (typeof pgT === 'function') ? pgT('pgGcTokenBar') : 'Context Usage';
  var html = '<div class="pg-gc-token-title">' + pgEscapeHtml(title) + '</div>';
  for (var i = 0; i < pgState.splitCount; i++) {
    var w = pgWinAt(i);
    if (!w.config.model) continue;
    var tokens = pgAutoChatEstimateWindowTokens(i);
    var name = pgAutoChatGetAgentName(i);
    var ctxLimit = w.config.contextLimit || 8000;
    var pct = Math.min(100, (tokens / ctxLimit) * 100);
    var color = pct > 80 ? '#ff6b6b' : (pct > 50 ? '#ffd93d' : '#6bcf7f');
    html += '<div class="pg-gc-token-item">' +
      '<span class="pg-gc-token-name">' + pgEscapeHtml(name) + '</span>' +
      '<div class="pg-gc-token-bar-bg">' +
        '<div class="pg-gc-token-bar-fill" style="width:' + pct + '%;background:' + color + '"></div>' +
      '</div>' +
      '<span class="pg-gc-token-num">' + tokens + '/' + ctxLimit + '</span>' +
    '</div>';
  }
  bar.innerHTML = html;
}

// Live stream hook: render a streaming window's partial reply into the modal.
function pgGcOnStreamChunk(winIdx, assistantIdx) {
  var overlay = document.getElementById('pg-modal-overlay');
  if (!overlay || !overlay.classList.contains('show')) return;
  if (!pgState.autoChat.isRunning) return;
  var w = pgWinAt(winIdx);
  if (!w || !w.streaming) return;

  var content = pgTextContent(w.pendingContent);
  if (!content) return;

  var msgBox = document.getElementById('pg-gc-messages');
  if (!msgBox) return;

  var agentName = pgAutoChatGetAgentName(winIdx);
  var streamingNode = msgBox.querySelector('.pg-gc-msg.streaming-agent-' + winIdx);

  if (!streamingNode) {
    streamingNode = document.createElement('div');
    streamingNode.className = 'pg-gc-msg agent streaming-agent-' + winIdx;
    streamingNode.innerHTML =
      '<div class="pg-gc-sender">' + pgEscapeHtml(agentName) +
      '<span class="pg-gc-time">' + new Date().toLocaleTimeString() + '</span></div>' +
      '<div class="pg-gc-content">' + pgRenderMarkdown(content) + '</div>';
    msgBox.appendChild(streamingNode);
  } else {
    var contentNode = streamingNode.querySelector('.pg-gc-content');
    if (contentNode) contentNode.innerHTML = pgRenderMarkdown(content);
  }

  if (pgGcAutoScroll) msgBox.scrollTop = msgBox.scrollHeight;
}

function pgOpenGroupChatModal() {
  // Clear any existing refresh timer.
  if (pgGcRefreshTimer) { clearInterval(pgGcRefreshTimer); pgGcRefreshTimer = null; }

  pgGcRenderedIds = {};
  pgGcStreamingNode = null;
  pgGcStreamingId = 0;
  pgGcAutoScroll = true;

  var html = '<div class="pg-modal-header">' +
    '<span class="pg-modal-title">💬 ' + pgEscapeHtml(pgT('pgGroupChatTitle')) + '</span>' +
    '<button class="pg-modal-close" onclick="pgCloseGroupChatModal()">✕</button>' +
  '</div>' +
  '<div class="pg-modal-body pg-gc-body">' +
    '<div class="pg-gc-sidebar">' +
      '<div class="pg-gc-token-bar" id="pg-gc-token-bar"></div>' +
    '</div>' +
    '<div class="pg-gc-main">' +
      '<div class="pg-gc-messages" id="pg-gc-messages"></div>' +
      '<div class="pg-gc-new-msgs" id="pg-gc-new-msgs" style="display:none" onclick="pgGcScrollToBottom()"></div>' +
      '<div class="pg-gc-input-bar">' +
        '<textarea class="pg-gc-input" id="pg-gc-input" placeholder="' + pgEscapeHtml(pgT('pgEnterMessage')) + '" onkeydown="pgOnGroupChatInputKey(event)"></textarea>' +
        '<button class="pg-send" onclick="pgGroupChatSend()">' + pgEscapeHtml(pgT('pgSendMessage')) + '</button>' +
      '</div>' +
    '</div>' +
  '</div>';

  pgShowModal(html);

  // First full render from the timeline.
  pgGcRefreshModalIncremental();

  var msgBox = document.getElementById('pg-gc-messages');
  if (msgBox) {
    msgBox.scrollTop = msgBox.scrollHeight;
    msgBox.addEventListener('scroll', function() {
      var atBottom = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 50;
      pgGcAutoScroll = atBottom;
      var newMsgBtn = document.getElementById('pg-gc-new-msgs');
      if (!newMsgBtn) return;
      if (atBottom) {
        newMsgBtn.style.display = 'none';
      } else {
        var unread = pgGcUnreadCount();
        if (unread > 0) {
          newMsgBtn.textContent = pgT('pgGcNewMsgs', [unread]);
          newMsgBtn.style.display = 'block';
        }
      }
    });
  }

  // Keep-alive fallback refresh (self-cleaning when modal closes).
  pgGcRefreshTimer = setInterval(function() {
    var overlay = document.getElementById('pg-modal-overlay');
    if (!overlay || !overlay.classList.contains('show')) {
      clearInterval(pgGcRefreshTimer);
      pgGcRefreshTimer = null;
      return;
    }
    pgGcRefreshModalIncremental();
  }, 2000);
}

function pgCloseGroupChatModal() {
  if (pgGcRefreshTimer) { clearInterval(pgGcRefreshTimer); pgGcRefreshTimer = null; }
  pgCloseModal();
}

function pgGroupChatSend() {
  var ta = document.getElementById('pg-gc-input');
  if (!ta) return;
  var text = ta.value.trim();
  if (!text) return;
  ta.value = '';
  var mainTa = document.getElementById('pg-input');
  if (mainTa) mainTa.value = text;
  pgUserSend();
  // Immediate incremental refresh; the interval keeps it updated.
  pgGcRefreshModalIncremental();
}

function pgOnGroupChatInputKey(e) {
  if (Shortcuts.matchEvent('pg.send-group-message', e) && !e.shiftKey) {
    e.preventDefault();
    pgGroupChatSend();
  }
}

// ----- Failure retry (auto chat) --------------------------------------

// Per-window retry counter: { winIdx: count }.
var pgAutoChatRetryCount = {};

// Decide whether to retry a failed auto-chat reply. Returns true (and schedules
// a retry) when the window has not yet exhausted its single retry.
function pgAutoChatShouldRetry(winIdx, assistantIdx) {
  var retries = pgAutoChatRetryCount[winIdx] || 0;
  if (retries >= 1) return false;

  pgAutoChatRetryCount[winIdx] = retries + 1;
  var capturedSession = pgState.autoChat.session;
  var w = pgWinAt(winIdx);

  // Block other triggers while we wait (pending => pgAutoChatCanReply false).
  w.autoChatPending = true;

  // Show a retry notice in the console log.
  try { pgConsoleLog('[auto-chat] W' + (winIdx + 1) + ': ' + pgT('pgAutoChatRetryMsg', [winIdx + 1])); } catch (e) {}

  setTimeout(function() {
    w.autoChatPending = false;
    if (capturedSession !== pgState.autoChat.session) return;
    if (!pgState.autoChat.isRunning) return;
    if (w.autoChatDone) return;
    if (!pgAutoChatCanReply(winIdx)) return;
    var last = w.messages[w.messages.length - 1];
    if (last) {
      last.status = 'loading';
      last.content = '';
      last.error = null;
    }
    pgRenderMessages(winIdx);
    pgSend(winIdx, w.messages.length - 1);
  }, 3000);

  return true;
}
