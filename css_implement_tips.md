# CSS 样式移植实施经验与检查清单

> 本文总结 TinyRouter 本轮 Header 页面切换控件移植的经验。目标不是复刻某一段 Uiverse CSS，而是把外部视觉参考安全地转换成符合 TinyRouter 现有 shell、主题系统、交互逻辑和嵌入式交付方式的生产样式。
>
> 适用范围：`web/static/index.html`、`web/static/index-nopg.html`、`web/static/style.css`，以及依赖全局 SPA 导航状态的 Header 控件。

## 结论先行

“有完整 HTML/CSS”不等于“可以直接复制”。外部代码只完整描述了它自己的 DOM、层叠环境、状态模型和尺寸假设；移植到 TinyRouter 后，至少还要重新确认：

1. DOM 结构是否仍然成立。
2. 原有 JavaScript 行为是否仍然绑定到新元素。
3. 全局 CSS、主题 Token、响应式规则是否改变了计算结果。
4. 参考图中没有写进代码的空间关系、光照方向、透明度和边缘裁剪是否被还原。
5. CSS 是否已经重新嵌入目标二进制并通过真实 HTTP 页面验证。

本轮反复修改不是“代码不完整”，而是因为移植同时包含了**结构转换、状态转换、视觉重建、主题适配和交付验证**五个不同问题。只解决其中一个，页面仍然可能“能用但不像”。

## 一、为什么完整参考代码仍需要多轮调整

### 1. 参考代码描述的是组件，不是项目上下文

Uiverse 示例默认拥有自己的：

- `.radio-input` 根容器。
- `label + input[type=radio] + span` 的状态结构。
- `:has()` 选择器关系。
- 负 `z-index`、伪元素和层叠上下文。
- 固定正方形尺寸、固定间距和固定文字长度。
- 一个与业务无关的 radio 状态模型。

TinyRouter 的 Header 则是：

- `nav` 内的原生 `button`。
- `data-page` 作为页面身份。
- `app.js` 通过 `active` class 和 `navigateTo()` 管理状态。
- Playground 版和 no-playground 版拥有不同按钮数量。
- Header 旁边还有品牌、QuickSlot、统计卡片和关闭按钮。

因此，直接复制 HTML 会丢失项目行为；直接复制 CSS 会把示例的尺寸、层级和状态假设带进生产 shell。正确做法是保留 TinyRouter 的 DOM 行为契约，只移植视觉语义。

### 2. 参考图包含大量未显式编码的视觉信息

代码通常能告诉我们“有一个渐变”和“有一个阴影”，但不能完整告诉我们参考图中的：

- 菱形究竟位于哪两个按钮之间。
- 5 个业务按钮和第 6 个空槽位如何排列。
- 下方按钮是中间还是右侧。
- 菱形哪一条边朝向当前激活按钮。
- 激活轮廓是否实心、是否等宽、四角是否裁切。
- 文字是“模糊发光”还是“锐利文字 + 外围弱光晕”。
- 亮色和暗色模式下透明度、对比度是否需要不同处理。

本轮从“整体结构接近”继续调整到“Download 位置、两个菱形、单侧照明、轮廓渐变、文字锐度”，正是因为这些关系主要需要结合截图和实际渲染判断，而不是只读 CSS 语法。

### 3. 项目主题系统会改变最终计算值

TinyRouter 不是单一暗色页面。`html` 上的以下属性共同参与样式计算：

- `data-theme`：dark / light。
- `data-theme-variant`：每种模式的 9 个变体。
- `data-theme-style`：default / sharp / soft / compact。
- `data-font-size`：s / m / l。

同一条 CSS 在这些状态下会得到不同的背景、边框、阴影、圆角、字重和间距。外部样式使用固定 `#333`、`#1d1d1d`、`rgba(...)` 时，暗色截图可能接近参考图，但亮色模式会失去对比度，或者破坏既有主题语义。

所以本轮把导航拆成 `--nav-*` Token：frame、cell、active color、text shadow、diamond edge/background 等，状态规则只选择 Token，不重复写一套深色/亮色组件。

### 4. 视觉状态和业务状态不是一回事

参考组件用 radio 的 `:checked` 表示激活；TinyRouter 用 `button[data-page]` 和 `.active` 表示激活。两者不能只替换标签名：

- `app.js` 会在页面切换时更新 `.active`。
- Gallery 按钮还承担 Gallery / Editor 二路切换显示名和 active 联动。
- 快捷键直接调用 `navigateTo()`，不一定触发鼠标 click。
- no-playground shell 没有 Playground、Download、Gallery 按钮。

移植时必须让所有进入页面的路径都得到同样的视觉状态：鼠标点击、快捷键、初始页面、Gallery/Editor 切换、语言切换后的重新渲染。

### 5. CSS 选择器的“可用”不代表视觉结果正确

本轮多次遇到这类问题：

- `::before` 原本属于激活轮廓，后来又需要被导航容器用作菱形。
- 一个伪元素无法同时承担两个独立装饰；两个菱形需要 `::before` 和 `::after`，或者真实占位元素。
- 自动 Grid placement 会把按钮放到第一个可用槽位，无法表达“下方中间 + 右下为空”这种明确布局。
- 统一 `box-shadow` 会让所有边同时发光，但参考图只让朝向激活按钮的一侧受光。
- 大范围 `text-shadow` 会把字形边缘一起扩散，结果是“有 glow 但不锐利”。
- `border: 1px solid accent` 是实心等宽边框，不等于参考图中的透明度/亮度渐变轮廓。

这些都是计算结果问题，需要通过实际渲染和 `getComputedStyle()` 检查，而不是只确认选择器匹配。

### 6. CSS 修改会影响邻近的基础设施规则

`style.css` 同时承载：

- 全局 reset。
- 页面布局。
- Header。
- Modal。
- Download、Gallery、Monitor 等页面样式。
- 响应式规则。
- 主题覆盖层。

大段文本替换 Header 区域时，如果边界不精确，可能误删相邻的 `.main`、utility、动画或 responsive 规则，也可能产生重复 selector 或破坏注释边界。外观可能暂时正常，但其他页面会出现难以关联的回归。

因此，样式移植必须使用小范围、带锚点的修改；每次修改后重新读取相邻区域，确认只有目标规则发生变化。

### 7. 浏览器看到的 CSS 可能不是工作区里的 CSS

TinyRouter 使用 `//go:embed all:static`。修改工作区的 `style.css` 后直接刷新浏览器，服务器仍可能提供旧二进制中嵌入的 CSS。

这会产生非常典型的误判：

- 以为 selector 没生效。
- 继续叠加更高 specificity 的补丁。
- 实际上只是没有重新 `go build`。

每次重要样式变更都必须重新构建目标变体，并通过 HTTP 访问，而不是使用 `file://`。

## 二、本轮移植得到的具体经验

### 1. 先还原空间关系，再处理光效

推荐顺序：

1. 确定 Grid 行列数。
2. 明确每个按钮的 `grid-column` / `grid-row`。
3. 明确空槽位是真实 disabled button 还是纯装饰。
4. 确定菱形相对于列间隙的位置。
5. 确定按钮宽高、行间距、列间距和外框 padding。
6. 最后再调边框、阴影、文字和光照。

如果空间关系不对，任何 glow 都只是在错误布局上增加噪声。本轮最终采用：

- 3 列 × 2 行。
- Monitor / Settings / Playground 在第一行。
- Gallery / Download / 空按钮在第二行。
- 两个菱形位于两个列间隙的行间区域。

### 2. 有多个装饰物时，优先使用显式槽位

只用伪元素表达结构，会很快遇到数量限制。当前导航使用：

- `::before`：第一个菱形。
- `::after`：第二个菱形。
- `.nav-placeholder`：真实的第六个空按钮。
- `.nav-item.active::before`：激活按钮内部轮廓。

如果未来还要增加第三个装饰物，不要继续复用已有伪元素；应增加真实的装饰节点或专门的装饰容器。

### 3. 激活轮廓应与按钮本体分层

推荐把按钮本体和轮廓分成两层：

```css
.nav-item.active {
  border-color: transparent;
  background: var(--nav-cell-active-bg);
}

.nav-item.active::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: /* 多条带透明度渐变的渐变层 */;
}
```

这样可以独立控制：

- 本体背景。
- 轮廓透明度。
- 上下边的亮度渐变。
- 左右边的弱光。
- 圆角裁切。
- 轮廓外部 glow。

避免直接使用 `border: 1px solid var(--accent)`，因为它会产生实心、等宽、没有亮度变化的边框。

### 4. 文字锐度和 glow 必须分开设计

不推荐：

```css
text-shadow: 0 0 20px var(--accent);
```

这会让文字本身一起变糊。更稳定的结构是：

- 文字填充使用高对比度 accent/白色混合色。
- 使用极小的 `-webkit-text-stroke` 修复边缘。
- 使用 `0 1px 0 rgba(0,0,0,...)` 保留立体下沉感。
- 使用 2px 左右的近距离 shadow 保持轮廓。
- 使用 7px 左右的低透明度 accent shadow 产生光晕。
- 避免 15px 以上的强 blur 直接叠在文字上。

本轮最终文字规则的重点不是“更强的光”，而是“锐利字形 + 短距离弱光晕”。

### 5. 菱形照明必须按几何关系单独建模

两个菱形不应共享一个整体 `background` 或整体 accent `box-shadow`。应先列出关系表：

| 激活按钮 | 受光菱形 | 受光边 |
|---|---|---|
| Monitor | 左菱形 | 朝向 Monitor 的边 |
| Settings | 左、右菱形 | 各自朝向 Settings 的边 |
| Playground | 右菱形 | 朝向 Playground 的边 |
| Gallery | 左菱形 | 朝向 Gallery 的边 |
| Download | 左、右菱形 | 各自朝向 Download 的边 |

实现时只改对应伪元素的一条 `border-*-color` 和局部 `inset box-shadow`，其余边保持 `--nav-diamond-edge`。这样不会出现整个菱形整体变色。

## 三、之后进行样式移植的推荐流程

### Phase 0：拆解参考代码

先不要编辑项目文件，把参考代码拆成四类：

1. **结构**：元素层级、真实交互元素、装饰元素。
2. **状态**：checked、active、hover、focus、disabled 的来源。
3. **视觉 Token**：背景、边框、文字、阴影、光晕、圆角、间距。
4. **环境假设**：固定尺寸、父级定位、z-index、字体、浏览器特性、`:has()`、伪元素数量。

输出一张“参考结构 → 项目结构”的映射表，再开始改代码。

### Phase 1：定位 TinyRouter 的真实契约

必须先确认：

- `index.html` 和 `index-nopg.html` 哪些节点相同、哪些不同。
- `app.js` 如何更新 active 状态。
- 是否存在 inline `onclick` 或快捷键调用。
- `style.css` 的全局 reset 和 Header 既有规则。
- 主题属性和 Token 定义位置。
- 是否有 `!important`、inline style 或后加载的 `playground.css` 会覆盖目标规则。
- CSS 是否通过 `embed.FS` 嵌入二进制。

不要把复制来的 HTML 直接当作生产页面；SPA 导航后，`#page-content` 会被重新渲染，复制进去的静态节点可能被清空。

### Phase 2：建立 preview，而不是直接污染生产 CSS

优先使用真实 shell + 临时 preview override：

1. 先构建目标二进制或使用已有 filesystem dev server。
2. 只加载额外的 preview CSS。
3. 在 preview 中确认尺寸、布局、状态、主题和响应式。
4. 确认后再把稳定规则合并到 `style.css`。
5. 删除 preview override，避免产生第二套事实来源。

preview 必须通过 HTTP，不能用 `file://` 模拟，因为 `file://` 不会复现真实脚本、路由、认证、静态资源和 embed 行为。

### Phase 3：先移植结构，再移植效果

按以下顺序合并：

1. DOM 和可访问属性。
2. Grid/Flex 空间关系。
3. 基础 cell 背景、边框、圆角。
4. hover / active / disabled 状态。
5. 文字字重、字号、阴影。
6. 激活轮廓渐变。
7. 局部光照和装饰。
8. dark/light 和 variant Token。
9. responsive 尺寸。

每一步都应能单独截图确认。不要在布局还没稳定时同时修改十种 shadow、gradient 和 opacity。

### Phase 4：把外部固定值转换为项目 Token

优先映射到已有 Token：

| 外部概念 | TinyRouter 方向 |
|---|---|
| page/card surface | `--surface-page` / `--surface-card` |
| normal/strong border | `--border-subtle` / `--border-strong` |
| active accent | `--accent` 或模块专用 `--nav-active-color` |
| radius | `--radius-sm` / `--radius-md` / `--radius-lg` |
| transition | `--transition-fast` / `--transition-normal` |
| structural shadow | `--shadow-card` / `--shadow-card-hover` |
| code/debug surface | `--code-surface` / `--code-text` |

只有当已有 Token 无法表达组件语义时，才增加模块专用 Token。新增 Token 必须同时考虑 dark、light、variant 和 style dimension。

### Phase 5：主题和风格矩阵

至少验证：

- dark/default。
- light/default。
- 一个非默认 dark variant。
- 一个非默认 light variant。
- sharp、soft、compact。
- font-size s、m、l。
- playground shell 和 no-playground shell。
- desktop、tablet、mobile。

不要只在当前截图的暗色默认主题下调到“看起来正确”就结束。

### Phase 6：真实交互验证

逐项点击或触发：

- 每一个页面按钮。
- 快捷键导航。
- Gallery / Editor 二路切换。
- 语言切换后的按钮文字长度变化。
- 主题切换后的 active 颜色和轮廓。
- 键盘 focus / focus-visible。
- disabled 占位不可触发页面导航。

重点检查：交互状态是否由 JS 正确维护，而不是只在首次渲染时正确。

## 四、项目专用验证清单

### 文件和代码

- [ ] 修改前已读取 `PROJECT_MAP.md` §24。
- [ ] `index.html` 和 `index-nopg.html` 都已检查。
- [ ] 所有业务调用方仍使用原有 `data-page`、函数和 class 契约。
- [ ] 新增选择器已命名空间化，或明确属于 Header 全局基础设施。
- [ ] 没有重复 selector、孤立注释、意外删除相邻 utility 规则。
- [ ] 所有自定义 Token 在 dark 和 light 层均有定义或安全继承。
- [ ] 没有未定义的裸 `var(--token)`。
- [ ] 交互元素拥有正确的 `aria-label`、`type`、disabled 和键盘行为。

### 浏览器

- [ ] 通过 HTTP，不使用 `file://`。
- [ ] 构建了准确的目标二进制，确认 embed 已更新。
- [ ] 监听 console error、page error 和 request failure。
- [ ] 检查 `document.documentElement.dataset`。
- [ ] 检查 `getComputedStyle()` 的关键 Token、圆角、尺寸、阴影和伪元素。
- [ ] 点击每个状态并截图，不只检查默认首屏。
- [ ] 检查实际文字锐度，而不是只检查 `text-shadow` 字符串。
- [ ] 检查 active outline 是否有正确的圆角、透明度渐变和边缘裁切。

### 命令

```bash
go build -o <default-smoke>.exe .
go build -tags playground -o <playground-smoke>.exe .
go test ./...
go vet ./...
node --check web/static/app.js
node --check web/static/auth.js
git diff --check
```

验证完成后再删除临时二进制、临时配置、临时目录和 smoke server。

## 五、常见失败模式与修复方向

| 现象 | 常见原因 | 正确修复方向 |
|---|---|---|
| 页面不变 | 修改后未重新 build，CSS 仍在旧 embed 中 | 重新构建目标二进制并重启服务 |
| 按钮能显示但不能导航 | 替换了 DOM 或丢失 `data-page` / 原有 listener | 保留业务节点和 `app.js` 契约，只改变 CSS |
| 5 个按钮自动挤成错误顺序 | Grid 自动 placement | 给每个业务按钮和空槽位明确 grid 坐标 |
| 菱形整体变色 | 对伪元素使用整体背景/阴影 | 只修改朝向激活按钮的 border edge 和 inset shadow |
| 激活文字变糊 | 大范围 text-shadow 或 blur 直接作用于文字 | 锐利填充 + 极小 stroke + 短距离弱 glow |
| 激活轮廓像实心框 | 使用单色 border 或等宽 box-shadow | 使用继承圆角的多层透明度/亮度渐变伪元素 |
| 四角不符合参考图 | 轮廓层没有继承圆角，或 clip-path 与 radius 冲突 | 让轮廓伪元素 `border-radius: inherit`，再按参考图选择裁切方式 |
| 亮色模式对比度失效 | 只定义了 dark fixed colors | 在 light token 层提供明确 surface、text、border、diamond 值 |
| 其他页面突然错位 | 大范围替换误删邻近基础规则 | 使用小范围锚点编辑，重新读取相邻区并跑完整 smoke |
| 预览和生产结果不同 | preview CSS 未合并或生产 CSS 未重新 embed | 确认唯一生产来源，再构建目标二进制 |

## 六、最终原则

1. **先还原项目契约，再还原外观。**
2. **先固定空间关系，再调光影。**
3. **状态由项目 JavaScript 管理，CSS 只表现状态。**
4. **外部固定颜色转换为项目语义 Token。**
5. **文字本体和文字光晕分开处理。**
6. **装饰元素按数量和几何关系建模，不滥用伪元素。**
7. **每次重要修改都通过重新嵌入后的真实 HTTP 页面验证。**
8. **截图是视觉验证，computed style 是结构验证，两者缺一不可。**
9. **一次只改变一个视觉变量，避免在错误布局上叠加补丁。**
10. **文档、代码、构建变体和验证结果必须保持同步。**
