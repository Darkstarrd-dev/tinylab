// RS.FogOfWar — 迷雾（已见/可见）
(function () {
  'use strict';
  var RS = window.RS;
  function FogOfWar(cols, rows){
    this.cols=cols; this.rows=rows;
    this.seen=[]; this.visible=[]; // 2D bool
    for(var r=0;r<rows;r++){ this.seen[r]=[]; this.visible[r]=[]; for(var c=0;c<cols;c++){ this.seen[r][c]=false; this.visible[r][c]=false; } }
    this.revealedCount=0;
  }
  FogOfWar.prototype.resetVisible = function(){
    for(var r=0;r<this.rows;r++) for(var c=0;c<this.cols;c++) this.visible[r][c]=false;
  };
  FogOfWar.prototype.reveal = function(c,r,range){
    for(var dr=-range; dr<=range; dr++) for(var dc=-range; dc<=range; dc++){
      var cc=c+dc, rr=r+dr;
      if(cc<0||cc>=this.cols||rr<0||rr>=this.rows) continue;
      if(Math.abs(dc)+Math.abs(dr) > range) continue; // 曼哈顿
      // 视线遮挡：M/W 不透视可省略，简化为不遮挡（RTS 常规）
      this.visible[rr][cc]=true;
      if(!this.seen[rr][cc]){ this.seen[rr][cc]=true; this.revealedCount++; }
    }
  };
  FogOfWar.prototype.isVisible = function(c,r){ if(c<0||c>=this.cols||r<0||r>=this.rows) return false; return !!this.visible[r][c]; };
  FogOfWar.prototype.isSeen = function(c,r){ if(c<0||c>=this.cols||r<0||r>=this.rows) return false; return !!this.seen[r][c]; };
  FogOfWar.prototype.isUnseen = function(c,r){ return !this.isSeen(c,r); };
  RS.FogOfWar = FogOfWar;
})();
