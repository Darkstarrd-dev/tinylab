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

## Detailed Feature Guide & Shortcuts

TinyRouter provides rich keyboard shortcut support. Core shortcuts across Global, Playground, and Gallery can be **customized and rebound** on the **Settings → Shortcut Settings** page (defaults live in memory; only overrides are written to `config.yaml`).

### 1. Page Navigation & System Shortcuts (*Customizable*)

| Shortcut | Default Binding | Description |
|---|---|---|
| `F1` | `F1` | Switch to **Usage** (Real-Time Statistics & Monitoring) page |
| `F2` | `F2` | Switch to **Settings** (Config, Providers & Combos) page |
| `F3` | `F3` | Switch to **Console** (Logs, Monitor & Terminal) page |
| `F4` | `F4` | Switch to **Playground** (Multi-Model AI Testing) page |
| `F5` | `F5` | Switch to **Download** (Video/Audio Download Manager) page |
| `F6` | `F6` | Switch to **Gallery** (Image/Manga/Video Viewer) page |
| `1`–`9` | `1`–`9` | Open & cycle QuickSlot #1–#9 model selector popup |
| `f` | `f` | Toggle web / native fullscreen mode |
| `Escape` | `Escape` | Safely shutdown TinyRouter service (when no modal is open) |

---

### 2. Playground Shortcuts & Modes

| Shortcut | Default / Type | Description |
|---|---|---|
| `Enter` | `Enter` (*Customizable*) | Send message in main prompt input (`!Shift` for newline) |
| `Ctrl+Enter` | `Ctrl+Enter` (*Customizable*) | Save and apply edited message in chat history |
| `Escape` | `Escape` (*Customizable*) | Cancel message edit mode |
| `Enter` | `Enter` (*Customizable*) | Send message in AutoChat input |
| `Alt + ~` | Mode Hotkey | **Focus Input**: Quick-focus cursor to the prompt input box |
| `Alt + 1`–`4` | Mode Hotkey | **Switch Mode**: `1`-Normal, `2`-Search, `3`-Image, `4`-Auto |
| `Alt + C` | Mode Hotkey | **Clear Chat**: Clear conversation history for current mode |
| `Ctrl + 1`–`4` | Mode Hotkey | **Split Count**: Switch Playground to 1–4 split windows |
| `Shift + 1`–`4` | Mode Hotkey | **Set Active Window**: Switch active focus pane to pane 1–4 |

---

### 3. Gallery (Viewer & Player) Shortcuts

| Shortcut | Default / Type | Description |
|---|---|---|
| `d` | `d` (*Customizable*) | **Toggle Dual View**: Switch between Single View and Dual View (Left Image, Right Video) |
| `m` | `m` (*Customizable*) | **Toggle Media Mode**: Switch between Picture Mode and Video Mode |
| `Tab` | `Tab` (*Customizable*) | **Switch Focus**: Toggle active control focus between left and right panes in Dual View |
| `←` / `→` | `ArrowLeft` / `Right` (*Customizable*) | Prev / Next item (Synonyms: `PageUp` / `PageDown` / `Space`) |
| `↑` / `↓` | `ArrowUp` / `Down` (*Customizable*) | Prev / Next folder or directory |
| `a` | `a` (*Customizable*) | **Autoplay**: Toggle image/video autoplay |
| `f` | `f` (*Customizable*) | **Fullscreen**: Toggle web / native fullscreen |
| `t` | `t` (*Customizable*) | **Directory Tree**: Toggle count-badged directory tree panel |
| `c` | `c` (*Customizable*) | **Clear Filter**: Clear active tree selection filter |
| `Escape` | `Escape` (*Customizable*) | **Exit Fullscreen**: Exit fullscreen view (Synonym: `Enter`) |
| `Delete` | Item Management | Mark current item for deletion / Toggle check in review mode |
| `Shift + Delete` | Item Management | Prompt modal to delete entire ZIP archive from disk |
| `Ctrl + Delete` | Item Management | Prompt modal to delete current single image item from disk |
| `1`–`9` | Video Active | Set playback volume (11%–99%) / Set autoplay interval (1s–9s) |
| `←` / `→` | Video Active | Rewind / Fast-forward video (Fullscreen: 5s / Normal: 10s) |
| `↑` / `↓` | Video Active | Volume +/- 10% (Fullscreen) or Prev / Next video (Normal page) |
| `Space` | Video Active | Play / Pause video |

---

### 4. Modal & Popup Interaction Shortcuts

- **QuickSlot Selection Popup**:
  - `1`–`9`: Move focus to model index (resets 1s auto-close timer);
  - `↑` / `↓`: Move focus up/down (cancels auto-close);
  - `+` or `=`: Open model import selector modal;
  - `Enter`: Confirm and set focused model active;
  - `Delete`: Remove focused model from slot; `Escape` or Right-click background: Close popup.
- **QuickSlot Model Import Modal**:
  - `↑` / `↓`: Move focus item by item in model list;
  - `PageUp` / `PageDown` / `Home` / `End`: Page scroll or jump to top/bottom;
  - `Space`: Check / uncheck highlighted model; `Enter`: Confirm import;
  - `Tab` / `Shift+Tab`: Focus trap loop across search filter, select all, deselect all, close, add buttons and list.
- **Global Modals**:
  - `Escape`: Dismiss top modal (Settings, Proxy, Port, Logs, Password, etc.);
  - `Tab` / `Shift+Tab`: Modal Focus Trap loop;
  - `←` / `→` / `↑` / `↓`: Navigate focus across modal footer buttons;
  - `Enter`: Click focused button (or trigger `.btn-primary` if no button focused).

---

### Quick Slot Guide

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
