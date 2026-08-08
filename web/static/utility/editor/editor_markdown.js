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

  function sanitize(html) {
    var source = asText(html);
    var purifier = root.DOMPurify;
    if (purifier && typeof purifier.sanitize === 'function') {
      try {
        source = purifier.sanitize(source, {
          FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form'],
          FORBID_ATTR: ['style'],
          ALLOW_UNKNOWN_PROTOCOLS: false,
          ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[\/#]|\.{0,2}\/|[^:]+$)/i
        });
      } catch (e) {
        return fallbackSanitize(source);
      }
      var doc = getDocument();
      if (doc && doc.createElement) {
        try {
          var wrapper = doc.createElement('div');
          wrapper.innerHTML = source;
          var all = wrapper.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var element = all[i];
            for (var ai = element.attributes.length - 1; ai >= 0; ai--) {
              var attr = element.attributes[ai];
              var name = attr.name.toLowerCase();
              if (/^on/i.test(name) || (URI_ATTRS[name] && !uriIsSafe(attr.value))) element.removeAttribute(attr.name);
            }
          }
          decorateLinks(wrapper);
          source = wrapper.innerHTML;
        } catch (e2) { /* DOMPurify output is still safe */ }
      }
      return source;
    }
    return fallbackSanitize(source);
  }

  function prismLanguage(name) {
    var prism = root.Prism;
    if (!prism || !prism.languages) return null;
    var language = asText(name).toLowerCase().replace(/[^a-z0-9_+-]/g, '');
    if (!language) return null;
    if (prism.languages[language]) return prism.languages[language];
    var aliases = { js: 'javascript', jsx: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', sh: 'bash', shell: 'bash', html: 'markup', xml: 'markup', md: 'markdown' };
    return prism.languages[aliases[language]] || null;
  }

  function renderMarkdown(text, options) {
    var source = asText(text);
    var opts = options && typeof options === 'object' ? options : {};
    var markdownFactory = root.markdownit;
    if (typeof markdownFactory !== 'function') return '<pre>' + escapeHtml(source) + '</pre>';

    var md;
    var mdOptions = {
      html: opts.html !== false,
      breaks: opts.breaks !== false,
      linkify: opts.linkify !== false,
      typographer: opts.typographer !== false
    };
    try {
      md = markdownFactory(mdOptions);
    } catch (e) {
      try { md = markdownFactory({}); } catch (e2) { md = null; }
    }
    if (!md || !md.render) return '<pre>' + escapeHtml(source) + '</pre>';

    if (md.renderer && md.renderer.rules) {
      var originalFence = md.renderer.rules.fence;
      md.renderer.rules.fence = function (tokens, idx, renderingOptions, env, self) {
        var token = tokens[idx];
        var info = asText(token.info).trim().split(/\s+/)[0] || '';
        var className = info.replace(/[^a-zA-Z0-9_-]/g, '');
        var language = prismLanguage(info);
        var code = asText(token.content);
        var highlighted = escapeHtml(code);
        var prism = root.Prism;
        if (language && prism && typeof prism.highlight === 'function') {
          try { highlighted = prism.highlight(code, language, info); } catch (e) { highlighted = escapeHtml(code); }
        }
        return '<pre><code' + (className ? ' class="language-' + className + '"' : '') + '>' + highlighted + '</code></pre>\n';
      };
      try {
        return sanitize(md.render(source));
      } catch (e3) {
        if (originalFence) md.renderer.rules.fence = originalFence;
      }
    }
    try { return sanitize(md.render(source)); } catch (e4) { return '<pre>' + escapeHtml(source) + '</pre>'; }
  }
  function slugify(value) {
    var slug = asText(value).replace(/^\s+|\s+$/g, '').toLowerCase();
    try { slug = slug.normalize('NFKD'); } catch (e) {}
    // Keep non-ASCII letters usable in ids while removing punctuation.
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
    var prism = root.Prism;
    if (!rootElement || !prism) return rootElement;
    var blocks = rootElement.querySelectorAll ? rootElement.querySelectorAll('pre code') : [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var match = (block.className || '').match(/(?:language|lang)-([\w+-]+)/i);
      var language = prismLanguage(match ? match[1] : '');
      if (!language || typeof prism.highlight !== 'function') continue;
      try { block.innerHTML = prism.highlight(block.textContent || '', language, match[1]); } catch (e) {}
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
