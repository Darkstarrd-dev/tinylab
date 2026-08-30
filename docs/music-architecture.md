# Music Architecture

> 覆盖：Music 模块（融合 5 家：MusicFree 插件思想、LX/Luxon、Listen1、Azusa/Bilibili、Jamendo/Nuclear + yt-dlp/ffmpeg）。
> 前端 `web/static/music/*.js`（`host.js`/`player.js`/`music.js` + `providers/bilibili.js`/`example-generic.js`），后端 `internal/api/music/{register,transcode,playlists}.go`（library/proxy/download + `bilibili/search|resolve` + `transcode`/`file` + `playlists/m3u`），配置 `internal/config/{types,paths}.go`（MusicDir），路由 `internal/api/router.go`（`/api/music`），落盘 `Musics`（`playlists.json` + 音频 + `m3u`）。
> 融合蓝本：`docs/music-implementation-plan.md`（5 源分工 + 零依赖设计 + 5 约束映射，§8 分阶段：至 Stage 5 全量，已闭环）。

## 1. 模块定位

- **落位**：`Gallery` 页面下拉的 `Music` 子工具（`GALLERY_TOOLS=['gallery','music']`，`galleryActiveTool` 持久化 `localStorage.galleryActiveTool`），仿 `Utility` 下拉（见 `app.js: GALLERY_TOOLS/updateGalleryNavLabel/renderGalleryWithMenu`）。
- **解耦**：独立 `web/static/music/` 目录（`host.js`+`player.js`+`music.js` + `providers/bilibili.js`/`example-generic.js` 热加载示范），与 `web/playground/static-pg/gallery/*.js`、`web/static/download.js`、`web/playground/*` 零交叉；仅 `app.js/index.html/index-nopg.html/settings_modal` 做最小拼接。
- **存储**：`Settings → Path Settings → Default Music Dir`（`MusicDir`），默认 `{configDir}/Musics`（`internal/config/paths.go::ResolveMusicDir`：空→`Musics`/`{configDir}/Musics`，相对拼 `configDir`，绝对原样；`internal/api/settings/register.go: getSettings` 暴露 `musicDir/configDir`，PATCH presence-aware）。

## 2. 前端架构

### 2.1 host.js — 插件沙箱
- 统一接口 `MusicHost {register, list, get, loadFromSource, loadFromURL, search, getMediaSource}`。
- `register(plugin)` 要求 `{id, name, search(keyword,limit)=>Promise<Song[]>, getMediaSource(song|id)=>Promise<{url, quality}>}`。
- `loadFromSource(sourceCode, expectedId)` 以 `new Function('register','fetch',...)` 沙箱求值，返回 `plugin` 并注册（`MusicFree/LX/Listen1` JS 插件热加载）；`loadFromURL(url)` 为其 fetch 封装。
- **内置/随船 providers**：
  - `jamendo`（builtin）：`https://api.jamendo.com/v3.0/tracks/?client_id=836523a7&format=json`（`836523a7` 来自 `nukeop/nuclear` 公开 `.env`，`56d30dc8/709fa152` 已实测失效，见 `docs/music-verification-report.md` §2 #1）→ `Song {id,title,artist,album,duration,url,downloadUrl,cover,source:'jamendo',raw}`，`getMediaSource` 直取 `audio`。
  - `bilibili`（`providers/bilibili.js`，Azusa 思想）：`search` → `GET /api/music/bilibili/search?keyword=&limit=`（后端代理 Bilibili 搜索），`getMediaSource` → `POST /api/music/bilibili/resolve {bvid,cid}`（后端 `bvid→cid→playurl durl[0].url/dash.audio`）。
  - `generic`（`providers/example-generic.js`，Listen1/LX 思想示范）：镜像 Jamendo 的可替换模板，演示 `loadFromSource` 热加载契约（`var plugin={id,...}`/`module.exports`）。
  - `local`：`search` 空、`getMediaSource` 取 `song._objectUrl`（`URL.createObjectURL(File)`）。
- `search(keyword, providerIds, limit)` 并发聚合多 provider 结果（UI 以 `selectedProviders` 多选徽标驱动，默认 `['jamendo']`）。

### 2.2 player.js — `<audio>` 队列
- `MusicPlayer {audio, queue, index, loop, shuffle, _order}`，事件 `track/timeupdate/play/pause/error/ended/loop/shuffle`。
- `setQueue(list, startIndex)` + `_rebuildOrder()`（Fisher-Yates，shuffle 时保持当前曲目在逻辑首位）。
- `playAt(idx)` 经 `MusicHost.getMediaSource(song)` 解析直链 → `audio.src=url` → `audio.play()`；`next/prev/_onEnded/cycleLoop/seek/destroy`。

### 2.3 music.js — MVP 交互
- `renderMusic(container)`：顶部搜索 + provider 多选徽标（`renderProviderChips`）+ Local + Library + Path Settings；次级 playlists bar（select/name/Create/Save queue→/Load→queue/Export m3u/Import m3u file/Fetch URL）；左侧 results + Library（音频行 Play/→mp3 转码）；右侧 Now Playing + 控制 + 进度 + Queue。
- `doSearch()` → `MusicHost.search(kw, selectedProviders, 24)` → `renderResults`；行操作 Play/+Queue/↓。
- `addToQueue/playSong/renderQueue` 维护 `queue` 同步；Library：`Play` → `GET /api/music/file?name=` 的 `Song url` 播，`→mp3` → `fetch /api/music/file` → `POST /api/music/transcode?format=mp3` → `blob URL` 入队播；本地 `input[type=file]` → `createObjectURL` 入队。
- 下载落盘 `POST /api/music/download` → `refreshLibrary()`；`GET /api/music/library` 列 Musics。
- 播放列表：`GET/PUT /api/music/playlists`（`Musics/playlists.json` + `tmp+Rename`）、`POST /api/music/playlists/import {url}`（远端 `m3u/json`）、`GET /api/music/m3u?name=` 导出、`POST /api/music/m3u {name,m3u}` 导入（前端 FileReader + URL Fetch）。
- 生命周期 `cleanupMusic/suspendMusic/resumeMusic` 对称 `galleryToolLifecycle`；`refreshPlaylists/bindPlaylistEvents/renderProviderChips`。

## 3. 后端契约

- `GET  /api/music/library` → `{dir, files:[{name,size,mtime,ext,isDir}]}`（`os.MkdirAll` + `os.ReadDir`，`files` 恒为数组）。
- `POST /api/music/proxy`   `{url}` 或 `?url=` → 透传 `GET url`（`User-Agent: TinyRouter/1.0 Music`，对 `*bilivideo.com/*bilibili.com` 加 `Referer: https://www.bilibili.com/` 否则 403，透传 `Range`→`206 Content-Range/Accept-Ranges`，200 MB 限 `io.LimitReader`，`Access-Control-Allow-Origin:*`）。
- `POST /api/music/download` `{url, filename}` → 同 proxy 的 `Referer`/`Range` 语义 → `Musics/filename` 原子写（`filepath.Base` 防穿越、`(1),(2)` 递增、`tmp+Rename`）。
- `GET  /api/music/bilibili/search?keyword=&limit=` → 优先 `search/type`，`-412/HTML` 时降级 `search/all/v2` 抽 `result_type=video`，映射 `Song {id/bvid,cid,title,artist,cover,duration,source:'bilibili'}`（见 `docs/music-verification-report.md` §2 #2）。
- `POST /api/music/bilibili/resolve {bvid,cid?,id?}` → 若缺 `cid` 则 `GET /x/web-interface/view?bvid=` 解析 `cid`，再 `GET /x/player/playurl?bvid=&cid=&fnval=16` 取 `durl[0].url`/`dash.audio.baseUrl` → `{url,bvid,cid}`。
- `GET  /api/music/file?name=` → `Musics/name` 的 `http.ServeContent`（`Content-Type` 按 `ext` + `Accept-Ranges: bytes`，`filepath.Base` 防穿越）。
- `POST /api/music/transcode?format=mp3|opus|ogg|wav` body 为原始音频字节（`200 MiB`，**在 `internal/api/router.go` 豁免全局 1 MiB `MaxBytesReader`**，见 `docs/music-verification-report.md` §2 #5）→ `lookupFFmpeg` → `runFFmpegTranscode pipe:0→pipe:1`，503/422 语义。
- 播放列表（`internal/api/music/playlists.go`，`Musics/playlists.json`，`tmp+Rename` 原子）：`GET /api/music/playlists` → `{playlists}`（不存在则 `[]`）；`PUT /api/music/playlists {playlists}` 覆盖；`POST /api/music/playlists/import {url,name?}` 远端取 `m3u/json` → `{name,tracks}`；`GET /api/music/m3u?name=` 导出 `#EXTM3U`（`Content-Disposition: attachment`）；`POST /api/music/m3u {name,m3u}` 导入（`#EXTINF` 解析，存在则按名替换否则追加）。
- 挂载：`internal/api/router.go: Routes()` 内 `apiDeps` → `music.NewHandler(apiDeps)` → `r.Route("/api", auth Group, "/music")`（复用 `/api` 的 1 MiB limit + auth），与 `fsbrowse/gallery/filetransfer` 同级。
- CSP：`internal/api/router.go: securityHeaders` 的 `connect-src` 已放行 `https://api.jamendo.com https://api.bilibili.com`（前端直连 Jamendo/Bilibili 搜索可用，B站解析经后端则无跨域顾虑）。

## 4. 配置

- `internal/config/types.go: Config.MusicDir string`（`yaml/json:"musicDir,omitempty"`）。
- `internal/config/paths.go: ResolveMusicDir(musicDir, configDir string) string`（三段式，见 §1）。
- `web/static/download.js: openPathSettingsModal` 新增 `musicDir:true` 行（placeholder `configDir/Musics`，`fasBrowsePicker` 初始目录 `musicInit`）。
- `web/static/settings/settings_modal.js: openPathModal` 全量 `musicDir:true`。
- `web/static/i18n.js: music/musicDir/musicDirDesc` en+cn。
- `web/static/index.html`/`index-nopg.html` 依次加载 `host.js → player.js → music.js`（顺序敏感，host 在 music 前）。

## 5. 验证

- 隔离实例 `Z:/tmp/tr-music` on `20168` 实测（`docs/music-verification-report.md`）：`go vet ./internal/api/music ./internal/api` + `go build -o Z:/tmp/tr-music/tr-music.exe`；`GET /api/music/bilibili/search?keyword=lofi|音乐` + `POST /api/music/bilibili/resolve`→`dash.audio` + `POST /api/music/proxy`（`Range 206`）+ `POST /api/music/download`→`Musics/*.m4s/*.mp3` + `GET /api/music/file` `Range` + `POST /api/music/transcode 5.8 MB mp3→mp3/opus 200` + `playlists/m3u` 全通；前端 `host.js` `836523a7` + `example-generic` 同。
- `node --check web/static/music/*.js web/static/music/providers/*.js && node --check web/static/app.js`
- 手动：`Settings → Path Settings → Default Music Dir` → `Gallery ▾ → Music` → 顶部切 `Jamendo/Bilibili/Generic` 多选搜（`lofi`/关键字）可播 → `↓` 落盘 Musics → `Local` 选本地 `mp3` 入队可播 → Library `Play`/`→mp3`（`ffmpeg`）可用 → 播放列表 Create/Save queue→/Load→queue/Export m3u/Import m3u/Fetch URL 均落 `Musics/playlists.json` → 进度拖拽/shuffle/loop 生效。

## 6. 风险与后续

- 非标准格式（`ape/wma`）经 `POST /api/music/transcode`（复用 `download.ffmpegPath`，`wav/flac` 等原生可播无需转码，仅 `ape/wma` 等兜底）；B站音频 `m4a/mp4` 原生可播，无需转码。
- 国内平台完整接入：以 `host.loadFromSource(fetch(js))`/`loadFromURL` 热加载 `MusicFree/LX/Listen1` JS 插件注入 `registry`，无需改后端（当前 `generic` 为可替换模板）。
- `yt-dlp` YouTube 音源可作为后续冗余（复用 `internal/download`），Jamendo(CC)+Bilibili 已满足私用免费播放。

## 7. 变更维护清单

- 新增/修改 Music 前端：`web/static/music/{host,player,music}.js` + `web/static/music/providers/{bilibili,example-generic}.js`（多源+热加载）
- 新增/修改 Music 后端：`internal/api/music/{register,transcode,playlists}.go`（library/proxy/download + `bilibili/search|resolve` + `transcode`/`file` + `playlists`/`m3u`）
- 新增/修改 Music 配置：`internal/config/types.go`（MusicDir）、`internal/config/paths.go`（ResolveMusicDir）、`internal/api/settings/register.go`（musicDir，`getSettings`/PATCH）
- 修改路由/CSP：`internal/api/router.go`（`music.NewHandler` + `r.Route("/music")` 挂 `auth Group` 内 + `securityHeaders connect-src` 放行 `https://api.jamendo.com https://api.bilibili.com`）
- 修改导航/加载：`web/static/app.js`（`GALLERY_TOOLS/renderGalleryWithMenu/galleryToolLifecycle/preserveGalleryState` + `DEMO_TOOLS` 同批次）、`web/static/index.html`+`index-nopg.html`（`gallery-nav-wrap`/`demo-nav-wrap`、music `host→player→providers→music` 顺序）
- 修改路径设置：`web/static/download.js`（`musicDir:true` 行 预览 `configDir/Musics`）、`web/static/settings/settings_modal.js`（`musicDir:true`）、`web/static/i18n.js`（`music/musicDir/musicDirDesc` en+cn）
- 文档：`docs/music-implementation-plan.md`（蓝本，Stage 2→5 全量）、`docs/music-architecture.md`（本文件，§2–§3 全量）、`docs/config-registry-state-architecture.md`（`2026-08-29 Music MVP→全量` 段）、`PROJECT_MAP.md`（`paths.go`/`quick-lookup` Music/path 行）

> **最后核对（2026-08-30，Music 全量 + 验证修复，见 `docs/music-verification-report.md`）：** `web/static/music/host.js` `JAMENDO_CLIENT 56d30dc8→836523a7` + `web/static/music/providers/example-generic.js` `CLIENT 56d30dc8→836523a7` + `providers/bilibili.js`（Azusa `bvid→cid→playurl`）+ `music.js` 日志串同 + `internal/api/music/register.go`（`bilibili/search` `-412→all/v2` 降级 + `proxy/download` 对 `*bilivideo.com` 加 `Referer` + `proxy 32MB→200MB` + `Range` 透传）+ `internal/api/router.go`（`POST /api/music/transcode` 豁免全局 1 MiB `MaxBytesReader`）+ `docs/music-architecture.md` §2.1/§3/§5 同步 + `docs/music-verification-report.md`（新增，隔离实例 `Z:/tmp/tr-music` on `20168` 全链路 `search/resolve/proxy/download/file/transcode/playlists/m3u` 实测通过）。
