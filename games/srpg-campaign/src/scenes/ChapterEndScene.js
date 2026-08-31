// SC.ChapterEndScene — 章节结算/终章
(function () {
  'use strict';
  var SC = window.SC;
  SC.ChapterEndScene = function(){ Phaser.Scene.call(this,{key:'ChapterEnd'}); };
  SC.ChapterEndScene.prototype = Object.create(Phaser.Scene.prototype);
  SC.ChapterEndScene.prototype.constructor = SC.ChapterEndScene;
  SC.ChapterEndScene.prototype.init = function(data){ this.chapterId=data.chapterId; this.isFinal=!!data.isFinal; };
  SC.ChapterEndScene.prototype.create = function(){
    var W=this.scale.width, H=this.scale.height;
    this.cameras.main.setBackgroundColor('#0e1628');
    this.add.text(W/2, 52, this.isFinal ? '通关' : '章节完成', {fontSize:'26px', color:this.isFinal?'#f1c40f':'#2ecc71', fontStyle:'bold'}).setOrigin(0.5);
    var ch=SC.CHAPTERS[this.chapterId-1];
    this.add.text(W/2, 82, ch ? ch.title : ('CH'+this.chapterId), {fontSize:'13px', color:'#e6edf3'}).setOrigin(0.5);
    // 存活/等级概览
    var roster=SC.gameState.roster;
    var y=118;
    for(var k in roster){
      var re=roster[k];
      var chDef=SC.getChar(k);
      var name = chDef ? chDef.name : k;
      this.add.text(W/2-180, y, name+' Lv'+re.level+'  HP'+re.hp+'/'+re.maxHp+'  攻'+re.atk+' 防'+re.def+' 技['+(re.skills||[]).join(',')+']', {fontSize:'10px', color:'#8b949e'});
      y+=16;
    }
    if(this.isFinal){
      var txt = (SC.gameState.flags.route==='A' ? '路线A 山道结局' : (SC.gameState.flags.route==='B' ? '路线B 密林结局' : ''));
      var allied=0; if(SC.gameState.flags.recruitValdris) allied++; if(SC.gameState.flags.recruitShade) allied++;
      var ending = allied>=2 ? '真结局：群星之誓' : '通常结局：孤星之誓';
      this.add.text(W/2, y+18, txt+'  ·  '+ending, {fontSize:'12px', color:'#f1c40f', fontStyle:'bold'}).setOrigin(0.5);
      this.add.text(W/2, y+40, '可回章节选择重走另一条分支，解锁更多角色与转职。', {fontSize:'11px', color:'#6e7681'}).setOrigin(0.5);
    } else {
      this.add.text(W/2, y+12, '已解锁下一章。可继续或回菜单分歧重走。', {fontSize:'11px', color:'#6e7681'}).setOrigin(0.5);
    }
    var self=this;
    function btn(yy,label,cb){
      var bg=self.add.rectangle(W/2,yy,200,36,0x2a3a56).setInteractive({useHandCursor:true});
      var tx=self.add.text(W/2,yy,label,{fontSize:'13px', color:'#e6edf3'}).setOrigin(0.5);
      bg.on('pointerdown', cb);
      bg.on('pointerover', function(){bg.fillColor=0x34495e;}); bg.on('pointerout', function(){bg.fillColor=0x2a3a56;});
    }
    if(this.isFinal){
      btn(H-86,'返回开始', function(){ self.scene.start('Start'); });
      btn(H-44,'章节选择', function(){ self.scene.start('SaveLoad',{mode:'chapter'}); });
    } else {
      var nextId=SC.gameState.chapterId;
      btn(H-86,'下一章', function(){ SC.currentChapter=nextId; self.scene.start('Avg',{chapterId:nextId, phase:'before'}); });
      btn(H-44,'返回开始', function(){ self.scene.start('Start'); });
    }
    // 同步旗帜
    SC.flags = SC.gameState.flags;
  };
})();
