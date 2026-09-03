---
name: tinylab-gif-editor
description: "TinyLab GIF editor (web/static/gif-editor/): transparency engine internals (redmean color key, flood fill, GIMP C2A) and headless-Chrome smoke testing with programmatic pixel assertions."
---

# TinyLab GIF Editor


## tinylab-gif-editor-browser-smoke


### TinyLab GIF Editor headless smoke (no visual reasoning)

Use when changing `web/static/gif-editor/*` and needing runtime proof without screenshots/visual checks. Verified 2026-08-12 on the transparency-engine refactor (18/18 assertions).

#### Setup
1. Build + run with a temp config (strict YAML: port only):
   ```bash
   go build -o C:/tmp/tr-smoke/tr.exe .
   printf 'port: 18789\n' > C:/tmp/tr-smoke/data/config.yaml
   ```
   Start via hub with `ready={"log":"started","port":18789}`. NOTE: Go exe can get AV-quarantined between build and launch on this machine — if launch says "file not found" right after a successful build, rebuild and launch immediately.
2. Scratch dir + puppeteer-core: `mkdir node && cd node && npm i puppeteer-core`; launch `executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'`, headless 'new', `--no-sandbox --disable-gpu`.
3. `page.goto('http://127.0.0.1:18789/')` with `waitUntil:'domcontentloaded'`, sleep ~1.2s for shell init.

#### Driving the editor without the Import Modal
```js
renderGifEditor(document.getElementById('page-content'));   // bypasses app.js nav
const core = window.GifEditorCore;
const c = document.createElement('canvas'); c.width=64; c.height=64;
const g = c.getContext('2d');
g.fillStyle='#ffffff'; g.fillRect(0,0,64,64);              // background
g.fillStyle='#ff0000'; g.fillRect(20,20,24,24);            // "character"
core.state.slices = [{ id: 1, canvas: c, delay: 100, layers: [] }];
core.state.source.kind='image'; core.state.source.gridSliced=false;
core.state.processedImg = c; core.state.selectedSliceIdx = 0;
core.commands.updateSourcePanels('image', {});
core.commands.updateSelectionUI(0); core.commands.redrawSelection(0);
core.timeline.render();
```
Stage clicks: dispatch synthetic `MouseEvent('mousedown',{clientX,clientY,bubbles:true})` on `#gif-stage-container` with `clientX = rect.left + (x/64)*rect.width` from `#gif-preview-canvas.getBoundingClientRect()` (canvas coords → client coords; the canvas is inside a transformed wrapper, so ALWAYS map via the rect). Panel buttons: plain `.click()`; range/color inputs: set `.value` then `dispatchEvent(new Event('input',{bubbles:true}))`; checkboxes: `new Event('change',{bubbles:true})`.

#### Pitfalls (each cost a debug cycle)
- **Do NOT sample stage pixel (0,0) for transparency proof.** `drawEdgeCropGrid` (active for unsliced image sources) strokes a 2px `#ff0055` border over the whole frame + seed markers are drawn at the seed point — (0,0) is overlay territory. Sample (5,5) (background) and (32,32) (character interior) instead.
- **`getThumb` returning `undefined` manifests as `img.src == "http://host/undefined"`** (relative-URL resolution), NOT an empty src. If a timeline thumb looks broken, check the function actually `return dataUrl;` — the edit-tool auto-repair can drop a trailing return when replacing a function tail. Thumb cache keyed by `slice.id` — after state changes call `core.timeline.clearThumbCache(); core.timeline.render();`.
- **Thumbs must run the transparency pipeline on the FULL frame before crop+downscale** (flood connectivity must match stage/export) — do not apply per-thumb-crop pixels.
- Assert committed-state semantics via `core.state.trans.committed` (Apply freezes live params there; export/thumb only read committed) — not via DOM checkbox alone.
- Page console noise is normal: `404`s and `vendor/diff.min.js` MIME refusal come from the app shell (pre-existing), filter them out of page-error assertions. Filter `pageerror` for the real JS errors.

#### Assertion set (transparency feature, all programmatic)
1. Live preview BEFORE Apply: stage (5,5) alpha == 0, (32,32) still opaque, seed-count label updated.
2. Sprite preservation: flood seed at (0,0) must NOT remove interior red at (32,32).
3. Cancel: checkbox unchecked, `trans.committed` null, stage restored opaque.
4. Apply: checkbox on, committed frozen; thumb PNG dataURL corner alpha==0, center red opaque.
5. Export compositor: `core.commands.composeFrame(0, tmp, {applyTransparency:true, matte:'#FF00FF'})` → removed pixel = matte, sprite pixel opaque.
6. Disable: checkbox off, committed null, thumb back to opaque.

Decode thumb dataURLs in-page (`new Image()` + draw to a probe canvas + `getImageData`) — resolves inside `page.evaluate` with a Promise.

#### Cleanup
Stop the hub process, `rm -rf C:/tmp/tr-smoke`.

## tinylab-gif-editor-transparency-engine


### TinyLab GIF Editor 透明引擎（非破坏提交模型）

2026-08-12 重构后的权威事实。改透明相关代码前先读此 skill + `gif_implented.md` 顶部 2026-08-12 最后核对块。

#### 核心模型：slice canvas 永不烘焙

`state.trans`（`gif-editor-state.js`）持有：
- **live 参数**：`mode`（'color'|'flood'）、`keyColor`、`fuzziness`（0–100）、`seeds`（[{x,y}] 画布坐标）、`corner`（角点预设）、`c2a`（软边）——面板打开时舞台预览用它们
- **`committed` 快照**：Apply 按钮把 live 参数冻结进来；缩略图、导出**只认 committed**

管线函数在 `web/static/gif-editor/gif-editor-transparency.js`（`window.GifEditorTransparency`，零 DOM 依赖，Node VM 可直接测）：
- `chromaKeyToAlpha(imgData, key, fuzz)` — 颜色去背，**redmean 感知色距**（旧实现是 RGB box 距离），`fuzzThreshold(fuzz) = fuzz * 7.65`（0–100 → 0–765）
- `floodFillToAlpha(imgData, x, y, fuzz)` — 区域去背：扫描线（行 run 追踪，**不是**经典双边界像素版——整行 span 时双边界版会漏推相邻行），只删与种子同色**连通**区域；已透明像素可穿越（match 返回 true）；种子在透明像素上 = no-op
- `cornerFloodToAlpha` — 四角 flood 预设
- `colorToAlphaGimp(imgData, key)` — GIMP C2A 软边：`a = max(|ΔR|,|ΔG|,|ΔB|)`，`F = (N - (1-a)·B)/a` 夹到 [0,255]；GIF 单透明索引不支持部分 alpha（仅 PNG/精灵图/ZIP 生效）
- `applyPipeline(imgData, opts)` / `hasActiveRemoval(opts)` — 分发与门控
- 所有函数跳过已透明像素（幂等）

#### 消费者（改任何一个都要知道）

| 消费者 | 用的参数 | 位置 |
|---|---|---|
| 舞台预览 draw() | 面板打开 → `liveTransParams()`；面板关+已应用 → `committedTransParams()`；`previewTransParams()` 统一 | gif-editor.js draw() |
| 缩略图 | **committed only**；在**全尺寸**帧上跑管线再裁方缩略（flood 连通性必须与舞台一致） | timeline.js `getThumb` |
| 导出（GIF/PNG/ZIP） | committed only；`isTransparencyEnabled()` = checkbox && transparencyReady && **trans.committed 非空** | export.js + composeFrame（`applyTransparency: true` → committed，对象 → 显式参数） |
| 变换类操作 | `materializeTransparency()` 先把 committed 烘焙进所有 slice + processedImg，然后清空 committed（flood 种子坐标随几何失效） | runSlice / applyCrop / 全局缩放 / splitApplyBtn |

#### 关键不变量

- **隐藏复选框 `#gif-enable-trans` 镜像 committed**（`updateSourcePanels` 里 `checked = !!trans.committed`）——页面重入（resume）不能丢已应用透明；`updateSourcePanels(kind, {resetTrans:true})` 才全量重置（import commit、Reset）
- Apply = `trans.committed = liveTransParams()` + 勾选 + `clearThumbCache()` + `timeline.render()`（缩略图同步透明）
- Cancel = 丢弃 live 改动，DOM 恢复到 committed（有 committed 时）或 `resetTransState()`（无）
- Disable（`#gif-disable-trans-btn`）= `resetTransState()` → 全还原（真正的 undo）
- 舞台点击：`floodPickMode` 分支在 `pickColorMode` 之前；Esc 两模式都退出（capture-phase keydown）

#### 验证（用户偏好：**不要截图视觉推理**）

1. `node web/gif-editor-transparency.test.js`（24 项纯函数契约：连通性/精灵图内部幸存/透明穿越/角点/C2A 合成不变性 `F·a + B·(1-a) == N`）
2. 既有 `web/gif-editor-export-contract.test.js`、`web/gif-editor-i18n-args.test.js` 必须全绿
3. headless Chrome 冒烟用**程序化像素断言**（`getImageData` 采样 alpha/RGB），从不截图

#### 已知坑（本会话踩过）

- `getThumb` 的 `return dataUrl` 极易被 edit 工具的自动修复吞掉 → 缩略图 src 变 `/undefined`（坑特征：img.src 解析成 `http://host/undefined`）
- 采样 (0,0) 会被 edge-crop grid 的 2px stroke 覆盖（未切片图片）——采样点用 (5,5) 等避开边框；种子标记/裁剪框 overlay 同理
- `'bad'` 是合法 3 位 hex 色（扩展成 `bbaadd`）——测试无效色用 `'zzz'`
- VM 沙箱里 `assert.deepStrictEqual` 跨 realm 对象会因原型不同失败——逐字段断言
- 缩略图透明背景：`.gif-thumb-wrapper` 棋盘格（暗色 `#262626`/`#3a3a3a`，亮色 `#f0f0f0`/`#d0d0d0`，12px 对角双渐变）——不是纯黑
- 本机 anysearch CLI 直连超时 → 用 `anysearch-cli-proxy-workaround` skill 的 curl 走代理方式，或按用户偏好退回内置 web_search

