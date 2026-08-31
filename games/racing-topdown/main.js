// =============================================================================
// 【资产替换清单】—— 将来替换为外部资源时逐项修改：
//   视觉：
//     generateTexture('car_player'/'car_ai1'/'car_ai2'/'car_ai3') 纯色矩形+轮子+驾驶舱
//       → 换成 this.load.image('car_player','assets/car_player.png') 等 4 贴图
//     generateTexture('particle_smoke'/'particle_spark') 圆形粒子
//       → 换成 this.load.image('smoke','assets/smoke.png')
//     赛道 this.add.graphics 画草地+灰色路面+橙白路肩+起点线
//       → 换成 this.load.image('track_bg','assets/track_bg.png') + Tiled JSON
//     围墙 this.add.graphics 橙色多边形描边(内墙/外墙)
//       → 换成 this.load.image('wall','assets/wall.png') + 碰撞多边形
//     航点调试点 this.add.graphics 半透明圆点+序号
//       → 换成 this.load.image('waypoint','assets/wp.png') 或关闭调试
//     小地图 this.add.graphics 缩略路面+车辆点
//       → 换成 this.add.image('minimap','assets/minimap.png')
//   音频：
//     Sfx.play('engine'/'brake'/'drift'/'collide'/'overtake'/'bgm'/'finish')
//       WebAudio oscillator+gain → 换成 this.load.audio('engine','assets/engine.wav')+this.sound.play
//       文件顶部 Sfx 块已写替换写法注释。
//   关卡：
//     TRACKS 数组 waypoints+roadW → 换成 this.load.json('tracks','assets/tracks.json')
//     每赛道 TRACK_CONFIG.waypoints + roadW + wall 布局 → Tiled 赛道中线导出
//   纹理生成段落在各 Scene.create() 中以“生成纹理”中文注释标出替换点。
// =============================================================================
(function(){
'use strict';
// ==========================================================================
// 顶部可调参数（带单位）—— 中文注释 + 英文 HUD 文本
// ==========================================================================
/** 画布逻辑宽 px — 固定横屏 */
var CW=960;
/** 画布逻辑高 px */
var CH=540;
/** 每圈圈数 */
var TOTAL_LAPS=3;
/** 玩家最高速 px/s — 约 320 */
var P_MAX_SPEED=340;
/** AI 最高速 px/s — 每辆不同，覆盖于 TRACKS.aiSpeeds */
var AI_MAX_SPEED_BASE=260;
/** 加速系数 1/s — 油门响应 */
var ACCEL=180;
/** 自然减速/阻力 1/s — 松油门滑行 */
var DRAG=45;
/** 刹车减速度 px/s² — 比加速强 */
var BRAKE_DECEL=420;
/** 倒车最高速 px/s — 负值上限幅值 */
var REV_MAX=120;
/** 倒车加速度 px/s² */
var REV_ACCEL=140;
/** 转向速率 deg/s per 输入 — 基础 */
var STEER_RATE=165;
/** 高速转向衰减系数 — 速度越高转向越钝(漂移除外) */
var STEER_SPEED_FACTOR=0.55;
/** 手刹漂移：横滑角增量系数 */
var DRIFT_FACTOR=2.2;
/** 漂移摩擦衰减 — 漂移时横向速度衰减更慢 */
var DRIFT_FRICTION=0.92;
/** 墙碰撞回弹系数 0~1 */
var WALL_BOUNCE=0.35;
/** 墙碰撞速度损失系数 */
var WALL_SPEED_LOSS=0.55;
/** 车体碰撞击退速度 px/s */
var CAR_KNOCK=140;
/** 车体尺寸 长 px */
var CAR_LEN=28;
/** 车体尺寸 宽 px */
var CAR_WID=14;
/** 碰撞半径 px — 用于墙距判断近似圆 */
var CAR_RADIUS=10;
/** AI 航点追踪转向平滑 0~1 */
var AI_STEER_SMOOTH=0.14;
/** AI 航点切换距离阈值 px */
var AI_WP_THRESH=38;
/** 超车判定：超越 AI 时加分 */
var OVERTAKE_SCORE=200;
/** 单圈最佳时间初始大值 ms */
var INIT_BEST=9999999;

// ==========================================================================
// 赛道定义 — 双赛道闭环多边形 + 航点贴中线 + 可变路宽
//   教学：每赛道 waypoints 为闭环中线点(x,y)，按顺时针顺序，首尾自动闭合
//         roadW 为平均路宽 px，roadWVar 为每段宽度扰动(可选)
//         外墙/内墙由中线法线偏移 roadW/2 生成，墙碰撞用中线距离判定
//         赛道2更窄弯更急：roadW 更小，航点密度更高、曲率更大
//         将来换 Tiled：TRACKS → this.load.json('tracks','assets/tracks.json')
// ==========================================================================
var TRACKS=[
  {
    id:1,
    name:'TRACK 1  OVAL',
    roadW:132,
    // 航点：外椭圆近似 8字加长椭圆，含直道+缓弯，逆时针
    waypoints:[
      {x:200,y:270},{x:310,y:120},{x:520,y:90},{x:760,y:150},
      {x:840,y:270},{x:760,y:400},{x:520,y:470},{x:310,y:430},
      {x:200,y:320},{x:180,y:270}
    ],
    // 起点位置与朝向：取 waypoints[0] 附近，朝向指向 wp1
    start:{x:200,y:270,ang: -30},
    // AI 3 辆差异速度 px/s
    aiSpeeds:[238,252,222],
    bg:0x1a2e1a,
    roadColor:0x3a3a3a,
    wallColor:0xd97a2b
  },
  {
    id:2,
    name:'TRACK 2  TIGHT',
    roadW:86,
    // 航点：更窄多弯，含急发夹弯与 S 弯，密度更高
    waypoints:[
      {x:160,y:270},{x:240,y:140},{x:360,y:100},{x:480,y:130},
      {x:560,y:220},{x:520,y:320},{x:460,y:380},{x:380,y:420},
      {x:300,y:380},{x:360,y:300},{x:480,y:260},{x:620,y:240},
      {x:780,y:200},{x:820,y:300},{x:740,y:420},{x:580,y:460},
      {x:400,y:460},{x:220,y:400},{x:160,y:320}
    ],
    start:{x:160,y:270,ang: -45},
    aiSpeeds:[245,258,230],
    bg:0x1e2a3a,
    roadColor:0x2f2f2f,
    wallColor:0xe0a030
  }
];

// ==========================================================================
// 存档与状态缝
// ==========================================================================
var hostRef=null;
var sceneRef=null;
var saveData={bestTime:{1:0,2:0},bestRank:{1:0,2:0}};
function getState(){
  var s=sceneRef;
  if(!s) return {scene:'title',lap:0,speed:0,rank:1,track:1};
  return {
    scene: s.scene.key||'race',
    lap: s.lap||0,
    speed: s.player?Math.round(Math.abs(s.player.speed)):0,
    rank: s.rank||1,
    track: s.trackId||1
  };
}

// ==========================================================================
// Sfx — WebAudio，注释含替换写法
// 将来换 this.load.audio：
//   preload(){ this.load.audio('engine','assets/engine.wav'); }
//   play(n){ this.sound.play(n); }
// 现用 WebAudio：首交互 resume，try/catch 静默降级
// ==========================================================================
var Sfx={
  ctx:null, bgmTimer:null, engineTimer:null,
  ensure:function(){
    try{
      if(!Sfx.ctx){
        var AC=window.AudioContext||window.webkitAudioContext;
        if(!AC) return null;
        Sfx.ctx=new AC();
      }
      if(Sfx.ctx.state==='suspended') Sfx.ctx.resume();
      return Sfx.ctx;
    }catch(e){return null;}
  },
  tone:function(freq,dur,type,vol,slideTo){
    try{
      var ctx=Sfx.ensure(); if(!ctx) return;
      var o=ctx.createOscillator(), g=ctx.createGain();
      o.type=type||'sine'; o.frequency.value=freq;
      if(slideTo) o.frequency.linearRampToValueAtTime(slideTo, ctx.currentTime+dur);
      g.gain.value=vol!=null?vol:0.16;
      g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime+dur);
    }catch(e){}
  },
  play:function(name, opt){
    try{
      if(name==='brake') Sfx.tone(320,0.12,'square',0.14,140);
      else if(name==='drift') Sfx.tone(180,0.18,'sawtooth',0.12,90);
      else if(name==='collide') Sfx.tone(120,0.22,'square',0.22,60);
      else if(name==='overtake'){ Sfx.tone(600,0.10,'sine',0.18,900); setTimeout(function(){Sfx.tone(900,0.14,'sine',0.15);},90); }
      else if(name==='lap'){ Sfx.tone(700,0.12,'sine',0.18,1050); }
      else if(name==='finish'){ Sfx.tone(523,0.14,'sine',0.18); setTimeout(function(){Sfx.tone(659,0.14,'sine',0.18);},130); setTimeout(function(){Sfx.tone(784,0.22,'sine',0.18);},260); }
      else if(name==='countdown'){ Sfx.tone(440,0.12,'square',0.16,660); }
      else if(name==='go'){ Sfx.tone(880,0.28,'square',0.20,660); }
    }catch(e){}
  },
  startBgm:function(scene){
    try{
      Sfx.stopBgm();
      var ctx=Sfx.ensure(); if(!ctx) return;
      var notes=[110,146,164,130];
      var idx=0;
      Sfx.bgmTimer=scene.time.addEvent({delay:520,loop:true,callback:function(){
        try{ Sfx.tone(notes[idx%notes.length],0.18,'triangle',0.045); idx++; }catch(e){}
      }});
      // 引擎嗡鸣：按玩家速度调频
      Sfx.engineTimer=scene.time.addEvent({delay:120,loop:true,callback:function(){
        try{
          var sc=sceneRef; if(!sc||!sc.player) return;
          var sp=Math.abs(sc.player.speed);
          var f=80+sp*0.55;
          // 轻微引擎声，音量随速
          var v=Math.min(0.06, 0.02+sp/6000);
          Sfx.tone(f,0.10,'sawtooth',v, f*1.02);
        }catch(e){}
      }});
    }catch(e){}
  },
  stopBgm:function(){
    try{
      if(Sfx.bgmTimer){ Sfx.bgmTimer.remove(false); Sfx.bgmTimer=null; }
      if(Sfx.engineTimer){ Sfx.engineTimer.remove(false); Sfx.engineTimer=null; }
    }catch(e){}
  }
};

// ==========================================================================
// 工具函数
// ==========================================================================
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function lerp(a,b,t){ return a+(b-a)*t; }
function angDiff(a,b){ var d=b-a; while(d>180) d-=360; while(d<-180) d+=360; return d; }
function dist2(ax,ay,bx,by){ var dx=ax-bx, dy=ay-by; return dx*dx+dy*dy; }
function len2D(x,y){ return Math.sqrt(x*x+y*y); }


// ==========================================================================
// 赛道几何辅助
// ==========================================================================
/** 点到线段最近距离及最近点法线
 * @returns {{dist:number, nx:number, ny:number, cx:number, cy:number}}
 */
function closestToSegment(px,py, ax,ay, bx,by){
  var abx=bx-ax, aby=by-ay;
  var apx=px-ax, apy=py-ay;
  var ab2=abx*abx+aby*aby;
  var t=ab2===0?0:(apx*abx+apy*aby)/ab2;
  if(t<0) t=0; else if(t>1) t=1;
  var cx=ax+abx*t, cy=ay+aby*t;
  var dx=px-cx, dy=py-cy;
  var d=Math.sqrt(dx*dx+dy*dy);
  var nx=0,ny=0;
  if(d>0.001){ nx=dx/d; ny=dy/d; }
  return {dist:d, nx:nx, ny:ny, cx:cx, cy:cy};
}
/** 点到闭环中线最近距离及法线（用于墙碰撞） */
function distToCenterline(px,py, waypoints){
  var best={dist:1e9, nx:0, ny:0, cx:px, cy:py};
  for(var i=0;i<waypoints.length;i++){
    var a=waypoints[i], b=waypoints[(i+1)%waypoints.length];
    var r=closestToSegment(px,py, a.x,a.y, b.x,b.y);
    if(r.dist<best.dist) best=r;
  }
  return best;
}
/** 计算给定点在赛道中线上的进度(0~wpCount) — 用于名次排序 */
function progressAlongTrack(x,y, waypoints){
  // 找到最近段及段内 t，再算总段长比例
  var bestT=0, bestIdx=0, bestD=1e9;
  var totalLen=0;
  var segLens=[];
  for(var i=0;i<waypoints.length;i++){
    var a=waypoints[i], b=waypoints[(i+1)%waypoints.length];
    var dx=b.x-a.x, dy=b.y-a.y;
    var l=Math.sqrt(dx*dx+dy*dy);
    segLens.push(l); totalLen+=l;
  }
  var acc=0;
  for(var i2=0;i2<waypoints.length;i2++){
    var a2=waypoints[i2], b2=waypoints[(i2+1)%waypoints.length];
    var abx=b2.x-a2.x, aby=b2.y-a2.y;
    var apx=x-a2.x, apy=y-a2.y;
    var ab2=abx*abx+aby*aby;
    var t2=ab2===0?0:(apx*abx+apy*aby)/ab2;
    t2=Math.max(0,Math.min(1,t2));
    var cx2=a2.x+abx*t2, cy2=a2.y+aby*t2;
    var d2=(x-cx2)*(x-cx2)+(y-cy2)*(y-cy2);
    if(d2<bestD){ bestD=d2; bestIdx=i2; bestT=t2; }
  }
  // 进度 = 段前累计 + t*段长，再归一到 0~wpCount
  var prog=0;
  for(var k=0;k<bestIdx;k++) prog+=segLens[k];
  prog+=segLens[bestIdx]*bestT;
  // 转为航点计数单位
  return prog/totalLen * waypoints.length;
}

// ==========================================================================
// 车辆构造与池化 — 纯几何+粒子池
// ==========================================================================
/** 创建车辆状态对象（非 Phaser 对象，纯数据） */
function makeCar(x,y,ang){
  return {
    x:x, y:y,
    ang:ang,            // 车头朝向 deg
    speed:0,            // 前进速度 px/s（负为倒车）
    drift:0,            // 横滑角 deg，handbrake 时累积
    spin:0,             // 角速度 deg/s（漂移时残留）
    lap:0,              // 已完成圈数
    nextWp:1,           // 下一检查点索引
    checkpoints:0,      // 已过检查点计数(用于防切线)
    progress:0,         // 总进度浮点
    finished:false,
    finishTime:0,
    overtakeCooldown:0,
    wallCooldown:0
  };
}
/** 根据 car 状态更新 Phaser 容器位置 */
function syncCarSprite(car, sprite){
  sprite.x=car.x; sprite.y=car.y;
  sprite.setAngle(car.ang + car.drift*0.35);
}

// ==========================================================================
// 纹理生成 — 纯几何，generateTexture
// 中文注释标出替换点：换成 this.load.image('car_player','assets/...')
// ==========================================================================
function buildCarTextures(scene){
  function ensure(k){ if(scene.textures.exists(k)) scene.textures.remove(k); }
  var g;
  // 玩家车：蓝底红条纹 + 4 轮 + 驾驶舱
  ensure('car_player');
  g=scene.add.graphics();
  g.fillStyle(0x1a1a1a,1); // 4 轮阴影
  g.fillRoundedRect(2,2, CAR_LEN-4, CAR_WID-4, 3);
  g.fillStyle(0x2e7af0,1); // 车身
  g.fillRoundedRect(1,3, CAR_LEN-2, CAR_WID-6, 4);
  g.fillStyle(0xffffff,0.95); // 车头灯
  g.fillCircle(CAR_LEN-3, 5, 2); g.fillCircle(CAR_LEN-3, CAR_WID-5, 2);
  g.fillStyle(0xff3b3b,1); // 尾灯
  g.fillCircle(3, 5, 1.8); g.fillCircle(3, CAR_WID-5, 1.8);
  g.fillStyle(0x0d1b3a,1); // 驾驶舱
  g.fillRoundedRect(CAR_LEN*0.42, 4, 8, CAR_WID-8, 2);
  g.lineStyle(1, 0xffffff, 0.18); g.strokeRoundedRect(1,3, CAR_LEN-2, CAR_WID-6, 4);
  g.generateTexture('car_player', CAR_LEN, CAR_WID);
  g.destroy();
  // AI 车1 红
  ensure('car_ai1');
  g=scene.add.graphics();
  g.fillStyle(0x1a1a1a,1); g.fillRoundedRect(2,2, CAR_LEN-4, CAR_WID-4, 3);
  g.fillStyle(0xe53935,1); g.fillRoundedRect(1,3, CAR_LEN-2, CAR_WID-6, 4);
  g.fillStyle(0xffffff,0.95); g.fillCircle(CAR_LEN-3,5,2); g.fillCircle(CAR_LEN-3,CAR_WID-5,2);
  g.fillStyle(0x222222,1); g.fillRoundedRect(CAR_LEN*0.42,4,8,CAR_WID-8,2);
  g.generateTexture('car_ai1', CAR_LEN, CAR_WID);
  g.destroy();
  // AI 车2 黄
  ensure('car_ai2');
  g=scene.add.graphics();
  g.fillStyle(0x1a1a1a,1); g.fillRoundedRect(2,2, CAR_LEN-4, CAR_WID-4, 3);
  g.fillStyle(0xf5b400,1); g.fillRoundedRect(1,3, CAR_LEN-2, CAR_WID-6, 4);
  g.fillStyle(0xffffff,0.95); g.fillCircle(CAR_LEN-3,5,2); g.fillCircle(CAR_LEN-3,CAR_WID-5,2);
  g.fillStyle(0x222222,1); g.fillRoundedRect(CAR_LEN*0.42,4,8,CAR_WID-8,2);
  g.generateTexture('car_ai2', CAR_LEN, CAR_WID);
  g.destroy();
  // AI 车3 绿
  ensure('car_ai3');
  g=scene.add.graphics();
  g.fillStyle(0x1a1a1a,1); g.fillRoundedRect(2,2, CAR_LEN-4, CAR_WID-4, 3);
  g.fillStyle(0x43a047,1); g.fillRoundedRect(1,3, CAR_LEN-2, CAR_WID-6, 4);
  g.fillStyle(0xffffff,0.95); g.fillCircle(CAR_LEN-3,5,2); g.fillCircle(CAR_LEN-3,CAR_WID-5,2);
  g.fillStyle(0x222222,1); g.fillRoundedRect(CAR_LEN*0.42,4,8,CAR_WID-8,2);
  g.generateTexture('car_ai3', CAR_LEN, CAR_WID);
  g.destroy();
  // 粒子：烟雾
  ensure('particle_smoke');
  g=scene.add.graphics();
  g.fillStyle(0x999999,1); g.fillCircle(4,4,3.5);
  g.fillStyle(0xbbbbbb,0.9); g.fillCircle(4,4,2);
  g.generateTexture('particle_smoke', 8,8);
  g.destroy();
  // 粒子：火花
  ensure('particle_spark');
  g=scene.add.graphics();
  g.fillStyle(0xffcc00,1); g.fillCircle(3,3,2.5);
  g.fillStyle(0xffffff,1); g.fillCircle(3,3,1);
  g.generateTexture('particle_spark', 6,6);
  g.destroy();
}

// ==========================================================================
// 粒子池 — 复用 Image 对象，避免每帧 new
// ==========================================================================
function makePool(scene){
  return {
    scene:scene,
    pool:[],
    get:function(tex){
      for(var i=0;i<this.pool.length;i++){
        var it=this.pool[i];
        if(!it.active){
          it.setTexture(tex); it.setVisible(true); it.setActive(true);
          it.setAlpha(0.9); it.setScale(1);
          return it;
        }
      }
      var img=scene.add.image(-100,-100, tex);
      img.setDepth(12); img.setActive(true);
      this.pool.push(img);
      return img;
    },
    release:function(img){
      img.setActive(false); img.setVisible(false);
      img.x=-100; img.y=-100;
    },
    update:function(dt){
      for(var i=0;i<this.pool.length;i++){
        var it=this.pool[i];
        if(!it.active) continue;
        // 由外部 tween 驱动，这里仅做生命周期清理兜底
        // 透明/缩放由 tween 控制
      }
    }
  };
}

// ==========================================================================
// Boot / Menu
// ==========================================================================
var BootScene = class extends Phaser.Scene {
  constructor(){ super('boot'); }
  create(){
    var self=this;
    hostRef = this.registry.get('hostRef') || hostRef;
    // 尝试读取存档
    if(hostRef && typeof hostRef.loadState==='function'){
      try{
        hostRef.loadState().then(function(data){
          if(data && data.bestTime) saveData.bestTime=data.bestTime;
          if(data && data.bestRank) saveData.bestRank=data.bestRank;
          self.scene.start('menu');
        }, function(){ self.scene.start('menu'); });
      }catch(e){ self.scene.start('menu'); }
    } else {
      this.scene.start('menu');
    }
  }
};

var MenuScene = class extends Phaser.Scene {
  constructor(){ super('menu'); }
  create(){
    sceneRef=this;
    // 背景
    this.cameras.main.setBackgroundColor('#0f1820');
    buildCarTextures(this);
    var cx=CW/2, cy=CH/2;
    this.add.text(cx, 64, 'RACING  TOPDOWN', {fontFamily:'monospace',fontSize:'28px',color:'#ffffff',fontStyle:'bold'}).setOrigin(0.5);
    this.add.text(cx, 100, 'Top-Down Circuit  •  3 Laps  •  Drift with SPACE', {fontFamily:'monospace',fontSize:'12px',color:'#8aa0b8'}).setOrigin(0.5);
    this.add.text(cx, 124, 'Arrow/WASD  Steer  •  UP/W Throttle  DOWN/S Brake/Reverse', {fontFamily:'monospace',fontSize:'11px',color:'#6a7d94'}).setOrigin(0.5);
    // 赛道卡片
    var cards=[];
    for(var i=0;i<TRACKS.length;i++){
      (function(idx){
        var tr=TRACKS[idx];
        var x = 220 + idx*520; // will be 220 and 740 but second may overflow; adjust
        if(TRACKS.length===2) x = 260 + idx*440;
        var y=260;
        var bg = this.add.graphics();
        bg.fillStyle(idx===0?0x2a4a2a:0x2a3a56,1);
        bg.fillRoundedRect(x-150,y-90,300,190,12);
        bg.lineStyle(2, tr.wallColor, 0.9);
        bg.strokeRoundedRect(x-150,y-90,300,190,12);
        bg.setDepth(1);
        // 赛道缩略：用 Graphics 画中线
        var g=this.add.graphics(); g.setDepth(2);
        g.lineStyle(tr.roadW*0.18, tr.roadColor, 1);
        g.beginPath();
        for(var k=0;k<tr.waypoints.length;k++){
          var wp=tr.waypoints[k];
          // 缩放映射到卡片内
          var sx = x + (wp.x - 490)*0.16;
          var sy = y + (wp.y - 270)*0.16;
          if(k===0) g.moveTo(sx,sy); else g.lineTo(sx,sy);
        }
        g.closePath(); g.strokePath();
        // 起点点
        var sp=tr.start;
        var sxs= x + (sp.x-490)*0.16, sys= y + (sp.y-270)*0.16;
        g.fillStyle(0xffffff,1); g.fillCircle(sxs,sys,3);
        g.fillStyle(0x000000,1); g.fillRect(sxs-6,sys-1,12,2);
        this.add.text(x, y-64, tr.name, {fontFamily:'monospace',fontSize:'13px',color:'#ffffff',fontStyle:'bold'}).setOrigin(0.5).setDepth(3);
        this.add.text(x, y-46, (idx===0?'Wide Oval  Easy':'Tight  Hairpins  Narrow'), {fontFamily:'monospace',fontSize:'10px',color:'#a0b8d0'}).setOrigin(0.5).setDepth(3);
        var bt=saveData.bestTime[tr.id]||0;
        var br=saveData.bestRank[tr.id]||0;
        var btStr = bt? (Math.floor(bt/1000)+'.'+String(Math.floor((bt%1000)/10)).padStart(2,'0')+'s') : '--';
        this.add.text(x, y+52, 'BEST  '+btStr+'   RANK '+ (br||'-'), {fontFamily:'monospace',fontSize:'11px',color:'#ffd54f'}).setOrigin(0.5).setDepth(3);
        // 点击区域
        var zone=this.add.zone(x,y,300,190).setOrigin(0.5).setInteractive({useHandCursor:true}).setDepth(4);
        zone.on('pointerdown', function(){
          Sfx.play('go');
          // 消解 Sfx ctx
          Sfx.ensure();
          this.scene.start('race', {trackId: tr.id});
        }, this);
        zone.on('pointerover', function(){ bg.clear(); bg.fillStyle(0x3a5a6a,1); bg.fillRoundedRect(x-150,y-90,300,190,12); bg.lineStyle(3, 0xffffff, 0.9); bg.strokeRoundedRect(x-150,y-90,300,190,12); });
        zone.on('pointerout', function(){ bg.clear(); bg.fillStyle(idx===0?0x2a4a2a:0x2a3a56,1); bg.fillRoundedRect(x-150,y-90,300,190,12); bg.lineStyle(2, tr.wallColor, 0.9); bg.strokeRoundedRect(x-150,y-90,300,190,12); });
        cards.push(zone);
      }).call(this, i);
    }
    this.add.text(cx, 420, 'Click a track  •  [1]/[2] quick start  •  [F] toggle waypoint debug in race', {fontFamily:'monospace',fontSize:'11px',color:'#6a7d94'}).setOrigin(0.5);
    this.add.text(cx, 440, 'SPACE = Handbrake Drift  •  Finish 3 laps to save Best Time', {fontFamily:'monospace',fontSize:'11px',color:'#6a7d94'}).setOrigin(0.5);
    this.input.keyboard.on('keydown-ONE', function(){ this.scene.start('race',{trackId:1}); }, this);
    this.input.keyboard.on('keydown-TWO', function(){ this.scene.start('race',{trackId:2}); }, this);
    this.input.keyboard.on('keydown-NUMPAD_ONE', function(){ this.scene.start('race',{trackId:1}); }, this);
    this.input.keyboard.on('keydown-NUMPAD_TWO', function(){ this.scene.start('race',{trackId:2}); }, this);
  }
};
// ==========================================================================
// Race Scene — 核心玩法
// ==========================================================================
var RaceScene = class extends Phaser.Scene {
  constructor(){ super('race'); }
  init(data){
    this.trackId = (data && data.trackId) ? data.trackId : 1;
    this.track = TRACKS[this.trackId===2?1:0];
  }
  create(){
    sceneRef=this;
    var tr=this.track;
    this.w=CW; this.h=CH;
    this.cameras.main.setBackgroundColor(Phaser.Display.Color.IntegerToColor(tr.bg).rgba);
    // 生成纹理 — 替换点：换成 this.load.image('car_*','assets/...')
    buildCarTextures(this);

    // 赛道绘制 — Graphics 草地+路面+路肩+起点线
    // 替换点：换成 this.add.image(CW/2,CH/2,'track_bg') + Tiled 碰撞层
    this.trackG = this.add.graphics().setDepth(1);
    this.wallG = this.add.graphics().setDepth(2);
    this.drawTrack();

    // 粒子池
    this.pool = makePool(this);
    this.sparkTime=0;

    // 玩家车数据 + 精灵
    var st=tr.start;
    this.player = makeCar(st.x, st.y, st.ang);
    this.playerSprite = this.add.image(st.x, st.y, 'car_player').setDepth(8).setAngle(st.ang);
    this.playerSprite.setOrigin(0.5,0.5);

    // AI 车 2-3 辆 — 起点后方错位发车
    this.aiCars=[]; this.aiSprites=[];
    var aiCount=3;
    var aiTexKeys=['car_ai1','car_ai2','car_ai3'];
    for(var i=0;i<aiCount;i++){
      var offX = - (i+1)*26; // 起点后方
      var offY = (i-1)*18;   // 横向错开
      var ac=makeCar(st.x+offX, st.y+offY, st.ang + (Math.random()*6-3));
      ac.maxSpeed = tr.aiSpeeds[i % tr.aiSpeeds.length] * (0.96 + Math.random()*0.08);
      ac.baseSpeed = ac.maxSpeed;
      // AI 航点索引错开，避免堆叠
      ac.nextWp = 1 + (i%2);
      ac._wobble = Math.random()*Math.PI*2;
      ac.aiSpeedScale = 0.85 + Math.random()*0.15;
      this.aiCars.push(ac);
      var sp=this.add.image(ac.x, ac.y, aiTexKeys[i]).setDepth(8).setAngle(ac.ang);
      this.aiSprites.push(sp);
    }

    // 航点调试层（默认关闭，D 切换）— 注释替换点：asset 'waypoint' 贴图
    this.showWaypoints=false;
    this.wpG=this.add.graphics().setDepth(6);
    this.wpG.setVisible(false);

    // 小地图 — 右上角缩略
    this.miniG=this.add.graphics().setDepth(9);
    this.miniX=CW-108; this.miniY=14; this.miniW=96; this.miniH=62;
    this.drawMinimap();

    // 输入
    this.keys = this.input.keyboard.addKeys({
      UP:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      DOWN:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      LEFT:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      RIGHT:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      W:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      SPACE:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      DEBUG:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.F),
      R:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R),
      M:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.M),
      ESC:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC),
      ONE:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ONE),
      TWO:this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.TWO)
    });
    // D 键双重：既是右转向也是航点调试切换 — 用单次 JustDown 切换调试时不影响转向
    // DEBUG=F 航点可视切换，不占转向键

    // 状态
    this.lap=0; this.totalLaps=TOTAL_LAPS;
    this.rank=1; this.prevRank=1;
    this.timeMs=0; this.raceState='countdown'; // countdown|racing|finished
    this.countdownMs=3000; this.countdownVal=3;
    this.finishTime=0; this.bestLapTime=0;
    this.overtakes=0; this.collisions=0;
    this.paused=false;
    this._lastOvertakeCheckRank=1;
    this._playerProgress=0; this._playerWpPassed=0;

    // 起点/终点线段（waypoints[0] 附近法线段，用于圈数判定）
    var wp0=tr.waypoints[0], wp1=tr.waypoints[1];
    var dx=wp1.x-wp0.x, dy=wp1.y-wp0.y;
    var len=Math.sqrt(dx*dx+dy*dy)||1;
    // 法线
    var fnx=-dy/len, fny=dx/len;
    var halfW=tr.roadW/2;
    this.finishA={x:wp0.x+fnx*halfW, y:wp0.y+fny*halfW};
    this.finishB={x:wp0.x-fnx*halfW, y:wp0.y-fny*halfW};
    // 起点朝向向量
    this.startDir={x:dx/len, y:dy/len};
    // 圈数检查点：把赛道分成 4 段，必经检查点防切线
    this.checkpointIdxs=this.buildCheckpoints();

    // HUD
    this.hudG=this.add.graphics().setDepth(10);
    this.hudG.fillStyle(0x000000,0.42); this.hudG.fillRoundedRect(8,8,220,108,8);
    this.hudText=this.add.text(16,14,'',{fontFamily:'monospace',fontSize:'12px',color:'#ffffff',lineSpacing:4}).setDepth(11);
    this.centerText=this.add.text(CW/2, CH/2 - 40,'',{fontFamily:'monospace',fontSize:'42px',color:'#ffffff',fontStyle:'bold',stroke:'#000000',strokeThickness:6}).setOrigin(0.5).setDepth(11);
    this.centerSub=this.add.text(CW/2, CH/2 + 22,'',{fontFamily:'monospace',fontSize:'13px',color:'#ffd54f'}).setOrigin(0.5).setDepth(11);
    // 速度条
    this.speedBarBg=this.add.graphics().setDepth(10);
    this.speedBarFg=this.add.graphics().setDepth(11);
    // 漂移指示
    this.driftText=this.add.text(CW/2, CH-28,'',{fontFamily:'monospace',fontSize:'12px',color:'#ff9100',fontStyle:'bold'}).setOrigin(0.5).setDepth(11);

    Sfx.startBgm(this);
    this.updateHud(true);
    this.showCountdown(3);

    // 键盘一次性切换航点调试（D 长按不抖动）
    var self=this;
    // DEBUG 切换在 update 中 JustDown(DEBUG) 处理
    // 用 update 中 JustDown 检测
  }

  buildCheckpoints(){
    var n=this.track.waypoints.length;
    // 4 个检查点均分
    var idxs=[];
    for(var i=0;i<4;i++) idxs.push(Math.floor(i*n/4));
    return idxs;
  }

  drawTrack(){
    var tr=this.track;
    var wps=tr.waypoints;
    var g=this.trackG;
    var wg=this.wallG;
    g.clear(); wg.clear();
    // 草地底
    g.fillStyle(tr.bg,1); g.fillRect(0,0,CW,CH);
    // 路面：用一系列粗线段连成闭环，路宽可变
    // 每段微调宽度：roadW * (0.92~1.06) 制造可变路宽手感
    g.lineStyle(1, 0x000000, 0);
    // 先画路基（双色路肩）
    for(var i=0;i<wps.length;i++){
      var a=wps[i], b=wps[(i+1)%wps.length];
      var w = tr.roadW * (0.90 + 0.16*Math.abs(Math.sin(i*1.7)));
      // 外路肩 橙白间隔 — 用两条平行细线模拟
      g.lineStyle(w+12, 0xcc6a1a, 1);
      g.beginPath(); g.moveTo(a.x,a.y); g.lineTo(b.x,b.y); g.strokePath();
      g.lineStyle(w+6, 0xffffff, 0.95);
      g.beginPath(); g.moveTo(a.x,a.y); g.lineTo(b.x,b.y); g.strokePath();
    }
    // 路面主体
    for(var i2=0;i2<wps.length;i2++){
      var a2=wps[i2], b2=wps[(i2+1)%wps.length];
      var w2 = tr.roadW * (0.90 + 0.16*Math.abs(Math.sin(i2*1.7)));
      g.lineStyle(w2, tr.roadColor, 1);
      g.beginPath(); g.moveTo(a2.x,a2.y); g.lineTo(b2.x,b2.y); g.strokePath();
      // 中线虚线
      g.lineStyle(2, 0xffffff, 0.42);
      var mx=(a2.x+b2.x)/2, my=(a2.y+b2.y)/2;
      g.beginPath(); g.moveTo(mx,my); g.lineTo(mx+0.1,my+0.1); g.strokePath();
    }
    // 起点线：黑白棋盘
    var st=tr.start;
    var fa=this.finishA, fb=this.finishB;
    if(fa && fb){
      g.lineStyle(3, 0xffffff, 1);
      g.beginPath(); g.moveTo(fa.x,fa.y); g.lineTo(fb.x,fb.y); g.strokePath();
      // 棋盘格
      var segs=8;
      for(var k=0;k<segs;k++){
        var t=k/segs, t2=(k+1)/segs;
        var x1=fa.x+(fb.x-fa.x)*t, y1=fa.y+(fb.y-fa.y)*t;
        var x2=fa.x+(fb.x-fa.x)*t2, y2=fa.y+(fb.y-fa.y)*t2;
        g.fillStyle(k%2===0?0xffffff:0x111111,1);
        // 用小矩形近似
        var cx=(x1+x2)/2, cy=(y1+y2)/2;
        var ang=Math.atan2(fb.y-fa.y, fb.x-fa.x);
        // 简化：画小方块
        g.fillRect(cx-5, cy-3, 10, 6);
      }
    }
    // 外墙/内墙：沿中线法线偏移绘制橙色墙线（视觉+碰撞均用 distToCenterline）
    wg.lineStyle(4, tr.wallColor, 1);
    wg.beginPath();
    for(var j=0;j<wps.length;j++){
      var pa=wps[j], pb=wps[(j+1)%wps.length];
      // 外墙点 = 中线 + 法线*halfW
      var dx2=pb.x-pa.x, dy2=pb.y-pa.y;
      var len2=Math.sqrt(dx2*dx2+dy2*dy2)||1;
      var nx=-dy2/len2, ny=dx2/len2;
      var half=tr.roadW/2;
      var ox = pa.x + nx*half, oy= pa.y + ny*half;
      // 内墙隔一段取反
      if(j===0) wg.moveTo(ox,oy); else wg.lineTo(ox,oy);
    }
    wg.closePath(); wg.strokePath();
    // 内墙
    wg.lineStyle(4, tr.wallColor, 0.92);
    wg.beginPath();
    for(var j2=0;j2<wps.length;j2++){
      var pa2=wps[j2], pb2=wps[(j2+1)%wps.length];
      var dx3=pb2.x-pa2.x, dy3=pb2.y-pa2.y;
      var len3=Math.sqrt(dx3*dx3+dy3*dy3)||1;
      var nx3=-dy3/len3, ny3=dx3/len3;
      var half3=tr.roadW/2;
      var ix = pa2.x - nx3*half3, iy= pa2.y - ny3*half3;
      if(j2===0) wg.moveTo(ix,iy); else wg.lineTo(ix,iy);
    }
    wg.closePath(); wg.strokePath();
    // 轮胎印装饰（随机短线）
    g.lineStyle(1, 0x111111, 0.12);
    for(var r=0;r<18;r++){
      var wp=wps[r%wps.length];
      var rx=wp.x + (Math.random()-0.5)*24;
      var ry=wp.y + (Math.random()-0.5)*24;
      g.beginPath(); g.moveTo(rx,ry); g.lineTo(rx+6,ry+2); g.strokePath();
    }
  }

  drawMinimap(){
    var tr=this.track;
    var g=this.miniG;
    g.clear();
    g.fillStyle(0x000000,0.52); g.fillRoundedRect(this.miniX,this.miniY,this.miniW,this.miniH,6);
    g.lineStyle(1, 0xffffff, 0.18); g.strokeRoundedRect(this.miniX,this.miniY,this.miniW,this.miniH,6);
    // 路面缩略
    var minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    for(var i=0;i<tr.waypoints.length;i++){ var wp=tr.waypoints[i]; if(wp.x<minX)minX=wp.x; if(wp.x>maxX)maxX=wp.x; if(wp.y<minY)minY=wp.y; if(wp.y>maxY)maxY=wp.y; }
    var pad=12;
    var sx=this.miniW/(maxX-minX+pad*2), sy=this.miniH/(maxY-minY+pad*2);
    var sc=Math.min(sx,sy)*0.92;
    var ox=this.miniX+this.miniW/2, oy=this.miniY+this.miniH/2;
    var cx=(minX+maxX)/2, cy=(minY+maxY)/2;
    g.lineStyle(3, 0x6a6a6a, 1);
    g.beginPath();
    for(var k=0;k<tr.waypoints.length;k++){
      var w2=tr.waypoints[k];
      var px= ox + (w2.x-cx)*sc;
      var py= oy + (w2.y-cy)*sc;
      if(k===0) g.moveTo(px,py); else g.lineTo(px,py);
    }
    g.closePath(); g.strokePath();
    // 存储映射供 update 绘制车辆点
    this.miniMap={cx:cx, cy:cy, sc:sc, ox:ox, oy:oy};
  }

  showCountdown(n){
    this.centerText.setText(String(n));
    this.centerText.setVisible(true);
    this.centerSub.setText(n===3?'GET READY':'');
    this.centerSub.setVisible(true);
    Sfx.play('countdown');
    var self=this;
    this.tweens.add({targets:this.centerText, scale:1.25, duration:180, yoyo:true, ease:'Sine.easeOut'});
  }

  updateHud(force){
    var sp=Math.round(Math.abs(this.player?this.player.speed:0));
    var lapStr=this.raceState==='finished'? ('FINISHED  '+ (this.finishTime/1000).toFixed(2)+'s') : ('LAP '+ (this.lap+1)+'/'+this.totalLaps);
    var rankStr='RANK '+this.rank+'/4';
    var timeStr=(this.timeMs/1000).toFixed(1)+'s';
    var otStr='Overtakes: '+this.overtakes;
    var txt = rankStr+'   '+lapStr+'\nTIME '+timeStr+'   SPD '+sp+'\n'+otStr;
    if(this.raceState==='countdown') txt+='\nGET READY...';
    if(this.raceState==='finished') txt+='\nPress R : Restart   M : Menu   1/2 : Track';
    if(txt!==this._hudCache || force){ this._hudCache=txt; this.hudText.setText(txt); }
    // 速度条
    var pct=clamp(sp / P_MAX_SPEED, 0, 1);
    this.speedBarBg.clear(); this.speedBarBg.fillStyle(0x000000,0.45); this.speedBarBg.fillRoundedRect(8, 126, 220, 10, 5);
    this.speedBarFg.clear();
    var col = pct>0.85?0xff3b3b : (pct>0.55?0xffd54f:0x4fc3f7);
    this.speedBarFg.fillStyle(col,1); this.speedBarFg.fillRoundedRect(8,126, 220*pct,10,5);
    // 漂移指示
    var isDrift = this.player && Math.abs(this.player.drift)>12;
    this.driftText.setText(isDrift ? 'DRIFT!  '+ Math.round(this.player.drift)+'°' : '');
    this.driftText.setColor(isDrift ? '#ff9100' : '#ffffff');
    // 小地图车辆点
    this.drawMinimapCars();
  }

  drawMinimapCars(){
    if(!this.miniMap) return;
    var g=this.miniG;
    // 清除旧点：重画底后叠加
    // 简化：每帧重画 minimap 底 + 点
    this.drawMinimap();
    var mp=this.miniMap;
    function dot(x,y,color){
      g.fillStyle(color,1); g.fillCircle(mp.ox+(x-mp.cx)*mp.sc, mp.oy+(y-mp.cy)*mp.sc, 2.4);
    }
    dot(this.player.x, this.player.y, 0x2e7af0);
    for(var i=0;i<this.aiCars.length;i++){
      var ac=this.aiCars[i];
      var col = i===0?0xe53935 : (i===1?0xf5b400:0x43a047);
      dot(ac.x, ac.y, col);
    }
  }

  // 墙碰撞：若到中线距离 > halfW - CAR_RADIUS，则推回并减速
  handleWall(car, isPlayer){
    var tr=this.track;
    var half=tr.roadW/2;
    var d = distToCenterline(car.x, car.y, tr.waypoints);
    var limit = half - CAR_RADIUS;
    if(d.dist > limit){
      var penetration = d.dist - limit;
      // 推回
      car.x -= d.nx * (penetration + 1.2);
      car.y -= d.ny * (penetration + 1.2);
      // 速度损失
      var sp=Math.abs(car.speed);
      var loss = WALL_SPEED_LOSS + Math.min(0.25, sp/800);
      car.speed *= (1-loss);
      if(sp>80 && car.wallCooldown<=0){
        Sfx.play('collide');
        car.wallCooldown=320;
        // 火花粒子
        this.spawnWallSparks(car.x + d.nx*6, car.y + d.ny*6);
      }
      // 横滑角扰动
      car.drift += (Math.random()-0.5)*10;
      car.spin += (Math.random()-0.5)*90;
      if(isPlayer) this.collisions++;
      return true;
    }
    return false;
  }

  spawnWallSparks(x,y){
    for(var i=0;i<5;i++){
      var p=this.pool.get('particle_spark');
      p.x=x + (Math.random()-0.5)*8; p.y=y + (Math.random()-0.5)*8;
      p.setAlpha(1); p.setScale(0.9+Math.random()*0.5);
      this.tweens.add({targets:p, alpha:0, scale:0.2, duration:260+Math.random()*120, onComplete:(function(img){ return function(){ this.pool.release(img); }; }.call(this, p)).bind(this)});
    }
  }
  spawnDriftSmoke(x,y){
    var p=this.pool.get('particle_smoke');
    p.x=x; p.y=y; p.setAlpha(0.55); p.setScale(0.5);
    this.tweens.add({targets:p, alpha:0, scale:1.4, duration:420, onComplete:(function(img){ return function(){ this.pool.release(img); }; }.call(this,p)).bind(this)});
  }

  // 车体互碰：圆近似，击退
  handleCarCollisions(){
    var cars=[this.player].concat(this.aiCars);
    var sprites=[this.playerSprite].concat(this.aiSprites);
    for(var i=0;i<cars.length;i++){
      for(var j=i+1;j<cars.length;j++){
        var a=cars[i], b=cars[j];
        var dx=b.x-a.x, dy=b.y-a.y;
        var d2=dx*dx+dy*dy;
        var minD=CAR_LEN*0.72; // 碰撞阈值
        if(d2 < minD*minD && d2>0.01){
          var d=Math.sqrt(d2);
          var nx=dx/d, ny=dy/d;
          var overlap=(minD-d);
          // 互推
          var push=overlap*0.52;
          a.x -= nx*push; a.y -= ny*push;
          b.x += nx*push; b.y += ny*push;
          // 速度交换/击退
          var rel = (a.speed - b.speed)*0.18;
          a.speed -= rel + CAR_KNOCK*0.12;
          b.speed += rel - CAR_KNOCK*0.12;
          // 旋转扰动
          a.spin += (Math.random()-0.5)*120;
          b.spin += (Math.random()-0.5)*120;
          if(i===0 || j===0){
            // 玩家参与
            if(this.player.wallCooldown<=0){
              Sfx.play('collide');
              this.player.wallCooldown=220;
            }
          }
        }
      }
    }
  }

  // 越终点线判定（有向）：点在终点段两侧且运动方向与起跑方向同向 + 已过足够检查点
  checkLap(car, prevX, prevY){
    var fa=this.finishA, fb=this.finishB;
    // 线段法线方向为起跑方向的垂直，这里用叉积判断是否跨线
    function side(x,y){
      // 有向：(fb-fa) x (p-fa)
      return (fb.x-fa.x)*(y-fa.y) - (fb.y-fa.y)*(x-fa.x);
    }
    var s0=side(prevX, prevY);
    var s1=side(car.x, car.y);
    if(s0===0||s1===0) return false;
    // 跨线：异号
    if(s0*s1 >=0) return false;
    // 方向：位移点积起跑方向 >0
    var mx=car.x-prevX, my=car.y-prevY;
    if(mx*this.startDir.x + my*this.startDir.y <= 0) return false;
    // 防切线：必须已访问至少 2 个检查点
    if(car.checkpoints < 2) return false;
    // 且距离终点段中点足够近（防平行线误触）
    var midx=(fa.x+fb.x)/2, midy=(fa.y+fb.y)/2;
    var d2=dist2(car.x,car.y,midx,midy);
    if(d2 > (this.track.roadW*0.9)*(this.track.roadW*0.9)) return false;
    return true;
  }

  // 更新圈数与排名
  updateRaceProgress(prevPx, prevPy){
    // 检查点经过：距离最近检查点 < 42
    var tr=this.track;
    for(var ci=0;ci<this.checkpointIdxs.length;ci++){
      var idx=this.checkpointIdxs[ci];
      var wp=tr.waypoints[idx];
      if(dist2(this.player.x,this.player.y, wp.x,wp.y) < 42*42){
        // 标记访问
        if(this.player._visited==null) this.player._visited={};
        this.player._visited[idx]=1;
      }
    }
    var visitedCount=0;
    if(this.player._visited) for(var k in this.player._visited) visitedCount++;
    this.player.checkpoints=visitedCount;

    // 圈数
    if(this.raceState==='racing' && this.checkLap(this.player, prevPx, prevPy)){
      this.lap++;
      this.player.checkpoints=0; this.player._visited={};
      // 进度重置用
      this.player.progress += tr.waypoints.length;
      Sfx.play(this.lap>=this.totalLaps ? 'finish' : 'lap');
      if(this.lap>=this.totalLaps){
        this.raceState='finished';
        this.finishTime=this.timeMs;
        this.rank=this.computeRank();
        this.onFinish();
      }
    }
    // AI 圈数
    for(var i=0;i<this.aiCars.length;i++){
      var ac=this.aiCars[i];
      if(ac.finished) continue;
      // 检查点
      for(var ci2=0;ci2<this.checkpointIdxs.length;ci2++){
        var idx2=this.checkpointIdxs[ci2];
        var wp2=tr.waypoints[idx2];
        if(dist2(ac.x,ac.y, wp2.x,wp2.y) < 46*46){
          if(ac._visited==null) ac._visited={};
          ac._visited[idx2]=1;
        }
      }
      var vc2=0; if(ac._visited) for(var kk in ac._visited) vc2++;
      ac.checkpoints=vc2;
      // 用 prev 存于 ac._prev
      var px2=ac._prevX!=null?ac._prevX:ac.x, py2=ac._prevY!=null?ac._prevY:ac.y;
      if(this.checkLap(ac, px2, py2)){
        ac.lap = (ac.lap||0)+1;
        ac._visited={}; ac.checkpoints=0;
        ac.progress = (ac.progress||0)+tr.waypoints.length;
        if(ac.lap>=this.totalLaps){
          ac.finished=true; ac.finishTime=this.timeMs + (Math.random()*420-210);
        }
      }
    }
    // 排名：按 (lap*wpCount + progress) 排序，progress 用 progressAlongTrack
    this.rank=this.computeRank();
    // 超车加分：rank 变小
    if(this.prevRank!=null && this.rank < this.prevRank){
      this.overtakes++;
      Sfx.play('overtake');
      var pts=OVERTAKE_SCORE;
      // 飘字
      var t=this.add.text(CW/2, 92, '+'+pts+'  OVERTAKE!', {fontFamily:'monospace',fontSize:'16px',color:'#00e676',fontStyle:'bold',stroke:'#000000',strokeThickness:4}).setOrigin(0.5).setDepth(12);
      this.tweens.add({targets:t, y:72, alpha:0, duration:900, ease:'Sine.easeOut', onComplete:function(){ t.destroy(); }});
    }
    this.prevRank=this.rank;
  }

  computeRank(){
    var tr=this.track;
    var all=[];
    var pProg = (this.lap*tr.waypoints.length) + progressAlongTrack(this.player.x,this.player.y,tr.waypoints);
    // 若已完成，用 finishTime 小者靠前
    if(this.raceState==='finished') pProg+=999;
    all.push({isPlayer:true, prog:pProg, time:this.raceState==='finished'?this.finishTime:Infinity, x:this.player.x});
    for(var i=0;i<this.aiCars.length;i++){
      var ac=this.aiCars[i];
      var prog = ((ac.lap||0)*tr.waypoints.length) + progressAlongTrack(ac.x,ac.y,tr.waypoints);
      if(ac.finished) prog+=999;
      all.push({isPlayer:false, prog:prog, time:ac.finished?ac.finishTime:Infinity, idx:i});
    }
    all.sort(function(a,b){
      if(a.prog!==b.prog) return b.prog-a.prog;
      return a.time-b.time;
    });
    for(var r=0;r<all.length;r++) if(all[r].isPlayer) return r+1;
    return 4;
  }

  update(time, delta){
    var dt=delta/1000;
    if(this.paused) return;
    // 快捷键：航点调试切换（JustDown）
    if(Phaser.Input.Keyboard.JustDown(this.keys.DEBUG)){
      // 避免与转向冲突：仅当单独按 D 且未同时按方向时不误触，但此处直接切换
      this.showWaypoints=!this.showWaypoints;
      this.wpG.setVisible(this.showWaypoints);
      this.drawWaypoints();
    }
    if(Phaser.Input.Keyboard.JustDown(this.keys.R)){
      this.scene.restart({trackId:this.trackId});
      return;
    }
    if(Phaser.Input.Keyboard.JustDown(this.keys.M) || Phaser.Input.Keyboard.JustDown(this.keys.ESC)){
      Sfx.stopBgm();
      this.scene.start('menu');
      return;
    }
    if(Phaser.Input.Keyboard.JustDown(this.keys.ONE)){
      Sfx.stopBgm(); this.scene.start('race',{trackId:1}); return;
    }
    if(Phaser.Input.Keyboard.JustDown(this.keys.TWO)){
      Sfx.stopBgm(); this.scene.start('race',{trackId:2}); return;
    }

    // 倒计时阶段
    if(this.raceState==='countdown'){
      this.countdownMs-=delta;
      if(this.countdownMs<=2000 && this.countdownVal===3){ this.countdownVal=2; this.showCountdown(2); }
      else if(this.countdownMs<=1000 && this.countdownVal===2){ this.countdownVal=1; this.showCountdown(1); }
      else if(this.countdownMs<=0 && this.countdownVal===1){
        this.raceState='racing';
        this.centerText.setText('GO!');
        this.centerText.setColor('#00e676');
        this.centerSub.setText('');
        Sfx.play('go');
        this.tweens.add({targets:this.centerText, alpha:0, duration:700, delay:420, onComplete:function(){ this.centerText.setVisible(false); this.centerText.setAlpha(1); }.bind(this)});
        this.centerSub.setVisible(false);
      }
      // 倒计时期间仍允许轻微转向预览，但速度为 0
      this.player.speed*=0.96;
      this.updateHud();
      return;
    }

    if(this.raceState==='finished'){
      // 结束界面输入
      if(Phaser.Input.Keyboard.JustDown(this.keys.R)) this.scene.restart({trackId:this.trackId});
      this.updateHud();
      return;
    }

    // 计时
    this.timeMs+=delta;
    if(this.player.wallCooldown>0) this.player.wallCooldown-=delta;
    for(var ai=0;ai<this.aiCars.length;ai++) if(this.aiCars[ai].wallCooldown>0) this.aiCars[ai].wallCooldown-=delta;

    // 保存玩家 prev 供跨线判定
    var prevPx=this.player.x, prevPy=this.player.y;
    for(var ai2=0;ai2<this.aiCars.length;ai2++){
      var ac0=this.aiCars[ai2];
      ac0._prevX=ac0.x; ac0._prevY=ac0.y;
    }

    // 玩家物理 — 油门/刹车/倒车 + 漂移
    var up = this.keys.UP.isDown || this.keys.W.isDown;
    var down = this.keys.DOWN.isDown || this.keys.S.isDown;
    var left = this.keys.LEFT.isDown || this.keys.A.isDown;
    var right = this.keys.RIGHT.isDown || this.keys.D.isDown;
    // 若航点调试用 D 切换会影响转向，这里 right 仍为 D 键按下
    var driftKey = this.keys.SPACE.isDown;

    var p=this.player;
    // 加速/减速曲线
    if(this.raceState==='racing'){
      if(up && !down){
        // 加速：随速度趋近上限，增益衰减
        var ratio = clamp(Math.abs(p.speed)/P_MAX_SPEED, 0, 1);
        var eff = ACCEL * (1 - ratio*0.62);
        p.speed += eff * dt;
        if(p.speed > P_MAX_SPEED) p.speed = P_MAX_SPEED;
      } else if(down && !up){
        // 刹车/倒车：若正向速度高则刹车，否则倒车
        if(p.speed > 8){
          p.speed -= BRAKE_DECEL * dt;
          if(p.speed < 8) p.speed=8;
          // 轻微刹车音（节流）
          if(this.time.now - (this._brakeSfx||0) > 260){ this._brakeSfx=this.time.now; Sfx.play('brake'); }
        } else {
          // 倒车加速
          p.speed -= REV_ACCEL * dt;
          if(p.speed < -REV_MAX) p.speed = -REV_MAX;
        }
      } else {
        // 自然阻力滑行
        var drag = DRAG * (1 + Math.abs(p.speed)/600);
        if(p.speed>0){ p.speed-=drag*dt; if(p.speed<0) p.speed=0; }
        else if(p.speed<0){ p.speed+=drag*dt; if(p.speed>0) p.speed=0; }
      }
    }

    // 转向：方向输入
    var steerInput=0;
    if(left) steerInput-=1;
    if(right) steerInput+=1;
    // 倒车时转向反向
    if(p.speed < -6) steerInput*=-1;

    var speedAbs=Math.abs(p.speed);
    var steerEff = STEER_RATE * (0.42 + 0.58*(1 - clamp(speedAbs/P_MAX_SPEED,0,1)*STEER_SPEED_FACTOR));
    // 漂移：手刹时横滑角累积，转向更灵
    if(driftKey && speedAbs>60 && steerInput!==0){
      p.drift += steerInput * DRIFT_FACTOR * 42 * dt * (0.6+speedAbs/400);
      p.spin += steerInput * 90 * dt;
      // 烟雾粒子（节流）
      if(this.time.now - (this._smokeT||0) > 48){
        this._smokeT=this.time.now;
        var rad=(p.ang+90)*Math.PI/180;
        // 后轮位置
        var rx=p.x - Math.cos(p.ang*Math.PI/180)*10 + Math.cos(rad)*6;
        var ry=p.y - Math.sin(p.ang*Math.PI/180)*10 + Math.sin(rad)*6;
        this.spawnDriftSmoke(rx + (Math.random()-0.5)*6, ry + (Math.random()-0.5)*6);
        if(Math.random()<0.12) Sfx.play('drift');
      }
      steerEff *= 1.35;
    } else {
      // 非漂移时横滑角回正
      p.drift = lerp(p.drift, 0, clamp(5.2*dt,0,1));
      p.spin = lerp(p.spin, 0, clamp(6.0*dt,0,1));
    }
    // 应用转向
    if(steerInput!==0 && speedAbs>6){
      var factor = speedAbs<40 ? (speedAbs/40)*0.65+0.35 : 1;
      p.ang += steerInput * steerEff * factor * dt + p.spin*dt*0.18;
    } else {
      p.spin = lerp(p.spin, 0, clamp(4*dt,0,1));
    }
    // 漂移时横向滑移：对位置加侧向分量
    var driftRad=p.drift*Math.PI/180;
    var forwardRad=p.ang*Math.PI/180;
    var friction = driftKey ? DRIFT_FRICTION : 0.94;
    // 速度向量分解：前进 + 侧滑
    var fwdX=Math.cos(forwardRad), fwdY=Math.sin(forwardRad);
    var latX=Math.cos(forwardRad+Math.PI/2), latY=Math.sin(forwardRad+Math.PI/2);
    var driftInfluence = clamp(Math.abs(p.drift)/32,0,1) * (driftKey?1:0.35);
    // 侧滑速度
    var latSpeed = p.speed * Math.sin(driftRad) * driftInfluence * 0.72;
    // 更新位置
    p.x += fwdX * p.speed * dt + latX * latSpeed * dt * friction;
    p.y += fwdY * p.speed * dt + latY * latSpeed * dt * friction;
    // 漂移角随速度摩擦衰减
    if(!driftKey) p.drift *= Math.pow(0.86, dt*60);
    p.drift = clamp(p.drift, -48, 48);

    // 墙碰撞
    this.handleWall(p, true);
    // 限制在画布内兜底
    p.x=clamp(p.x, CAR_RADIUS, CW-CAR_RADIUS);
    p.y=clamp(p.y, CAR_RADIUS, CH-CAR_RADIUS);

    // AI 更新 — 沿航点巡航
    for(var i=0;i<this.aiCars.length;i++){
      var ac=this.aiCars[i];
      if(ac.finished){
        ac.speed = Math.max(0, ac.speed - 120*dt);
        ac.x += Math.cos(ac.ang*Math.PI/180)*ac.speed*dt;
        ac.y += Math.sin(ac.ang*Math.PI/180)*ac.speed*dt;
        this.handleWall(ac,false);
        syncCarSprite(ac, this.aiSprites[i]);
        continue;
      }
      // 选目标航点：若已接近则切下一航点
      var wps=this.track.waypoints;
      // 若 AI 卡墙，偶尔加摆动避免死锁
      var tgt=wps[ac.nextWp % wps.length];
      var d2w=dist2(ac.x,ac.y,tgt.x,tgt.y);
      if(d2w < AI_WP_THRESH*AI_WP_THRESH){
        ac.nextWp = (ac.nextWp+1)%wps.length;
        // 随机微调速度，制造超车机会
        ac.maxSpeed = ac.baseSpeed * (0.92 + Math.random()*0.16);
        tgt=wps[ac.nextWp % wps.length];
      }
      // 目标角度
      var targetAng = Math.atan2(tgt.y-ac.y, tgt.x-ac.x)*180/Math.PI;
      var diff=angDiff(ac.ang, targetAng);
      // 曲率自适应：弯道前减速，直道加速
      var next2=wps[(ac.nextWp+1)%wps.length];
      var v1x=tgt.x-ac.x, v1y=tgt.y-ac.y;
      var v2x=next2.x-tgt.x, v2y=next2.y-tgt.y;
      var ang1=Math.atan2(v1y,v1x)*180/Math.PI, ang2=Math.atan2(v2y,v2x)*180/Math.PI;
      var bend=Math.abs(angDiff(ang1,ang2));
      var targetSpeed=ac.maxSpeed * (bend>45? 0.62 : bend>28? 0.78 : 1.0);
      // 平滑转向
      ac.ang += diff * AI_STEER_SMOOTH * clamp(60*dt,0,1);
      // 加速/减速到目标速
      if(ac.speed < targetSpeed) ac.speed += 120*dt;
      else if(ac.speed > targetSpeed) ac.speed -= 180*dt;
      // 加入轻微摆动，避免 AI 完全重叠
      ac._wobble += dt*2.1;
      ac.ang += Math.sin(ac._wobble + i)*0.18;
      // 墙距自适应：若接近墙则额外减速
      var wallD=distToCenterline(ac.x,ac.y,wps);
      var wallMargin=this.track.roadW/2 - wallD.dist;
      if(wallMargin < 18) ac.speed *= 0.96;
      ac.speed=clamp(ac.speed, 40, ac.maxSpeed);
      ac.x += Math.cos(ac.ang*Math.PI/180)*ac.speed*dt;
      ac.y += Math.sin(ac.ang*Math.PI/180)*ac.speed*dt;
      this.handleWall(ac,false);
      ac.x=clamp(ac.x, CAR_RADIUS, CW-CAR_RADIUS);
      ac.y=clamp(ac.y, CAR_RADIUS, CH-CAR_RADIUS);
      syncCarSprite(ac, this.aiSprites[i]);
    }

    // 车体碰撞
    this.handleCarCollisions();

    // 同步玩家精灵
    syncCarSprite(this.player, this.playerSprite);
    // 同步 AI 精灵已在循环内完成

    // 圈数与排名
    this.updateRaceProgress(prevPx, prevPy);

    // HUD
    this.updateHud();
    // 航点调试
    if(this.showWaypoints) this.drawWaypoints();
  }

  drawWaypoints(){
    var g=this.wpG;
    g.clear();
    var wps=this.track.waypoints;
    for(var i=0;i<wps.length;i++){
      var wp=wps[i];
      var isNext=this.player && this.player.nextWp===i;
      g.fillStyle(isNext?0x00e676:0xffffff, 0.72);
      g.fillCircle(wp.x, wp.y, isNext?7:4.5);
      g.fillStyle(0x000000,0.85);
      // 序号需用 text，graphics 写字用 add.text，这里用 graphics 文字近似
    }
    // 用 text 标序号（清除旧的）
    if(this._wpLabels) for(var k=0;k<this._wpLabels.length;k++) this._wpLabels[k].destroy();
    this._wpLabels=[];
    for(var j=0;j<wps.length;j++){
      var w=wps[j];
      var t=this.add.text(w.x+6,w.y-10,String(j),{fontFamily:'monospace',fontSize:'9px',color:'#ffffff',stroke:'#000000',strokeThickness:2}).setDepth(7);
      this._wpLabels.push(t);
    }
  }

  onFinish(){
    var rank=this.rank;
    var tMs=this.finishTime;
    var trId=this.trackId;
    // 存档 bestTime / bestRank
    var prevBest=saveData.bestTime[trId]||0;
    var prevRank=saveData.bestRank[trId]||99;
    var isBestTime = !prevBest || tMs < prevBest;
    var isBestRank = rank < prevRank;
    if(isBestTime) saveData.bestTime[trId]=tMs;
    if(isBestRank) saveData.bestRank[trId]=rank;
    if((isBestTime||isBestRank) && hostRef && typeof hostRef.saveState==='function'){
      try{ hostRef.saveState({bestTime:saveData.bestTime, bestRank:saveData.bestRank}); }catch(e){}
    }
    Sfx.play('finish');
    var msg = rank===1 ? 'YOU WIN!' : (rank===2 ? 'PODIUM!' : 'FINISHED');
    var color = rank===1 ? '#00e676' : rank===2 ? '#ffd54f' : '#ff8a65';
    this.centerText.setText(msg);
    this.centerText.setColor(color);
    this.centerText.setVisible(true); this.centerText.setAlpha(1);
    var detail='TIME  '+(tMs/1000).toFixed(2)+'s   RANK '+rank+'/4'+ (isBestTime?'  ★ NEW BEST':'');
    this.centerSub.setText(detail+'\nR: Restart   M: Menu   1/2: Switch Track');
    this.centerSub.setVisible(true);
    this.tweens.add({targets:this.centerText, scale:1.08, duration:180, yoyo:true, repeat:1});
  }
};

// ==========================================================================
// 启动注册 — IIFE + TRGames.register + Phaser v4.2.1
// ==========================================================================
function launch(host){
  hostRef=host;
  // 恢复存档（异步）后切 menu，Boot 负责
  var config={
    type:Phaser.AUTO,
    parent:host.container,
    width:CW,
    height:CH,
    backgroundColor:'#0f1820',
    physics:{default:'arcade', arcade:{gravity:{y:0}, debug:false}},
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene:[BootScene, MenuScene, RaceScene]
  };
  // 注入 hostRef 供 Boot 读取
  // Phaser registry 传参
  var game=new Phaser.Game(config);
  // 延迟注入 registry（Boot create 前）
  try{ game.registry.set('hostRef', host); }catch(e){}
  window.__trgame={game:game, getState:getState, getTrack:function(){return sceneRef?sceneRef.trackId:1;}};
  return game;
}

if(typeof window.TRGames!=='undefined' && typeof window.TRGames.register==='function'){
  window.TRGames.register({id:'racing-topdown', title:'Racing Topdown', launch:launch});
}
})();
