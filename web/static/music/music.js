// web/static/music/music.js
// Music MVP — Jamendo search + local File + <audio> queue + download to Musics.
// Depends: host.js (MusicHost), player.js (MusicPlayer)
(function(){
  var player = null;
  var queue = []; // Song[]
  var searchResults = [];
  var selectedProviders = ['jamendo']; // multi-select, default jamendo only

  function fmtDuration(sec){
    sec = Math.round(sec||0);
    var m = Math.floor(sec/60), s = sec%60;
    return (m<10?'0':'')+m+':'+(s<10?'0':'')+s;
  }

  function musicUseProxy(){
    try{ return localStorage.getItem('tr:music:useProxy')==='1'; }catch(e){ return false; }
  }
  function setMusicUseProxy(v){
    try{ localStorage.setItem('tr:music:useProxy', v?'1':'0'); }catch(e){}
  }

  function ensurePlayer(){
    if(player) return player;
    player = new MusicPlayer();
    player.on('track', function(song){ syncNowPlaying(song); musicLog('Now playing: "'+(song&&song.title||'')+'" — '+ (song&&song.artist||''),'ok'); });
    player.on('timeupdate', syncProgress);
    player.on('play', syncPlayBtn);
    player.on('pause', syncPlayBtn);
    player.on('error', function(e){ var msg=(e&&e.message)||String(e); console.warn('[Music] play error', e); musicLog('Audio error: '+msg+' — check media URL / CORS / Referer','error'); if(typeof toast==='function') toast('Playback failed: '+msg,'error'); });
    player.audio.addEventListener('loadedmetadata', syncProgress);
    // <audio> 自身错误（MediaError）也进 Activity
    player.audio.addEventListener('error', function(){
      var me=player.audio.error;
      var code=me?me.code:0;
      var msg=me?('MediaError '+code+': '+(me.message||'')):'audio error';
      musicLog(msg,'error');
    });
    return player;
  }

  function syncNowPlaying(song){
    var el = document.getElementById('music-now-title');
    if(el) el.textContent = (song&&song.title)||'—';
    var el2 = document.getElementById('music-now-artist');
    if(el2) el2.textContent = (song&&song.artist)||'';
    var cov = document.getElementById('music-cover');
    if(cov){
      var url = (song&&song.cover)||'';
      cov.style.backgroundImage = url ? 'url('+JSON.stringify(url).slice(1,-1)+')' : 'none';
      cov.textContent = url ? '' : '♫';
    }
    syncQueueHighlight();
  }
  function syncQueueHighlight(){
    var cur = player && player.current();
    document.querySelectorAll('#music-queue .music-queue-item').forEach(function(row){
      var id = row.getAttribute('data-id');
      row.classList.toggle('active', !!cur && String(cur.id)===String(id));
    });
    syncPlayBtn();
  }
  function syncPlayBtn(){
    var btn = document.getElementById('music-btn-play');
    if(!btn || !player) return;
    btn.textContent = (!player.audio.paused && !player.audio.ended) ? '⏸' : '▶';
  }
  function syncProgress(){
    if(!player) return;
    var cur = player.audio.currentTime||0, dur = player.audio.duration||0;
    var fill = document.getElementById('music-progress-fill');
    var curEl = document.getElementById('music-cur');
    var durEl = document.getElementById('music-dur');
    if(fill) fill.style.width = (dur? (cur/dur*100):0)+'%';
    if(curEl) curEl.textContent = fmtDuration(cur);
    if(durEl) durEl.textContent = fmtDuration(dur);
  }

  function apiFetch(path, opts){
    opts = opts||{};
    opts.headers = opts.headers||{};
    if(opts.body && typeof opts.body==='object' && !(opts.body instanceof FormData)){
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type']='application/json';
    }
    return fetch(path, opts).then(function(r){
      if(!r.ok) return r.text().then(function(t){ throw new Error(t||('HTTP '+r.status)); });
      var ct=r.headers.get('content-type')||'';
      return ct.indexOf('application/json')>=0 ? r.json() : r.text();
    });
  }

  // Download-style trace panel: explicit step/request/feedback display so silent failures are visible.
  var musicTrace = []; // {ts, msg, kind:'step'|'req'|'ok'|'warn'|'error'}
  function musicLog(msg, kind){
    var ts = new Date().toLocaleTimeString();
    musicTrace.push({ts: ts, msg: String(msg), kind: kind||'step'});
    if(musicTrace.length>120) musicTrace.shift();
    console.log('[Music]['+kind+'] '+msg);
    renderMusicTrace();
  }
  function renderMusicTrace(){
    var el=document.getElementById('music-trace');
    if(!el) return;
    if(!musicTrace.length){ el.innerHTML='<div style="color:var(--text-tertiary);font-size:11px;padding:4px">No activity yet — search to see steps here. Like Download, each step and request is logged with feedback.</div>'; return; }
    el.innerHTML = musicTrace.slice(-80).map(function(e){
      var c = e.kind==='error' ? 'var(--danger)' : e.kind==='warn' ? 'var(--warning,#e6a23c)' : e.kind==='ok' ? 'var(--success,#67c23a)' : e.kind==='req' ? 'var(--text-secondary)' : 'var(--text-tertiary)';
      return '<div style="font-size:11px;line-height:1.5;color:'+c+';white-space:pre-wrap;word-break:break-all">['+escapeHtml(e.ts)+'] '+escapeHtml(e.msg)+'</div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  function renderMusic(container){
    container.innerHTML = ''+
      '<div class="music-page" style="display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden">'+
        '<div style="display:flex;gap:8px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--glass-border);flex-wrap:wrap">'+
          '<div style="display:flex;gap:8px;align-items:center;flex:1;min-width:220px">'+
            '<input id="music-search" placeholder="Search — e.g. lofi, piano, jazz" style="flex:1;min-width:160px;padding:8px 10px;border-radius:8px;border:1px solid var(--glass-border);background:var(--input-bg);color:var(--text)">'+
            '<button id="music-search-btn" class="btn btn-primary">Search</button>'+
          '</div>'+
          '<div id="music-provider-chips" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"></div>'+
          '<label class="btn btn-ghost" style="cursor:pointer;white-space:nowrap"><input id="music-use-proxy" type="checkbox" style="margin-right:6px;vertical-align:middle">Proxy</label>'+
          '<label class="btn btn-ghost" style="cursor:pointer">Local<input id="music-file" type="file" accept="audio/*,.mp3,.flac,.wav,.ogg,.m4a,.aac,.opus,.wma,.ape" multiple hidden></label>'+
          '<button id="music-refresh-lib" class="btn btn-ghost" title="Refresh local Musics">Library</button>'+
          '<button class="btn btn-ghost" onclick="openPathSettingsModal({title:t(\'pathSettings\'),sections:{musicDir:true}})">'+escapeHtml(t('pathSettings')||'Path Settings')+'</button>'+
        '</div>'+
        '<div id="music-playlists-bar" style="display:flex;gap:8px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--glass-border);flex-wrap:wrap;background:var(--glass-bg)">'+
          '<select id="music-playlist-select" style="min-width:160px;padding:6px 8px;border-radius:8px;border:1px solid var(--glass-border);background:var(--input-bg);color:var(--text)"><option value="">Playlists — Musics/playlists.json</option></select>'+
          '<input id="music-playlist-name" placeholder="New playlist name" style="padding:6px 8px;border-radius:8px;border:1px solid var(--glass-border);background:var(--input-bg);color:var(--text);min-width:140px">'+
          '<button id="music-pl-create" class="btn btn-ghost">Create</button>'+
          '<button id="music-pl-savequeue" class="btn btn-ghost" title="Save queue to selected playlist">Save queue →</button>'+
          '<button id="music-pl-load" class="btn btn-ghost" title="Load selected playlist to queue">Load → queue</button>'+
          '<button id="music-pl-export" class="btn btn-ghost" title="Export selected as .m3u">Export m3u</button>'+
          '<label class="btn btn-ghost" style="cursor:pointer">Import m3u<input id="music-m3u-file" type="file" accept=".m3u,.m3u8" hidden></label>'+
          '<input id="music-pl-url" placeholder="Import playlist URL (remote m3u/json)" style="flex:1;min-width:180px;padding:6px 8px;border-radius:8px;border:1px solid var(--glass-border);background:var(--input-bg);color:var(--text)">'+
          '<button id="music-pl-import-url" class="btn btn-ghost">Fetch</button>'+
        '</div>'+
        '<div style="display:flex;flex:1;min-height:0;overflow:hidden">'+
          // left: results + library
          '<div style="flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;border-right:1px solid var(--glass-border)">'+
            '<div id="music-results" style="flex:1;overflow:auto;padding:12px"></div>'+
            '<div style="border-top:1px solid var(--glass-border);padding:10px 12px;max-height:38%;overflow:auto">'+
              '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px"><b style="font-size:13px">Library — Musics</b><span id="music-lib-dir" style="font-size:11px;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%"></span></div>'+
              '<div id="music-library" style="font-size:12px;color:var(--text-secondary)">—</div>'+
            '</div>'+
            '<div style="border-top:1px solid var(--glass-border);padding:8px 12px;max-height:32%;overflow:auto;background:rgba(0,0,0,0.12)">'+
              '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;gap:8px"><b style="font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:var(--text-tertiary)">Activity — steps &amp; requests (like Download)</b><div style="display:flex;gap:6px"><button id="music-trace-copy" class="btn btn-ghost" style="padding:3px 8px;font-size:11px">Copy</button><button id="music-trace-clear" class="btn btn-ghost" style="padding:3px 8px;font-size:11px">Clear</button></div></div>'+
              '<div id="music-trace" style="font-family:ui-monospace,monospace;font-size:11px;min-height:64px;max-height:160px;overflow:auto;border:1px solid var(--glass-border);border-radius:8px;padding:6px;background:var(--glass-bg)"></div>'+
            '</div>'+
          '</div>'+
          // right: queue + player
          '<div style="width:360px;max-width:42%;display:flex;flex-direction:column;min-width:280px;background:var(--glass-bg);border-left:1px solid var(--glass-border)">'+
            '<div style="padding:12px;border-bottom:1px solid var(--glass-border)">'+
              '<div style="display:flex;gap:10px;align-items:center">'+
                '<div id="music-cover" style="width:56px;height:56px;border-radius:8px;background:var(--glass-hover);display:flex;align-items:center;justify-content:center;font-size:22px;color:var(--text-tertiary);background-size:cover;background-position:center;flex-shrink:0">♫</div>'+
                '<div style="min-width:0;flex:1">'+
                  '<div id="music-now-title" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">—</div>'+
                  '<div id="music-now-artist" style="font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>'+
                '</div>'+
              '</div>'+
              '<div style="display:flex;gap:6px;margin-top:10px;align-items:center;flex-wrap:wrap">'+
                '<button id="music-btn-prev" class="btn btn-ghost" title="Prev">⏮</button>'+
                '<button id="music-btn-play" class="btn btn-primary" style="min-width:44px" title="Play/Pause">▶</button>'+
                '<button id="music-btn-next" class="btn btn-ghost" title="Next">⏭</button>'+
                '<button id="music-btn-shuffle" class="btn btn-ghost" title="Shuffle">⇄</button>'+
                '<button id="music-btn-loop" class="btn btn-ghost" title="Loop">↻</button>'+
                '<span style="margin-left:auto;font-size:11px;color:var(--text-tertiary)"><span id="music-cur">00:00</span> / <span id="music-dur">00:00</span></span>'+
              '</div>'+
              '<div id="music-progress" style="height:6px;background:var(--glass-border);border-radius:999px;margin-top:8px;overflow:hidden;cursor:pointer;position:relative"><div id="music-progress-fill" style="height:100%;width:0;background:var(--accent);transition:width 0.12s"></div></div>'+
            '</div>'+
            '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--glass-border)"><b style="font-size:12px">Queue</b><span id="music-queue-count" style="font-size:11px;color:var(--text-tertiary)">0</span></div>'+
            '<div id="music-queue" style="flex:1;overflow:auto;padding:8px 8px 12px 8px"></div>'+
          '</div>'+
        '</div>'+
      '</div>';
    ensurePlayer();
    bindMusicEvents(container);
    renderResults([]);
    renderMusicTrace();
    refreshLibrary();
    // Issue 6: 不再自动检索。仅在结果为空时提示用户主动点击搜索
  }

  function renderProviderChips(){
    var el=document.getElementById('music-provider-chips'); if(!el) return;
    var host=window.MusicHost; var providers=(host&&host.list()||[]).filter(function(p){return p.id!=='local';});
    if(providers.length===0) providers=[{id:'jamendo',name:'Jamendo'}];
    el.innerHTML = providers.map(function(p){
      var on = selectedProviders.indexOf(p.id)>=0;
      return '<button data-prov="'+escapeHtml(p.id)+'" class="btn '+(on?'btn-primary':'btn-ghost')+'" style="padding:4px 8px;font-size:11px;border-radius:999px">'+escapeHtml(p.name||p.id)+'</button>';
    }).join('');
    el.querySelectorAll('button[data-prov]').forEach(function(b){
      b.addEventListener('click', function(){
        var id=b.getAttribute('data-prov');
        var i=selectedProviders.indexOf(id);
        if(i>=0) { if(selectedProviders.length>1) selectedProviders.splice(i,1); }
        else selectedProviders.push(id);
        renderProviderChips();
      });
    });
  }

  function bindMusicEvents(container){
    var searchBtn = document.getElementById('music-search-btn');
    var searchInp = document.getElementById('music-search');
    var fileInp = document.getElementById('music-file');
    var prog = document.getElementById('music-progress');
    renderProviderChips();
    if(searchBtn) searchBtn.onclick = doSearch;
    if(searchInp) searchInp.addEventListener('keydown', function(e){ if(e.key==='Enter') doSearch(); });
    var proxyChk=document.getElementById('music-use-proxy');
    if(proxyChk){
      proxyChk.checked = musicUseProxy();
      proxyChk.title='Use backend proxy for Jamendo (like Download useProxy)';
      proxyChk.addEventListener('change', function(){
        setMusicUseProxy(proxyChk.checked);
        musicLog('Settings: Music proxy '+(proxyChk.checked?'ON':'OFF')+' — Jamendo will '+(proxyChk.checked?'go via /api/music/proxy':'fetch directly'),'step');
      });
    }
    // trace panel controls
    var trCopy=document.getElementById('music-trace-copy');
    var trClear=document.getElementById('music-trace-clear');
    if(trClear) trClear.onclick=function(){ musicTrace=[]; renderMusicTrace(); };
    if(trCopy) trCopy.onclick=function(){
      var t=musicTrace.map(function(x){return '['+x.ts+']['+x.kind+'] '+x.msg;}).join('\n');
      if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function(){ if(typeof toast==='function') toast('Copied','success'); }).catch(function(){});
      else if(typeof toast==='function') toast(t.slice(0,120),'info');
    };
    if(fileInp) fileInp.addEventListener('change', function(e){
      var files = Array.from(e.target.files||[]);
      if(!files.length) return;
      musicLog('Local: selected '+files.length+' file(s): '+files.map(function(f){return f.name;}).join(', '),'step');
      files.forEach(function(f){
        var url = URL.createObjectURL(f);
        var song = { id:'local:'+Date.now()+':'+f.name, title: f.name.replace(/\.[^.]+$/,''), artist:'Local', album:'', duration:0, url:url, _objectUrl:url, cover:'', source:'local', _file:f };
        addToQueue(song, false);
      });
      musicLog('Local: added '+files.length+' to queue','ok');
      e.target.value='';
    });
    var btnPrev=document.getElementById('music-btn-prev'); if(btnPrev) btnPrev.onclick=function(){ player && player.prev(); };
    var btnPlay=document.getElementById('music-btn-play'); if(btnPlay) btnPlay.onclick=function(){ if(!player) return; if(player.queue.length===0 && queue.length) { player.setQueue(queue,0); player.playAt(0); } else player.toggle(); syncPlayBtn(); };
    var btnNext=document.getElementById('music-btn-next'); if(btnNext) btnNext.onclick=function(){ player && player.next(); };
    var btnShuf=document.getElementById('music-btn-shuffle'); if(btnShuf) btnShuf.onclick=function(){
      if(!player) return; player.setShuffle(!player.shuffle); btnShuf.classList.toggle('active', player.shuffle); btnShuf.style.background = player.shuffle ? 'var(--glass-active)' : '';
    };
    var btnLoop=document.getElementById('music-btn-loop'); if(btnLoop) btnLoop.onclick=function(){
      if(!player) return; var m=player.cycleLoop(); btnLoop.textContent = m==='one' ? '↻1' : (m==='all' ? '↻∞' : '↻'); btnLoop.title='Loop: '+m;
    };
    if(prog) prog.addEventListener('click', function(e){
      if(!player) return;
      var r=prog.getBoundingClientRect(); var ratio=(e.clientX - r.left)/r.width; player.seek(Math.max(0,Math.min(1,ratio)));
    });
    var libBtn=document.getElementById('music-refresh-lib'); if(libBtn) libBtn.onclick=function(){ musicLog('Library: refresh','step'); refreshLibrary(); };
    // playlists bar
    bindPlaylistEvents();
    refreshPlaylists();
    musicLog('Music page ready — providers: '+(window.MusicHost? window.MusicHost.list().map(function(p){return p.id;}).join(', '):'?')+' — Jamendo '+(musicUseProxy()?'via proxy':'direct')+', Bilibili via /api/music','warn');
  }

  function doSearch(){
    var inp=document.getElementById('music-search');
    var kw=(inp&&inp.value||'').trim();
    if(!kw){ musicLog('Search: empty keyword — nothing to do','warn'); return; }
    var host = window.MusicHost;
    if(!host){ musicLog('Search: MusicHost not loaded (host.js missing?)','error'); renderResults([], 'MusicHost not loaded'); return; }
    var btn=document.getElementById('music-search-btn');
    if(btn) { btn.disabled=true; btn.textContent='…'; musicLog('Search: "'+kw+'" — providers ['+selectedProviders.join(', ')+']','step'); }
    var provs = selectedProviders.length? selectedProviders : null;
    var t0=Date.now();
    musicLog('Request: MusicHost.search("'+kw+'", ['+(provs?provs.join(', '):'all')+'], 24)','req');
    // Also surface what each fetch will hit so CSP/network blocks are obvious
    if(selectedProviders.indexOf('jamendo')>=0) musicLog('Request: Jamendo → '+(musicUseProxy()?'via /api/music/proxy':'https://api.jamendo.com/v3.0/tracks/?client_id=836523a7&search='+encodeURIComponent(kw))+' (proxy '+(musicUseProxy()?'ON':'OFF')+')','req');
    if(selectedProviders.indexOf('bilibili')>=0) musicLog('Request: Bilibili → GET /api/music/bilibili/search?keyword='+encodeURIComponent(kw)+' (proxied via backend)','req');
    host.search(kw, provs, 24).then(function(list){
      var dt=Date.now()-t0;
      searchResults = list||[];
      if(!searchResults.length) musicLog('Response: no results for "'+kw+'" ('+dt+'ms) — try another keyword or check Activity above for per-provider errors','warn');
      else musicLog('Response: '+(list.length)+' result(s) ('+dt+'ms) — providers: '+(function(){var m={}; list.forEach(function(s){m[s.source||'?']=1;}); return Object.keys(m).join(', ');})(),'ok');
      renderResults(searchResults);
    }).catch(function(e){
      musicLog('Search failed: '+String(e&&e.message||e)+' — open DevTools Console/Network for stack & HTTP status','error');
      searchResults=[];
      renderResults([], String(e&&e.message||e));
    }).finally(function(){ if(btn){ btn.disabled=false; btn.textContent='Search'; } });
  }

  function renderResults(list, err){
    var el=document.getElementById('music-results');
    if(!el) return;
    if(err){
      el.innerHTML='<div style="color:var(--danger);font-size:13px">Search failed: '+escapeHtml(err)+'<br><span style="color:var(--text-tertiary)">Check the Activity panel below and DevTools Console/Network for details.</span></div>';
      return;
    }
    if(!list || !list.length){
      el.innerHTML='<div style="color:var(--text-tertiary);font-size:13px;line-height:1.6">No results yet. Click Search or try a keyword like <code>lofi</code>, <code>piano</code>, <code>jazz</code>. If only Bilibili returns, try Proxy ON for Jamendo.<br><span style="font-size:11px">If search always returns empty, check Activity panel for request errors.</span></div>';
      return;
    }
    el.innerHTML = list.map(function(s,idx){
      return ''+
        '<div class="music-result" data-idx="'+idx+'" style="display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--glass-border);border-radius:10px;margin-bottom:8px;background:var(--glass-bg)">'+
          '<div style="width:44px;height:44px;border-radius:6px;background:var(--glass-hover);background-size:cover;background-position:center;flex-shrink:0;'+(s.cover?('background-image:url('+JSON.stringify(s.cover).slice(1,-1)+')'):'')+'"></div>'+
          '<div style="flex:1;min-width:0">'+
            '<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px">'+escapeHtml(s.title||'Untitled')+'</div>'+
            '<div style="font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+escapeHtml((s.artist||'')+(s.album?(' — '+s.album):''))+' · '+escapeHtml(s.source||'')+'</div>'+
          '</div>'+
          '<div style="display:flex;gap:6px;flex-shrink:0">'+
            '<button class="btn btn-primary" data-act="play" data-idx="'+idx+'" style="padding:6px 10px">Play</button>'+
            '<button class="btn btn-ghost" data-act="queue" data-idx="'+idx+'">+Queue</button>'+
            '<button class="btn btn-ghost" data-act="dl" data-idx="'+idx+'" title="Download to Musics">↓</button>'+
          '</div>'+
        '</div>';
    }).join('');
    el.querySelectorAll('button[data-act]').forEach(function(b){
      b.addEventListener('click', function(e){
        e.stopPropagation();
        var act=b.getAttribute('data-act'), i=parseInt(b.getAttribute('data-idx'),10);
        var song=list[i]; if(!song) return;
        if(act==='play'){ playSong(song, true); }
        else if(act==='queue'){ addToQueue(song,true); }
        else if(act==='dl'){ downloadSong(song,b); }
      });
    });
  }

  function addToQueue(song, toast){
    queue.push(song);
    ensurePlayer().setQueue(queue, Math.max(0, ensurePlayer().index));
    renderQueue();
    musicLog('Queue: + "'+(song.title||song.id)+'" ('+queue.length+' total)','ok');
    if(toast && typeof window.toast==='function') window.toast('Added to queue: '+(song.title||''),'success');
  }
  function playSong(song, addFirst){
    ensurePlayer();
    var idx = queue.findIndex(function(q){ return String(q.id)===String(song.id); });
    if(idx===-1){ queue.push(song); idx=queue.length-1; }
    player.setQueue(queue, idx);
    // Issue 7: Bilibili 的 song 只有 bvid/cid，无直链；需先 resolve 再播放。
    // 若 song 已有 _objectUrl / url（Jamendo/Local/已 resolve），直接播；否则显式 resolve。
    var needResolve = song && song.source==='bilibili' && !song.url && !song._objectUrl;
    musicLog('Play: "'+(song.title||song.id)+'" via '+ (song.source||'?')+' — '+(needResolve?'resolving Bilibili…':'resolving media source…'),'step');
    musicLog('Play: request MusicHost.getMediaSource for id='+song.id+(song.cid?(' cid='+song.cid):''),'req');
    var p = needResolve
      ? window.MusicHost.getMediaSource(song).then(function(m){
          if(!m || !m.url) throw new Error('resolve returned empty url (bvid may need login)');
          // 回填 url 以便下载复用
          song.url = m.url;
          song._resolvedUrl = m.url;
          if(m.cid) song.cid = m.cid;
          musicLog('Resolve: '+song.id+' → '+m.url.slice(0,80)+' ('+m.quality+')','ok');
          // 更新队列中的引用
          var qref = queue[idx];
          if(qref) { qref.url = m.url; qref._resolvedUrl = m.url; }
          return player.playAt(idx);
        })
      : player.playAt(idx);
    p.then(function(){ musicLog('Play: started "'+(song.title||song.id)+'"','ok'); }).catch(function(e){ musicLog('Play failed: '+(e&&e.message||e),'error'); if(typeof toast==='function') toast(String(e.message||e),'error'); });
    renderQueue();
  }
  function renderQueue(){
    var el=document.getElementById('music-queue'); var cnt=document.getElementById('music-queue-count');
    if(cnt) cnt.textContent = String(queue.length);
    if(!el) return;
    if(!queue.length){ el.innerHTML='<div style="color:var(--text-tertiary);font-size:12px;padding:8px">Queue empty — Play a result or add Local files.</div>'; return; }
    el.innerHTML = queue.map(function(s, i){
      return '<div class="music-queue-item" data-id="'+escapeHtml(String(s.id))+'" data-idx="'+i+'" style="display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent">'+
        '<span style="font-size:11px;color:var(--text-tertiary);width:18px;text-align:right">'+(i+1)+'</span>'+
        '<span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px">'+escapeHtml(s.title||'Untitled')+'<span style="color:var(--text-tertiary);font-weight:400"> — '+escapeHtml(s.artist||'')+'</span></span>'+
        '<button class="btn btn-ghost" data-rm="'+i+'" style="padding:4px 6px;font-size:11px">✕</button>'+
      '</div>';
    }).join('');
    el.querySelectorAll('.music-queue-item').forEach(function(row){
      row.addEventListener('click', function(e){
        if(e.target && e.target.getAttribute('data-rm')!=null) return;
        var idx=parseInt(row.getAttribute('data-idx'),10);
        ensurePlayer().setQueue(queue, idx);
        ensurePlayer().playAt(idx);
      });
    });
    el.querySelectorAll('button[data-rm]').forEach(function(b){
      b.addEventListener('click', function(e){
        e.stopPropagation();
        var idx=parseInt(b.getAttribute('data-rm'),10);
        var wasCur = player && player.index===idx;
        queue.splice(idx,1);
        if(wasCur){ try{ player.pause(); }catch(_e){} }
        if(player) player.setQueue(queue, Math.min(idx, queue.length-1));
        renderQueue(); syncQueueHighlight();
      });
    });
    syncQueueHighlight();
  }

  function downloadSong(song, btn){
    var doDownload = function(url){
      if(!url){ musicLog('Download: no url for "'+(song.title||song.id)+'"','error'); if(typeof toast==='function') toast('No download url','error'); return; }
      var orig = btn?btn.textContent:'';
      if(btn){ btn.disabled=true; btn.textContent='…'; }
      var filename = (song.artist? (song.artist+' - '):'') + (song.title||'track') + '.mp3';
      filename = filename.replace(/[\\/:*?"<>|]/g,'_');
      musicLog('Download: POST /api/music/download → '+filename+' from '+url.slice(0,80),'req');
      apiFetch('/api/music/download', {method:'POST', body:{url:url, filename: filename}}).then(function(j){
        musicLog('Download: saved '+ (j.filename||filename)+' — refresh library','ok');
        if(typeof toast==='function') toast('Saved: '+(j.filename||filename),'success');
        refreshLibrary();
      }).catch(function(e){ musicLog('Download failed: '+(e.message||e),'error'); if(typeof toast==='function') toast('Download failed: '+(e.message||e),'error'); })
      .finally(function(){ if(btn){ btn.disabled=false; btn.textContent=orig||'↓'; } });
    };
    var direct = song.downloadUrl || song._resolvedUrl || song.url || '';
    if(direct){ doDownload(direct); return; }
    // Bilibili 无直链：先 resolve 再下载
    if(song.source==='bilibili'){
      if(btn){ btn.disabled=true; btn.textContent='…'; }
      musicLog('Download: resolving Bilibili '+song.id+' before download','step');
      window.MusicHost.getMediaSource(song).then(function(m){
        if(!m || !m.url) throw new Error('no url after resolve');
        song.url = m.url; song._resolvedUrl = m.url;
        if(m.cid) song.cid = m.cid;
        musicLog('Resolve: '+song.id+' → '+m.url.slice(0,80),'ok');
        doDownload(m.url);
      }).catch(function(e){
        musicLog('Resolve failed: '+(e&&e.message||e),'error');
        if(typeof toast==='function') toast('Resolve failed: '+(e.message||e),'error');
        if(btn){ btn.disabled=false; btn.textContent='↓'; }
      });
      return;
    }
    doDownload(direct);
  }

  function refreshLibrary(){
    var box=document.getElementById('music-library'); var dirEl=document.getElementById('music-lib-dir');
    if(box) box.textContent='Loading…';
    musicLog('Library: GET /api/music/library','req');
    apiFetch('/api/music/library').then(function(j){
      musicLog('Library: '+(j.files||[]).length+' file(s) in '+(j.dir||''),'ok');
      if(dirEl) dirEl.textContent = j.dir||'';
      if(!box) return;
      var files=j.files||[];
      if(!files.length){ box.innerHTML='<span style="color:var(--text-tertiary)">Empty — downloads go to Musics; Local files play via queue. Library files support Play & Transcode.</span>'; return; }
      box.innerHTML = files.map(function(f){
        var isAudio = !f.isDir && /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|wma|ape)$/i.test(f.name);
        return '<div style="display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--glass-border)">'+
          '<span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+escapeHtml(f.name)+'</span>'+
          '<span style="font-size:11px;color:var(--text-tertiary)">'+(f.isDir? 'dir' : (Math.round(f.size/1024)+' KB'))+'</span>'+
          (isAudio? '<button class="btn btn-ghost" data-play-file="'+escapeHtml(f.name)+'" style="padding:4px 8px">Play</button><button class="btn btn-ghost" data-transcode-file="'+escapeHtml(f.name)+'" title="Transcode via ffmpeg to mp3" style="padding:4px 8px">→mp3</button>' : (f.isDir? '' : '<button class="btn btn-ghost" data-play-file="'+escapeHtml(f.name)+'" style="padding:4px 8px">Play</button>'))+
        '</div>';
      }).join('');
      box.querySelectorAll('button[data-play-file]').forEach(function(b){
        b.addEventListener('click', function(){
          var name=b.getAttribute('data-play-file');
          var url='/api/music/file?name='+encodeURIComponent(name);
          var song={id:'lib:'+name, title:name, artist:'Library', url:url, cover:'', source:'library'};
          musicLog('Library: Play '+name,'step');
          playSong(song, true);
        });
      });
      box.querySelectorAll('button[data-transcode-file]').forEach(function(b){
        b.addEventListener('click', function(){
          var name=b.getAttribute('data-transcode-file');
          var orig=b.textContent; b.disabled=true; b.textContent='…';
          musicLog('Transcode: '+name+' — fetch bytes then POST /api/music/transcode?format=mp3','step');
          // Fetch file bytes then POST to transcode
          fetch('/api/music/file?name='+encodeURIComponent(name)).then(function(r){
            if(!r.ok) throw new Error('fetch '+r.status);
            return r.arrayBuffer();
          }).then(function(buf){
            musicLog('Transcode: POST /api/music/transcode?format=mp3 ('+buf.byteLength+' bytes)','req');
            return fetch('/api/music/transcode?format=mp3', {method:'POST', body: buf});
          }).then(function(r){
            if(!r.ok) return r.text().then(function(t){ throw new Error(t); });
            return r.blob();
          }).then(function(blob){
            var url=URL.createObjectURL(blob);
            var song={id:'transcoded:'+name+':'+Date.now(), title:name+' (mp3)', artist:'Transcoded', url:url, _objectUrl:url, source:'local'};
            addToQueue(song, false);
            playSong(song, false);
            musicLog('Transcode: '+name+' → mp3 ok ('+blob.size+' bytes)','ok');
            if(typeof toast==='function') toast('Transcoded '+name+' → mp3','success');
          }).catch(function(e){ musicLog('Transcode failed: '+(e.message||e),'error'); if(typeof toast==='function') toast('Transcode failed: '+(e.message||e),'error'); })
          .finally(function(){ b.disabled=false; b.textContent=orig; });
        });
      });
    }).catch(function(e){ musicLog('Library error: '+(e.message||e),'error'); if(box) box.textContent='Library error: '+(e.message||e); });
  }

  // Playlists: Musics/playlists.json via /api/music/playlists + m3u
  var playlistsCache = [];
  function refreshPlaylists(){
    var sel=document.getElementById('music-playlist-select'); if(!sel) return;
    musicLog('Playlists: GET /api/music/playlists','req');
    apiFetch('/api/music/playlists').then(function(data){
      var pls=(data&&data.playlists)||[];
      playlistsCache=pls;
      var cur=sel.value;
      sel.innerHTML='<option value="">Playlists — Musics/playlists.json</option>' + pls.map(function(p){
        return '<option value="'+escapeHtml(String(p.id||p.name))+'">'+escapeHtml(String(p.name||p.id))+' ('+((p.tracks||[]).length)+')</option>';
      }).join('');
      if(cur) sel.value=cur;
      musicLog('Playlists: loaded '+pls.length+' playlist(s)','ok');
    }).catch(function(e){ musicLog('Playlists error: '+String(e&&e.message||e),'error'); });
  }
  function savePlaylists(pls){
    musicLog('Playlists: PUT /api/music/playlists ('+pls.length+' playlist(s))','req');
    return apiFetch('/api/music/playlists', {method:'PUT', body:{playlists: pls}});
  }
  function bindPlaylistEvents(){
    var sel=document.getElementById('music-playlist-select');
    var nameIn=document.getElementById('music-playlist-name');
    var btnCreate=document.getElementById('music-pl-create');
    var btnSaveQueue=document.getElementById('music-pl-savequeue');
    var btnLoad=document.getElementById('music-pl-load');
    var btnExport=document.getElementById('music-pl-export');
    var m3uFile=document.getElementById('music-m3u-file');
    var urlIn=document.getElementById('music-pl-url');
    var btnFetch=document.getElementById('music-pl-import-url');
    if(btnCreate) btnCreate.addEventListener('click', function(){
      var name=(nameIn&&nameIn.value||'').trim() || ('Playlist '+(playlistsCache.length+1));
      var id='pl-'+Date.now();
      playlistsCache.push({id:id, name:name, tracks:[]});
      musicLog('Playlist: create "'+name+'"','step');
      savePlaylists(playlistsCache).then(function(){ musicLog('Playlist: created "'+name+'"','ok'); if(typeof toast==='function') toast('Created '+name,'success'); refreshPlaylists(); sel.value=id; }).catch(function(e){ musicLog('Create failed: '+(e.message||e),'error'); if(typeof toast==='function') toast(String(e.message||e),'error'); });
    });
    if(btnSaveQueue) btnSaveQueue.addEventListener('click', function(){
      var id=sel&&sel.value||''; if(!id){ if(typeof toast==='function') toast('Select a playlist first','error'); return; }
      var pl=playlistsCache.find(function(p){ return String(p.id)===String(id) || String(p.name)===String(id); });
      if(!pl){ if(typeof toast==='function') toast('Playlist not found','error'); return; }
      pl.tracks = queue.map(function(s){ return {id:s.id, title:s.title, artist:s.artist, url:s.url||s.downloadUrl||s._objectUrl||'', cover:s.cover||'', source:s.source||''}; });
      musicLog('Playlist: save queue → "'+pl.name+'" ('+pl.tracks.length+' tracks)','step');
      savePlaylists(playlistsCache).then(function(){ musicLog('Playlist: saved','ok'); if(typeof toast==='function') toast('Saved queue → '+pl.name+' ('+pl.tracks.length+')','success'); refreshPlaylists(); }).catch(function(e){ musicLog('Save failed: '+(e.message||e),'error'); if(typeof toast==='function') toast(String(e.message||e),'error'); });
    });
    if(btnLoad) btnLoad.addEventListener('click', function(){
      var id=sel&&sel.value||''; if(!id){ if(typeof toast==='function') toast('Select a playlist first','error'); return; }
      var pl=playlistsCache.find(function(p){ return String(p.id)===String(id) || String(p.name)===String(id); });
      if(!pl || !(pl.tracks||[]).length){ if(typeof toast==='function') toast('Playlist empty','error'); return; }
      var songs=(pl.tracks||[]).map(function(t){ return {id:t.id||t.url||('pl:'+t.title), title:t.title||t.url||'Untitled', artist:t.artist||'', url:t.url||'', cover:t.cover||'', source:t.source||'library'}; });
      queue = songs.slice();
      ensurePlayer().setQueue(queue, 0);
      renderQueue();
      if(queue.length) ensurePlayer().playAt(0);
      musicLog('Playlist: loaded "'+pl.name+'" → queue ('+songs.length+')','ok');
      if(typeof toast==='function') toast('Loaded '+pl.name+' → queue ('+songs.length+')','success');
    });
    if(btnExport) btnExport.addEventListener('click', function(){
      var id=sel&&sel.value||''; if(!id){ if(typeof toast==='function') toast('Select a playlist first','error'); return; }
      var pl=playlistsCache.find(function(p){ return String(p.id)===String(id) || String(p.name)===String(id); });
      if(!pl){ if(typeof toast==='function') toast('Playlist not found','error'); return; }
      musicLog('Playlist: export "'+pl.name+'" as m3u','step');
      window.open('/api/music/m3u?name='+encodeURIComponent(pl.name||pl.id), '_blank');
    });
    if(m3uFile) m3uFile.addEventListener('change', function(e){
      var f=(e.target.files||[])[0]; if(!f) return;
      var rd=new FileReader();
      musicLog('m3u import: reading '+f.name,'step');
      rd.onload=function(ev){
        var text=String(ev.target.result||'');
        var name=f.name.replace(/\.[^.]+$/,'') || 'import';
        musicLog('m3u import: POST /api/music/m3u name="'+name+'" ('+text.length+' chars)','req');
        apiFetch('/api/music/m3u', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:name, m3u:text})})
          .then(function(){ musicLog('m3u import: imported "'+name+'"','ok'); if(typeof toast==='function') toast('Imported '+name,'success'); refreshPlaylists(); })
          .catch(function(err){ musicLog('m3u import failed: '+(err.message||err),'error'); if(typeof toast==='function') toast(String(err.message||err),'error'); });
      };
      rd.readAsText(f); e.target.value='';
    });
    if(btnFetch) btnFetch.addEventListener('click', function(){
      var url=(urlIn&&urlIn.value||'').trim(); if(!url){ if(typeof toast==='function') toast('Enter a playlist URL','error'); return; }
      btnFetch.disabled=true; var old=btnFetch.textContent; btnFetch.textContent='…';
      musicLog('Remote import: POST /api/music/playlists/import url='+url,'req');
      apiFetch('/api/music/playlists/import', {method:'POST', body:{url:url}}).then(function(data){
        var name=(data&&data.name)||('import-'+Date.now());
        var tracks=(data&&data.tracks)||[];
        if(!tracks.length){ musicLog('Remote import: no tracks at URL','warn'); if(typeof toast==='function') toast('No tracks found at URL','error'); return; }
        // append as new playlist
        var id='pl-'+Date.now();
        playlistsCache.push({id:id, name:name, tracks: tracks.map(function(t){ return {id:t.url||t.title, title:t.title||t.url, url:t.url||'', source:'import'}; })});
        musicLog('Remote import: "'+name+'" ('+tracks.length+' tracks) — saving','step');
        return savePlaylists(playlistsCache).then(function(){ musicLog('Remote import: imported "'+name+'"','ok'); if(typeof toast==='function') toast('Imported '+name+' ('+tracks.length+')','success'); refreshPlaylists(); sel.value=id; });
      }).catch(function(e){ musicLog('Remote import failed: '+(e.message||e),'error'); if(typeof toast==='function') toast(String(e.message||e),'error'); })
      .finally(function(){ btnFetch.disabled=false; btnFetch.textContent=old; });
    });
  }

  function cleanupMusic(){
    if(player){ try{ player.pause(); }catch(e){} }
  }
  function suspendMusic(){ if(player) try{ player.pause(); }catch(e){} }
  function resumeMusic(){}

  window.renderMusic = renderMusic;
  window.cleanupMusic = cleanupMusic;
  window.suspendMusic = suspendMusic;
  window.resumeMusic = resumeMusic;
})();
