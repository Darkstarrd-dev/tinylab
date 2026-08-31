// SC.SettingsScene — 设置面板
(function () {
  'use strict';
  var SC = window.SC;
  SC.SettingsScene = function(){ Phaser.Scene.call(this,{key:'Settings'}); };
  SC.SettingsScene.prototype = Object.create(Phaser.Scene.prototype);
  SC.SettingsScene.prototype.constructor = SC.SettingsScene;
  SC.SettingsScene.prototype.create = function(){
    var W=this.scale.width, H=this.scale.height;
    this.cameras.main.setBackgroundColor('#0e1628');
    this.add.text(W/2, 30, '设置', {fontSize:'22px', color:'#e6edf3', fontStyle:'bold'}).setOrigin(0.5);
    var self=this;
    var st = SC.gameState ? SC.gameState.settings : { animSpeed:1, autoSave:true };
    function row(y,label,opts, cur, onChange){
      self.add.text(220, y, label, {fontSize:'12px', color:'#8b949e'}).setOrigin(0,0.5);
      for(var i=0;i<opts.length;i++){
        (function(opt,idx){
          var sel = (opt===cur);
          var bg=self.add.rectangle(360+idx*86, y, 78, 28, sel?0x2a3a56:0x1a2332).setInteractive({useHandCursor:true});
          if(sel) bg.setStrokeStyle(1.5,0x3498db,1);
          var tx=self.add.text(360+idx*86, y, String(opt), {fontSize:'11px', color:sel?'#e6edf3':'#6e7681'}).setOrigin(0.5);
          bg.on('pointerdown', function(){ onChange(opt); self.scene.restart(); });
        })(opts[i], i);
      }
    }
    row(86, '动画速度', [1,2], st.animSpeed, function(v){ st.animSpeed=v; SC.saveMgr.settings.animSpeed=v; SC.saveMgr._persist(); });
    // 自动存档开关（文字切换）
    (function(){
      var y=128;
      self.add.text(220,y,'自动存档',{fontSize:'12px', color:'#8b949e'}).setOrigin(0,0.5);
      var cur = !!SC.saveMgr.settings.autoSave;
      var bg=self.add.rectangle(360,y,78,28, cur?0x1a7a3a:0x1a2332).setInteractive({useHandCursor:true});
      if(cur) bg.setStrokeStyle(1.5,0x2ecc71,1);
      self.add.text(360,y, cur?'开启':'关闭', {fontSize:'11px', color:cur?'#e6edf3':'#6e7681'}).setOrigin(0.5);
      bg.on('pointerdown', function(){ SC.saveMgr.settings.autoSave = !SC.saveMgr.settings.autoSave; SC.gameState.settings.autoSave = SC.saveMgr.settings.autoSave; SC.saveMgr._persist(); self.scene.restart(); });
    })();
    var back=self.add.rectangle(W/2, H-28, 140, 32, 0x2a3a56).setInteractive({useHandCursor:true});
    self.add.text(W/2,H-28,'返回',{fontSize:'13px', color:'#e6edf3'}).setOrigin(0.5);
    back.on('pointerdown', function(){ self.scene.start('Start'); });
    back.on('pointerover', function(){back.fillColor=0x34495e;}); back.on('pointerout', function(){back.fillColor=0x2a3a56;});
  };
})();
