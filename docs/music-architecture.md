# Music Architecture

> 覆盖：Music 模块（融合 5 家：MusicFree 插件思想、LX/Luxon、Listen1、Azusa/Bilibili、Jamendo/Nuclear + yt-dlp/ffmpeg）。
> 前端 `web/static/music/*.js`（host/player/ui），后端 `internal/api/music/register.go`（library/proxy/download，当前 MVP 已闭环；`transcode`/`playlists`/`file-serve` 为后续），配置 `internal/config/{types,paths}.go`（MusicDir），路由 `internal/api/router.go`（`/api/music`），落盘 `Musics` 目录。
> 融合蓝本：`docs/music-implementation-plan.md`（5 源分工 + 零依赖设计 + 5 约束映射，§8 分阶段：当前至 Stage 2 MVP，Stages 3–5 见下文 §6）。

## 1. 模块定位

- **落位**：`Gallery` 页面下拉的 `Music` 子工具（`GALLERY_TOOLS=['gallery','music']`，`galleryActiveTool` 持久化 `localStorage.galleryActiveTool`），仿 `Utility` 下拉（见 `app.js: GALLERY_TOOLS/updateGalleryNavLabel/renderGalleryWithMenu`）。
- **解耦**：独立 `web/static/music/` 目录（当前 `host.js`+`player.js`+`music.js`；后续 `providers/`），与 `web/playground/static-pg/gallery/*.js`、`web/static/download.js`、`web/playground/*` 零交叉；仅 `app.js/index.html/index-nopg.html/settings_modal` 做最小拼接。
- **存储**：`Settings → Path Settings → Default Music Dir`（`MusicDir`），默认 `{configDir}/Musics`（`internal/config/paths.go::ResolveMusicDir`：空→`Musics`/`{configDir}/Musics`，相对拼 `configDir`，绝对原样；`internal/api/settings/register.go: getSettings` 暴露 `musicDir/configDir`，PATCH presence-aware）。

## 2. 前端架构

### 2.1 host.js — 插件沙箱
- 统一接口 `MusicHost {register, list, get, loadFromSource, search, getMediaSource}`。
- `register(plugin)` 要求 `{id, name, search(keyword,limit)=>Promise<Song[]>, getMediaSource(song|id)=>Promise<{url, quality}>}`。
- `loadFromSource(sourceCode, expectedId)` 以 `new Function('register','fetch',...)` 沙箱求值，返回 `plugin` 并注册（为后续 `MusicFree/LX/Listen1` JS 插件热加载预留）。
- **内置 providers**：
  - `jamendo`（builtin）：`https://api.jamendo.com/v3.0/tracks/?client_id=56d30dc8&format=json&limit&search` → 映射 `Song {id,title,artist,album,duration,url,downloadUrl,cover,source:'jamendo',raw}`，`getMediaSource` 直取 `audio`。
  - `local`：`search` 空、`getMediaSource` 取 `song._objectUrl`（`URL.createObjectURL(File)`）。
- `search(keyword, providerIds, limit)` 并发聚合多 provider 结果（本 MVP `['jamendo']`）。

### 2.2 player.js — `<audio>` 队列
- `MusicPlayer {audio, queue, index, loop, shuffle, _order}`，事件 `track/timeupdate/play/pause/error/ended/loop/shuffle`。
- `setQueue(list, startIndex)` + `_rebuildOrder()`（Fisher-Yates，shuffle 时保持当前曲目在逻辑首位）。
- `playAt(idx)` 经 `MusicHost.getMediaSource(song)` 解析直链 → `audio.src=url` → `audio.play()`；`next/prev/_onEnded/cycleLoop/seek/destroy`。

### 2.3 music.js — MVP 交互
- `renderMusic(container)`：顶部搜索 + Local 文件 + Library 按钮 + Path Settings；左侧 results + Library 列表；右侧 Now Playing（cover/title/artist）+ 播放控制（prev/play/next/shuffle/loop）+ 进度条 + Queue。
- `doSearch()` → `MusicHost.search(kw,['jamendo'],24)` → `renderResults`；行操作 Play/+Queue/↓（下载到 Musics）。
- `addToQueue/playSong/renderQueue` 维护 `queue` 与 `player.setQueue/playAt` 同步，queue 点击切歌、✕ 删除。
- 本地：`input[type=file] accept audio/*` → `URL.createObjectURL` → `Song {_objectUrl,_file,source:'local'}` 入队。
- 下载：`POST /api/music/download {url,filename}` 落盘 Musics → `refreshLibrary()`。
- `GET /api/music/library` 扫 `Musics` 列文件（name/size/mtime/ext/isDir）。
- 生命周期：`cleanupMusic/suspendMusic/resumeMusic` 对称 `galleryToolLifecycle`。

## 3. 后端契约

- `GET  /api/music/library` → `{dir, files:[{name,size,mtime,ext,isDir}]}`（`os.MkdirAll` + `os.ReadDir`，`files` 恒为数组）。
- `POST /api/music/proxy`   `{url}` 或 `?url=` → 透传 `GET url`（校验 `http/https`，`User-Agent: TinyRouter/1.0 Music`，30s 超时，`Access-Control-Allow-Origin:*`，直拷 `Content-Type`）。
- `POST /api/music/download` `{url, filename}` → 校验 → 拉取 → `Musics/filename` 原子写（`filepath.Base` 防穿越、已存在自动 `(1),(2)` 后缀、`tmp`+`Rename`，目录 `MkdirAll`）。
- 挂载：`internal/api/router.go: Routes()` 内 `apiDeps` → `music.NewHandler(apiDeps)` → `r.Route("/api", auth Group, "/music")`（复用 `/api` 的 1 MiB limit + auth），与 `fsbrowse/gallery/filetransfer` 同级。
- CSP：`internal/api/router.go: securityHeaders` 的 `connect-src` 已放行 `https://api.jamendo.com`（前端直连搜索不走 proxy 亦可）。

## 4. 配置

- `internal/config/types.go: Config.MusicDir string`（`yaml/json:"musicDir,omitempty"`）。
- `internal/config/paths.go: ResolveMusicDir(musicDir, configDir string) string`（三段式，见 §1）。
- `web/static/download.js: openPathSettingsModal` 新增 `musicDir:true` 行（placeholder `configDir/Musics`，`fasBrowsePicker` 初始目录 `musicInit`）。
- `web/static/settings/settings_modal.js: openPathModal` 全量 `musicDir:true`。
- `web/static/i18n.js: music/musicDir/musicDirDesc` en+cn。
- `web/static/index.html`/`index-nopg.html` 依次加载 `host.js → player.js → music.js`（顺序敏感，host 在 music 前）。

## 5. 验证

- `go vet ./... && go build -o ./build/tinyrouter-music.exe .`
- `node --check web/static/music/*.js && node --check web/static/app.js`
- 手动：`Settings → Path Settings → Default Music Dir` 改 Musics → 重启 → `Gallery ▾ → Music` → Jamendo 搜 `lofi` 可播 → `↓` 落盘 Musics → `Local` 选本地 `mp3` 可播/入队 → 进度可拖、shuffle/loop 生效 → Library 刷新可见落盘文件。

## 6. 风险与后续

- Jamendo 直链为 `mp3`，浏览器原生支持；非标准格式（`ape/wma`）本地走 `ffmpeg` 转码为后续阶段（`/api/music/transcode`，复用 `download.ffmpegPath`）。
- 国内平台（`Listen1/LX`）与 B站（`Azusa`）provider 为下一阶段：以 `host.loadFromSource(fetch(js))` 热加载注入 `registry`，无需改后端。
- `Library Play` 对已落盘文件的静态服务为后续（当前提示经文件选择器回放），可考虑 `GET /api/music/file?name=` 静态透传。

## 7. 变更维护清单

- 新增/修改 Music 前端：`web/static/music/*.js`（host/player/music）
- 新增/修改 Music 后端：`internal/api/music/register.go`（library/proxy/download）
- 新增/修改 Music 配置：`internal/config/types.go`（MusicDir）、`internal/config/paths.go`（ResolveMusicDir）、`internal/api/settings/register.go`（musicDir）
- 修改路由/CSP：`internal/api/router.go`（musicHandler + `connect-src https://api.jamendo.com`）
- 修改导航/加载：`web/static/app.js`（`GALLERY_TOOLS/renderGalleryWithMenu/galleryToolLifecycle/preserveGalleryState`）、`web/static/index.html`+`index-nopg.html`（`gallery-nav-wrap`、script 顺序）
- 修改路径设置：`web/static/download.js`（`musicDir:true` 行）、`web/static/settings/settings_modal.js`（`musicDir:true`）、`web/static/i18n.js`（`music/musicDir`）
- 文档：`docs/music-implementation-plan.md`（蓝本）、`docs/music-architecture.md`（本文件）、`docs/config-registry-state-architecture.md`（`2026-08-29 Music` 段）、`PROJECT_MAP.md`（`paths.go`/`quick-lookup` Music/path 行）

> **最后核对（2026-08-29，Music MVP Jamendo+Local+Musics 闭环）：** `web/static/music/host.js`（`MusicHost` 沙箱+`jamendo`/`local` 内置 provider + `loadFromSource`+`search/getMediaSource`）、`web/static/music/player.js`（`MusicPlayer<audio>` 队列/随机/循环/进度+`playAt/next/prev/seek/cycleLoop`）、`web/static/music/music.js`（搜索+Local 文件入队+Queue+Now Playing/进度+下载落 Musics+Library + `cleanup/suspend/resume`）、`internal/api/music/register.go`（`GET /api/music/library`、`POST /api/music/proxy` 透传、`POST /api/music/download` 原子落盘 `(1)` 去重）、`internal/api/router.go`（`music.NewHandler` 挂 `r.Route("/music")` 于 `auth Group` 内、`securityHeaders connect-src` 放行 `https://api.jamendo.com`）、`web/static/index.html`/`index-nopg.html`（`host→player→music` 顺序加载，`gallery-nav-wrap` 已在前轮）。详见 `docs/music-implementation-plan.md` §2–§5。
