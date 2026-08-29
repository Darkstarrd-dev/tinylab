// web/static/music/providers/example-generic.js
// Example Generic provider — demonstrates Listen1/LX-style custom source contract
// without copying any upstream site's private logic. Replace search/getMediaSource
// bodies with per-site fetch+parse when wiring a real source (e.g. via
// MusicHost.loadFromSource(remoteJS)). This file is a template + a working
// Jamendo mirror to prove the hot-load path end-to-end.
//
// Hot-load contract: the evaluated JS must expose `var plugin = {id,...}`
// or `module.exports`. MusicHost.loadFromSource(sourceCode, expectedId)
// will register it. See docs/music-implementation-plan.md §2/§4.
(function(global){
  // Template search: override with real API. Here mirrors Jamendo search
  // to keep an additional demo source in Stage 3 without external auth.
  var JAMENDO_API = 'https://api.jamendo.com/v3.0';
  var CLIENT = '56d30dc8';
  function search(keyword, limit){
    var url = JAMENDO_API + '/tracks/?client_id=' + CLIENT + '&format=json&limit=' + (limit || 12) + '&search=' + encodeURIComponent(keyword || '') + '&audioformat=mp32';
    return fetch(url).then(function(r){ if(!r.ok) throw new Error('Jamendo '+r.status); return r.json(); })
      .then(function(j){
        var arr = j.results || [];
        return arr.slice(0, 6).map(function(t){
          return {
            id: 'generic:' + t.id,
            title: (t.name || t.title || 'Untitled') + ' (Generic demo)',
            artist: t.artist_name || '',
            album: t.album_name || '',
            duration: t.duration || 0,
            url: t.audio || '',
            downloadUrl: (t.audiodownload || {}).url || t.audio || '',
            cover: t.image || '',
            source: 'generic',
            raw: t
          };
        }).filter(function(s){ return !!s.url; });
      }).catch(function(){ return []; });
  }
  function getMediaSource(song){
    var url = song && (song.url || song.downloadUrl) || '';
    if (!url) return Promise.resolve(null);
    return Promise.resolve({ url:url, quality:'mp3', source:'generic' });
  }
  var plugin = { id:'generic', name:'Generic (demo)', kind:'builtin', search:search, getMediaSource:getMediaSource };
  if (global.MusicHost && typeof global.MusicHost.register === 'function') global.MusicHost.register(plugin);
  try { global.plugin = plugin; } catch(_e){}
  if (typeof module !== 'undefined' && module.exports) module.exports = plugin;
})(typeof window!=='undefined'?window:globalThis);
