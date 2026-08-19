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

计划状态保持「进行中」。已完成六批实施（§1.5 首轮 13 行、§1.6 第二批 7 行、§1.8 第三批 17 行、§1.11 第四批 21 行、§1.12 Phase 2 第一批 19 行删除、§1.14/§1.15 第五批 11 行 Token 化 + DESIGN 一致性核验 + reduced-motion 契约修正），各批验证均已在实施后立即补跑并通过（构建 / Node / CSS 结构门禁，见 §1.11 / §1.12 / §1.14 / §1.15）。**HTTP 与浏览器验证已首次执行**（真实 HTTP + headless Chromium，两 shell、CSS/vendor 全 200、0 console/page error、主题矩阵 9 组合 + 3 档宽度、modal/dropdown、reduced-motion、焦点 Tab 实测，见 §1.19）。**截图与视觉验证为用户手动任务**（自动化截图/视觉/浏览器主题验证已停止，不产生新的视觉证据；`tmp/css-verify/evidence/` 下已有证据为 gitignored 的 HTTP/computed 值 + 日志，非截图；用户将自行对端点做视觉测试，见 §1.20.4）。当前已知剩余项：

- `--font-lg`（style.css `.qs-modal-title`）与 `--font-sm`（style.css `.qs-modal-hint`）仍为未定义 Token 引用：已确认为 QuickSlot（`qs-modal-*`）可见字号问题，替换值需在浏览器中确认字号观感后确定，属 Phase 1/2 后续工作项。
- Phase 0 深度审计产物：selector 清单与重复声明分析（§1.12）、`var(--token)` 表（§1.9）、硬编码颜色原始统计（§1.10）与 A/B/C 家族级分类（§1.20.1）、JS 内联样式命中统计与静态/动态分类（§1.10/§1.15.2）、`!important` 分类表（§1.14.4）、页面矩阵源码级（§1.13）、两 shell HTTP 静态资源基线（§1.19.2）均已有；computed-style 主题矩阵已取样 9 组合（§1.19.3）；**截图基线由用户手动执行**（自动化视觉验证已停止，本计划不产出截图证据）。
- Phase 1 剩余：DESIGN token 层一致性核验已完成（token 完全一致，§1.14.1；reduced-motion 契约已按代码事实修正 DESIGN.md，§1.17，并经浏览器 reduce 实测一致，§1.19.6）；语义重复 Token 合并、模块 Token 使用边界 B 类硬编码颜色（SSE badge 色、diff 色、`#fbbf24` 警示琥珀、原生 select option、图像画布等）需浏览器对比度验证后处理；焦点环：`.nav-item` 键盘焦点原判缺口已按浏览器证据撤销（§1.17 修正，焦点可达且阴影渲染），GIF 切片按钮与 3 处仅 border 变色输入未覆盖、保留为未验证项；`color-mix()` 浏览器支持与 light 对比度审计（浏览器 150 已实测渲染 color-mix 值正常）仍需全组合抽查。
- Phase 2 已启动：同 selector 完全覆盖删除/收窄两批完成（16+3 行 + 6 条声明，§1.12/§1.14）；`!important` 四类归档完成（§1.14.4，无高置信度历史补丁）；border-radius Token 化 10 行完成（§1.14/§1.15.1，sharp/soft/compact 半径已由 §1.19.3 实测生效）；`transition: all` 与 `box-shadow` 替换需浏览器验证后逐条处理。
- Phase 3/4 文档基座已建立（控件状态来源表 + 模块归属表，§1.16）；控件 CSS 合并与 Gallery 归属收敛（唯一明确收敛点）需浏览器验证后推进。
- Phase 5 源码契约审计完成（§1.17：媒体查询清单、reduced-motion 事实、焦点环、触摸/裁切风险）；浏览器已实测：3 档宽度无横向溢出（§1.19.4）、modal/dropdown 无裁切（§1.19.7）、reduced-motion 有意不变（§1.19.6）、nav 焦点可见（§1.19.5）；Phase 6 进入条件审计完成（§1.18，条件 2/5 不满足，条件 6 已由 §1.19 满足，仍不进入）。
- 第四批至第五批已完成，HTTP / 浏览器 smoke 已执行（§1.19）；构建 / 语法门禁持续通过（§1.11 / §1.12 / §1.14 / §1.15 / §1.19 后复跑）。


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
- 截图 / `getComputedStyle()` 记录 / HTTP 资源基线（页面矩阵、默认 / Playground shell）仍未执行。（补记：HTTP 资源基线与 computed-style 采样已由 §1.19 执行，两 shell 全 200、9 组合 computed 值实测；截图仍无产物）

### 1.11 第四批实施记录（2026-08-07，Phase 1 A 类 Token 替换）

承接 §1.8/§1.9，第四批对剩余高置信度硬编码颜色做 Token 化替换。本轮只修改生产 CSS（21 行：`web/static/style.css` 16 行 + `web/playground/static-pg/playground.css` 5 行），git diff 为 +21/−21，全部为单行值 → Token 等价替换；实施后已立即补跑验证门禁（见下方边界段落）。

**实际 CSS 改动（21 行）：**

| 文件 | selector | 旧值 | 新 Token |
|---|---|---|---|
| style.css | `.mp-mini-badge.mp-ok` / `.mp-mini-badge.mp-err` / `.mp-proto-badge.mp-ok` / `.mp-proto-badge.mp-err` / `.info-modal-proto-status.mp-ok` / `.info-modal-proto-status.mp-err`（6 行） | `color:#fff` | `var(--text-contrast)` |
| style.css | `.pg-model-picker-item.selected.has-model-note::after` | `color:#fff` | `var(--text-contrast)` |
| style.css | `[data-theme="light"] .login-card` | `background:#fff` | `var(--surface-auth-card)`（light 层值即 `#fff`，语义同源） |
| style.css | `[data-theme="light"] .login-input` | `background:#f5f5fa` | `var(--surface-auth-input)`（light 层值即 `#f5f5fa`） |
| style.css | `.dl-status-error` / `.dl-status-dot.dl-status-error`（bg+color 各 1 处，共 2 行） / `.dl-detail-error` | `color:#ef5350`（dot 另含 `background:#ef5350`） | `var(--danger)`（dark 层值即 `#ef5350`） |
| style.css | `.dl-status-cancelled` / `.dl-status-dot.dl-status-cancelled`（bg+color 各 1 处，共 2 行） | `color:#ffa726`（dot 另含 `background:#ffa726`） | `var(--warn)`（dark 层值即 `#ffa726`） |
| style.css | `.gallery-layout.gallery-layout-fullscreen .gallery-video-time` / `.gallery-btn`（2 行） | `color:#fff` | `var(--text-contrast)` |
| playground.css | `.pg-input-thumb-del` / `.pg-search-history-del`（2 行） | `color:#fff`（danger 表面） | `var(--text-contrast)` |
| playground.css | `.pg-gc-new-msgs` / `.pg-model-picker-item.selected` / `.log-mode-btn.active`（3 行） | `color:#fff`（accent 表面） | `var(--text-contrast)` |

判定依据：

- 全部为「值等价或语义等价」：`--text-contrast:#fff`（两主题均如此）、`--danger:#ef5350`（dark）、`--warn:#ffa726`（dark）。
- dl-status 家族同组兄弟 selector 已用 Token（`.dl-status-downloading`→`var(--accent)`、`.dl-status-completed`→`var(--accent2)`、`.dl-status-pending`→`var(--text-muted)`、`.dl-status-dot.*` 同理）；error/cancelled 是家族内最后两处硬编码。
- light 覆盖下 dl-status 颜色随 `--danger`/`--warn` 变暗（`#dc2626`/`#d97706`），属「状态语义来源统一」的设计意图（与 §1.8 combo-speed 同模式）；状态仍保留文字/图标/结构区别，非纯颜色编码。

**本轮边界：**

- 无新增 Token；未修改 vendor CSS、HTML shell、JS、DOM 结构；未拆分 CSS；未增删 `!important`（两文件 108/26 不变）。
- 验证（实施后立即补跑并通过）：`go test -count=1 ./internal/feature`、`go build ./...`、`go build -tags playground ./...`、`node web/media-bridge.test.js`（16/16）、57 个非 vendor JS 文件 `node --check`、CSS 花括号/注释平衡、`git diff --check`、var 扫描无新增未定义 Token（style.css undefined 仍为 `--arrow-offset`/`--font-lg`/`--font-sm` 三个预存项）。
- HTTP / 浏览器验证（含 dark/light 及 9 variant × 4 style 组合）仍未执行；本批不声称任何浏览器视觉或运行时等价性。

### 1.12 Phase 2 第一批实施记录（2026-08-07，证明安全重复删除 + selector 审计产物）

Phase 2 第一批只处理「同一 selector 的早期顶层规则被后续同 selector 顶层规则完全覆盖」的证明安全候选：同一 selector 特异性相等、后规则胜出，删除早期重复声明/规则不改变任何元素的最终计算样式。判定由一次性 Node 脚本（写入系统 TEMP 执行后已删除）对两个生产 CSS 做「同 selector 跨顶层规则的声明级比较」得出，并逐族人工核验（含对单行多规则行 `.stat-value{...}.detail-block{...}` 的修正，脚本对该行第二个规则计数存在已知局限，见下）。本轮共删除 19 行（`web/static/style.css` 16 行 + `web/playground/static-pg/playground.css` 3 行，另 playground.css 1 行部分声明删除），累计 git diff 为 style.css +16/−32、playground.css +6/−9。

**style.css 删除明细（16 行）：**

| 行号（删除前） | 规则 | 证明（被覆盖的后续规则） |
|---|---|---|
| 661-665 | `.detail-block`、`.detail-block + .detail-block`、`.detail-header`、`.detail-header h2`、`.section-title` 原型块 | 757-761 同 selector 规则：detail-block / detail-header / detail-header h2 完全一致；section-title 全部 6 条声明被重声明（`margin-bottom` 14px→0 由后规则胜出） |
| 700-707 | `.badge::before`、`.badge-active,.badge-valid`、`.badge-active::before,.badge-valid::before`、`.badge-cooldown`、`.badge-cooldown::before`、`.badge-locked,.badge-invalid`、`.badge-inactive::before`、`.badge-testing` 原型块（8 规则） | 723-734 同 selector 规则完全覆盖（badge 状态族；含值不同但后规则胜出的 `background`） |
| 773 | `.model-row .model-quota-select` | 822 同 selector 规则重声明全部 8 条声明并追加 height/box-sizing |
| 1189 | `.info-field-key`（`display:block` 版） | 1215 同 selector 规则重声明全部 6 条（`display:flex` 胜出） |
| 2129 | `.login-error-visible { display:block; }` | 4298 文件尾部同 selector 规则完全一致 |

**playground.css 删除明细（3 行删除 + 1 行部分声明）：**

| 行号（删除前） | 规则 | 证明 |
|---|---|---|
| 358 | `.pg-winbar{padding:0}` | 419 `.pg-winbar{flex-shrink:0;padding:0}` 重声明 padding |
| 469 | `.pg-param-row` 删除 `display:flex;align-items:center;gap:8px` 三条声明 | 542 同 selector 规则重声明三条；保留 `font-size`/`color`（未被重声明） |
| 470 | `.pg-param-row label{flex:1;user-select:none}` | 543 同 selector 规则重声明两条 |
| 472 | `.pg-param-row input:focus{outline:none;border-color:var(--accent)}` | 547 同 selector 规则重声明两条 |

**本轮边界：**

- 未修改 vendor CSS、HTML shell、JS、DOM 结构；未拆分 CSS；未增删 `!important`（108/26 不变）。
- Header 高风险区不触及：`.nav-item:focus,.nav-item:focus-visible{outline:none}`（L384）与 L3159 同声明重复已识别、删除亦证明安全，但按计划「优先不涉及 Header」保留为后续批次候选（证据见本节）。
- 验证（实施后立即补跑并通过）：同 §1.11 全部门禁（feature test / 双构建 / media-bridge / 57 JS check / CSS 平衡 / diff check / var 扫描无新增未定义）。
- HTTP / 浏览器验证仍未执行；本批不声称任何浏览器视觉或运行时等价性。

**Phase 0 selector 审计产物（本轮新增，可重复）：**

- 一次性 Node 脚本（写入系统 TEMP 执行后已删除）方法：剥离 `/* */` 注释、保留字符串字面量（含属性选择器内字符串，避免 `[data-page="x"]` 被合并）→ 顶层花括号扫描提取规则与 selector 列表 → 统计规则数、唯一 selector、多定义 selector、裸全局 tag selector、模块命名空间计数；另做「同 selector 跨顶层规则声明级比较」识别完全覆盖候选。
- 已知局限：单物理行含多个规则（如 `.stat-value{...}.detail-block{...}`）时第二个规则被并入前一个规则解析（删除决策前已人工修正）；`@media`/`@supports` 内部规则不计入顶层比较；`!important` 与更高特异性 selector 的覆盖关系不在脚本判定范围。
- 关键输出（style.css）：1,183 顶层块 / 27 at-rule / 1,156 普通规则 / 1,164 唯一 selector / 48 个多定义 selector（多为 `[data-theme][data-theme-variant]` 变体覆盖、`.nav-item[data-page]` 页面色、`[data-theme-style]` 预设等有意覆盖）/ 裸全局 tag selector：html×1、body×2、h2×1、h3×1、table×1 / 命名空间计数：gif-150、dl-94、nav-34、settings-38、sc-23、qs-19、mp-16 等。
- 关键输出（playground.css）：840 顶层块 / 9 at-rule / 831 普通规则 / 848 唯一 selector / 28 个多定义 selector（`.pg-mode-toggle:has(...)` 模式色 4 组、`.gallery-edit-*` 输入族、`.pg-param-row` 族、`.pg-bubble h1/h2/h3` 族等）/ 命名空间计数：pg-、tr-、ge-、ed- 等。
- 完整原始输出随一次性脚本删除，未入库（与 §1.4/§1.9/§1.10 口径一致：统计命令未入库、方法可重复生成）。

### 1.13 Phase 0 页面矩阵（2026-08-07，源码级，不含截图/HTTP）

Phase 0 工作项 6 的源码级产物：页面 → shell 可用性 / 导航按钮 / 主 CSS 命名空间 / 主 JS 模块映射（截图与 `getComputedStyle()` 记录仍无产物）。以下事实均直接检索自 `web/static/index.html`、`index-nopg.html`、`web/static/app.js` 与两个生产 CSS：

| 页面 | `data-page` | 默认 shell（index-nopg） | Playground shell（index） | 主 CSS 命名空间 | 主 JS 模块 |
|---|---|---|---|---|---|
| Monitor | `monitor` | 有导航按钮 | 有导航按钮 | 全局 + `.quota-*`/`.pager-*`（无独立页面前缀） | `web/static/monitor/monitor_*.js`（state/io/quota/recent） |
| Settings（含 Providers/Combos/QuickSlot） | `endpoint` | 有导航按钮 | 有导航按钮 | `.settings-*`、`.btn-*`、`.custom-select-*`、`.number-stepper`、`.provider-*`、`.combo-*`、`.qs-modal-*` | `web/static/settings/*.js`、`providers.js`、`combos.js`、`quickslots.js` |
| Download | `download` | 无导航按钮（补加载 `download.js`，可经 F5/逻辑进入） | 有导航按钮 | `.dl-*`（94 个 selector，见 §1.12 命名空间计数） | `web/static/download.js` |
| Playground | `playground` | 无（不加载 playground.css） | 有导航按钮 | `.pg-*`、`--pg-mode-*` | `web/playground/static-pg/playground/*.js` |
| Gallery | `gallery` | 无 | 有导航按钮 | `.ge-*`、`.gallery-*` | `web/playground/static-pg/gallery/*.js` |
| Editor（含 Text Review Clean） | `editor` | 无 | 经 Gallery↔Editor 二路导航进入 | `.ed-*`、`.tr-*` | `web/playground/static-pg/editor/*.js` |
| GIF Frame Editor | `gif` | 有导航按钮 | 有导航按钮 | `.gif-*`（150 个 selector，见 §1.12） | `web/static/gif-editor/gif-editor-*.js` |
| Auth / 登录 | —（登录覆盖层，非 data-page） | 有（登录页） | 有（登录页） | `.login-*` | `web/static/auth.js` |

补充事实（源码核验）：

- `app.js` 页面 switch：`monitor` / `endpoint` / `download` / `playground` / `gallery` / `editor` / `gif` / `providers` / `combos`（后两者为 Settings 内子视图）。
- 默认 shell 导航为 3 按钮（Monitor / Settings / GIF），Playground shell 为 6 按钮（Monitor / Settings / Download / Playground / Gallery / GIF）；Download 页面在默认 shell 无导航按钮但模块已加载（PROJECT_MAP §24 记录 `index-nopg.html` 补加载 `download.js`）。
- Playground 专属 CSS（`.pg-*`/`.ge-*`/`.ed-*`/`.tr-*`）仅随 Playground shell 交付（§1.6 两 shell 加载边界）；`style.css` 两 shell 均交付。
- 本矩阵不包含截图与 `getComputedStyle()` 记录（未执行）；HTTP 静态资源基线未执行（见 §1.7）。（补记：computed-style 采样与 HTTP 基线已由 §1.19 执行；截图仍无产物）

### 1.14 第五批实施记录（2026-08-07，DESIGN 一致性核验 + 圆角 Token 化 + !important 分类表）

承接 §1.11/§1.12/§1.13，第五批完成三件事：Phase 1 工作项 1 的 `DESIGN.md` ↔ token 层一致性核验（结论仅限 token 层：完全一致；设计契约层面另有 reduced-motion 一项不一致，见 §1.17 修正记录）；Phase 2 第二批「同 selector 完全覆盖」收尾（`.info-field-key` 6 条被覆盖声明删除）；Phase 1/2 圆角 Token 化（7 行值 → `--radius-*`）。本轮生产 CSS 改动：`web/static/style.css` 5 行 + `web/playground/static-pg/playground.css` 3 行，全部为单行值 → Token 等价替换或重复声明删除；实施后已立即补跑验证门禁（见下方边界段落）。

**1.14.1 DESIGN.md token 层一致性核验（Phase 1 工作项 1，范围：token 层）：**

- 方法：一次性 Node 脚本剥离注释后按顶层规则提取全部 token 层（`:root` 165 个、`[data-theme="light"]` 116 个、9 个 dark variant × 16 个、9 个 light variant × 27 个、`[data-theme-style="sharp|soft|compact"]` 各 19 个、`[data-font-size="m|l"]` 各 10 个），与 `DESIGN.md` 逐表比对。
- 结果：shape（radius 5 组 × 4 style）、shadow（3 组 × 4 style）、motion（3 组 × 4 style）、typography（font-weight-normal/bold、letter-spacing × 4 style）、layout（card-padding/btn-padding × 4 style）、blur（3 组 × 4 style）、font-size（base/h2/h3/stat-value × s/m/l）、z-index（5 级）、基础颜色 token（root dark 21 项）全部与 `DESIGN.md` 数值一致；Header 契约（98px 容器 `min-height:98px;height:98px;flex-wrap:nowrap!important;overflow:hidden;padding:6px 16px`）与 nav 3×2 grid 布局（Download 占下行中格）亦与 `DESIGN.md` 一致。
- 结论（**仅限 token 层**）：`DESIGN.md` 的 Token 名称、用途、维度与代码完全一致，无高置信度不一致项。**注意：本次核验范围是 token 数值，不覆盖 DESIGN.md 全部契约条款**；§1.17 的 Phase 5 审计另行发现 DESIGN.md §Accessibility 的 reduced-motion 表述与代码不符（全局 0.01ms 禁用规则已移除），该契约不一致已在 §1.17 轮次修正 DESIGN.md —— 本节的「完全一致」仅指 token 层，不与该修正矛盾。

**1.14.2 圆角 Token 化（7 行，Phase 2 工作项 5「重复 border-radius 优先使用 Token」）：**

| 文件 | selector | 旧值 | 新 Token |
|---|---|---|---|
| style.css | `.current-key-tag` | `border-radius:4px` | `var(--radius-xs)` |
| style.css | `.info-json-markdown pre` | `border-radius:6px` | `var(--radius-sm)` |
| style.css | `.skeleton` | `border-radius:10px` | `var(--radius-md)` |
| style.css | `.sc-list::-webkit-scrollbar-thumb` | `border-radius:4px` | `var(--radius-xs)` |
| style.css | `.info-modal-search input` | `border-radius:6px` | `var(--radius-sm)` |
| style.css | `.info-modal-search button` | `border-radius:4px` | `var(--radius-xs)` |
| style.css | `.quickslot-dropdown-item` | `border-radius:6px` | `var(--radius-sm)`（与第二批 `.qs-modal-item` 同族先例） |
| playground.css | `.pg-bubble kbd` | `border-radius:4px` | `var(--radius-xs)` |
| playground.css | `.pg-bubble details` | `border-radius:6px` | `var(--radius-sm)` |
| playground.css | `.pg-bubble code` | `border-radius:4px` | `var(--radius-xs)` |

（补充 2026-08-07：圆角 Token 化实际合计 10 行——上表 7 行 + `.info-modal-search input/button` 与 `.quickslot-dropdown-item` 3 行；本轮批次计数以 §1.15 为准。）

判定依据：`DESIGN.md` 组件规则明确「Use var(--radius-*) for all border-radius（100px pill 与 50% 圆除外）」；前三批已建立同模式先例（`.qs-modal-item`、`.pg-code-warning` 等 6px→`--radius-sm`）。选点均避开 Header / Toggle / GIF / Text Review / Monitor 固定高度等高风险区（无 100px/50% 例外命中）。未 token 化的剩余硬编码圆角（3px/2px/1px/8px/12px/16px/999px）均无精确默认值对应（8px 介于 sm/md、999px 为 pill），属 B 类保留。

**1.14.3 Phase 2 第二批（同 selector 完全覆盖收尾）：**

- style.css `.info-field-key`：L1200 与 L1221（`position:sticky` 版）同为顶层规则；L1221 以相同值重声明 `margin-bottom/display/align-items/justify-content/flex-wrap/gap` 六条。删除 L1200 中该六条（保留 `font-size/font-weight/color/font-family`，L1221 未重声明它们）。删除前后计算样式不变（同 selector 后规则胜出）。
- playground.css 经复扫无剩余同 selector 完全覆盖候选；style.css 剩余候选仅 `.nav-item:focus/:focus-visible`（Header 高风险区，按计划保留，证据见 §1.12）。

**1.14.4 !important 分类表（Phase 2 工作项 3 的源码级产物，108/26 不变）：**

| 类别 | 数量（style/playground） | 代表项 | 处理 |
|---|---|---|---|
| 结构 / 构建约束 | 主要部分 | `html,body,.app` 全屏（pg:6）、`.top-header` 98px（364）、model-toolbar-row 28px（691-693）、status-col 28px（732-733）、`.detail-block > *:first-child`（752）、custom-select 尺寸族（810-839）、`.download-toolbar` overflow（2143）、gallery fullscreen body（3254-3256）、`.tr-s1/s2-root` height（pg:766/782）、`.ge-trim-mode-ctrl`（pg:993）、gif 画布族（1764-1780） | 保留；补充原因注释或未来以更精确 selector 替代（需浏览器验证） |
| 主题兼容覆盖 | 5（pg:127/132 等） | `[data-theme="light"] .pg-msg.user .pg-bubble` 深色文字覆盖、`.pg-search-toggle-btn.disabled` light 态（pg:579-580） | 保留；降低重复 selector 后再尝试去除 |
| 状态 / 交互 | 若干 | `.quota-key-row-error td`（983）、`.modal-footer .btn:focus` 文字色焦点环（1237）、modal/import input focus-visible（1242、1343-1345、1463-1464）、hidden 工具类（3877、3982、pg:635）、gif 滑条 outline 清除（4127-4142） | 保留功能性焦点/隐藏强制；gif 滑条族为高风险区 |
| 历史补丁 | 0（高置信度） | — | 无：未发现无对应 DOM/JS 契约或已被新规则取代的高置信度历史补丁，本轮不删除任何 `!important` |

**1.14.5 本轮边界：**

- 无新增 Token；未修改 vendor CSS、HTML shell、JS、DOM 结构；未拆分 CSS；未增删 `!important`（108/26 不变）。
- 验证（实施后立即补跑并通过）：`go test -count=1 ./internal/feature`、`go build ./...`、`go build -tags playground ./...`、`node web/media-bridge.test.js`（16/16）、57 个非 vendor JS `node --check`、CSS 花括号平衡、`git diff --check`。
- HTTP / 浏览器验证（含 dark/light 及 9 variant × 4 style 组合）仍未执行；本批不声称任何浏览器视觉或运行时等价性。圆角 Token 化在 sharp/soft/compact 下会按预设改变圆角（如 4px→0px/6px/2px），属 `DESIGN.md` Shape 维度设计意图，仍建议后续浏览器矩阵抽查。

### 1.15 第五批补充与 Phase 0 JS 内联样式静态/动态分类（2026-08-07）

**1.15.1 第五批补充（3 行圆角 Token 化，计入第五批合计 11 行 CSS 改动）：**

在 §1.14 基础上补充三处低风险圆角 Token 化（均为单行值替换，实施后与后续门禁一起补跑通过）：

- `.info-modal-search input` `border-radius:6px` → `var(--radius-sm)`；
- `.info-modal-search button` `border-radius:4px` → `var(--radius-xs)`；
- `.quickslot-dropdown-item` `border-radius:6px` → `var(--radius-sm)`（与第二批 `.qs-modal-item` 同族先例，QuickSlot dropdown 项，非 Header/QuickSlot 头部区域）。

至此圆角 Token 化合计 10 行（§1.14 表 7 行 + 本补充 3 行）；剩余硬编码圆角（3px/2px/1px/8px/12px/16px/999px）均无精确默认 Token 对应，B 类保留。

**1.15.2 Phase 0 工作项 5 完成：JS 内联样式静态/动态分类（可重复产物）**

承接 §1.10 命中统计，本轮用一次性 Node 扫描（写入系统 TEMP 执行后已删除）对 57 个非 vendor JS 文件做模式分类：提取 `.style.<prop>` 赋值与 HTML 字符串 `style="..."` 属性，按属性名归类为「运行时几何」（width/height/transform/left/top/opacity/display/flex/scrollTop/zIndex/margin/padding 动态值等）与「静态表现」（color/background/border*/border-radius/box-shadow/font-weight/text-align/cursor/overflow/position 固定值等）。

结果（模式分类口径，未逐条人工核对）：

- `.style.*` 赋值：运行时几何约 222 处、静态表现约 24 处；top props 分布：`display` 178（状态切换，绝大多数为显隐开关）、`height` 14、`width` 14、`cursor` 11、`overflow` 7、`cssText` 6、`left` 5、`min-width` 5、`flex` 5、其余（border-color/background/font-size/border-bottom 等静态表现合计约 5）。
- HTML `style="..."` 属性：运行时 366 处、静态 163 处（多数为模板字符串中的固定布局值，如 `width:90vw;height:90vh`、`flex:1`）。
- 静态表现命中示例（已 Token 驱动，无需迁移）：`color=isError ? 'var(--danger)' : ''`（gallery-edit.js）、`background=remain===0&&total>0?'var(--danger)':…`（providers.js）。
- 结论：运行时几何占绝对多数（约 92% 的 `.style.*` 命中），符合 §4 治理规则「运行时 geometry 保留 inline」；静态表现命中极少且已 Token 驱动。**本轮不做任何 JS inline → CSS class 迁移**——每处迁移需按 §4 覆盖初始/成功/失败/空/关闭状态并做 DOM 验证，属 Phase 4 工作项，留待浏览器验证后逐条处理。
- 口径局限：`border`/`margin`/`padding` 多值属性与 camelCase 属性（如 `backgroundPosition`）部分落入未分类桶（合计约 617 处含 html 属性），不影响「静态表现极少且 Token 驱动」的结论。

### 1.16 共享控件状态表与模块归属表（2026-08-07，Phase 3/4 文档基座，无 CSS 改动）

**1.16.1 共享控件状态来源表（Phase 3 工作项 1 的源码级产物）：**

| 控件族 | normal | hover | active | focus-visible | disabled | error/selected |
|---|---|---|---|---|---|---|
| `.btn` 基础 | `--btn-secondary-*` tokens（bg/border/text） | `--btn-secondary-bg-hover` + shadow + translateY(-0.5px) | `--btn-secondary-bg-active` + translateY(0) | 全局 `button:focus-visible` 2px accent 环（style.css 焦点族） | `.btn:disabled{opacity:0.6;cursor:not-allowed}` | — |
| `.btn-primary` / `.btn-danger` / `.btn-accent` / `.btn-ghost` | 各自 `--btn-*-*` token 族 | 各自 `-hover` token + glow | 各自 `-active` token | 同上全局环；`.modal-footer .btn:focus` 另用 `var(--text)` 环（modal 内高对比） | 继承 `.btn:disabled` | danger 族即错误语义来源 |
| `.input` / 原生 input/select/textarea | `var(--input-bg)` + `--glass-border` | — | — | `input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent)}`（style.css 焦点族）+ 部分 `:focus` box-shadow accent-glow | `.input:disabled` / 语义类 | `.form-group` 内 `.is-error` / 模块 error class |
| `.custom-select-*` | wrapper/option 菜单 `--surface-overlay` + blur | option hover `--glass-hover` | option `:active` | wrapper `:focus-within` accent 轮廓（.number-stepper 同款） | — | `.focused` 高亮 `--interactive-active-bg` + accent border |
| `.number-stepper` | `--input-bg` 容器 | 按钮 hover | 按钮 active | `:focus-within` accent 轮廓光圈 | 输入 disabled 态 | — |
| `.toggle-switch` | 3D 翻转点 + `--toggle-off-bg` | — | — | input 可见焦点环（全局） | — | checked 态 = `.toggle-switch input:checked + .toggle-slider`（accent gradient） |
| `.modal-*` / `.pg-modal-*` | `--modal-bg` + blur + `--shadow-modal` | — | — | 弹窗内控件走全局焦点环；焦点陷阱为 JS（auth.js/quickslots.js 等） | — | 弹窗内错误提示 class（`.login-error`、`.pg-autochat-hint` 等） |
| Toast / Tooltip | `--toast-bg` / 单共享 `.tip` 节点 | — | — | Tooltip 不可聚焦（装饰） | — | `.toast-error` / `.toast-success` 图标语义色 |

结论：各控件族状态均有唯一主来源（token 或全局焦点族），无高置信度分叉可合并；Phase 3「统一共享基础控件」的 CSS 合并需浏览器验证后逐族推进。

**1.16.2 模块归属表（Phase 4 文档基座，源码级）：**

| 模块 | 主文件 | 样式归属 | 备注 |
|---|---|---|---|
| 主题/Token/重置/滚动条 | style.css | style.css | 两 shell 共用 |
| Header / nav / QuickSlot 头部 / theme-switch | style.css | style.css（`.nav-*`、`.top-header*`、`.qs-modal-*`） | Header 高风险区 |
| 共享基础控件（btn/input/select/modal/toast/tooltip/custom-select/stepper/toggle） | style.css | style.css（`.btn*`、`.modal*`、`.custom-select-*`、`.number-stepper`、`.toggle-*`、`.tip`） | Phase 3 范围 |
| Auth / 登录 | style.css | style.css（`.login-*`、`--surface-auth-*`） | |
| Monitor / Console / Quota | style.css | style.css（无独立前缀，`.status-*`、`.quota-*`、`.pager-*`、`.session-*`） | Monitor 28px 工具条高风险 |
| Settings / Provider / Combo / QuickSlot 弹窗 | style.css + web/static/*.js | style.css（`.settings-*`、`.provider-*`、`.combo-*`、`.qs-modal-*`） | |
| Download / FileTransfer | style.css + download.js/filetransfer.js | style.css（`.dl-*` 94 个 selector） | |
| GIF Frame Editor | style.css + gif-editor/*.js | style.css（`.gif-*` 150 个 selector） | GIF 高风险区 |
| Playground shell / 消息 / 模式 / Search / Image / AutoChat / ComfyUI | playground.css + playground/*.js | playground.css（`.pg-*`、`--pg-mode-*`） | 仅 Playground shell 加载 |
| Gallery（布局/全屏/树/预览） | style.css + gallery/*.js | **style.css 与 playground.css 分属**：`.gallery-*` 布局/全屏在 style.css；`.ge-*` 编辑弹窗与 `.gallery-edit-*` 在 playground.css | **Phase 4 归属收敛点 1** |
| Editor / Text Review / Log Reader | playground.css + editor/*.js | playground.css（`.ed-*`、`.tr-*`、`.log-*`） | Text Review 高度契约高风险 |

结论：Gallery 样式跨文件分属（style.css 持有全屏/布局，playground.css 持有编辑/审核），是 Phase 4 唯一明确的高置信度归属收敛点；其余模块归属清晰。收敛动作（移动规则）必须保持 source order 并做浏览器验证，本轮不动。

### 1.17 Phase 5 源码契约审计（2026-08-07，无 CSS 改动）

**响应式：**

- style.css 11 个媒体/容器查询：1250px（隐藏 header-stats）、1024px、900px、760px、768px（×3 处：3091/3892/4016）、480px、1280px、1100-901px、`@container main (max-width:600px)`、`@supports crisp-edges`。
- playground.css 5 个：900px（×3：12/347/403）、768px（154）、`prefers-reduced-motion`（202）。
- 观察：768px 断点在 style.css 定义 3 处、900px 在 playground.css 定义 3 处，存在「同一断点多处分散」现象（Phase 5 工作项 2）；合并需浏览器验证各页行为，本轮不动。
- Header 窄屏隐藏优先级仍由 `setupHeaderResponsive()`（auth.js）运行时计算（DESIGN §Header 契约），CSS 无擅自隐藏核心导航的规则。

**动效（prefers-reduced-motion）：**

- style.css 无任何 `prefers-reduced-motion` 规则——全局 0.01ms 禁用规则已于 2026-08 移除（恢复 Header 主题切换、齿轮、Tooltip 动画，PROJECT_MAP §24 记录）；playground.css L202 有作用域 reduce 块（`.pg-image-generating` shimmer 与 `.pg-image-ring` spinner 禁用）。
- 审计发现 `DESIGN.md` §Accessibility 的「universal selector 禁用全部动画」表述与代码不符（已过时），本轮已更新 `DESIGN.md` 为按组件作用域处理的实际契约（见 §1.17 文档改动记录）；**该契约已由浏览器实证**：reduce 媒体匹配下 navItem/statCard/pageEnter 动效值与基准完全一致（有意不变），仅作用域 kill 生效（§1.19.6）。

**焦点（focus-visible）：**

- 已存在的焦点环均使用 `var(--accent)` 2px（全局 `input/select/textarea:focus-visible`、`.btn:focus-visible` 族 L3142，含 header-icon-btn/shutdown-btn/style-swatch/btn-filter/gallery-tree-node/provider-card）或模式感知环（`.pg-mode-btn:focus-visible` 用 `--pg-mode-active-color` color-mix）；`.modal-footer .btn:focus` 用 `var(--text)` 环为 modal 内高对比特例（浏览器计算为 3px solid #fff，minor 观察项）；`.theme-card`/`.style-swatch` 用 box-shadow 双环 + outline:none（浏览器实测可见）；`.toggle-switch` 的 checkbox 走全局 `input:focus-visible` 环（无缺口）。
- **缺口修正（据 §1.19.5 浏览器键盘 Tab 实测）：**
  1. `.nav-item` 键盘焦点原判「无可见指示」**撤销**：浏览器实测全部 nav-item 键盘聚焦 `:focus-visible=true`，outline 计算为 `3px none`（源 3143 显式 outline:none），元素以 box-shadow 呈现——active 项带 accent glow（`rgba(244,114,182,0.22) 0 0 12px inset` 等），非 active 项保持基座 `0 2px 4px rgba(0,0,0,0.2)` 阴影。焦点可达性已证实；非 active 项无专属焦点环的余韵（仅基座阴影）记为设计斟酌项，待全量键盘矩阵复核，不再列为已证实缺口。
  2. GIF 时间线切片按钮 `.btn-copy-slice:focus-visible,.btn-del-slice:focus-visible{outline:none}`（L4281）——**未被 §1.19 smoke 覆盖，保留为未验证项**（且为 18px 尺寸例外）。
  3. 弱指示（仅 border-color 变化，非契约的 2px outline）：`.gif-workspace input:focus`（L3990）、`.console-search:focus`（L945）、`.login-input:focus`（L2109）——**未被 §1.19 smoke 覆盖，保留为未验证项**。
- 结论修正：已证实缺口仅剩 GIF 切片按钮与 3 处弱指示输入（均未覆盖、待键盘专项）；nav-item 缺口撤销。本轮不做 CSS 改动，记录为 Phase 5 工作项 4 待办。

**触摸 / 裁切：**

- `touch-action` 共 3 处（style.css 2 + playground.css 1），集中在 Gallery/GIF 拖拽区；最小触摸目标 24×24px 的完整验证需浏览器（部分按钮为 18px 图标钮，属既定例外 `.btn-copy-slice` 等，见 §2.4）。
- `overflow:hidden` 裁切风险清单与 §1.3 一致（tooltip/dropdown/modal 已由 `.download-toolbar` overflow-visible 与 `.custom-select-wrapper.open` z-index 修复覆盖），无新增发现。

结论：本轮 Phase 5 不做 CSS 改动；唯一代码外动作是 `DESIGN.md` reduced-motion 契约表述更新（§1.17 记录）。所有响应式/动效/焦点/触摸的最终判定需浏览器矩阵。

### 1.18 Phase 6 CSS 拆分进入条件审计（2026-08-07，结论：不满足，不进入）

| 进入条件 | 当前事实 | 判定 |
|---|---|---|
| 1. 页面/模块归属已明确 | §1.16.2 模块归属表已建立；Gallery 跨文件分属为唯一收敛点 | 部分满足 |
| 2. CSS source order 已有测试或稳定记录 | 无 source-order 测试；仅有实施记录与 §1.12 重复分析 | 不满足 |
| 3. 两个 HTML shell 的加载边界可明确表达 | §1.6 已核验：默认 shell 仅 style.css；Playground shell 另加 playground.css + vendor ×2 | 满足 |
| 4. Playground `feature.Assets` 路由 / embed 清单有对应更新方案 | StaticFiles manifest 机制存在（feature.go），但拆分方案未起草 | 部分满足 |
| 5. 拆分不会引入新的 cascade 依赖或重复 Token | 尚无拆分方案设计，无法证明拆分不引入新依赖；§1.19 浏览器基线已建立，可支撑拆分后的验证 | 不满足 |
| 6. 可以用真实 HTTP 页面验证而不是只做文件存在性检查 | **已满足**：§1.19 已用真实 HTTP + headless Chromium 验证两 shell、CSS/vendor 路由 200、主题矩阵与 3 档宽度 | 满足 |

结论：条件 2/5 不满足（source order 无测试；拆分方案未设计），条件 6 已由 §1.19 满足，条件 1 部分满足、3 满足、4 部分满足——**Phase 6 仍不进入**。候选结构（§3 Phase 6）保持仅候选；重新评估前置：先补 source-order 稳定记录（浏览器基线已就绪），再收敛 Gallery 归属、起草拆分方案。本轮无拆分动作、无新 CSS 文件。

### 1.19 HTTP / 浏览器验证记录（2026-08-07，真实 HTTP + headless Chromium，Phase 0 工作项 7 / §6.2 门禁首次执行）

由浏览器 worker（CssBrowserSmoke）执行真实 HTTP/Chromium smoke，证据存 `tmp/css-verify/evidence/evidence-*.json`（gitignored，保留备查）。以下为验证事实与结论：

**1.19.1 构建与运行：**

- 二进制：`go build -tags playground`（小写 tag），25,153,536 字节，置于 `tmp/css-verify/tinyrouter.exe`（验证后已删除）。
- 运行：临时 `run/config.yaml`，端口 21337，密码禁用，`enablePlayground` true→false 切换两个 shell；浏览器为 headless Chromium 150（playwright-core；xd://browser 工具不可用时的替代通道）。

**1.19.2 两个 shell 的静态资源基线（Phase 0 工作项 7 完成）：**

| shell | HTML | CSS 请求 | 状态 | console/page error | request failure |
|---|---|---|---|---|---|
| Playground（index.html） | `hasPlayground:true`，pg-mode-toggle×1、pg-mode-btn×4、pg-layout/panes/input-bar/win-btns 齐全 | `/style.css`、`/playground.css`、`/vendor/pg-highlight-theme.css`、`/vendor/katex.min.css` | 全部 200（style 204,840B / playground 100,562B / highlight 2,307B / katex 23,352B） | 0 / 0 | 1：`/api/monitor/events` SSE `net::ERR_ABORTED`（页面导航中止流式连接，属应用行为，非 CSS） |
| 默认（index-nopg.html） | `hasPlayground:false`，pg 元素缺席，nav = Monitor/Settings/GIF | `/style.css` | 200（`/playground.css` 路由亦 200，因同二进制编译注册，但 shell 从不引用） | 0 / 0 | 0 |

- 两 shell dataset 默认：`dark / default / default / s`；默认 shell token 实测：accent `#4fc3f7`、radiusMd `10px`、fontBase `13.5px`。

**1.19.3 主题矩阵（computed style，9 组合单元 + 配置驱动）：**

| 组合 | accent | text | surfaceOverlay | 其他实测 |
|---|---|---|---|---|
| dark/default/s | `#4fc3f7` | `#ededf0` | `rgba(26,26,36,0.96)` | radiusMd 10px、radiusXl 18px、fontBase 13.5px、btnPadding 8px 16px、navRadius 14px |
| light/default/s | `#0ea5e9` | `#1a1a1a` | `rgba(255,255,255,0.98)` | — |
| dark/tokyo-night/s（非默认 dark） | `#7aa2f7` | `#c0caf5` | `rgba(26,27,38,0.96)` | — |
| light/cool/s（非默认 light） | `#6366f1` | `#1e293b` | `rgba(248,250,252,0.98)` | — |
| sharp | — | — | — | radiusMd 3px、radiusXl 6px、btnPadding 6px 14px |
| soft | — | — | — | radiusMd 14px、radiusXl 24px、btnPadding 10px 20px |
| compact | — | — | — | radiusMd 6px、radiusXl 10px、btnPadding 5px 10px |
| font-m | — | — | — | fontBase 15px |
| font-l | — | — | — | fontBase 17px |

- 配置驱动主题：config `theme:{darkVariant:tokyo-night, style:soft}` + 全新 profile → dataset `dark/tokyo-night/soft/s`，实测 accent `#7aa2f7`、text `#c0caf5`、radiusMd `14px`，0 console error。持久化：localStorage 的 theme/fontSize 跨刷新保留；variant/style 由 config `/api/settings` theme 段重新应用（config 为持久权威路径）。

**1.19.4 响应式（desktop/tablet/mobile 无横向溢出）：**

- desktop 1440：无横向溢出；tablet 768：scrollWidth=innerWidth=768、headerStatGrid `repeat(3,80px)`、topHeader padding `6px 12px`、无溢出；mobile 390：`repeat(3,52px)`（≤480 规则生效）、statCardPadding `1px 4px`、无溢出。

**1.19.5 焦点（focus-visible，键盘 Tab 实测）：**

- logo link 与全部 nav-item 键盘聚焦时 `:focus-visible=true`；nav-item outline 计算为 `3px none`（源 3143 显式 `outline:none`），可见性由 box-shadow 呈现——**active nav-item 另带 accent glow（`rgba(244,114,182,0.22) 0 0 12px inset` 等），非 active 项保持基座 `0 2px 4px rgba(0,0,0,0.2)` 阴影**。§1.17 审计原判「nav-item 键盘焦点无可见指示」据此**撤销**：浏览器观察到焦点可达且元素带阴影渲染；非 active 项无专属焦点环的余韵属设计斟酌项，记入待浏览器矩阵复核，不再列为已证实缺口。
- modal 内：theme-card/style-swatch 双环 box-shadow（accent 2px + glow 4px，源 3800/3843）实测可见；`.modal-footer .btn-primary` 计算 outline 为 `3px solid #fff`（源 1237 声明 2px solid var(--text)，浏览器计算为 3px——宽度差为 minor 观察项，无需改动）。
- 程序化 `.focus()` 不触发 `:focus-visible`（符合浏览器启发式）。

**1.19.6 reduced-motion（媒体匹配下实测值不变——有意保持）：**

- `prefers-reduced-motion: reduce` 媒体匹配成功；navItem transition `0.15s all`、statCard `0.15s`、pageEnter `pageFadeIn 0.25s` 在 reduce 下与基准完全一致（valuesIdentical=true）。与 §1.17 记录一致：style.css 有意无全局 kill 规则（源 3086 注释），仅 playground.css:202 作用域 kill（`.pg-image-generating`/`.pg-image-ring`）。**DESIGN.md 的 reduced-motion 契约修正（§1.17）得到浏览器实证**。

**1.19.7 modal / dropdown：**

- modal：overlay `fixed/inset-0/z-index:50(--z-modal)/rgba(0,0,0,0.5)`；modal 本体 radius 18px（--radius-xl）、maxHeight 860px=calc(100vh-40px)、boxShadow=--shadow-modal、bg=--modal-bg、backdrop blur 20px；modal-body `overflow-y:auto`；overlay 为唯一祖先 → 无页面容器裁切。
- dropdown（Download 页 `#dl-type-wrap`）：absolute z-100、bg `rgba(26,26,36,0.96)`（=--surface-overlay，第二批 `.custom-select-menu` 修复目标）、radius 10px（--radius-md）、矩形完全位于视口内；`.custom-select-wrapper.open` z-1000 生效；祖先仅 main/app 为滚动容器（overflow 非 hidden 于菜单路径）。

**1.19.8 未声称：**

- 未做全 72 组合截图；矩阵 = 9 个 computed-style 组合单元 + 3 档宽度 + 配置驱动全新 profile + 两 shell；证据为 computed 值 + 请求/console 日志，**非截图**。截图与完整交互矩阵（全页面、全组合）为**用户手动任务**（自动化视觉验证已停止），见 §1.7 剩余项。
- GIF 切片按钮焦点、3 处仅 border 变色输入（gif-workspace/console-search/login-input）未被本次 smoke 覆盖，§1.17 所列相应缺口**保留为未验证项**，需键盘专项复核。

**1.19.9 边界：**

- 验证后已停止服务（21337 关闭）、删除二进制/临时脚本/运行配置；证据 JSON 保留（gitignored）；仓库工作树除既有 6 个修改文件外无其他改动，本记录不改变任何生产代码。

### 1.20 完成度总览与剩余风险（2026-08-07 终审）

对全部阶段工作项做最终核对；勾选项均有上文证据锚点，未勾选项明确标注浏览器/人工依赖，不声称 Phase 3–5 完成。

**1.20.1 硬编码颜色 A/B/C 家族级分类表（Phase 0 工作项 4 / Phase 1 工作项 3 完成）：**

| 类别 | 内容 | 状态 |
|---|---|---|
| **A 类**（可直接映射既有语义 Token） | 表面文字 `#fff`→`--text-contrast`（§1.5 8 行 + §1.6 3 行 + §1.11 11 行：mp/proto/info 徽章、pg-send、模型选择、GC 新消息、缩略删除、log-mode、gallery 全屏）；`#000`/`#1a1326`→`--text-on-accent`（§1.5 8 行）；代码面 `#1a1326`/`#e6def0`→`--code-surface`/`--code-text`（§1.5 4 行）；错误/警告 `#ff6b6b`→`--danger`（§1.5）、`#ef5350`/`#ffa726`→`--danger`/`--warn`（§1.11 dl-status 家族 + dl-detail-error）；表面 `rgba(26,26,36,0.96)` 等→`--surface-overlay`/`--surface-fullscreen`/`--fullscreen-control-*`/`--surface-auth-*`（§1.6/§1.8/§1.11）；活跃态 `rgba(79,195,247,0.10)`→`--interactive-active-bg`（§1.6）；未定义别名 `--accent-text`/`--accent-contrast`→`--text-contrast`（§1.9）；圆角 `4px/6px/10px`→`--radius-xs/sm/md` 10 行（§1.14/§1.15.1） | **已替换**：颜色 58 行 + 圆角 10 行；构建/Node/CSS 门禁全过；浏览器矩阵验证 token 解析正确（§1.19.3） |
| **B 类**（模块专属 / 需对比度验证，未替换） | SSE badge 事件色（`#c4a6ff`/`#f59e0b`/`#4ade80`/`#94a3b8` + rgba 底）；Editor diff 色族（`#ef4444`/`#22c55e`/`#eab308` + light 覆盖）；警示琥珀 `#fbbf24`（`.pg-editor-title .unsaved`、`.ed-dirty-dot`、`.tr-notice h3`、`.pg-custom-warning`、`.pg-tab-badge.custom`）；原生 select option（light `#fff`/`#1a1a1a`、dark `#16162a`/`#f0f0f5`）；`.dl-status-processing` `#b39ddb`；`.pg-gc-*` 玻璃面（`rgba(255,255,255,.05/.08)`、`rgba(0,0,0,.1)`）；`.pg-modal-overlay` `rgba(0,0,0,0.5)`；`.pg-autochat-panel` border `rgba(255,255,255,0.1)`；`.pg-code-expand-btn:hover` `rgba(60,60,60,.95)`；`.toggle-slider::after` 灰 `#9b9b9b`；`.pg-mode-btn.active` inset `rgba(0,0,0,.45/.06)`；`.pg-tab-badge`/`.pg-mermaid` 紫 `rgba(196,166,255,.2)`；`.pg-search-history-del:hover` 红 glow `rgba(239,68,68,0.4)` | **未替换**：需浏览器对比度验证后决定 token 化或新增模块 Token（`--warn` 与 `#fbbf24` 色相不同，不强行替代） |
| **C 类**（第三方 / 图像 / 代码高亮 / 装饰，不替换） | vendor（`katex.min.css`、`pg-highlight-theme.css`）；图像/iframe 画布（`.pg-html-preview` `#fff`、gallery video 区、`[data-theme="light"] .ed-parsed-area pre`、`.pg-image-generating` 微光、`.pg-image-loading-overlay`）；代码高亮/徽章发光（badge pulse box-shadow、`--accent-glow` 类）；几何装饰（nav diamond、scrollbar 色、skeleton 渐变、keyframes 内色值、focus ring 发光 `0 0 0 2px`）；全屏画廊按钮族底色 `rgba(255,255,255,.1/.15/.25)`（控制条本身已 token 化，§1.8） | **不替换**：与 §1.4/§1.10 口径一致 |

**1.20.2 语义重复 Token / alias 审计（Phase 1 工作项 2 完成）：**

- 既有 alias 层（`--primary`/`--border`/`--bg-card`/`--bg-main`/`--bg-input`/`--bg-secondary`/`--text-primary`/`--toast-border`/`--option-bg`/`--badge-inactive-bg`/`--panel-sticky-bg`）均有消费者（1–23 处，2026-08-07 检索），属兼容基础设施，保留。
- 3 个无消费者 alias：`--error`、`--surface-page`、`--interactive-active-text`（web/ CSS+JS+HTML 零使用）；按「保留兼容 alias 时标注用途」已在 `style.css` L141-146 注释中标注，**不删除**（兼容层契约）。
- 语义 token 组（`--surface-*`/`--border-*`/`--status-*`/`--code-*`/`--interactive-*`）无重复定义，无可合并项。

**1.20.3 完成项核对表（证据锚点）：**

| 工作项 | 状态 | 证据 |
|---|---|---|
| Phase 0：行数/字节/规则/媒体/动画/!important 基线 | ✅ | §1.4 |
| Phase 0：selector 清单（重复/多定义/裸全局/命名空间） | ✅ | §1.12（一次性脚本 + 关键输出） |
| Phase 0：var(--token) 定义/使用/未定义/fallback 表 | ✅ | §1.9 + 各批复扫（无新增未定义） |
| Phase 0：硬编码颜色/圆角/字重/过渡/模糊/阴影扫描 + A/B/C 分类 | ✅ | §1.10 原始统计 + §1.20.1 分类表 |
| Phase 0：JS 内联样式静态/动态分类 | ✅ | §1.15.2（结论：静态极少且 Token 驱动，不做迁移） |
| Phase 0：页面矩阵 | ✅（源码级） | §1.13 + computed 采样 §1.19.3 |
| Phase 0：截图基线 | ⏳ 用户手动 | computed 值已完成（§1.19.3/§1.19.4）；**截图由用户手动执行**（自动化视觉验证已停止，本计划不产出截图证据） |
| Phase 0：两 shell HTTP 资源基线 | ✅ | §1.19.2（全 200、0 error、SSE abort 为应用行为） |
| Phase 1：DESIGN token 层一致性核验 | ✅ | §1.14.1（reduced-motion 契约例外见 §1.17） |
| Phase 1：语义重复 Token 合并/alias 标注 | ✅ | §1.20.2（无可合并项；3 个死 alias 已标注） |
| Phase 1：硬编码颜色 A/B/C 分级 | ✅（家族级） | §1.20.1（B 类替换待对比度验证） |
| Phase 1：模块 Token 使用边界 | ✅（源码级） | §1.16.2 归属表 + §1.12 命名空间计数 + §1.20.1 B 类清单 |
| Phase 1：焦点环/状态语义统一 | ⏳ | 审计完成（§1.17）；GIF/弱指示输入未验证 |
| Phase 1：color-mix() 支持与 light 对比度 | ⏳ 部分 | 浏览器支持已实证（§1.19.3 computed 值）；light 对比度审计未做 |
| Phase 1：DESIGN.md 同步 | ✅ | §1.17 reduced-motion 契约修正（无新 Token） |
| Phase 2：同 selector 完全覆盖删除/合并 + `.pg-param-row` 族语义合并 | ✅（证明安全子集） | §1.12（16+3 行 + 6 条声明 + `.pg-param-row` label/input:focus 死规则删除与 3 条声明收窄）+ §1.14；复扫 0 新增；剩余 `.nav-item:focus` 同值重复证明安全但按 Header 高风险规则**有意延后**；按钮/输入/Modal footer 合并**用户视觉门控** |
| Phase 2：覆盖链识别/死声明删除 | ⏳ | 同 selector 声明级比较完成（§1.12）；跨 selector 覆盖链需 computed-style 验证，**用户视觉门控** |
| Phase 2：!important 分类表 | ✅（源码级） | §1.14.4（四类归档，无高置信度历史补丁） |
| Phase 2：transition/box-shadow/border-radius 逐条替换 | ⏳ 部分 | border-radius 10 行完成（§1.14/§1.15.1）；transition/box-shadow 会改变行为，**用户视觉门控** |
| Phase 2：不引入 @layer | ✅ | 约束保持（未引入） |
| Phase 2：注释/媒体查询/keyframes 完整性 | ✅ | 各批 CSS 花括号/注释/媒体/关键帧平衡门禁通过；原型块删除时核对注释边界（§1.12） |
| Phase 3：控件状态表 | ✅（文档基座） | §1.16.1（未声称 Phase 3 完成） |
| Phase 3：checkbox/radio/Toggle 不被通用 input 覆盖 | ✅ | 源码核验：`.form-group input`/`.detail-block input` 显式 `:not([type=checkbox]):not([type=radio])`（L1253/L1256）；`.toggle-switch input` 独立 appearance:none（L1751+） |
| Phase 3：其余控件统一 | ⏳ | 抽取/职责/高度统一/文字溢出/焦点锁均**用户视觉门控**（见 §3 Phase 3 勾选注释） |
| Phase 4：模块归属表 + 依赖标记 + Playground 全局布局识别 + shell 隔离核验 | ✅（源码级） | §1.16.2 归属表；§1.20.1 模块内 B/C 色归类；§1.3/§1.13/§1.16.2 记录 `html,body,.app` 全屏约束为 Playground 专属；§1.6 + §1.19.2 核验默认 shell 仅 style.css、pg 元素缺席；**未移动任何规则（移动为视觉门控）** |
| Phase 4：跨页面共用规则移动 / 动态 inline 静态表现迁移 | ⏳ | 移动/迁移改变 source order 与加载，**用户视觉门控**（分类结论见 §1.15.2，不做迁移） |
| Phase 5：源码契约审计 + 媒体查询检查 + Header 响应式职责校验 | ✅ | §1.17 清单；§1.19.4 三档无溢出；768/480 断点不隐藏核心导航、隐藏为 `setupHeaderResponsive()` JS 职责（§1.19.4/§1.17） |
| Phase 5：浏览器实测子集 | ✅ | §1.19（3 档宽度、modal/dropdown、reduce、焦点 Tab） |
| Phase 5：完整响应式/可访问性专项（focus-visible 全量、reduced-motion GIF 反馈、touch/触摸尺寸、tooltip/错误裁切、L/M 字体与中英文） | ⏳ | 源码审计 + 部分实测完成（§1.17/§1.19）；**其余为端点键盘/对比度/视觉测试，用户视觉任务** |
| Phase 6：进入条件审计 | ✅ | §1.18（条件 2/5 不满足，不进入） |

**1.20.4 剩余风险（全部为用户手动 / 端点视觉 / 键盘交互依赖，未声称完成）：**

- **用户边界（明确）**：截图、视觉外观、浏览器主题矩阵扩展、端点键盘/对比度/交互测试均由用户手动执行（自动化视觉验证已停止，本计划不再产出视觉证据；用户对端点做最终视觉验收）。
- §4 动态内联样式治理 5 项全部为**用户视觉门控**（统计/分类已完成见 §1.15.2；合并/迁移动作未开始，执行时须按 §4 覆盖各状态）。
- 截图基线：**用户手动任务**（自动化视觉验证已停止，本计划不产出截图证据）；§1.19 证据为 computed 值 + 日志，非截图。
- 完整交互矩阵（全页面、全组合、键盘顺序、窄屏交互）：**用户手动任务**，未执行。
- B 类颜色对比度验证与可能的模块 Token 新增（§1.20.1 B 类）。
- GIF 切片按钮与 3 处仅 border 变色输入的键盘焦点复核（§1.17 保留为未验证项）。
- QuickSlot `--font-lg`/`--font-sm` 字号（需浏览器确认观感）。
- Phase 3 控件 CSS 合并、Phase 4 模块收拢（Gallery 归属）、Phase 5 剩余专项、Phase 6 拆分（条件 2/5 未满足）。
- `transition: all` 与 `box-shadow` 逐条 Token 化（行为变化，需浏览器）。

**1.20.5 不再实施的高置信度浏览器无关编辑及其原因：**

- 同 selector 完全覆盖删除已穷尽：复扫 0 新增；唯一剩余 `.nav-item:focus/:focus-visible` 重复（L384/L3159 同值）删除虽证明安全，但按计划「优先不涉及 Header 高风险区域」保留（证据见 §1.12）。
- A 类颜色/圆角已穷尽：`color:#fff` on token 背景扫描 0 命中；4px/6px/10px 圆角低风险选点全 token 化；剩余 8px/12px/16px/3px/2px/1px/999px 无精确默认 Token 对应（999px 为 pill 例外），B 类保留。
- 死 alias（`--error`/`--surface-page`/`--interactive-active-text`）有意不删除：兼容层契约，已按计划标注用途（§1.20.2）。

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
- [x] 生成 selector 清单，标记：重复 selector、同一 selector 多处定义、裸全局 selector、模块命名空间 selector。（可重复产物已完成，见 §1.12：一次性 Node 脚本 + 关键输出；含同 selector 跨顶层规则声明级比较）
- [x] 扫描 `var(--token)` 使用点，建立"定义 / 使用 / 未定义 / fallback"表。（var 扫描已完成，见 §1.9；第四批后复扫确认无新增未定义，见 §1.11）
- [x] 扫描硬编码颜色、`border-radius`、`font-weight`、`transition`、`backdrop-filter`、结构性 `box-shadow`。（原始统计见 §1.10；A/B/C 家族级分类表见 §1.20.1；A 类颜色替换四批 13+7+17+21 行 + 圆角 10 行；B 类清单与 C 类边界见 §1.20.1）
- [x] 扫描 JS 的 `style`、`style.cssText` 和 HTML 字符串内联样式，区分静态表现值与运行时几何/进度值。（命中统计见 §1.10；静态/动态分类已完成，结论：静态表现极少且已 Token 驱动、运行时几何为主、不做迁移，见 §1.15.2）
- [x] 建立页面矩阵：Monitor、Settings、Download、GIF、Auth、Playground、Gallery、Editor、Text Review。（源码级矩阵见 §1.13；computed-style 采样见 §1.19.3；截图由用户手动执行）
- [ ] 为每个关键页面保存 dark/light 默认主题的桌面和窄屏截图；记录页面数据属性和关键 `getComputedStyle()` 值。（部分完成：关键 `getComputedStyle()` 值已由浏览器实测 9 组合 + 3 档宽度，见 §1.19.3/§1.19.4；**截图为用户手动任务**——自动化视觉验证已停止，用户将自行对端点做视觉测试）
- [x] 记录默认 shell 与 Playground shell 的静态资源请求结果，作为后续 HTTP 回归基线。（已完成，见 §1.19.2：两 shell、4+1 CSS 请求全 200、0 console/page error、SSE abort 为应用行为；证据 tmp/css-verify/evidence/，gitignored）

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

- [x] 校验 `DESIGN.md` 与 `style.css` 根 Token、light Token、variant/style 覆盖层一致。（已完成，结论：完全一致，无改动；方法见 §1.14.1）
- [x] 合并语义重复的 surface、border、status、code 和 active Token；保留兼容 alias 时标注用途。（审计完成，见 §1.20.2：语义 token 组无可合并项；alias 层均有消费者或已标注——3 个无消费者 alias `--error`/`--surface-page`/`--interactive-active-text` 已在 style.css 注释标注用途并保留）
- [x] 对项目 CSS 中可安全替换的硬编码颜色分级（A/B/C 家族级分类完成，见 §1.20.1；A 类已替换 13+7+17+21 行，见 §1.5/§1.6/§1.8/§1.11）：
  - A 类：明显对应现有语义 Token，优先替换；
  - B 类：模块专属但需验证对比度，可新增模块 Token；
  - C 类：第三方、图像预览、代码高亮或几何装饰，暂不替换。
- [x] 为 `.pg-*`、`.ed-*`、`.ge-*`、`.tr-*`、`.dl-*` 等模块确认 Token 使用边界。（源码级边界确认完成：模块归属表 §1.16.2、命名空间计数 §1.12、模块内硬编码色 B/C 归类 §1.20.1）
- [ ] 统一焦点环、禁用态、错误态、成功态和警告态的语义来源。（**用户视觉门控**：源码审计见 §1.17；GIF 切片按钮与 3 处弱指示输入需键盘/对比度人工验证，B 类颜色需端点视觉测试）
- [ ] 对 `color-mix()` 使用点检查浏览器支持和 light 主题对比度；必要时提供安全 fallback，但不复制整套组件规则。（浏览器支持已实证：Chromium 150 computed 值正常，见 §1.19.3；**light 对比度为用户视觉任务**）
- [x] 把新 Token 和语义变化同步到 `DESIGN.md`，不在计划执行中私自改变设计系统含义。（无新增 Token；reduced-motion 契约已按代码事实修正 DESIGN.md，见 §1.17）

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

- [x] 对同名 selector 合并同一职责的声明，保留最终 source order 和注释边界。（证明安全子集已完成两批：16+3 行 + 6 条声明，见 §1.12/§1.14；复扫 0 新增；剩余 `.nav-item:focus/:focus-visible` 同值重复删除虽证明安全，但按计划「优先不涉及 Header 高风险区域」**有意延后**，见 §1.12）
- [ ] 识别"基础规则 → 页面规则 → 主题规则 → responsive 修复"的真实覆盖链，删除已被后续规则完全覆盖的死声明。（同 selector 声明级比较已完成，见 §1.12；**跨 selector 覆盖链需 computed-style 验证，属用户视觉门控**；`!important` 分类表已完成见 §1.14.4）
- [x] 把重复的 `.pg-param-row`、按钮、输入、Modal footer 等规则按语义合并；若两个模块确实不同，保留命名空间而不是强行合并。（**证明安全子集完成**：`.pg-param-row` 族（含 label/input:focus 死规则删除与 3 条重复声明收窄）见 §1.12；按钮/输入/Modal footer 语义合并为**用户视觉门控**，未执行）
- [ ] 统一 selector 顺序：基础元素/布局 → 状态 → 主题覆盖 → responsive → reduced motion。（重排 source order 会改变层叠结果，**用户视觉门控**）
- [ ] 给重复的 `transition: all`、`box-shadow`、`border-radius` 和固定颜色做逐条替换，优先使用 Token。（border-radius 已 token 化 10 行低风险选点，见 §1.14/§1.15.1；`transition: all` 与 `box-shadow` 替换会改变行为/阴影观感，**用户视觉门控**）
- [x] 不引入 `@layer` 作为第一步。只有在已有 source order 经过浏览器验证、且能够证明 layer 顺序更清晰时，才建立小范围试验。（约束保持：未引入 @layer；source order 经 §1.19 浏览器基线验证）
- [x] 对相邻注释、媒体查询边界和 keyframes 做完整性检查。（花括号/注释/媒体查询/keyframes 平衡随每批门禁通过；原型块删除时核对注释边界，见 §1.12；媒体查询清单见 §1.17）

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
- [x] 建立控件状态表：normal / hover / active / focus-visible / disabled / error / selected。（源码级状态来源表已完成，见 §1.16.1；表中记录的来源为当前事实，是否可合并需浏览器验证，未声称 Phase 3 完成）
- [ ] 先保留各模块的 class 名和 DOM 结构，抽取公共声明，不做 class 重命名。（抽取/合并会改变层叠外观，**用户视觉门控**；控件状态来源表已建，见 §1.16.1）
- [ ] 明确全局 `.btn` 与模块 `.pg-btn`、`.tr-btn` 的职责；不要用更宽的裸 selector 覆盖模块控件。（职责对照需逐控件视觉验证，**用户视觉门控**）
- [ ] 统一高度、padding、radius、font-weight、transition 和 focus ring 的 Token 来源。（radius 已统一 10 行，见 §1.14/§1.15.1；高度/padding/font-weight/transition/focus ring 统一会改变外观，**用户视觉门控**）
- [ ] 检查按钮文字在中英文、`data-font-size` S/M/L 和 mobile 下是否溢出。（需端点字体/语言/窄屏视觉测试，**用户视觉任务**）
- [x] 检查 checkbox/radio/Toggle slider 不被通用 `input` 规则覆盖。（源码已核验：`.form-group input`/`.detail-block input` 均显式 `:not([type="checkbox"]):not([type="radio"])` 排除，style.css L1253/L1256；`.toggle-switch input[type="checkbox"]` 有独立 `appearance:none` 定制（L1751+）；toggle 焦点走全局 input:focus-visible 环，§1.17 无缺口）
- [ ] 检查 modal 的 z-index、滚动、焦点锁和关闭按钮样式，不修改 JS 焦点逻辑。（部分实测：overlay z-index 50=--z-modal、modal-body overflow-y:auto、无页面容器裁切，见 §1.19.7；**JS 焦点锁与关闭按钮样式未覆盖，需端点键盘测试，用户视觉任务**）

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


1. Playground shell、input bar、messages、reasoning、sources；
2. Image Canvas、Inspire、Batch；
3. Custom body、SSE/debug、ComfyUI 相关面板；
4. mode selector、multi-window、group chat；
5. Gallery/Editor/Text Review；
6. Log Reader；
7. shared Playground responsive 和 reduced-motion rules。

### 工作项

- [x] 为每个区块标记依赖的 DOM/JS 模块和允许覆盖的 Token。（模块级依赖/归属标记已完成，见 §1.16.2 归属表 + §1.12 命名空间计数 + §1.20.1 模块内 B/C 色归类；更细的区块级标注并入 Phase 6 拆分设计，**有意延后**（条件不满足，见 §1.18））
- [ ] 识别跨页面共用规则，放回 shared primitives，不复制到页面区块。（移动规则改变 source order 与加载，**用户视觉门控**；共享控件归属已在 §1.16.1 标注）
- [x] 识别只属于 Playground 的全局布局规则，保留在 `playground.css` 并记录其为何需要覆盖 `html/body/.app`。（已识别并记录：`html,body,.app` 全屏滚动约束为 Playground shell 专属（§1.3 高风险清单、§1.16.2 归属表、§1.19.2 两 shell 加载边界）；`.pg-*`/`.ge-*`/`.ed-*`/`.tr-*` 仅随 Playground shell 交付；未移动任何规则）
- [x] 识别只属于 Editor/Gallery/Log Reader 的样式，确保不会被 no-playground shell 加载。（已核验：默认 shell 仅加载 style.css（§1.6 加载边界、§1.19.2 HTTP 实测 index-nopg 仅 /style.css 200 且 pg 元素缺席）；Editor/Gallery/Log Reader 样式（`.ed-*`/`.ge-*`/`.tr-*`/`.log-*`）全部位于 playground.css，默认 shell 不可能加载）
- [ ] 将动态内联样式中的静态表现迁入对应模块 CSS，但保留运行时 geometry、progress、width、height、transform 等计算值。（分类已完成：静态表现极少且 Token 驱动、运行时几何为主，见 §1.15.2；**迁移需 DOM/状态覆盖验证，用户视觉门控**）

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

- [x] 检查现有媒体查询与 container query 是否重复、互相覆盖或只修正单一页面。（检查已完成：源码清单见 §1.17；desktop 1440 / tablet 768 / mobile 390 三档浏览器实测无横向溢出且断点规则生效，见 §1.19.4；768px×3 与 900px×3 的**合并为用户视觉任务**，不在此勾选内）
- [x] 校验窄屏下 Header 隐藏优先级仍由 `setupHeaderResponsive()` 决定，CSS 不擅自隐藏核心导航。（源码+HTTP 已核验：CSS 窄屏规则仅压缩 `.top-header` gap/padding 与 `#header-stat-grid`（768/480 断点，L3091/L3110），从不隐藏核心导航；导航隐藏为 auth.js `setupHeaderResponsive()` 运行时职责（DESIGN §Header 契约，§1.17）；tablet/mobile 实测 topHeader 完整保留（§1.19.4））
- [ ] 为所有可交互模块检查 `:focus-visible`、键盘顺序、文本裁切和焦点对比度。（源码审计 + 浏览器键盘 Tab 实测见 §1.17/§1.19.5：nav-item 焦点缺口已撤销；**GIF 切片按钮与 3 处仅 border 变色输入未被覆盖，需端点键盘测试，用户视觉任务**）
- [ ] 检查 `prefers-reduced-motion: reduce` 对 CSS animation、transition、GIF/媒体编辑器反馈的影响。（animation/transition 已实测：reduce 下与基准一致、有意不变，见 §1.19.6；**GIF/媒体编辑器反馈为端点视觉任务**）
- [ ] 检查 `touch-action`、拖拽滑块、时间线、滚动容器和最小触摸尺寸。（需端点交互测试，**用户视觉任务**；`touch-action` 3 处源码位置见 §1.17）
- [ ] 检查 `overflow:hidden` 是否截断 tooltip、dropdown、modal 或错误信息。（modal 与 Download 页 dropdown 已实测无裁切、菜单在视口内，见 §1.19.7；**tooltip/错误信息为端点视觉任务**）
- [ ] 检查 L/M 字体尺寸、中文/英文长文本和语言切换后的布局。（需端点字体/语言/窄屏视觉测试，**用户视觉任务**）

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

> **2026-08-07 审计结论（§1.18）：** 条件 2（source order 无测试）与 5（拆分方案未设计）不满足，**Phase 6 不进入**；条件 1 部分满足（§1.16.2 归属表，Gallery 为唯一收敛点）、3 满足（§1.6）、4 部分满足（manifest 机制存在但拆分方案未起草）、**6 已满足**（§1.19 真实 HTTP + headless Chromium 验证两 shell 与主题矩阵）。重新评估前置：补 source-order 稳定记录 → 收敛 Gallery 归属 → 起草拆分方案。

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

- [ ] 先统计重复的 `style` 片段，按组件合并，不逐行机械替换。（统计与分类已完成：§1.10 命中统计 + §1.15.2 静态/动态分类（静态表现极少且 Token 驱动）；**按组件合并为 JS/DOM 契约变更，用户视觉门控**）
- [ ] 为动态 UI 增加稳定 class 和状态 class，保持 JS API 与 DOM ID 不变。（改 JS 生成结构，需 DOM/状态覆盖验证，**用户视觉门控**）
- [ ] 对 `style.cssText` 拆成"静态 class + 必要动态属性"。（cssText 仅 3 处命中（§1.10），拆分会改 JS 行为，**用户视觉门控**）
- [ ] 对 HTML 字符串中的 inline style 迁移后，检查 escape、翻译文字和条件分支。（HTML 字符串 inline style 静态 163 处（§1.15.2），迁移涉及 escape/翻译/分支，**用户视觉门控**）
- [ ] 任何迁移都必须覆盖初始、成功、失败、空状态和关闭/清理状态。（迁移动作本身未开始（§1.15.2 结论：不做迁移），执行时按此契约覆盖各状态）

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
