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

### 页面全局导航

| 快捷键 | 功能说明 |
|---|---|
| `F1` | 快速切换到 **Usage** (实时统计与用量监控) 页面 |
| `F2` | 快速切换到 **Settings** (配置、Provider 与 Combo 管理) 页面 |
| `F3` | 快速切换到 **Console** (日志、Monitor 与 Terminal) 页面 |
| `F4` | 快速切换到 **Playground** (多模型对话与 AI 测试) 页面 |
| `F5` | 快速切换到 **Download** (视频/音频下载管理器) 页面 |
| `F6` | 快速切换到 **Gallery** (图片/漫画/视频画廊) 页面 |

---

### Quick Slot (快速模型槽) 指南

Quick Slot 是预设的“模型快速切换槽”，适合将常用的多个模型或组合绑定到数字键 `1` ~ `9` 上进行一键循环切换，无需每次打开下拉菜单选择。

- **模型与 Combo 混合绑定**：除了支持添加具体的 Provider 模型（如 `ms/deepseek-chat` 或 `gpt-4o`）外，还**完美支持将 Combo 模型组合添加为可选项**！
- **按键循环切换**：按下数字键 `1` ~ `9`，会弹窗显示对应Slot可用的模型，连续按数字键会轮询，停止按键窗口关闭。同时弹窗里可以直接添加、删除已设定的模型
- **只暴露 Quick Slot 模式 (`QuickSlotOnly`)**：
  - 在 Settings 页面可开启 `QuickSlotOnly` 选项。开启后 `/v1/models` 接口仅返回在 Quick Slot 中配置的模型列表，对支持模型下拉菜单的第三方客户端界面极其整洁友好(指Zed，你不会看到几百个模型，仅自己设置的几个QuickSlot模型ID)。

---

### Combo (模型组合) 策略指南

Combo 允许您将多个不同 Provider 的模型聚合为一个虚拟逻辑模型，在前端或第三方客户端中直接调用。Combo 支持 3 种调度策略：

1. **`fallback` (故障转移排序)**：
   - 按配置的模型节点列表顺序尝试调用；
   - 当排在前面的模型遇到错误、超额（429）或进入退避冷却时，TinyRouter 会无缝自动切换到下一个模型节点重试，对客户端完全透明。
2. **`round-robin` (负载均衡轮转)**：
   - 在组合内所有可用的模型节点之间逐请求轮转，平均分散请求流量。
3. **`greedy-squirrel` (贪婪松鼠配额层级策略)**：
   - TinyRouter 会读取 Provider 配置中的额度类型 (`QuotaType`: `unlimited` / `limited` / `paid`)；
   - 自动按照 **免费无限 (`unlimited`) → 限额 (`limited`) → 付费 (`paid`)** 的优先级顺序尝试请求，节点受限后自动降级，最大程度为您节省调用费用。

---

### Playground 专属快捷键与操作手势

Playground 支持每个模式独立的“状态沙盒”与消息隔离，随时自由双向切换：

| 快捷键 | 功能说明 |
|---|---|
| `Alt + ~` | **聚焦输入框**：快速将光标聚焦到底部的 Prompt Input 文本框 |
| `Alt + 1` | 切换到 **Normal** (多模型对话与请求测试) 模式 |
| `Alt + 2` | 切换到 **Search** (AI 联网检索与双屏比对) 模式 |
| `Alt + 3` | 切换到 **Image** (AI 图像生成) 模式 |
| `Alt + 4` | 切换到 **Auto** (多模型自动群聊碰撞) 模式 |
| `Alt + C` | **清空聊天**：清空当前模式下的会话历史记录 (`Clear Chat`) |
| `Ctrl + 1` ~ `4` | **切换窗口数量**：一键切换 Playground 当前显示 1 ~ 4 个窗口屏数 (Auto 模式限定最少 2 窗口) |
| `Shift + 1` ~ `4` | **切换活动焦点窗口**：快速将活动编辑窗口切换到第 1 ~ 4 窗口（输入框打字时自动放行放误触） |

---

### Gallery (画廊 & 视频播放器) 快捷键

| 快捷键 | 功能说明 |
|---|---|
| `Space` | **播放 / 暂停**：播放或暂停当前视频 |
| `F` | **全屏模式**：切换网页全屏 / 原生无边框全屏 (支持鼠标右键一键退出) |
| `D` | **切换视图**：切换单屏 (Single View) / 左图右视频双屏 (Dual View) |
| `Tab` | **切换焦点**：左图右视频双屏 (Dual View)时切换当前操作左侧还是右侧 
| `M` | **切换媒体模式**：切换图片模式 (Picture Mode) / 视频模式 (Video Mode) |
| `A` | **自动播放**：开启/关闭图片自动播放（悬停可调节 1s ~ 120s 间隔） |
| `T` | **目录树面板**：展开/收起压缩包或文件夹的直属计数层级目录树 |
| `←` / `→` | 切换上张 / 下张图片（或视频快退 / 快进 5 秒） |
| `↑` / `↓` / `PageUp` / `PageDown` | 切换上一个 / 下一个文件夹或子目录 |

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
