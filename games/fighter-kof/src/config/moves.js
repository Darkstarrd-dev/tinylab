(function(){
'use strict';
var FKO=window.FKO;
function mkMoves(prefix){
  return [
    {id:'5A',name:'\u8F7B\u62F3',input:'A',dmg:6,chip:1,hs:260,bs:140,push:10,startup:80,active:90,rec:160,kd:false,meterGain:4,hitboxes:[{frame:0,x:35,y:-32,w:42,h:18}],motion:'stand'},
    {id:'5B',name:'\u8F7B\u817F',input:'B',dmg:8,chip:1,hs:300,bs:160,push:12,startup:90,active:100,rec:180,kd:false,meterGain:5,hitboxes:[{frame:0,x:38,y:-18,w:44,h:20}],motion:'stand'},
    {id:'5C',name:'\u91CD\u62F3',input:'C',dmg:12,chip:2,hs:360,bs:180,push:15,startup:120,active:110,rec:220,kd:false,meterGain:6,hitboxes:[{frame:0,x:36,y:-36,w:46,h:22}],motion:'stand'},
    {id:'5D',name:'\u91CD\u817F',input:'D',dmg:14,chip:2,hs:400,bs:200,push:18,startup:140,active:120,rec:260,kd:true,meterGain:7,hitboxes:[{frame:0,x:40,y:-20,w:48,h:24}],motion:'stand'},
    {id:'236A',name:prefix+'\u00B7\u70C8',input:'236A',dmg:14,chip:4,hs:400,bs:200,push:18,startup:180,active:120,rec:320,kd:false,meterGain:8,hitboxes:[{frame:0,x:30,y:-40,w:40,h:50}],motion:'fireball'},
    {id:'623C',name:prefix+'\u00B7\u5347',input:'623C',dmg:16,chip:2,hs:600,bs:180,push:30,startup:90,active:240,rec:420,kd:true,meterGain:10,hitboxes:[{frame:0,x:20,y:-50,w:44,h:36}],motion:'dp'},
    {id:'236236A',name:prefix+'\u00B7\u5965\u4E49',input:'236236A',dmg:30,chip:8,hs:800,bs:300,push:50,startup:120,active:300,rec:600,kd:true,meterCost:100,super:true,hitboxes:[{frame:0,x:30,y:-40,w:60,h:50}],motion:'super'}
  ];
}
FKO.MOVES={
  kyo: mkMoves('\u8349\u8599'),
  iori: mkMoves('\u516B\u795E'),
  terry: mkMoves('\u7279\u745E'),
  mai: mkMoves('\u4E0D\u77E5\u706B')
};
// override specific names for kyo to match spec
FKO.MOVES.kyo[4].name='\u9B3C\u70E7';
FKO.MOVES.kyo[5].name='\u8352\u54AC';
FKO.MOVES.kyo[6].name='\u5927\u86C7\u8599';
FKO.MOVES.iori[4].name='\u8475\u82B1';
FKO.MOVES.iori[5].name='\u9B3C\u70E7';
FKO.MOVES.iori[6].name='\u516B\u7A1A\u5973';
FKO.getMoveset=function(charId){return FKO.MOVES[charId]||[];};
FKO.getMove=function(charId,moveId){var ms=FKO.getMoveset(charId);for(var i=0;i<ms.length;i++) if(ms[i].id===moveId) return ms[i];return null;};
})();
