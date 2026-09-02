(function(){
'use strict';
var FKO=window.FKO;
FKO.dist2=function(ax,ay,bx,by){var dx=ax-bx,dy=ay-by;return dx*dx+dy*dy;};
FKO.dist=function(ax,ay,bx,by){return Math.sqrt(FKO.dist2(ax,ay,bx,by));};
FKO.clamp=function(v,lo,hi){return v<lo?lo:v>hi?hi:v;};
FKO.lerp=function(a,b,t){return a+(b-a)*t;};
FKO.rectIntersects=function(ax,ay,aw,ah,bx,by,bw,bh){return !(ax+aw<bx||bx+bw<ax||ay+ah<by||by+bh<ay);};
})();
