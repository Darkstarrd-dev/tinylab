# TinyRouter GIF Editor 升级执行方案

> **用途：** 本文件是本轮 GIF Editor 导入流程、时间线控制和模块拆分的唯一执行入口。后续实施者应先读取本文，再按阶段执行；不需要重新解释需求或重新设计模块边界。
>
> **范围：** 仅修改 TinyRouter 的 GIF Editor 前端及其必要的页面资产/文档同步。当前方案不新增 Go 媒体 API，不改变 Gallery 后端媒体编辑契约。
>
> **参考：**
> - ScreenToGif：<https://github.com/NickeManarin/ScreenToGif>
> - ScreenToGif Editor 操作说明：<https://github.com/NickeManarin/ScreenToGif/wiki/Help/afdac811da4187c85323f6398de348c467dd4c66>
> - ScreenToGif 视频导入预览讨论：<https://github.com/NickeManarin/ScreenToGif/issues/677>
> - 本项目 GIF 既有实施基线：[`gif_implented.md`](gif_implented.md)
>
> **实施原则：** 先完成模块边界和导入状态隔离，再实现 Import Modal；先迁移现有时间线行为，再增加底部控制和播放；每个阶段都必须保持现有图片/GIF/视频编辑及三种导出能力可回归验证。

---

## 1. 背景与当前基线

### 1.1 当前文件和职责

当前 GIF Editor 是一个全局 SPA 页面，入口在：

- `web/static/gif-editor.js`
- `renderGifEditor(container)`
- `cleanupGifEditor()`

页面通过 `web/static/index.html` 和 `web/static/index-nopg.html` 加载。它位于 `web/static`，不是 Playground 专属资产，因此所有构建变体都可以使用。

当前 `gif-editor.js` 约 2350 行，单文件同时承担：

- 页面模板和生命周期；
- DOM 缓存和全局事件清理；
- 图片/GIF/视频导入；
- gifuct-js GIF 解码与 disposal 1/2/3 合成；
- 视频 seek 抽帧；
- 网格切片；
- Canvas 预览、舞台缩放、拖拽和取色；
- 全局裁剪；
- 图层、文字、贴图和同步；
- 虚拟化时间线、排序、复制、删除、delay；
- GIF、PNG 帧 ZIP、Sprite Sheet 导出；
- MediaBridge 结果交接。

这已经超过适合单一 IIFE 维护的规模。本轮需求还会增加：

- Import Modal；
- 起点/终点双手柄进度条；
- 起点/终点毫秒输入；
- 导入比例；
- 导入 FPS；
- 实际帧数和播放时间统计；
- 时间线独立横向滚动区；
- 时间线放大倍率；
- First/Previous/Play/Pause/Next/Last；
- 播放 timer 和页面离开清理。

如果继续向原文件追加，导入、选帧、滚动、播放、导出和 Canvas 的状态耦合会进一步增加。因此本轮**必须先做受控模块拆分，再实施新增行为**。

### 1.2 当前导入行为

现有入口位于 `gif-editor.js` 的 `processFile()`：

- 文件选择、拖放、粘贴后直接开始处理；
- `processFile()` 立即清空当前 `state.slices`、`srcImg`、`srcVideo`；
- 图片通过 `FileReader + Image` 读取后直接显示；
- GIF 通过 `gifuct-js` 解码后直接生成全部 `state.slices`；
- 视频通过 `URL.createObjectURL` 创建 `<video>`，之后由 `extractFrames()` 从 0 秒抽到结束；
- 视频当前只有 FPS 控件，没有起点、终点、导入比例、结果统计；
- 用户取消或误选文件没有独立的回退边界。

本轮必须改变为：

```text
选择/拖放/粘贴文件
        ↓
读取元数据和临时预览
        ↓
打开 Import Modal
        ↓
用户调整参数
        ↓
取消：保留当前工程
确认：才替换当前工程并正式导入
```

### 1.3 当前时间线行为

当前时间线已经完成虚拟化：

- `timelineWindow()` 计算可见窗口；
- `.gif-timeline-track` 保持 `N × pitch` 的原生横向几何；
- 只挂载可见帧及缓冲帧；
- 缩略图缓存上限为 256；
- 时间线容器已使用 `overflow-x:auto`；
- 点击帧会调用 `selectSlice()`；
- `selectSlice()` 会调用 `centerTimelineOn()`；
- 左右键盘已能切换帧；
- 支持拖拽排序、复制、删除和单帧 delay。

但当前仍缺少清晰的结构和控制：

- 帧滚动区与底部操作区没有分离；
- 没有独立的底部总帧数/当前帧信息；
- 没有时间线显示倍率；
- 没有 First/Previous/Play/Pause/Next/Last 控件；
- 当前“切换帧”和“滚动到选中帧”混在一个函数中，后续容易误把左右按钮实现成滚动按钮；
- 播放状态机不存在。

---

## 2. 目标与非目标

### 2.1 本轮目标

#### 导入

1. 选择文件、拖放文件、粘贴文件统一打开 Import Modal。
2. Import Modal 采用 TinyRouter 当前 Modal、Button、Input、Range 和主题 token 样式，不复制 ScreenToGif 的 WPF 代码或视觉样式。
3. Modal 至少支持：
   - 原文件分辨率；
   - 导入比例；
   - 导入 FPS；
   - 起点/终点进度条；
   - 起点/终点毫秒输入；
   - 实际导入帧数；
   - 导入后播放时间。
4. 起点/终点滑块、起点/终点毫秒输入双向联动。
5. 调整视频范围时只更新预览，不立即抽取完整帧序列。
6. 取消导入不破坏当前工程。
7. 确认后才正式替换帧序列并导入。
8. 图片、GIF、视频按媒体类型正确启用/禁用不适用的字段。

#### 模块拆分

1. 保留 classic script 加载方式，不改成 ES Module。
2. 保留 `renderGifEditor()` 和 `cleanupGifEditor()` 作为唯一页面入口。
3. 使用单一 `window.GifEditorCore` 命名空间共享状态和模块 API，禁止散落多个全局函数。
4. 第一轮只拆分高变动、高耦合功能：
   - state/context；
   - import；
   - timeline；
   - playback；
   - export。
5. Canvas、图层、裁剪、透明抠图、网格切片等成熟功能暂时保留在入口文件，避免一次性迁移所有代码。

#### 时间线

1. 帧轨道和横向滚动条独立成 viewport。
2. 底部增加：
   - 时间线倍率；
   - 总帧数；
   - 当前帧/总帧数；
   - 第一帧；
   - 前一帧；
   - 播放/暂停；
   - 后一帧；
   - 最后一帧。
3. First/Previous/Next/Last 的语义是切换帧焦点，不是直接横向滚动。
4. 焦点切换完成后可辅助滚动使选中帧可见，但滚动不是按钮的主要行为。
5. 播放按每帧 `delay` 调度，播放到最后一帧后停止。
6. 页面离开、重渲染、重新导入和关闭 Modal 时必须清理 timer 和事件监听。

### 2.2 非目标

- 不新增 Go 后端抽帧 API；视频仍使用浏览器 `<video>` seek + Canvas。
- 不改变 Gallery 的 GIF/animated WebP 播放和 FFmpeg 编辑 API。
- 不把 gif.js、gifuct-js、MediaBridge 改成动态 CDN 依赖。
- 不把整个 GIF Editor 一次性拆成十个以上文件。
- 不迁移 Canvas、图层、裁剪、透明和网格切片到独立模块，除非实施过程中发现无法维持现有契约。
- 不引入 React、Vue、TypeScript、前端构建器或新的状态管理库。
- 不复制 ScreenToGif 的 C#、XAML 或 WPF 实现；只采用其交互语义和参数组织方式。

---

## 3. 固定设计决策

这些决策在实施时直接执行，不再重新讨论。

### 3.1 脚本模式

继续使用 classic script。原因：

- 项目当前全部前端资产按 classic script 加载；
- `web/static` 通过 `embed.FS` 提供静态文件；
- 当前 vendor 依赖暴露全局 `GIF`、`parseGIF`、`decompressFrames`；
- 不引入模块打包器，不增加 ES Module MIME、路径和 WebView2 回归面。

### 3.2 共享命名空间

只保留两个页面级全局入口：

```js
window.renderGifEditor
window.cleanupGifEditor
```

模块共享对象：

```js
window.GifEditorCore
```

禁止新增以下形式的全局函数：

```js
window.processFile
window.renderTimeline
window.playFrame
window.exportGif
```

### 3.3 Import Modal 容器

优先复用现有 `#modal-overlay`，以获得：

- 现有 Modal 主题；
- ESC 关闭；
- Tab 焦点循环；
- 统一按钮和 Footer；
- 全站 Modal 的层级和背景处理。

Import Modal 必须带有独立 class：

```html
<div class="modal gif-import-modal">
```

为确保 ESC、右键和全局 Modal 关闭流程不会遗留 `importDraft`，需要增加通用关闭事件：

```js
document.dispatchEvent(new CustomEvent('tinyrouter:modal-close'));
```

`closeModalOverlay()` 在清空 `#modal-overlay` 前触发该事件；GIF import 模块监听该事件，若当前有导入草稿则执行取消和资源清理。该事件是通用通知，不让 `app.js` 直接依赖 GIF Editor。

### 3.4 导入草稿与正式状态隔离

文件进入时只创建：

```js
state.importDraft
```

不得在 Modal 确认前修改：

```js
state.slices
state.srcImg
state.srcVideo
state.selectedSliceIdx
```

取消导入时：

- 清理 object URL；
- 清理临时 video/image 引用；
- 释放 GIF 临时解码帧引用；
- 清空 `state.importDraft`；
- 保留当前编辑工程。

确认导入时：

1. 验证参数；
2. 保存当前 draft 所需的正式源媒体信息；
3. 清理旧工程资源；
4. 执行正式导入；
5. 成功后替换 `state.slices`；
6. 导入失败时保留旧工程，错误信息明确显示。

### 3.5 视频采样语义

为匹配用户截图中的：

```text
起点 0ms、终点 4000ms、30FPS、121帧、播放时间 4000ms
```

视频预览和帧数估算采用**包含终点的采样点**：

```js
frameCount = Math.floor((endMs - startMs) * fps / 1000) + 1;
```

采样时间：

```js
timeMs = startMs + index * 1000 / fps;
```

最后一个采样点不得超过 `endMs`。

Modal 中的播放时间是用户选择的时间范围：

```js
durationMs = endMs - startMs;
```

为了让导入后统计时间与 Modal 一致，视频导入后的帧 delay 采用总时长平均分配：

```js
frameDelay = durationMs / frameCount;
```

说明：

- FPS 决定采样点数量和画面采样间隔；
- `delay` 的累计值以用户选择的区间为准；
- 由于 GIF 编码格式最终会将 delay 量化到厘秒，导出文件的播放器时间可能存在量化误差；
- 编辑器内部统计保留数字 delay，不提前四舍五入；
- 时间线显示可显示整数毫秒，内部统计使用浮点累计值。

### 3.6 GIF 时间语义

GIF 解码结果保留：

```js
{
  canvas,
  delay,
  startMs,
  endMs,
  disposal
}
```

默认导入：

- 保留原始 frame delay；
- 起点为 0；
- 终点为 GIF 总时长；
- FPS 默认显示源 GIF 的平均 FPS，不强行改变源 delay。

用户修改 GIF FPS 后：

- 按帧时间轴重新采样；
- 生成新的帧序列；
- 新帧 delay 按所选导入区间和采样点计算；
- disposal 处理仍以已合成的完整画布为基础，不重新执行错误的局部 patch 合成。

### 3.7 图片时间语义

图片是单帧媒体：

- 分辨率、导入比例启用；
- FPS、起点、终点禁用；
- 实际帧数为 `1`；
- 播放时间为 `0ms`；
- 图片确认后继续进入现有 `image-tools`，保留边缘修正和网格切片流程。

### 3.8 导入比例与导出比例分离

Import Modal 的比例是：

```text
导入比例：源文件 → state.slices 的帧尺寸
```

现有左侧 Output Settings 的比例保留，语义是：

```text
导出比例：state.slices → 输出文件尺寸
```

两者不能共用同一个 DOM id 或同一状态字段。

导入尺寸：

```js
importWidth = Math.max(1, Math.round(sourceWidth * scalePercent / 100));
importHeight = Math.max(1, Math.round(sourceHeight * scalePercent / 100));
```

保持宽高比，不提供独立宽高编辑。

### 3.9 时间线焦点和滚动分离

定义统一帧焦点函数：

```js
core.commands.focusFrame(index, options)
```

它负责：

- 边界校验；
- 更新 `selectedSliceIdx`；
- 更新 Canvas 预览；
- 更新当前帧/总帧数；
- 更新按钮 disabled 状态；
- 必要时调用 `timeline.ensureVisible(index)`。

First/Previous/Next/Last、键盘方向键、点击帧、播放 timer 都必须调用该命令。

禁止让控制按钮直接修改：

```js
timeline.scrollLeft
```

只有 `ensureVisible()` 可以处理滚动。

### 3.10 播放模型

使用递归 `setTimeout`，不使用固定 `setInterval`：

```js
nextTimer = setTimeout(scheduleNext, Math.max(1, Number(slice.delay) || 1));
```

原因：每帧 delay 可不同，且导入视频可能使用浮点 delay。

播放到最后一帧：

- 保持最后一帧选中；
- 设置 `playing=false`；
- 清除 timer；
- 播放按钮恢复 Play 图标。

---

## 4. 目标模块结构

第一轮最终文件结构：

```text
web/static/
├── gif-editor-state.js       # Core、状态、DOM 引用、生命周期注册
├── gif-editor-import.js      # 文件输入、Import Modal、解码、确认导入
├── gif-editor-timeline.js    # 虚拟化时间线、滚动、缩放、帧节点、排序
├── gif-editor-playback.js    # First/Prev/Play/Next/Last、键盘、timer
├── gif-editor-export.js      # GIF、ZIP、Sprite Sheet、结果 Modal、MediaBridge
└── gif-editor.js             # 页面入口、模板、Canvas/图层/裁剪/透明/网格等暂留逻辑
```

### 4.1 `gif-editor-state.js`

职责：

- 创建 `window.GifEditorCore`；
- 保存常量；
- 保存 `state`；
- 保存 `dom`；
- 提供 `byId()`、`freshId()`；
- 提供模块注册和清理；
- 提供统一 `resetSlices()`、`replaceSlices()` 辅助；
- 保存播放、时间线和导入 draft 的基础状态。

建议状态：

```js
var state = {
  source: {
    kind: null,
    file: null,
    objectUrl: null,
    width: 0,
    height: 0,
    durationMs: 0,
    sourceFps: 0,
    image: null,
    video: null
  },
  importDraft: null,
  slices: [],
  selectedSliceIdx: -1,
  mode: 'source',
  scale: 1,
  panX: 0,
  panY: 0,
  activeLayer: null,
  transparencyReady: false,
  timeline: {
    zoom: 1,
    window: null,
    thumbCache: {},
    thumbKeys: []
  },
  playback: {
    playing: false,
    timer: null,
    generation: 0
  }
};
```

模块注册接口：

```js
core.registerModule(name, moduleApi)
core.cleanupModules()
```

每个模块的 `cleanup()` 必须幂等。

### 4.2 `gif-editor-import.js`

职责：

- 点击选择文件；
- 拖放文件；
- 粘贴文件；
- 文件类型和 200MB 校验；
- 建立 `importDraft`；
- 读取图片/GIF/视频元数据；
- GIF 解码和 disposal 1/2/3 合成；
- Import Modal；
- 双手柄时间范围；
- 起点/终点数字输入；
- FPS 和比例同步；
- 预览 debounce；
- 实际帧数/播放时间估算；
- 确认导入；
- 取消和资源清理。

公开 API：

```js
core.import.openFromFile(file)
core.import.bindEvents()
core.import.cancel()
core.import.cleanup()
```

内部 API：

```js
openImportModal()
readDraftMetadata(file)
updateImportPreview()
updateImportSummary()
commitImportDraft()
commitImageDraft()
commitGifDraft()
commitVideoDraft()
```

### 4.3 `gif-editor-timeline.js`

职责：

- 时间线 viewport；
- 虚拟化窗口；
- 有界缩略图缓存；
- 横向滚动；
- 时间线倍率；
- 帧节点；
- 点击选中；
- delay 修改；
- 复制/删除；
- 拖拽/触摸排序；
- `ensureVisible()`。

公开 API：

```js
core.timeline.render()
core.timeline.updateWindow()
core.timeline.ensureVisible(index)
core.timeline.setZoom(value)
core.timeline.getZoom()
core.timeline.clearThumbCache()
core.timeline.cleanup()
```

时间线模块不得拥有正式选帧语义。点击帧时调用：

```js
core.commands.focusFrame(index)
```

### 4.4 `gif-editor-playback.js`

职责：

- `focusFrame()` 命令；
- First/Previous/Next/Last；
- Play/Pause；
- 当前帧显示；
- 键盘 Home/End/PageUp/PageDown/ArrowLeft/ArrowRight；
- 播放 timer；
- 页面离开清理。

公开 API：

```js
core.commands.focusFrame(index, options)
core.playback.first()
core.playback.previous()
core.playback.play()
core.playback.pause()
core.playback.toggle()
core.playback.next()
core.playback.last()
core.playback.cleanup()
```

`focusFrame()` 需要调用入口文件提供的 Canvas 更新能力，但不得直接依赖入口文件私有变量。入口文件应向 Core 注册：

```js
core.commands.redrawSelection = function () { ... }
core.commands.updateSelectionUI = function () { ... }
```

如果 Canvas 尚未初始化，`focusFrame()` 只更新状态并等待下一次 render。

### 4.5 `gif-editor-export.js`

职责：

- GIF 编码；
- PNG 帧上传和 ZIP 打包；
- Sprite Sheet；
- `composeFrame()` 调用；
- 结果 Modal；
- MediaBridge register/openGallery；
- 导出峰值内存提示。

公开 API：

```js
core.export.gif()
core.export.zip()
core.export.sprite()
core.export.closeResult()
core.export.openResultInGallery()
core.export.cleanup()
```

已有导出请求契约保持不变：

- `POST /api/archive/assets` / `/api/archive/pack` 优先路径；
- 旧 `/api/gallery/edit/upload-temp` / `/api/gallery/edit/zip-outputs` 兼容路径保留；
- MediaBridge 只接收受控 `MediaAsset`，不传绝对路径。

### 4.6 `gif-editor.js`

第一轮保留职责：

- `renderGifEditor()` / `cleanupGifEditor()`；
- 页面模板；
- `cacheDom()` 中对已有 Canvas、图层、裁剪、透明、输出字段的引用；
- Canvas `draw()`；
- Canvas 舞台交互；
- 网格切片；
- 全局裁剪；
- 透明抠图；
- 图层；
- `composeFrame()` 的已有实现或注册入口；
- 通用 spinner；
- 页面级 render/teardown。

入口文件不能重新拥有 import/timeline/playback/export 的业务实现，只负责调用模块 API 和注册基础回调。

后续可选拆分：

```text
gif-editor-decode.js
 gif-editor-canvas.js
gif-editor-layers.js
gif-editor-effects.js
```

本轮不实施，避免扩大迁移面。

---

## 5. Core 接口和生命周期

### 5.1 Core 初始化

`gif-editor-state.js` 首先加载并创建 Core：

```js
window.GifEditorCore = (function () {
  'use strict';

  var modules = {};
  var cleanupFns = [];

  return {
    state: state,
    dom: {},
    modules: modules,
    commands: {},
    registerModule: function (name, api) { ... },
    registerCleanup: function (fn) { cleanupFns.push(fn); },
    cleanupModules: function () { ... }
  };
})();
```

实际实现不使用占位 `...`；计划中的伪代码只表示接口形状。

### 5.2 DOM 缓存

入口模板注入后，入口调用：

```js
core.dom.canvas = document.getElementById('gif-preview-canvas')
core.dom.timeline = document.getElementById('gif-timeline')
core.dom.timelineScroll = document.getElementById('gif-timeline-scroll')
core.dom.timelineToolbar = document.getElementById('gif-timeline-toolbar')
```

模块只能从 `core.dom` 读取元素，禁止每个模块重复缓存整个页面。

### 5.3 Render 顺序

```text
renderGifEditor(container)
  ↓
cleanup previous modules
  ↓
container.innerHTML = pageTemplate()
  ↓
cacheDom()
  ↓
register Canvas callbacks
  ↓
import.bindEvents()
  ↓
timeline.bindEvents()
  ↓
playback.bindEvents()
  ↓
export.bindEvents()
  ↓
timeline.render()
  ↓
draw()
  ↓
resetView()
```

### 5.4 Cleanup 顺序

```text
cleanupGifEditor()
  ↓
playback.cleanup()       # 停止 timer
  ↓
import.cleanup()         # 取消 draft、释放 object URL
  ↓
timeline.cleanup()      # 移除滚动/拖拽/resize 监听
  ↓
export.cleanup()         # 关闭结果资源、释放 object URL
  ↓
entry cleanup            # 移除 Canvas/window/document 监听
  ↓
清空 state 中的大对象
```

`cleanup()` 必须可以重复调用，不得因元素已不存在而抛异常。

---

## 6. Import Modal 详细设计

### 6.1 Modal 结构

使用现有 `#modal-overlay`，内容采用 `.gif-import-modal`：

```text
┌────────────────────────────────────────────┐
│ 从视频导入帧 / 从 GIF 导入帧 / 导入图片       │
├─────────────────────┬──────────────────────┤
│                     │ 文件信息             │
│      预览区域        │ 原始分辨率           │
│                     │ 导入分辨率           │
│                     │ 源帧率/时长          │
├─────────────────────┴──────────────────────┤
│ 时间范围轨道（视频/GIF）                     │
│ 起点手柄 ───────────────────── 终点手柄      │
├────────────────────────────────────────────┤
│ 比例 [100] %      FPS [30]                   │
│ 起点 [0] ms       终点 [4000] ms             │
├────────────────────────────────────────────┤
│ 实际导入帧数：121                            │
│ 导入后播放时间：00:00:04.000                 │
├────────────────────────────────────────────┤
│                         取消        确定      │
└────────────────────────────────────────────┘
```

使用本项目现有：

- `.modal`
- `.modal-title`
- `.modal-body`
- `.modal-footer`
- `.btn-primary`
- `.btn-ghost`
- `.input`
- `renderStepperHtml()` 或同等现有控件风格
- `var(--*)` 主题 token

不直接复用 ScreenToGif 的视觉布局和颜色。

### 6.2 Draft 数据结构

```js
state.importDraft = {
  file: file,
  kind: 'image' | 'gif' | 'video',
  objectUrl: null,

  sourceWidth: 0,
  sourceHeight: 0,
  sourceDurationMs: 0,
  sourceFps: 0,

  scalePercent: 100,
  fps: 30,
  fpsMode: 'numeric' | 'source',
  startMs: 0,
  endMs: 0,

  image: null,
  video: null,
  gifFrames: null,
  gifTotalDurationMs: 0,
  previewFrameIndex: 0,
  previewTimer: null,
  previewGeneration: 0
};
```

`gifFrames` 只在 Modal 和确认导入期间保留。确认导入完成或取消时必须置空。

### 6.3 文件类型识别

优先使用 MIME，MIME 不可靠时回退到扩展名：

- `image/gif` 或 `.gif` → GIF；
- `video/*` 或常见视频扩展 → 视频；
- `image/*` 或常见图片扩展 → 图片；
- 其他类型 → 显示可读错误，不清空当前工程。

GIF/视频继续使用 `MAX_FILE_BYTES = 200MB` 单文件限制。

### 6.4 元数据读取

图片：

```js
sourceWidth = img.naturalWidth || img.width
sourceHeight = img.naturalHeight || img.height
sourceDurationMs = 0
```

GIF：

- 解析 GIF logical screen 尺寸；
- 完整合成 disposal 1/2/3；
- 每帧保存原始 delay 和累计时间；
- 总时长为所有帧 delay 之和；
- 平均 FPS 为 `1000 / averageDelay`，限制到 1–60 供 UI 显示。

视频：

```js
sourceWidth = video.videoWidth
sourceHeight = video.videoHeight
sourceDurationMs = Math.round(video.duration * 1000)
sourceFps = metadata FPS（无法取得时使用 30）
```

视频 `duration` 为 `0` 或 `Infinity` 时，显示 `gifEditorAlertVideoUnsupported`，关闭该 draft，不修改当前工程。

### 6.5 Modal 字段启用规则

| 字段 | 图片 | GIF | 视频 |
|---|---:|---:|---:|
| 原始分辨率 | 启用 | 启用 | 启用 |
| 导入比例 | 启用 | 启用 | 启用 |
| FPS | 禁用 | 启用 | 启用 |
| 起点 | 禁用 | 启用 | 启用 |
| 终点 | 禁用 | 启用 | 启用 |
| 时间范围滑块 | 禁用 | 启用 | 启用 |
| 预览 | 单帧 | 当前时间帧 | 当前视频位置 |
| 帧数/时长摘要 | 1/0ms | 按参数计算 | 按参数计算 |

### 6.6 双手柄范围控件

DOM 结构：

```html
<div class="gif-import-range" id="gif-import-range">
  <div class="gif-import-range-track"></div>
  <div class="gif-import-range-selected"></div>
  <input type="range" id="gif-import-start-range">
  <input type="range" id="gif-import-end-range">
  <div class="gif-import-range-marker" id="gif-import-preview-marker"></div>
</div>
```

约束：

```text
0 ≤ startMs < endMs ≤ sourceDurationMs
```

最小跨度：

```js
minSpanMs = Math.max(1, Math.round(1000 / fps))
```

交互规则：

- 起点滑块更新 `startMs`，但不得超过 `endMs - minSpanMs`；
- 终点滑块更新 `endMs`，但不得低于 `startMs + minSpanMs`；
- 数字输入失焦或回车时执行 clamp 和合法性校验；
- `startMs`、`endMs`、FPS 变化后同步更新 selected 区间宽度和摘要；
- 起点/终点变化后通过 100–150ms debounce 更新预览；
- 取消或全局 Modal 关闭事件发生时停止 debounce 和 preview timer。

selected 区间百分比：

```js
left = startMs / sourceDurationMs * 100;
width = (endMs - startMs) / sourceDurationMs * 100;
```

### 6.7 预览策略

视频：

- `video.currentTime = previewMs / 1000`；
- `seeked` 回调必须检查 draft generation，旧文件或旧 seek 不能覆盖当前预览；
- 预览 Canvas 使用导入比例后的尺寸，但不写入正式 `state.slices`；
- 用户拖动过程中不执行完整抽帧。

GIF：

- 由累计时间定位已解码帧；
- 只将对应完整合成 Canvas 绘制到预览 Canvas；
- 不在每次滑动时重新执行 GIF patch 解码。

图片：

- 直接绘制唯一图片；
- 预览按导入比例计算显示尺寸。

### 6.8 摘要计算

视频：

```js
var spanMs = endMs - startMs;
var frameCount = Math.max(1, Math.floor(spanMs * fps / 1000) + 1);
var durationMs = spanMs;
```

如果 `endMs === startMs`，在合法化阶段将 `endMs` 推进至少一个采样周期；不能展示 0 帧视频导入状态。

GIF：

- 默认 FPS 模式：计算时间范围内实际包含的 decoded frames；
- 指定 FPS 模式：按 `[startMs, endMs]` 采样时间点生成预计帧数；
- 预计播放时间等于选中范围内原始 delay 总和，或指定 FPS 模式下的用户选定区间。

图片：

```text
frameCount = 1
durationMs = 0
```

格式化：

```js
formatDurationMs(ms) // HH:MM:SS.mmm
```

显示必须同时包含可读文本和数字值，例如：

```text
实际导入帧数：121
导入后播放时间：00:00:04.000
```

### 6.9 确认导入事务

`commitImportDraft()` 必须遵循事务边界：

1. 读取并 clamp 所有字段；
2. 计算导入宽高和预计帧数；
3. 显示正式导入 spinner；
4. 在局部变量中生成 `nextSlices`；
5. 所有帧成功生成后才替换 `state.slices`；
6. 关闭 Import Modal；
7. 清理旧源媒体和 draft；
8. `renderTimeline()`、`focusFrame(0)`、`draw()`、`resetView()`；
9. 若任意帧生成失败，丢弃 `nextSlices`，保留旧工程并显示错误。

禁止先清空旧工程再开始视频抽帧。大文件失败时用户必须还能继续使用原工程。

### 6.10 视频正式抽帧

采样循环：

```js
for (var i = 0; i < frameCount; i++) {
  var sampleMs = startMs + i * 1000 / fps;
  if (sampleMs > endMs + 0.001) break;
  await seekTo(video, sampleMs / 1000);

  var frame = document.createElement('canvas');
  frame.width = importWidth;
  frame.height = importHeight;
  frame.getContext('2d').drawImage(video, 0, 0, importWidth, importHeight);
  nextSlices.push({
    id: freshId(),
    canvas: frame,
    delay: durationMs / frameCount,
    layers: []
  });
}
```

实现时必须处理：

- `seekTo()` 超时保护，避免媒体 seek 永久等待；
- 用户在导入期间切换页面或重新选择文件时，中止旧任务；
- 使用 `importGeneration` 检查异步任务是否仍属于当前 draft；
- 抽帧完成后将 `state.srcVideo` 绑定为正式源，或根据现有 Canvas 预览契约保留必要引用；
- 不在循环中频繁重建整条时间线，只更新 spinner 文案和百分比。

### 6.11 GIF 正式导入

默认模式：

- 选取起点到终点范围内的完整合成帧；
- 复制每帧 Canvas 到 `nextSlices`；
- 保留源 frame delay；
- 按导入比例创建目标 Canvas。

指定 FPS 模式：

- 用时间点查找源 decoded frame；
- 采样时间点重复命中同一源帧时，允许生成重复帧，这是 FPS 重采样的正常结果；
- 按选择区间分配导入 delay；
- 不直接把 patch Canvas 当作完整帧。

### 6.12 图片正式导入

- 创建一张按导入比例缩放后的 Canvas；
- `state.srcImg` 保留原图片，用于现有 image-tools；
- `state.processedImg` 由现有透明/边缘处理逻辑维护；
- Modal 确认后不自动执行网格切片，保留当前图片编辑流程；
- 如果用户随后点击 Grid Slice，继续调用现有 `runSlice()`。

---

## 7. 时间线详细设计

### 7.1 DOM 结构

当前单一容器：

```html
<div class="gif-timeline-area" id="gif-timeline"></div>
```

改为：

```html
<section class="gif-timeline-area" aria-label="GIF timeline">
  <div class="gif-timeline-scroll" id="gif-timeline-scroll">
    <div class="gif-timeline-track" id="gif-timeline"></div>
  </div>
  <div class="gif-timeline-toolbar" id="gif-timeline-toolbar">
    <div class="gif-timeline-zoom">
      <span class="gif-muted-label" id="gif-timeline-zoom-label"></span>
      <input type="range" id="gif-timeline-zoom-range" min="0.5" max="2" step="0.1" value="1">
      <span id="gif-timeline-zoom-value">100%</span>
    </div>
    <span class="gif-timeline-count" id="gif-timeline-count"></span>
    <div class="gif-timeline-nav" role="group">
      <button type="button" class="gif-timeline-control" id="gif-timeline-first"></button>
      <button type="button" class="gif-timeline-control" id="gif-timeline-prev"></button>
      <button type="button" class="gif-timeline-control" id="gif-timeline-play"></button>
      <button type="button" class="gif-timeline-control" id="gif-timeline-next"></button>
      <button type="button" class="gif-timeline-control" id="gif-timeline-last"></button>
    </div>
  </div>
</section>
```

实际 `id` 必须按 GIF 前缀规则命名；上面已符合 `gif-` 约束。按钮内容优先使用可读符号/文本组合，不依赖外部图标库。

### 7.2 滚动区

`.gif-timeline-scroll` 负责：

- `overflow-x: auto`；
- `overflow-y: hidden`；
- 原生横向滚动条；
- 虚拟化帧轨道；
- 滚动事件委托。

`.gif-timeline-area` 和 `.gif-timeline-toolbar` 不负责横向滚动。

滚动区必须具有明确高度，不允许因空轨道或底部 Toolbar 造成高度塌陷。

### 7.3 时间线倍率

状态：

```js
state.timeline.zoom = 1;
```

几何：

```js
itemWidth = Math.round(100 * zoom);
itemGap = Math.max(4, Math.round(10 * zoom));
itemPitch = itemWidth + itemGap;
```

倍率范围：

```text
50%–200%
```

倍率只影响：

- 帧卡片显示宽度；
- 帧卡片显示高度可按同一倍率 clamp 到合理范围；
- track 总宽度；
- 可见窗口数量；
- 选中帧可见位置。

倍率不影响：

- Canvas 帧实际分辨率；
- `state.slices`；
- 单帧 delay；
- 导出输出尺寸。

改变倍率时：

1. 记录当前选中帧和视口中心对应的帧；
2. 更新 geometry；
3. 重算 track 宽度；
4. 保持选中帧尽量处于原视口中心；
5. 重新计算虚拟窗口；
6. 更新 zoom 文本。

### 7.4 虚拟化兼容

保留当前：

- `TL_BUFFER = 4`；
- `THUMB_CACHE_MAX = 256`；
- 窗口化 DOM；
- 事件委托。

禁止在增加底部控制时回退成一帧一个永久 DOM 节点。

每次窗口更新必须满足：

```text
0 <= start <= end <= total
```

滚动到尾部时仍必须渲染最后一帧；滚动位置超出最大值时先 clamp。

### 7.5 帧卡片

保留当前功能：

- 点击选择；
- 复制；
- 删除；
- 每帧 delay 输入；
- 拖拽排序；
- 触摸排序。

帧卡片点击选择必须调用：

```js
core.commands.focusFrame(index)
```

### 7.6 底部控制栏

Toolbar 信息：

```text
🔍 100%   121 帧   24 / 121   |<   <   ▶   >   >|
```

控件语义：

| 控件 | 调用 | 边界 |
|---|---|---|
| 第一帧 | `core.playback.first()` | 无帧禁用；已有第一帧时保持选中 |
| 前一帧 | `core.playback.previous()` | 当前为 0 时禁用 |
| 播放/暂停 | `core.playback.toggle()` | 无帧禁用 |
| 后一帧 | `core.playback.next()` | 当前为最后一帧时禁用 |
| 最后一帧 | `core.playback.last()` | 无帧禁用；已有最后一帧时保持选中 |

当前帧文本使用 1-based 显示：

```text
当前：24 / 121
```

内部索引仍使用 0-based。

### 7.7 FocusFrame 命令

统一实现：

```js
function focusFrame(index, options) {
  options = options || {};
  var total = core.state.slices.length;
  if (!total) return false;
  index = Math.max(0, Math.min(total - 1, Number(index) || 0));

  core.state.selectedSliceIdx = index;
  core.state.mode = 'editor';
  core.dom.frameIndicator.textContent = formatFrameIndicator(index, total);

  if (core.commands.updateSelectionUI) core.commands.updateSelectionUI(index);
  if (core.commands.redrawSelection) core.commands.redrawSelection(index);
  if (options.ensureVisible !== false && core.timeline) {
    core.timeline.ensureVisible(index);
  }
  updatePlaybackButtons();
  return true;
}
```

实现时不得照抄伪代码中的未定义辅助函数；必须在对应模块中提供完整实现。

`options.ensureVisible === false` 只允许在内部批量更新或初始化时使用，用户按钮、键盘、点击和播放默认必须让焦点帧可见。

### 7.8 排序、复制、删除后的焦点

- 复制：焦点移到新复制帧；
- 删除当前帧：优先选同位置的新帧，删除尾帧时选新的最后一帧；
- 删除全部帧：焦点设为 `-1`，播放停止，Toolbar 全部控制禁用；
- 重排当前帧：焦点跟随被移动的帧；
- 重排其他帧：当前焦点按索引变化规则修正；
- 所有结构性变更后调用 `timeline.render()` 和 `updatePlaybackButtons()`。

### 7.9 播放状态机

```js
state.playback = {
  playing: false,
  timer: null,
  generation: 0
};
```

开始播放：

1. 无帧时直接返回；
2. 如果当前索引为 `-1`，先聚焦第一帧；
3. `generation++`；
4. 设置 `playing=true`；
5. 更新按钮为 Pause；
6. 以当前帧 delay 调度下一次切换。

每次 timer 回调必须检查 generation，防止旧 timer 在暂停/重播后继续推进帧：

```js
var generation = state.playback.generation;
state.playback.timer = setTimeout(function () {
  if (!state.playback.playing || generation !== state.playback.generation) return;
  if (state.selectedSliceIdx >= state.slices.length - 1) {
    pause();
    return;
  }
  focusFrame(state.selectedSliceIdx + 1);
  scheduleNext();
}, delay);
```

暂停必须：

- `playing=false`；
- `generation++`；
- `clearTimeout(timer)`；
- `timer=null`；
- 保留当前焦点帧；
- 更新按钮为 Play。

### 7.10 键盘行为

保留现有：

- ArrowLeft → Previous；
- ArrowRight → Next；
- Home → First；
- End → Last；
- PageUp → Previous；
- PageDown → Next。

当焦点位于 input、textarea、select、contenteditable 或 Import Modal 内时，不拦截时间线快捷键。

Space 可作为 Play/Pause，但只在：

- 没有打开 Modal；
- 当前焦点不是表单控件；
- 当前 GIF 页面仍然活动；

的条件下处理。

---

## 8. 页面模板、脚本和样式接线

### 8.1 脚本加载顺序

两个入口 `web/static/index.html` 和 `web/static/index-nopg.html` 必须保持同序：

```html
<script src="/media-bridge.js"></script>
<script src="/vendor/gif.js/gif.js"></script>
<script src="/vendor/gifuct-js/gifuct-js.js"></script>
<script src="/gif-editor-state.js"></script>
<script src="/gif-editor-import.js"></script>
<script src="/gif-editor-timeline.js"></script>
<script src="/gif-editor-playback.js"></script>
<script src="/gif-editor-export.js"></script>
<script src="/gif-editor.js"></script>
```

约束：

- vendor 必须先于解码/导出模块；
- `media-bridge.js` 必须先于导出模块；
- `gif-editor.js` 最后加载，因为它负责 render/cleanup 和模板；
- 不新增 `internal/api/router.go` 的 Playground 白名单项：这些文件位于 `web/static`，由主静态 embed 提供；
- 如项目当前入口的实际 script 顺序已有差异，以两个入口的共同可用顺序为准，并在文档中记录。

### 8.2 `pageTemplate()` 调整

导入区：

- 继续保留 `#gif-drop-zone`；
- `#gif-file-input` 仍为 hidden；
- 删除或隐藏原侧栏中“视频提取设置”作为正式导入参数的 UI；
- 原视频 FPS 控件不得与 Modal 中的导入 FPS 共用 id；
- 图片 edge trim、网格切片仍保留在图片工具区域；
- Import Modal 的字段全部使用独立 `gif-import-*` id。

时间线区：

- 用 §7.1 的 scroll + track + toolbar 结构替换单一 `#gif-timeline`；
- 保留 `gif-timeline-track` 的虚拟化绝对定位；
- 新增按钮必须有 `type="button"`、可读 `title`、`aria-label`；
- 播放按钮必须动态同步 `aria-label` 和 `aria-pressed`。

### 8.3 样式范围

所有新增选择器必须使用以下前缀之一：

- `.gif-`；
- `.gif-import-`；
- `.gif-timeline-`。

必须遵守 `DESIGN.md`：

- 容器和按钮使用 `var(--radius-*)`；
- 结构字体使用 `var(--font-weight-normal)` / `var(--font-weight-bold)`；
- 结构阴影使用 `var(--shadow-card)` / `var(--shadow-modal)`；
- 背景、边框、文字和状态颜色使用现有主题 token；
- 过渡使用 `var(--transition-*)`；
- 不增加新的硬编码紫色、背景色或固定字体；
- 所有新增交互控件至少保持 24×24px 触控尺寸；
- `:focus-visible` 必须有 `2px solid var(--accent)` 的可见轮廓。

Modal 响应式：

- 桌面宽度建议 `min(900px, calc(100vw - 32px))`；
- 小屏改为单列预览/信息布局；
- Modal body 可纵向滚动；
- 时间范围轨道不得因窄屏溢出；
- Footer 按钮在小屏可以等宽排列。

Timeline 响应式：

- scroll viewport 允许横向滚动；
- toolbar 在窄屏允许换行；
- 五个控制按钮保持最小触控尺寸；
- zoom 控件可收缩，但当前帧/总帧数不能隐藏。

---

## 9. 文件变更清单

### 9.1 新增文件

```text
web/static/gif-editor-state.js
web/static/gif-editor-import.js
web/static/gif-editor-timeline.js
web/static/gif-editor-playback.js
web/static/gif-editor-export.js
gif_upgrade.md
```

### 9.2 修改文件

```text
web/static/gif-editor.js
web/static/index.html
web/static/index-nopg.html
web/static/style.css
web/static/i18n.js
web/static/app.js                 # 仅在统一 modal-close 事件需要时修改
gif_implented.md
PROJECT_MAP.md
docs/playground-architecture.md
```

### 9.3 不应修改的文件

本轮不应修改：

```text
internal/mediaedit/*
internal/api/gallery/*
web/playground/static-pg/gallery-*.js
web/static/vendor/gif.js/*
web/static/vendor/gifuct-js/*
```

除非验证发现现有导出或 vendor 契约确实因拆分回归；若必须修改，需先记录原因并同步相应架构文档。

### 9.4 文档同步

`gif_implented.md`：

- 在“最后核对”行记录本轮模块拆分和 Import Modal；
- 更新 P1/P4 状态；
- 增加 Import Modal、时间线 Toolbar、播放控制的源码函数锚点；
- 更新 ADR，记录 classic script + `GifEditorCore` 选择；
- 记录视频采样包含终点和 121 帧/4000ms 契约。

`PROJECT_MAP.md`：

- §18.2 增加 5 个 GIF Editor 子模块及职责；
- §24 GIF Editor 条目列出所有新增 `web/static` 文件、入口加载顺序和 `app.js` modal-close 影响；
- 明确 GIF Editor 仍不属于 Playground 静态资产。

`docs/playground-architecture.md`：

- 更新最后核对日期；
- 在 GIF Editor 事实基线中增加模块结构和导入/时间线边界；
- 说明 Gallery 的后端媒体 API 不受本轮影响；
- 保留 GIF Editor 与 MediaBridge 的生产者边界。

---

## 10. 分阶段实施顺序

每个阶段都必须先读当前源码锚点；编辑后重新读取受影响范围，不能继续使用过期行号。

### P0：建立 Core 和脚本接线

实现：

1. 新建 `gif-editor-state.js`；
2. 将现有 IIFE 的基础状态、DOM 引用辅助和生命周期注册迁移到 Core；
3. 入口文件改为读取 `GifEditorCore`；
4. 两个 HTML 入口按 §8.1 增加脚本；
5. 不改变导入、时间线、导出用户行为。

验收：

- `node --check` 通过；
- 点击 GIF 页面可以渲染；
- 图片/GIF/视频现有导入仍可工作；
- 三种导出仍可工作；
- 页面离开后没有旧事件重复触发；
- `GifEditorCore` 是唯一模块共享全局。

### P1：迁移 Import 模块并实现 Import Modal

实现：

1. 新建 `gif-editor-import.js`；
2. 将文件选择、拖放、粘贴迁移；
3. 实现 `importDraft`；
4. 实现图片/GIF/视频元数据读取；
5. 实现 Modal 结构和主题样式；
6. 实现取消不破坏当前工程；
7. 实现视频/GIF 起止范围、比例、FPS、摘要；
8. 实现双手柄和数字字段联动；
9. 实现 debounce 预览；
10. 实现正式确认导入事务。

验收：

- 选择图片、GIF、视频都打开 Modal；
- 拖放和粘贴也打开同一 Modal；
- 取消后原帧序列和当前选帧保持不变；
- `1280×720 / 0–4000ms / 30FPS / 100%` 显示 `121` 帧和 `4000ms`；
- 改动比例时导入尺寸更新；
- 改动 FPS 时预计帧数更新；
- 改动起点/终点时滑块、数字值、预览、摘要同步；
- 非法范围被 clamp 或明确拒绝；
- 视频抽帧失败时旧工程保留。

### P2：迁移 Timeline 模块并实现独立滚动区

实现：

1. 新建 `gif-editor-timeline.js`；
2. 迁移当前虚拟化窗口和有界缩略图缓存；
3. 将时间线 DOM 改为 scroll viewport + track + toolbar；
4. 保持复制、删除、delay、排序行为；
5. 增加 50%–200% zoom；
6. 保持选中帧可见；
7. 处理空帧和 10000 帧几何边界。

验收：

- 原生横向滚动条可见且只出现在帧轨道区域；
- 1、5、63、64、1000、10000 帧窗口计算有界；
- 首部、中部、尾部滚动均能显示正确帧；
- 50%、100%、200% 缩放均不破坏 track 几何；
- 点击帧、复制、删除、排序回归通过；
- 时间线不因 zoom 回退为全量 DOM。

### P3：迁移 Playback 模块并实现底部控制

实现：

1. 新建 `gif-editor-playback.js`；
2. 实现统一 `focusFrame()`；
3. 将键盘导航改为调用焦点命令；
4. 增加 First/Previous/Play/Pause/Next/Last；
5. 实现按帧 delay 的递归 timer；
6. 实现按钮边界 disabled 和 aria 状态；
7. 处理页面离开和重复 render 清理。

验收：

- 五个按钮切换的是帧焦点，不是单独滚动；
- 焦点切换后选中帧必要时自动可见；
- 第一帧、最后一帧边界正确；
- 播放按每帧 delay 运行；
- 播放到最后一帧自动暂停；
- 暂停保留当前帧；
- 反复进入/离开 GIF 页面没有 timer 残留；
- input/textarea 内不会误触发时间线快捷键。

### P4：迁移 Export 模块和结果交接

实现：

1. 新建 `gif-editor-export.js`；
2. 迁移 GIF、ZIP、Sprite 导出；
3. 迁移结果 Modal 和 MediaBridge；
4. 入口通过 Core 注册 `composeFrame()` 和输出配置读取；
5. 保持 export memory warning；
6. 清理 object URL 和在途 register。

验收：

- GIF 导出仍使用 gif.js 同源 worker；
- ZIP 导出仍走 Archive API 优先/legacy fallback；
- Sprite Sheet 仍可预览、下载和 Open in Gallery；
- 导出不读取 Import Modal 临时状态；
- MediaBridge 不接收绝对路径；
- 页面离开后结果 URL 按既有契约清理。

### P5：回归、文档和最终验证

实现：

1. 补齐 i18n 中英文键；
2. 更新 `gif_implented.md`；
3. 更新 `PROJECT_MAP.md`；
4. 更新 `docs/playground-architecture.md`；
5. 清理迁移后入口文件中的重复/孤儿 import、timeline、playback、export 实现；
6. 运行完整验证。

---

## 11. 验证矩阵

### 11.1 静态检查

```powershell
node --check web/static/gif-editor-state.js
node --check web/static/gif-editor-import.js
node --check web/static/gif-editor-timeline.js
node --check web/static/gif-editor-playback.js
node --check web/static/gif-editor-export.js
node --check web/static/gif-editor.js
node --check web/static/i18n.js
```

如果仓库已有统一前端检查脚本，优先使用该脚本；上述命令作为最小证明。

### 11.2 构建检查

```powershell
go build ./...
go build -tags playground ./...
```

本轮不新增 Go 代码，但必须确认静态资产嵌入和两个构建变体不受影响。

### 11.3 页面冒烟

至少驱动以下场景：

#### 图片

1. 进入 GIF 页面；
2. 选择 PNG/JPEG；
3. Modal 显示源分辨率；
4. 比例 50%/100%/200% 切换；
5. 确认后得到一帧；
6. 继续执行边缘修正和网格切片。

#### GIF

1. 选择含透明和 disposal 2/3 的 GIF；
2. Modal 显示 logical screen 尺寸和总时长；
3. 调整范围；
4. 调整 FPS；
5. 调整比例；
6. 确认后检查帧数、帧画面、delay；
7. 继续图层编辑和 GIF 导出。

#### 视频

1. 选择短 MP4/WebM；
2. Modal 显示分辨率、时长和 FPS；
3. 设置 `0–4000ms / 30FPS / 100%`；
4. 检查 `121` 帧和 `4000ms`；
5. 拖动起点/终点，观察 preview 和数字字段；
6. 确认导入；
7. 检查帧尺寸和播放时间；
8. 运行 GIF、ZIP、Sprite 三种导出。

#### 取消和异步竞态

1. 已有工程时选择新文件；
2. Modal 取消；
3. 确认旧帧、旧选中帧、旧图层未丢失；
4. 导入过程中切换页面；
5. 返回 GIF 页面，确认旧异步任务不更新新页面；
6. 快速连续选择两个文件，确认最后一次任务拥有有效 generation。

#### 时间线

1. 1、5、63、64、1000、10000 帧；
2. 50%、100%、200% zoom；
3. 拖动横向滚动条到尾部；
4. 点击尾帧；
5. First/Previous/Play/Next/Last；
6. 删除最后一帧、删除全部帧；
7. 拖拽排序；
8. 页面切换后重新进入。

#### 主题和响应式

1. dark/light；
2. 中英文；
3. 低宽度窗口；
4. Modal body 滚动；
5. timeline toolbar 换行；
6. `:focus-visible` 和 Tab 焦点循环。

### 11.4 结果判定

交付前必须满足：

- 关键静态检查通过；
- 默认构建和 Playground 构建通过；
- 图片/GIF/视频三类导入完成；
- 取消不破坏旧工程；
- 视频参数与截图契约一致；
- 时间线滚动条和底部五控件可操作；
- 播放 timer 无页面残留；
- 三种导出没有回归；
- 文档和资产清单已同步。

---

## 12. 风险与处理

| 风险 | 影响 | 处理 |
|---|---|---|
| 模块拆分时私有 IIFE 状态丢失 | 页面初始化失败或功能静默失效 | 先建立 `GifEditorCore`，再逐块迁移；每块迁移后立即静态检查和页面冒烟 |
| Import Modal 关闭路径不统一 | object URL、draft、timer 残留 | `closeModalOverlay()` 发送通用关闭事件；import 模块 cleanup 幂等 |
| 视频 seek 永久等待 | 导入 spinner 卡死 | `seekTo()` 增加 timeout；导入 generation 失效时中止；错误保留旧工程 |
| 快速调整起止范围造成高 CPU | 预览卡顿、旧 seek 覆盖新预览 | 100–150ms debounce；旧 seek 检查 generation；只预览当前帧 |
| 包含终点语义与媒体实际 duration 边界冲突 | 最后一帧超出视频长度 | sampleMs 超过 endMs 或 duration 时 clamp；实际帧数以有效采样点为准，摘要显示最终有效值 |
| 浮点 frame delay 被 UI/编码器截断 | 播放时间略有误差 | 内部保留数字 delay；显示格式化；导出 GIF 的厘秒量化误差在结果统计中说明 |
| 时间线 zoom 破坏虚拟窗口 | 空白、尾部无法到达或 DOM 暴增 | geometry 单一来源；每次 zoom 后 clamp、重算窗口；保留 buffer 和缓存上限 |
| 旧按钮仍绑定旧函数 | 双重事件或按钮无效 | 迁移完成后删除入口文件中的旧 listener/函数；每个模块只绑定一次并在 cleanup 对称移除 |
| classic script 加载顺序错误 | Core 或 vendor 未定义 | 两个入口逐一检查顺序；页面浏览器冒烟必须覆盖 no-playground 和 playground 构建 |
| 文档与源码脱节 | 后续实施者误用旧锚点 | 每阶段结束更新 `gif_implented.md`/`PROJECT_MAP.md`/架构文档；锚点优先使用函数名而不是脆弱行号 |

---

## 13. 完成定义

本轮只有同时满足以下条件才算完成：

1. `gif-editor.js` 已按 §4 拆分，入口文件不再承担新增模块的全部实现；
2. 文件选择/拖放/粘贴统一进入 Import Modal；
3. Modal 实际提供并联动比例、FPS、起点、终点、进度条、帧数和时长；
4. 取消导入不破坏旧工程；
5. 确认导入按参数生成图片/GIF/视频帧；
6. 时间线拥有独立横向滚动区和 zoom；
7. 底部拥有总帧数、当前帧和五个焦点/播放控制；
8. 控制按钮切换帧焦点，滚动只作为焦点可见性辅助；
9. 播放按帧 delay 调度并能可靠暂停/清理；
10. 原有图层、裁剪、透明、切片、排序、删除和三种导出无回归；
11. 两个 HTML 入口、i18n、主题样式和所有文档均同步；
12. §11 的静态、构建、浏览器和回归验证均有实际结果。

未完成上述任一项时，不得以“模块已经拆出”或“Modal 已显示”为完成交付。

---

## 14. 实施时的快速入口

实施者按以下顺序读取并执行：

1. 本文件 §1–§3：理解现状、范围和固定决策；
2. 本文件 §4–§5：建立模块和 Core 接口；
3. 本文件 §6：实现 Import Modal 和正式导入；
4. 本文件 §7–§8：实现时间线、底部控制、脚本和样式接线；
5. 本文件 §10：按 P0–P5 顺序执行；
6. 本文件 §11：运行验证矩阵；
7. 更新 §9.4 所列文档，并以 §13 判断完成。

优先修改现有文件、复用现有模式、避免新建平行机制。任何与本文固定契约冲突的实现都必须先修订本文，再修改代码。