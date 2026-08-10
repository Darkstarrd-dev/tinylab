// gallery-meta.js — Gallery metadata sidebar. The toggle button
// (#gallery-meta-btn) opens a fixed right-side sidebar (1/3 of the pane
// width) showing the current item's stored generation metadata, parsed
// client-side from the raw file bytes: PNG tEXt chunks (ComfyUI writes
// ASCII-safe \uXXXX JSON there) and MP4 moov/udta/meta mdta keys+ilst boxes.
// The sidebar is CSS-driven: .gallery-meta-open on #gallery-main reveals the
// sidebar and shrinks the media to the left 2/3. ESC (or toggling the button
// again) closes it. Per-item results are cached in galleryState.metaCache
// keyed by the item's stable URL/path.

'use strict';

// ---------- toggle & sidebar ----------------------------------------
function toggleMetaOverlay() {
  galleryState.metaOverlayEnabled = !galleryState.metaOverlayEnabled;
  document.querySelectorAll('#gallery-meta-btn').forEach(function(b) {
    b.classList.toggle('active', galleryState.metaOverlayEnabled);
  });
  document.querySelectorAll('#gallery-main').forEach(function(m) {
    m.classList.toggle('gallery-meta-open', galleryState.metaOverlayEnabled);
  });
  if (galleryState.metaOverlayEnabled) {
    renderMetaSidebar(false);
    renderMetaSidebar(true);
  } else {
    document.querySelectorAll('#gallery-meta-sidebar').forEach(function(s) { s.innerHTML = ''; });
  }
}

// renderMetaSidebar renders the current item's metadata into the sidebar of
// the pane whose kind matches paneIsVideo (split mode duplicates panes;
// non-split mode only the active pane exists, so the other kind no-ops).
function renderMetaSidebar(paneIsVideo) {
  if (!galleryState.metaOverlayEnabled) return;
  var mainEls = document.querySelectorAll('#gallery-main');
  mainEls.forEach(function(mainEl) {
    var isVidPane = !!(mainEl.querySelector('#gallery-main-video') || mainEl.querySelector('#gallery-main-anim'));
    if (isVidPane !== !!paneIsVideo) return;
    var sidebar = mainEl.querySelector('#gallery-meta-sidebar');
    if (!sidebar) return;
    var item = isVidPane ? galleryState.videoItems[galleryState.videoIndex] : galleryState.items[galleryState.index];
    if (!item) return;
    var key = _metaCacheKey(item);
    if (galleryState.metaCache[key]) {
      sidebar.innerHTML = formatMetadataForOverlay(galleryState.metaCache[key]);
      return;
    }
    sidebar.textContent = T('gmMetaLoading') || 'Loading metadata...';
    readItemMetadata(item).then(function(meta) {
      galleryState.metaCache[key] = meta;
      if (!galleryState.metaOverlayEnabled) return;
      var cur = isVidPane ? galleryState.videoItems[galleryState.videoIndex] : galleryState.items[galleryState.index];
      if (cur !== item) return;
      if (!sidebar.isConnected) return;
      sidebar.innerHTML = formatMetadataForOverlay(meta);
    });
  });
}

// _metaCacheKey — stable per-item cache key. Items carry no plain `url`
// field, so fall back to the media URL / path / name (in that order).
function _metaCacheKey(item) {
  if (!item) return '';
  return item.url || item.mainURL || item.path || item.name || '';
}

// ---------- metadata read pipeline --------------------------------
// readItemMetadata resolves with the parsed metadata object (TinyRouter
// record, ComfyUI API-format graph, or raw string) or null.
function readItemMetadata(item) {
  return new Promise(function(resolve) {
    var blobPromise = (typeof getItemBlob === 'function') ? getItemBlob(item) : Promise.resolve(null);
    Promise.resolve(blobPromise).then(function(blob) {
      if (!blob && item && item.mainURL) {
        // Bridge/backend items expose a server URL without local bytes.
        return fetch(item.mainURL).then(function(r) {
          if (!r.ok) throw new Error('meta fetch ' + r.status);
          return r.blob();
        });
      }
      return blob;
    }).then(function(blob) {
      return readBlobMetadata(blob);
    }).then(function(texts) {
      resolve(_extractPromptMeta(texts));
    }).catch(function() {
      resolve(null);
    });
  });
}

function readBlobMetadata(blob) {
  if (!blob) return Promise.resolve(null);
  return blob.slice(0, 8).arrayBuffer().then(function(head8) {
    var dv = new DataView(head8);
    var isPng = head8.byteLength >= 8 &&
      dv.getUint8(0) === 0x89 && dv.getUint8(1) === 0x50 && dv.getUint8(2) === 0x4E && dv.getUint8(3) === 0x47 &&
      dv.getUint8(4) === 0x0D && dv.getUint8(5) === 0x0A && dv.getUint8(6) === 0x1A && dv.getUint8(7) === 0x0A;
    var isMp4 = head8.byteLength >= 8 &&
      dv.getUint8(4) === 0x66 && dv.getUint8(5) === 0x74 && dv.getUint8(6) === 0x79 && dv.getUint8(7) === 0x70;
    if (isPng) {
      // tEXt chunks live between IHDR and IDAT; the first 2MB covers every
      // realistic prompt, avoiding a full read of large scans.
      var pngSlice = blob.slice(0, Math.min(blob.size, 2 * 1024 * 1024));
      return pngSlice.arrayBuffer().then(readPNGTextChunks);
    }
    if (isMp4) {
      // Try the head first (faststart files carry moov up front); fall back
      // to a full read for non-faststart files where moov sits at the end.
      var head = blob.slice(0, Math.min(blob.size, 2 * 1024 * 1024));
      return head.arrayBuffer().then(function(headBuf) {
        var m = readMP4Metadata(headBuf);
        if (m) return m;
        return blob.arrayBuffer().then(readMP4Metadata);
      });
    }
    return null;
  });
}

// _extractPromptMeta picks the `prompt` (or `workflow`) value out of the
// raw {key:value} map and JSON-parses it. When the parsed prompt is an
// OBJECT and the file also carries a `workflow` key, the parsed workflow
// graph is stashed on parsed.__workflow_graph so the overlay can report
// its presence (raw-string prompts and TinyRouter records never stash).
function _extractPromptMeta(texts) {
  if (!texts) return null;
  if (texts.prompt != null) {
    try {
      var p = JSON.parse(texts.prompt);
      if (p && typeof p === 'object') {
        if (texts.workflow != null) {
          try {
            var w = JSON.parse(texts.workflow);
            if (w && typeof w === 'object') p.__workflow_graph = w;
          } catch (e3) { /* workflow not JSON — ignore */ }
        }
        return p;
      }
      return texts.prompt;
    } catch (e) {
      return texts.prompt;
    }
  }
  if (texts.workflow != null) {
    try {
      var w2 = JSON.parse(texts.workflow);
      return (w2 && typeof w2 === 'object') ? w2 : texts.workflow;
    } catch (e2) {
      return texts.workflow;
    }
  }
  return null;
}

// ---------- PNG tEXt parser ----------------------------------------
// Walks PNG chunks; tEXt = keyword\0text (latin-1 per the PNG spec, which is
// why per-byte String.fromCharCode is correct — ComfyUI writes \uXXXX-escaped
// ASCII). zTXt/iTXt are out of scope. Returns {key:value} or null.
function readPNGTextChunks(arrayBuffer) {
  var dv = new DataView(arrayBuffer);
  var sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (var i = 0; i < 8; i++) if (dv.getUint8(i) !== sig[i]) return null;
  var pos = 8, texts = {};
  while (pos + 8 <= arrayBuffer.byteLength) {
    var len = dv.getUint32(pos);
    if (pos + 8 + len + 4 > arrayBuffer.byteLength) break; // truncated chunk
    var type = String.fromCharCode(dv.getUint8(pos + 4), dv.getUint8(pos + 5), dv.getUint8(pos + 6), dv.getUint8(pos + 7));
    if (type === 'IEND') break;
    if (type === 'tEXt') {
      var data = new Uint8Array(arrayBuffer, pos + 8, len);
      var nul = 0; while (nul < data.length && data[nul] !== 0) nul++;
      var key = ''; for (var k = 0; k < nul; k++) key += String.fromCharCode(data[k]);
      var val = ''; for (var j = nul + 1; j < data.length; j++) val += String.fromCharCode(data[j]);
      if (!(key in texts)) texts[key] = val; // keep first on duplicates
    }
    pos += 12 + len;
  }
  return Object.keys(texts).length ? texts : null;
}

// ---------- MP4 mdta/ilst parser ------------------------------------
// Walks top-level boxes (size(4 BE) + type(4)), descends moov → udta → meta.
// meta is a FULL box: skip its 4-byte version/flags before parsing children.
// Inside meta: `keys` (full box: version/flags(4) + count(4) + entries of
// size(4) + namespace(4 'mdta') + keyname) and `ilst` (entries of
// size(4) + index(4, 1-based) + `data` sub-box of size(4) + type('data') +
// flags(4) + locale(4) + UTF-8 value). Returns {key:value} or null.
function readMP4Metadata(arrayBuffer) {
  var dv = new DataView(arrayBuffer);
  var len = arrayBuffer.byteLength;
  if (len < 12) return null;
  // ftyp box must sit at offset 4.
  if (dv.getUint8(4) !== 0x66 || dv.getUint8(5) !== 0x74 || dv.getUint8(6) !== 0x79 || dv.getUint8(7) !== 0x70) return null;

  var keys = [];
  var ilstEntries = [];

  function walk(start, end) {
    var pos = start;
    while (pos + 8 <= end) {
      var size = dv.getUint32(pos);
      var type = String.fromCharCode(dv.getUint8(pos + 4), dv.getUint8(pos + 5), dv.getUint8(pos + 6), dv.getUint8(pos + 7));
      if (size === 1) {
        // 64-bit size: extended size follows the type.
        var hi = dv.getUint32(pos + 8);
        var lo = dv.getUint32(pos + 12);
        size = hi * 4294967296 + lo;
        if (size < 16 || pos + size > end) break;
      } else if (size === 0) {
        size = end - pos; // box extends to end of container
      } else if (size < 8 || pos + size > end) {
        break; // truncated
      }
      var body = pos + 8;
      if (type === 'moov' || type === 'udta') {
        walk(body, pos + size);
      } else if (type === 'meta') {
        walk(body + 4, pos + size); // full box: skip version/flags
      } else if (type === 'keys') {
        var p = body + 4; // full box: skip version/flags
        if (p + 4 > pos + size) break;
        var count = dv.getUint32(p);
        p += 4;
        for (var i = 0; i < count && p + 8 <= pos + size; i++) {
          var esz = dv.getUint32(p);
          if (esz < 8 || p + esz > pos + size) break;
          // Entry = size(4) + namespace(4) + keyname (no 'key ' field).
          var key = '';
          for (var b = p + 8; b < p + esz; b++) key += String.fromCharCode(dv.getUint8(b));
          keys.push(key);
          p += esz;
        }
      } else if (type === 'ilst') {
        var ip = body;
        while (ip + 8 <= pos + size) {
          var isz = dv.getUint32(ip);
          if (isz < 8 || ip + isz > pos + size) break;
          var index = dv.getUint32(ip + 4); // 1-based into keys
          var fourcc = String.fromCharCode(dv.getUint8(ip + 4), dv.getUint8(ip + 5), dv.getUint8(ip + 6), dv.getUint8(ip + 7));
          var subPos = ip + 8;
          var subEnd = ip + isz;
          var value = null;
          while (subPos + 8 <= subEnd) {
            var dsz = dv.getUint32(subPos);
            if (dsz < 8 || subPos + dsz > subEnd) break;
            var dtype = String.fromCharCode(dv.getUint8(subPos + 4), dv.getUint8(subPos + 5), dv.getUint8(subPos + 6), dv.getUint8(subPos + 7));
            if (dtype === 'data') {
              var u8 = new Uint8Array(arrayBuffer, subPos + 16, dsz - 16);
              value = _utf8ToString(u8, 0, u8.length);
            }
            subPos += dsz;
          }
          ilstEntries.push({ index: index, fourcc: fourcc, value: value });
          ip += isz;
        }
      }
      pos += size;
    }
  }

  walk(0, len);

  var out = {};
  for (var e = 0; e < ilstEntries.length; e++) {
    var entry = ilstEntries[e];
    var keyName = (entry.index >= 1 && entry.index <= keys.length) ? keys[entry.index - 1] : entry.fourcc;
    if (entry.value !== null && !(keyName in out)) out[keyName] = entry.value;
  }
  return Object.keys(out).length ? out : null;
}

// _utf8ToString decodes UTF-8 bytes (mdta values are UTF-8 per the box spec;
// ComfyUI's ensure_ascii JSON is plain ASCII and passes through untouched).
function _utf8ToString(bytes, start, end) {
  var out = '';
  var i = start;
  while (i < end) {
    var b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0); i += 1;
    } else if (b0 < 0xE0 && i + 1 < end) {
      out += String.fromCharCode(((b0 & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 2;
    } else if (b0 < 0xF0 && i + 2 < end) {
      out += String.fromCharCode(((b0 & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)); i += 3;
    } else if (i + 3 < end) {
      var cp = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
      if (cp > 0xFFFF) {
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      } else {
        out += String.fromCharCode(cp);
      }
      i += 4;
    } else {
      out += String.fromCharCode(b0); i += 1;
    }
  }
  return out;
}

// ---------- overlay formatting --------------------------------------
// formatMetadataForOverlay returns an HTML string; every dynamic value is
// escaped via escapeHtml.
function formatMetadataForOverlay(meta) {
  if (meta == null) {
    return '<div class="gm-field">' + escapeHtml(T('gmMetaNone') || 'No metadata found') + '</div>';
  }
  if (typeof meta === 'string') {
    return '<div class="gm-field"><pre>' + escapeHtml(meta) + '</pre></div>';
  }
  if (typeof meta === 'object') {
    // TinyRouter generation record: {prompt, model, protocol?, params?, ...}
    if (typeof meta.prompt === 'string' && typeof meta.model === 'string') {
      var html = '';
      // Prompt first, always fully visible (never truncated, never folded).
      html += '<div class="gm-field"><span class="gm-label">' + escapeHtml(T('gmPrompt') || 'Prompt') + '</span><div class="gm-value gm-prompt gm-copy">' + escapeHtml(meta.prompt) + '</div></div>';
      html += '<details class="gm-more"><summary>' + escapeHtml(T('gmDetails') || 'Details') + '</summary>';
      html += _gmRow(T('gmModel') || 'Model', escapeHtml(meta.model));
      if (meta.protocol) html += _gmRow(T('gmSource') || 'Source', escapeHtml(meta.protocol));
      if (meta.params) {
        html += '<div class="gm-field"><span class="gm-label">' + escapeHtml(T('gmParams') || 'Parameters') + '</span><pre>' +
                escapeHtml(JSON.stringify(meta.params, null, 2)) + '</pre></div>';
      }
      if (meta.revised_prompt) html += _gmRow('Revised Prompt', escapeHtml(meta.revised_prompt));
      if (meta.created_at) {
        var d = new Date(meta.created_at);
        if (!isNaN(d.getTime()) && d.getTime() > 0) html += _gmRow('Created', escapeHtml(d.toLocaleString()));
      }
      if (meta.duration_ms && meta.duration_ms > 0) html += _gmRow('Duration', escapeHtml(String(meta.duration_ms) + 'ms'));
      if (meta.provider) html += _gmRow('Provider', escapeHtml(meta.provider));
      if (meta.generator) html += _gmRow('Generator', escapeHtml(meta.generator));
      html += '</details>';
      return html;
    }
    // ComfyUI API-format prompt graph: {<nodeId>: {inputs, class_type, ...}}
    if (_looksLikeComfyGraph(meta)) {
      var prompts = _comfyPrompts(meta);
      var chtml = '';
      // Prompt rows first, always fully visible.
      if (prompts.positive) {
        chtml += '<div class="gm-field"><span class="gm-label">' + escapeHtml(T('gmPrompt') || 'Prompt') + '</span><div class="gm-value gm-prompt gm-copy">' + escapeHtml(prompts.positive) + '</div></div>';
      }
      if (prompts.negative) {
        chtml += '<div class="gm-field"><span class="gm-label">' + escapeHtml(T('gmNegative') || 'Negative Prompt') + '</span><div class="gm-value gm-prompt gm-copy">' + escapeHtml(prompts.negative) + '</div></div>';
      }
      chtml += '<details class="gm-more"><summary>' + escapeHtml(T('gmDetails') || 'Details') + '</summary>';
      chtml += _gmRow(T('gmSource') || 'Source', escapeHtml('ComfyUI'));
      chtml += _gmRow('Workflow', escapeHtml(meta.__workflow_graph ? 'Yes' : 'No'));
      chtml += '<div class="gm-field"><pre>' + escapeHtml(_comfyNodeList(meta)) + '</pre></div>';
      chtml += '</details>';
      return chtml;
    }
    return '<div class="gm-field"><pre>' + escapeHtml(JSON.stringify(meta, null, 2)) + '</pre></div>';
  }
  return '<div class="gm-field"><pre>' + escapeHtml(String(meta)) + '</pre></div>';
}

function _gmRow(label, valueHtml) {
  return '<div class="gm-field"><span class="gm-label">' + escapeHtml(label) + '</span><span class="gm-value">' + valueHtml + '</span></div>';
}

// _looksLikeComfyGraph: at least one value is a node object with a
// class_type string (API-format prompt).
function _looksLikeComfyGraph(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  var keyNames = Object.keys(meta);
  if (!keyNames.length) return false;
  for (var i = 0; i < keyNames.length; i++) {
    var v = meta[keyNames[i]];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.class_type === 'string') return true;
  }
  return false;
}

// _comfyPrompts extracts {positive, negative} prompt text from a ComfyUI
// API-format graph. Classification order: sampler/guider input links (most
// reliable — inputs.positive/negative are [nodeId, outputIndex] links into
// CLIPTextEncode nodes), then node _meta.title, then a generic longest
// inputs.prompt scan for graphs with no CLIPTextEncode at all (MiniMax H3
// video workflows store their prompt on e.g. MiniMaxH3ImageToVideo.inputs).
function _comfyPrompts(meta) {
  var positive = null;
  var negative = null;

  // 1. Node map: nodeId -> node for every graph key with a class_type.
  var nodes = {};
  var keyNames = Object.keys(meta);
  for (var i = 0; i < keyNames.length; i++) {
    var id = keyNames[i];
    if (id.indexOf('__') === 0) continue;
    var n = meta[id];
    if (n && typeof n === 'object' && typeof n.class_type === 'string') nodes[id] = n;
  }

  // nodeText resolves the prompt text of a CLIPTextEncode node; SDXL nodes
  // fall back to joining text_g + text_l when inputs.text is absent.
  function nodeText(nodeId) {
    var node = nodes[nodeId];
    if (!node || !node.inputs) return null;
    var t = node.inputs.text;
    if (typeof t === 'string' && t.trim()) return t;
    if (node.class_type === 'CLIPTextEncodeSDXL') {
      var g = node.inputs.text_g;
      var l = node.inputs.text_l;
      if ((typeof g === 'string' && g.trim()) || (typeof l === 'string' && l.trim())) {
        return ((typeof g === 'string' ? g : '') + '\n\n' + (typeof l === 'string' ? l : '')).trim();
      }
    }
    return null;
  }

  // 2. Sampler/Guider link classification: the sampler node's
  // inputs.positive / inputs.negative are [nodeId, outputIndex] links.
  var linkPositive = null;
  var linkNegative = null;
  for (var nid in nodes) {
    if (!/sampler|guider/i.test(nodes[nid].class_type)) continue;
    var inp = nodes[nid].inputs || {};
    if (linkPositive === null && Array.isArray(inp.positive) && typeof inp.positive[0] === 'string') linkPositive = inp.positive[0];
    if (linkNegative === null && Array.isArray(inp.negative) && typeof inp.negative[0] === 'string') linkNegative = inp.negative[0];
    if (linkPositive !== null && linkNegative !== null) break;
  }
  if (linkPositive !== null) positive = nodeText(linkPositive);
  if (linkNegative !== null) negative = nodeText(linkNegative);

  var classified = {};
  if (linkPositive !== null) classified[linkPositive] = true;
  if (linkNegative !== null) classified[linkNegative] = true;

  // 3. Title-based fallback for CLIPTextEncode/SDXL nodes not classified
  // by sampler links. The real ComfyUI titles are 'CLIP Text Encode
  // (Positive Prompt)' / 'CLIP Text Encode (Negative Prompt)'.
  var positives = [];
  for (var nid2 in nodes) {
    var node2 = nodes[nid2];
    if (node2.class_type !== 'CLIPTextEncode' && node2.class_type !== 'CLIPTextEncodeSDXL') continue;
    if (classified[nid2]) continue;
    var t2 = nodeText(nid2);
    if (t2 === null) continue;
    var title = node2._meta && node2._meta.title;
    if (typeof title === 'string' && /negative|neg\b|负面|负向|反向/i.test(title)) {
      if (negative === null) negative = t2;
    } else {
      positives.push(t2);
    }
  }
  // 6. Multiple unclassified positive texts join with a blank line.
  if (positive === null && positives.length) positive = positives.join('\n\n');

  // 4. Generic prompt scan fallback when the graph has NO CLIPTextEncode
  // node at all (MiniMax H3 video): scan every node for a non-empty string
  // inputs.prompt and take the longest.
  if (positive === null && negative === null) {
    var hasClipEncode = false;
    for (var nid3 in nodes) {
      if (nodes[nid3].class_type === 'CLIPTextEncode' || nodes[nid3].class_type === 'CLIPTextEncodeSDXL') {
        hasClipEncode = true;
        break;
      }
    }
    if (!hasClipEncode) {
      var best = null;
      for (var nid4 in nodes) {
        var p = nodes[nid4].inputs && nodes[nid4].inputs.prompt;
        if (typeof p === 'string' && p.trim() && (best === null || p.length > best.length)) best = p;
      }
      positive = best;
    }
  }

  return { positive: positive, negative: negative };
}

// _comfyNodeList renders one line per graph node: '[nodeId] class_type
// «title»'. __-prefixed keys (e.g. __workflow_graph) are skipped; the title
// is omitted when absent.
function _comfyNodeList(meta) {
  var lines = [];
  var keyNames = Object.keys(meta);
  for (var i = 0; i < keyNames.length; i++) {
    var id = keyNames[i];
    if (id.indexOf('__') === 0) continue;
    var n = meta[id];
    if (!n || typeof n !== 'object' || typeof n.class_type !== 'string') continue;
    var line = id + ' ' + n.class_type;
    var title = n._meta && n._meta.title;
    if (typeof title === 'string' && title) line += ' «' + title + '»';
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------- ESC handling -------------------------------------------
// The app-wide keydown handler in app.js binds in the bubble phase and maps
// Escape (no modal open) to the shutdown-server shortcut, which would swallow
// our ESC before onGalleryKeyDown ever ran. Bind capture-phase so an open
// metadata sidebar closes on ESC first; with the sidebar closed (or a modal
// open) the event passes through untouched and the app keeps its normal
// Escape behavior (modal close / shutdown confirm).
function onMetaOverlayKeyDown(e) {
  if (e.key !== 'Escape') return;
  if (typeof topOpenModal === 'function' && topOpenModal()) return; // modals win
  if (!galleryState.metaOverlayEnabled) return;
  e.preventDefault();
  // stopImmediatePropagation (not stopPropagation): other capture-phase
  // listeners on document — onFullscreenKey (bound with capture=true) and
  // app.js's bubble shutdown-server handler — must NOT run for this Escape.
  // Otherwise onFullscreenKey would fall through to gallery.exit-fullscreen
  // and ESC would close the sidebar AND leave fullscreen.
  e.stopImmediatePropagation();
  toggleMetaOverlay();
}
document.addEventListener('keydown', onMetaOverlayKeyDown, true);

// ---------- click-to-copy -------------------------------------------
// Clicking a prompt value copies its full text. Delegated on document so it
// survives the sidebar's per-navigation re-renders; reuses app.js's global
// copyToClipboard (clipboard API + execCommand fallback + toast feedback).
function onMetaCopyClick(e) {
  var el = e.target && e.target.closest ? e.target.closest('.gm-copy') : null;
  if (!el) return;
  var lbl = el.parentElement ? el.parentElement.querySelector('.gm-label') : null;
  copyToClipboard(el.textContent, (lbl && lbl.textContent) || T('gmPrompt') || 'Prompt');
}
document.addEventListener('click', onMetaCopyClick);
