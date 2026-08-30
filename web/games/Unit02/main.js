// =============================================================================
// Unit02 — 精灵与图形（Sprites & Graphics）
// =============================================================================
// 【这一节学什么】
//   • 用 make.graphics() 程序生成贴图，再用 generateTexture 存进纹理缓存
//     （不依赖外部图片/网络，适合 Demo 预览；参考 C:/omp/Phaser 第 03 节 sprites、
//     第 12 节 graphics、第 11 节 text）
//   • 精灵的常见变换：缩放、角度、透明度、颜色叠加（tint）、水平翻转、层级（depth）
//   • 点击可交互：setInteractive + pointerdown + tween 动画
//   • 重点坑：v4 里 make.graphics() 不传参、setTint 仅 WebGL 生效、text padding 需对象
// =============================================================================
(function () {
  'use strict';
  window.TRGames.register({
    id: 'Unit02',
    title: '示例单元 02 — 精灵与图形',
    launch: function (host) {
      var Phaser = host.phaser;
      if (!Phaser) throw new Error('Phaser not loaded');
      var container = host.container, W = host.width || 800, H = host.height || 450;

      var Scene = new (Phaser.Scene)('Sprites');
      Scene.create = function () {
        this.cameras.main.setBackgroundColor('#0f172a');

        // —— 1. 生成一张 64×64 的方块贴图（v4：make.graphics() 不传 {add:false}） ——
        var gfx = this.make.graphics();
        gfx.fillStyle(0x4a90d9);           // 填充色：蓝
        gfx.fillRect(0, 0, 64, 64);        // 画一个实心矩形
        gfx.generateTexture('box', 64, 64); // 存进全局纹理缓存，key = 'box'
        gfx.destroy();                      // 用完就销毁，避免残留 displayList

        // —— 2. 用同一张贴图展示 5 种变换（横向排开，标签在下方） ——
        var y = Math.round(H * 0.42);
        var xs = [W * 0.18, W * 0.34, W * 0.5, W * 0.66, W * 0.82];
        var a = this.add.sprite(xs[0], y, 'box').setOrigin(0.5); // 原图
        var b = this.add.image(xs[1], y, 'box').setOrigin(0.5)
          .setTint(0xff6b6b) // 染成红色；注意 tint 只有 WebGL 下可见，Canvas 会忽略
          // MULTIPLY 让纹理与染色的混合更自然（可选，不加也能看出 tint）
          .setTintMode(Phaser.TintModes ? Phaser.TintModes.MULTIPLY : 0);
        var c = this.add.image(xs[2], y, 'box').setOrigin(0.5).setAlpha(0.4); // 半透明
        var d = this.add.image(xs[3], y, 'box').setOrigin(0.5)
          .setFlipX(true).setAngle(15); // 水平翻转 + 轻微倾斜
        var e = this.add.image(xs[4], y, 'box').setOrigin(0.5).setScale(1.4); // 放大

        var labels = ['基本', 'Tint 着色', 'Alpha 0.4', 'Flip+Angle', 'Scale 1.4'];
        var items = [a, b, c, d, e];
        for (var i = 0; i < items.length; i++) {
          this.add.text(items[i].x, y + 52, labels[i], { color: '#8b949e', fontSize: '11px' }).setOrigin(0.5, 0);
        }

        // —— 3. depth（层级）：背景矩形在下，可点击精灵在上 ——
        this.add.rectangle(W / 2, H * 0.78, Math.min(W * 0.9, 760), 64, 0x1e293b).setDepth(-1)
          .setStrokeStyle(1, 0x334155);
        var front = this.add.sprite(W / 2, H * 0.78, 'box').setDepth(10).setScale(0.85);
        this.add.text(W / 2, H * 0.78 + 34, 'depth：矩形 depth=-1 在下，精灵 depth=10 在上（试着把 depth 改小）', {
          color: '#64748b', fontSize: '11px'
        }).setOrigin(0.5, 0);

        // —— 4. 交互：点中间方块会转一圈（tween） ——
        front.setInteractive(); // 必须先设为可交互，才能收到 pointerdown
        var self = this;
        front.on('pointerdown', function () {
          self.tweens.add({ // tweens 在场景 07 还会深入讲，这里先尝鲜一小段
            targets: front,
            rotation: front.rotation + Math.PI * 2,
            duration: 700,
            ease: 'Cubic.easeInOut'
          });
        });

        // 顶部提示 + 底部说明
        this.add.text(W / 2, 14, '精灵变换 · 点击中间方块旋转 · 参考 C:/omp/Phaser 03-sprites / 12-graphics', {
          color: '#8b949e', fontSize: '11px'
        }).setOrigin(0.5, 0);
        this.add.text(10, H - 14, 'Tint 仅 WebGL 生效 · Canvas 下看不到染红色属正常', {
          color: '#334155', fontSize: '10px'
        }).setOrigin(0, 0.5);

        // 可选：渐变示例（v4 正确写法：fillGradientStyle 再 fillRect，非 fillGradientRect）
        // var g2 = this.make.graphics();
        // g2.fillGradientStyle(0xff00ff, 0x00ffff, 0xff00ff, 0x00ffff);
        // g2.fillRect(W - 140, 40, 120, 18);
        // g2.generateTexture('grad', 120, 18); g2.destroy();
        // this.add.image(W - 80, 64, 'grad').setOrigin(0.5);

        window.__trgame = { game: this.game, getState: function () { return { id: 'Unit02', running: true }; } };
      };

      return new Phaser.Game({
        type: Phaser.AUTO, parent: container, width: W, height: H,
        backgroundColor: '#0f172a', scene: [Scene]
      });
    }
  });
})();
