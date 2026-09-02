(function(){
'use strict';
var FKO=window.FKO;
FKO.StageSelectScene=function(){ Phaser.Scene.call(this,{key:'StageSelect'}); };
FKO.StageSelectScene.prototype=Object.create(Phaser.Scene.prototype);
FKO.StageSelectScene.prototype.constructor=FKO.StageSelectScene;
FKO.StageSelectScene.prototype.create=function(){
  var self=this;
  var w=this.scale.width, h=this.scale.height;
  this.cameras.main.setBackgroundColor('#0f1117');
  this.add.text(w/2, 40, 'SELECT STAGE', {fontFamily:'monospace',fontSize:'28px',color:'#ffffff',fontStyle:'bold',stroke:'#000000',strokeThickness:4}).setOrigin(0.5);
  this.add.text(w/2, 68, '\u9009\u62E9\u821E\u53F0  |  Enter \u5F00\u6218', {fontFamily:'monospace',fontSize:'11px',color:'#90a4ae'}).setOrigin(0.5);
  var n=FKO.STAGES.length;
  var cardW=260, cardH=140, gap=20;
  var startX=(w-(n*cardW+(n-1)*gap))/2;
  var startY=110;
  this.sel=FKO.save.stageId||0;
  if(this.sel<0||this.sel>=n) this.sel=0;
  this.cards=[];
  for(var i=0;i<n;i++){
    var st=FKO.STAGES[i];
    var cx=startX+i*(cardW+gap)+cardW/2;
    var cy=startY+cardH/2;
    var col=Phaser.Display.Color.HexStringToColor(st.bg).color;
    var rect=this.add.rectangle(cx, cy, cardW, cardH, col).setInteractive({useHandCursor:true}).setStrokeStyle(2, 0x2a3a56);
    rect.stageIndex=i;
    this.add.text(cx, cy-10, st.name, {fontFamily:'monospace',fontSize:'16px',color:'#ffffff',stroke:'#000000',strokeThickness:3}).setOrigin(0.5);
    this.add.text(cx, cy+18, 'STAGE '+(i+1), {fontFamily:'monospace',fontSize:'10px',color:'#ffffff'}).setOrigin(0.5);
    this.cards.push(rect);
    (function(idx, r){
      r.on('pointerdown', function(){
        self.sel=idx;
        self.updateSelection();
        try{ if(FKO.Sfx) FKO.Sfx.play('block'); }catch(e){}
      });
    })(i, rect);
  }
  var btn=this.add.text(w/2, startY+cardH+40, 'FIGHT! (Enter)', {fontFamily:'monospace',fontSize:'18px',color:'#ffffff',backgroundColor:'#e53935',padding:{x:18,y:8}}).setOrigin(0.5).setInteractive({useHandCursor:true});
  var go=function(){
    FKO.save.stageId=self.sel;
    try{ if(FKO.Sfx) FKO.Sfx.play('punch'); }catch(e){}
    self.scene.start('Fight');
  };
  btn.on('pointerdown', go);
  this.input.keyboard.on('keydown-ENTER', go);
  this.input.keyboard.on('keydown-SPACE', go);
  this.updateSelection();
};
FKO.StageSelectScene.prototype.updateSelection=function(){
  for(var i=0;i<this.cards.length;i++){
    if(i===this.sel) this.cards[i].setStrokeStyle(3, 0x4fc3f7);
    else this.cards[i].setStrokeStyle(2, 0x2a3a56);
  }
};
})();
