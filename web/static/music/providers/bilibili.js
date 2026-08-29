// web/static/music/providers/bilibili.js
// Bilibili provider for MusicHost — Azusa-style bvid -> cid -> playurl extractor.
// Requires backend proxy (POST /api/music/bilibili) to avoid Bilibili CORS/referer.
// Exposes hot-loadable export: `var plugin = {id:'bilibili',...}` (also `register(plugin)` if MusicHost present).
// API: search(keyword) hits Bilibili search, getMediaSource(song) resolves audio url via backend.
(function(global){
  function apiFetch(path, opts){
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type'] = 'application/json';
    }
    return fetch(path, opts).then(function(r){
      if (!r.ok) return r.text().then(function(t){ throw new Error(t || ('HTTP '+r.status)); });
      var ct = r.headers.get('content-type') || '';
      return ct.indexOf('application/json') >= 0 ? r.json() : r.text();
    });
  }

  function search(keyword, limit){
    var q = (keyword || '').trim();
    if (!q) return Promise.resolve([]);
    // Delegate to backend — backend mimics Bilibili search mapping to Song[]
    return apiFetch('/api/music/bilibili/search?keyword=' + encodeURIComponent(q) + '&limit=' + (limit || 20))
      .then(function(data){ return Array.isArray(data) ? data : (data.results || data.data || []); })
      .catch(function(e){ console.warn('[Bilibili] search', e); throw e; });
  }

  function getMediaSource(song){
    var id = typeof song === 'string' ? song : (song && (song.bvid || song.id) || '');
    var cid = song && song.cid || '';
    if (!id) return Promise.resolve(null);
    // Backend resolves bvid/cid -> audio url (playurl durl[0].url)
    return apiFetch('/api/music/bilibili/resolve', { method:'POST', body:{ bvid: id, cid: cid } })
      .then(function(data){
        var url = (data && (data.url || data.audio || data.src)) || '';
        if (!url) return null;
        return { url: url, quality: 'm4a', source:'bilibili', bvid: data.bvid||id, cid: data.cid||cid };
      })
      .catch(function(e){ console.warn('[Bilibili] resolve', e); throw e; });
  }

  var plugin = { id:'bilibili', name:'Bilibili', kind:'builtin', search: search, getMediaSource: getMediaSource };
  if (global.MusicHost && typeof global.MusicHost.register === 'function') global.MusicHost.register(plugin);
  // expose for loadFromSource hot-load path
  try { global.plugin = plugin; } catch(_e){}
  if (typeof module !== 'undefined' && module.exports) module.exports = plugin;
})(typeof window!=='undefined'?window:globalThis);
