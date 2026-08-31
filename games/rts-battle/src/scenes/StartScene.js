// RS.StartScene — 开始菜单
(function () {
  'use strict';
  var RS = window.RS;
  RS.StartScene = function(){ Phaser.Scene.call(this,{key:'Start'}); };
  RS.StartScene.prototype = Object.create(Phaser.Scene.prototype);
  RS.StartScene.prototype.constructor = RS.StartScene;
  RS.StartScene.prototype.create=function(){
    var W=this.scale.width, H=this.scale.height;
    this.cameras.main.setBackgroundColor('#0e1628');
    this.add.rectangle(W/2,H/2,W,H,0x0e1628);
    this.add.text(W/2, 72, 'RTS BATTLE', {fontSize:'42px', color:'#e6edf3', fontStyle:'bold'}).setOrigin(0.5);
    this.add.text(W/2, 104, '星际征伐  ·  单场景  ·  迷雾  ·  随机地图  ·  采集战斗', {fontSize:'12px', color:'#8b949e'}).setOrigin(0.5);
    this.add.text(W/2, 124, '框选多单位  ·  阵型避让（搞笑夸张） ·  AI 对手', {fontSize:'11px', color:'#6e7681'}).setOrigin(0.5);
    var self=this;
    var seedTxt='种子: '+RS.state.seed;
    this.add.text(W/2, 152, seedTxt, {fontSize:'11px', color:'#6e7681'}).setOrigin(0.5);
    function btn(y,label,cb){
      var bg=self.add.rectangle(W/2,y,240,42,0x2a3a56).setInteractive({useHandCursor:true});
      var tx=self.add.text(W/2,y,label,{fontSize:'15px', color:'#e6edf3', fontStyle:'bold'}).setOrigin(0.5);
      bg.on('pointerover',function(){bg.fillColor=0x34495e;}); bg.on('pointerout',function(){bg.fillColor=0x2a3a56;}); bg.on('pointerdown',cb);
      return bg;
    }
    btn(200,'开始战斗', function(){ self.scene.start('Rts', { seed: RS.state.seed }); });
    btn(252,'随机新图', function(){
      RS.state.seed=Math.floor(Math.random()*1e9);
      try{ localStorage.setItem(RS.MAP_CFG.seedKey, JSON.stringify({seed:RS.state.seed})); }catch(e){}
      self.scene.restart();
    });
    btn(304,'迷雾: '+(RS.state.settings.fog ? '开' : '关'), function(){ RS.state.settings.fog=!RS.state.settings.fog; self.scene.restart(); });
    btn(356,'AI: '+(RS.state.settings.ai ? '开' : '关'), function(){ RS.state.settings.ai=!RS.state.settings.ai; self.scene.restart(); });
    this.add.text(W/2, H-16, 'v'+RS.VERSION+'  ·  零外部资源  ·  热更新: 改 src/*.js 后点 Reload', {fontSize:'10px', color:'#484f58'}).setOrigin(0.5);
  };
})();
