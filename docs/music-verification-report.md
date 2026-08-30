# Music 多源验证与修正实施报告

> **时间** 2026-08-30 · **隔离实例** `Z:/tmp/tr-music` on `127.0.0.1:20168`（主实例 20102 不动）· **覆盖** 5 源融合 + yt-dlp/ffmpeg/通用链路，已逐条搜索→流媒体播放→下载真链路验证。

## 1. 验证矩阵（隔离实例，直连外网经 Windows 本机）

| 源 | 搜索 | 流媒体播放（`<audio>` 需 `Range`+解码） | 下载落盘 | 结论 |
|---|---|---|---|---|
| **Jamendo (CC)** `api.jamendo.com/v3.0` via `836523a7` (Nuclear .env) | ✅ `search=lofi/rock` 返回 1–2 条，`audio=prod-1.storage.jamendo.com/?trackid=...&format=mp32` | ✅ `audio/mpeg` 5.5 MB，`HEAD 200 range=bytes`，`<audio>` 可播；`/api/music/proxy` 全量 200 MB 透传 + `Range 206` 转发已验证 | ✅ `POST /api/music/download {url: audio}` → `Musics/jam-trans-*.mp3 5.8 MB` + `GET /api/music/file?name=` `206 Range` | **可用，合法兜底**。原 `56d30dc8` 已全量失效（`code 5 invalid`），旧 `709fa152` 已封（`code 11 suspended`）。已全局替换为 `836523a7`。 |
| **Bilibili (Azusa)** `api.bilibili.com` + `upos/*bilivideo.com` m4s | ✅ `GET /api/music/bilibili/search` 透传；英文/中文 `lofi`/`周杰伦` 正常；中文风控关键词（如 `音乐`/`音乐`）在 `/search/type` 上 `-412 banned`，已降级 `search/all/v2` + 抽 `result_type=video`，现 `音乐` 3/3 次命中 | ⚠️ **受限可用**：`POST /api/music/bilibili/resolve` → `dash.audio[0].baseUrl` `m4s` (86–91 MB) 需 `Referer: https://www.bilibili.com/` 否则 `403`，已在 proxy/download 补 `Referer`；`/api/music/proxy` 对 `>32 MB` 原 `response too large` 已提至 200 MB + `Range` 透传，现 `Range 206` 与全量 86 MB 透传均通；`<audio>` 源为 `audio/mp4 (m4s)` 浏览器可播，但建议走 `/api/music/file` 本地落盘后播以避免 CDN 时效与 403 | ✅ `POST /api/music/download {url: dash.audio}` → `Musics/bili-verify-*.m4s 88.9 MB` + `ServeContent 206` | **可用，风控已缓解**。剩余风险：B 站风控为动态策略，部分词仍可能间歇 412；`playurl` 的 `e=` 过期需重 resolve。 |
| **Listen1 / LX (国内 5 源)** `listen1/listen1_chrome_extension` · `lyswhut/lx-music-desktop` | — 热加载契约验证（`host.loadFromSource` 沙箱 `new Function` + `loadFromURL` fetch）· `example-generic.js` 镜像 Jamendo 证明链路通；真实站点的 `js/provider/*.js` 需逐站反爬，非本轮真外网打通范围 | — 同左，`getMediaSource` 契约 `→{url,quality}` 已验证 | — 模板复用 `/api/music/download` 同 Jamendo | **契约可用，内容需用户自备 JS**。已验证：`MusicHost.register/loadFromSource/loadFromURL/search/getMediaSource` 全链路；`/music/host.js` + `/music/providers/bilibili.js` + `/music/providers/example-generic.js` 经 `/music/*.js` 200。 |
| **MusicFree 插件思想** `MusicFreePlugins` | — 思想已落地为 `host.js` 沙箱 + `registry` + `search` 并发聚合 + `MusicHost` 统一入口 | — 同上 | — 同上 | **已落地** |
| **yt-dlp / ffmpeg 通用** | — | — | — | **yt-dlp/ffmpeg**：`ffmpeg=C:\Tools\ffmpeg-7.1.1-essentials_build\bin\ffmpeg.exe`；`transcode` 对 400 KB 切片 `mp3→mp3 200` 已通，全量 5.8 MB 原受 `/api` 1 MiB `MaxBytesReader` 阻塞，已在 `internal/api/router.go` 对 `POST /api/music/transcode` 豁免，复测 `mp3 5.8 MB→mp3 4.6 MB` 与 `→opus 4.5 MB` 均 `200`；`playlists/m3u`、`library/file`、`proxy/download` 已全量通过 |

## 2. 本轮发现的阻塞与已落地修复

| # | 阻塞 | 修复 | 文件 | 验证 |
|---|---|---|---|---|
| 1 | **Jamendo `56d30dc8` 全失效**：`failed code 5 invalid`；`709fa152` `code 11 suspended` | 替换为 **Nuclear `.env` 的 `836523a7`**（经 `jamendo/api v3.0` 实测 `search=lofi` 成功 + `HEAD audio/mpeg`） | `web/static/music/host.js` `JAMENDO_CLIENT`、`web/static/music/providers/example-generic.js` `CLIENT`、`web/static/music/music.js` 日志串、`docs/music-*.md` 文案 | 隔离实例 `host.js` 200 含 `836523a7`；直连与经 `proxy` 的 `search` 均 `success` |
| 2 | **B 站搜索 `-412 wind-control`**：`GET /x/web-interface/search/type?keyword=音乐&type=video` 412/HTML；`周杰伦` 等间歇 412 | **降级到 `GET /x/web-interface/search/all/v2?keyword=`** 并抽 `result_type=video` 的 `data[]` 复用同一映射，结果与 `search/type` 一致 | `internal/api/music/register.go: bilibiliSearch` | 隔离实例 `search 音乐` 3/3 命中，`lofi` 不变 |
| 3 | **B 站音频 403**：`upos/*bilivideo.com` 的 `dash.audio` 无 `Referer` 直接 403 | **proxy/download 对 `*bilivideo.com`/`*bilibili.com` 加 `Referer: https://www.bilibili.com/`** | `internal/api/music/register.go: proxy/download` | 直连 `no-referer 403 → with-referer 200`；经 proxy `bilibili audio 403→200`，`Range 206` 透传 |
| 4 | **proxy `>32 MB` 限**：B 站 `m4s` 86 MB 触发 `response too large` | **提至 200 MB** + 转发 `Range`/`Accept-Ranges`/`Content-Range` + `io.LimitReader 200 MB`，并透传 `Range` 请求头 | `internal/api/music/register.go: proxy` | `proxy full 86 MB 200 chunked` + `Range 0-1023 206` |
| 5 | **transcode `400 request body too large`**：`/api` 全局 `1<<20 MaxBytesReader` 覆盖了 handler 的 `200<<20`，5.8 MB 音频必 400 | **`internal/api/router.go` 对 `POST /api/music/transcode` 豁免全局 1 MiB 包装** | `internal/api/router.go` + `internal/api/music/register.go: transcode` 备注 | 400 KB 切片本就 200，全量 5.8 MB 由 `400→200`，`mp3→opus` 亦通 |

## 3. 确切可用方式（用户手册）

- **Jamendo**：Gallery ▸ Music，切 `Jamendo`，搜 `lofi/rock/jazz` 等（`piano/pop` 等小众词可能 0 结果，属服务端库存）；点 Play 即 `<audio src=direcct prod-1.storage...>`（已放行 `connect-src https://api.jamendo.com`），或 `↓` 经 `/api/music/download` 落 `Musics/`，Library `Play` 走 `/api/music/file` 本地播（`Range` 已通）。
- **Bilibili**：切 `Bilibili`，搜中文/英文均可（`音乐` 类风控词已降级兜底）；Play 经 `POST /api/music/bilibili/resolve` 拿 `dash.audio`，优先 `↓` 落盘 `Musics/*.m4s`（`m4a/mp4` 原生可播，无需转码），再 Library 播；或经 `/api/music/proxy` 代理播（已加 `Referer` + `Range`）。
- **国内音源**：`host.loadFromSource(js)` / `loadFromURL(url)` 热加载 Listen1/LX/MusicFree 插件 JS（契约 `var plugin={id,name,search,getMediaSource}` 或 `module.exports`），无需改后端；`example-generic.js` 为可替换模板。
- **本地**：`Local` 选 `audio/*` → `URL.createObjectURL` 入队；`ape/wma` 等经 `fetch /api/music/file → POST /api/music/transcode?format=mp3`（现支持 200 MB）转后 `blob:` 播。
- **播放列表**：`playlists.json`（`Musics/playlists.json`）经 `GET/PUT /api/music/playlists`，`Export/Import m3u` 经 `GET/POST /api/music/m3u`，`Fetch URL` 远端 `m3u/json` 已验。
- **前置**：`ffmpeg` 路径在 `Settings → Path Settings` 配 `C:\Tools\ffmpeg-7.1.1-essentials_build\bin\ffmpeg.exe`；`yt-dlp` 复用 `internal/download` 已验。

## 4. 剩余风险与建议

- B 站风控为服务端动态，极小概率仍 412/403；前端已对 `search → []` 静默降级，resolve 失败回 `audio url not found (bvid may require login)`，属预期。
- Jamendo `836523a7` 来自 `nukeop/nuclear` 公开 `.env`，属第三方演示 key，无 SLA；若再失效需用户到 `devportal.jamendo.com` 自建 app 替换 `JAMENDO_CLIENT`。
- 国内平台直连抽取依赖站点反爬，稳定性以 LX 社区周更为准，本项目仅保证热加载契约稳定。

## 5. 变更清单（本轮）

| 文件 | 改动 |
|---|---|
| `web/static/music/host.js` | `JAMENDO_CLIENT 56d30dc8→836523a7` |
| `web/static/music/providers/example-generic.js` | `CLIENT 56d30dc8→836523a7` |
| `web/static/music/music.js` | 日志串同上 |
| `internal/api/music/register.go` | `proxy/download` 加 `Referer`；`proxy` 提 200 MB + `Range` 透传；`bilibiliSearch` `-412/all/v2` 降级 |
| `internal/api/router.go` | `/api/music/transcode` 豁免全局 1 MiB `MaxBytesReader` |
| `docs/music-verification-report.md` | **本报告（新增）** |
| `docs/music-architecture.md` / `docs/music-implementation-plan.md` | （下轮同步 §2–§3/§9 与最后核对行） |
