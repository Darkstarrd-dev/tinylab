// tilemap_editor.js — TileMap Editor for the Editor page category.
// Pure frontend canvas 2D editor. Data model is Tiled JSON compatible
// (orthogonal, single tileset v1). Exports directly to Phaser:
//   this.load.tilemapTiledJSON(key, url)
//   const map = this.make.tilemap({key})
//   const ts = map.addTilesetImage('tileset','tilesImg')
//   map.createLayer('Ground', ts) etc.
// Reference inspirations: Godot TileSet/TileMapLayer & Tiled TMJ.
// No backend dependency beyond optional file pickers.
(function(global){
  'use strict';
  var STORAGE_KEY = 'trTilemapEditor';
  var LS_CAT = 'trEditorCategory';
  var CAT_TEXT = 'text';
  var CAT_TILEMAP = 'tilemap';

  // ---- category persistence ----
  function getCategory(){
    try{ var v=localStorage.getItem(LS_CAT); return v===CAT_TILEMAP?CAT_TILEMAP:CAT_TEXT; }catch(e){ return CAT_TEXT; }
  }
  function setCategory(cat){
    try{ localStorage.setItem(LS_CAT, cat); }catch(e){}
  }

  // ---- tilemap model ----
  function makeEmptyMap(w,h,tw,th){
    return {
      width: w||16, height: h||12, tileWidth: tw||32, tileHeight: th||32,
      tileset: { name:'tileset', image:'', imagewidth:0, imageheight:0, tilewidth: tw||32, tileheight: th||32, columns:0, tilecount:0, spacing:0, margin:0 },
      layers: [{ id:1, name:'Ground', type:'tilelayer', visible:true, opacity:1, data: makeEmptyData(w||16,h||12) }],
      _nextLayerId: 2
    };
  }
  function makeEmptyData(w,h){ var a=new Array(w*h); for(var i=0;i<a.length;i++) a[i]=0; return a; }
  function clone(o){ return JSON.parse(JSON.stringify(o)); }

  var state = {
    map: loadStored() || makeEmptyMap(16,12,32,32),
    selectedGid: 1,
    selectedLayer: 0,
    tool: 'brush', // brush|eraser|fill|picker
    zoom: 1,
    showGrid: true,
    showIds: false,
    history: [], future: [],
    tilesetImg: null, tilesetUrl: ''
  };

  function loadStored(){
    try{
      var raw=localStorage.getItem(STORAGE_KEY);
      if(!raw) return null;
      var o=JSON.parse(raw);
      if(!o || !o.width || !o.layers) return null;
      return o;
    }catch(e){ return null; }
  }
  function persist(){
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state.map)); }catch(e){}
  }
  function pushHistory(){
    state.history.push(JSON.stringify(state.map));
    if(state.history.length>60) state.history.shift();
    state.future.length=0;
  }
  function undo(){ if(!state.history.length) return; state.future.push(JSON.stringify(state.map)); state.map=JSON.parse(state.history.pop()); persist(); renderAll(); }
  function redo(){ if(!state.future.length) return; state.history.push(JSON.stringify(state.map)); state.map=JSON.parse(state.future.pop()); persist(); renderAll(); }

  // ---- DOM refs ----
  var root=null, canvas=null, ctx=null, palCanvas=null, palCtx=null;
  var hoverCell=null, dragging=false, dragButton=0;

  function t(key, fallback){
    try{ if(typeof global.t==='function') return global.t(key)||fallback; }catch(e){}
    return fallback||key;
  }

  function gidToRC(gid, columns){ if(!columns) return null; var idx=gid-1; return { c: idx%columns, r: Math.floor(idx/columns) }; }

  function buildTilesetMeta(){
    var ts=state.map.tileset;
    if(!ts.imagewidth || !ts.imageheight || !ts.tilewidth || !ts.tileheight) return;
    var usableW = ts.imagewidth - ts.margin*2 + ts.spacing;
    var usableH = ts.imageheight - ts.margin*2 + ts.spacing;
    var cols = Math.floor(usableW / (ts.tilewidth + ts.spacing));
    var rows = Math.floor(usableH / (ts.tileheight + ts.spacing));
    ts.columns = Math.max(0, cols);
    ts.tilecount = Math.max(0, cols*rows);
  }

  function loadTilesetFromFile(file){
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function(){
      state.tilesetImg = img;
      state.tilesetUrl = url;
      var ts=state.map.tileset;
      ts.imagewidth = img.naturalWidth; ts.imageheight = img.naturalHeight;
      buildTilesetMeta();
      if(ts.columns && ts.tilecount) state.selectedGid = 1;
      persist();
      renderAll();
    };
    img.onerror = function(){ if(typeof global.toast==='function') global.toast('Tileset load failed','error'); };
    img.src = url;
    // store name for export
    state.map.tileset.image = file.name || 'tileset.png';
  }

  function exportTiledJSON(){
    var m=state.map;
    var ts=m.tileset;
    var tilesetJson = {
      columns: ts.columns||0,
      firstgid: 1,
      image: ts.image||'tileset.png',
      imagewidth: ts.imagewidth||0,
      imageheight: ts.imageheight||0,
      margin: ts.margin||0,
      name: ts.name||'tileset',
      spacing: ts.spacing||0,
      tilecount: ts.tilecount||0,
      tileheight: ts.tileheight||m.tileHeight,
      tilewidth: ts.tilewidth||m.tileWidth
    };
    var layers = m.layers.map(function(ly){
      return { data: ly.data.slice(), height: m.height, id: ly.id, name: ly.name, opacity: ly.opacity==null?1:ly.opacity, type:'tilelayer', visible: ly.visible!==false, width: m.width, x:0, y:0 };
    });
    var out = {
      compressionlevel:-1, height: m.height, infinite:false, layers: layers, nextlayerid: m._nextLayerId|| (layers.length+1), nextobjectid:1,
      orientation:'orthogonal', renderorder:'right-down', tiledversion:'1.10.2', tileheight: m.tileHeight, tilesets:[tilesetJson], tilewidth: m.tileWidth, type:'map', version:'1.10', width: m.width
    };
    return JSON.stringify(out, null, 2);
  }

  function downloadText(filename, text, mime){
    var blob=new Blob([text],{type:mime||'application/json'});
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function importJson(text){
    try{
      var o=JSON.parse(text);
      if(!o.layers || !o.width || !o.height) throw new Error('Not a Tiled map');
      var first = (o.tilesets&&o.tilesets[0])||{};
      var m = makeEmptyMap(o.width, o.height, o.tilewidth||32, o.tileheight||32);
      m.tileset.name = first.name||'tileset';
      m.tileset.image = first.image||'tileset.png';
      m.tileset.imagewidth = first.imagewidth||0;
      m.tileset.imageheight = first.imageheight||0;
      m.tileset.margin = first.margin||0;
      m.tileset.spacing = first.spacing||0;
      m.tileset.tilewidth = first.tilewidth||o.tilewidth||32;
      m.tileset.tileheight = first.tileheight||o.tileheight||32;
      m.tileset.columns = first.columns||0;
      m.tileset.tilecount = first.tilecount||0;
      if(!m.tileset.columns && m.tileset.imagewidth) buildTilesetMeta.call({map:m}); // fallback
      m.layers = o.layers.filter(function(l){ return l.type==='tilelayer'; }).map(function(l,i){
        return { id: l.id|| (i+1), name: l.name||('Layer '+(i+1)), type:'tilelayer', visible: l.visible!==false, opacity: l.opacity==null?1:l.opacity, data: (l.data||[]).slice(0, o.width*o.height) };
      });
      if(!m.layers.length) m.layers=[{id:1,name:'Ground',type:'tilelayer',visible:true,opacity:1,data:makeEmptyData(m.width,m.height)}];
      m._nextLayerId = o.nextlayerid || (m.layers.length+1);
      pushHistory();
      state.map=m;
      // try keep image
      state.tilesetImg=null; state.tilesetUrl='';
      persist(); renderAll();
      if(typeof global.toast==='function') global.toast('Imported '+m.width+'x'+m.height+' x'+m.layers.length+' layers','success');
    }catch(e){ if(typeof global.toast==='function') global.toast('Import failed: '+(e&&e.message),'error'); }
  }

  // ---- painting ----
  function cellAt(evt){
    var rect=canvas.getBoundingClientRect();
    var x=(evt.clientX-rect.left)/state.zoom, y=(evt.clientY-rect.top)/state.zoom;
    var tw=state.map.tileWidth, th=state.map.tileHeight;
    var c=Math.floor(x/tw), r=Math.floor(y/th);
    if(c<0||r<0||c>=state.map.width||r>=state.map.height) return null;
    return { c:c, r:r, idx: r*state.map.width+c };
  }
  function setCell(idx, gid){
    var ly=state.map.layers[state.selectedLayer];
    if(!ly) return;
    ly.data[idx]=gid|0;
  }
  function floodFill(startIdx, newGid){
    var ly=state.map.layers[state.selectedLayer];
    if(!ly) return;
    var w=state.map.width, h=state.map.height;
    var old=ly.data[startIdx];
    if(old===newGid) return;
    var q=[startIdx], seen={};
    seen[startIdx]=1;
    while(q.length){
      var cur=q.pop();
      if(ly.data[cur]!==old) continue;
      ly.data[cur]=newGid;
      var c=cur%w, r=Math.floor(cur/w);
      var nbs=[ cur-1, cur+1, cur-w, cur+w ];
      for(var i=0;i<nbs.length;i++){
        var nb=nbs[i];
        if(seen[nb]) continue;
        if(nb<0||nb>=w*h) continue;
        if(i===0 && c===0) continue;
        if(i===1 && c===w-1) continue;
        seen[nb]=1;
        if(ly.data[nb]===old) q.push(nb);
      }
    }
  }

  // ---- rendering ----
  function drawGrid(){
    if(!state.showGrid) return;
    var m=state.map; var tw=m.tileWidth, th=m.tileHeight;
    ctx.strokeStyle='rgba(255,255,255,0.08)';
    ctx.lineWidth=1;
    ctx.beginPath();
    for(var c=0;c<=m.width;c++){ var x=c*tw+0.5; ctx.moveTo(x,0); ctx.lineTo(x,m.height*th); }
    for(var r=0;r<=m.height;r++){ var y=r*th+0.5; ctx.moveTo(0,y); ctx.lineTo(m.width*tw,y); }
    ctx.stroke();
  }
  function drawMap(){
    if(!ctx||!canvas) return;
    var m=state.map; var tw=m.tileWidth, th=m.tileHeight;
    canvas.width = Math.max(1, m.width*tw*state.zoom);
    canvas.height = Math.max(1, m.height*th*state.zoom);
    // reset transform for zoom scaling via CSS size + backing scale
    // We keep logical size = map px, then scale via ctx scaling
    // Simpler: set canvas bitmap to map px * zoom and scale drawings by zoom.
    // Instead draw at zoom.
    ctx.setTransform(state.zoom,0,0,state.zoom,0,0);
    ctx.clearRect(0,0,m.width*tw,m.height*th);
    // checker background
    var cs=16;
    for(var y=0;y<m.height*th;y+=cs) for(var x=0;x<m.width*tw;x+=cs){
      ctx.fillStyle= ((Math.floor(x/cs)+Math.floor(y/cs))%2===0) ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.18)';
      ctx.fillRect(x,y,Math.min(cs,m.width*tw-x),Math.min(cs,m.height*th-y));
    }
    // layers bottom->top
    for(var li=0; li<m.layers.length; li++){
      var ly=m.layers[li];
      if(ly.visible===false) continue;
      var alpha = ly.opacity==null?1:ly.opacity;
      if(alpha<=0) continue;
      ctx.globalAlpha=alpha;
      for(var r2=0;r2<m.height;r2++) for(var c2=0;c2<m.width;c2++){
        var gid=ly.data[r2*m.width+c2]|0;
        if(!gid) continue;
        var dx=c2*tw, dy=r2*th;
        if(state.tilesetImg && state.map.tileset.columns){
          var rc=gidToRC(gid, state.map.tileset.columns);
          if(!rc) continue;
          var sx=state.map.tileset.margin + rc.c*(tw+state.map.tileset.spacing);
          var sy=state.map.tileset.margin + rc.r*(th+state.map.tileset.spacing);
          try{ ctx.drawImage(state.tilesetImg, sx,sy,tw,th, dx,dy,tw,th); }catch(e){}
        } else {
          // fallback: colored tile with gid label
          var hue=(gid*47)%360;
          ctx.fillStyle='hsl('+hue+' 70% 55%)';
          ctx.fillRect(dx+1,dy+1,tw-2,th-2);
          if(tw>=20){
            ctx.fillStyle='rgba(0,0,0,0.75)'; ctx.font='10px monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.fillText(String(gid), dx+tw/2, dy+th/2);
          }
        }
        if(state.showIds && state.tilesetImg){
          ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.fillRect(dx,dy,tw,10);
          ctx.fillStyle='#fff'; ctx.font='9px monospace'; ctx.textAlign='center'; ctx.fillText(String(gid), dx+tw/2, dy+7);
        }
      }
      ctx.globalAlpha=1;
    }
    drawGrid();
    if(hoverCell){
      ctx.strokeStyle='rgba(255,220,80,0.95)'; ctx.lineWidth=2;
      ctx.strokeRect(hoverCell.c*tw+0.5, hoverCell.r*th+0.5, tw-1, th-1);
    }
    var selLy=m.layers[state.selectedLayer];
    if(selLy){
      // label selected layer
      ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.fillRect(0,0, 120, 18);
      ctx.fillStyle='#fff'; ctx.font='11px sans-serif'; ctx.textAlign='left'; ctx.fillText('Layer: '+selLy.name, 6, 12);
    }
  }
  function drawPalette(){
    if(!palCanvas||!palCtx) return;
    var ts=state.map.tileset;
    var tw=ts.tilewidth||state.map.tileWidth, th=ts.tileheight||state.map.tileHeight;
    if(state.tilesetImg && ts.columns){
      var cols=ts.columns, rows=Math.ceil(ts.tilecount/cols)||1;
      var pad=4, gap=4;
      var cell= Math.min(64, Math.max(28, Math.floor((palCanvas.width-pad*2 - gap*(cols-1))/cols) ));
      // palette canvas size fit
      palCanvas.width = pad*2 + cols*cell + gap*(cols-1);
      palCanvas.height = pad*2 + rows*cell + gap*(rows-1);
      palCtx.clearRect(0,0,palCanvas.width,palCanvas.height);
      for(var gid=1; gid<=ts.tilecount; gid++){
        var rc=gidToRC(gid, cols);
        var col=rc.c, row=rc.r;
        var x=pad+col*(cell+gap), y=pad+row*(cell+gap);
        var sx=ts.margin + col*(tw+ts.spacing), sy=ts.margin + row*(th+ts.spacing);
        palCtx.fillStyle='#1e1e2a'; palCtx.fillRect(x,y,cell,cell);
        try{ palCtx.drawImage(state.tilesetImg, sx,sy,tw,th, x,y,cell,cell); }catch(e){}
        if(gid===state.selectedGid){ palCtx.strokeStyle='#ffd54f'; palCtx.lineWidth=3; palCtx.strokeRect(x+1,y+1,cell-2,cell-2); }
        palCtx.fillStyle='rgba(0,0,0,0.55)'; palCtx.fillRect(x,y,cell,10);
        palCtx.fillStyle='#fff'; palCtx.font='9px monospace'; palCtx.textAlign='center'; palCtx.fillText(String(gid), x+cell/2, y+8);
      }
    } else {
      // empty palette placeholder
      palCanvas.width=240; palCanvas.height=120;
      palCtx.clearRect(0,0,palCanvas.width,palCanvas.height);
      palCtx.fillStyle='rgba(255,255,255,0.06)'; palCtx.fillRect(0,0,palCanvas.width,palCanvas.height);
      palCtx.fillStyle='var(--text-muted, #888)'; palCtx.font='12px sans-serif'; palCtx.textAlign='center';
      palCtx.fillText('Upload a tileset image', palCanvas.width/2, palCanvas.height/2);
    }
  }

  function renderAll(){
    drawMap();
    drawPalette();
    syncControls();
    persist();
  }
  function syncControls(){
    if(!root) return;
    var m=state.map;
    var wEl=root.querySelector('#tm-w'), hEl=root.querySelector('#tm-h'), twEl=root.querySelector('#tm-tw'), thEl=root.querySelector('#tm-th');
    if(wEl) wEl.value=String(m.width);
    if(hEl) hEl.value=String(m.height);
    if(twEl) twEl.value=String(m.tileWidth);
    if(thEl) thEl.value=String(m.tileHeight);
    var zoomEl=root.querySelector('#tm-zoom');
    if(zoomEl) zoomEl.value=String(Math.round(state.zoom*100));
    var gridEl=root.querySelector('#tm-grid');
    if(gridEl) gridEl.checked=!!state.showGrid;
    var idsEl=root.querySelector('#tm-ids');
    if(idsEl) idsEl.checked=!!state.showIds;
    var toolEls=root.querySelectorAll('[data-tm-tool]');
    toolEls.forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-tm-tool')===state.tool); });
    // layers list
    var list=root.querySelector('#tm-layers');
    if(list){
      list.innerHTML='';
      m.layers.forEach(function(ly, idx){
        var row=document.createElement('div');
        row.className='tm-layer-row'+(idx===state.selectedLayer?' active':'');
        row.innerHTML='<span class="tm-layer-name">'+escapeHtml(ly.name)+'</span>'
          +'<label class="tm-layer-vis"><input type="checkbox" '+(ly.visible!==false?'checked':'')+' data-vis="'+idx+'"> vis</label>'
          +'<input type="range" min="0" max="100" value="'+Math.round((ly.opacity==null?1:ly.opacity)*100)+'" data-op="'+idx+'" style="width:70px">'
          +'<button data-up="'+idx+'" title="Up">↑</button><button data-down="'+idx+'" title="Down">↓</button>'
          +'<button data-del="'+idx+'" title="Delete">×</button>';
        row.addEventListener('click', function(e){
          if(e.target.closest('button')||e.target.closest('input')) return;
          state.selectedLayer=idx; renderAll();
        });
        list.appendChild(row);
      });
      // bind layer controls (delegate)
      list.querySelectorAll('input[data-vis]').forEach(function(cb){
        cb.addEventListener('change', function(){ var i=parseInt(cb.getAttribute('data-vis'),10); state.map.layers[i].visible=cb.checked; renderAll(); });
      });
      list.querySelectorAll('input[data-op]').forEach(function(rg){
        rg.addEventListener('input', function(){ var i=parseInt(rg.getAttribute('data-op'),10); state.map.layers[i].opacity=parseInt(rg.value,10)/100; drawMap(); persist(); });
      });
      list.querySelectorAll('button[data-up]').forEach(function(b){
        b.addEventListener('click', function(){ var i=parseInt(b.getAttribute('data-up'),10); if(i<=0) return; pushHistory(); var a=state.map.layers; var tmp=a[i-1]; a[i-1]=a[i]; a[i]=tmp; state.selectedLayer=Math.max(0, state.selectedLayer- (state.selectedLayer===i?1:0) + (state.selectedLayer===i-1?1:0)); renderAll(); });
      });
      list.querySelectorAll('button[data-down]').forEach(function(b){
        b.addEventListener('click', function(){ var i=parseInt(b.getAttribute('data-down'),10); if(i>=state.map.layers.length-1) return; pushHistory(); var a=state.map.layers; var tmp=a[i+1]; a[i+1]=a[i]; a[i]=tmp; state.selectedLayer=Math.min(a.length-1, state.selectedLayer + (state.selectedLayer===i?1:0) - (state.selectedLayer===i+1?1:0)); renderAll(); });
      });
      list.querySelectorAll('button[data-del]').forEach(function(b){
        b.addEventListener('click', function(){ var i=parseInt(b.getAttribute('data-del'),10); if(state.map.layers.length<=1){ if(typeof global.toast==='function') global.toast('Keep at least one layer','warning'); return; } pushHistory(); state.map.layers.splice(i,1); state.selectedLayer=Math.min(state.selectedLayer, state.map.layers.length-1); renderAll(); });
      });
    }
    var selInfo=root.querySelector('#tm-sel');
    if(selInfo) selInfo.textContent='GID '+state.selectedGid+' · Tool '+state.tool+' · Layer '+(m.layers[state.selectedLayer]?m.layers[state.selectedLayer].name:'-');
  }

  function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function bindCanvas(){
    if(!canvas) return;
    canvas.addEventListener('mousemove', function(e){
      hoverCell=cellAt(e);
      if(dragging && hoverCell){
        if(dragButton===0){
          if(state.tool==='brush') setCell(hoverCell.idx, state.selectedGid);
          else if(state.tool==='eraser') setCell(hoverCell.idx, 0);
        }
        drawMap();
      } else {
        drawMap();
      }
    });
    canvas.addEventListener('mouseleave', function(){ hoverCell=null; drawMap(); });
    canvas.addEventListener('mousedown', function(e){
      if(e.button!==0 && e.button!==2) return;
      e.preventDefault();
      var cell=cellAt(e);
      if(!cell) return;
      // right-click picks tile
      if(e.button===2){
        var ly=state.map.layers[state.selectedLayer];
        if(ly){ state.selectedGid = ly.data[cell.idx]|| state.selectedGid; state.tool='brush'; renderAll(); }
        return;
      }
      pushHistory();
      dragging=true; dragButton=e.button;
      if(state.tool==='fill'){
        var gid = state.selectedGid;
        floodFill(cell.idx, gid);
        dragging=false;
        renderAll();
        return;
      } else if(state.tool==='picker'){
        var ly2=state.map.layers[state.selectedLayer];
        if(ly2){ state.selectedGid = ly2.data[cell.idx]||1; state.tool='brush'; renderAll(); }
        dragging=false;
        return;
      } else if(state.tool==='brush'){
        setCell(cell.idx, state.selectedGid); drawMap();
      } else if(state.tool==='eraser'){
        setCell(cell.idx, 0); drawMap();
      }
    });
    window.addEventListener('mouseup', function(){
      if(dragging){ dragging=false; persist(); }
    });
    canvas.addEventListener('contextmenu', function(e){ e.preventDefault(); });
    canvas.addEventListener('wheel', function(e){
      if(!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      var delta = e.deltaY>0? -0.1: 0.1;
      state.zoom = Math.max(0.25, Math.min(4, state.zoom+delta));
      drawMap(); syncControls();
    }, { passive:false });
  }

  function bindPalette(){
    if(!palCanvas) return;
    palCanvas.addEventListener('click', function(e){
      var ts=state.map.tileset;
      if(!state.tilesetImg || !ts.columns) return;
      var rect=palCanvas.getBoundingClientRect();
      var x=e.clientX-rect.left, y=e.clientY-rect.top;
      var pad=4, gap=4;
      var cols=ts.columns;
      var cellW = (palCanvas.width-pad*2 - gap*(cols-1))/cols;
      // derive col/row from click
      // brute hit test
      for(var gid=1; gid<=ts.tilecount; gid++){
        var rc=gidToRC(gid, cols);
        var col=rc.c, row=rc.r;
        var cx=pad+col*(cellW+gap), cy=pad+row*(cellW+gap);
        if(x>=cx && x<cx+cellW && y>=cy && y<cy+cellW){ state.selectedGid=gid; renderAll(); break; }
      }
    });
  }

  function buildRoot(container){
    root=document.createElement('div');
    root.className='tilemap-root';
    root.style.cssText='display:flex;flex-direction:column;height:100%;min-height:0;gap:8px;padding:10px;box-sizing:border-box;';
    // top bar
    var top=document.createElement('div');
    top.style.cssText='display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
    top.innerHTML=
      '<div style="display:flex;align-items:center;gap:6px"><span style="font-weight:700">TileMap</span><span style="font-size:12px;color:var(--text-muted)">Tiled JSON → Phaser</span></div>'
      +'<span style="flex:1"></span>'
      +'<label class="btn btn-ghost" style="padding:4px 10px;cursor:pointer"><input id="tm-tileset-file" type="file" accept="image/*" hidden> Upload Tileset</label>'
      +'<button id="tm-import" class="btn btn-ghost" style="padding:4px 10px">Import JSON</button>'
      +'<input id="tm-import-file" type="file" accept=".json,.tmj,application/json" hidden>'
      +'<button id="tm-export" class="btn btn-primary" style="padding:4px 12px">Export JSON</button>'
      +'<button id="tm-copy" class="btn btn-ghost" style="padding:4px 10px">Copy JSON</button>'
      +'<button id="tm-clear" class="btn btn-ghost" style="padding:4px 10px">Clear</button>'
      +'<span style="width:1px;height:20px;background:var(--glass-border);margin:0 4px"></span>'
      +'<button data-tm-tool="brush" class="btn btn-ghost" style="padding:4px 10px">Brush</button>'
      +'<button data-tm-tool="eraser" class="btn btn-ghost" style="padding:4px 10px">Eraser</button>'
      +'<button data-tm-tool="fill" class="btn btn-ghost" style="padding:4px 10px">Fill</button>'
      +'<button data-tm-tool="picker" class="btn btn-ghost" style="padding:4px 10px">Picker</button>'
      +'<span style="width:1px;height:20px;background:var(--glass-border);margin:0 4px"></span>'
      +'<button id="tm-undo" class="btn btn-ghost" style="padding:4px 8px">Undo</button><button id="tm-redo" class="btn btn-ghost" style="padding:4px 8px">Redo</button>';
    root.appendChild(top);
    var cfg=document.createElement('div');
    cfg.style.cssText='display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--text-muted)';
    cfg.innerHTML=
      'W <input id="tm-w" type="number" min="1" max="256" style="width:64px;padding:4px 6px"> '
      +'H <input id="tm-h" type="number" min="1" max="256" style="width:64px;padding:4px 6px"> '
      +'TW <input id="tm-tw" type="number" min="8" max="256" style="width:64px;padding:4px 6px"> '
      +'TH <input id="tm-th" type="number" min="8" max="256" style="width:64px;padding:4px 6px"> '
      +'<button id="tm-resize" class="btn btn-ghost" style="padding:4px 8px">Resize</button>'
      +'<span style="width:1px;height:18px;background:var(--glass-border);margin:0 4px"></span>'
      +'Zoom <input id="tm-zoom" type="range" min="25" max="300" step="25" style="width:90px"> <span id="tm-zoom-label" style="min-width:36px;text-align:right">100%</span>'
      +'<label style="display:inline-flex;align-items:center;gap:4px"><input id="tm-grid" type="checkbox" checked> Grid</label>'
      +'<label style="display:inline-flex;align-items:center;gap:4px"><input id="tm-ids" type="checkbox"> IDs</label>'
      +'<span id="tm-sel" style="margin-left:auto;font-size:11px;color:var(--text-muted)"></span>';
    root.appendChild(cfg);
    var body=document.createElement('div');
    body.style.cssText='display:flex;flex:1;min-height:0;gap:10px;';
    // left palette
    var left=document.createElement('div');
    left.style.cssText='width:280px;min-width:220px;max-width:360px;display:flex;flex-direction:column;gap:8px;border:1px solid var(--glass-border);border-radius:10px;padding:8px;overflow:auto;background:rgba(0,0,0,0.12)';
    left.innerHTML='<div style="font-weight:600;font-size:13px;display:flex;align-items:center;justify-content:space-between">Palette <span style="font-weight:400;font-size:11px;color:var(--text-muted)">click to select</span></div>';
    palCanvas=document.createElement('canvas');
    palCanvas.style.cssText='width:100%;height:auto;display:block;border-radius:8px;background:rgba(255,255,255,0.03)';
    palCtx=palCanvas.getContext('2d');
    left.appendChild(palCanvas);
    var palHint=document.createElement('div');
    palHint.style.cssText='font-size:11px;color:var(--text-muted);line-height:1.4';
    palHint.textContent='Tip: right-click canvas to pick tile. Ctrl+wheel to zoom.';
    left.appendChild(palHint);
    // Phaser snippet helper
    var snippet=document.createElement('div');
    snippet.style.cssText='margin-top:6px;padding:8px;border:1px dashed var(--glass-border);border-radius:8px;background:rgba(255,255,255,0.04);font-size:11px;line-height:1.4';
    snippet.innerHTML='<div style="font-weight:600;margin-bottom:4px">Phaser 4 snippet</div>'
      +'<pre style="margin:0;white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:11px">preload(){ this.load.image(\'tiles\', \'tileset.png\'); this.load.tilemapTiledJSON(\'map\', \'map.json\'); }\ncreate(){ const map=this.make.tilemap({key:\'map\'}); const ts=map.addTilesetImage(\'tileset\',\'tiles\'); map.createLayer(\'Ground\',ts); }</pre>'
      +'<div style="color:var(--text-muted);margin-top:4px">Exported JSON already matches Tiled format: spacing/margin/firstgid preserved. Put the tileset PNG next to the JSON.</div>';
    left.appendChild(snippet);
    // center canvas
    var center=document.createElement('div');
    center.style.cssText='flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;';
    var canvasWrap=document.createElement('div');
    canvasWrap.style.cssText='flex:1;min-height:280px;overflow:auto;border:1px solid var(--glass-border);border-radius:10px;background:rgba(0,0,0,0.18);display:flex;align-items:flex-start;justify-content:flex-start;padding:8px;';
    canvas=document.createElement('canvas');
    canvas.style.cssText='display:block;image-rendering:pixelated;image-rendering:crisp-edges;';
    ctx=canvas.getContext('2d');
    canvasWrap.appendChild(canvas);
    center.appendChild(canvasWrap);
    var hint=document.createElement('div');
    hint.style.cssText='font-size:11px;color:var(--text-muted)';
    hint.textContent='Layers are orthogonal grid. Exported JSON is Tiled-compatible: load via Phaser tilemapTiledJSON → make.tilemap → addTilesetImage → createLayer. Spacing/margin preserved.';
    center.appendChild(hint);
    // right layers
    var right=document.createElement('div');
    right.style.cssText='width:260px;min-width:220px;display:flex;flex-direction:column;gap:8px;border:1px solid var(--glass-border);border-radius:10px;padding:8px;overflow:auto;background:rgba(0,0,0,0.12)';
    right.innerHTML='<div style="font-weight:600;font-size:13px">Layers</div><div id="tm-layers" style="display:flex;flex-direction:column;gap:6px"></div><div style="display:flex;gap:6px"><input id="tm-layer-name" placeholder="New layer" style="flex:1;padding:4px 6px"><button id="tm-layer-add" class="btn btn-ghost" style="padding:4px 8px">Add</button></div><div style="font-size:11px;color:var(--text-muted)">Top = drawn last. Visibility & opacity per layer.</div>';
    body.appendChild(left); body.appendChild(center); body.appendChild(right);
    root.appendChild(body);
    container.appendChild(root);

    // bind top actions
    root.querySelector('#tm-tileset-file').addEventListener('change', function(e){ var f=e.target.files&&e.target.files[0]; if(f) loadTilesetFromFile(f); e.target.value=''; });
    root.querySelector('#tm-import').addEventListener('click', function(){ root.querySelector('#tm-import-file').click(); });
    root.querySelector('#tm-import-file').addEventListener('change', function(e){ var f=e.target.files&&e.target.files[0]; if(!f) return; var r=new FileReader(); r.onload=function(){ importJson(r.result); }; r.readAsText(f); e.target.value=''; });
    root.querySelector('#tm-export').addEventListener('click', function(){ var txt=exportTiledJSON(); downloadText((state.map.tileset.name||'map')+'.json', txt, 'application/json'); if(typeof global.toast==='function') global.toast('Exported JSON','success'); });
    root.querySelector('#tm-copy').addEventListener('click', function(){ var txt=exportTiledJSON(); if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(function(){ if(typeof global.toast==='function') global.toast('Copied JSON','success'); }); } else { downloadText('map.json', txt); } });
    root.querySelector('#tm-clear').addEventListener('click', function(){ if(!confirm('Clear current layer?')) return; pushHistory(); var ly=state.map.layers[state.selectedLayer]; if(ly) for(var i=0;i<ly.data.length;i++) ly.data[i]=0; renderAll(); });
    root.querySelectorAll('[data-tm-tool]').forEach(function(b){ b.addEventListener('click', function(){ state.tool=b.getAttribute('data-tm-tool'); renderAll(); }); });
    root.querySelector('#tm-undo').addEventListener('click', undo);
    root.querySelector('#tm-redo').addEventListener('click', redo);
    root.querySelector('#tm-resize').addEventListener('click', function(){
      var w=parseInt(root.querySelector('#tm-w').value,10), h=parseInt(root.querySelector('#tm-h').value,10), tw=parseInt(root.querySelector('#tm-tw').value,10), th=parseInt(root.querySelector('#tm-th').value,10);
      if(!(w>0&&h>0&&tw>=8&&th>=8)) return;
      if(w>256||h>256){ if(typeof global.toast==='function') global.toast('Max 256','warning'); return; }
      pushHistory();
      var oldW=state.map.width, oldH=state.map.height;
      state.map.width=w; state.map.height=h; state.map.tileWidth=tw; state.map.tileHeight=th;
      state.map.tileset.tilewidth=tw; state.map.tileset.tileheight=th;
      // resize each layer data preserving top-left
      state.map.layers.forEach(function(ly){
        var nd=makeEmptyData(w,h);
        for(var r=0;r<Math.min(oldH,h);r++) for(var c=0;c<Math.min(oldW,w);c++) nd[r*w+c]=ly.data[r*oldW+c];
        ly.data=nd;
      });
      buildTilesetMeta(); renderAll();
    });
    root.querySelector('#tm-zoom').addEventListener('input', function(e){ var v=parseInt(e.target.value,10); state.zoom=v/100; root.querySelector('#tm-zoom-label').textContent=v+'%'; drawMap(); });
    root.querySelector('#tm-grid').addEventListener('change', function(e){ state.showGrid=e.target.checked; drawMap(); });
    root.querySelector('#tm-ids').addEventListener('change', function(e){ state.showIds=e.target.checked; drawMap(); });
    // layer add
    root.querySelector('#tm-layer-add').addEventListener('click', function(){
      var name=(root.querySelector('#tm-layer-name').value||'').trim()||('Layer '+(state.map.layers.length+1));
      pushHistory();
      state.map.layers.push({ id: state.map._nextLayerId++, name:name, type:'tilelayer', visible:true, opacity:1, data: makeEmptyData(state.map.width,state.map.height) });
      state.selectedLayer=state.map.layers.length-1;
      root.querySelector('#tm-layer-name').value='';
      renderAll();
    });
    bindCanvas(); bindPalette();
    renderAll();
  }

  function destroyRoot(){
    try{ if(root&&root.parentNode) root.parentNode.removeChild(root); }catch(e){}
    root=null; canvas=null; ctx=null; palCanvas=null; palCtx=null;
  }

  // Public: render into Editor container category wrapper
  function renderTilemap(container){
    // container is the Editor page container (#page-content)
    container.innerHTML='';
    container.style.height='100%'; container.style.overflow='hidden'; container.style.display='flex'; container.style.flexDirection='column';
    buildRoot(container);
  }
  function cleanupTilemap(){ destroyRoot(); }

  // ---- Editor category chrome (tabs above existing editor) ----
  function ensureCategoryBar(edContainer){
    if(!edContainer) return;
    var existing=edContainer.querySelector('#ed-category-bar');
    if(existing) return existing;
    var bar=document.createElement('div');
    bar.id='ed-category-bar';
    bar.style.cssText='display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--glass-border);background:rgba(0,0,0,0.12);flex-shrink:0;';
    var cat=getCategory();
    bar.innerHTML='<button data-ed-cat="text" class="btn '+(cat===CAT_TEXT?'btn-primary':'btn-ghost')+'" style="padding:4px 10px">Text Editor</button>'
      +'<button data-ed-cat="tilemap" class="btn '+(cat===CAT_TILEMAP?'btn-primary':'btn-ghost')+'" style="padding:4px 10px">TileMap Editor</button>'
      +'<span style="flex:1"></span><span style="font-size:11px;color:var(--text-muted)">Editor categories</span>';
    // insert as first child of edContainer (which is #page-content)
    if(edContainer.firstChild) edContainer.insertBefore(bar, edContainer.firstChild);
    else edContainer.appendChild(bar);
    bar.querySelectorAll('[data-ed-cat]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var c=btn.getAttribute('data-ed-cat');
        setCategory(c);
        // re-render Editor page via navigateTo to switch category content
        if(typeof global.navigateTo==='function'){
          // force re-render by navigating to editor again
          var cur = (typeof global.currentPage!=='undefined'? global.currentPage : 'editor');
          if(cur==='editor') { destroyRoot(); if(typeof global.renderEditor==='function' && c===CAT_TEXT) { /* will be handled by wrapper */ } }
          global.navigateTo('editor');
        }
      });
    });
    return bar;
  }

  // Wrap existing renderEditor to support categories
  function installEditorCategory(){
    if(global.__tilemapCategoryInstalled) return;
    global.__tilemapCategoryInstalled=true;
    var origRender = global.renderEditor;
    var origCleanup = global.cleanupEditor;
    var origSuspend = global.suspendEditor;
    var origResume = global.resumeEditor;
    global.renderEditor = function(container){
      var cat=getCategory();
      // Always ensure bar exists at top of #page-content
      // We render bar first, then the actual editor content below it.
      // To keep layout, wrap content in a flex column: bar + body.
      container.innerHTML='';
      container.style.height='100%'; container.style.overflow='hidden'; container.style.display='flex'; container.style.flexDirection='column';
      var bar=document.createElement('div');
      bar.id='ed-category-bar';
      bar.style.cssText='display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--glass-border);background:rgba(0,0,0,0.12);flex-shrink:0;';
      bar.innerHTML='<button data-ed-cat="text" class="btn '+(cat===CAT_TEXT?'btn-primary':'btn-ghost')+'" style="padding:4px 10px">Text Editor</button>'
        +'<button data-ed-cat="tilemap" class="btn '+(cat===CAT_TILEMAP?'btn-primary':'btn-ghost')+'" style="padding:4px 10px">TileMap Editor</button>'
        +'<span style="flex:1"></span><span style="font-size:11px;color:var(--text-muted)">TileMap · Tiled JSON → Phaser</span>';
      container.appendChild(bar);
      var body=document.createElement('div');
      body.id='ed-category-body';
      body.style.cssText='flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;';
      container.appendChild(body);
      bar.querySelectorAll('[data-ed-cat]').forEach(function(btn){
        btn.addEventListener('click', function(){
          var c=btn.getAttribute('data-ed-cat');
          setCategory(c);
          global.renderEditor(container);
        });
      });
      if(cat===CAT_TILEMAP){
        renderTilemap(body);
        return;
      }
      // Text Editor: delegate to original (renderLegacyEditor if available)
      var fn = global.renderLegacyEditor || origRender;
      if(typeof fn==='function') return fn.call(global, body);
    };
    global.cleanupEditor = function(){
      cleanupTilemap();
      if(typeof origCleanup==='function') try{ origCleanup(); }catch(e){}
    };
    global.suspendEditor = function(){ cleanupTilemap(); if(typeof origSuspend==='function') try{ origSuspend(); }catch(e){} };
    global.resumeEditor = function(){ if(typeof origResume==='function') try{ origResume(); }catch(e){} };
  }

  // auto-install when script loaded after editor.js
  if(typeof global.renderEditor==='function') installEditorCategory();
  else {
    // defer until DOM ready in case script order is off
    document.addEventListener('DOMContentLoaded', function(){ if(typeof global.renderEditor==='function') installEditorCategory(); });
  }

  // Expose for tests/manual
  global.TilemapEditor = {
    getCategory: getCategory, setCategory: setCategory,
    exportTiledJSON: exportTiledJSON, importJson: importJson,
    getState: function(){ return state; },
    makeEmptyMap: makeEmptyMap,
    renderTilemap: renderTilemap, cleanupTilemap: cleanupTilemap
  };

})(typeof window!=='undefined'? window : this);
