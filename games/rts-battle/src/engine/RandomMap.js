// RS.RandomMap — 随机地形与资源分布（可重复种子）
(function () {
  'use strict';
  var RS = window.RS;
  function mulberry32(a){ return function(){ var t=a+=0x6D2B79F5; t=Math.imul(t^t>>>15,t|1); t^=t+Math.imul(t^t>>>7,61|t); return ((t^t>>>14)>>>0)/4294967296; }; }
  RS.RandomMap = {
    generate: function(seed){
      var cfg=RS.MAP_CFG;
      var rnd=mulberry32(seed>>>0);
      var cols=cfg.cols, rows=cfg.rows;
      var map=[];
      for(var r=0;r<rows;r++){ var row=''; for(var c=0;c<cols;c++){
        var v=rnd();
        if(v < cfg.waterRatio) row+='W';
        else if(v < cfg.waterRatio + cfg.forestRatio) row+='F';
        else if(v < cfg.waterRatio + cfg.forestRatio + cfg.rockRatio) row+='M';
        else row+='.';
      } map.push(row); }
      // 清理起点与终点区域（保证可出生）
      function clearRect(cc,rr,w,h){
        for(var rr2=rr; rr2<rr+h && rr2<rows; rr2++){
          var arr=map[rr2].split('');
          for(var cc2=cc; cc2<cc+w && cc2<cols; cc2++) arr[cc2]='.';
          map[rr2]=arr.join('');
        }
      }
      clearRect(1,1,7,7);
      clearRect(cols-8, rows-8,7,7);
      // 资源
      var resources=[];
      function placeResource(type, amount, n){
        for(var i=0;i<n;i++){
          var tries=32;
          while(tries-->0){
            var c=Math.floor(rnd()*cols), r2=Math.floor(rnd()*rows);
            if(map[r2][c]!=='.') continue;
            // 避开基地极近
            if((c<4&&r2<4) || (c>cols-5&&r2>rows-5)) continue;
            // 检查周边无资源
            var near=false;
            for(var k=0;k<resources.length;k++) if(Math.abs(resources[k].c-c)<3 && Math.abs(resources[k].r-r2)<3) near=true;
            if(near) continue;
            resources.push({ type:type, c:c, r:r2, amount:amount });
            break;
          }
        }
      }
      placeResource('gold', cfg.goldPerVein, cfg.goldVeins);
      placeResource('wood', cfg.woodPerPatch, cfg.woodPatches);
      return { map: map, resources: resources, seed: seed };
    }
  };
})();
