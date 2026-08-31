// RS.SelectionManager — 框选 + 多选
(function () {
  'use strict';
  var RS = window.RS;
  function SelectionManager(scene){ this.scene=scene; this.selected=[]; this._box=null; this._dragStart=null; this._boxGfx=null; }
  SelectionManager.prototype.setSelected=function(list){
    for(var i=0;i<this.selected.length;i++) this.selected[i].setSelected(false);
    this.selected=list.slice(0);
    for(var j=0;j<this.selected.length;j++) this.selected[j].setSelected(true);
  };
  SelectionManager.prototype.selectOne=function(u){ this.setSelected([u]); };
  SelectionManager.prototype.add=function(u){ if(this.selected.indexOf(u)===-1){ this.selected.push(u); u.setSelected(true);} };
  SelectionManager.prototype.clear=function(){ this.setSelected([]); };
  SelectionManager.prototype.boxSelect=function(x1,y1,x2,y2, units){
    var minX=Math.min(x1,x2), maxX=Math.max(x1,x2), minY=Math.min(y1,y2), maxY=Math.max(y1,y2);
    var picked=[];
    for(var i=0;i<units.length;i++){ var u=units[i]; if(u.side!=='player'||!u.alive) continue; if(u.x>=minX&&u.x<=maxX&&u.y>=minY&&u.y<=maxY) picked.push(u); }
    if(picked.length) this.setSelected(picked);
  };
  SelectionManager.prototype.drawBox=function(x1,y1,x2,y2){
    if(!this._boxGfx) this._boxGfx=this.scene.add.graphics().setDepth(30);
    this._boxGfx.clear();
    this._boxGfx.lineStyle(1.5, RS.COLORS.SELECT, 1);
    this._boxGfx.strokeRect(Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1));
    this._boxGfx.fillStyle(RS.COLORS.SELECT_FILL, 0.12);
    this._boxGfx.fillRect(Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1));
  };
  SelectionManager.prototype.clearBox=function(){ if(this._boxGfx) this._boxGfx.clear(); };
  RS.SelectionManager = SelectionManager;
})();
