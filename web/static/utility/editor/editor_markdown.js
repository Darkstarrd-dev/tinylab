/* Utility Editor Markdown helpers. Classic-script module; optional globals are used when present. */
(function (root) {
  'use strict';

  if (!root || root.EditorMarkdown) return;

  var URI_ATTRS = { href: true, src: true, action: true, formaction: true, 'xlink:href': true };
  var SAFE_URI = /^(?:(?:https?|mailto|tel):|[\/#]|\.{0,2}\/|[^:]+$)/i;
  var EXTERNAL_URI = /^https?:\/\//i;

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

  function highlightCode(rootElement) {
    if (!rootElement || !rootElement.querySelectorAll) return rootElement;

    if (typeof root.hljs !== 'undefined') {
      var blocks = rootElement.querySelectorAll('pre code');
      blocks.forEach(function (block) {
        if (block.dataset.edHl === '1') return;
        block.dataset.edHl = '1';
        try { root.hljs.highlightElement(block); } catch (e) {}
      });
    }

    if (typeof root.mermaid !== 'undefined') {
      var pres = rootElement.querySelectorAll('pre');
      pres.forEach(function (pre) {
        if (pre.dataset.edMmd === '1') return;
        var codeEl = pre.querySelector('code');
        if (!codeEl) return;
        var cls = codeEl.className || '';
        var langMatch = cls.match(/(?:language|lang)-([\w-]+)/i);
        var lang = langMatch ? langMatch[1].toLowerCase() : '';
        if (lang === 'mermaid') {
          pre.dataset.edMmd = '1';
          var raw = codeEl.textContent || '';
          var placeholder = root.document.createElement('div');
          placeholder.className = 'ed-mermaid';
          placeholder.style.cssText = 'padding:12px; border:1px solid var(--glass-border-hover, rgba(255,255,255,0.1)); border-radius:6px; background:rgba(0,0,0,0.15); margin:8px 0; overflow:auto;';
          placeholder.textContent = raw;
          pre.parentNode.insertBefore(placeholder, pre.nextSibling);
          pre.style.display = 'none';
          try {
            root.mermaid.run({ nodes: [placeholder], suppressErrors: true });
          } catch (err) {
            placeholder.className += ' mermaid-error';
            placeholder.textContent = '[mermaid] ' + (err && err.message ? err.message : String(err));
          }
        }
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
