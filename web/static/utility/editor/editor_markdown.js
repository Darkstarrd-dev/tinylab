/* Utility Editor Markdown helpers. Classic-script module; optional globals are used when present. */
(function (root) {
  'use strict';

  if (!root || root.EditorMarkdown) return;

  var URI_ATTRS = { href: true, src: true, action: true, formaction: true, 'xlink:href': true };
  var SAFE_URI = /^(?:(?:https?|mailto|tel):|[\/#]|\.{0,2}\/|[^:]+$)/i;
  var EXTERNAL_URI = /^https?:\/\//i;

  // Heavy-render cache: mermaid SVG layout and hljs highlighting dominate
  // per-keystroke cost, so both are memoized by exact source hash. A cache
  // hit injects the stored markup with zero library calls; only blocks whose
  // source actually changed pay for a re-render. Bounded LRU (oldest evicted
  // first) so long sessions cannot grow memory without limit.
  var ED_HEAVY_CACHE_MAX = 96;
  var edHeavyCache = null; // lazily created Map<string, string>
  var edMermaidSeq = 0;
  function edHeavyMap() {
    if (!edHeavyCache && typeof Map === 'function') edHeavyCache = new Map();
    return edHeavyCache;
  }
  function edHash(value) {
    // FNV-1a 32-bit over UTF-16 code units: cheap, collision-safe enough
    // for a render cache (a collision only costs one stale diagram until
    // the next source change re-renders it).
    var text = asText(value);
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 0x01000193) | 0;
    }
    return (hash >>> 0).toString(36) + ':' + text.length;
  }
  function edCacheGet(key) {
    var map = edHeavyMap();
    if (!map) return null;
    if (!map.has(key)) return null;
    var val = map.get(key);
    map.delete(key);
    map.set(key, val); // refresh LRU position
    return val;
  }
  function edCacheSet(key, val) {
    var map = edHeavyMap();
    if (!map) return;
    if (map.has(key)) map.delete(key);
    map.set(key, val);
    while (map.size > ED_HEAVY_CACHE_MAX) {
      var oldest = null;
      map.forEach(function (v, k) { if (oldest === null) oldest = k; });
      if (oldest === null) break;
      map.delete(oldest);
    }
  }
  function edMermaidRender(raw) {
    // Render one mermaid diagram to an SVG string without touching the live
    // DOM (no layout of throwaway nodes). Prefers the v10+ promise API
    // `mermaid.render(id, text)`; falls back to `mermaidAPI.render` with a
    // callback shim for older bundles. A single pathological diagram must
    // never freeze the window: past 3s the render is abandoned and the
    // caller shows the source with an error note instead.
    var ED_MERMAID_TIMEOUT_MS = 3000;
    return new Promise(function (resolve, reject) {
      var id = 'ed-mmd-' + (++edMermaidSeq) + '-' + Date.now().toString(36);
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('mermaid render timed out'));
      }, ED_MERMAID_TIMEOUT_MS);
      var done = function (fn, arg) {
        if (settled) return;
        settled = true;
        try { clearTimeout(timer); } catch (e) {}
        fn(arg);
      };
      try {
        var mm = root.mermaid;
        if (mm && typeof mm.render === 'function') {
          var out = mm.render(id, raw);
          if (out && typeof out.then === 'function') {
            out.then(function (r) { done(resolve, r && r.svg ? r.svg : String(r)); }, function (e) { done(reject, e); });
            return;
          }
          done(resolve, String(out));
          return;
        }
        var api = mm && mm.mermaidAPI;
        if (api && typeof api.render === 'function') {
          api.render(id, raw, function (svg) { done(resolve, svg); });
          return;
        }
        done(reject, new Error('no mermaid render api'));
      } catch (e) { done(reject, e); }
    });
  }

  function asText(value) {
    return value == null ? '' : String(value);
  }

  function escapeHtml(value) {
    return asText(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getDocument() {
    return root.document || (typeof document !== 'undefined' ? document : null);
  }

  function uriIsSafe(value) {
    var uri = asText(value).replace(/[\u0000-\u0020]/g, '');
    return !uri || SAFE_URI.test(uri);
  }

  function decorateLinks(fragment) {
    if (!fragment || !fragment.querySelectorAll) return;
    var links = fragment.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var href = link.getAttribute('href') || '';
      if (!uriIsSafe(href)) {
        link.removeAttribute('href');
        link.removeAttribute('target');
        link.removeAttribute('rel');
      } else if (EXTERNAL_URI.test(href.replace(/^\s+|\s+$/g, ''))) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }

  function fallbackSanitize(html) {
    var source = asText(html);
    var doc = getDocument();
    if (doc && doc.createElement) {
      try {
        var template = doc.createElement('template');
        template.innerHTML = source;
        var content = template.content || template;
        var blocked = content.querySelectorAll('script,style,iframe,object,embed,base,meta,link,form');
        for (var i = blocked.length - 1; i >= 0; i--) blocked[i].remove();
        var elements = content.querySelectorAll('*');
        for (var ei = 0; ei < elements.length; ei++) {
          var element = elements[ei];
          for (var ai = element.attributes.length - 1; ai >= 0; ai--) {
            var attr = element.attributes[ai];
            var name = attr.name.toLowerCase();
            if (/^on/i.test(name) || name === 'style' || (URI_ATTRS[name] && !uriIsSafe(attr.value))) {
              element.removeAttribute(attr.name);
            }
          }
        }
        decorateLinks(content);
        return content.innerHTML;
      } catch (e) { /* use the string-only fallback below */ }
    }

    // This path is only used outside a DOM. It intentionally removes whole
    // dangerous elements before stripping event and unsafe URI attributes.
    source = source.replace(/<\s*(script|style|iframe|object|embed|base|meta|link|form)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
    source = source.replace(/<\s*(script|style|iframe|object|embed|base|meta|link|form)[^>]*\/?>/gi, '');
    source = source.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    source = source.replace(/\s+(?:href|src|action|formaction|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, function (whole, quoted) {
      var value = quoted;
      var quote = value.charAt(0);
      if (quote === '"' || quote === "'") value = value.substring(1, value.length - 1);
      return uriIsSafe(value) ? whole : '';
    });
    return source;
  }

  function pgEscapeBrackets(text) {
    var pattern = /(```[\s\S]*?```|`[^`]*`)|\\\[([\s\S]*?[^\\])\\\]|\\\((.*?)\\\)/g;
    return text.replace(pattern, function(m, code, sq, rd) {
      if (code) return code;
      if (sq !== undefined) return '$$' + sq + '$$';
      if (rd !== undefined) return '$' + rd + '$';
      return m;
    });
  }

  function pgNormalizeDisplayMath(text) {
    var parts = [];
    var last = 0;
    var fence = /```[\s\S]*?```/g;
    var m;
    while ((m = fence.exec(text)) !== null) {
      var chunk = text.slice(last, m.index);
      parts.push(pgNormalizeInChunk(chunk));
      parts.push(m[0]);
      last = m.index + m[0].length;
    }
    parts.push(pgNormalizeInChunk(text.slice(last)));
    return parts.join('');
  }

  function pgNormalizeInChunk(chunk) {
    chunk = chunk.replace(/\$\$([^\n$]+?)\$\$/g, function(_, inner) {
      return '\n$$\n' + inner.trim() + '\n$$\n';
    });
    chunk = chunk.replace(/\$\$(?!\n)([\s\S]*?)\$\$/g, function(_, inner) {
      return '\n$$\n' + inner.trim() + '\n$$\n';
    });
    return chunk;
  }

  function sanitize(html) {
    var source = asText(html);
    var purifier = root.DOMPurify;
    if (purifier && typeof purifier.sanitize === 'function') {
      try {
        var mathTags = ['math','semantics','annotation','annotation-xml','mrow','mi','mo','mn',
          'msup','msub','msubsup','mfrac','mtable','mtr','mtd','mtext','mspace','menclose',
          'mstyle','merror','msqrt','mroot','mfenced','mover','munder','munderover','mpadded',
          'mphantom','maligngroup','malignmark','maction','mfrac','mlongdiv','mscarries','mscarry',
          'msgroup','mstack','msline','msrow'];
        var mathAttrs = ['aria-hidden','class','style','encoding','stretchy','fence','separator',
          'movablelimits','symmetric','maxsize','minsize','largeop','scriptlevel','displaystyle',
          'columnalign','rowalign','columnspacing','rowspacing','columnlines','rowlines','frame',
          'framespacing','mathbackground','mathcolor','notation','lspace','rspace','depth','height',
          'width','voffset','role','crossout','location','form','linethickness','accent',
          'accentunder','align','stackalign','link','href','stretchy','symmetric','lquote',
          'rquote','xlink:href','xref','columnspan','rowspan','bevelled','close','open','separators',
          'selection','side','decimalpoint','shift','position','href','target','d','viewBox',
          'preserveAspectRatio','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin',
          'transform','cx','cy','r','rx','ry','x','y','x1','x2','y1','y2','xlink:title','xmlns',
          'xmlns:xlink','textContent','mathvariant'];
        return purifier.sanitize(source, {
          ADD_TAGS: mathTags.concat(['svg','g','path','line','rect','circle','ellipse','polygon',
            'polyline','defs','use','clippath','clipPath','text','tspan','title','desc','symbol','marker','foreignobject','use']),
          ADD_ATTR: mathAttrs,
          ALLOW_UNKNOWN_PROTOCOLS: false,
          ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|blob|data):|[\/#]|\.{0,2}\/|[^:]+$)/i
        });
      } catch (e) {
        return fallbackSanitize(source);
      }
    }
    return fallbackSanitize(source);
  }

  function renderMarkdown(text, options) {
    var source = asText(text);
    if (!source) return '';

    if (typeof root.marked !== 'undefined' && typeof root.marked.parse === 'function') {
      try {
        if (typeof root.markedKatex !== 'undefined' && !root.__edMarkedKatexInit) {
          try { root.marked.use(root.markedKatex({ throwOnError: false, nonStandard: true })); } catch (e) {}
          root.__edMarkedKatexInit = true;
        }
        var pre = pgEscapeBrackets(source);
        pre = pgNormalizeDisplayMath(pre);
        var html = root.marked.parse(pre, { breaks: true, gfm: true });
        return sanitize(html);
      } catch (e) {}
    }

    var markdownFactory = root.markdownit;
    if (typeof markdownFactory === 'function') {
      try {
        var md = markdownFactory({ html: true, breaks: true, linkify: true });
        return sanitize(md.render(source));
      } catch (e2) {}
    }
    return '<pre>' + escapeHtml(source) + '</pre>';
  }

  function slugify(value) {
    var slug = asText(value).replace(/^\s+|\s+$/g, '').toLowerCase();
    try { slug = slug.normalize('NFKD'); } catch (e) {}
    slug = slug.replace(/[^\w\u0080-\uFFFF\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'section';
  }

  function buildToc(rootElement) {
    if (!rootElement || typeof rootElement.querySelectorAll !== 'function') return [];
    var headings = rootElement.querySelectorAll('h1,h2,h3,h4,h5,h6');
    var used = Object.create(null);
    var toc = [];
    for (var i = 0; i < headings.length; i++) {
      var heading = headings[i];
      var text = asText(heading.textContent).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
      var base = slugify(text);
      var id = base;
      var suffix = 2;
      while (used[id]) id = base + '-' + suffix++;
      used[id] = true;
      heading.id = id;
      toc.push({ id: id, level: parseInt(heading.tagName.substring(1), 10), text: text });
    }
    return toc;
  }

  function utf8Bytes(value) {
    if (root.TextEncoder) {
      try { return new root.TextEncoder().encode(value).length; } catch (e) {}
    }
    try { return unescape(encodeURIComponent(value)).length; } catch (e2) { return value.length; }
  }

  function sourceParagraphs(value) {
    var trimmed = value.replace(/^\s+|\s+$/g, '');
    return trimmed ? trimmed.split(/(?:\r\n|\r|\n){2,}/).filter(function (part) { return /\S/.test(part); }).length : 0;
  }

  function getStats(text, html) {
    var source = asText(text);
    var trimmed = source.replace(/^\s+|\s+$/g, '');
    var words = trimmed ? trimmed.split(/\s+/).length : 0;
    var paragraphs = sourceParagraphs(source);
    var doc = getDocument();
    if (html && doc && doc.createElement) {
      try {
        var holder = doc.createElement('div');
        holder.innerHTML = asText(html);
        var paragraphNodes = holder.querySelectorAll('p');
        if (paragraphNodes.length) paragraphs = paragraphNodes.length;
      } catch (e) {}
    }
    var chars;
    try { chars = Array.from(source).length; } catch (e2) { chars = source.length; }
    return {
      bytes: utf8Bytes(source),
      words: words,
      lines: source ? source.split(/\r\n|\r|\n/).length : 0,
      chars: chars,
      paragraphs: paragraphs
    };
  }

  function toHtmlDocument(text, title) {
    var rendered = renderMarkdown(text);
    var doc = getDocument();
    if (doc && doc.createElement) {
      try {
        var holder = doc.createElement('div');
        holder.innerHTML = rendered;
        buildToc(holder);
        rendered = sanitize(holder.innerHTML);
      } catch (e) {}
    }
    var documentTitle = title == null || title === '' ? 'Document' : asText(title);
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + escapeHtml(documentTitle) + '</title></head><body>' + rendered + '</body></html>';
  }

  function highlightCode(rootElement, opts) {
    if (!rootElement || !rootElement.querySelectorAll) return rootElement;
    var doc = getDocument();
    // skipHeavy (large-document budget from the shell): leave code plain and
    // degrade mermaid diagrams to click-to-render placeholders instead of
    // paying hljs full-document scan + SVG layout on every pass. The
    // placeholder re-enters the normal cached path for that single block.
    if (opts && opts.skipHeavy) {
      var heavyPres = rootElement.querySelectorAll('pre');
      heavyPres.forEach(function (pre) {
        if (pre.dataset.edMmd === '1' || pre.dataset.edHeavySkip === '1') return;
        var codeEl = pre.querySelector('code');
        if (!codeEl) return;
        var cls = codeEl.className || '';
        var langMatch = cls.match(/(?:language|lang)-([\w-]+)/i);
        var lang = langMatch ? langMatch[1].toLowerCase() : '';
        if (lang !== 'mermaid') return;
        pre.dataset.edHeavySkip = '1';
        var raw = codeEl.textContent || '';
        var btn = doc ? doc.createElement('button') : null;
        if (!btn || !pre.parentNode) return;
        btn.type = 'button';
        btn.className = 'ed-mermaid-render-btn';
        btn.textContent = 'Render diagram (large document mode)';
        btn.style.cssText = 'display:block;margin:8px 0;padding:6px 12px;cursor:pointer;';
        btn.setAttribute('data-mermaid-source', raw);
        btn.addEventListener('click', function () {
          pre.dataset.edHeavySkip = '0';
          pre.dataset.edMmd = '0';
          try { btn.remove(); } catch (eRm) {}
          highlightCode(rootElement, null);
        });
        pre.parentNode.insertBefore(btn, pre.nextSibling);
        pre.style.display = 'none';
      });
      return rootElement;
    }

    // hljs: highlight each block once per exact source text. The preview
    // container is rebuilt via innerHTML on every pass, so DOM flags alone
    // never survive; the source-hash cache is what actually skips work.
    // Identical code blocks share one entry: repeated snippets cost one
    // highlight no matter how often they appear in the document.
    if (typeof root.hljs !== 'undefined') {
      var blocks = rootElement.querySelectorAll('pre code');
      blocks.forEach(function (block) {
        if (block.dataset.edHl === '1') return;
        var src = block.textContent || '';
        var key = 'hl:' + edHash(block.className + '\n' + src);
        var cached = edCacheGet(key);
        if (cached !== null && cached !== undefined) {
          // Restore the whole node: highlightElement also mutates the
          // element's own class list (hljs theme hooks), so innerHTML
          // alone would lose syntax colors on cache hits.
        try {
            var holder = doc.createElement('div');
            holder.innerHTML = cached;
            var fresh = holder.firstChild;
            if (fresh && block.parentNode) {
              fresh.dataset.edHl = '1';
              block.parentNode.replaceChild(fresh, block);
        }
          } catch (eSwap) {}
          return;
        }
        try {
          root.hljs.highlightElement(block);
          block.dataset.edHl = '1';
          try { edCacheSet(key, block.outerHTML); } catch (eCache) {}
        } catch (e) {}
      });
    }

    // mermaid: render each diagram once per exact source text, synchronously
    // injecting the cached SVG on repeats. Async renders resolve into the
    // same placeholder (guarded by a per-node token so a stale render from
    // an older keystroke never overwrites a newer source).
    if (typeof root.mermaid !== 'undefined') {
      var pres = rootElement.querySelectorAll('pre');
      pres.forEach(function (pre) {
        if (pre.dataset.edMmd === '1') return;
        var codeEl = pre.querySelector('code');
        if (!codeEl) return;
        var cls = codeEl.className || '';
        var langMatch = cls.match(/(?:language|lang)-([\w-]+)/i);
        var lang = langMatch ? langMatch[1].toLowerCase() : '';
        if (lang !== 'mermaid') return;
        pre.dataset.edMmd = '1';
        var raw = codeEl.textContent || '';
        var key = 'mmd:' + edHash(raw);
        var hit = edCacheGet(key);
        var placeholder = doc ? doc.createElement('div') : null;
        if (!placeholder) return;
        placeholder.className = 'ed-mermaid';
        placeholder.style.cssText = 'padding:12px; border:1px solid var(--glass-border-hover, rgba(255,255,255,0.1)); border-radius:6px; background:rgba(0,0,0,0.15); margin:8px 0; overflow:auto;';
        pre.parentNode.insertBefore(placeholder, pre.nextSibling);
        pre.style.display = 'none';
        if (hit !== null && hit !== undefined) {
          placeholder.innerHTML = hit;
          return;
        }
        placeholder.textContent = raw;
        var token = (pre.dataset.edMmdToken = String(Date.now()) + Math.random().toString(36).slice(2));
        edMermaidRender(raw).then(function (svg) {
          if (pre.dataset.edMmdToken !== token) return; // superseded keystroke
          try { edCacheSet(key, svg); } catch (eSet) {}
          if (placeholder.isConnected) placeholder.innerHTML = svg;
        }, function (err) {
          if (pre.dataset.edMmdToken !== token) return;
          placeholder.className += ' mermaid-error';
          placeholder.textContent = '[mermaid] ' + (err && err.message ? err.message : String(err));
        });
      });
    }

    return rootElement;
  }

  root.EditorMarkdown = {
    renderMarkdown: renderMarkdown,
    sanitize: sanitize,
    highlightCode: highlightCode,
    buildToc: buildToc,
    getStats: getStats,
    toHtmlDocument: toHtmlDocument
  };
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this)));
