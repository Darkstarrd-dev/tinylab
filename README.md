[中文](README.md) | [English](README_EN.md)

# TinyRouter V2.0.0

TinyRouter 是一个极轻量级的本地端 AI 工具箱与 API 代理引擎。它以单二进制交付（解压即用、零外部依赖、极低内存占用），在提供 OpenAI ChatCompletions、Responses、Anthropic 协议兼容代理与多 Key 轮询功能的同时，方便手中有多 Key、多公益站的用户无需部署庞大的项目。通过模型组合（Combo）与快速切换（QuickSlot）设计，用户可以轻松在多个模型间实时切换，而客户端使用端仅需配置几个对应的快速切换模型 ID 即可。

同时，TinyRouter 深度集成了多模式的 Playground（支持 AI 联网检索、图像生成、流式对话、一对多模型测试、多模型自动碰撞群聊）、提供详细的请求记录与 Debug 审计、整合音视频下载器（yt-dlp）、多媒体画廊（图片/漫画浏览器与视频播放器）以及交互终端与系统实时监控等功能。

---

## 核心功能概览

### 1. 🔀 API Router & Provider Rotation (API 代理与轮询引擎)
- **多 Key 轮询与退避**：支持 `fill-first`（按优先级填充）与 `round-robin`（粘性轮询）策略，提供指数退避冷却、429 日配额自动锁定与 per-model 独立锁机制。
- **Provider 管理**：支持动态增删改 Provider、密钥批量导入、连通性测试与独立模型映射。
- **协议兼容与前缀路由**：OpenAI Chat / Responses / Anthropic / NVIDIA NIM 原生兼容，支持带前缀自动路由解析（如 `ms/deepseek-chat`）。

### 2. 📊 Usage (实时请求统计与用量监控)
- **核心 Metrics 仪表盘**：实时展示 Total Requests (总请求数)、Success Rate (成功率)、Avg Latency (平均延迟) 与 Token 用量（Input / Output / Total）。
- **Top Models 请求趋势图 (Request Trends)**：提供最近 4 小时 (16 个 15 分钟时间桶) 的各模型请求分布趋势折线/柱状图。
- **Quota & Rate Limit 监控**：实时监控处于 429 锁定或退避冷却中的 Key / Provider / Model，显示精确到秒的退避倒计时与 CST 00:05 配额解锁状态。
- **Recent Requests 深度审计**：流式推送最近请求记录（状态、Provider、模型别名 Alias、延迟/TTFT 首包耗时、Token 消耗）。点击状态点可唤起 **Request Detail 弹窗**，审计原始 Request Payload、Headers、Response 状态、回复内容以及 AI 思考过程 (Reasoning / Thought Process)。
- **本地缓存**：自动在本地 `localStorage` 保持最近 200 条请求记录，刷新页面数据不丢失。

### 3. 🧪 Playground (AI 多模型混合引擎)
- **Normal 模式**：支持 1~4 窗口自由分割，对多个模型并行发起对话，对比回复延迟、生成速度与 Token 用量。
- **Search 模式**：AI 联网检索合成模式。自动意图提取 → 调用 AnySearch 检索 → 左屏展示策略与 Raw 抓取结果、右屏流式合成 Synthesized 回复，并支持 Markdown 结构自动修复与删除单条 Search 历史。
- **Image 模式**：AI 图像生成与创作控制台，支持画质比例预设管理与多尺寸切换。
- **Auto (AutoChat) 模式**：多模型自动群聊与碰撞测试。设定角色与主题后，多个 AI 自动在多窗口间轮流对话与辩论。

### 4. ⬇️ Stream Video Download Manager (音视频下载管理器)
- 基于 `yt-dlp` 与 `ffmpeg` 驱动，支持单链接解析与播放列表批量下载。
- 支持最高画质选择、仅提取音频、并发分片下载、代理设置、缩略图预览与任务队列生命周期管理。
- 下载完成的视频可以直接在Gallery中打开播放

### 5. 🖼️ Gallery (Image Viewer & Video Player 多媒体画廊)
- **图片与漫画浏览器**：支持单图/多图拖拽与粘贴、本地文件夹及多层 Zip 压缩包秒解解析，采用自然段排序（Natural Segment Path Order）。
- **视频播放器**：支持状态感知连贯播放（State-Aware Continuity）与视频预览。
- **分屏与多模式**：支持独立 Sub-Panel 左图右视频双屏 (`D`)、全屏黄金比例自适应排布 (`F`)、媒体模式切换 (`M`) 与直属计数目录树 (`T`)。
- **极简加载**：支持从文件管理器拖入或者直接复制黏贴到Gallery中，会自动分流图片和视频到各自的列表里

### 6. 💻 Terminal & Monitor (交互终端与系统监控)
- **Monitor**：实时流式运行白名单监控命令（如 `nvidia-smi -l 1`），结果内嵌于控制台。
- **Terminal**：Debug 模式下提供完整 PTY 交互式终端（xterm.js + WebSocket + ConPTY/PTY），支持 vim、Ctrl+C 与 Tab 自动补全。

---

## 详细功能指南与快捷键

## 详细功能指南与快捷键

TinyRouter 提供了丰富的键盘快捷键支持，其中全局、Playground 及 Gallery 的核心快捷键均支持在 **Settings → Shortcut Settings** 页面中进行**自定义重新绑定**（预设存储于内存，仅覆盖项写入 `config.yaml`）。

### 1. 页面全局导航与系统快捷键 (*支持自定义*)

| 快捷键 | 默认绑定位 | 功能说明 |
|---|---|---|
| `F1` | `F1` | 快速切换到 **Usage** (实时统计与用量监控) 页面 |
| `F2` | `F2` | 快速切换到 **Settings** (配置、Provider 与 Combo 管理) 页面 |
| `F3` | `F3` | 快速切换到 **Console** (日志、Monitor 与 Terminal) 页面 |
| `F4` | `F4` | 快速切换到 **Playground** (多模型对话与 AI 测试) 页面 |
| `F5` | `F5` | 快速切换到 **Download** (视频/音频下载管理器) 页面 |
| `F6` | `F6` | 快速切换到 **Gallery** (图片/漫画/视频画廊) 页面 |
| `1` ~ `9` | `1` ~ `9` | 唤起 QuickSlot #1 ~ #9 模型选择悬浮弹窗并循环切槽 |
| `f` | `f` | 切换网页全屏 / 全屏视图模式 |
| `Escape` | `Escape` | 安全关闭 TinyRouter 服务进程 (仅在无弹窗时触发) |

---

### 2. Playground 专属快捷键与模式操作

| 快捷键 | 默认绑定位 / 类型 | 功能说明 |
|---|---|---|
| `Enter` | `Enter` (*可自定义*) | 单模型对话主输入框发送消息 (`!Shift` 换行) |
| `Ctrl+Enter` | `Ctrl+Enter` (*可自定义*) | 保存并应用已修改的历史对话消息 |
| `Escape` | `Escape` (*可自定义*) | 取消历史消息编辑状态 |
| `Enter` | `Enter` (*可自定义*) | 多模型自动群聊输入框发送消息 |
| `Alt + ~` | 模式快捷键 | **聚焦输入框**：快速将光标聚焦到底部的 Prompt 输入文本框 |
| `Alt + 1` ~ `4` | 模式快捷键 | **切换模式**：`1`-Normal (多模型对话), `2`-Search (联网检索), `3`-Image (生图), `4`-Auto (群聊碰撞) |
| `Alt + C` | 模式快捷键 | **清空聊天**：一键清空当前模式下的会话历史记录 (`Clear Chat`) |
| `Ctrl + 1` ~ `4` | 模式快捷键 | **切换屏数**：一键切换 Playground 显示 1 ~ 4 个分屏窗口屏数 |
| `Shift + 1` ~ `4` | 模式快捷键 | **切换焦点**：快速将活动编辑焦点切换到第 1 ~ 4 窗口（打字时自动放行） |

---

### 3. Gallery (画廊 & 视频播放器) 快捷键

| 快捷键 | 默认绑定位 / 类型 | 功能说明 |
|---|---|---|
| `d` | `d` (*可自定义*) | **切换视图**：切换单屏 (Single View) / 左图右视频双屏 (Dual View) |
| `m` | `m` (*可自定义*) | **切换媒体模式**：切换图片模式 (Picture Mode) / 视频模式 (Video Mode) |
| `Tab` | `Tab` (*可自定义*) | **切换焦点**：双屏对比时在左/右焦点侧之间切换 Focus |
| `←` / `→` | `ArrowLeft` / `Right` (*可自定义*) | 切换上张 / 下张图片（同义键: `PageUp` / `PageDown` / `Space`） |
| `↑` / `↓` | `ArrowUp` / `Down` (*可自定义*) | 切换上一个 / 下一个文件夹或子目录 |
| `a` | `a` (*可自定义*) | **自动播放**：开启/关闭图片/视频自动播放 |
| `f` | `f` (*可自定义*) | **全屏模式**：切换网页全屏 / 原生全屏 |
| `t` | `t` (*可自定义*) | **目录树面板**：展开/收起直属计数层级目录树 |
| `c` | `c` (*可自定义*) | **清空筛选**：清空侧边目录树的当前选中筛选条件 |
| `Escape` | `Escape` (*可自定义*) | **退出全屏**：退出全屏视图模式（同义键: `Enter`） |
| `Delete` | 页面管理 | 标记当前项为待删除 / 审核模式下 Toggle 勾选 |
| `Shift + Delete` | 页面管理 | 弹出确认框：一键彻底删除整个 ZIP 归档包 |
| `Ctrl + Delete` | 页面管理 | 弹出确认框：一键彻底删除当前单张图片文件 |
| `1` ~ `9` | 视频播放激活 | 快速设置音量 (11%~99%) / 自动播放模式下设置切换间隔 (1s~9s) |
| `←` / `→` | 视频播放激活 | 快退 / 快进视频 (全屏模式 5 秒 / 普通页面 10 秒) |
| `↑` / `↓` | 视频播放激活 | 音量 +/- 10% (全屏) 或 切换上一个/下一个视频 (普通页面) |
| `Space` | 视频播放激活 | 播放 / 暂停视频 |

---

### 4. 弹出页面（Modal）与弹窗交互快捷键

- **QuickSlot 悬浮选择弹窗**：
  - `1` ~ `9`：移动高亮焦点至对应序号模型（并重启 1 秒自动关闭计时器）；
  - `↑` / `↓`：上下移动高亮焦点（取消自动关闭）；
  - `+` 或 `=`：直接打开模型导入搜索弹窗；
  - `Enter`：确认选中焦点模型并设为 Active；
  - `Delete`：从槽位中移除焦点模型；`Escape` 或 右键点击背景：关闭悬浮弹窗。
- **QuickSlot 模型导入搜索弹窗**：
  - `↑` / `↓`：模型列表中逐项移动高亮焦点；
  - `PageUp` / `PageDown` / `Home` / `End`：模型列表按页翻页或跳转至首尾项；
  - `Space`：勾选 / 取消勾选当前高亮模型；`Enter`：确认导入所有选中模型；
  - `Tab` / `Shift+Tab`：在搜索框、全选、反选、关闭、添加按钮与列表之间循环焦点。
- **全局通用 Modal / 弹窗**：
  - `Escape`：关闭当前最顶层 Modal 弹窗（如设置/代理/端口/下载日志/密码等）；
  - `Tab` / `Shift+Tab`：弹窗内焦点陷阱 (Focus Trap) 循环捕获；
  - `←` / `→` / `↑` / `↓`：在弹窗底部按钮组之间切换高亮焦点；
  - `Enter`：触发当前高亮按钮的点击事件（无高亮时触发 `.btn-primary` 确认按钮）。

---

### Quick Slot (快速模型槽) 指南

---

### Stream Video Download 外部依赖说明

Download 功能依赖 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 抓取与 [ffmpeg](https://ffmpeg.org/) 音视频转码工具：
1. **yt-dlp**：下载 `yt-dlp.exe` 或 `yt-dlp` 二进制放至系统 `PATH` 或在 `Settings → Download Settings` 中指定路径。
2. **ffmpeg**：下载 `ffmpeg` 可执行文件放至系统 `PATH` 或在设置中指定路径。

---

## 基本配置与客户端调用指南

在任意 OpenAI 兼容客户端（如 NextChat、Cherry Studio、ChatBox、Cursor、VS Code Continue、Claude Dev / Cline 等）中，只需配置 TinyRouter 的本地服务入口：

- **API Base URL / Endpoint**：`http://localhost:8080/v1` （端口见 Settings 页面，默认 `8080`）
- **API Key**：填入任意字符串即可（如 `sk-local`；若在 Settings 中启用了本地密码保护，请填入您设置的密码）。
- **AI First**: 不会设置的可以直接委派AI代为设置，因为各个软件的要求各自有些区别，可以直接贴各个软件的仓库地址，然后告诉AI TinyRouter的端点，因为是兼容+透传，AI会自动帮你搞定一切的
- **OpenCode示例**
```opencode.jsonc
  "provider": {
    "TinyRouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "TinyRouter",
      "options": {
        "baseURL": "http://localhost:20102/v1", //你设定的端口
        "apiKey": "any", //随意
      },
      "models": {
        "01-Plan": { //OpenCode内部使用的字段，比如用来设置某个Agent使用什么使用这个
          "id": "Plan", //向服务器端请求的名字，对应你在TinyRouter里指定的名称
          "name": "01-Plan", //OpenCode里面显示的名字
          "attachment": false, //是否支持附件
          "reasoning": true, //是否支持推理
          "tool_call": true, //是否支持工具调用
          "structured_output": true, //是否支持结构化输出
          "temperature": true, //是否支持传递温度参数
          "release_date": "2026-06-13",
          "last_updated": "2026-06-13",
          "limit": { "context": 1000000, "output": 131072 }, //上下文大小、最大输出token
          "modalities": { "input": ["text"], "output": ["text"] }, //支持的输入、输出
          "variants": {
            "high": { "reasoningEffort": "high" },
            "max": { "reasoningEffort": "max" },
          }, //思考映射，需要服务器端支持
          "cost": {
            "input": 1.4, //输入价格
            "output": 4.4, //输出价格
            "cache": {
              "read": 0.26, //缓存读取价格
              "write": 0, //缓存写入价格
            },    
          },
        },
}
```

### 3 种模型名称 (Model) 调用方式：

#### 1. 调用 Quick Slot (快捷切换槽)
- **模型名称格式**：可以自定义为任何名称，比如`Planner`、`Scout` ... `Builder`（或简写数字 `1`, `2` ... `9`）。
- **优势**：客户端配置固定为 `Scout` 后，您只需在 TinyRouter 界面或按数字键切槽，即可**实时、无缝地更换客户端背后的实际物理模型/Combo**，客户端无需修改任何设置！

#### 2. 调用 Combo (模型组合)
- **模型名称格式**：填入 Combo 的名称（如 `DeekSeekV4Flash` 或 `GLM-5.2`）, 可以聚合OpenCode、Nvidai、ModelScope、SenseNova等塞博活佛提供的免费模型。
- **优势**：触发 Combo 内的多模型自动调度逻辑（如故障备用转移 `fallback`、免费优先 `greedy-squirrel`），由 TinyRouter 自动完成上游节点选择与重试。

#### 3. 直接调用特定 Provider 的模型
- **带前缀形式**：不需要用户自己填写，在provider的详情卡里可以直接点击模型ID，复制到剪贴板里，直接黏贴即可


## 社区支持

- 特别感谢[LinuxDO](https://linux.do)社区佬友们的支持
