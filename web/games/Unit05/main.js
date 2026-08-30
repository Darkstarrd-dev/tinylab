// =============================================================================
// Unit05 — 相机与粒子（Camera & Particles）
// =============================================================================
// 【这一节学什么】
//   • 相机（Camera）：setBounds 限制可滚范围、startFollow 跟随目标、pan 平移、
//     zoom 缩放、shake 震动、flash 闪光、fade 淡入淡出；HUD 用 setScrollFactor(0)
//     固定在屏幕上不随相机滚动。参考 C:/omp/Phaser 第 09 节 cameras
//   • 粒子（Particles）：add.particles 发射器，支持持续喷泉 vs 点击爆发
//     参考第 08 节 particles
//   • 操作：WASD 移动红点（相机会跟随）· P 平移 · F 缩放 · 空格震动
// =============================================================================
(function () {
  'use strict';
  window.TRGames.register({
    id: 'Unit05',
    title: '示例单元 05 — 相机与粒子',
    launch: function (host) {
      var Phaser = host.phaser;
      if (!Phaser) throw new Error('Phaser not loaded');
      var container = host.container, W = host.width || 800, H = host.height || 450;

      var Scene = new (Phaser.Scene)('Camera');

      // 把更新用的引用挂在场景上，避免闭包在 update 里取不到
      Scene.create = function () {
        // —— 大地图：用程序绘制一个 1400×900 的网格，方便观察相机滚动 ——
        var gfx = this.make.graphics();
        gfx.fillStyle(0x0f172a); gfx.fillRect(0, 0, 1400, 900);
        gfx.lineStyle(1, 0x1f2a44);
        for (var x = 0; x <= 1400; x += 80) { gfx.lineBetween(x, 0, x, 900); }
        for (var y = 0; y <= 900; y += 80) { gfx.lineBetween(0, y, 1400, y); }
        gfx.generateTexture('world', 1400, 900);
        gfx.destroy();
        gfx = this.make.graphics();
        gfx.fillStyle(0xffff77); gfx.fillCircle(6, 6, 6);
        gfx.generateTexture('spark', 12, 12);
        gfx.destroy();

        this.add.image(700, 450, 'world');

        // 相机边界 = 地图大小；否则相机会滚出地图看到黑边
        var cam = this.cameras.main;
        cam.setBounds(0, 0, 1400, 900);
        cam.setBackgroundColor('#0f172a');

        // 跟随目标：一个红点，相机会平滑地追它（lerp 0.1）
        var target = this.add.circle(700, 450, 10, 0xff6b6b);
        cam.startFollow(target, true, 0.1, 0.1);

        // 输入：WASD 移动目标点
        this._target = target;
        this._keys = this.input.keyboard.addKeys('W,A,S,D');

        // P：平移到地图右侧（2 秒缓动）；F：缩放切换；空格：震动；C：闪光
        var self = this;
        this.input.keyboard.on('keydown-P', function () { cam.pan(1100, 450, 1600, 'Cubic.easeInOut'); });
        this.input.keyboard.on('keydown-F', function () {
          var to = (cam.zoom < 1.5 ? 1.8 : 1); // 在 1x 与 1.8x 间切换
          cam.zoomTo(to, 600, 'Cubic.easeInOut');
        });
        this.input.keyboard.on('keydown-SPACE', function () { cam.shake(280, 0.006); });
        this.input.keyboard.on('keydown-C', function () { cam.flash(180, 255, 255, 255); });

        // 持续喷泉：放在地图中央偏上，无需手动触发，一直喷
        this.add.particles(700, 620, 'spark', {
          lifespan: 700, speed: { min: 80, max: 220 }, angle: { min: -110, max: -70 },
          scale: { start: 1, end: 0 }, alpha: { start: 1, end: 0 },
          quantity: 2, frequency: 70, gravityY: 420
        });

        // 点击爆发：点哪里就在哪里炸一团（一次性 explode）
        var burster = this.add.particles(700, 450, 'spark', {
          lifespan: 500, speed: { min: 100, max: 260 }, angle: { min: 0, max: 360 },
          scale: { start: 1.2, end: 0 }, alpha: { start: 1, end: 0 },
          quantity: 16, frequency: -1, emitting: false
        });
        this.input.on('pointerdown', function (pointer) {
          burster.setPosition(pointer.worldX, pointer.worldY);
          burster.explode(18);
        });

        // HUD：固定在屏幕上的提示（setScrollFactor(0) 让它不随相机滚动）
        var hud = this.add.text(10, 10,
          'WASD 移动红点（相机跟随）· P 平移 · F 缩放 · 空格震动 · C 闪光 · 点击爆发', {
            color: '#e8e8e8', fontSize: '11px', backgroundColor: '#0b1220', padding: { x: 6, y: 4 }
          });
        hud.setScrollFactor(0).setDepth(100);

        cam.fadeIn(400, 0, 0, 0); // 开场淡入

        window.__trgame = { game: this.game, getState: function () { return { id: 'Unit05', running: true }; } };
      };

      Scene.update = function () {
        if (!this._target || !this._keys) return;
        var k = this._keys, vx = 0, vy = 0, speed = 260;
        if (k.A && k.A.isDown) vx -= speed; if (k.D && k.D.isDown) vx += speed;
        if (k.W && k.W.isDown) vy -= speed; if (k.S && k.S.isDown) vy += speed;
        // 斜向归一，避免对角线更快
        if (vx !== 0 && vy !== 0) { vx *= 0.7071; vy *= 0.7071; }
        this._target.setPosition(this._target.x + vx * (1 / 60), this._target.y + vy * (1 / 60));
      };

      return new Phaser.Game({
        type: Phaser.AUTO, parent: container, width: W, height: H,
        backgroundColor: '#0f172a', scene: [Scene]
      });
    }
  });
})();
