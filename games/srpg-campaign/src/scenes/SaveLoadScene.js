// SC.SaveLoadScene — 存档/读档 + 章节选择
(function () {
  'use strict';
  var SC = window.SC;
  SC.SaveLoadScene = function(){ Phaser.Scene.call(this,{key:'SaveLoad'}); };
  SC.SaveLoadScene.prototype = Object.create(Phaser.Scene.prototype);
  SC.SaveLoadScene.prototype.constructor = SC.SaveLoadScene;
  SC.SaveLoadScene.prototype.init = function(data){ this.mode=(data&&data.mode)||'load'; };
  SC.SaveLoadScene.prototype.create = function(){
    var W=this.scale.width, H=this.scale.height;
    this.cameras.main.setBackgroundColor('#0e1628');
    var title = this.mode==='chapter' ? '章节选择（分歧重走）' : (this.mode==='save' ? '存档' : '读档');
    this.add.text(W/2, 26, title, {fontSize:'18px', color:'#e6edf3', fontStyle:'bold'}).setOrigin(0.5);
    var self=this;
    if(this.mode==='chapter'){
      // 章节卡片
      var cols=3, cw=260, ch=120, gap=14, sx=(W-(cols*cw+(cols-1)*gap))/2, sy=62;
      for(var i=0;i<SC.CHAPTERS.length;i++){
        (function(ch, idx){
          var c=idx%cols, r=Math.floor(idx/cols);
          var x=sx+c*(cw+gap), y=sy+r*(ch+gap);
          var can = SC.chapterMgr ? SC.chapterMgr.canPlay(ch.id) : (idx===0);
          var bg=self.add.rectangle(x+cw/2,y+ch/2,cw,ch, can?0x1a2332:0x111827);
          bg.setStrokeStyle(1, can?0x2a3a56:0x1a2332,1);
          if(can) bg.setInteractive({useHandCursor:true});
          self.add.text(x+10,y+10,'CH'+ch.id+'  '+ch.title,{fontSize:'12px', color:can?'#e6edf3':'#484f58', fontStyle:'bold'});
          self.add.text(x+10,y+30,ch.desc,{fontSize:'10px', color:can?'#8b949e':'#484f58'});
          var cleared = SC.gameState && SC.gameState.cleared[ch.id];
          self.add.text(x+10,y+70, cleared?'已通关':'', {fontSize:'10px', color:'#2ecc71'});
          if(can) bg.on('pointerdown', function(){ SC.gameState.chapterId=ch.id; SC.currentChapter=ch.id; SC.sceneRef=self; self.scene.start('Avg',{chapterId:ch.id, phase:'before'}); });
          else self.add.text(x+cw/2,y+ch/2+12,'🔒 未解锁',{fontSize:'11px', color:'#484f58'}).setOrigin(0.5).setAlpha(0.6);
        })(SC.CHAPTERS[i], i);
      }
    } else {
      // 槽位
      var isSave=this.mode==='save';
      self.add.text(W/2, 56, isSave?'选择槽位保存当前进度':'选择槽位读取',{fontSize:'11px', color:'#6e7681'}).setOrigin(0.5);
      for(var s=0;s<3;s++){
        (function(idx){
          var y=92+idx*88;
          var slot=SC.saveMgr.slots[idx];
          var bg=self.add.rectangle(W/2,y,520,72, slot?0x1a2332:0x111827).setInteractive({useHandCursor:true});
          bg.setStrokeStyle(1, slot?0x2a3a56:0x1a2332,1);
          var label = slot ? ('槽 '+(idx+1)+'  ·  CH'+slot.chapterId+'  ·  '+new Date(slot.at).toLocaleString()) : ('槽 '+(idx+1)+'  ·  空');
          self.add.text(W/2-246,y-16,label,{fontSize:'11px', color:slot?'#e6edf3':'#484f58'});
          if(slot){
            var flagsTxt = JSON.stringify(slot.flags);
            if(flagsTxt.length>64) flagsTxt=flagsTxt.slice(0,64)+'…';
            self.add.text(W/2-246,y+8,flagsTxt,{fontSize:'9px', color:'#6e7681'});
          }
          var actTxt = isSave ? '保存' : (slot?'读取':'空');
          var ab=self.add.rectangle(W/2+190,y,72,28, isSave||slot?0x2a3a56:0x1a2332).setInteractive(isSave||slot?{useHandCursor:true}:{});
          self.add.text(W/2+190,y,actTxt,{fontSize:'11px', color:isSave||slot?'#e6edf3':'#484f58'}).setOrigin(0.5);
          bg.on('pointerdown', function(){
            if(isSave){
              SC.saveMgr.saveSlot(idx, SC.gameState);
              self.add.text(W/2,y+30,'已保存',{fontSize:'11px', color:'#2ecc71'}).setOrigin(0.5);
              if(SC.Sfx) SC.Sfx.play('heal');
              self.time.delayedCall(600, function(){ self.scene.restart({mode:'save'}); });
            } else if(slot){
              var g=SC.saveMgr.loadSlot(idx);
              if(g){ SC.gameState=g; SC.flags=g.flags; SC.currentChapter=g.chapterId; SC.chapterMgr.state=g; SC.sceneRef=self; self.scene.start('Avg',{chapterId:g.chapterId, phase:'before'}); }
            }
          });
          if(isSave||slot){
            ab.on('pointerdown', function(){
              if(isSave){ SC.saveMgr.saveSlot(idx, SC.gameState); self.scene.restart({mode:'save'}); }
              else if(slot){ var g2=SC.saveMgr.loadSlot(idx); if(g2){ SC.gameState=g2; SC.flags=g2.flags; SC.currentChapter=g2.chapterId; SC.chapterMgr.state=g2; SC.sceneRef=self; self.scene.start('Avg',{chapterId:g2.chapterId, phase:'before'}); } }
            });
          }
        })(s);
      }
      // 自动存档行
      if(SC.saveMgr.autosave){
        var a=SC.saveMgr.autosave;
        self.add.text(W/2, 92+3*88+10, '自动存档  ·  CH'+a.chapterId+'  ·  '+new Date(a.at).toLocaleString()+'  (点击读取)', {fontSize:'10px', color:'#8b949e'}).setOrigin(0.5).setInteractive({useHandCursor:true}).on('pointerdown', function(){
          var g=SC.GameState.fromJSON(a); SC.gameState=g; SC.flags=g.flags; SC.currentChapter=g.chapterId; SC.chapterMgr.state=g; SC.sceneRef=self; self.scene.start('Avg',{chapterId:g.chapterId, phase:'before'});
        });
      }
    }
    var back=self.add.rectangle(W/2,H-26,140,32,0x2a3a56).setInteractive({useHandCursor:true});
    self.add.text(W/2,H-26,'返回',{fontSize:'13px', color:'#e6edf3'}).setOrigin(0.5);
    back.on('pointerdown', function(){ self.scene.start('Start'); });
    back.on('pointerover', function(){back.fillColor=0x34495e;}); back.on('pointerout', function(){back.fillColor=0x2a3a56;});
    // 快捷：存档模式也可切换到读档
    if(this.mode==='save'){
      var sw=self.add.text(W-16,26,'切换到读档',{fontSize:'10px', color:'#8b949e'}).setOrigin(1,0.5).setInteractive({useHandCursor:true});
      sw.on('pointerdown', function(){ self.scene.start('SaveLoad',{mode:'load'}); });
    } else if(this.mode==='load'){
      var sw2=self.add.text(W-16,26,'切换到存档',{fontSize:'10px', color:'#8b949e'}).setOrigin(1,0.5).setInteractive({useHandCursor:true});
      sw2.on('pointerdown', function(){ self.scene.start('SaveLoad',{mode:'save'}); });
    }
  };
})();
