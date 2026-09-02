(function(){
'use strict';
var FKO=window.FKO;
FKO.CharacterSelectScene=function(){ Phaser.Scene.call(this,{key:'CharacterSelect'}); };
FKO.CharacterSelectScene.prototype=Object.create(Phaser.Scene.prototype);
FKO.CharacterSelectScene.prototype.constructor=FKO.CharacterSelectScene;
FKO.CharacterSelectScene.prototype.create=function(){
  var self=this;
  var w=this.scale.width, h=this.scale.height;
  this.cameras.main.setBackgroundColor('#0f1117');
  this.add.text(w/2, 40, 'SELECT CHARACTER', {fontFamily:'monospace',fontSize:'28px',color:'#ffffff',fontStyle:'bold',stroke:'#000000',strokeThickness:4}).setOrigin(0.5);
  this.add.text(w/2, 68, 'P1 vs P2  |  Enter \u5F00\u59CB', {fontFamily:'monospace',fontSize:'11px',color:'#90a4ae'}).setOrigin(0.5);

  var cardW=180, cardH=120, gapX=20, gapY=20;
  var startX=(w-(2*cardW+gapX))/2;
  var startY=100;
  // default from save
  var p1Sel=0, p2Sel=1;
  for(var cc=0;cc<FKO.CHARACTERS.length;cc++){
    if(FKO.CHARACTERS[cc].id===FKO.save.p1CharId) p1Sel=cc;
    if(FKO.CHARACTERS[cc].id===FKO.save.p2CharId) p2Sel=cc;
  }
  this.p1Sel=p1Sel;
  this.p2Sel=p2Sel;
  this.cards=[];

  for(var i=0;i<FKO.CHARACTERS.length;i++){
    var col=i%2, row=(i/2)|0;
    var cx=startX+col*(cardW+gapX)+cardW/2;
    var cy=startY+row*(cardH+gapY)+cardH/2;
    var ch=FKO.CHARACTERS[i];
    var rect=this.add.rectangle(cx, cy, cardW, cardH, 0x1a2332).setInteractive({useHandCursor:true}).setStrokeStyle(2, 0x2a3a56);
    rect.charIndex=i;
    // mini ragdoll preview: torso+head
    var g=this.add.graphics();
    g.fillStyle(ch.color, 1);
    g.fillRoundedRect(cx-14, cy-10, 28, 24, 4);
    g.fillStyle(0xf5d6b8, 1);
    g.fillCircle(cx, cy-22, 10);
    this.add.text(cx, cy+28, ch.name, {fontFamily:'monospace',fontSize:'11px',color:'#ffffff'}).setOrigin(0.5);
    this.cards.push(rect);
    (function(idx, r){
      r.on('pointerdown', function(){
        self.p1Sel=idx;
        self.updateSelection();
        try{ if(FKO.Sfx) FKO.Sfx.play('block'); }catch(e){}
      });
    })(i, rect);
  }

  this.p1Label=this.add.text(w/2-120, startY+2*(cardH+gapY)+28, '', {fontFamily:'monospace',fontSize:'12px',color:'#4fc3f7'}).setOrigin(0.5);
  this.p2Label=this.add.text(w/2+120, startY+2*(cardH+gapY)+28, '', {fontFamily:'monospace',fontSize:'12px',color:'#ff8a65'}).setOrigin(0.5);

  var btnY=startY+2*(cardH+gapY)+60;
  var btn=this.add.text(w/2, btnY, '\u25B6  START (Enter)', {fontFamily:'monospace',fontSize:'16px',color:'#ffffff',backgroundColor:'#e53935',padding:{x:18,y:8}}).setOrigin(0.5).setInteractive({useHandCursor:true});
  var go=function(){
    var c1=FKO.CHARACTERS[self.p1Sel]||FKO.CHARACTERS[0];
    var c2=FKO.CHARACTERS[self.p2Sel]||FKO.CHARACTERS[1];
    FKO.save.p1CharId=c1.id;
    FKO.save.p2CharId=c2.id;
    try{ if(FKO.Sfx) FKO.Sfx.play('punch'); }catch(e){}
    self.scene.start('StageSelect');
  };
  btn.on('pointerdown', go);
  this.input.keyboard.on('keydown-ENTER', go);
  // second player cycle with 2 key (optional)
  this.input.keyboard.on('keydown-TWO', function(){
    self.p2Sel=(self.p2Sel+1)%FKO.CHARACTERS.length;
    if(self.p2Sel===self.p1Sel) self.p2Sel=(self.p2Sel+1)%FKO.CHARACTERS.length;
    self.updateSelection();
  });

  this.updateSelection();
};
FKO.CharacterSelectScene.prototype.updateSelection=function(){
  for(var i=0;i<this.cards.length;i++){
    var c=this.cards[i];
    if(i===this.p1Sel) c.setStrokeStyle(3, 0x4fc3f7);
    else if(i===this.p2Sel) c.setStrokeStyle(3, 0xff8a65);
    else c.setStrokeStyle(2, 0x2a3a56);
  }
  var c1=FKO.CHARACTERS[this.p1Sel]||FKO.CHARACTERS[0];
  var c2=FKO.CHARACTERS[this.p2Sel]||FKO.CHARACTERS[0];
  this.p1Label.setText('P1: '+c1.name);
  this.p2Label.setText('P2: '+c2.name);
};
})();
