// SC.BootScene — 初始化存档与 Sfx，跳 Start
(function () {
  'use strict';
  var SC = window.SC;
  SC.BootScene = function(){ Phaser.Scene.call(this,{key:'Boot'}); };
  SC.BootScene.prototype = Object.create(Phaser.Scene.prototype);
  SC.BootScene.prototype.constructor = SC.BootScene;
  SC.BootScene.prototype.preload = function(){ /* 零外部资源；TODO(视觉替换点): this.load.image */ };
  SC.BootScene.prototype.create = function(){
    var self=this;
    SC.Sfx = (function(){
      var ctx=null;
      function ensure(){ if(ctx) return ctx; try{var AC=window.AudioContext||window.webkitAudioContext; if(AC) ctx=new AC();}catch(e){} return ctx; }
      function tone(freq,dur,type,vol){
        var c=ensure(); if(!c) return;
        try{
          if(c.state==='suspended') c.resume().catch(function(){});
          var o=c.createOscillator(), g=c.createGain();
          o.type=type||'sine'; o.frequency.value=freq; g.gain.value=vol||0.16; o.connect(g); g.connect(c.destination);
          o.start(); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime+dur); o.stop(c.currentTime+dur+0.02);
        }catch(e){}
      }
      return { play:function(name){
        // TODO(音频替换点)
        if(name==='select') tone(700,0.08,'sine',0.14);
        else if(name==='move') tone(520,0.12,'sine',0.12);
        else if(name==='attack') tone(220,0.12,'square',0.14);
        else if(name==='hit') tone(180,0.16,'square',0.16);
        else if(name==='heal') tone(900,0.2,'sine',0.14);
        else if(name==='levelup'){ tone(523,0.16,'sine',0.14); setTimeout(function(){tone(659,0.16,'sine',0.14);},120); setTimeout(function(){tone(784,0.22,'sine',0.16);},240); }
        else if(name==='victory'){ tone(523,0.18,'sine',0.14); setTimeout(function(){tone(659,0.18,'sine',0.14);},140); setTimeout(function(){tone(784,0.32,'sine',0.18);},300); }
        else if(name==='defeat') tone(150,0.45,'sawtooth',0.14);
      }};
    })();
    if(!SC.gameState) SC.gameState = new SC.GameState();
    if(!SC.chapterMgr) SC.chapterMgr = new SC.ChapterManager(SC.gameState);
    if(!SC.saveMgr) SC.saveMgr = new SC.SaveManager(SC.hostRef);
    SC.saveMgr.load().then(function(){
      // 将存档 settings 同步到 gameState
      if(SC.saveMgr.settings) SC.gameState.settings = SC.saveMgr.settings;
      self.scene.start('Start');
    });
  };
})();
