// =============================================================================
// Unit03 — 输入与物理（Input & Arcade Physics）
// =============================================================================
// 【这一节学什么】
//   • Arcade 物理：重力、世界边界、静态体 vs 动态体、collider（有反弹）vs
//     overlap（只检测不反弹）；参考 C:/omp/Phaser 第 05 节 physics-arcade
//   • 输入：方向键/WASD 轮询、鼠标点击、拖拽（draggable）；参考第 06 节 input
//   • 轻量“掉落+弹跳”小玩法：点哪里小球就去哪里，平台会接住它
//   • 坑：v4 gravity 必须写成 {x:0, y:500}，body 的属性在 sprite.body 上
// =============================================================================
(function () {
  'use strict';
  window.TRGames.register({
    id: 'Unit03',
    title: '示例单元 03 — 输入与物理',
    launch: function (host) {
      var Phaser = host.phaser;
      if (!Phaser) throw new Error('Phaser not loaded');
      var container = host.container, W = host.width || 800, H = host.height || 450;

      var Scene = new (Phaser.Scene)('Physics');

      Scene.create = function () {
        this.cameras.main.setBackgroundColor('#0f172a');

        // —— 世界设置：重力向下 520，边界就是舞台四周 ——
        // 坑：v4 写法 gravity: {x:0, y:520}，只写 y 会被忽略
        this.physics.world.gravity.x = 0;
        this.physics.world.gravity.y = 520;
        this.physics.world.setBounds(0, 0, W, H);
        this.physics.world.setBoundsCollision(true, true, true, true);

        // —— 生成贴图：地面/平台/小球（零资产，纯程序绘制） ——
        var gfx = this.make.graphics();
        gfx.fillStyle(0x1f3a2a); gfx.fillRect(0, 0, W, 18);
        gfx.generateTexture('ground', W, 18); gfx.clear();
        gfx.fillStyle(0x334155); gfx.fillRect(0, 0, 160, 12);
        gfx.generateTexture('plat', 160, 12); gfx.clear();
        gfx.fillStyle(0xff6b6b); gfx.fillCircle(12, 12, 12);
        gfx.generateTexture('ball', 24, 24);
        gfx.destroy();

        // 地面：staticImage = 不会被重力拉动的静态体
        var ground = this.physics.add.staticImage(W / 2, H - 10, 'ground');
        // 两个平台：放在不同高度，形成“跳台”感
        var plat1 = this.physics.add.staticImage(W * 0.30, H * 0.62, 'plat');
        var plat2 = this.physics.add.staticImage(W * 0.72, H * 0.52, 'plat');

        // 小球：先用 add.circle 画形，再用 physics.add.existing 挂物理体（v4 推荐写法）
        // 不用 add.circle 的旧 physics.add.circle 快捷方式（v4 已移除）
        var ball = this.physics.add.existing(this.add.circle(W / 2, 70, 12, 0xff6b6b));
        if (ball.body) {
          ball.body.setBounce(0.85);           // 弹性：接近 1 就很弹
          ball.body.setCollideWorldBounds(true); // 撞舞台边缘也会弹
        }

        // 碰撞：小球与 [平台, 地面] 会产生物理反应（被挡住/弹起）
        // 区分：collider 会阻挡；overlap 只通知不阻挡（适合“吃金币”）
        this.physics.add.collider(ball, [plat1, plat2, ground]);

        // —— 输入：WASD/方向键 水平推动小球；点击舞台瞬移 ——
        this.cursors = this.input.keyboard.createCursorKeys();            // 方向键
        this.wasd = this.input.keyboard.addKeys('W,A,S,D');               // WASD

        var self = this;
        this.input.on('pointerdown', function (pointer) {
          // pointer.worldX/Y 是世界坐标（相机滚动时会带上偏移，本节无滚动就是舞台坐标）
          var x = pointer.worldX, y = pointer.worldY;
          // 对于 Arcade 体，瞬移尽量用 setPosition（非传送穿过检测场景就够用）
          ball.setPosition(x, y);
          if (ball.body) ball.body.setVelocity(0, -160); // 给一点上抛，观感更“弹”
        });

        // 顶部/底部提示
        this.add.text(W / 2, 12, '点击任意位置：小球瞬移到那并上抛 · 平台只挡 collider 不挡 overlap', {
          color: '#8b949e', fontSize: '11px'
        }).setOrigin(0.5, 0);
        this.add.text(10, H - 14, 'WASD/方向键：水平推 · 试着把 gravity.y 改成 200 看慢动作', {
          color: '#334155', fontSize: '10px'
        }).setOrigin(0, 0.5);

        // 每帧用方向键给一个水平速度（Arcade 里用 setVelocity 而非直接改 x）
        this._ball = ball;
        window.__trgame = { game: this.game, getState: function () { return { id: 'Unit03', running: true }; } };
      };

      Scene.update = function () {
        if (!this._ball || !this._ball.body) return;
        var left = (this.cursors.left && this.cursors.left.isDown) || (this.wasd.A && this.wasd.A.isDown);
        var right = (this.cursors.right && this.cursors.right.isDown) || (this.wasd.D && this.wasd.D.isDown);
        var vx = 0; if (left) vx -= 220; if (right) vx += 220;
        // 只改水平速度，垂直方向交给重力与碰撞
        this._ball.body.setVelocityX(vx);
      };

      return new Phaser.Game({
        type: Phaser.AUTO, parent: container, width: W, height: H,
        backgroundColor: '#0f172a',
        physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 520 }, debug: false } },
        scene: [Scene]
      });
    }
  });
})();
