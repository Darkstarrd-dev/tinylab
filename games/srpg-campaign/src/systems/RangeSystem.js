// SC.RangeSystem — 移动/攻击范围与高亮
(function () {
  'use strict';
  var SC = window.SC;
  function RangeSystem(grid){ this.grid=grid; this.moveSet=null; this.attackSet=null; this._gfx=null; }
  RangeSystem.prototype.showMove = function(scene, unit, units){
    this.clear();
    var occ={};
    for(var i=0;i<units.length;i++){ var u=units[i]; if(u===unit) continue; if(!u.isAlive()) continue; occ[u.c+','+u.r]=true; }
    this.moveSet = SC.calcMoveRange(this.grid, {c:unit.c,r:unit.r}, unit.mov, occ);
    var range = unit.range;
    this.attackSet = SC.calcAttackRange(this.grid, this.moveSet, range);
    var g=scene.add.graphics().setDepth(2);
    var tile=this.grid.tile, ox=this.grid.ox, oy=this.grid.oy;
    // 移动
    g.fillStyle(SC.COLORS.MOVE, 0.22);
    for(var k in this.moveSet){ var p=k.split(','); var c=parseInt(p[0],10), r=parseInt(p[1],10); g.fillRect(ox+c*tile, oy+r*tile, tile, tile); }
    g.lineStyle(1, SC.COLORS.MOVE, 0.9);
    for(var k2 in this.moveSet){ var p2=k2.split(','); var c2=parseInt(p2[0],10), r2=parseInt(p2[1],10); g.strokeRect(ox+c2*tile+0.5, oy+r2*tile+0.5, tile-1, tile-1); }
    // 攻击（不含移动）
    g.fillStyle(SC.COLORS.ATTACK, 0.18);
    for(var k3 in this.attackSet){ if(this.moveSet[k3]) continue; var p3=k3.split(','); var c3=parseInt(p3[0],10), r3=parseInt(p3[1],10); g.fillRect(ox+c3*tile, oy+r3*tile, tile, tile); }
    this._gfx=g;
  };
  RangeSystem.prototype.isInMove = function(c,r){ return this.moveSet && !!this.moveSet[c+','+r]; };
  RangeSystem.prototype.isInAttack = function(c,r){ return this.attackSet && !!this.attackSet[c+','+r]; };
  RangeSystem.prototype.clear = function(){ if(this._gfx) try{this._gfx.destroy();}catch(e){}; this._gfx=null; this.moveSet=null; this.attackSet=null; };
  SC.RangeSystem = RangeSystem;
})();
