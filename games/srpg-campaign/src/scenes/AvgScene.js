// SC.AvgScene — AVG 叙事（开幕/穿插/收尾，含分歧选择，类似 SRW）
(function () {
  'use strict';
  var SC = window.SC;
  SC.AvgScene = function(){ Phaser.Scene.call(this,{key:'Avg'}); };
  SC.AvgScene.prototype = Object.create(Phaser.Scene.prototype);
  SC.AvgScene.prototype.constructor = SC.AvgScene;
  SC.AvgScene.prototype.init = function(data){
    this.chapterId = (data&&data.chapterId)||SC.currentChapter||1;
    this.phase = (data&&data.phase)||'before'; // before/mid/after
    this.onDone = (data&&data.onDone)||null;
  };
  SC.AvgScene.prototype.create = function(){
    SC.sceneRef = this;
    var ch = SC.resolveChapter(this.chapterId);
    if(!ch){ this.scene.start('Start'); return; }
    var nodes=[];
    if(this.phase==='before') nodes = ch.avgBefore || ch.variants ? (SC.resolveChapter(this.chapterId).avgBefore||[]) : ch.avgBefore||[];
    else if(this.phase==='mid') nodes = ch.avgMid || [];
    else if(this.phase==='after') nodes = ch.avgAfter || [];
    // 过滤 cond
    var filtered=[];
    for(var i=0;i<nodes.length;i++){
      var n=nodes[i];
      if(n.choices){ filtered.push(n); continue; }
      if(n.cond && !SC.chapterMgr.testCond(n.cond)) continue;
      // setFlag 预处理：若本行含 setFlag 且 cond 已过，则先置旗
      filtered.push(n);
    }
    if(!filtered.length){
      this._proceed();
      return;
    }
    this.nodes = filtered; this.idx = 0;
    this._buildUI();
    this._show(0);
  };
  SC.AvgScene.prototype._buildUI = function(){
    var W=this.scale.width, H=this.scale.height;
    this.cameras.main.setBackgroundColor('#0e1628');
    this.bgRect = this.add.rectangle(W/2,H/2,W,H,0x1a2332).setDepth(0);
    this.nameText = this.add.text(28, H-132, '', {fontSize:'13px', color:'#f1c40f', fontStyle:'bold'}).setDepth(2);
    this.bodyText = this.add.text(28, H-108, '', {fontSize:'13px', color:'#e6edf3', wordWrap:{width:W-56}}).setDepth(2);
    this.hint = this.add.text(W-18, H-18, '点击继续 ▶', {fontSize:'10px', color:'#6e7681'}).setOrigin(1,1).setDepth(2);
    this.choiceGroup = this.add.container(W/2, H/2).setDepth(4).setVisible(false);
    // 输入
    var self=this;
    this.input.on('pointerdown', function(){ self._advance(); });
    this.input.keyboard.on('keydown-SPACE', function(){ self._advance(); });
    this.input.keyboard.on('keydown-ENTER', function(){ self._advance(); });
  };
  SC.AvgScene.prototype._show = function(i){
    var n=this.nodes[i];
    if(!n){ this._proceed(); return; }
    // choices 节点
    if(n.choices){
      this.choiceGroup.setVisible(true);
      this.choiceGroup.removeAll(true);
      this.hint.setVisible(false);
      this.nameText.setText('选择');
      this.bodyText.setText('你的决定将改变后续章节与加入角色。');
      var self=this;
      for(var ci=0;ci<n.choices.length;ci++){
        (function(ch, idx){
          var y = -28 + idx*44;
          var bg=self.add.rectangle(0,y,420,36,0x2a3a56).setInteractive({useHandCursor:true});
          var tx=self.add.text(0,y,ch.text,{fontSize:'12px', color:'#e6edf3'}).setOrigin(0.5);
          self.choiceGroup.add([bg,tx]);
          bg.on('pointerdown', function(){
            // 置旗
            if(ch.setFlag) for(var k in ch.setFlag){ SC.gameState.flags[k]=ch.setFlag[k]; SC.flags[k]=ch.setFlag[k]; }
            SC.saveMgr._persist();
            self.choiceGroup.setVisible(false); self.hint.setVisible(true);
            self.idx++; self._show(self.idx);
          });
          bg.on('pointerover', function(){bg.fillColor=0x34495e;});
          bg.on('pointerout', function(){bg.fillColor=0x2a3a56;});
        })(n.choices[ci], ci);
      }
      return;
    }
    // 普通行
    if(n.bg) this.bgRect.fillColor = parseInt(n.bg.replace('#','0x'),16) || 0x1a2332;
    this.nameText.setText(n.speaker || '');
    var txt = n.text || '';
    // 旗帜条件文本内插：若含管线则已过滤
    this.bodyText.setText(txt);
    if(n.setFlag) for(var k2 in n.setFlag){ SC.gameState.flags[k2]=n.setFlag[k2]; SC.flags[k2]=n.setFlag[k2]; }
    if(n.type==='narration'){ this.nameText.setColor('#8b949e'); } else { this.nameText.setColor('#f1c40f'); }
  };
  SC.AvgScene.prototype._advance = function(){
    if(this.choiceGroup && this.choiceGroup.visible) return;
    this.idx++;
    if(this.idx >= this.nodes.length) this._proceed();
    else this._show(this.idx);
  };
  SC.AvgScene.prototype._proceed = function(){
    SC.saveMgr._persist();
    if(this.onDone){ this.onDone(); return; }
    var self=this;
    if(this.phase==='before'){
      self.scene.start('Tactics', { chapterId: self.chapterId });
    } else if(this.phase==='mid'){
      // 中场 AVG 后返回 Tactics（由 Tactics 触发）
      self.scene.start('Tactics', { chapterId: self.chapterId, resume:true });
    } else if(this.phase==='after'){
      // 章节结束，自动存档并进结算
      if(SC.gameState.settings.autoSave) SC.saveMgr.setAutosave(SC.gameState);
      var ch = SC.CHAPTERS[self.chapterId-1];
      if(self.chapterId >= SC.CHAPTERS.length){
        self.scene.start('ChapterEnd', { chapterId:self.chapterId, isFinal:true });
      } else {
        SC.chapterMgr.advance();
        SC.currentChapter = SC.gameState.chapterId;
        self.scene.start('ChapterEnd', { chapterId:self.chapterId, isFinal:false });
      }
    }
  };
})();
