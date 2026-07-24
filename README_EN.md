[Chinese](README.md) | [English](README_EN.md)

# TinyRouter V2.0.0

TinyRouter is an extremely lightweight local AI toolkit and API proxy engine. Delivered as a single binary (zero external dependencies, zero installation, ultra-low memory footprint), it provides OpenAI ChatCompletions, Responses, and Anthropic protocol-compatible proxies with multi-Key rotation. It allows users with multiple API keys or free community providers to easily manage endpoints without deploying heavy server stacks. With Model Combos and QuickSlots, users can seamlessly switch models in real time, while clients only need to configure a few corresponding QuickSlot IDs.

Furthermore, TinyRouter deeply integrates a multi-mode Playground (supporting AI web search, image generation, streaming dialogue, 1-to-N model testing, and auto-chat agent battles), detailed request logging with debug auditing, a stream video/audio download manager (yt-dlp), a multimedia gallery (image/manga viewer and video player), an interactive terminal, and real-time system monitoring.

---

## Feature Overview

### 1. 🔀 API Router & Provider Rotation
- **Multi-Key Rotation & Backoff**: Supports `fill-first` (priority-based) and `round-robin` (sticky limit) strategies with exponential backoff, 429 daily quota locking, and per-model lock mechanisms.
- **Provider Management**: Supports dynamic CRUD operations for Providers, batch key importing, connectivity tests, and independent model mapping.
- **Protocol Compatibility & Prefix Routing**: Native support for OpenAI Chat / Responses, Anthropic, and NVIDIA NIM APIs. Supports prefix-based automatic routing (e.g., `ms/deepseek-chat`).

### 2. 📊 Usage (Real-Time Request Statistics & Monitoring)
- **Core Metrics Dashboard**: Displays Total Requests, Success Rate, Avg Latency, and Token Usage (Input / Output / Total) in real time.
- **Top Models Request Trends**: Provides request distribution trend charts for the last 4 hours (16 fifteen-minute time buckets).
- **Quota & Rate Limit Monitoring**: Monitors locked or cooling-down Keys / Providers / Models in real time, showing countdowns to CST 00:05 quota reset.
- **Recent Requests Deep Audit**: Streamed live request entries (Status, Provider, Model Alias, Latency/TTFT, Token consumption). Clicking the status dot opens the **Request Detail Modal** to audit raw request payloads, headers, response status, content, and AI reasoning/thought processes.
- **Local Persistence**: Automatically caches the last 200 requests in `localStorage`, keeping history intact across page refreshes.

### 3. 🧪 Playground (AI Multi-Model Engine)
- **Normal Mode**: Supports 1–4 split windows to trigger parallel queries across models, comparing latency, generation speed, and token usage side by side.
- **Search Mode**: AI Web Search Synthesis. Auto intent extraction → AnySearch retrieval → Left pane displays strategy & raw search results, right pane streams synthesized answers. Supports Markdown structure repair and individual search history deletion.
- **Image Mode**: AI Image Generation console with resolution ratio presets and multi-size switching.
- **Auto (AutoChat) Mode**: Multi-model automated chat & agent battles. Configurable roles and topics allow models to converse and debate across split windows automatically.

### 4. ⬇️ Stream Video Download Manager
- Powered by `yt-dlp` and `ffmpeg`. Supports single-video parsing and playlist batch downloads.
- Features best-quality selection, audio-only extraction, concurrent multi-part downloading, custom proxies, thumbnail previews, and task queue lifecycle management.
- Completed downloads can be opened and played directly inside the Gallery.

### 5. 🖼️ Gallery (Image Viewer & Video Player)
- **Image & Manga Viewer**: Supports drag-and-drop or clipboard paste of single/multiple images, local folders, and multi-layered Zip archives with Natural Segment Path Order sorting.
- **Video Player**: Features State-Aware Continuity playback and video preview.
- **Split Views & Modes**: Supports dual view (left image, right video `D`), single view, full-screen adaptive layout (`F`), media mode switching (`M`), and a count-badged directory tree (`T`).
- **Minimalist Loading**: Drag files or paste directly into Gallery from file managers; images and videos are automatically sorted into respective lists.

### 6. 💻 Terminal & Monitor
- **Monitor**: Real-time streaming execution of whitelisted commands (e.g., `nvidia-smi -l 1`) embedded directly in the Console page.
- **Terminal**: Full interactive PTY terminal in Debug Mode (xterm.js + WebSocket + ConPTY/PTY) supporting `vim`, `Ctrl+C`, and `Tab` completion.

---

## Detailed Feature Guide & Shortcuts

### Page Navigation Shortcuts

| Shortcut | Description |
|---|---|
| `F1` | Switch to **Usage** (Statistics & Monitoring) page |
| `F2` | Switch to **Settings** (Config, Providers & Combos) page |
| `F3` | Switch to **Console** (Logs, Monitor & Terminal) page |
| `F4` | Switch to **Playground** (Multi-Model AI Testing) page |
| `F5` | Switch to **Download** (Video/Audio Download Manager) page |
| `F6` | Switch to **Gallery** (Image/Manga/Video Viewer) page |

---

### Quick Slot Guide

Quick Slot is a preset "model fast-switching slot" mechanism designed to bind multiple frequently-used models or combos to number keys `1`–`9` for 1-click cycling without opening dropdown menus.

- **Model & Combo Hybrid Binding**: In addition to individual Provider models (e.g., `ms/deepseek-chat` or `gpt-4o`), Quick Slots **fully support adding Model Combos as options**!
- **Key Cycling & Popup Management**: Pressing number keys `1`–`9` displays a popup showing available models for that slot. Repeatedly pressing the key cycles through active models, and stopping closes the window. Models can also be added or removed directly inside the popup.
- **Expose Quick Slots Only (`QuickSlotOnly`)**:
  - Enable `QuickSlotOnly` in Settings so that `/v1/models` returns only models configured in Quick Slots. This keeps model dropdown lists extremely clean in third-party clients (such as Zed, avoiding hundreds of clutter models).

---

### Combo Strategy Guide

Combos allow you to aggregate multiple models from different Providers into a single virtual model name for frontend or client calls. Combos support 3 scheduling strategies:

1. **`fallback` (Failover Order)**:
   - Tries model nodes in configured sequential order.
   - When a preceding model encounters errors, rate limits (429), or cooldowns, TinyRouter automatically falls back to the next model node transparently.
2. **`round-robin` (Load Balancing)**:
   - Rotates requests sequentially among all available model nodes to balance traffic load.
3. **`greedy-squirrel` (Tiered Quota Strategy)**:
   - Reads quota types (`QuotaType`: `unlimited` / `limited` / `paid`) configured on Providers.
   - Automatically prioritizes requests in order: **Unlimited Free → Limited → Paid**. It degrades to paid nodes only when free/limited nodes are exhausted, saving maximum cost.

---

### Playground Shortcuts & Gestures

Playground provides independent state sandboxes and message isolation for each mode with free bi-directional switching:

| Shortcut | Description |
|---|---|
| `Alt + ~` | **Focus Prompt Input**: Quick-focus cursor to the prompt text box |
| `Alt + 1` | Switch to **Normal** Mode |
| `Alt + 2` | Switch to **Search** (AI Web Search & Dual View) Mode |
| `Alt + 3` | Switch to **Image** (AI Image Generation) Mode |
| `Alt + 4` | Switch to **Auto** (Multi-Model AutoChat Battle) Mode |
| `Alt + C` | **Clear Chat**: Clear chat history for current mode |
| `Ctrl + 1`–`4` | **Set Split Count**: Switch Playground to 1–4 split windows (Auto mode min 2) |
| `Shift + 1`–`4` | **Set Active Window**: Switch active focus window to pane 1–4 |

---

### Gallery Shortcuts

| Shortcut | Description |
|---|---|
| `Space` | **Play / Pause**: Toggle video playback |
| `F` | **Fullscreen**: Toggle web / native frameless fullscreen (Right-click to exit) |
| `D` | **Toggle Dual View**: Switch between Single View and Dual View (Left Image, Right Video) |
| `Tab` | **Switch Focus**: Toggle active control focus between left and right panes in Dual View |
| `M` | **Toggle Media Mode**: Switch between Picture Mode and Video Mode |
| `A` | **Autoplay**: Toggle image autoplay (Hover to set 1s–120s interval) |
| `T` | **Directory Tree**: Toggle count-badged directory tree panel |
| `←` / `→` | Prev / Next image (or video rewind / fast-forward 5s) |
| `↑` / `↓` / `PageUp` / `PageDown` | Prev / Next folder or directory |

---

### Stream Video Download Dependencies

Download relies on [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org/):
1. **yt-dlp**: Place `yt-dlp.exe` / `yt-dlp` in system `PATH` or specify its path in `Settings → Download Settings`.
2. **ffmpeg**: Place `ffmpeg` executable in system `PATH` or specify its path in Settings.

---

## Basic Configuration & Client Setup

Configure TinyRouter's local endpoint in any OpenAI-compatible client (such as NextChat, Cherry Studio, ChatBox, Cursor, VS Code Continue, Claude Dev / Cline, Zed, etc.):

- **API Base URL**: `http://localhost:8080/v1` (Default port `8080`, configurable in Settings)
- **API Key**: Enter any string (e.g., `sk-local`; or your custom password if password protection is enabled in Settings).

### 3 Model Calling Conventions:

#### 1. Calling Quick Slots
- **Model Format**: Custom slot names such as `Planner`, `Scout`, `Builder`, or numbers `1`, `2` ... `9`.
- **Advantage**: Once configured to `Scout` in your client, switching slots in TinyRouter's UI or via hotkeys **instantly changes the actual model/combo serving the client in real time** without altering client settings!

#### 2. Calling Combos
- **Model Format**: Enter the Combo name (e.g., `DeepSeekV4Flash` or `GLM-5.2`), aggregating free models provided by OpenCode, NVIDIA, ModelScope, SenseNova, etc.
- **Advantage**: Triggers multi-model scheduling logic (e.g., `fallback` or `greedy-squirrel`), automatically handling node selection and retries.

#### 3. Calling Specific Provider Models
- **Prefixed Format**: Simply click the model ID inside the Provider Card to copy `provider_id/model_id` directly to your clipboard for easy pasting into clients.


## Community

- Speacial thanks to the [LinuxDO](https://linux.do) community for their support
