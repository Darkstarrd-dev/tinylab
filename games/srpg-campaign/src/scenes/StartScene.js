// SC.StartScene — 开始菜单
(function () {
  'use strict';
  var SC = window.SC;
  SC.StartScene = function(){ Phaser.Scene.call(this,{key:'Start'}); };
  SC.StartScene.prototype = Object.create(Phaser.Scene.prototype);
  SC.StartScene.prototype.constructor = SC.StartScene;
  SC.StartScene.prototype.create = function(){
    var W=this.scale.width, H=this.scale.height;
    this.cameras.main.setBackgroundColor('#0e1628');
    this.add.rectangle(W/2,H/2,W,H,0x0e1628);
    this.add.text(W/2, 78, '星痕战记', {fontSize:'40px', color:'#e6edf3', fontStyle:'bold'}).setOrigin(0.5);
    this.add.text(W/2, 110, 'SRPG Campaign  ·  5章分支  ·  AVG+战棋+独立战斗演出', {fontSize:'12px', color:'#8b949e'}).setOrigin(0.5);
    this.add.text(W/2, 130, '转职 · 技能 · 分歧结局（真/通常）', {fontSize:'11px', color:'#6e7681'}).setOrigin(0.5);
    var self=this;
    function btn(y,label,cb,en){
      var enabled=en!==false;
      var bg=self.add.rectangle(W/2,y,220,40, enabled?0x2a3a56:0x1a2332).setInteractive(enabled?{useHandCursor:true}:{});
      var tx=self.add.text(W/2,y,label,{fontSize:'15px', color:enabled?'#e6edf3':'#6e7681', fontStyle:'bold'}).setOrigin(0.5);
      if(enabled){ bg.on('pointerover',function(){bg.fillColor=0x34495e;}); bg.on('pointerout',function(){bg.fillColor=0x2a3a56;}); bg.on('pointerdown',cb); }
      return {bg:bg,tx:tx};
    }
    var hasSave = SC.saveMgr && (SC.saveMgr.autosave || SC.saveMgr.slots.some(function(s){return !!s;}));
    btn(188,'开始新游戏', function(){ SC.gameState.reset(); SC.flags={}; SC.gameState.flags={}; SC.currentChapter=1; SC.sceneRef=self; self.scene.start('Avg', { chapterId:1, phase:'before' }); });
    btn(238,'继续游戏', function(){
      if(SC.saveMgr.autosave){ var g=SC.GameState.fromJSON(SC.saveMgr.autosave); SC.gameState=g; SC.flags=g.flags; SC.currentChapter=g.chapterId; SC.sceneRef=self; self.scene.start('Avg',{chapterId:g.chapterId, phase:'before'}); }
      else self.scene.start('SaveLoad', { mode:'load' });
    }, !!hasSave);
    btn(288,'读档 / 存档', function(){ self.scene.start('SaveLoad', { mode:'load' }); });
    btn(338,'设置', function(){ self.scene.start('Settings'); });
    btn(388,'章节选择', function(){ self.scene.start('SaveLoad', { mode:'chapter' }); });
    this.add.text(W/2, H-16, 'v'+SC.VERSION+'  ·  零外部资源  ·  热更新: 改 src/*.js 后点 Reload', {fontSize:'10px', color:'#484f58'}).setOrigin(0.5);
  };
})();
