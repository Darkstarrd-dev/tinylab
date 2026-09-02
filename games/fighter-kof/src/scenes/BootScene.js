(function(){
'use strict';
var FKO=window.FKO;
FKO.BootScene=function(){ Phaser.Scene.call(this,{key:'Boot'}); };
FKO.BootScene.prototype=Object.create(Phaser.Scene.prototype);
FKO.BootScene.prototype.constructor=FKO.BootScene;
FKO.BootScene.prototype.create=function(){
  var self=this;
  // Sfx init — WebAudio oscillator+gain
  FKO.Sfx=(function(){
    var ctx=null;
    var bgmTimer=null;
    var bgmStage=0;
    var pendingTimers=[];
    function ensure(){
      if(ctx) return ctx;
      try{ var AC=window.AudioContext||window.webkitAudioContext; if(AC) ctx=new AC(); }catch(e){}
      return ctx;
    }
    function tone(freq,dur,type,vol,slideTo){
      var c=ensure(); if(!c) return;
      try{
        if(c.state==='suspended') c.resume().catch(function(){});
        var o=c.createOscillator(), g=c.createGain();
        o.type=type||'sine'; o.frequency.value=freq;
        if(slideTo) try{ o.frequency.linearRampToValueAtTime(slideTo, c.currentTime+dur); }catch(e){}
        g.gain.value=vol!=null?vol:0.18;
        o.connect(g); g.connect(c.destination);
        o.start(); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime+dur);
        o.stop(c.currentTime+dur+0.02);
      }catch(e){}
    }
    function sched(fn,ms){ var id=setTimeout(fn,ms); pendingTimers.push(id); return id; }
    return {
      ensure: ensure,
      tone: tone,
      play:function(name){
        // TODO(音频替换点): 换成 this.sound.play(name)
        if(name==='punch') tone(180,0.08,'square',0.2,90);
        else if(name==='kick') tone(140,0.10,'square',0.2,70);
        else if(name==='hit') tone(220,0.14,'square',0.28,110);
        else if(name==='block') tone(300,0.07,'triangle',0.12,300);
        else if(name==='hadouken') { tone(260,0.22,'sawtooth',0.22,180); sched(function(){ tone(520,0.12,'square',0.14); },80); }
        else if(name==='shoryu') { tone(320,0.16,'sawtooth',0.24,640); sched(function(){ tone(440,0.18,'square',0.2); },120); }
        else if(name==='ko') { tone(150,0.4,'sawtooth',0.28,60); sched(function(){ tone(100,0.35,'triangle',0.2); },180); }
        else if(name==='super') { tone(400,0.2,'sawtooth',0.25,800); sched(function(){ tone(600,0.3,'square',0.22); },150); }
        else if(name==='fireball') tone(260,0.22,'sawtooth',0.22,180);
      },
      startBgm:function(scene, stage){
        try{
          FKO.Sfx.stopBgm();
          var c=ensure(); if(!c) return;
          bgmStage=stage|0;
          var notesA=[110,138,165,138];
          var notesB=[196,247,294,330,294,247];
          var notes=(bgmStage===0)?notesA:notesB;
          var delay=(bgmStage===0)?420:300;
          var idx=0;
          bgmTimer=scene.time.addEvent({delay:delay,loop:true,callback:function(){
            try{ var f=notes[idx%notes.length]; tone(f,0.14,(bgmStage===0?'triangle':'square'),0.05); idx++; }catch(e){}
          }});
        }catch(e){}
      },
      stopBgm:function(){
        try{ if(bgmTimer){ bgmTimer.remove(false); bgmTimer=null; } }catch(e){}
      },
      shutdown:function(){
        for(var i=0;i<pendingTimers.length;i++) try{ clearTimeout(pendingTimers[i]); }catch(e){}
        pendingTimers.length=0;
        try{ if(bgmTimer){ bgmTimer.remove(false); bgmTimer=null; } }catch(e){}
        try{ if(ctx && typeof ctx.close==='function' && ctx.state!=='closed') ctx.close(); else if(ctx && typeof ctx.suspend==='function' && ctx.state==='running') ctx.suspend(); }catch(e2){}
      },
      get ctx(){ return ctx; }, set ctx(v){ ctx=v; },
      get bgmTimer(){ return bgmTimer; }, set bgmTimer(v){ bgmTimer=v; }
    };
  })();
  try{ this.events.on('shutdown', function(){ if(FKO.Sfx&&FKO.Sfx.shutdown) FKO.Sfx.shutdown(); }); }catch(e){}
  try{ this.events.on('destroy', function(){ if(FKO.Sfx&&FKO.Sfx.shutdown) FKO.Sfx.shutdown(); }); }catch(e){}
  FKO.save=FKO.save||{wins:0,p1CharId:'kyo',p2CharId:'iori',stageId:0};
  var p=Promise.resolve(null);
  try{ if(FKO.hostRef&&FKO.hostRef.loadState) p=FKO.hostRef.loadState().catch(function(){ return null; }); }catch(e){ p=Promise.resolve(null); }
  p.then(function(s){
    if(s&&typeof s==='object'){
      if(typeof s.wins==='number') FKO.save.wins=s.wins|0;
      if(typeof s.p1CharId==='string'&&FKO.getCharacter(s.p1CharId)) FKO.save.p1CharId=s.p1CharId;
      if(typeof s.p2CharId==='string'&&FKO.getCharacter(s.p2CharId)) FKO.save.p2CharId=s.p2CharId;
      if(typeof s.stageId==='number') FKO.save.stageId=s.stageId|0;
    }
    self.scene.start('CharacterSelect');
  });
};
})();
