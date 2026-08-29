// web/static/music/player.js
// Thin wrapper around <audio> with queue, loop, shuffle, and events.
(function(global){
  function createAudio(){
    var a = document.createElement('audio');
    a.preload='metadata';
    a.crossOrigin='anonymous';
    return a;
  }
  function MusicPlayer(opts){
    opts = opts||{};
    this.audio = opts.audio || createAudio();
    this.queue = [];
    this.index = -1;
    this.loop = 'off'; // off | one | all
    this.shuffle = false;
    this._order = []; // shuffled index order
    this._cb = {};
    var self=this;
    this.audio.addEventListener('ended', function(){ self._onEnded(); });
    this.audio.addEventListener('timeupdate', function(){ self._emit('timeupdate'); });
    this.audio.addEventListener('play', function(){ self._emit('play'); });
    this.audio.addEventListener('pause', function(){ self._emit('pause'); });
    this.audio.addEventListener('error', function(e){ self._emit('error', e); });
  }
  MusicPlayer.prototype.on = function(ev, fn){ (this._cb[ev]=this._cb[ev]||[]).push(fn); };
  MusicPlayer.prototype.off = function(ev, fn){
    var arr=this._cb[ev]; if(!arr) return;
    var i=arr.indexOf(fn); if(i>=0) arr.splice(i,1);
  };
  MusicPlayer.prototype._emit = function(ev, data){
    var arr=this._cb[ev]||[]; for(var i=0;i<arr.length;i++) try{arr[i](data);}catch(e){}
  };
  MusicPlayer.prototype.setQueue = function(list, startIndex){
    this.queue = (list||[]).slice();
    this._rebuildOrder();
    this.index = typeof startIndex==='number'?startIndex:0;
  };
  MusicPlayer.prototype._rebuildOrder = function(){
    this._order = this.queue.map(function(_,i){return i;});
    if(this.shuffle){
      // Fisher-Yates
      for(var i=this._order.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=this._order[i]; this._order[i]=this._order[j]; this._order[j]=t; }
      // keep current at front
      if(this.index>=0){ var cur=this.queue[this.index]?this.index:this._order[0]; var pos=this._order.indexOf(cur); if(pos>0){ var tmp=this._order[0]; this._order[0]=this._order[pos]; this._order[pos]=tmp; } }
    }
  };
  MusicPlayer.prototype.current = function(){ return this.queue[this.index] || null; };
  MusicPlayer.prototype._resolveIndex = function(logical){
    if(!this.shuffle) return logical;
    return this._order[logical] ?? logical;
  };
  MusicPlayer.prototype._logicalOf = function(physical){
    if(!this.shuffle) return physical;
    return this._order.indexOf(physical);
  };
  MusicPlayer.prototype.playAt = function(idx){
    if(idx<0 || idx>=this.queue.length) return Promise.reject(new Error('out of range'));
    this.index = idx;
    var song=this.queue[idx];
    var self=this;
    // Use host to resolve media
    var host = global.MusicHost;
    var p = song && song._objectUrl ? Promise.resolve({url: song._objectUrl}) : (host ? host.getMediaSource(song) : Promise.resolve(null));
    return p.then(function(media){
      var url = (media&&media.url) || (song&&song.url) || '';
      if(!url) throw new Error('no url');
      self.audio.src = url;
      self.audio.play().catch(function(e){ self._emit('error', e); });
      self._emit('track', song);
      return song;
    });
  };
  MusicPlayer.prototype.play = function(){ if(this.audio.paused) this.audio.play(); };
  MusicPlayer.prototype.pause = function(){ this.audio.pause(); };
  MusicPlayer.prototype.toggle = function(){ if(this.audio.paused) this.play(); else this.pause(); };
  MusicPlayer.prototype.next = function(){
    if(!this.queue.length) return;
    if(this.loop==='one') return this.playAt(this.index);
    var logical=this._logicalOf(this.index);
    var nl = logical+1;
    if(nl>=this.queue.length){ if(this.loop==='all') nl=0; else return; }
    var phys=this._resolveIndex(nl);
    this.playAt(phys);
  };
  MusicPlayer.prototype.prev = function(){
    if(!this.queue.length) return;
    var logical=this._logicalOf(this.index);
    var pl=logical-1; if(pl<0){ if(this.loop==='all') pl=this.queue.length-1; else return; }
    var phys=this._resolveIndex(pl);
    this.playAt(phys);
  };
  MusicPlayer.prototype._onEnded = function(){
    if(this.loop==='one'){ this.playAt(this.index); return; }
    var logical=this._logicalOf(this.index);
    var nl=logical+1;
    if(nl>=this.queue.length){ if(this.loop==='all'){ this.playAt(this._resolveIndex(0)); } else { this._emit('ended'); } return; }
    this.playAt(this._resolveIndex(nl));
  };
  MusicPlayer.prototype.setShuffle = function(on){
    var cur=this.index;
    this.shuffle=!!on;
    this._rebuildOrder();
    // keep cur logical stable
    if(cur>=0) this.index=cur;
    this._emit('shuffle', this.shuffle);
  };
  MusicPlayer.prototype.cycleLoop = function(){
    var order=['off','all','one'];
    var i=order.indexOf(this.loop); this.loop=order[(i+1)%order.length];
    this._emit('loop', this.loop);
    return this.loop;
  };
  MusicPlayer.prototype.seek = function(ratio){
    var d=this.audio.duration||0; if(d>0) this.audio.currentTime = Math.max(0,Math.min(1,ratio))*d;
  };
  MusicPlayer.prototype.destroy = function(){
    try{ this.audio.pause(); this.audio.src=''; this.audio.removeAttribute('src'); }catch(e){}
    this._cb={};
  };
  global.MusicPlayer = MusicPlayer;
})(typeof window!=='undefined'?window:globalThis);
