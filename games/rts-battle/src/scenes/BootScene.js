// RS.BootScene
(function () {
  'use strict';
  var RS = window.RS;
  RS.BootScene = function(){ Phaser.Scene.call(this,{key:'Boot'}); };
  RS.BootScene.prototype = Object.create(Phaser.Scene.prototype);
  RS.BootScene.prototype.constructor = RS.BootScene;
  RS.BootScene.prototype.preload=function(){ /* TODO(视觉替换点) */ };
  RS.BootScene.prototype.create=function(){
    var self=this;
    RS.Sfx=(function(){
      var ctx=null;
      function ensure(){ if(ctx) return ctx; try{var AC=window.AudioContext||window.webkitAudioContext; if(AC) ctx=new AC();}catch(e){} return ctx; }
      function tone(f,d,t,v){ var c=ensure(); if(!c) return; try{ if(c.state==='suspended') c.resume().catch(function(){}); var o=c.createOscillator(), g=c.createGain(); o.type=t||'sine'; o.frequency.value=f; g.gain.value=v||0.14; o.connect(g); g.connect(c.destination); o.start(); g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+d); o.stop(c.currentTime+d+0.02);}catch(e){} }
      return { play:function(n){ if(n==='select') tone(700,0.08,'sine',0.12); else if(n==='build') tone(520,0.16,'sine',0.12); else if(n==='attack') tone(220,0.10,'square',0.12); else if(n==='hit') tone(160,0.14,'square',0.14); else if(n==='victory'){ tone(523,0.16,'sine',0.12); setTimeout(function(){tone(659,0.16,'sine',0.12);},120); setTimeout(function(){tone(784,0.22,'sine',0.14);},240);} else if(n==='defeat') tone(140,0.4,'sawtooth',0.12);} };
    })();
    if(!RS.state) RS.state=new RS.GameState();
    // 种子持久
    try{
      var saved=JSON.parse(localStorage.getItem(RS.MAP_CFG.seedKey)||'null');
      if(saved && saved.seed) RS.state.seed=saved.seed;
      else localStorage.setItem(RS.MAP_CFG.seedKey, JSON.stringify({seed:RS.state.seed}));
    }catch(e){}
    // host 存档合并
    var p=Promise.resolve(null);
    try{ if(RS.hostRef&&RS.hostRef.loadState) p=RS.hostRef.loadState().catch(function(){return null;}); }catch(e){ p=Promise.resolve(null); }
    p.then(function(s){
      if(s && s.settings) RS.state.settings = Object.assign(RS.state.settings, s.settings);
      self.scene.start('Start');
    });
  };
})();
