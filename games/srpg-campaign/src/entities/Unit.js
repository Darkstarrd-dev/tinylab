// SC.Unit — 战场单位基类
(function () {
  'use strict';
  var SC = window.SC;
  function Unit(opts) {
    this.id = opts.id;
    this.name = opts.name; this.abbr = opts.abbr;
    this.job = opts.job; this.level = opts.level || 1;
    this.maxHp = opts.maxHp; this.hp = opts.hp != null ? opts.hp : opts.maxHp;
    this.atk = opts.atk; this.def = opts.def; this.spd = opts.spd;
    this.mov = opts.mov; this.range = opts.range;
    this.c = opts.c; this.r = opts.r;
    this.side = opts.side || 'player'; // player/enemy/npc
    this.exp = opts.exp || 0;
    this.skills = opts.skills ? opts.skills.slice(0) : [];
    this.alive = true;
    this.hasActed = false; this.hasMoved = false;
    this.go = null; this._hpBar = null; this._label = null;
    this._selRing = null;
  }
  Unit.prototype.isAlive = function(){ return this.alive && this.hp > 0; };
  Unit.prototype.takeDamage = function (n){ this.hp -= n; if(this.hp<=0){ this.hp=0; this.alive=false; } this._syncHp(); return !this.alive; };
  Unit.prototype.heal = function (n){ this.hp += n; if(this.hp>this.maxHp) this.hp=this.maxHp; this._syncHp(); };
  Unit.prototype._syncHp = function(){
    if(!this.go) return;
    if(this._hpBar){
      var w = 32 * (this.hp / this.maxHp);
      this._hpBar.width = Math.max(0, w);
      this._hpBar.fillColor = this.hp / this.maxHp > 0.5 ? 0x2ecc71 : this.hp / this.maxHp > 0.25 ? 0xf1c40f : 0xe74c3c;
    }
    if(this._label) this._label.setText(this.abbr + ' ' + this.hp + '/' + this.maxHp);
  };
  Unit.prototype.createGO = function (scene, grid) {
    var pos = grid.cellToWorld(this.c, this.r);
    var col = this.side === 'enemy' ? 0xe74c3c : this.side === 'npc' ? 0xf1c40f : SC.getClass(this.job).color;
    var cont = scene.add.container(pos.x, pos.y);
    var bg = scene.add.rectangle(0, 0, 32, 32, col);
    bg.setStrokeStyle(1.5, 0xffffff, 0.9);
    var tx = scene.add.text(0, -2, this.abbr, { fontSize:'10px', color:'#0e1628', fontStyle:'bold' }).setOrigin(0.5);
    var lv = scene.add.text(13, -13, 'Lv'+this.level, { fontSize:'7px', color:'#ffffff', backgroundColor:'#000000aa' }).setOrigin(1,0);
    var barBg = scene.add.rectangle(0, 14, 32, 4, 0x000000, 0.5);
    var bar = scene.add.rectangle(-16, 14, 32, 4, 0x2ecc71);
    bar.setOrigin(0,0.5);
    cont.add([bg, tx, lv, barBg, bar]);
    cont.setDepth(10 + this.r);
    bg.setInteractive({ useHandCursor:true });
    var self=this;
    bg.on('pointerdown', function(){ if(scene.onUnitPicked) scene.onUnitPicked(self); });
    this.go = cont; this._bg = bg; this._label = tx; this._hpBar = bar; this._hpBarBg = barBg; this._lvText = lv;
    this._syncHp();
  };
  Unit.prototype.setCell = function(c,r, grid){
    this.c=c; this.r=r;
    if(this.go && grid){ var p=grid.cellToWorld(c,r); this.go.x=p.x; this.go.y=p.y; this.go.setDepth(10+r); }
  };
  Unit.prototype.setSelected = function(on){
    if(this._bg) this._bg.setStrokeStyle(on?2.5:1.5, on?0x3498db:0xffffff, 0.95);
  };
  Unit.prototype.resetTurn = function(){ this.hasActed=false; this.hasMoved=false; };
  SC.Unit = Unit;
})();
