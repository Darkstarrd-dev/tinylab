// web/static/music/host.js
// Plugin host: sandbox for MusicFree/LX/Listen1-style provider scripts.
// Zero deps. Providers are plain JS strings exposing {id, name, search, getMediaSource}.
// This MVP ships with a built-in Jamendo provider (API) and accepts future plugin JS via fetch.
(function(global){
  var registry = {};
  var order = [];

  function register(plugin){
    if(!plugin || !plugin.id) return;
    registry[plugin.id]=plugin;
    if(order.indexOf(plugin.id)===-1) order.push(plugin.id);
  }

  function list(){ return order.map(function(id){return registry[id];}); }

  function get(id){ return registry[id]||null; }

  // Sandbox: evaluate provider JS string returning plugin object.
  // providerJS expected to define a global-like plugin or return it.
  // We use new Function to isolate; no eval leakage.
  function loadFromSource(sourceCode, expectedId){
    try{
      var fn = new Function('register','fetch','console','URL','URLSearchParams','__expectedId',
        '"use strict";\n'+sourceCode+'\n;return typeof plugin!=="undefined"?plugin:(typeof module!=="undefined"&&module.exports?module.exports:null);');
      var mod = fn(register, global.fetch ? global.fetch.bind(global): function(){return Promise.reject(new Error('fetch unavailable'));}, global.console, global.URL, global.URLSearchParams, expectedId||'');
      if(mod && mod.id) register(mod);
      return mod;
    }catch(e){ console.warn('[Music Host] loadFromSource',e); return null; }
  }

  // Built-in Jamendo provider (CC licensed, no key, client_id demo 56d30dc8)
  // API: https://api.jamendo.com/v3.0/tracks/?client_id=56d30dc8&format=json&limit=20&search=xxx
  // Also supports tracks by id via /tracks/?id=xxx
  var JAMENDO_CLIENT = '56d30dc8';
  var JAMENDO_API = 'https://api.jamendo.com/v3.0';

  function jamendoSearch(keyword, limit){
    var url = JAMENDO_API+'/tracks/?client_id='+JAMENDO_CLIENT+'&format=json&limit='+(limit||20)+'&search='+encodeURIComponent(keyword||'')+'&include=musicinfo&audioformat=mp32';
    return fetch(url).then(function(r){
      if(!r.ok) throw new Error('Jamendo '+r.status);
      return r.json();
    }).then(function(j){
      var arr = j.results || j.tracks || [];
      return arr.map(function(t){
        return {
          id: String(t.id),
          title: t.name || t.title || 'Untitled',
          artist: t.artist_name || '',
          album: t.album_name || '',
          duration: t.duration || 0,
          url: t.audio || t.audio_url || '',
          downloadUrl: (t.audiodownload || t.audioDownload || {}).url || t.audio || '',
          cover: t.image || t.album_image || (t.album && t.album.image) || '',
          source: 'jamendo',
          raw: t
        };
      }).filter(function(s){ return !!s.url; });
    });
  }

  function jamendoGetMediaSource(song){
    // Jamendo audio is direct; just return
    var id = typeof song==='string'?song:(song&&song.id)||'';
    if(!id) return Promise.resolve(null);
    // If song already has url, reuse
    if(song && song.url) return Promise.resolve({url: song.url, quality:'mp3', source:'jamendo'});
    var url = JAMENDO_API+'/tracks/?client_id='+JAMENDO_CLIENT+'&format=json&id='+encodeURIComponent(id);
    return fetch(url).then(function(r){return r.json();}).then(function(j){
      var t=(j.results||j.tracks||[])[0];
      if(!t) return null;
      return {url: t.audio || t.audio_url || '', quality:'mp3', source:'jamendo'};
    });
  }

  register({
    id: 'jamendo',
    name: 'Jamendo (CC)',
    search: jamendoSearch,
    getMediaSource: jamendoGetMediaSource,
    kind: 'builtin'
  });

  // Local provider: tracks are created from File objects (ObjectURLs)
  register({
    id: 'local',
    name: 'Local',
    search: function(){ return Promise.resolve([]); },
    getMediaSource: function(song){
      if(song && song._objectUrl) return Promise.resolve({url: song._objectUrl, quality:'local', source:'local'});
      return Promise.resolve(null);
    },
    kind: 'local'
  });

  // Expose
  global.MusicHost = {
    register: register,
    list: list,
    get: get,
    loadFromSource: loadFromSource,
    search: function(keyword, providerIds, limit){
      var ids = providerIds && providerIds.length ? providerIds : order.filter(function(id){ return registry[id] && registry[id].kind!=='local'; });
      // parallel search
      var ps = ids.map(function(id){
        var p = registry[id];
        if(!p || !p.search) return Promise.resolve([]);
        try{ return Promise.resolve(p.search(keyword, limit)).catch(function(){return [];}); }catch(e){ return Promise.resolve([]); }
      });
      return Promise.all(ps).then(function(groups){
        var out=[]; for(var i=0;i<groups.length;i++) out = out.concat(groups[i]||[]);
        return out;
      });
    },
    getMediaSource: function(song){
      var src = (song&&song.source)||'jamendo';
      var p = registry[src] || registry['jamendo'];
      if(!p || !p.getMediaSource) return Promise.resolve(null);
      return Promise.resolve(p.getMediaSource(song));
    }
  };
})(typeof window!=='undefined'?window:globalThis);
