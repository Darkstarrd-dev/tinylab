(function(){
'use strict';
var FKO=window.FKO;
FKO.InputBuffer=function(){this.history=[];this.frameCounter=0;};
FKO.InputBuffer.prototype.push=function(dir,btns){
  this.frameCounter++;
  this.history.push({dir:dir,btns:{A:!!btns.A,B:!!btns.B,C:!!btns.C,D:!!btns.D},frame:this.frameCounter});
  var max=FKO.CFG.INPUT_BUFFER_FRAMES||12;
  while(this.history.length>max) this.history.shift();
};
FKO.InputBuffer.prototype._parseCommand=function(cmd){
  // cmd includes button at end, we parse motion part
  var motion=cmd.slice(0,-1);
  if(motion==='') return [];
  if(motion==='236') return [2,3,6];
  if(motion==='623') return [6,2,3];
  if(motion==='214') return [2,1,4];
  if(motion==='236236') return [2,3,6,2,3,6];
  if(motion==='214214') return [2,1,4,2,1,4];
  return null;
};
FKO.InputBuffer.prototype._mirrorDir=function(d, facing){
  if(facing!==-1) return d;
  if(d===6) return 4;
  if(d===4) return 6;
  if(d===3) return 1;
  if(d===1) return 3;
  if(d===9) return 7;
  if(d===7) return 9;
  return d;
};
FKO.InputBuffer.prototype.matchCommand=function(cmd,facing){
  if(!cmd||!cmd.length) return false;
  var btn=cmd.slice(-1);
  if(btn!=='A'&&btn!=='B'&&btn!=='C'&&btn!=='D') return false;
  var needDirs=this._parseCommand(cmd);
  if(needDirs===null) return false;
  // mirror dirs according to facing
  var dirs=[];
  for(var i=0;i<needDirs.length;i++) dirs.push(this._mirrorDir(needDirs[i], facing));
  if(this.history.length===0) return false;
  var last=this.history[this.history.length-1];
  if(!last.btns[btn]) return false;
  if(dirs.length===0) return true;
  var dirIdx=dirs.length-1;
  for(var h=this.history.length-1; h>=0; h--){
    if(this.history[h].dir===dirs[dirIdx]){
      dirIdx--;
      if(dirIdx<0) return true;
    }
  }
  return false;
};
})();
