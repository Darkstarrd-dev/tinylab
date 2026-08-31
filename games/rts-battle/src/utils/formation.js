// RS.Formation — 多选阵型与朝向
(function () {
  'use strict';
  var RS = window.RS;
  RS.formationTargets = function(center, units){
    var n=units.length;
    if(n<=1) return [center];
    // 简单横队（根据点击方向可旋转，此处固定）
    var cols=Math.ceil(Math.sqrt(n));
    var pts=[];
    for(var i=0;i<n;i++){
      var r=Math.floor(i/cols), c=i%cols;
      var offC = c - (cols-1)/2;
      var offR = r - Math.floor(n/cols)/2;
      pts.push({ c:center.c + offC, r:center.r + offR });
    }
    return pts;
  };
})();
