// SC.TacticsScene — 战棋主场景（topdown 回合，选-移-攻-待机）
(function () {
  'use strict';
  var SC = window.SC;
  SC.TacticsScene = function(){ Phaser.Scene.call(this,{key:'Tactics'}); };
  SC.TacticsScene.prototype = Object.create(Phaser.Scene.prototype);
  SC.TacticsScene.prototype.constructor = SC.TacticsScene;
  SC.TacticsScene.prototype.init = function(data){ this.chapterId=(data&&data.chapterId)||SC.currentChapter||1; this.resumeFlag=!!(data&&data.resume); };
  SC.TacticsScene.prototype.create = function(){
    SC.sceneRef=this; SC.currentChapter=this.chapterId;
    var W=this.scale.width, H=this.scale.height;
    this.cameras.main.setBackgroundColor('#0e1628');
    var ch = SC.resolveChapter(this.chapterId);
    if(!ch){ this.scene.start('Start'); return; }
    // 网格与地图
    var tile=SC.CFG.TILE, cols=ch.map[0].length, rows=ch.map.length;
    // 居中
    var mapW=cols*tile, mapH=rows*tile;
    var ox=Math.floor((W-mapW)/2), oy=Math.floor(22 + (H-22 - mapH)/2);
    this.grid = new SC.Grid(ch.map, tile, ox, oy);
    this.mapMgr = new SC.MapManager(ch.map, this.grid); this.mapMgr.draw(this);
    // 单位
    this.units=[];
    var starts = SC.gameState.getRosterList(this.chapterId);
    // 若 variant 额外单位，已在 getRosterList 含；按 placement 落格
    var placements = ch.playerStarts || [];
    var variant = SC.resolveChapter(this.chapterId);
    if(variant && variant.extraUnits) placements = placements.concat(variant.extraUnits);
    for(var i=0;i<starts.length;i++){
      var re=starts[i];
      var chDef = SC.getChar(re.charId);
      var cu = new SC.Character(chDef, re);
      // 找对应 placement
      var pl=null;
      for(var pi=0; pi<placements.length; pi++) if(placements[pi].charId===re.charId) pl=placements[pi];
      if(pl){ cu.c=pl.c; cu.r=pl.r; } else { cu.c= ox ? 2+i : 2+i; cu.r=rows-2; }
      cu.createGO(this, this.grid);
      this.units.push(cu);
    }
    var enemyPlaces = ch.enemyPlacements || [];
    for(var ei=0; ei<enemyPlaces.length; ei++){
      var ep=enemyPlaces[ei];
      var ed=SC.getEnemy(ep.enemyId);
      var lv = ep.lv || (ed.isBoss ? (this.chapterId+1) : this.chapterId);
      var eu=new SC.EnemyUnit(ed, lv, ep.c, ep.r);
      eu.createGO(this, this.grid);
      this.units.push(eu);
    }
    this.turnMgr=new SC.TurnManager(); this.turnMgr.startPlayerPhase(this.units);
    this.battleMgr=new SC.BattleManager(); this.expMgr=new SC.ExpManager();
    this.rangeSys=new SC.RangeSystem(this.grid);
    this.aiSys=new SC.AISystem(this.grid);
    this.skillSys=new SC.SkillSystem();
    this.selected=null; this.actionMenu=null;
    // 光标
    this.cursor = this.add.rectangle(0,0,tile,tile,0x000000,0);
    this.cursor.setStrokeStyle(2, SC.COLORS.SELECT, 1);
    this.cursor.setDepth(12); this.cursor.setVisible(false);
    // HUD
    this.hudBg=this.add.rectangle(W/2,11,W,22,0x111827).setDepth(20);
    this.hudText=this.add.text(10,11,'',{fontSize:'11px', color:'#e6edf3'}).setOrigin(0,0.5).setDepth(21);
    this._updateHud();
    // 输入
    var self=this;
    this.input.on('pointerdown', function(pointer){
      if(self._busy) return;
      var cell=self.grid.worldToCell(pointer.x, pointer.y);
      self._onCellClick(cell);
    });
    this.input.keyboard.on('keydown-ESC', function(){ self._cancel(); });
    this.input.keyboard.on('keydown-SPACE', function(){ if(self.turnMgr.isPlayerPhase() && self.turnMgr.allPlayerActed(self.units)) self._endPlayerPhase(); });
    this.input.keyboard.on('keydown-ENTER', function(){ if(self.turnMgr.isPlayerPhase() && self.turnMgr.allPlayerActed(self.units)) self._endPlayerPhase(); });
    this._toast('回合 '+this.turnMgr.turn+'  玩家阶段  ·  点击单位行动', 1600);
  };
  SC.TacticsScene.prototype._updateHud = function(){
    var ch=SC.resolveChapter(this.chapterId);
    this.hudText.setText('CH'+this.chapterId+' '+ch.title+'  |  回合 '+this.turnMgr.turn+'  '+(this.turnMgr.isPlayerPhase()?'▶ 玩家':'▶ 敌方')+'  |  胜: '+ch.win+'  |  ESC取消  SPACE结束阶段');
  };
  SC.TacticsScene.prototype._toast = function(msg, ms){
    var t=this.add.text(this.scale.width/2, this.scale.height-18, msg, {fontSize:'11px', color:'#e6edf3', backgroundColor:'#111827cc'}).setOrigin(0.5).setDepth(30);
    this.time.delayedCall(ms||1400, function(){ try{t.destroy();}catch(e){} });
  };
  SC.TacticsScene.prototype._onCellClick = function(cell){
    if(!this.grid.inBounds(cell.c,cell.r)) return;
    // 若有行动菜单，先关
    if(this.actionMenu){ this._closeMenu(); }
    // 选单位
    var hit=null;
    for(var i=0;i<this.units.length;i++){ var u=this.units[i]; if(u.c===cell.c&&u.r===cell.r&&u.isAlive()) hit=u; }
    if(hit){
      if(hit.side==='player' && this.turnMgr.isPlayerPhase()){
        if(hit.hasActed){ this._toast('已行动',700); return; }
        this._selectUnit(hit);
        return;
      } else if(hit.side==='enemy'){
        this._showEnemyInfo(hit);
        return;
      }
    }
    // 点移动格
    if(this.selected && this.turnMgr.isPlayerPhase() && !this.selected.hasMoved){
      if(this.rangeSys.isInMove(cell.c,cell.r)){
        this._moveSelected(cell);
        return;
      }
      if(this.rangeSys.isInAttack(cell.c,cell.r)){
        // 攻击目标应在该格
        var tgt=null;
        for(var j=0;j<this.units.length;j++){ var v=this.units[j]; if(v.c===cell.c&&v.r===cell.r&&v.side==='enemy'&&v.isAlive()) tgt=v; }
        if(tgt){ this._attackFromSelected(tgt); return; }
      }
    }
    // 清选
    this._deselect();
  };
  SC.TacticsScene.prototype._selectUnit = function(u){
    this._deselect();
    this.selected=u; u.setSelected(true);
    this.cursor.setVisible(true);
    var p=this.grid.cellToWorld(u.c,u.r); this.cursor.x=p.x; this.cursor.y=p.y;
    this.rangeSys.showMove(this, u, this.units);
    this._toast(u.name+' Lv'+u.level+'  '+u.job+'  HP'+u.hp+'/'+u.maxHp+'  可移动'+u.mov+'格', 1400);
  };
  SC.TacticsScene.prototype._deselect = function(){
    if(this.selected) this.selected.setSelected(false);
    this.selected=null; this.cursor.setVisible(false);
    this.rangeSys.clear(); this._closeMenu();
  };
  SC.TacticsScene.prototype._showEnemyInfo = function(e){
    this._toast(e.name+' Lv'+e.level+'  HP'+e.hp+'/'+e.maxHp+'  攻'+e.atk+' 防'+e.def, 1200);
  };
  SC.TacticsScene.prototype._cancel = function(){
    if(this.actionMenu){ this._closeMenu(); return; }
    this._deselect();
  };
  SC.TacticsScene.prototype._moveSelected = function(cell){
    var self=this;
    var u=this.selected;
    if(!u) return;
    var occ={};
    for(var i=0;i<this.units.length;i++){ var uu=this.units[i]; if(uu===u) continue; if(!uu.isAlive()) continue; occ[uu.c+','+uu.r]=true; }
    var path=SC.findPath(this.grid, {c:u.c,r:u.r}, cell, occ);
    if(!path) return;
    this._busy=true;
    this.rangeSys.clear();
    // tween 单步
    var idx=0;
    var step=function(){
      idx++;
      if(idx>=path.length){
        u.c=cell.c; u.r=cell.r; u.hasMoved=true;
        self._busy=false;
        self._showPostMoveMenu();
        return;
      }
      var nxt=path[idx];
      var pos=self.grid.cellToWorld(nxt.c,nxt.r);
      self.tweens.add({ targets:u.go, x:pos.x, y:pos.y, duration: SC.CFG.MOVE_TWEEN_MS / (SC.gameState.settings.animSpeed||1), onComplete:function(){
        u.c=nxt.c; u.r=nxt.r; u.go.setDepth(10+nxt.r);
        step();
      }});
    };
    step();
  };
  SC.TacticsScene.prototype._showPostMoveMenu = function(){
    var self=this;
    var u=this.selected; if(!u) return;
    // 可攻击目标
    var targets=[];
    for(var i=0;i<this.units.length;i++){ var e=this.units[i]; if(e.side!=='enemy'||!e.isAlive()) continue; var d=Math.abs(u.c-e.c)+Math.abs(u.r-e.r); if(d<=u.range && d>0) targets.push(e); }
    var acts=[];
    if(targets.length) acts.push({label:'攻击 ('+targets.length+')', cb:function(){ self._chooseAttackTarget(targets); }});
    // 技能（若有可攻击技能且范围内有目标）
    var skills=self.skillSys.activeSkills(u);
    var skillActs=[];
    for(var si=0; si<skills.length; si++){
      var sk=skills[si]; if(sk.power<0) continue;
      for(var ti=0; ti<targets.length; ti++) if(self.skillSys.canUse(u, sk.id, targets[ti])){ skillActs.push({label:sk.name, skillId:sk.id}); break; }
    }
    if(skillActs.length) for(var k2=0;k2<skillActs.length;k2++) (function(sa){ acts.push({label:'技能:'+SC.getSkill(sa.skillId).name, cb:function(){ self._chooseAttackTarget(targets, sa.skillId); }}); })(skillActs[k2]);
    // 治愈（若为僧侣/主教）
    if(u.job==='cleric' || u.job==='bishop'){
      var healSk = u.skills.indexOf('heal')!==-1 ? SC.getSkill('heal') : null;
      if(healSk){
        var allies=[];
        for(var ai=0;ai<self.units.length;ai++){ var a=self.units[ai]; if(a.side!=='player'||!a.isAlive()||a===u) continue; var dd=Math.abs(u.c-a.c)+Math.abs(u.r-a.r); if(dd<=healSk.range) allies.push(a); }
        if(allies.length) acts.push({label:'治愈', cb:function(){ self._healTarget(allies, 'heal'); }});
      }
    }
    acts.push({label:'待机', cb:function(){ self._endUnitTurn(); }});
    // 转职
    if(u.canPromoteNow(self.chapterId)){
      var opts=SC.canPromote(u,self.chapterId);
      for(var pi=0; pi<opts.length; pi++) (function(o){ acts.push({label:'转职→'+SC.getClass(o.to).name, cb:function(){ u.doPromote(o.to); self._toast(u.name+' 转职为 '+SC.getClass(o.to).name+'！',1400); if(SC.Sfx) SC.Sfx.play('levelup'); self._endUnitTurn(); }}); })(opts[pi]);
    }
    this._openMenu(acts);
  };
  SC.TacticsScene.prototype._chooseAttackTarget = function(targets, skillId){
    var self=this;
    if(targets.length===1){ self._attackFromSelected(targets[0], skillId); return; }
    // 简易：选最近
    self._toast('点击敌方选择目标', 1100);
    var handler=function(pointer){
      var cell=self.grid.worldToCell(pointer.x, pointer.y);
      for(var i=0;i<targets.length;i++) if(targets[i].c===cell.c&&targets[i].r===cell.r){ self.input.off('pointerdown', handler); self._attackFromSelected(targets[i], skillId); return; }
    };
    this.input.on('pointerdown', handler);
  };
  SC.TacticsScene.prototype._healTarget = function(allies, skillId){
    var self=this;
    if(allies.length===1){ self._doHeal(allies[0], skillId); return; }
    self._toast('点击我方选择治愈目标', 1100);
    var handler=function(pointer){
      var cell=self.grid.worldToCell(pointer.x, pointer.y);
      for(var i=0;i<allies.length;i++) if(allies[i].c===cell.c&&allies[i].r===cell.r){ self.input.off('pointerdown', handler); self._doHeal(allies[i], skillId); return; }
    };
    this.input.on('pointerdown', handler);
  };
  SC.TacticsScene.prototype._doHeal = function(target, skillId){
    var self=this; var u=this.selected;
    var sk=SC.getSkill(skillId);
    // 切独立战斗演出（治愈）
    this.scene.launch('Battle', { atk:u, def:target, grid:this.grid, skillId:skillId, tacticsScene:this });
    this.scene.pause();
    // Battle 会回调 onBattleDone
    this._pendingHeal={ atk:u, def:target, skillId:skillId };
  };
  SC.TacticsScene.prototype._attackFromSelected = function(target, skillId){
    var u=this.selected; if(!u) return;
    // 切独立战斗演出
    this.scene.launch('Battle', { atk:u, def:target, grid:this.grid, skillId:skillId, tacticsScene:this });
    this.scene.pause();
    this._pendingAttack={ atk:u, def:target, skillId:skillId };
  };
  SC.TacticsScene.prototype.onBattleDone = function(result){
    var pending=this._pendingAttack || this._pendingHeal;
    this._pendingAttack=null; this._pendingHeal=null;
    // result 由 BattleScene 写入（hit/killed/exp/levelUp 等）
    if(pending && pending.def){
      // 若治愈，已在 Battle 中 heal，此处给施法者经验
      if(pending.atk && result && result.heal){
        this.expMgr.applyExp(pending.atk, result.exp||10, function(unit, before){
          if(SC.Sfx) SC.Sfx.play('levelup');
        });
      } else if(pending.atk && result){
        if(result.hit && result.exp) this.expMgr.applyExp(pending.atk, result.exp, function(unit, before){ if(SC.Sfx) SC.Sfx.play('levelup'); });
        if(result.counter && result.counterExp) this.expMgr.applyExp(pending.def, result.counterExp, function(unit, before){ if(SC.Sfx) SC.Sfx.play('levelup'); });
      }
      // 死亡单位隐藏
      if(pending.def && !pending.def.isAlive() && pending.def.go){ pending.def.go.setVisible(false); }
      if(pending.atk && !pending.atk.isAlive() && pending.atk.go){ pending.atk.go.setVisible(false); }
      if(result && result.counterKilled && result.counterTarget && result.counterTarget.go) result.counterTarget.go.setVisible(false);
    }
    // 单位行动结束
    if(this.selected) this.selected.hasActed=true;
    this._deselect();
    this._checkWinLose();
    if(this.scene.isPaused()) this.scene.resume();
  };
  SC.TacticsScene.prototype._endUnitTurn = function(){
    if(this.selected) this.selected.hasActed=true;
    this._deselect();
    this._checkWinLose();
  };
  SC.TacticsScene.prototype._openMenu = function(acts){
    this._closeMenu();
    var W=this.scale.width, H=this.scale.height;
    var cont=this.add.container(W-110, H/2).setDepth(25);
    var bg=this.add.rectangle(0,0,120, acts.length*32+16, 0x0e1628, 0.96);
    bg.setStrokeStyle(1,0x2a3a56,1);
    cont.add(bg);
    for(var i=0;i<acts.length;i++){
      (function(a, idx){
        var y = -acts.length*16 + 16 + idx*32;
        var b=cont.scene.add.rectangle(0,y,104,26,0x2a3a56).setInteractive({useHandCursor:true});
        var t=cont.scene.add.text(0,y,a.label,{fontSize:'11px', color:'#e6edf3'}).setOrigin(0.5);
        cont.add([b,t]);
        b.on('pointerdown', a.cb);
        b.on('pointerover', function(){b.fillColor=0x34495e;});
        b.on('pointerout', function(){b.fillColor=0x2a3a56;});
      })(acts[i], i);
    }
    this.actionMenu=cont;
  };
  SC.TacticsScene.prototype._closeMenu = function(){ if(this.actionMenu) try{this.actionMenu.destroy();}catch(e){} this.actionMenu=null; };
  SC.TacticsScene.prototype._endPlayerPhase = function(){
    if(!this.turnMgr.isPlayerPhase()) return;
    this.turnMgr.startEnemyPhase(this.units);
    this._updateHud(); this._deselect();
    // AI 依次
    var self=this; this._busy=true;
    this.aiSys.takeTurn(this.units, this.battleMgr, function(action){
      return new Promise(function(resolve){
        if(action.type==='attack'){
          self._aiAttack(action.from, action.to, resolve);
        } else if(action.type==='moveAttack'){
          self._aiMoveAttack(action.from, action.path, action.to, resolve);
        } else if(action.type==='move'){
          self._aiMove(action.from, action.path, resolve);
        } else resolve();
      });
    }).then(function(){
      self._busy=false;
      self.turnMgr.nextTurn(self.units);
      self._updateHud();
      self._checkWinLose();
    });
  };
  SC.TacticsScene.prototype._aiAttack = function(from, to, done){
    var self=this;
    self.scene.launch('Battle', { atk:from, def:to, grid:self.grid, tacticsScene:self });
    self.scene.pause();
    self._pendingAttack={ atk:from, def:to };
    // 拦截 onBattleDone 的 resume，由 _aiAttack 的 done 接管
    var orig=self.onBattleDone;
    var wrapped=function(result){
      orig.call(self, result);
      done();
    };
    self._aiBattleDone=wrapped;
  };
  SC.TacticsScene.prototype._aiMove = function(from, path, done){
    var self=this;
    if(!path||path.length<2){ done(); return; }
    var idx=0;
    var step=function(){
      idx++;
      if(idx>=path.length){ from.c=path[idx-1].c; from.r=path[idx-1].r; done(); return; }
      var nxt=path[idx];
      var pos=self.grid.cellToWorld(nxt.c,nxt.r);
      self.tweens.add({ targets:from.go, x:pos.x, y:pos.y, duration: SC.CFG.MOVE_TWEEN_MS/(SC.gameState.settings.animSpeed||1), onComplete:function(){ from.c=nxt.c; from.r=nxt.r; from.go.setDepth(10+nxt.r); step(); }});
    };
    step();
  };
  SC.TacticsScene.prototype._aiMoveAttack = function(from, path, to, done){
    var self=this;
    self._aiMove(from, path, function(){
      self._aiAttack(from, to, done);
    });
  };
  SC.TacticsScene.prototype._checkWinLose = function(){
    var aliveBoss=false, aliveEnemy=false, alivePlayer=false;
    for(var i=0;i<this.units.length;i++){
      var u=this.units[i];
      if(!u.isAlive()) continue;
      if(u.side==='enemy'){ aliveEnemy=true; if(u.isBoss) aliveBoss=true; }
      if(u.side==='player') alivePlayer=true;
    }
    if(!alivePlayer){
      this._lose();
      return;
    }
    if(!aliveBoss && !aliveEnemy){
      this._win();
      return;
    }
    if(!aliveBoss){
      // Boss 死即胜（即使有小兵）
      this._win();
    }
  };
  SC.TacticsScene.prototype._win = function(){
    if(this._ended) return; this._ended=true;
    if(SC.Sfx) SC.Sfx.play('victory');
    // 存盘前：同 roster
    for(var i=0;i<this.units.length;i++){ var u=this.units[i]; if(u.side==='player'&&u.syncToRoster) u.syncToRoster(); }
    if(SC.gameState.settings.autoSave) SC.saveMgr.setAutosave(SC.gameState);
    var self=this;
    this.time.delayedCall(520, function(){
      // 中场 AVG（若有），否则直接 after
      var ch=SC.resolveChapter(self.chapterId);
      if(ch.avgMid && ch.avgMid.length){
        self.scene.start('Avg', { chapterId:self.chapterId, phase:'mid', onDone:function(){ self.scene.start('Avg', { chapterId:self.chapterId, phase:'after' }); } });
      } else {
        self.scene.start('Avg', { chapterId:self.chapterId, phase:'after' });
      }
    });
  };
  SC.TacticsScene.prototype._lose = function(){
    if(this._ended) return; this._ended=true;
    if(SC.Sfx) SC.Sfx.play('defeat');
    var W=this.scale.width, H=this.scale.height;
    var bg=this.add.rectangle(W/2,H/2,W,H,0x000000,0.62).setDepth(40);
    this.add.text(W/2,H/2-22,'败北',{fontSize:'28px', color:'#e74c3c', fontStyle:'bold'}).setOrigin(0.5).setDepth(41);
    var self=this;
    var b1=this.add.rectangle(W/2,H/2+28,140,32,0x2a3a56).setDepth(41).setInteractive({useHandCursor:true});
    this.add.text(W/2,H/2+28,'重试',{fontSize:'13px', color:'#e6edf3'}).setOrigin(0.5).setDepth(42);
    b1.on('pointerdown', function(){ self.scene.restart({chapterId:self.chapterId}); });
    var b2=this.add.rectangle(W/2,H/2+68,140,32,0x2a3a56).setDepth(41).setInteractive({useHandCursor:true});
    this.add.text(W/2,H/2+68,'返回',{fontSize:'13px', color:'#e6edf3'}).setOrigin(0.5).setDepth(42);
    b2.on('pointerdown', function(){ self.scene.start('Start'); });
  };
  // Battle 回调分发（AI 路径也会走这里，AI 已包装）
  SC.TacticsScene.prototype.onBattleResult = function(result){
    if(this._aiBattleDone){ var fn=this._aiBattleDone; this._aiBattleDone=null; fn(result); return; }
    this.onBattleDone(result);
  };
})();
