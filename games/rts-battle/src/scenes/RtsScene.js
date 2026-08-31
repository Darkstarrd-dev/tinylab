// RS.RtsScene — 单场景 RTS 主战场
(function () {
  'use strict';
  var RS = window.RS;
  RS.RtsScene = function(){ Phaser.Scene.call(this,{key:'Rts'}); };
  RS.RtsScene.prototype = Object.create(Phaser.Scene.prototype);
  RS.RtsScene.prototype.constructor = RS.RtsScene;
  RS.RtsScene.prototype.init=function(data){ this.seed=(data&&data.seed!=null)?data.seed:RS.state.seed; };
  RS.RtsScene.prototype.create=function(){
    RS.sceneRef=this;
    var W=this.scale.width, H=this.scale.height;
    this.cameras.main.setBackgroundColor('#0e1628');
    // 世界尺寸（按地图推算，超出视口可平移）
    var gen=RS.RandomMap.generate(this.seed);
    this.mapRows=gen.map; this.resPlacements=gen.resources;
    this.state=RS.state; this.state.units=[]; this.state.buildings=[]; this.state.resources=[];
    // 网格与地图（世界坐标原点 0,22）
    var tile=RS.MAP_CFG.tile;
    this.grid=new RS.Grid(this.mapRows, tile, 0, 22);
    this.mapMgr=new RS.MapManager(this.mapRows, this.grid); this.mapMgr.draw(this);
    // 实现世界相机：用主相机 scroll 模拟（W/H 视口，世界 1584x1080）
    this.worldW=this.grid.cols*tile; this.worldH=this.grid.rows*tile+22;
    this.cameras.main.setBounds(0,0,this.worldW,this.worldH);
    this.cameras.main.setScroll(0,0);
    // 资源
    this.resources=[];
    for(var ri=0;ri<this.resPlacements.length;ri++){
      var rp=this.resPlacements[ri];
      var res=new RS.Resource(rp.type, rp.c, rp.r, rp.amount);
      res.createGO(this, this.grid);
      this.resources.push(res);
    }
    // 单位/建筑
    this.units=[]; this.buildings=[];
    this._spawnInitial();
    // 管理器/系统
    this.selection=new RS.SelectionManager(this);
    this.economy=new RS.EconomyManager(this.state);
    this.aiMgr=new RS.AIManager(this);
    this.movement=new RS.MovementSystem(this);
    this.combat=new RS.CombatSystem(this);
    this.gathering=new RS.GatheringSystem(this);
    this.fogOfWar=new RS.FogOfWar(this.grid.cols, this.grid.rows);
    this.fogSystem=new RS.FogSystem(this, this.grid, this.fogOfWar);
    // 迷雾初始揭示（基地周边）
    this.fogSystem.revealFromUnits(this.units, this.buildings);
    // HUD
    this._buildHud();
    // 输入：左键点/拖框选，右键移动/攻击/采集，中键拖相机
    var self=this;
    this.input.on('pointerdown', function(pointer){
      if(pointer.button===1 || pointer.middleButtonDown()){ self._dragCamStart={x:pointer.x, y:pointer.y, sx:self.cameras.main.scrollX, sy:self.cameras.main.scrollY}; return; }
      if(pointer.rightButtonDown()){
        // 右键：对选中单位发指令
        var world=self.cameras.main.getWorldPoint(pointer.x, pointer.y);
        self._orderMove(world.x, world.y);
        return;
      }
      // 左键：若点中单位则选中
      var worldL=self.cameras.main.getWorldPoint(pointer.x, pointer.y);
      var cell=self.grid.worldToCell(worldL.x, worldL.y);
      var hit=self._pickUnitAt(worldL.x, worldL.y);
      var hitBuilding=self._pickBuildingAt(worldL.x, worldL.y);
      if(hit){
        if(pointer.event && pointer.event.shiftKey) self.selection.add(hit);
        else self.selection.selectOne(hit);
      } else if(hitBuilding){
        self._onBuildingPicked(hitBuilding);
      } else {
        self.selection._dragStart={x:worldL.x, y:worldL.y};
      }
    });
    this.input.on('pointermove', function(pointer){
      if(self._dragCamStart){
        var dx=pointer.x - self._dragCamStart.x;
        var dy=pointer.y - self._dragCamStart.y;
        self.cameras.main.setScroll(self._dragCamStart.sx - dx, self._dragCamStart.sy - dy);
        self.cameras.main.scrollX=Math.max(0,Math.min(self.cameras.main.scrollX, self.worldW - W));
        self.cameras.main.scrollY=Math.max(0,Math.min(self.cameras.main.scrollY, self.worldH - H));
        return;
      }
      if(self.selection._dragStart){
        var cur=self.cameras.main.getWorldPoint(pointer.x, pointer.y);
        self.selection.drawBox(self.selection._dragStart.x, self.selection._dragStart.y, cur.x, cur.y);
      }
    });
    this.input.on('pointerup', function(pointer){
      if(self._dragCamStart){ self._dragCamStart=null; return; }
      if(self.selection._dragStart){
        var end=self.cameras.main.getWorldPoint(pointer.x, pointer.y);
        self.selection.boxSelect(self.selection._dragStart.x, self.selection._dragStart.y, end.x, end.y, self.units);
        self.selection.clearBox(); self.selection._dragStart=null;
        return;
      }
    });
    // 阻止右键菜单
    this.input.mouse.disableContextMenu();
    // 键盘相机
    this.cursors=this.input.keyboard.createCursorKeys();
    this.wasd=this.input.keyboard.addKeys('W,A,S,D');
    this.escKey=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.spaceKey=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.escKey.on('down', function(){ self.scene.start('Start'); });
    // 小地图（右下 160x110）
    this._buildMinimap();
    this._toast('左键框选  右键移动/攻击/采集  中键拖动相机  WASD平移', 2000);
  };
  RS.RtsScene.prototype._spawnInitial=function(){
    // 我方基地+3工兵
    var b0=new RS.Building(RS.getBuildingDef('base'), 'player', 2, 2); b0.createGO(this,this.grid); this.buildings.push(b0);
    this.state.popCap+=8;
    for(var i=0;i<3;i++){
      var u=new RS.Unit(RS.getUnitDef('worker'), 'player', 0,0); u.setCell(5+i, 4, this.grid); u.createGO(this,this.grid); this.units.push(u); this.state.pop++;
    }
    // 敌方基地+2工兵+1步兵
    var be=new RS.Building(RS.getBuildingDef('base'), 'enemy', this.grid.cols-4, this.grid.rows-4); be.createGO(this,this.grid); this.buildings.push(be);
    for(var j=0;j<2;j++){ var ue=new RS.Unit(RS.getUnitDef('worker'),'enemy',0,0); ue.setCell(this.grid.cols-6+j, this.grid.rows-3, this.grid); ue.createGO(this,this.grid); this.units.push(ue); }
    var rf=new RS.Unit(RS.getUnitDef('rifle'),'enemy',0,0); rf.setCell(this.grid.cols-5, this.grid.rows-5, this.grid); rf.createGO(this,this.grid); this.units.push(rf);
  };
  RS.RtsScene.prototype.spawnUnit=function(def, side, c, r){
    // 找空地
    var tile=this.grid.tile;
    var found=null;
    for(var rr=r; rr<r+3 && rr<this.grid.rows; rr++) for(var cc=c; cc<c+3 && cc<this.grid.cols; cc++) if(this.grid.isPassable(cc,rr)) { var occ=this.units.some(function(u){return u.c===cc&&u.r===rr&&u.alive;}); if(!occ){ found={c:cc,r:rr}; break; } }
    if(!found) found={c:c,r:r};
    var u=new RS.Unit(def, side, 0,0); u.setCell(found.c, found.r, this.grid); u.createGO(this,this.grid); this.units.push(u); return u;
  };
  RS.RtsScene.prototype.aiBuild=function(buildingId){
    var def=RS.getBuildingDef(buildingId); if(!this.state.canAfford(def.cost)) return false;
    // 敌基地附近空地
    var base=this.buildings.filter(function(b){return b.side==='enemy'&&b.def.id==='base';})[0]; if(!base) return false;
    for(var dr=-3; dr<=3; dr++) for(var dc=-3; dc<=3; dc++){
      var cc=base.c+dc, rr=base.r+dr;
      if(!this.grid.inBounds(cc,rr)) continue;
      if(!this.grid.isPassable(cc,rr)) continue;
      var occ=this.buildings.some(function(b){ return cc>=b.c && cc < b.c+b.size && rr>=b.r && rr < b.r+b.size; });
      if(occ) continue;
      this.state.spend(def.cost);
      var nb=new RS.Building(def, 'enemy', cc, rr); nb.createGO(this,this.grid); this.buildings.push(nb);
      return true;
    }
    return false;
  };
  RS.RtsScene.prototype._pickUnitAt=function(x,y){
    for(var i=0;i<this.units.length;i++){ var u=this.units[i]; if(!u.alive) continue; if(Math.abs(u.x - x) < 16 && Math.abs(u.y - y) < 16) return u; }
    return null;
  };
  RS.RtsScene.prototype._pickBuildingAt=function(x,y){
    for(var i=0;i<this.buildings.length;i++){ var b=this.buildings[i]; if(!b.alive) continue; var cx=b.go.cx, cy=b.go.cy, w=b.go.w, h=b.go.h; if(Math.abs(cx - x) < w/2 && Math.abs(cy - y) < h/2) return b; }
    return null;
  };
  RS.RtsScene.prototype._onBuildingPicked=function(b){
    var self=this;
    if(b.side!=='player') return;
    // 简易建造面板（生产队列）
    var produces=b.def.produces || [];
    if(!produces.length){ this._toast(b.def.name+'  无可生产', 900); return; }
    // 弹菜单
    this._showBuildMenu(b, produces);
  };
  RS.RtsScene.prototype._showBuildMenu=function(building, list){
    var self=this;
    if(this._buildMenu) try{this._buildMenu.destroy();}catch(e){}
    var W=this.scale.width, H=this.scale.height;
    var cont=this.add.container(W/2, H-110).setDepth(40);
    var bg=this.add.rectangle(0,0, 360, 64, 0x0e1628, 0.96); bg.setStrokeStyle(1,0x2a3a56,1); // 固定相机，需 setScrollFactor(0)
    bg.setScrollFactor(0); cont.add(bg);
    for(var i=0;i<list.length;i++){
      (function(unitId, idx){
        var def=RS.getUnitDef(unitId);
        var x=-140+idx*88, y=0;
        var b=self.add.rectangle(x,y,80,44,def.color).setInteractive({useHandCursor:true});
        b.setScrollFactor(0);
        var tx=self.add.text(x,y-8,def.abbr,{fontSize:'10px', color:'#0e1628', fontStyle:'bold'}).setOrigin(0.5); tx.setScrollFactor(0);
        var pr=self.add.text(x,y+10,'$'+def.cost.gold+' W'+(def.cost.wood||0),{fontSize:'8px', color:'#0e1628'}).setOrigin(0.5); pr.setScrollFactor(0);
        cont.add([b,tx,pr]);
        b.on('pointerdown', function(){
          if(!self.state.canAfford(def.cost)){ self._toast('资源不足',800); return; }
          building.enqueue(unitId);
          self._toast('已加入队列: '+def.name, 900);
          if(RS.Sfx) RS.Sfx.play('build');
        });
      })(list[i], i);
    }
    var close=self.add.text(150,-24,'×',{fontSize:'16px', color:'#e6edf3'}).setOrigin(0.5).setInteractive({useHandCursor:true}); close.setScrollFactor(0);
    close.on('pointerdown', function(){ try{cont.destroy();}catch(e){} self._buildMenu=null; });
    cont.add(close);
    this._buildMenu=cont;
    this.time.delayedCall(4200, function(){ try{cont.destroy();}catch(e){} if(self._buildMenu===cont) self._buildMenu=null; });
  };
  RS.RtsScene.prototype._orderMove=function(wx, wy){
    var sel=this.selection.selected;
    if(!sel.length) return;
    var cell=this.grid.worldToCell(wx, wy);
    // 点到资源 -> 采集
    var resHit=null;
    for(var ri=0; ri<this.resources.length; ri++){ var r=this.resources[ri]; if(r.isDepleted()) continue; if(r.c===cell.c && r.r===cell.r) resHit=r; }
    if(resHit){
      var workers=sel.filter(function(u){return u.def.id==='worker';});
      if(workers.length){
        for(var wi=0; wi<workers.length; wi++){ workers[wi].gatherTarget=resHit; workers[wi].state='gather'; workers[wi].moveTo({c:resHit.c, r:resHit.r}, this.grid, null); }
        this._toast('采集 '+ (resHit.type==='gold'?'金矿':'木材'), 900);
      } else {
        this._toast('需工兵采集', 800);
      }
      return;
    }
    // 点到敌单位/建筑 -> 攻击移动
    var hitU=this._pickUnitAt(wx, wy);
    var hitB=this._pickBuildingAt(wx, wy);
    if(hitU && hitU.side==='enemy'){
      for(var i2=0;i2<sel.length;i2++){ sel[i2].moveTo({c:hitU.c, r:hitU.r}, this.grid, null); }
      this._toast('攻击移动', 700);
      return;
    }
    if(hitB && hitB.side==='enemy'){
      for(var i3=0;i3<sel.length;i3++){ sel[i3].moveTo({c:hitB.c, r:hitB.r}, this.grid, null); }
      this._toast('攻击移动', 700);
      return;
    }
    // 普通移动（多单位散开）
    var targets=RS.spreadTargets(cell, sel.length, this.grid);
    var occupied={};
    for(var oi=0; oi<this.units.length; oi++){ var ou=this.units[oi]; if(ou.alive) occupied[ou.c+','+ou.r]=true; }
    for(var si=0; si<sel.length; si++){
      var u2=sel[si];
      delete occupied[u2.c+','+u2.r];
      var tgt=targets[si] || cell;
      u2.moveTo(tgt, this.grid, occupied);
      occupied[tgt.c+','+tgt.r]=true;
    }
  };
  RS.RtsScene.prototype._buildHud=function(){
    var W=this.scale.width;
    this.hudBg=this.add.rectangle(W/2,11,W,22,0x111827).setDepth(30); this.hudBg.setScrollFactor(0);
    this.hudText=this.add.text(10,11,'',{fontSize:'11px', color:'#e6edf3'}).setOrigin(0,0.5).setDepth(31); this.hudText.setScrollFactor(0);
    // 底栏（建造/人口）
    var panelY=this.scale.height - 18;
    this.panelText=this.add.text(10, panelY, '', {fontSize:'10px', color:'#8b949e'}).setOrigin(0,0.5).setDepth(31); this.panelText.setScrollFactor(0);
    // 快捷生产按钮（基地）
    var self=this;
    var btnW=70, btnH=26, gap=6, startX=W-300;
    var btnDefs=[
      { label:'工兵', cb:function(){ self._quickProduce('worker'); } },
      { label:'步枪', cb:function(){ self._quickProduce('rifle'); } },
      { label:'游侠', cb:function(){ self._quickProduce('archer'); } },
      { label:'兵营', cb:function(){ self._quickBuild('barracks'); } }
    ];
    for(var bi=0; bi<btnDefs.length; bi++){
      (function(def, idx){
        var x=startX+idx*(btnW+gap)+btnW/2, y=panelY;
        var bg=self.add.rectangle(x,y,btnW,btnH,0x2a3a56).setInteractive({useHandCursor:true}).setDepth(31); bg.setScrollFactor(0);
        var tx=self.add.text(x,y,def.label,{fontSize:'10px', color:'#e6edf3'}).setOrigin(0.5).setDepth(32); tx.setScrollFactor(0);
        bg.on('pointerdown', def.cb);
        bg.on('pointerover', function(){bg.fillColor=0x34495e;}); bg.on('pointerout', function(){bg.fillColor=0x2a3a56;});
      })(btnDefs[bi], bi);
    }
  };
  RS.RtsScene.prototype._quickProduce=function(unitId){
    var base=this.buildings.filter(function(b){return b.side==='player'&&b.def.id==='base'&&b.alive;})[0];
    if(!base){ this._toast('无基地',800); return; }
    base.enqueue(unitId);
    this._toast('队列: '+RS.getUnitDef(unitId).name, 800);
  };
  RS.RtsScene.prototype._quickBuild=function(buildingId){
    var def=RS.getBuildingDef(buildingId);
    if(!this.state.canAfford(def.cost)){ this._toast('资源不足',800); return; }
    // 玩家基地旁空地
    var base=this.buildings.filter(function(b){return b.side==='player'&&b.def.id==='base';})[0];
    if(!base) return;
    for(var dr=-2; dr<=3; dr++) for(var dc=-2; dc<=3; dc++){
      var cc=base.c+dc, rr=base.r+dr;
      if(!this.grid.inBounds(cc,rr)) continue;
      if(!this.grid.isPassable(cc,rr)) continue;
      var occ=this.buildings.some(function(b){ return cc>=b.c && cc < b.c+b.size && rr>=b.r && rr < b.r+b.size; });
      if(occ) continue;
      this.state.spend(def.cost);
      var nb=new RS.Building(def,'player',cc,rr); nb.createGO(this,this.grid); this.buildings.push(nb);
      if(def.id==='house') this.state.popCap+=6;
      if(RS.Sfx) RS.Sfx.play('build');
      this._toast('建造 '+def.name, 900);
      return;
    }
    this._toast('无空地', 800);
  };
  RS.RtsScene.prototype._buildMinimap=function(){
    var W=this.scale.width, H=this.scale.height;
    var mw=160, mh=110, mx=W-mw-10, my=H-mh-10 - 36;
    this.miniBg=this.add.rectangle(mx+mw/2, my+mh/2, mw, mh, 0x000000, 0.55).setStrokeStyle(1,0x2a3a56,1).setDepth(31); this.miniBg.setScrollFactor(0);
    this.miniGfx=this.add.graphics().setDepth(32); this.miniGfx.setScrollFactor(0);
    this._miniRect={ x:mx, y:my, w:mw, h:mh };
    var self=this;
    this.miniBg.setInteractive({useHandCursor:true});
    this.miniBg.on('pointerdown', function(pointer){
      var lx=pointer.x - mx, ly=pointer.y - my;
      var cc=Math.floor(lx/mw * self.grid.cols), rr=Math.floor(ly/mh * self.grid.rows);
      var world=self.grid.cellToWorld(cc,rr);
      self.cameras.main.centerOn(world.x, world.y);
      self.cameras.main.scrollX=Math.max(0,Math.min(self.cameras.main.scrollX, self.worldW - W));
      self.cameras.main.scrollY=Math.max(0,Math.min(self.cameras.main.scrollY, self.worldH - H));
    });
  };
  RS.RtsScene.prototype._drawMinimap=function(){
    var g=this.miniGfx, r=this._miniRect;
    g.clear();
    var cols=this.grid.cols, rows=this.grid.rows;
    // 地形
    for(var rr=0; rr<rows; rr++) for(var cc=0; cc<cols; cc++){
      var t=this.grid.terrainAt(cc,rr);
      var col=RS.COLORS.TERRAIN[t]||0x2a3a56;
      g.fillStyle(col, 0.95);
      g.fillRect(r.x + cc/r.cols * r.w, r.y + rr/rows * r.h, r.w/cols+1, r.h/rows+1);
    }
    // 资源
    for(var i=0;i<this.resources.length;i++){
      var res=this.resources[i]; if(res.isDepleted()) continue;
      g.fillStyle(res.type==='gold'?0xf1c40f:0x2ecc71, 1);
      g.fillRect(r.x + res.c/cols * r.w, r.y + res.r/rows * r.h, 4, 4);
    }
    // 建筑
    for(var bi=0; bi<this.buildings.length; bi++){
      var b=this.buildings[bi]; if(!b.alive) continue;
      g.fillStyle(b.side==='player'?0x3498db:0xe74c3c, 1);
      g.fillRect(r.x + b.c/cols * r.w, r.y + b.r/rows * r.h, 6, 6);
    }
    // 单位
    for(var ui=0; ui<this.units.length; ui++){
      var u=this.units[ui]; if(!u.alive) continue;
      g.fillStyle(u.side==='player'?0x85c1e9:0xf5b7b1, 1);
      g.fillRect(r.x + u.c/cols * r.w, r.y + u.r/rows * r.h, 3, 3);
    }
    // 视口
    var cam=this.cameras.main;
    g.lineStyle(1, 0xffffff, 0.9);
    var vx=r.x + cam.scrollX/this.worldW * r.w;
    var vy=r.y + (cam.scrollY - 22)/this.worldH * r.h;
    var vw=r.w * this.scale.width / this.worldW;
    var vh=r.h * this.scale.height / this.worldH;
    g.strokeRect(vx, vy, vw, vh);
    // 迷雾叠加（半透）
    if(this.state.settings.fog){
      for(var fr=0; fr<rows; fr++) for(var fc=0; fc<cols; fc++){
        if(this.fogOfWar.isVisible(fc,fr)) continue;
        var seen=this.fogOfWar.isSeen(fc,fr);
        g.fillStyle(seen?0x1a2332:0x0a0f1e, seen?0.35:0.82);
        g.fillRect(r.x + fc/cols * r.w, r.y + fr/rows * r.h, r.w/cols+1, r.h/rows+1);
      }
    }
  };
  RS.RtsScene.prototype._toast=function(msg, ms){
    var t=this.add.text(this.scale.width/2, this.scale.height - 42, msg, {fontSize:'11px', color:'#e6edf3', backgroundColor:'#111827cc'}).setOrigin(0.5).setDepth(40); t.setScrollFactor(0);
    this.time.delayedCall(ms||1300, function(){ try{t.destroy();}catch(e){} });
  };
  RS.RtsScene.prototype.update=function(time, delta){
    var dt=delta;
    // 相机键盘
    var cam=this.cameras.main, spd=420*dt/1000;
    if(this.cursors.left.isDown || this.wasd.A.isDown) cam.scrollX-=spd;
    if(this.cursors.right.isDown || this.wasd.D.isDown) cam.scrollX+=spd;
    if(this.cursors.up.isDown || this.wasd.W.isDown) cam.scrollY-=spd;
    if(this.cursors.down.isDown || this.wasd.S.isDown) cam.scrollY+=spd;
    cam.scrollX=Math.max(0,Math.min(cam.scrollX, this.worldW - this.scale.width));
    cam.scrollY=Math.max(0,Math.min(cam.scrollY, this.worldH - this.scale.height));
    // 系统
    this.movement.update(dt, this.units, this.grid);
    this.combat.update(dt, this.units);
    this.gathering.update(dt, this.units, this.resources);
    // 建筑队列
    for(var bi=0; bi<this.buildings.length; bi++) this.buildings[bi].updateQueue(dt, this);
    // AI
    this.aiMgr.update(dt);
    // 迷雾
    this.fogSystem.revealFromUnits(this.units, this.buildings);
    // 清理死亡单位/枯竭资源
    this.units=this.units.filter(function(u){return u.alive;});
    // HUD
    var selN=this.selection ? this.selection.selected.length : 0;
    this.hudText.setText('金 '+this.state.gold+'  木 '+this.state.wood+'  人口 '+this.state.pop+'/'+this.state.popCap+'  选中 '+selN+'  |  左框选  右指令  中拖动  ESC退出');
    var selInfo='';
    if(selN===1){ var u2=this.selection.selected[0]; selInfo=u2.def.name+'  HP'+u2.hp+'/'+u2.maxHp+'  攻'+u2.atk+'  射程'+u2.range; }
    else if(selN>1) selInfo='选中 '+selN+' 单位';
    this.panelText.setText(selInfo);
    this._drawMinimap();
    // 胜负：基地被毁即败/胜
    var myBaseAlive=this.buildings.some(function(b){return b.side==='player'&&b.def.id==='base'&&b.alive;});
    var enemyBaseAlive=this.buildings.some(function(b){return b.side==='enemy'&&b.def.id==='base'&&b.alive;});
    if(!myBaseAlive && !this._ended){ this._ended=true; this._defeat(); }
    if(!enemyBaseAlive && !this._ended){ this._ended=true; this._victory(); }
  };
  RS.RtsScene.prototype._victory=function(){
    if(RS.Sfx) RS.Sfx.play('victory');
    var W=this.scale.width, H=this.scale.height;
    var bg=this.add.rectangle(W/2,H/2,W,H,0x000000,0.62).setDepth(50); bg.setScrollFactor(0);
    this.add.text(W/2,H/2-28,'胜利！',{fontSize:'28px', color:'#2ecc71', fontStyle:'bold'}).setOrigin(0.5).setDepth(51).setScrollFactor(0);
    this.add.text(W/2,H/2,'敌方基地已摧毁',{fontSize:'12px', color:'#e6edf3'}).setOrigin(0.5).setDepth(51).setScrollFactor(0);
    var self=this;
    var b1=this.add.rectangle(W/2,H/2+36,140,32,0x2a3a56).setDepth(51).setInteractive({useHandCursor:true}).setScrollFactor(0);
    this.add.text(W/2,H/2+36,'再来一局',{fontSize:'13px', color:'#e6edf3'}).setOrigin(0.5).setDepth(52).setScrollFactor(0);
    b1.on('pointerdown', function(){ self.scene.restart({seed: Math.floor(Math.random()*1e9)}); });
    var b2=this.add.rectangle(W/2,H/2+74,140,32,0x2a3a56).setDepth(51).setInteractive({useHandCursor:true}).setScrollFactor(0);
    this.add.text(W/2,H/2+74,'返回',{fontSize:'13px', color:'#e6edf3'}).setOrigin(0.5).setDepth(52).setScrollFactor(0);
    b2.on('pointerdown', function(){ self.scene.start('Start'); });
  };
  RS.RtsScene.prototype._defeat=function(){
    if(RS.Sfx) RS.Sfx.play('defeat');
    var W=this.scale.width, H=this.scale.height;
    var bg=this.add.rectangle(W/2,H/2,W,H,0x000000,0.62).setDepth(50); bg.setScrollFactor(0);
    this.add.text(W/2,H/2-28,'败北',{fontSize:'28px', color:'#e74c3c', fontStyle:'bold'}).setOrigin(0.5).setDepth(51).setScrollFactor(0);
    var self=this;
    var b1=this.add.rectangle(W/2,H/2+24,140,32,0x2a3a56).setDepth(51).setInteractive({useHandCursor:true}).setScrollFactor(0);
    this.add.text(W/2,H/2+24,'重试',{fontSize:'13px', color:'#e6edf3'}).setOrigin(0.5).setDepth(52).setScrollFactor(0);
    b1.on('pointerdown', function(){ self.scene.restart({seed:self.seed}); });
    var b2=this.add.rectangle(W/2,H/2+62,140,32,0x2a3a56).setDepth(51).setInteractive({useHandCursor:true}).setScrollFactor(0);
    this.add.text(W/2,H/2+62,'返回',{fontSize:'13px', color:'#e6edf3'}).setOrigin(0.5).setDepth(52).setScrollFactor(0);
    b2.on('pointerdown', function(){ self.scene.start('Start'); });
  };
})();
