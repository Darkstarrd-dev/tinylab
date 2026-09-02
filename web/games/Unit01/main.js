// =============================================================================
// Unit01 — Hello Phaser（你好，Phaser）
// =============================================================================
// 【这一节学什么】
//   • Phaser 最小的可运行游戏：new Phaser.Game + 一个 Scene（场景）
//   • 参考 C:/omp/Phaser 第 01 节 game-config 与第 02 节 scenes 的思想，
//     但适配到本项目的 TRGames host 容器：canvas 挂在 host.container，
//     尺寸来自 host.width / host.height（跟随右侧预览区大小）。
//   • 文字锐化技巧：为何文字会发虚？如何使用 resolution + DPR 超采样让文字变得清晰锐利。
//   • 中文注释已尽量写细，改一改文字/颜色点 “Run” 就能看到效果。
//
// 【怎么玩】
//   1. 在 Game Designer 左侧打开 Unit01/main.js，改标题、改颜色、改字号
//   2. 点右上角 Run，右侧预览区实时生效；用 Explorer 删掉 Unit01 可腾出下拉菜单
//   3. 灵感：试着把 create 里的两行文本换成你游戏的名字与副标题
// =============================================================================
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 注册到宿主：必须同步调用 register，且 id 要与 game.json 的 id 一致。
  // 宿主会在用户点 Run/Launch 时调用 launch(host) 启动游戏。
  // host 只有这几个字段：container / width / height / phaser / saveState / loadState
  // 不要依赖宿主的任何全局变量——游戏就是一个自包含的 classic script。
  // ---------------------------------------------------------------------------
  window.TRGames.register({
    id: 'Unit01',
    title: '示例单元 01 — Hello Phaser', // Game select 下拉里显示的标题
    launch: function (host) {
      var Phaser = host.phaser; // 由宿主保证已加载的 Phaser 4.2.1
      if (!Phaser) throw new Error('Phaser not loaded');

      var container = host.container; // 空的 stage 元素，canvas 会挂在这里
      var W = host.width || 800;      // 启动时的舞台宽度（之后不跟随窗口缩放，需重启）
      var H = host.height || 450;     // 启动时的舞台高度

      // 一个最简场景：只在 create 里摆两行文字，不做任何输入与物理
      var HelloScene = new (Phaser.Scene)('Hello');
      HelloScene.create = function () {
        // 背景色用 setBackgroundColor（v4 写法），不要直接改属性
        this.cameras.main.setBackgroundColor('#0f172a');

        // ---------------------------------------------------------------------
        // 【文字清晰度与锐化技巧】
        // 在 Phaser 中，Text 对象是由独立的离线 Canvas 栅格化生成位图纹理后送入 WebGL 渲染的。
        // 若未指定 resolution，默认仅按 1 倍逻辑像素绘制，在高分屏（Retina / Windows 缩放）下
        // 纹理被双线性插值放大就会产生柔化/发虚感（且全局 Phaser.Game 的 resolution 并不会
        // 自动提升各个 Text 内部生成器的分辨率，直接在 Text 样式中指定是标准做法）。
        //
        // 语法说明：
        //   • window.devicePixelRatio || 1：读取系统设备像素比（DPR），若未定义则以 1 保底。
        //   • Math.max(..., 2)：至少采用 2 倍超采样精度光栅化文字，确保普通 100% 屏也有极佳锐度。
        // ---------------------------------------------------------------------
        var textResolution = Math.max(window.devicePixelRatio || 1, 2);

        // 主标题：大字，居中
        this.add.text(W / 2, H / 2 - 10, 'Hello Phaser — 改这里 ✨', {
          fontFamily: 'monospace',
          fontSize: '20px',
          color: '#e8e8e8',
          resolution: textResolution
        }).setOrigin(0.5);

        // 副标题：小字，提示改法与参考资料
        this.add.text(W / 2, H / 2 + 22, '改上面那行字，点 Run 立刻生效 · 参考 C:/omp/Phaser 01-game-config / 02-scenes', {
          fontFamily: 'monospace',
          fontSize: '11px',
          color: '#8b949e',
          resolution: textResolution
        }).setOrigin(0.5);

        // 可选：读一条只读的运行时信息展示在角落（像 Phaser 教程第 01 节那样）
        var isWebGL = this.game.renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer;
        this.add.text(10, H - 18, (isWebGL ? 'WebGL' : 'Canvas') + ' · ' + W + '×' + H + ' · DPR ' + (window.devicePixelRatio || 1), {
          fontFamily: 'monospace', fontSize: '10px', color: '#475569',
          resolution: textResolution
        }).setOrigin(0, 0.5);

        // 调试缝：让自动化/控制台可通过 window.__trgame.getState() 探查
        window.__trgame = {
          game: this.game,
          getState: function () { return { id: 'Unit01', running: true }; }
        };
      };

      // 启动游戏：parent 必须是 host.container，尺寸用 host 提供的 W/H
      var game = new Phaser.Game({
        type: Phaser.AUTO,        // 自动选 WebGL / Canvas
        parent: container,        // 宿主提供的空容器（不要写死 '#app'）
        width: W,
        height: H,
        backgroundColor: '#0f172a', // 与场景背景保持一致
        scene: [HelloScene]
      });
      return game; // 宿主会在停止时调用 game.destroy(true) 清理 canvas
    }
  });
})();
