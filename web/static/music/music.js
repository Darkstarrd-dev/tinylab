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

  function ensurePlayer(){
    if(player) return player;
    player = new MusicPlayer();
    player.on('track', function(song){ syncNowPlaying(song); });
    player.on('timeupdate', syncProgress);
    player.on('play', syncPlayBtn);
    player.on('pause', syncPlayBtn);
    player.on('error', function(e){ console.warn('[Music] play error', e); });
    player.audio.addEventListener('loadedmetadata', syncProgress);
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

  function renderMusic(container){
    container.innerHTML = ''+
      '<div class="music-page" style="display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden">'+
        '<div style="display:flex;gap:8px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--glass-border);flex-wrap:wrap">'+
          '<div style="display:flex;gap:8px;align-items:center;flex:1;min-width:220px">'+
            '<input id="music-search" placeholder="Search — e.g. lofi, piano, jazz (Jamendo+Bilibili)" style="flex:1;min-width:160px;padding:8px 10px;border-radius:8px;border:1px solid var(--glass-border);background:var(--input-bg);color:var(--text)">'+
            '<button id="music-search-btn" class="btn btn-primary">Search</button>'+
          '</div>'+
          '<div id="music-provider-chips" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"></div>'+
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
    refreshLibrary();
    // initial demo search
    setTimeout(function(){
      var inp=document.getElementById('music-search');
      if(inp && !inp.value) { inp.value='lofi'; doSearch(); }
    }, 120);
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
    if(fileInp) fileInp.addEventListener('change', function(e){
      var files = Array.from(e.target.files||[]);
      if(!files.length) return;
      files.forEach(function(f){
        var url = URL.createObjectURL(f);
        var song = { id:'local:'+Date.now()+':'+f.name, title: f.name.replace(/\.[^.]+$/,''), artist:'Local', album:'', duration:0, url:url, _objectUrl:url, cover:'', source:'local', _file:f };
        addToQueue(song, false);
      });
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
    var libBtn=document.getElementById('music-refresh-lib'); if(libBtn) libBtn.onclick=refreshLibrary;
    // playlists bar
    bindPlaylistEvents();
    refreshPlaylists();
  }

  function doSearch(){
    var inp=document.getElementById('music-search');
    var kw=(inp&&inp.value||'').trim();
    if(!kw) return;
    var btn=document.getElementById('music-search-btn');
    if(btn) { btn.disabled=true; btn.textContent='…'; }
    var host = window.MusicHost;
    var provs = selectedProviders.length? selectedProviders : null;
    host.search(kw, provs, 24).then(function(list){
      searchResults = list||[];
      renderResults(searchResults);
    }).catch(function(e){
      console.warn(e);
      searchResults=[];
      renderResults([], String(e&&e.message||e));
    }).finally(function(){ if(btn){ btn.disabled=false; btn.textContent='Search'; } });
  }

  function renderResults(list, err){
    var el=document.getElementById('music-results');
    if(!el) return;
    if(err){
      el.innerHTML='<div style="color:var(--danger);font-size:13px">Search failed: '+escapeHtml(err)+'</div>';
      return;
    }
    if(!list || !list.length){
      el.innerHTML='<div style="color:var(--text-tertiary);font-size:13px;line-height:1.6">No results yet. Try a keyword like <code>lofi</code>, <code>piano</code>, <code>jazz</code>. Jamendo is CC-licensed and fully free.</div>';
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
    if(toast && typeof window.toast==='function') window.toast('Added to queue: '+(song.title||''),'success');
  }
  function playSong(song, addFirst){
    ensurePlayer();
    var idx = queue.findIndex(function(q){ return String(q.id)===String(song.id); });
    if(idx===-1){ queue.push(song); idx=queue.length-1; }
    player.setQueue(queue, idx);
    player.playAt(idx).catch(function(e){ if(typeof toast==='function') toast(String(e.message||e),'error'); });
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
    var url = song.downloadUrl || song.url || '';
    if(!url){ if(typeof toast==='function') toast('No download url','error'); return; }
    var orig = btn?btn.textContent:'';
    if(btn){ btn.disabled=true; btn.textContent='…'; }
    var filename = (song.artist? (song.artist+' - '):'') + (song.title||'track') + '.mp3';
    filename = filename.replace(/[\\/:*?"<>|]/g,'_');
    apiFetch('/api/music/download', {method:'POST', body:{url:url, filename: filename}}).then(function(j){
      if(typeof toast==='function') toast('Saved: '+(j.filename||filename),'success');
      refreshLibrary();
    }).catch(function(e){ if(typeof toast==='function') toast('Download failed: '+(e.message||e),'error'); })
    .finally(function(){ if(btn){ btn.disabled=false; btn.textContent=orig||'↓'; } });
  }

  function refreshLibrary(){
    var box=document.getElementById('music-library'); var dirEl=document.getElementById('music-lib-dir');
    if(box) box.textContent='Loading…';
    apiFetch('/api/music/library').then(function(j){
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
          playSong(song, true);
        });
      });
      box.querySelectorAll('button[data-transcode-file]').forEach(function(b){
        b.addEventListener('click', function(){
          var name=b.getAttribute('data-transcode-file');
          var orig=b.textContent; b.disabled=true; b.textContent='…';
          // Fetch file bytes then POST to transcode
          fetch('/api/music/file?name='+encodeURIComponent(name)).then(function(r){
            if(!r.ok) throw new Error('fetch '+r.status);
            return r.arrayBuffer();
          }).then(function(buf){
            return fetch('/api/music/transcode?format=mp3', {method:'POST', body: buf});
          }).then(function(r){
            if(!r.ok) return r.text().then(function(t){ throw new Error(t); });
            return r.blob();
          }).then(function(blob){
            var url=URL.createObjectURL(blob);
            var song={id:'transcoded:'+name+':'+Date.now(), title:name+' (mp3)', artist:'Transcoded', url:url, _objectUrl:url, source:'local'};
            addToQueue(song, false);
            playSong(song, false);
            if(typeof toast==='function') toast('Transcoded '+name+' → mp3','success');
          }).catch(function(e){ if(typeof toast==='function') toast('Transcode failed: '+(e.message||e),'error'); })
          .finally(function(){ b.disabled=false; b.textContent=orig; });
        });
      });
    }).catch(function(e){ if(box) box.textContent='Library error: '+(e.message||e); });
  }

  // Playlists: Musics/playlists.json via /api/music/playlists + m3u
  var playlistsCache = [];
  function refreshPlaylists(){
    var sel=document.getElementById('music-playlist-select'); if(!sel) return;
    apiFetch('/api/music/playlists').then(function(data){
      var pls=(data&&data.playlists)||[];
      playlistsCache=pls;
      var cur=sel.value;
      sel.innerHTML='<option value="">Playlists — Musics/playlists.json</option>' + pls.map(function(p){
        return '<option value="'+escapeHtml(String(p.id||p.name))+'">'+escapeHtml(String(p.name||p.id))+' ('+((p.tracks||[]).length)+')</option>';
      }).join('');
      if(cur) sel.value=cur;
    }).catch(function(){});
  }
  function savePlaylists(pls){
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
      savePlaylists(playlistsCache).then(function(){ if(typeof toast==='function') toast('Created '+name,'success'); refreshPlaylists(); sel.value=id; }).catch(function(e){ if(typeof toast==='function') toast(String(e.message||e),'error'); });
    });
    if(btnSaveQueue) btnSaveQueue.addEventListener('click', function(){
      var id=sel&&sel.value||''; if(!id){ if(typeof toast==='function') toast('Select a playlist first','error'); return; }
      var pl=playlistsCache.find(function(p){ return String(p.id)===String(id) || String(p.name)===String(id); });
      if(!pl){ if(typeof toast==='function') toast('Playlist not found','error'); return; }
      pl.tracks = queue.map(function(s){ return {id:s.id, title:s.title, artist:s.artist, url:s.url||s.downloadUrl||s._objectUrl||'', cover:s.cover||'', source:s.source||''}; });
      savePlaylists(playlistsCache).then(function(){ if(typeof toast==='function') toast('Saved queue → '+pl.name+' ('+pl.tracks.length+')','success'); refreshPlaylists(); }).catch(function(e){ if(typeof toast==='function') toast(String(e.message||e),'error'); });
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
      if(typeof toast==='function') toast('Loaded '+pl.name+' → queue ('+songs.length+')','success');
    });
    if(btnExport) btnExport.addEventListener('click', function(){
      var id=sel&&sel.value||''; if(!id){ if(typeof toast==='function') toast('Select a playlist first','error'); return; }
      var pl=playlistsCache.find(function(p){ return String(p.id)===String(id) || String(p.name)===String(id); });
      if(!pl){ if(typeof toast==='function') toast('Playlist not found','error'); return; }
      window.open('/api/music/m3u?name='+encodeURIComponent(pl.name||pl.id), '_blank');
    });
    if(m3uFile) m3uFile.addEventListener('change', function(e){
      var f=(e.target.files||[])[0]; if(!f) return;
      var rd=new FileReader();
      rd.onload=function(ev){
        var text=String(ev.target.result||'');
        var name=f.name.replace(/\.[^.]+$/,'') || 'import';
        apiFetch('/api/music/m3u', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:name, m3u:text})})
          .then(function(){ if(typeof toast==='function') toast('Imported '+name,'success'); refreshPlaylists(); })
          .catch(function(err){ if(typeof toast==='function') toast(String(err.message||err),'error'); });
      };
      rd.readAsText(f); e.target.value='';
    });
    if(btnFetch) btnFetch.addEventListener('click', function(){
      var url=(urlIn&&urlIn.value||'').trim(); if(!url){ if(typeof toast==='function') toast('Enter a playlist URL','error'); return; }
      btnFetch.disabled=true; var old=btnFetch.textContent; btnFetch.textContent='…';
      apiFetch('/api/music/playlists/import', {method:'POST', body:{url:url}}).then(function(data){
        var name=(data&&data.name)||('import-'+Date.now());
        var tracks=(data&&data.tracks)||[];
        if(!tracks.length){ if(typeof toast==='function') toast('No tracks found at URL','error'); return; }
        // append as new playlist
        var id='pl-'+Date.now();
        playlistsCache.push({id:id, name:name, tracks: tracks.map(function(t){ return {id:t.url||t.title, title:t.title||t.url, url:t.url||'', source:'import'}; })});
        return savePlaylists(playlistsCache).then(function(){ if(typeof toast==='function') toast('Imported '+name+' ('+tracks.length+')','success'); refreshPlaylists(); sel.value=id; });
      }).catch(function(e){ if(typeof toast==='function') toast(String(e.message||e),'error'); })
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
