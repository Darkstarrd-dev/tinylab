# TinyRouter CSS 优化计划

> 计划状态：进行中
>
> 基线日期：2026-08-07
>
> 基线提交：`1cfc16e`（前端目录按功能子目录整理并收拢 CSS 归属）
>
> 适用范围：`web/static/style.css`、`web/playground/static-pg/playground.css`、生产 HTML shell、主题 Token、业务 JS 生成的动态 UI 样式，以及与 CSS 交付/验证有关的文档和构建流程。
>
> 第三方样式（`web/playground/static-pg/vendor/` 下的 KaTeX、Highlight 主题等）默认不重构；除非发生明确的兼容性或主题覆盖问题。

---

## 1. 目标与总决策

### 1.1 目标

1. 降低 CSS 的重复规则、特异性冲突和 `!important` 依赖。
2. 让颜色、表面、状态、边框、圆角、阴影、动效和间距继续遵循 `DESIGN.md` 的三维主题模型：
   - `data-theme`：dark / light；
   - `data-theme-variant`：每种模式的颜色变体；
   - `data-theme-style`：default / sharp / soft / compact 的形状、阴影、动效和间距。
3. 保持全局 shell、页面 DOM、JavaScript 行为、快捷键、构建变体和 embed 交付契约不变。
4. 让 Playground、Gallery、Editor、Text Review 等模块的样式边界清晰，新增样式有命名空间。
5. 提升响应式、键盘焦点、减少动效和触摸目标的可验证性。
6. 为未来按模块拆分 CSS 保留可控路径，但不以“拆文件”本身作为优化目标。

### 1.2 总决策

本项目不进行一次性全量重写、压缩或盲目拆分。采用“先建立基线 → 修正 Token → 清理层叠 → 统一基础控件 → 页面级收拢 → 再评估拆文件”的顺序。

原因：

- `style.css` 同时承载主题、全局布局、Header、按钮、表单、Modal、Settings、Download、Monitor、Auth 等基础设施；大范围移动规则容易破坏跨页面契约。
- `playground.css` 以 `.pg-*`、`.ed-*`、`.ge-*` 等模块命名空间为主，但仍包含全屏布局、主题覆盖、Editor/Gallery/Text Review 和 Log Reader 等多个边界。
- TinyRouter 没有 CSS bundler；CSS 文件通过 HTML 和 `embed.FS` 交付。拆分必须同步入口、静态资产、构建变体和 HTTP 验证。
- 现有主题不是单一 dark/light，而是 72 个组合（2 mode × 9 variant × 4 style），任何 Token 或层叠调整都必须避免只在默认暗色下成立。

### 1.3 当前基线

| 资产 | 当前事实 | 主要风险 |
|---|---|---|
| `web/static/style.css` | 约 4,298 行；包含根 Token、light 层、主题变体、全局 reset/layout、Header、按钮/表单、Modal、Settings、Download、Monitor、Auth 等 | 全局规则和页面规则共存；重复 selector、特异性堆叠、历史兼容覆盖较难定位 |
| `web/playground/static-pg/playground.css` | 约 1,067 行；包含 Playground、Image、Search、Group Chat、Editor、Text Review、GIF 相关共享样式、Log Reader | 模块命名空间较好，但仍有跨模块基础规则、light 覆盖和若干高特异性修复 |
| `web/playground/static-pg/vendor/*.css` | 第三方 KaTeX 与 Highlight 主题 | 不纳入常规清理；不能因项目规则误删第三方兼容样式 |
| CSS 交付 | `style.css` 由两个 HTML shell 使用；Playground 资产由 `-tags playground` 变体和 `feature.Assets` 路由提供 | 工作区修改不会自动进入已有二进制；必须重新构建并通过 HTTP 验证 |
| 动态 UI | 多个 JS 通过 `innerHTML`、`style`、`style.cssText` 生成临时控件 | 静态表现规则可能散落在 JS；但几何坐标、进度、尺寸等运行时值不能机械迁移 |

当前已知的高风险样式类别：

- `html, body, .app` 的 Playground 全屏滚动约束；
- Header 86px 子区域与 98px 容器高度契约；
- `.nav-item`、`.pg-mode-btn` 的 active/hover/focus 状态；
- Settings Toggle、Stepper、Custom Select 的层叠关系；
- Monitor 工具栏的固定 28px 高度；
- Text Review Step1/Step2 的 `height`/`gap` 强制规则；
- GIF/媒体编辑器的拖拽、时间线和 Trim 控件；
- light theme 对用户气泡、代码块、Diff、Select option 的专门覆盖。

### 1.4 首轮基线快照（2026-08-07）

本轮仅做文件级静态统计（只读）：未修改任何生产 CSS/JS/HTML，未运行构建或测试。

| 指标（口径见下） | `web/static/style.css` | `web/playground/static-pg/playground.css` |
|---|---|---|
| 行数（`wc -l`，换行符计数） | 4,297 | 1,066 |
| 字节数（UTF-8，`wc -c`） | 206,136 | 100,356 |
| `!important` 出现次数（子串，不区分大小写） | 108 | 26 |
| `@media` 块数 | 11 | 5 |
| `@keyframes` 定义数 | 12 | 4 |
| 花括号块总数（近似） | 1,277 | 862 |
| 其中：顶层块 | 1,183 | 840 |
| 顶层普通 selector 规则（近似） | 1,157 | 831 |
| 嵌套块（`@media` 内部规则等） | 94 | 22 |
| 其他 at-rule | `@supports`×1、`@container`×1 | 无 |
| 最大花括号嵌套深度 | 2 | 2 |

统计口径：

- 行数 = `wc -l`（换行符计数）。`style.css` 文件末尾无换行符、`playground.css` 末尾有换行符，因此编辑器/阅读工具显示的行号分别为 4,298 / 1,067（与 1.3 的估算一致）。
- 字节数 = UTF-8 编码字节数。
- `!important` = 子串出现次数（非行数），case-insensitive。
- `@media`、`@keyframes` = 块数量；`@-webkit-keyframes` 前缀兼容副本（`style.css` 2 个）不计入 keyframes 数。
- 规则数为近似值：先剔除 `/* */` 注释与字符串字面量，再按花括号深度扫描统计；顶层块含 at-rule 容器块，"顶层普通 selector 规则"为顶层块减去 at-rule 容器块的近似值。
- 统计工具：`wc` + Node 一次性只读脚本，统计命令未入库。

vendor CSS 明确未纳入：`web/playground/static-pg/vendor/` 下 `pg-highlight-theme.css`（33 行 / 2,307 字节）与 `katex.min.css`（1 行 / 23,352 字节）为第三方样式，不计入本项目清理指标。

本轮 Phase 0 完成/未完成项：

- 已完成：工作项 1 中的行数、字节数、`!important` 数、媒体查询数、keyframes 数、规则近似统计（即本快照）。
- 未执行：selector 清单与标记（重复 selector、同一 selector 多处定义、裸全局 selector、命名空间）；`var(--token)` 扫描；硬编码颜色 / `border-radius` / `font-weight` / `transition` / `backdrop-filter` / `box-shadow` 扫描；JS `style` / `style.cssText` 与 HTML 内联样式扫描；页面矩阵；截图与 `getComputedStyle()` 记录；默认 / Playground shell 静态资源请求基线。
- 明确未执行：未截图、未运行浏览器验证、未运行 HTTP 验证、未执行构建；本快照不含任何截图或 HTTP 结果。
- 产物：目前仅有本小节；基线验收（可重复生成、每条删除/合并可回溯、vendor 不计入）待后续工作项补齐后评估。

### 1.5 首轮实施记录（2026-08-07）

Phase 0 基线统计已完成并写入 §1.4；随后执行首轮 Phase 1 实施（将高置信度硬编码颜色替换为既有语义 Token），当前状态：

- 本轮只修改生产 CSS，具体文件为 `web/playground/static-pg/playground.css`（git diff 为 +13/−13，共 13 行替换）。
- 未修改 vendor CSS、HTML、JS、DOM 结构；未新增或删除任何 `!important`（13 行均为纯颜色值替换）。
- 13 项替换的语义类别（旧值 → 新 Token，具体以当前 git diff 为准）：
  - accent 上文字颜色（8 行）：`color:#1a1326` / `color:#000` → `var(--text-on-accent)`，涉及 `.pg-toggle.on`、`.pg-image-add:hover`、`.pg-win-btn.active`、`.pg-search-save-btn`、`.pg-search-history-item.active .pg-search-history-num`、`.tr-btn.active`、`.tr-btn-primary`、`.tr-btn-primary:hover:not(:disabled)`。
  - 代码块表面/文字（4 行，其中 2 行各替换 2 个值）：`background:#1a1326` → `var(--code-surface)`、`color:#e6def0` → `var(--code-text)`，涉及 `.pg-req-detail-pre`、`.pg-search-raw-body .pg-search-pretty-view pre`、`.pg-search-raw-body .pg-search-pretty-view pre code`、`.log-detail-section .code` / `.attempt-details .code`。
  - 错误提示色（1 行）：`color:#ff6b6b` → `var(--danger)`，涉及 `.pg-autochat-hint`。
- 已完成验证（2026-08-07 补记）：
  - `go test -count=1 ./internal/feature` 通过；
  - `go build ./...` 与 `go build -tags playground ./...` 通过（默认 shell 与 Playground 变体均可构建）；
  - `node web/media-bridge.test.js` 通过（16 checks）；
  - `node --check` 通过：73 个非 vendor 生产 JS 语法检查；
  - CSS 结构检查通过：花括号/注释平衡、本轮 diff 未新增 `!important`。
- 明确未执行（截至 2026-08-07 仍待执行，见 §1.7）：HTTP 验证与浏览器 smoke（含 dark/light 及 9 variant × 4 style 组合下的视觉回归）未运行。首轮已通过的验证范围仅为构建 / Node / CSS 结构门禁（见上「已完成验证」），不覆盖任何浏览器视觉或运行时等价性。
- 预存问题记录（不属于本轮 diff，不能宣称本轮修复）：var 扫描发现 3 个预存未定义 Token —— `var(--font-lg)`（style.css:2051）、`var(--font-sm)`（style.css:2093）、`var(--card-bg)`（style.css:2289），均位于本轮未修改的 `web/static/style.css`；保留为后续 Phase 1/2 工作项，不在此记录中计入首轮成果。

### 1.6 第二批实施记录（2026-08-07）

承接 §1.4 基线快照与 §1.5 首轮实施，第二批完成 Phase 0 静态范围审计的事实核验，并处理首轮 var 扫描发现的 3 个预存未定义 Token。本轮仍只修改生产 CSS（7 行）；本轮当时未运行构建或测试，后续已由 CssSecondValidation 补做并通过（构建 / Node / CSS 结构门禁），HTTP/browser 验证仍未运行（见 §1.7）。

**Phase 0 静态范围审计（本轮核验完成的事实）：**

- 生产 CSS 范围：项目自有生产样式仅两个文件 —— `web/static/style.css` 与 `web/playground/static-pg/playground.css`；无其他生产 CSS。
- 两个 shell 的 CSS 加载边界（router.go 按 `PlaygroundCompiled` / `EnablePlayground` 选择 shell）：
  - `web/static/index.html`（Playground 完整 shell）：加载 `/style.css`、`/playground.css`、`/vendor/pg-highlight-theme.css`、`/vendor/katex.min.css`；
  - `web/static/index-nopg.html`（no-playground shell）：仅加载 `/style.css`。
  - 结论：`playground.css` 只随 Playground shell 交付；`style.css` 两个 shell 都交付。
- vendor CSS 排除已确认：`web/playground/static-pg/vendor/` 下 `pg-highlight-theme.css`（33 行 / 2,307 字节）与 `katex.min.css`（1 行 / 23,352 字节）为第三方样式，不计入本项目清理指标（与 §1.4 口径一致）。
- `theme.js` 行为已核验：仅通过 `setAttribute` / `getAttribute` 读写 `document.documentElement` 上的 `data-theme`、`data-theme-variant`、`data-theme-style` 三个属性，不直接写 CSS 属性、不改 class。
- 明确未完成（不声称完成）：深度 selector 清单（重复 selector、同一 selector 多处定义、裸全局 selector、命名空间标记）与 JS/HTML 内联样式（`style` / `style.cssText` / HTML 内联）扫描仍未执行、无产物；与 §1.4「未执行」清单一致，待后续工作项。

**三个预存未定义 Token 的结论（§1.5 记录，第二批处理）：**

- `var(--card-bg)`（原 style.css:2289，`.custom-select-menu` 的 `background: var(--modal-bg, var(--card-bg))`）：已确认 `--card-bg` 在 `web/` 下无任何定义；而 `--modal-bg` 在 root 与 light 层均有定义，因此 `--card-bg` 是该声明的永不生效 fallback 死分支。本轮把该声明整体替换为已定义语义 Token `var(--surface-overlay)`（root/light 均为 `--surface-overlay: var(--modal-bg)`，语义等价）。问题消除，不再是未定义引用。
- `var(--font-lg)`（style.css:2051，`.qs-modal-title` 的 `font-size`）与 `var(--font-sm)`（style.css:2093，`.qs-modal-hint` 的 `font-size`）：已确认这两个 Token 在 `web/` 下无定义；二者均为 QuickSlot（`qs-modal-*`，由 `web/static/quickslots.js` 生成）的可见字号问题，替换值需要在浏览器中确认字号观感，本轮未修改，保留为后续 Phase 1/2 工作项。

**第二批实际 CSS 改动：7 行（`web/static/style.css` 4 行 + `web/playground/static-pg/playground.css` 3 行），git diff 为 +7/−7：**

| 文件 | selector | 旧值 | 新 Token |
|---|---|---|---|
| style.css | `.custom-select-menu` | `background: var(--modal-bg, var(--card-bg))` | `var(--surface-overlay)` |
| style.css | `.qs-modal-item` | `border-radius: 6px` | `var(--radius-sm)` |
| style.css | `.qs-modal-item.focused` | `background: rgba(79,195,247,0.10)` | `var(--interactive-active-bg)` |
| style.css | `.current-key-tag` | `background: rgba(79,195,247,0.10)` | `var(--interactive-active-bg)` |
| playground.css | `.pg-send` | `color: #fff` | `var(--text-contrast)` |
| playground.css | `.pg-send.stop` | `color: #fff` | `var(--text-contrast)` |
| playground.css | `.pg-image-rem:hover` | `color: #fff` | `var(--text-contrast)` |

**本轮边界：**

- 未修改 vendor CSS、HTML shell、JS、DOM 结构；两个 shell 的 CSS 加载边界保持不变。
- 未新增或删除任何 `!important`（7 行均为值 → Token 的等价替换）。
- 未拆分 CSS 文件；本轮当时未运行构建或测试，后续已由 CssSecondValidation 补做并通过（构建 / Node / CSS 结构门禁），HTTP/browser 验证仍未运行（见 §1.7）。
- 明确未执行：浏览器验证（dark/light 及 9 variant × 4 style 组合的视觉回归）与 HTTP 验证（两个 shell 的静态资源请求基线）待后续工作项；本轮不声称任何浏览器视觉或运行时等价性。

### 1.7 下一批 / 当前状态（2026-08-07）

计划状态保持「进行中」。已完成三批实施（§1.5 首轮 13 行、§1.6 第二批 7 行、§1.8 第三批 17 行）；前三批验证均止步于构建 / Node / CSS 结构门禁，第三批后门禁已补跑并通过（见 §1.8），HTTP 与浏览器验证（含 dark/light 及 9 variant × 4 style 组合）跨全部批次仍未执行。当前已知剩余项：

- `--font-lg`（style.css:2051，`.qs-modal-title`）与 `--font-sm`（style.css:2093，`.qs-modal-hint`）仍为未定义 Token 引用：已确认为 QuickSlot（`qs-modal-*`）可见字号问题，替换值需在浏览器中确认字号观感后确定，属 Phase 1/2 后续工作项。
- Phase 0 深度审计产物待补：selector 清单（重复 selector、同一 selector 多处定义、裸全局 selector、命名空间标记）、完整 `var(--token)` 定义 / 使用 / 未定义 / fallback 表、硬编码颜色 A/B/C 分类表、JS `style` / `style.cssText` 与 HTML 内联样式扫描、页面矩阵、截图与 `getComputedStyle()` 记录、默认 / Playground shell HTTP 资源基线均无产物；其中生产 CSS 范围与两 shell 加载边界的源码级核验已完成（见 §1.6），不对应上述深度统计产物。
- Phase 1 剩余：`DESIGN.md` 与根 Token / light Token / variant-style 覆盖层的一致性完整核验、语义重复 Token 合并、模块 Token 使用边界（`.pg-*` / `.ed-*` / `.ge-*` / `.tr-*` / `.dl-*`）、焦点环与状态语义来源统一、`color-mix()` 浏览器支持与 light 对比度审计仍未完成（A 类硬编码颜色替换已由三批部分完成，见 §1.5/§1.6/§1.8）。
- Phase 2–6 尚未开始：selector 重复与层叠链清理、共享基础控件统一、页面 / 模块收拢、响应式与可访问性专项、CSS 拆分评估均未启动。
- 第三批实施已完成；其 HTTP / 浏览器验证未执行，构建 / 语法门禁已在第三批后补跑并通过（见 §1.8）。


### 1.8 第三批实施记录（2026-08-07）

承接 §1.5/§1.6，第三批完成 badge / Gallery fullscreen / combo-speed 硬编码颜色与代码块圆角的 Token 化替换。本轮仍只修改生产 CSS（17 行：`web/static/style.css` 15 行 + `web/playground/static-pg/playground.css` 2 行）；本批当时未运行构建或测试，HTTP/浏览器验证也未执行；后续门禁已补跑，结果见下方边界段落。

**第三批实际 CSS 改动：17 行（git diff 为 +17/−17，均为单行值 → Token 等价替换）。累计三批后总 CSS diff 为 `style.css` +19/−19、`playground.css` +18/−18（含 §1.5 首轮 13 行、§1.6 第二批 7 行）：**

| 文件 | selector | 旧值 | 新 Token |
|---|---|---|---|
| style.css | `.mp-mini-badge` / `.mp-proto-badge` / `.info-modal-proto-status` / `.quickslot-btn .qs-number` / `.theme-card-badge` | `color: #fff` | `var(--text-contrast)` |
| style.css | `.gallery-layout.gallery-layout-fullscreen` 及 `.gallery-main`、`.gallery-pane` | `background: #000` | `var(--surface-fullscreen)` |
| style.css | `.gallery-layout.gallery-layout-fullscreen .gallery-bottom`（`border-top`）、`.gallery-video-hover-ctrl`（同行 `background` + `border-top`）、`.gallery-info`（`color`） | `rgba(255,255,255,0.1)` / `rgba(15,15,20,0.85)` / `rgba(255,255,255,0.85)` | `var(--fullscreen-control-border)` / `var(--fullscreen-control-bg)` / `var(--fullscreen-control-text)` |
| style.css | `.combo-speed-status-success` / `.combo-speed-status-error` / `.combo-speed-row-success` / `.combo-speed-row-error` | `var(--status-success-text/--status-danger-text/--status-success-border/--status-danger-border, <fallback>)` 未定义别名引用 | 直接使用生效 Token `var(--accent2)` / `var(--danger)` |
| playground.css | `.pg-code-warning` / `.pg-code-expand-btn` | `border-radius: 6px` | `var(--radius-sm)` |

**本轮边界：**

- 无新增 Token：本轮全部为值 → 既有 Token 替换（`--text-contrast`、`--surface-fullscreen`、`--fullscreen-control-bg/border/text`、`--accent2`、`--danger`、`--radius-sm` 均为 `style.css` root 层既有定义）。
- 未修改 vendor CSS、HTML shell、JS、DOM 结构；未拆分 CSS 文件；未新增或删除任何 `!important`。
- 验证事实（本批当时未运行任何构建 / 测试，本批不声称任何验证通过）：第三批后门禁已补跑并通过 — `go test -count=1 ./internal/feature`、`go build ./...`、`go build -tags playground ./...`、`node web/media-bridge.test.js`（16/16）、73 个非 vendor JS 文件 `node --check`、`git diff --check`；HTTP / 浏览器验证（含 dark/light 及 9 variant × 4 style 组合）仍未执行。
- §1.7 所列剩余任务均不受本轮影响、保持未完成：`--font-lg` / `--font-sm` 字号、Phase 0 深度审计产物、Phase 1 剩余项、Phase 2–6 仍为后续工作项。

### 1.9 Phase 0 var() 审计快照（2026-08-07）

Phase 0 工作项 3（扫描 `var(--token)` 使用点，建立“定义 / 使用 / 未定义 / fallback”表）的部分产物（var 扫描）：对两个生产 CSS 文件执行一次性 Node 扫描（临时脚本写入系统 TEMP 执行后已删除），脚本输出的真实 JSON 结果如下。selector 清单（工作项 2）、硬编码颜色 A/B/C 全分类（工作项 4）、JS `style` / `style.cssText` 与 HTML 内联样式扫描（工作项 5）仍无产物。

```json
{
  "web/static/style.css": {
    "defined": 187,
    "used": 161,
    "undefined": [
      "--arrow-offset",
      "--font-lg",
      "--font-sm",
      "--accent-text",
      "--accent-contrast"
    ],
    "noFallbackUndefined": [
      "--font-lg",
      "--font-sm"
    ]
  },
  "web/playground/static-pg/playground.css": {
    "defined": 1,
    "used": 64,
    "undefined": [
      "--glass-border",
      "--glass-bg",
      "--transition-fast",
      "--accent",
      "--text-on-accent",
      "--status-danger-bg",
      "--danger",
      "--font-badge",
      "--radius-sm",
      "--text-secondary",
      "--glass-hover",
      "--glass-border-hover",
      "--font-base",
      "--border-subtle",
      "--text",
      "--surface-card",
      "--border-strong",
      "--status-warning-bg",
      "--warn",
      "--font-code",
      "--code-text",
      "--interactive-active-bg",
      "--code-surface",
      "--radius-md",
      "--text-muted",
      "--font-body",
      "--radius-lg",
      "--input-bg",
      "--accent-gradient",
      "--text-contrast",
      "--font-section-title",
      "--font-log",
      "--font-h2",
      "--shadow-card",
      "--radius-xs",
      "--status-success-bg",
      "--accent2",
      "--pg-mode-frame-bg",
      "--pg-mode-normal-color",
      "--pg-mode-search-color",
      "--pg-mode-image-color",
      "--pg-mode-autochat-color",
      "--pg-mode-cell-border",
      "--pg-mode-separator",
      "--pg-mode-cell-bg",
      "--pg-mode-text",
      "--font-weight-bold",
      "--pg-mode-text-shadow",
      "--pg-mode-cell-active-bg",
      "--pg-mode-cell-hover-bg",
      "--glass-blur-overlay",
      "--transition-slow",
      "--modal-bg",
      "--shadow-modal",
      "--font-h3",
      "--letter-spacing-heading",
      "--bg",
      "--bg-input",
      "--accent-glow",
      "--bg-secondary",
      "--danger-glow",
      "--text-primary",
      "--glass-active"
    ],
    "noFallbackUndefined": [
      "--glass-border",
      "--glass-bg",
      "--transition-fast",
      "--accent",
      "--text-on-accent",
      "--status-danger-bg",
      "--font-badge",
      "--radius-sm",
      "--text-secondary",
      "--glass-hover",
      "--glass-border-hover",
      "--font-base",
      "--border-subtle",
      "--text",
      "--surface-card",
      "--border-strong",
      "--status-warning-bg",
      "--warn",
      "--font-code",
      "--code-text",
      "--interactive-active-bg",
      "--code-surface",
      "--radius-md",
      "--text-muted",
      "--font-body",
      "--radius-lg",
      "--accent-gradient",
      "--text-contrast",
      "--font-section-title",
      "--font-log",
      "--font-h2",
      "--shadow-card",
      "--radius-xs",
      "--status-success-bg",
      "--accent2",
      "--pg-mode-frame-bg",
      "--pg-mode-normal-color",
      "--pg-mode-search-color",
      "--pg-mode-image-color",
      "--pg-mode-autochat-color",
      "--pg-mode-cell-border",
      "--pg-mode-separator",
      "--pg-mode-cell-bg",
      "--pg-mode-text",
      "--pg-mode-text-shadow",
      "--pg-mode-cell-active-bg",
      "--pg-mode-cell-hover-bg",
      "--transition-slow",
      "--modal-bg",
      "--shadow-modal",
      "--bg",
      "--bg-input",
      "--accent-glow",
      "--bg-secondary",
      "--danger-glow",
      "--text-primary",
      "--glass-active"
    ]
  }
}
```

- `--font-lg` / `--font-sm` 仍出现在 `web/static/style.css` 的 noFallbackUndefined 中（其全部使用点均无 fallback），与 §1.7 记录一致：二者为 QuickSlot（`qs-modal-*`）可见字号问题，替换值需浏览器确认字号观感，属 Phase 1/2 后续工作项。
- 统计口径：注释已剥离（`/* ... */`），`@keyframes` 内未单独处理（其中的 var 定义 / 使用按普通规则计入）。
- 单文件口径说明：playground.css 的 defined 仅 1 且 undefined 项众多，因其绝大多数 Token 定义在 `style.css` root / light 层（跨文件引用），不表示实际渲染缺值；`style.css` 的 undefined 还含 `--arrow-offset` / `--accent-text` / `--accent-contrast`，本快照仅记录、未定位使用点。
**未定义 Token 修复（2026-08-07）：** 对 §1.9 记录的 style.css 5 个 undefined Token 的处理结论：
- `--accent-text`（style.css:2361 `.custom-select-option-link:hover`）：已替换 `var(--accent-text, #ffffff)` → `var(--text-contrast, #ffffff)`，保留 fallback，语义等价。
- `--accent-contrast`（style.css:3311 `.sc-btn-primary:hover`）：已替换 `var(--accent-contrast, #fff)` → `var(--text-contrast, #fff)`，保留 fallback，语义等价。
- `--arrow-offset`（style.css:1110 `.tip::before`）：暂缓。唯一使用点有 `0px` fallback（箭头居中），全文件无定义、无等价 Token，疑似预留钩子，不改不影响行为。
- `--font-lg` / `--font-sm`：仍暂缓，需浏览器确认字号。
- 修复后 style.css undefined Token 从 5 降至 3（`--arrow-offset`、`--font-lg`、`--font-sm`），noFallbackUndefined 仍为 2（`--font-lg`、`--font-sm`）。
- 本轮改动：web/static/style.css 2 行（2361、3311），未新增 Token，未改 !important。

### 1.10 Phase 0 硬编码颜色与 JS 内联样式扫描（2026-08-07）

Phase 0 工作项 4（硬编码颜色扫描）与工作项 5（JS 内联样式扫描）的部分产物：一次性 Node 脚本对两个生产 CSS 文件做硬编码颜色原始统计（注释已剥离、按原文件行号计数），对 57 个非 vendor JS 文件（web/static/*.js 16 个 + web/playground/static-pg/{playground,gallery,editor}/*.js 41 个 = playground 19 + gallery 11 + editor 11，static-pg/vendor/ 已排除）做内联样式命中统计（临时脚本写入系统 TEMP 执行后已删除）。仅原始统计，未做任何分类判断，脚本输出原样记录如下。

**1.10.1 硬编码颜色统计：**

```json
{
  "web/static/style.css": {
    "hex": 414,
    "rgb": 0,
    "rgba": 407,
    "total": 821,
    "distinct": 470,
    "top10": [
      {
        "value": "#fff",
        "count": 31,
        "lines": [
          94,
          106,
          107,
          109,
          110,
          120,
          121,
          127,
          128,
          130,
          132,
          157,
          239,
          249,
          449,
          789,
          790,
          792,
          797,
          798,
          800,
          806,
          807,
          809,
          1157,
          1259,
          2131,
          3256,
          3268,
          3311,
          3957
        ]
      },
      {
        "value": "#000",
        "count": 24,
        "lines": [
          95,
          96,
          104,
          106,
          107,
          108,
          108,
          121,
          125,
          127,
          128,
          129,
          129,
          158,
          250,
          252,
          254,
          255,
          269,
          272,
          274,
          275,
          3195,
          4287
        ]
      },
      {
        "value": "#ffffff",
        "count": 24,
        "lines": [
          159,
          254,
          255,
          256,
          269,
          274,
          275,
          276,
          309,
          1446,
          1787,
          2361,
          3499,
          3529,
          3559,
          3574,
          3575,
          3578,
          3589,
          3608,
          3619,
          3679,
          3698,
          3709
        ]
      },
      {
        "value": "#1a1a26",
        "count": 17,
        "lines": [
          101,
          104,
          106,
          106,
          107,
          107,
          108,
          108,
          121,
          121,
          125,
          127,
          127,
          128,
          128,
          129,
          129
        ]
      },
      {
        "value": "rgba(0, 0, 0, 0.25)",
        "count": 12,
        "lines": [
          475,
          476,
          488,
          488,
          489,
          489,
          527,
          527,
          528,
          528,
          559,
          560
        ]
      },
      {
        "value": "rgba(0,0,0,0.12)",
        "count": 11,
        "lines": [
          65,
          223,
          253,
          268,
          273,
          278,
          304,
          315,
          317,
          3198,
          3757
        ]
      },
      {
        "value": "#f8f9fc",
        "count": 11,
        "lines": [
          217,
          218,
          252,
          254,
          255,
          256,
          269,
          272,
          274,
          275,
          276
        ]
      },
      {
        "value": "rgba(0,0,0,0.35)",
        "count": 10,
        "lines": [
          34,
          369,
          392,
          393,
          394,
          395,
          396,
          397,
          398,
          401
        ]
      },
      {
        "value": "rgba(0,0,0,0.08)",
        "count": 9,
        "lines": [
          230,
          235,
          257,
          277,
          303,
          314,
          319,
          406,
          3756
        ]
      },
      {
        "value": "rgba(255, 255, 255, 0.1)",
        "count": 9,
        "lines": [
          500,
          505,
          505,
          505,
          505,
          506,
          506,
          506,
          506
        ]
      }
    ]
  },
  "web/playground/static-pg/playground.css": {
    "hex": 28,
    "rgb": 0,
    "rgba": 51,
    "total": 79,
    "distinct": 56,
    "top10": [
      {
        "value": "#fff",
        "count": 8,
        "lines": [
          189,
          205,
          207,
          463,
          514,
          539,
          612,
          1008
        ]
      },
      {
        "value": "rgba(196,166,255,.2)",
        "count": 4,
        "lines": [
          211,
          293,
          326,
          598
        ]
      },
      {
        "value": "#fbbf24",
        "count": 4,
        "lines": [
          218,
          342,
          653,
          827
        ]
      },
      {
        "value": "#1a1a1a",
        "count": 3,
        "lines": [
          708,
          709,
          1057
        ]
      },
      {
        "value": "rgba(0,0,0,.06)",
        "count": 2,
        "lines": [
          100,
          157
        ]
      },
      {
        "value": "#f59e0b",
        "count": 2,
        "lines": [
          294,
          327
        ]
      },
      {
        "value": "rgba(255,165,0,.2)",
        "count": 2,
        "lines": [
          294,
          327
        ]
      },
      {
        "value": "#4ade80",
        "count": 2,
        "lines": [
          328,
          336
        ]
      },
      {
        "value": "rgba(255,255,255,0.1)",
        "count": 2,
        "lines": [
          467,
          529
        ]
      },
      {
        "value": "rgba(255,255,255,0.08)",
        "count": 2,
        "lines": [
          518,
          534
        ]
      }
    ]
  }
}
```

- 注：两个文件的 `rgb(` 均为 0（颜色均以 `rgba(` 形式出现，`rgb(` 与 `rgba(` 两模式无重叠）；hex 正则 `#[0-9a-fA-F]{3,8}` 可能命中全部为十六进制字符的 `#` ID selector，属原始统计口径，未逐条核对。

**1.10.2 JS 内联样式命中统计（按文件）：**

```json
{
  "web/static/api.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/static/app.js": {
    "style-property": 10,
    "cssText": 0,
    "setProperty": 1,
    "setAttribute-style": 0,
    "html-style-attr": 6
  },
  "web/static/auth.js": {
    "style-property": 12,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 2
  },
  "web/static/combos.js": {
    "style-property": 2,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 8
  },
  "web/static/console.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 3
  },
  "web/static/download.js": {
    "style-property": 32,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 15
  },
  "web/static/filetransfer.js": {
    "style-property": 2,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 1
  },
  "web/static/fs-api.js": {
    "style-property": 1,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/static/headerStats.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/static/i18n.js": {
    "style-property": 1,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/static/info_common.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/static/media-bridge.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/static/providers.js": {
    "style-property": 13,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 56
  },
  "web/static/quickslots.js": {
    "style-property": 4,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 18
  },
  "web/static/shortcuts.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/static/theme.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 3
  },
  "web/playground/static-pg/playground/pg-autochat.js": {
    "style-property": 8,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 2
  },
  "web/playground/static-pg/playground/pg-comfyui.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 7
  },
  "web/playground/static-pg/playground/pg-core.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/playground/pg-director.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/playground/pg-i18n.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/playground/pg-image-batch.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 49
  },
  "web/playground/static-pg/playground/pg-image-inspire.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/playground/pg-image-model.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/playground/pg-lifecycle.js": {
    "style-property": 2,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/playground/pg-markdown.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/playground/pg-modal.js": {
    "style-property": 16,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 18
  },
  "web/playground/static-pg/playground/pg-render.js": {
    "style-property": 6,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 11
  },
  "web/playground/static-pg/playground/pg-request.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/playground/pg-search.js": {
    "style-property": 4,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/playground/pg-setup.js": {
    "style-property": 4,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 47
  },
  "web/playground/static-pg/playground/pg-state.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/playground/pg-stream.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/playground/pg-ui.js": {
    "style-property": 4,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 31
  },
  "web/playground/static-pg/playground/playground.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/gallery/gallery-edit-batch.js": {
    "style-property": 7,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 11
  },
  "web/playground/static-pg/gallery/gallery-edit-operations.js": {
    "style-property": 6,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 2
  },
  "web/playground/static-pg/gallery/gallery-edit.js": {
    "style-property": 40,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 89
  },
  "web/playground/static-pg/gallery/gallery-fullscreen.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 19
  },
  "web/playground/static-pg/gallery/gallery-io.js": {
    "style-property": 2,
    "cssText": 2,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 4
  },
  "web/playground/static-pg/gallery/gallery-layout.js": {
    "style-property": 5,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 3
  },
  "web/playground/static-pg/gallery/gallery-review.js": {
    "style-property": 5,
    "cssText": 1,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 40
  },
  "web/playground/static-pg/gallery/gallery-state.js": {
    "style-property": 2,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/gallery/gallery-tree.js": {
    "style-property": 3,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 8
  },
  "web/playground/static-pg/gallery/gallery-video.js": {
    "style-property": 4,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/gallery/gallery.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/editor/editor-logs.js": {
    "style-property": 7,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/editor/editor-state.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/editor/editor.js": {
    "style-property": 28,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/editor/editor_textreview.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/editor/editor_textreview_diff.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/editor/editor_textreview_split.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/editor/editor_textreview_state.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/editor/editor_textreview_step1.js": {
    "style-property": 4,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  },
  "web/playground/static-pg/editor/editor_textreview_step2.js": {
    "style-property": 8,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 2
  },
  "web/playground/static-pg/editor/editor_textreview_step3.js": {
    "style-property": 8,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 12
  },
  "web/playground/static-pg/editor/editor_textreview_step4.js": {
    "style-property": 0,
    "cssText": 0,
    "setProperty": 0,
    "setAttribute-style": 0,
    "html-style-attr": 0
  }
}
```

- 注：`style-property`（`.style.`）为通用属性赋值命中，同时覆盖 `cssText` / `setProperty` 命中；五列均为独立正则统计。

**状态与后续：**

- 本段为 Phase 0 工作项 4 和 5 的部分产物；硬编码颜色 A/B/C 完整分类表仍需人工判断（本段不含任何 A/B/C 判断）。
- JS 内联样式仅做命中统计，未区分静态表现值与运行时几何 / 进度值。
- 截图 / `getComputedStyle()` 记录 / HTTP 资源基线（页面矩阵、默认 / Playground shell）仍未执行。

---

## 2. 不可破坏的契约
每个阶段都必须保持以下契约；如果某项需要改变，必须单独提出设计变更，不得混在 CSS 清理中。

### 2.1 DOM 与 JavaScript 契约

- 不改页面身份、`data-page`、DOM ID、ARIA 属性和已有事件绑定。
- 不把由 JS 管理的状态迁移为 CSS 自己推断的状态。CSS 只表现 `.active`、`.disabled`、`.selected`、`.expanded`、`.is-error` 等已存在或明确新增的 class。
- 不替换 Header、Playground mode、Gallery/Editor 导航按钮为 radio 或其他控件。
- 不删除业务 JS 仍在使用的 class；删除前必须检索 HTML、JS、测试和文档调用方。
- 保留 Gallery↔Editor、主题切换、快捷键、语言切换后的动态渲染行为。

### 2.2 主题契约

- 颜色 Token 由 Mode + Variant 控制；形状、阴影、动效、字体权重和间距由 Style 控制；字体大小由 `data-font-size` 独立控制。
- 不让 Style preset 改变颜色，不让颜色变体覆盖结构性尺寸。
- 新 Token 必须在 dark/light 层有定义或安全继承，并检查 9 个变体的覆盖关系。
- 优先使用现有语义 Token：`--surface-*`、`--border-*`、`--status-*`、`--code-*`、`--interactive-*`、`--text-on-accent`。
- 只有已有 Token 无法表达组件语义时才新增模块 Token，并同步 `DESIGN.md`。

### 2.3 交付契约

- 不使用 `file://` 作为 CSS 等价验证。
- 目标变体必须重新构建：默认/no-playground shell 和 `-tags playground` shell 都要覆盖。
- 所有入口、静态 manifest、CSS 文件路径和 embed 边界保持一致。
- vendor CSS 仍由其原路径提供，不复制、压缩或修改第三方内容。

### 2.4 可访问性契约

- 交互元素必须有 `:focus-visible` 可见焦点轮廓，默认使用 `2px solid var(--accent)` 或等价语义 Token。
- `prefers-reduced-motion: reduce` 下不得保留会造成明显运动的动画/过渡。
- 交互目标不低于项目既定 24×24px 最小触摸尺寸。
- 不用颜色作为唯一状态信息；错误、选中、禁用和进度状态必须保留文本、图标或结构区别。

---

## 3. 分阶段路线

## Phase 0：建立可重复的 CSS 基线

### 目标

在任何重构前记录规则、Token、页面和视觉状态，避免"清理后看起来更好"却丢失原有行为。

### 工作项

- [x] 记录 `style.css`、`playground.css` 的行数、字节数、规则数、媒体查询数、动画数和 `!important` 数量。
- [ ] 生成 selector 清单，标记：重复 selector、同一 selector 多处定义、裸全局 selector、模块命名空间 selector。（源码级范围核验已完成：生产 CSS 文件边界、两 shell 加载边界、vendor 排除，见 §1.6；selector 清单产物待补）
- [ ] 扫描 `var(--token)` 使用点，建立"定义 / 使用 / 未定义 / fallback"表。（var 扫描已完成，见 §1.9）
- [ ] 扫描硬编码颜色、`border-radius`、`font-weight`、`transition`、`backdrop-filter`、结构性 `box-shadow`。（原始统计已完成，见 §1.10；A/B/C 完整分类表待补）
- [ ] 扫描 JS 的 `style`、`style.cssText` 和 HTML 字符串内联样式，区分静态表现值与运行时几何/进度值。（命中统计已完成，见 §1.10；静态/动态分类待补）
- [ ] 建立页面矩阵：Monitor、Settings、Download、GIF、Auth、Playground、Gallery、Editor、Text Review。
- [ ] 为每个关键页面保存 dark/light 默认主题的桌面和窄屏截图；记录页面数据属性和关键 `getComputedStyle()` 值。
- [ ] 记录默认 shell 与 Playground shell 的静态资源请求结果，作为后续 HTTP 回归基线。

### 产物

- CSS 规则/Token/内联样式基线表；
- 页面与主题截图基线；
- `!important` 分类表；
- 需要保留的兼容性规则清单。

### 验收

- 基线可由另一位维护者重复生成；
- 每个后续删除或合并的规则都能回溯到基线；
- 不把 vendor CSS 的规则计入项目清理指标。

### 回滚

Phase 0 不改生产代码；若基线脚本或记录方式不可靠，删除基线产物并重新定义，不进入下一阶段。

---

## Phase 1：整理 Token 和语义边界

### 目标

先修正"同一语义多套值"和"组件直接依赖固定颜色"的问题，再处理 selector 层叠。

### 工作项

- [ ] 校验 `DESIGN.md` 与 `style.css` 根 Token、light Token、variant/style 覆盖层一致。
- [ ] 合并语义重复的 surface、border、status、code 和 active Token；保留兼容 alias 时标注用途。
- [ ] 对项目 CSS 中可安全替换的硬编码颜色分级（A 类已由三批部分完成：13+7+17 行，见 §1.5/§1.6/§1.8）：
  - A 类：明显对应现有语义 Token，优先替换；
  - B 类：模块专属但需验证对比度，可新增模块 Token；
  - C 类：第三方、图像预览、代码高亮或几何装饰，暂不替换。
- [ ] 为 `.pg-*`、`.ed-*`、`.ge-*`、`.tr-*`、`.dl-*` 等模块确认 Token 使用边界。
- [ ] 统一焦点环、禁用态、错误态、成功态和警告态的语义来源。
- [ ] 对 `color-mix()` 使用点检查浏览器支持和 light 主题对比度；必要时提供安全 fallback，但不复制整套组件规则。
- [ ] 把新 Token 和语义变化同步到 `DESIGN.md`，不在计划执行中私自改变设计系统含义。

### 禁止

- 不以批量正则替换所有 `#fff`、`#000`、`rgba()`；这些值可能是图像画布、iframe、代码块或装饰几何的有效语义。
- 不把 `--accent` 强行替代所有成功、警告、错误颜色。
- 不把 Style dimension 的 Token 用于颜色。

### 验收

- CSS 不再出现新增的未定义 `var()`；
- 所有新增 Token 都有 dark/light 继承或明确覆盖；
- 默认、light、至少一个非默认 dark variant、一个非默认 light variant 的关键组件对比度和状态颜色可解释；
- `DESIGN.md` 与代码中的 Token 名称、用途、维度一致。

### 回滚

按 Token 组回滚，不回滚无关页面。若某一 Token 无法在 72 组合中保持语义稳定，恢复原值，保留该组件的硬编码并记录为 C 类例外。

---

## Phase 2：清理 selector 重复和层叠链

### 目标

减少重复定义、来源不明的覆盖和不必要的高特异性；不改变页面结构。

### 工作项

- [ ] 对同名 selector 合并同一职责的声明，保留最终 source order 和注释边界。
- [ ] 识别"基础规则 → 页面规则 → 主题规则 → responsive 修复"的真实覆盖链，删除已被后续规则完全覆盖的死声明。
- [ ] 把重复的 `.pg-param-row`、按钮、输入、Modal footer 等规则按语义合并；若两个模块确实不同，保留命名空间而不是强行合并。
- [ ] 统一 selector 顺序：基础元素/布局 → 状态 → 主题覆盖 → responsive → reduced motion。
- [ ] 给重复的 `transition: all`、`box-shadow`、`border-radius` 和固定颜色做逐条替换，优先使用 Token。
- [ ] 不引入 `@layer` 作为第一步。只有在已有 source order 经过浏览器验证、且能够证明 layer 顺序更清晰时，才建立小范围试验。
- [ ] 对相邻注释、媒体查询边界和 keyframes 做完整性检查。

### `!important` 处理规则

先分类，后删除：

| 类别 | 例子 | 处理方式 |
|---|---|---|
| 结构/构建约束 | Playground 全屏高度、Text Review root 高度、GIF trim 状态 | 暂保留；补充原因注释，并检查能否通过 source order 或更准确 selector 替代 |
| 主题兼容覆盖 | light 用户气泡、代码块、旧组件颜色覆盖 | 先降低重复 selector，再尝试去除；每次必须检查 computed style |
| 状态/交互 | disabled、hidden、focus、open | 优先改为明确状态 class 和稳定 source order；保留功能性 focus ring 的必要强制覆盖 |
| 历史补丁 | 没有对应 DOM/JS 契约或已被新规则取代 | 删除前检查所有调用方和截图；这是第一批清理对象 |

不得设定"全部删除"目标。成功标准是每个剩余 `!important` 都有可解释的契约或验证证据。

### 验收

- 重复 selector 和完全覆盖声明数量下降；
- `!important` 数量下降或每个保留项均有分类理由；
- CSS 花括号、注释、媒体查询、keyframes 和选择器边界完整；
- 页面状态没有因为 source order 改变而回归。

### 回滚

每次只处理一个 selector family 或一个模块。出现页面状态回归时，回滚该 family，不回滚整个 CSS 文件。

---

## Phase 3：统一共享基础控件

### 目标

把按钮、输入、Select、Stepper、Toggle、Modal、Tooltip 等共享控件的结构样式和状态样式统一到既有 Token，减少页面级重复。

### 优先级

1. `.btn` / `.pg-btn` / `.tr-btn` 的基础、primary、danger、ghost、accent、disabled、focus 状态；
2. `.input`、`.select`、textarea、原生 select 和 modal 内表单控件；
3. `.custom-select-*`；
4. `.number-stepper`；
5. `.toggle-switch`；
6. `.modal-*`、`.pg-modal-*`、信息 Modal、Toast、Tooltip；
7. loading、empty、error、success 等通用反馈状态。

### 工作项

- [ ] 建立控件状态表：normal / hover / active / focus-visible / disabled / error / selected。
- [ ] 先保留各模块的 class 名和 DOM 结构，抽取公共声明，不做 class 重命名。
- [ ] 明确全局 `.btn` 与模块 `.pg-btn`、`.tr-btn` 的职责；不要用更宽的裸 selector 覆盖模块控件。
- [ ] 统一高度、padding、radius、font-weight、transition 和 focus ring 的 Token 来源。
- [ ] 检查按钮文字在中英文、`data-font-size` S/M/L 和 mobile 下是否溢出。
- [ ] 检查 checkbox/radio/Toggle slider 不被通用 `input` 规则覆盖。
- [ ] 检查 modal 的 z-index、滚动、焦点锁和关闭按钮样式，不修改 JS 焦点逻辑。

### 验收

- 每种控件状态都有明确的唯一主要来源；
- Provider、Combo、QuickSlot、Settings、Download、Playground、Gallery 编辑 Modal 的控件没有视觉分叉；
- focus-visible、disabled 和错误状态在 dark/light 下均可见；
- 不新增全局裸 selector；新增模块样式均有命名空间。

### 回滚

按控件族提交。基础按钮回归不应连带回滚 Modal 或表单；保留每族的 before/after 截图。

---

## Phase 4：按页面和模块收拢规则

### 目标

在共享基础稳定后，减少 `style.css` 和 `playground.css` 内部的职责交叉。

### `web/static/style.css` 建议分区

按以下顺序维护，不要求立即拆文件：

1. Theme tokens、variant/style/font-size overrides；
2. Base/reset、shell、scrollbar、main layout；
3. Header navigation、brand、QuickSlot、theme switch；
4. Shared card/button/form/table/modal/toast/tooltip primitives；
5. Auth/login；
6. Monitor/console/quota；
7. Settings/QuickSlot/Provider/Combo；
8. Download/FileTransfer；
9. GIF editor shared shell；
10. responsive、reduced motion、兼容性例外。

### `web/playground/static-pg/playground.css` 建议分区

1. Playground shell、input bar、messages、reasoning、sources；
2. Image Canvas、Inspire、Batch；
3. Custom body、SSE/debug、ComfyUI 相关面板；
4. mode selector、multi-window、group chat；
5. Gallery/Editor/Text Review；
6. Log Reader；
7. shared Playground responsive 和 reduced-motion rules。

### 工作项

- [ ] 只移动规则，不改变 selector、source order 或声明值；先通过分区注释建立维护边界。
- [ ] 为每个区块标记依赖的 DOM/JS 模块和允许覆盖的 Token。
- [ ] 识别跨页面共用规则，放回 shared primitives，不复制到页面区块。
- [ ] 识别只属于 Playground 的全局布局规则，保留在 `playground.css` 并记录其为何需要覆盖 `html/body/.app`。
- [ ] 识别只属于 Editor/Gallery/Log Reader 的样式，确保不会被 no-playground shell 加载。
- [ ] 将动态内联样式中的静态表现迁入对应模块 CSS，但保留运行时 geometry、progress、width、height、transform 等计算值。

### 验收

- 每个 selector 都能归属到 shared、page 或 feature namespace；
- 删除/移动规则不会改变 HTML 两个 shell 的初始渲染；
- Playground 构建不再依赖 no-playground 专属页面样式，反之亦然；
- 文档中的模块路径、CSS 归属和维护清单同步更新。

---

## Phase 5：响应式、可访问性和动效专项

### 目标

把响应式和可访问性从"末尾补丁"提升为可验证的组件契约。

### 工作项

- [ ] 检查 desktop、tablet、mobile 三档：Header、Settings、Download、Monitor、Playground、Gallery、Editor。
- [ ] 检查现有媒体查询与 container query 是否重复、互相覆盖或只修正单一页面。
- [ ] 校验窄屏下 Header 隐藏优先级仍由 `setupHeaderResponsive()` 决定，CSS 不擅自隐藏核心导航。
- [ ] 为所有可交互模块检查 `:focus-visible`、键盘顺序、文本裁切和焦点对比度。
- [ ] 检查 `prefers-reduced-motion: reduce` 对 CSS animation、transition、GIF/媒体编辑器反馈的影响。
- [ ] 检查 `touch-action`、拖拽滑块、时间线、滚动容器和最小触摸尺寸。
- [ ] 检查 `overflow:hidden` 是否截断 tooltip、dropdown、modal 或错误信息。
- [ ] 检查 L/M 字体尺寸、中文/英文长文本和语言切换后的布局。

### 验收

- 所有关键交互在鼠标、键盘和窄屏下可到达；
- 无明显焦点丢失、文字被截断、下拉层被父容器裁切或滚动锁死；
- reduced-motion 下不出现明显动画闪烁或无限运动；
- 截图和 computed style 结果可复现。

---

## Phase 6：评估 CSS 文件拆分（条件阶段）

> 该阶段不是必做项。只有 Phase 1–5 稳定、重复和层叠问题已经收敛后，才评估是否值得拆文件。

### 进入条件

同时满足以下条件才进入：

- 页面/模块归属已明确；
- CSS source order 已有测试或稳定记录；
- 两个 HTML shell 的加载边界可明确表达；
- Playground 的 `feature.Assets`、静态路由和 embed 资产清单有对应更新方案；
- 拆分不会引入新的 cascade 依赖或重复 Token；
- 可以用真实 HTTP 页面验证而不是只做文件存在性检查。

### 候选结构

仅作为候选，不在本计划创建：

```text
web/static/
├─ style.css                 # 主题 Token、reset、shell、共享基础控件
├─ monitor/monitor.css       # Monitor/Console/Quota 页面
├─ settings/settings.css     # Settings/Provider/Combo/QuickSlot
└─ gif-editor/gif-editor.css # GIF 编辑器页面样式

web/playground/static-pg/
├─ playground.css            # Playground shell、消息、模式和共享 PG 控件
├─ gallery/gallery.css       # Gallery 样式
└─ editor/editor.css         # Editor/Text Review/Log Reader 样式
```

候选结构必须重新评估 Download、Auth、FileTransfer 是否应作为共享页面样式留在 `style.css`，不能按 JS 目录机械一一对应。

### 拆分步骤

1. 为每个候选文件建立依赖清单：Token、DOM、JS、source order、媒体查询、keyframes。
2. 先复制到 preview 路径并在真实 shell 中加载，确认 computed style 与截图一致。
3. 逐个迁移规则，保持原有加载顺序；不要同时重命名 class。
4. 更新 `index.html`、`index-nopg.html`、`internal/feature/feature.go`、测试和文档。
5. 验证 default 与 Playground 构建，确认 CSS 请求均为 200 且没有旧路径残留。
6. 删除旧区块，确认没有第二套事实来源。

### 拆分验收

- 每个页面只加载自身需要的 CSS；
- shared Token 和基础控件只定义一次；
- source order 依赖有文档说明；
- 默认 shell 不加载 Playground 专属 CSS；
- Playground shell 不因拆分丢失 Gallery/Editor/Text Review 样式；
- 二进制体积、首次加载请求数和页面渲染没有不可接受的回归。

### 回滚

拆分必须以独立提交完成。若任一构建变体、路由或页面出现回归，恢复入口引用和旧文件，不把拆分与其他 CSS 清理混合回滚。

---

## 4. 动态内联样式治理

### 分类规则

| 类型 | 例子 | 计划 |
|---|---|---|
| 静态表现 | 颜色、border、padding、font-size、固定布局、重复 modal footer | 迁移到命名空间 CSS class |
| 运行时几何 | progress width、拖拽位置、canvas transform、媒体尺寸、动态高度 | 保留 inline style，必要时只提供 CSS custom property |
| 状态切换 | `display:none`、错误色、selected/active、loading | 优先改为 class；只有一次性的计算值保留 inline |
| 第三方/沙盒内容 | iframe、Mermaid、KaTeX、Highlight | 保留边界，避免全局覆盖 |

### 工作项

- [ ] 先统计重复的 `style` 片段，按组件合并，不逐行机械替换。
- [ ] 为动态 UI 增加稳定 class 和状态 class，保持 JS API 与 DOM ID 不变。
- [ ] 对 `style.cssText` 拆成"静态 class + 必要动态属性"。
- [ ] 对 HTML 字符串中的 inline style 迁移后，检查 escape、翻译文字和条件分支。
- [ ] 任何迁移都必须覆盖初始、成功、失败、空状态和关闭/清理状态。

### 验收

- 静态视觉规则不再在多个 JS 字符串中重复；
- 运行时 geometry 不被误迁移导致拖拽、进度或缩放失效；
- `node --check` 和对应页面交互验证通过。

---

## 5. 每个 CSS 变更的标准执行模板

每一项实际优化都按下面顺序执行，不允许跳过基线和验证：

1. **问题定义**：指出重复、冲突、未定义 Token、硬编码颜色或可访问性问题。
2. **契约检索**：查找目标 class/ID 的 HTML、JS、测试、文档和两个 shell 使用情况。
3. **影响面**：列出页面、主题、style preset、字体尺寸、响应式断点和构建变体。
4. **预览方案**：必要时使用真实 shell + preview override；禁止 `file://`。
5. **最小编辑**：一次只改一个 selector family、Token 组或组件族。
6. **局部检查**：规则边界、注释、重复 selector、`var()`、`!important` 和相邻媒体查询。
7. **浏览器检查**：页面状态、computed style、截图、console error、request failure。
8. **构建检查**：默认构建与 Playground 构建；CSS 必须重新进入 embed/HTTP 服务。
9. **文档同步**：涉及 CSS 归属、入口、资产或设计 Token 时同步 `PROJECT_MAP.md`、`DESIGN.md`、`docs/playground-architecture.md` 或对应维护文档。
10. **独立提交**：提交标题说明一个主题，避免和 JS 重构、后端行为或无关格式化混合。

---

## 6. 验证矩阵

### 6.1 每个阶段的快速门禁

- CSS 花括号、注释、媒体查询和 keyframes 平衡；
- 不新增未定义 Token；
- `node --check` 覆盖受影响的动态 HTML/JS 文件；
- `git diff --check`；
- `go build ./...`；
- `go build -tags playground ./...`；
- 受影响的现有单元测试和 Node smoke test。

### 6.2 浏览器 HTTP 门禁

必须启动准确的目标构建，通过 HTTP 访问页面，并记录：

- console error、page error、request failure；
- CSS 请求状态与响应路径；
- `document.documentElement.dataset`；
- 关键 Token、computed width/height、border、radius、shadow、pseudo-element；
- hover、active、focus-visible、disabled、selected、error、expanded、loading；
- modal、dropdown、tooltip、scroll container 的层级和裁切。

### 6.3 主题与尺寸矩阵

每个组件族至少验证：

- dark/default；
- light/default；
- 一个非默认 dark variant；
- 一个非默认 light variant；
- `default`、`sharp`、`soft`、`compact` 四种 style；
- `data-font-size` 的 s、m、l；
- desktop、tablet、mobile；
- no-playground shell 和 Playground shell（适用时）。

发布前对 Header、共享控件和受影响页面执行完整 72 组合抽样/截图；若无法全量截图，必须明确记录未覆盖的组合和理由。

### 6.4 交互矩阵

- Header 所有页面按钮和快捷键；
- 主题、变体、style、字体和语言切换；
- Settings Toggle、Stepper、Custom Select、Modal 焦点；
- Monitor 过滤器、表格展开和错误状态；
- Download 表单、下拉、进度和错误卡片；
- Playground normal/search/image/autochat；
- Gallery/Editor 二路导航、拖拽、时间线、批处理；
- Text Review Step1/Step2/Step3；
- `prefers-reduced-motion` 和键盘 focus-visible。

---

## 7. 指标与完成定义

### 必须达到

- 没有新增未定义 CSS Token、裸全局模块 selector 或 vendor 改动；
- 每个删除的规则都有调用方检索和 before/after 验证；
- 每个保留的 `!important` 都能说明其结构、主题、状态或兼容性原因；
- 关键页面在默认和 Playground 构建中均能通过真实 HTTP 渲染；
- dark/light、variant/style/font-size 关键矩阵通过；
- 键盘焦点、减少动效和窄屏布局没有已知回归；
- `DESIGN.md`、`PROJECT_MAP.md`、相关架构文档与实际 CSS 归属一致。

### 建议跟踪

- 总规则数、重复 selector 数、完全覆盖声明数；
- `!important` 总数及按类别分布；
- 未定义 Token 数；
- 硬编码颜色中 A/B/C 三类数量；
- JS 静态 inline style 片段数量；
- 默认/Playground CSS 请求数和传输体积；
- 关键页面首屏、Modal、切换和移动端截图差异。

不设置"行数越少越好"作为成功标准。可维护性、契约稳定性和可验证性优先于压缩行数。

---

## 8. 提交与回滚策略

建议按以下独立提交推进：

1. `chore(css): record css baseline`（若需要提交基线工具或报告）；
2. `refactor(css): normalize semantic tokens`；
3. `refactor(css): reduce duplicate cascade rules`；
4. `refactor(css): unify shared controls`；
5. `refactor(css): consolidate page module styles`；
6. `fix(css): improve responsive and focus states`；
7. `refactor(css): split feature styles`（仅在 Phase 6 进入且验证通过时）。

每个提交必须满足：

- 只包含一个 CSS 主题；
- 不混入无关行尾变化、vendor 文件或后端行为；
- 提交前保存验证命令和结果；
- 发生回归时可以单独 revert，不需要反向撤销整个 CSS 重构。

---

## 9. 首轮执行顺序

下一轮实际优化建议从以下最小闭环开始：

1. Phase 0：建立 selector/Token/`!important`/inline style 基线；
2. Phase 1：只处理已有语义 Token 能明确承接的硬编码颜色；
3. Phase 2：清理一组高置信度重复 selector，优先不涉及 Header、Toggle、GIF 拖拽和 Text Review 高风险区域；
4. 重新构建两个变体并执行 HTTP smoke；
5. 根据截图和 computed style 决定是否进入 Phase 3；
6. 暂不拆 CSS 文件，直到共享控件和页面边界稳定。

首轮不做：

- 全量删除 `!important`；
- 全量替换颜色、圆角或阴影；
- 用 `@layer` 重写现有 cascade；
- 直接按 JS 目录一一创建 CSS 文件；
- 修改 DOM、JS 状态模型、事件绑定或后端路由；
- 修改第三方 vendor CSS；
- 以压缩体积代替结构优化。

---

## 10. 计划维护规则

本计划是执行路线，不替代 `DESIGN.md`、`PROJECT_MAP.md` 或 `docs/playground-architecture.md` 的事实基线。每次完成一个阶段后：

- 更新本文件的勾选项、实际指标和未覆盖风险；
- 若 CSS 文件、目录、入口或模块职责发生变化，同一次改动更新 `PROJECT_MAP.md`；
- 若主题 Token 或设计契约变化，同一次改动更新 `DESIGN.md`；
- 若 Playground CSS 归属或模块结构变化，同一次改动更新 `docs/playground-architecture.md`；
- 记录最终验证命令、构建变体和浏览器矩阵，不只记录"看起来正常"。
