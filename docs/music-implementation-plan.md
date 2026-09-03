# TinyLab Music 实施蓝本（融合 5 家长板·零依赖·可回溯）

> **定位**：为 TinyLab 添加音乐播放功能，直接复用现有能力、不引新依赖。私用场景，不考虑许可约束。
> **落位**：Gallery 页面下，仿 Utility 的下拉菜单，切换 `Gallery | Music`（`galleryActiveTool`）。
> **存储**：`Settings → Path Settings` 新增 `Default Music Dir`，默认 `TinyLab 运行目录/Musics`，下载音乐/播放列表等落此目录。
> **解耦要求**：音乐模块独立包/前端目录，与 Gallery/Download/Playground 互不侵入；仅在 `app.js/index.html/settings_modal` 做最小路由/菜单拼接。
> **来源追踪**：基于 `anysearch` 对 GitHub 的 5 家开源音乐项目实测得出的融合选型（见 §1），满足 5 约束见 §3。

## 1. 融合选型（5 家各取最长板，可综合借鉴）

| 角色 | GitHub 项目 | Stars/许可 | 借什么 | 解决约束 |
|---|---|---|---|---|
| 底座思想 | `maotoumao/MusicFree`+`MusicFreePlugins`+`MusicFreeDesktop` | ~30k · AGPL-3.0（私用忽略） | **插件化架构**：本体零音源，全靠 `plugins.json` 注册 `{search,getMediaSource,getLyric,importPlaylist}` 插件 JS | #1 零依赖扩展、#3 播放列表可扩展 |
| 国内音源 | `listen1/listen1_chrome_extension` | 12.1k · MIT | 最干净的 `js/provider/*.js`（网易/QQ/酷狗/酷我/咪咕）纯 `fetch` 拿直链 | #2 白嫖直链 |
| 音源生态 | `lyswhut/lx-music-desktop` | 52.9k · Apache-2.0 | `customSource` 单文件 `export {search,musicUrl}`，社区日更反爬，最稳 | #2 下载、#4 本地验证 |
| B站曲库 | `kenmingwang/azusa-player` + `lovegaoshi/NoxPlayer`/`azusa-player-mobile` | 3–5k · AGPLv3 | `bvid→cid→playurl?cid=&bvid=` 取 `durl[0].url`，无限免费，歌单订阅自动更新 | #2 最稳白嫖、#3 歌单 |
| 合法兜底 | `nukeop/nuclear` + `developer.jamendo.com/v3.0` | ~9k · AGPL-3.0/CC | `GET /v3.0/tracks?client_id=...&search=` 返 `audio` 流+`audiodownload`，`mp3` 直链，CC授权 600k+ | #2 合法兜底 |

备胎：`KRTirtho/spotube`(BSD-4, Spotify元数据+YT/Piped)思路同 Nuclear，但需 Spotify token 且 Piped 不稳，不如 Jamendo 稳。

## 2. 总体架构（零依赖）

```
web/static/music/                 # 纯 vanilla JS，复用现有 style.css token
  host.js            # 插件注册+沙箱(host=MusicFree思想重写~80行 new Function)
  player.js          # <audio>封装：队列/随机/循环/进度/歌词
  providers/         # 拷贝 listen1/lx/azusa/jamendo 四类 JS（可 git submodule 同步）
  ui.js              # 播放条+抽屉（Gallery 内嵌）
  music.js           # renderMusic/cleanupMusic 入口（仿 gallery/gallery.js）
web/playground/static-pg/gallery/ # 不动，仅提供挂载容器复用布局
internal/api/music/               # 新包，下述端点
  register.go        # 路由：/api/music/*（走鉴权同 gallery）
  proxy.go           # GET /api/music/proxy?url= 直链 CORS 透传（io.Copy，不引库）
  transcode.go       # POST /api/music/transcode  ffmpeg -i pipe:0 -f mp3 pipe:1
  library.go         # 扫描/列表/落盘：Default Music Dir 的本地库
internal/config/
  types.go           # MusicConfig { MusicDir string; Plugins []PluginRef; Playlists []Playlist } + Playlist/Song
  paths.go           # ResolveMusicDir(musicDir, configDir) string
  defaults.go        # MusicDir=""→{configDir}/Musics；finalizeConfig 透传
docs/music-architecture.md          # 基线文档（与其它 *-architecture.md 同级）
```

后端仅复用已有 `ffmpeg`/`fsutil`原子写/`POST /api/browse`选目录；前端仅 `fetch+<audio>+new Function`沙箱，不引 `howler.js`等。

## 3. 约束映射（5条逐条闭环）

| # | 约束 | 融合后如何满足 |
|---|---|---|
| 1 | 不加依赖 | 前端 vanilla；后端 `net/http+os/exec` 复用 `ffmpeg`（Download 已验） |
| 2 | 在线白嫖+可下载 | 四重冗余：Listen1/LX 国内5源 + Azusa B站 + Jamendo CC + yt-dlp(已有) YouTube；直链 `fetch→blob→a[download]` 或 Go 落盘 `MusicDir` |
| 3 | 播放列表 | 统一 `Playlist{id,name,tracks:Song[]}`：`localStorage + config.yaml:music.playlists` 持久化，支持 `importPlaylist(url)`（B站合集/网易歌单/Jamendo playlist）+ `m3u` 导入 |
| 4 | 本地播放 | `input file accept=audio/*` + `URL.createObjectURL` + `<audio>`；原生 `mp3/mpeg/opus/ogg/oga/wav/aac/flac(m4a)` 已覆盖，其余走 §5 |
| 5 | ffmpeg可转即纳入 | `POST /api/music/transcode`：`ffmpeg -i pipe:0 -c:a libmp3lame -q:a 4 pipe:1`，`wma/ape/flac/alac` 全量覆盖 |

## 4. 解耦边界（与现有模块互不侵入）

- **Gallery**：不改 `gallery-*.js`。新增 `web/static/music/` 独立目录；`app.js` 新增 `GALLERY_TOOLS=['gallery','music']`+`galleryActiveTool`，仿 `UTILITY_TOOLS` 下拉（见 §6）。`cleanupGallery` 仅在切出 `gallery/musics` 时调用；`cleanupMusic` 自清理 `<audio>`/计时器。
- **Utility/Download/Playground**：零耦合；仅复用 `POST /api/browse` 与 `ffmpeg` binary 检测。
- **Settings/Config**：仅增 `MusicDir` 字段与 `MusicConfig`，不改现有 `ImageSaveDir/DocDir/GamesDir` 语义；`settings/register.go` 新增 `musicPatch` 按指针判 presence 合并。
- **Router**：`internal/api/router.go` 新增 `r.Route("/api/music", ...)` 一处挂载，`fsbrowse` 同级。

## 5. 后端契约

- `GET  /api/music/plugins` 列插件；`POST /api/music/plugins/import {url}` 热加载（写 `config.yaml:music.plugins`）
- `GET  /api/music/library?dir=` 扫 `MusicDir` 返回 `{files:[{name,size,mtime,ext}]}`；`POST /api/music/proxy?url=` CORS透传（`Access-Control-Allow-Origin:*`）
- `POST /api/music/transcode` 接收原始字节，管道 ffmpeg 转 `mp3` 返回；失败回 422+stderr
- `POST /api/music/download {url, filename}` 直链落盘到 `MusicDir/filename`，原子写（`fsutil`）
- `GET/PUT /api/music/playlists` 读写 `config.yaml:music.playlists`（与前端 localStorage 双写一致）

## 6. 前端落地（Gallery下拉，仿 Utility）

```js
// app.js 新增（仿 UTILITY_TOOLS）
var GALLERY_TOOLS = [
  { id: 'gallery', labelKey: 'gallery' },
  { id: 'music',   labelKey: 'music' },
];
var galleryActiveTool = 'gallery'; // 持久化 localStorage.galleryActiveTool
function selectGalleryTool(id){ galleryActiveTool=id; updateGalleryNavLabel(); navigateTo(id); }
```

- `web/static/index.html`：`<button data-page="gallery">Gallery</button>` 改为 `gallery-nav-wrap` 下拉（含 `gallery`/`music` 两项），`aria-haspopup/expanded` 同 Utility。
- `web/static/app.js::navigateTo`：`case 'music': return renderMusic(container)` 分流；`case 'gallery'` 保留；`preserveGalleryState` 同 `preserveUtilityState`。
- `web/static/music/music.js`：`renderMusic(container)` 渲染播放器条 + 搜索/提供者切换 + 播放列表抽屉 + 本地文件入口。
- `web/static/music/host.js`：`register/fetch/sandbox/search/getMediaSource` 统一入口。
- `web/static/style.css`：复用既有 token，仅增 `.gallery-menu` 与 `.music-*` 最小样式。

## 7. Settings Path Settings 扩展

- `web/static/settings/settings_modal.js::openPathModal`：`openPathSettingsModal({..., musicDir: true})`
- `internal/config/paths.go::ResolveMusicDir(musicDir, configDir)`：空→`{configDir}/Musics`，相对→`join`，绝对→直用
- `internal/config/types.go::Config.MusicDir string` + `MusicConfig`（若需 playlists/plugins 落盘）
- `internal/api/settings/register.go`：`musicPatch{musicDir *string}` + `applyMusicUpdates`

## 8. 实施顺序（分阶段，每段可独立交付）

1. **本蓝本+骨架**：落 `docs/music-implementation-plan.md`+`MusicDir`配置+Settings Path项+Gallery下拉占位（本轮）
2. **Host+Jamendo最小可播（已完成，MVP）**：`host.js+player.js+<audio>+Jamendo` 打通搜索→播放→下载（`web/static/music/host|player|music.js` + `internal/api/music/register.go: library/proxy/download` + `internal/api/router.go` + `docs/music-architecture.md` 基线，见 `docs/music-architecture.md` §2–§5）
3. **国内音源+B站（已完成）**：接入 `providers/bilibili.js`（Azusa `bvid→cid→playurl` 经 `GET /api/music/bilibili/search` + `POST /api/music/bilibili/resolve`）+ `providers/example-generic.js`（Listen1/LX 热加载模板，`host.loadFromSource/loadFromURL`，`var plugin={id}`/`module.exports` 契约）+ `host.js loadFromURL` + UI `selectedProviders` 多选徽标
4. **本地+ffmpeg（已完成）**：`GET /api/music/file?name=` `ServeContent` + `Accept-Ranges` + `POST /api/music/transcode?format=mp3|opus|ogg|wav`（`ffmpeg pipe:0→pipe:1`，`lookupFFmpeg` 复用 `download.ffmpegPath`/`PATH`，`MaxBytes 200MiB`，`internal/api/music/transcode.go`）+ Library `Play`/`→mp3` 前端闭环
5. **播放列表持久化（已完成）**：`Musics/playlists.json` + `GET/PUT /api/music/playlists` + `POST /api/music/playlists/import {url}` + `GET /api/music/m3u?name=`/`POST /api/music/m3u {name,m3u}`（`#EXTM3U/#EXTINF` + `tmp+Rename` 原子，`internal/api/music/playlists.go`）+ 前端 playlists bar（Create/Save queue→/Load→queue/Export m3u/Import m3u/Fetch URL，`playlistsCache`）

## 9. 验证

- `go vet ./... && go test ./...`（新增 `internal/config` paths 单测、`internal/api/music` 单测）
- `node --check web/static/music/*.js`；`go build -o tinylab .`
- 手动：Settings Path 设置 MusicDir→重启→Gallery下拉切 Music→Jamendo 搜索可播→B站直链可播→本地文件可播→ffmpeg 转码可播→下载落盘到 MusicDir

## 10. 风险与规避

- 国内平台反爬→依赖 LX 社区脚本周更，Host 支持热更插件即可
- CORS→失败回退 `/api/music/proxy`
- ffmpeg 缺失→`transcode` 返回 503，前端提示安装并引导 Settings 指定 ffmpegPath（复用 Download 的 ffmpegPath）
- AGPL 仅私用，忽略；若后续分发则重写 host 不整库拷贝即不传染
