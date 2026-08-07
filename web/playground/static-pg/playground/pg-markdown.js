// pg-markdown.js
// ----- Module 3: Markdown rendering pipeline ----------------------
var pgMarkerReady = false;
function pgInitMarker() {
  if (pgMarkerReady) return;
  if (typeof marked === 'undefined') return;
  if (typeof markedKatex !== 'undefined') {
    try { marked.use(markedKatex({ throwOnError: false, nonStandard: true })); } catch (e) {}
  }
  marked.use({
    renderer: {
      // marked@18 passes one Link token; older marked releases passed
      // (href, title, text). Accept both shapes so the shared renderer
      // remains compatible with either bundle.
      link: function(tokenOrHref, oldTitle, oldText) {
        var token = tokenOrHref && typeof tokenOrHref === 'object' ? tokenOrHref : null;
        var href = token ? token.href : tokenOrHref;
        var title = token ? token.title : oldTitle;
        var text = token ? token.text : oldText;
        var safeHref = pgMarkdownSafeHref(href);
        var label = token && this.parser && typeof this.parser.parseInline === 'function' && token.tokens
          ? this.parser.parseInline(token.tokens)
          : (text || href || '');
        var out = '<a href="' + pgMarkdownEscapeHtml(safeHref) + '" target="_blank" rel="noopener noreferrer">';
        if (title) out += ' data-tooltip="' + pgMarkdownEscapeHtml(title) + '"';
        out += token ? label : (label || safeHref);
        return out + '</a>';
      }
    }
  });
  pgMarkerReady = true;
}

function pgMarkdownEscapeHtml(value) {
  if (typeof pgEscapeHtml === 'function') return pgEscapeHtml(value == null ? '' : String(value));
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function pgMarkdownSafeHref(rawHref) {
  var href = rawHref == null ? '' : String(rawHref);
  try {
    var origin = (typeof window !== 'undefined' && window.location && window.location.origin) || 'http://localhost';
    var parsed = new URL(href, origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch (e) {}
  return '#';
}

// DOMPurify config that allows KaTeX output (SVG/MathML + presentation attrs).
var PG_PURIFY_CONFIG = (function() {
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
  return {
    ADD_TAGS: mathTags.concat(['svg','g','path','line','rect','circle','ellipse','polygon',
      'polyline','defs','use','clippath','clipPath','text','tspan','title','desc','symbol','marker','foreignobject','use']),
    ADD_ATTR: mathAttrs,
  };
})();

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

function pgTryWrapHtmlCode(text) {
  if (text.indexOf('```') >= 0) return text;
  text = text.replace(/([`]*?)(\w*?)([\n\r]*?)(<!DOCTYPE html>)/g, function(m, qs, lang, nl, dt) {
    return qs ? m : '\n```html\n' + dt;
  });
  text = text.replace(/(<\/body>)([\r\n\s]*?)(<\/html>)([\n\r]*)([`]*)([\n\r]*?)/g, function(m, b, sp, h, nl, qe, nl2) {
    return qe ? m : b + sp + h + '\n```\n';
  });
  return text;
}

// pgUnescapeMarkdownSyntax strips backslash escapes before markdown syntax
// characters. The AnySearch API returns over-escaped markdown (e.g. `\``
// instead of `` ` ``), preventing marked from recognizing code blocks,
// emphasis, headings, etc. This function restores the raw syntax so marked
// can parse it correctly. Literal backslashes (\\) are preserved.
function pgUnescapeMarkdownSyntax(text) {
  if (!text || text.indexOf('\\') < 0) return text;
  var P = '\x00BS\x00';
  text = text.replace(/\\\\/g, P);
  text = text.replace(/\\([`*_{}[\]()#+\-.!])/g, '$1');
  text = text.replace(new RegExp(P, 'g'), '\\');
  return text;
}

function pgRenderMarkdown(text, isUser) {
  if (!text) return '';
  if (typeof marked !== 'undefined') {
    pgInitMarker();
    try {
      var pre = pgTryWrapHtmlCode(text);
      pre = pgEscapeBrackets(pre);
      pre = pgNormalizeDisplayMath(pre);
      var html = marked.parse(pre, { breaks: true, gfm: true });
      if (typeof DOMPurify !== 'undefined') {
        return DOMPurify.sanitize(html, PG_PURIFY_CONFIG);
      }
    } catch (e) { /* fall through to escaping */ }
  }
  return '<p>' + pgEscapeHtml(text).replace(/\n/g, '<br>') + '</p>';
}

function pgHighlight(container) {
  if (typeof hljs === 'undefined') return;
  container.querySelectorAll('pre code').forEach(function(block) {
    if (block.dataset.pgHl === '1') return;
    block.dataset.pgHl = '1';
    try { hljs.highlightElement(block); } catch (e) {}
  });
}

var PG_THINK_OPEN = String.fromCharCode(60) + 'think' + String.fromCharCode(62);
var PG_THINK_CLOSE = String.fromCharCode(60) + '/think' + String.fromCharCode(62);
var PG_THINK_RE = new RegExp('^\\s*' + PG_THINK_OPEN.replace(/([<\/ ])/g, '\\$1') + '([\\s\\S]*?)' + PG_THINK_CLOSE.replace(/([<\/ ])/g, '\\$1'));
var PG_THINK_ALL_RE = new RegExp(PG_THINK_OPEN.replace(/([<\/ ])/g, '\\$1') + '([\\s\\S]*?)' + PG_THINK_CLOSE.replace(/([<\/ ])/g, '\\$1'), 'g');

function pgSplitReasoning(text) {
  var reasoning = '';
  var m = text.match(PG_THINK_RE);
  if (m) {
    reasoning = m[1];
    text = text.slice(m[0].length);
  } else if (text.indexOf(PG_THINK_OPEN) === 0) {
    reasoning = text.slice(PG_THINK_OPEN.length);
    text = '';
  }
  return { content: text, reasoning: reasoning };
}

function pgExtractAllReasoning(text) {
  if (text.indexOf(PG_THINK_OPEN) < 0) return { content: text, reasoning: '' };
  var reasoningParts = [];
  text = text.replace(PG_THINK_ALL_RE, function(_, inner) {
    reasoningParts.push(inner);
    return '';
  });
  var openIdx = text.indexOf(PG_THINK_OPEN);
  if (openIdx >= 0) {
    reasoningParts.push(text.slice(openIdx + PG_THINK_OPEN.length));
    text = text.slice(0, openIdx);
  }
  return { content: text.trim(), reasoning: reasoningParts.join('\n').trim() };
}