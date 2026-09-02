(function(){
'use strict';
var FKO=window.FKO;
FKO.calcHitbox=function(fighter,hbox){var fx=fighter.facing;return {x:fighter.x+fx*hbox.x - hbox.w/2,y:fighter.y+hbox.y - hbox.h/2,w:hbox.w,h:hbox.h};};
FKO.calcHurtbox=function(fighter){var def=fighter.charDef.hurtbox;var box=fighter.crouching?def.crouch:def.stand;return {x:fighter.x+box.ox - box.w/2,y:fighter.y+box.oy - box.h/2,w:box.w,h:box.h};};
FKO.calcPushbox=function(fighter){var box=fighter.charDef.pushbox;return {x:fighter.x+box.ox - box.w/2,y:fighter.y+box.oy - box.h/2,w:box.w,h:box.h};};
})();
