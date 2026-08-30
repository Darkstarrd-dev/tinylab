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

  // Hot-load: fetch remote provider JS and register it.
  function loadFromURL(url){
    return fetch(url).then(function(r){
      if(!r.ok) throw new Error('provider fetch '+r.status);
      return r.text();
    }).then(function(src){ return loadFromSource(src, url); });
  }

  // Built-in Jamendo provider (CC licensed, client_id 836523a7 via Nuclear .env)
  // API: https://api.jamendo.com/v3.0/tracks/?client_id=836523a7&format=json&limit=20&search=xxx
  // Issue 5: Jamendo 前端直连在某些网络/代理下无法命中时静默零结果；增加
  // 上游代理开关（localStorage tr:music:useProxy）时改走后端 /api/music/proxy。
  // Also supports tracks by id via /tracks/?id=xxx
  var JAMENDO_CLIENT = '836523a7';
  var JAMENDO_API = 'https://api.jamendo.com/v3.0';
  function musicUseProxy(){
    try{ return localStorage.getItem('tr:music:useProxy')==='1'; }catch(e){ return false; }
  }
  function fetchWithProxy(targetUrl, opts){
    if(!musicUseProxy()) return fetch(targetUrl, opts);
    return fetch('/api/music/proxy', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({url: targetUrl})}).then(function(r){
      if(!r.ok) return r.text().then(function(t){ throw new Error('proxy '+r.status+': '+t.slice(0,400)); });
      return r;
    });
  }

  function jamendoSearch(keyword, limit){
    var url = JAMENDO_API+'/tracks/?client_id='+JAMENDO_CLIENT+'&format=json&limit='+(limit||20)+'&search='+encodeURIComponent(keyword||'')+'&include=musicinfo&audioformat=mp32';
    return fetchWithProxy(url).then(function(r){
      if(!r.ok) return r.text().then(function(t){ throw new Error('Jamendo '+r.status+': '+t.slice(0,300)); });
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
    }).catch(function(e){
      // Surface as rejected so music.js Activity can show per-provider error instead of silently swallowing
      console.warn('[Jamendo] search failed', e);
      throw e;
    });
  }

  function jamendoGetMediaSource(song){
    // Jamendo audio is direct; just return
    var id = typeof song==='string'?song:(song&&song.id)||'';
    if(!id) return Promise.resolve(null);
    // If song already has url, reuse
    if(song && song.url) return Promise.resolve({url: song.url, quality:'mp3', source:'jamendo'});
    var url = JAMENDO_API+'/tracks/?client_id='+JAMENDO_CLIENT+'&format=json&id='+encodeURIComponent(id);
    return fetchWithProxy(url).then(function(r){ if(!r.ok) throw new Error('Jamendo '+r.status); return r.json();}).then(function(j){
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
    loadFromURL: loadFromURL,
    search: function(keyword, providerIds, limit){
      var ids = providerIds && providerIds.length ? providerIds : order.filter(function(id){ return registry[id] && registry[id].kind!=='local'; });
      // parallel search — per-provider errors are wrapped with provider id so Activity can show them
      var ps = ids.map(function(id){
        var p = registry[id];
        if(!p || !p.search) return Promise.resolve([]);
        try{
          return Promise.resolve(p.search(keyword, limit)).catch(function(e){
            var msg = (e && e.message) || String(e);
            console.warn('[MusicHost] search provider '+id+' failed: '+msg);
            // Propagate as tagged empty so overall search can still succeed with other providers
            // but the error is visible via console and music.js per-provider logging
            // (the previous code silently mapped to [] with no trace).
            throw new Error(id+': '+msg);
          });
        }catch(e){
          return Promise.resolve([]);
        }
      });
      // Use allSettled semantics: providers that fail don't kill the whole search, but errors are still visible
      return Promise.all(ps.map(function(p){ return p.catch(function(e){ return {__musicError: String(e&&e.message||e)}; }); })).then(function(groups){
        var out=[], errs=[];
        for(var i=0;i<groups.length;i++){
          var g=groups[i];
          if(g && g.__musicError){ errs.push(g.__musicError); }
          else out = out.concat(g||[]);
        }
        if(out.length===0 && errs.length){
          // All providers failed — surface combined error so the Activity panel can explain why (CSP/CORS/network)
          return Promise.reject(new Error(errs.join(' | ')));
        }
        if(errs.length) console.warn('[MusicHost] partial search errors: '+errs.join(' | '));
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
