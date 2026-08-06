# TinyRouter 归档架构（ArchiveCore）

> **最后核对（2026-08-06 P3 Gallery 迁移落地）：** Gallery **后端桥接 + 前端 sourceId 双路径**已落地——`internal/api/gallery` 新增 `archiveBridge` 接口（`SetArchive` 注入，nil 时全部 Gallery 流程走 legacy 内存 zip 会话）；`/edit/extract-zip-entry` 与 review start 接受 `sourceId`（严格路径 + `DefaultBudget` 经 `/api/archive` 读取）；`POST /api/archive/zip-replace` 提供 sourceId 原子写回（replacements+deletes，并发冲突 409 `archive.busy`）；前端 `gallery-io/tree/fullscreen/review/edit` 全部支持 archive-source 条目（`/api/archive/sources/{id}/entries/...` 读取、TTL 后重登记、按 sourceId 分组删除/审核/编辑），**同时完整保留 legacy 调用方**（`/api/gallery/zip/{sid}*`、`zip-from-path`、`zip` 上传、`/edit/extract-zip-entry|upload-temp|zip-outputs|zip-writeback`——FSAA/拖放/粘贴路径仍走会话）。旧专用端点**未删除**（计划 §7.2"迁移完成后删除"未执行）；无浏览器任意路径 API 新增。`go build ./...`/`go vet ./...` 全绿。**P4/P6 未实施；P5 第一阶段（`internal/feature` manifest）已落地，feature_* tags 未实施**（见 §1/§12）。
> **与计划的关系：** 本文件是 [`archive_compatibility_plan.md`](../archive_compatibility_plan.md)（实施计划，非事实来源）的落地基线。计划 §1.3 冻结决策"先统一 API 和资产清单，再添加 build tags"仍然有效；feature build profiles（计划 §11/P5）**尚未实施**，本层无 build tag，无条件编译。

## 1. 范围与结论

- 统一归档能力层（ZIP 读写 + 7z/RAR 经外部工具读写）已按计划 §3/§4 落地为两个 leaf 包 + 一个 API 子包：
  - `internal/archive` — ArchiveCore 基础（P0/P1）：冻结合同、严格路径、预算、ZIP adapter、TempStore。
  - `internal/archivetool` — 外部工具层（P2）：`7z`/`7zz`/`unrar`/`rar` 解析、能力探测、argv runner、`Runner` 装配。
  - `internal/api/archive` — `/api/archive` HTTP 表面（P2 已落地 + P3 `zip-replace` 新增）。
- 浏览器侧交接统一走 `web/static/media-bridge.js`（MediaBridge，计划 §9.2）：Download/GIF/归档 pack 都是生产者，Gallery 通过自己的 `galleryImportAssets` 消费；**不再跨页面直接写 `galleryState`、不再传绝对临时路径**。
- 严格路径、collision 检测、budget 计数、owner/job token 均已按计划 §4.2/§4.3 实现并有测试。
- **已落地：** P0/P1（ArchiveCore 合同/严格路径/预算/ZIP adapter/TempStore）、P2（archivetool 外部工具层 + `Config.Archive` + Settings + `/api/archive` 挂载）、**P3 后端桥接 + 前端 sourceId 双路径**（见 §5/§9 与本文件头部核对）、P5 第一阶段（`internal/feature` manifest，[`PROJECT_MAP.md`](../PROJECT_MAP.md) §13g 与 `docs/build-variants.md`「编译裁剪边界」——router/app 经 `feature.Enabled` 门控，默认构建全启用）。
- **未实施（不得标记完成）：** P3 的"旧端点删除"（`/api/gallery/zip*`、`/edit/zip-outputs|zip-writeback|extract-zip-entry|upload-temp` 等 legacy 路由仍注册、前端仍调用，FSAA/拖放/粘贴导入仍走 zip 会话——"迁移后删除旧专用实现"未执行，无 shim 但有两套并存；**7z/RAR 浏览器导入缺口**：picker `accept` 仅 `.zip`（`gallery-layout.js:15`）、`isArchiveName` 识别 .7z/.rar 后仍走 zip-only 上传，7z/RAR list/read 只在 `/api/archive` API 层可用）；P4（GIF 导出格式选择 + 帧 asset 化全量迁移 + Download→Gallery 全量过桥）；P5 的 feature_* build tags 与构建 profiles（仅 manifest 边界落地）；P6（7z/RAR 原文件替换）。

## 2. 模块依赖与边界

```text
Core (proxy/config/registry/rotation/usage)
+-- internal/archive            (leaf：stdlib + golang.org/x/text；不依赖任何功能包)
|   +-- internal/archivetool    (只 import internal/archive 合同 + config.ArchiveConfig)
|       +-- internal/api/archive(import apibase + archivetool + archive；HTTP 表面)
+-- internal/api/apibase        (ArchiveRunner 接口 + ArchiveSettingsFn 回调，接口化避免 api→archivetool 直依赖)
+-- web/static/media-bridge.js  (零依赖 JS 契约，两个 index 变体均先于生产者加载)
```

- `internal/archive` **不依赖** Gallery/GIF/Download/Playground/API 层（包文档注释 + `go list` 验证：仅 import 外部库）。
- `internal/archivetool` 是 `internal/archive` 的兄弟：只消费冻结合同（`Format`/`Source`/`Entry`/`Manifest`/`Budget`/`Reader`/`Writer`/`TempStore`），不修改 foundation。
- `internal/api/apibase.Deps.ArchiveRunner` 接口（`apibase/deps.go`）由 `*archivetool.Runner` 实现；router 注入时不需要 import `archivetool`（经接口）。
- 前端：MediaBridge 是生产者的唯一出口、Gallery 的唯一外部入口；`galleryState` 只被 Gallery 自己的代码（`gallery-io.js::galleryImportAssets`）写入。

## 3. `internal/archive/` — ArchiveCore 基础（P0/P1，已落地）

### 3.1 合同类型（`types.go`）

冻结自计划 §4.1：`Format`（`zip`/`7z`/`rar` + `Valid()`）、`Source`（`ID`/`Format`/`Name`/`Path`(服务端专用)/`Size`/`Writable`）、`SourceRef`（`SourceID`/`Format`/`EntryPath`）、`AssetRef`（`ID`/`Name`/`MIME`/`Path`(服务端专用)/`Size`）、`MediaAsset`（浏览器可见元数据子集，永不携带服务端路径或密钥）、`Entry`（`Path`/`Size`/`CompressedSize`/`IsDir`/`Kind`）、`Manifest`、`Budget`、`Reader`（`List`/`ReadEntry`）、`Writer`（`ReplaceZIP`/`Pack`）。

哨兵错误：`ErrEntryNotFound` / `ErrUnsafePath` / `ErrPathCollision` / `ErrUnsupportedWriteback` / `ErrClosed` 及匹配辅助 `IsNotFound`/`IsUnsafePath`/`IsPathCollision`；`BudgetError`（`Dimension` 取值 `"entries"`/`"entry-bytes"`/`"total-bytes"`/`"ratio"`/`"input-bytes"`/`"output-bytes"`/`"depth"`）+ `IsBudgetExceeded`。

### 3.2 严格路径合同（`path.go`）

- `StrictArchivePath(p)`：**先校验后归一化**——拒绝 NUL/C0 控制字节、空路径、绝对 `/`/`\` 前缀、Windows 盘符、UNC、`\\?\`/`\\.\` 前缀、`.`/`..` 段、空段、ADS（任意 `:`）、尾随点/空格（Windows 名称等价）、Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名）；全部通过后把 `\` 归一为 `/` 重建路径。
- `ValidateEntryPaths(names)`：对**全部**条目做 collision map——规范化路径重复、Windows 等价（大小写折叠）重复、文件条目是另一条目路径的目录前缀、目录条目与文件条目同名，任一冲突整个归档失败。目录条目 `"dir/"` 校验为 `"dir"`。
- `IsDirEntry(raw)`：语法判断尾随 `/` 或 `\`。

### 3.3 预算（`budget.go`）

计划 §4.3 的代码默认常量：`MaxInputBytesDefault=500MiB`、`MaxLocalInputBytes=1GiB`、`MaxEntryBytesDefault=100MiB`、`MaxEntriesDefault=20000`、`MaxTotalBytesDefault=2GiB`、`MaxCompressedRatioDefault=100`、`MaxPackFilesDefault=2000`、`MaxOutputBytesDefault=2GiB`、`DefaultAssetBytes=MaxEntryBytesDefault`；操作超时 `ListTimeoutDefault=15s`、`ReadTimeoutDefault=60s`、`WriteTimeoutDefault=5min`；`MaxConcurrencyDefault=2`。`DefaultBudget()` 返回默认值（`MaxDuration=0` 由调用方选操作超时；`MaxNestedDepth=0` 不递归）。

- `Tracker`（并发安全）：`CheckEntrySize(compressed, uncompressed)` 计数条目数/单条大小/压缩比/总大小，超限返回 `*BudgetError`；`Counters()`。
- `CapReader`/`ReadCapped`：读到第 limit+1 字节即报 `"entry-bytes"` 预算错（不静默截断），镜像 gallery 的 `io.LimitReader(rc, cap+1)` 检测。
- `CountingWriter`：输出字节超限报 `"output-bytes"` 预算错。

### 3.4 ZIP adapter（`zip_adapter.go`）

`ZIP{}` 实现 `Reader`，`zip_writer.go::NewZIPWriter(store)` 实现 `Writer`：

- `List`：打开 `src.Path`（输入大小上限），对**全部**条目名严格校验 + collision 检测后返回 manifest，自然排序（数字段按值比较，其余字节序）。**与 `internal/gallery` 的差异（P3 迁移时需知）**：返回全部条目（目录以 `IsDir` 标记），因为 collision map 必须覆盖全部；图片扩展名过滤仍是 Gallery 层职责。
- `ReadEntry`：标识符是十进制索引或严格相对路径；不安全路径在任何匹配前即拒绝 `ErrUnsafePath`。
- `Replace`：内存 zip 重写，替换命中的严格路径条目，未命中条目字节级保留（Method/Modified/Extra/comment + 归档注释）；替换键与源条目全部严格校验，不安全键拒绝整个操作；返回的 Manifest 与 `List` 同规则。`NewZIPWriter.ReplaceZIP` 把输出注册为**新 asset（owner=source ID）**，并发冲突不会损坏源文件——原子换源由调用方决定。
- `Pack`（ZIP）：输入 `AssetRef` 名必须过 `StrictArchivePath`，不安全/缺失名拒绝整个 pack；输出注册到 TempStore。
- 非 ZIP 格式的 `ReplaceZIP` 返回 `ErrUnsupportedWriteback`（外部工具只 pack 不回写，见 archivetool）。
- 辅助：`contentTypeForExt`、`naturalLess`（与 Gallery 同序）。

### 3.5 TempStore（`tempstore.go`）

文件型、owner/job 绑定临时资产库：`<root>/<owner>/<job>/<id>_<name>`，客户端只见随机 asset ID。

- `NewTempStore(root, ttl)`：0700 私有 workspace；`ttl<=0` 选 `DefaultTempTTL=24h`。
- `Create(ctx, owner, jobID, name, mime, r, maxBytes)`：name 经 `sanitizeAssetName` 安全化；`Open`/`Path`（服务端专用，绝不返回浏览器）/`Stat`；`Release`（幂等）/`ReleaseOwner`；`Scavenge(now)`（过期资产回收，并发安全）；`Close`（整树删除，之后 `Create` 返回 `ErrClosed`）。
- 过期资产在 `Open` 时视同缺失（由 scavenger 回收文件）。

### 3.6 非 UTF-8 条目名（`charset.go`）

镜像 `internal/gallery/charset.go` 的 CJK 探测还原（Shift-JIS→GBK→EUC-KR→Big5 优先级 + round-trip 校验 + halfwidth katakana 惩罚评分），P3 去重两处副本。`internal/archive` 的 ZIP adapter 因此对日/中 Windows zip 条目名与 Gallery 呈现一致。

### 3.7 测试

`path_test.go`（遍历/绝对路径/盘符/UNC/ADS/保留名/等价碰撞）、`budget_test.go`（条目数/单条/总大小/压缩比/输出上限）、`zip_adapter_test.go`（List 严格校验 + 自然排序、ReadEntry 索引/路径、Replace 保留元数据）、`zip_writer_test.go`（ReplaceZIP/Pack 走 TempStore）、`tempstore_test.go`（owner/job 隔离、TTL 过期、确定性回填、Scavenge/Close）。`go test ./internal/archive/...` 通过。

## 4. `internal/archivetool/` — 外部工具层（P2，已落地）

计划 §5 的落地实现。包文档（`status.go`）自述：7z/7zz/unrar/rar 解析、能力探测、机器输出 list/read、pack，以及把工具与 TempStore 装配起来的 `Runner`（deadline、进程组取消、有界输出、并发信号量）。

### 4.1 工具发现与能力（`tool.go` + `status.go`）

- `Resolver`：计划 §5.1 优先级 配置路径 → 专用 env（`SEVENZIP_PATH`/`RAR_PATH`）→ PATH；配置路径缺失**不会**静默回退 PATH（typo 可见）；`validateTool` 要求绝对路径 + regular executable；结果按 `statusCacheTTL=30s` 缓存，`UpdateSettings` 立即失效。
- `SevenZip(ctx)`/`RAR(ctx)` 返回 `toolInfo`：bare banner 探测（`probeTimeout=15s`、`probeMaxBytes=4KiB`）+ `parseToolVersion`；RAR read 覆盖 7z fallback（无 rar/unrar 但 7z 可用时仍可读 .rar；Write 恒 false——只有验证过的 `rar` 二进制能写）。
- `ToolError`：稳定机器码 `ErrToolMissing`/`ErrToolTimeout`/`ErrReadOnly`/`ErrEncrypted`/`ErrMultiVolume`/`ErrCorrupt`，供 API 映射（计划 §5.3 可区分错误）。
- `Status`/`ToolStatus`：`GET /api/archive/status` 响应形状 `{zip:{read:true,write:true}, sevenZip:{...}, rar:{...}}`。

### 4.2 argv 构建与执行（`builders.go` + `exec.go`）

- `sevenZipBuilder`：list `l -slt -sccUTF-8 -p- -- <path>`（机器格式、非 ASCII 安全、加密 fast-fail）；read `x -so -sccUTF-8 -p- -- <path> <sel>`。
- `rarBuilder`：list `lb -p- -idq <path>`（bare 机器输出，无大小 → `Size=0`、`CompressedSize=-1`）；read `p -inul -p- <path> <sel>`。
- pack：`sevenZipPackBuilder` `a -t7z -mx=5 <out> <files...>`；`rarPackBuilder` `a -idq <out> <files...>`；`cmd.Dir` 设为 staging 目录 → 条目名是纯 basename，无绝对路径泄漏。
- `runTool`/`runToolDir`：`exec.CommandContext` **不经 shell**；子 context 施加超时；`procutil` 进程组（整树 kill）；stdout 有界（超限即 kill 子进程并返回 `*archive.BudgetError("entry-bytes")`，绝不交出截断数据）；stderr 只留 `stderrTailMax=16KiB` tail；非零退出按退出码+stderr 启发式分类为 `ToolError` 种类。输出上限：list `64MiB`、pack `1MiB`。

### 4.3 外部 adapter（`external.go` + `parse.go`）

- `NewExternalReader(res)`：实现 `archive.Reader`（7z/RAR List/ReadEntry）；`externalConcurrency=2` 信号量；`entrySelector` 拒绝外部工具视为通配符的元字符（`*`/`?` 等）；十进制索引经 `resolveRarIndex` 先用 bare listing 映射为严格名。
- `NewExternalWriter(res, store)`：`archive.Writer` 的 7z/RAR `Pack`——输入按去重 basename 暂存进私有 job 目录，`cmd.Dir`=staging；`ReplaceZIP` 恒返回 `ErrUnsupportedWriteback`。
- 解析：`parseSevenZipSLT`（`l -slt` key/value，按块取末次出现）、`parseRarLB`（`lb` 每行一条）；`buildManifest` 对原始工具条目**再走 foundation 严格校验 + collision + 预算 + 自然排序**，目录条目标记 `IsDir` 并归一化尾分隔符。
- 超时：`opTimeout(budget, def)` 让预算值覆盖默认（list 15s/read 60s/pack 5min）。

### 4.4 Runner（`runner.go`）

`NewRunner(root, cfg)`：创建 0700 archive workspace（失败只禁用归档能力，核心功能不受影响，返回诊断性 error）并装配 foundation ZIP writer + 外部 adapter；`Store()`、`Status(ctx)`（resolver probe 缓存）、`UpdateSettings(cfg)`（换配置 + 失效 probe 缓存）、`List`/`ReadEntry`/`Pack`（按格式分派：ZIP→stdlib，7z/RAR→外部工具）、`Scavenge(now)`（回收过期注册资产 + `sweepOrphans` 清 2×TTL 前的崩溃遗留目录）、`Close`/`IsClosed`。`ErrNoRunner` 是 API 层在 runner 未装配（temp 目录不可用）时的哨兵。

## 5. `internal/api/archive/` — HTTP 表面（P2/P3 已落地）

`register.go`（`Handler`/`NewHandler(d *apibase.Deps, runner apibase.ArchiveRunner)`；runner 可为 nil，此时所有端点返回诊断性 503 `archive.unavailable`）。已挂载于 `internal/api/router.go`：`r.Route("/api/archive", ...)`（auth 中间件；绕过 1MiB 组级上限，逐路由 body cap 在 handler 内，与 `/api/gallery` 同模式）；`deps.archiveRunner` 经 `Router.SetArchiveRunner(runner)` 注入（app `buildComponents` 在 `Routes()` 前调用），`apiDeps.ArchiveSettingsFn` 闭包把 settings PATCH 后的 `cfg.Archive` 推给 runner。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/archive/status` | 工具/格式能力 |
| POST | `/api/archive/sources` | 上传 ZIP/7z/RAR 源（500MiB 上限），登记 manifest |
| GET | `/api/archive/sources/{id}/entries/*` | 单条 entry 读取（路径再次严格校验） |
| DELETE | `/api/archive/sources/{id}` | 释放 source/workspace |
| POST | `/api/archive/assets` | 浏览器 blob → 服务端 assetId |
| GET | `/api/archive/assets/{id}` | 按 assetId 取字节（MediaBridge server 镜像读取路径） |
| POST | `/api/archive/pack` | `{assetIds, format, name}` → 新归档 asset |
| POST | `/api/archive/release/{id}` | 主动释放临时输出 |
| POST | `/api/archive/zip-replace` | **P3 新增**：原子写回已登记 ZIP source——`{sourceId, replacements:[{entryPath,assetId}], deletes:[entryPath]}`；严格路径校验、非 ZIP/只读源 403、同源并发写回 409 `archive.busy`（`h.replacing` 标志，所有退出路径清除）、输出经 TempStore 注册为新 asset 后由 handler 原子换源。对应计划 §7.2 `zip-replace` 合同 |

### 5.1 Gallery 桥接（`archiveBridge`，P3）

`internal/api/gallery/register.go` 定义 `archiveBridge` 接口（`ResolveSource(id)`/`List(ctx,src,b)`/`ReadEntry(ctx,src,id,b)`），由 `*internal/api/archive.Handler` 实现，router 经 `galleryHandler.SetArchive(archiveHandler)` 注入（`internal/api/router.go` Routes）。**nil 桥接 = 全部 Gallery 流程走 legacy 内存 zip 会话**（兼容边界，无归档 runner 时 Gallery 不回归）。消费点：

- `/edit/extract-zip-entry`：`sourceId` 作为 `zipAbsPath`/`sessionId` 之外的第三种输入，经 `ResolveSource` + `ReadEntry`（严格路径 + `DefaultBudget`）读取，不再信任浏览器提交的任意绝对路径。
- AI Review（`galleryStartReview`）：`sourceId` 替代 `sessionId` 启动（任务键 = sourceId）；`runReview`/`analyzeImage` 重构为 `readEntry func(ctx, path)` 闭包，legacy 会话流与 archive 源流共用同一引擎。
- 前端 sourceId 条目读取：`GET /api/archive/sources/{id}/entries/{path...}`（gallery-io.js `getZipEntryBlob`，404 = 源 TTL 过期 → 重登记后重试）；按 sourceId 分组删除（`DELETE /api/archive/sources/{id}`）、审核（review start 带 sourceId）、编辑（extract 带 sourceId）；删除条目经 `POST /api/archive/zip-replace`（`gallery-fullscreen.js::_zipReplaceDeleteEntries`）。

错误映射（`writeRunError`）：`ErrToolMissing`→503、`ErrToolTimeout`→504、`ErrReadOnly`→403、`ErrEncrypted`/`ErrMultiVolume`/`ErrCorrupt`→422、其余→502，JSON 信封带稳定机器码供前端 i18n 键控。辅助：`detectFormat`（扩展名 → magic-byte 兜底）、`mimeForName`、`kindForName`。

## 6. 配置与 Settings 接线（已落地）

- `internal/config/types.go`：`Config.Archive ArchiveConfig`（`yaml/json:"archive,omitempty"`），字段 `SevenZipPath`/`RarPath`/`TempDir` 全可选——空工具路径运行时回退 env/PATH，缺失工具**不阻塞启动**，只禁用对应能力。
- `internal/config/paths.go`：`ResolveArchiveTempDir(tempDir, configDir)`——空→`{configDir}/archives`、相对→拼 configDir、绝对→原样；创建 0700 workspace 由调用方负责，失败 fail-closed（归档能力关闭，核心功能照常）。
- `internal/api/settings/register.go`：GET `/api/settings` 返回 `archive:{sevenZipPath,rarPath,tempDir}`；PATCH 接受 presence-aware `archivePatch`（全指针字段：未发送不覆盖、空串=显式清除回 env/PATH），经 `applyArchiveUpdates` 逐字段合并后调 `ArchiveSettingsFn(cfg.Archive)` 推给 runner（换配置 + 失效 probe 缓存）。**绝不能整结构覆盖**（沿用 settings 的 presence-aware 合并纪律）。
- `internal/api/apibase/deps.go`：`ArchiveSettingsFn func(config.ArchiveConfig)`（可为 nil；settings handler 调用前判空）+ `ArchiveRunner` 接口（`Store`/`Status`/`List`/`ReadEntry`/`Pack`）。
- 运行时装配（`internal/app/app.go::buildComponents`，已落地）：`archiveRoot := config.ResolveArchiveTempDir(cfg.Archive.TempDir, a.configDir)` → `archivetool.NewRunner(archiveRoot, cfg.Archive)`（err 时 `Warn` 并保持 `a.archiveRunner == nil`，归档能力禁用、核心功能照常）→ 成功时 `a.archiveRunner.Scavenge(time.Now())`（启动回收过期资产/崩溃遗留）→ `a.apiRouter.SetArchiveRunner(a.archiveRunner)`（在 `Routes()` 前）→ `Shutdown` 中 `archiveRunner.Close()`。

## 7. MediaBridge（`web/static/media-bridge.js`，已落地）

计划 §9.2 冻结合同的实现（文件头注释注明 frozen 2026-08-06）。**零依赖**：守卫所有 DOM/toast/i18n 访问，`node --check` 通过；配套 `media-bridge.test.js`。

- 加载：`index.html` 与 `index-nopg.html` 均在其它脚本**之前**加载 `<script src="/media-bridge.js">`（生产者 download.js/gif-editor.js 之后才加载），故无 playground 构建的 GIF/Download 也能交接。
- 公开 API：`register(asset)` → `Promise<assetId>`（`{name,mime,kind?,format?,size?,blob?,url?,resolver?}`；有 blob 且 `/api/archive/status` 存在时镜像到服务端 assetId 并以受控 URL 为字节源，否则客户端持有 blob 到 TTL——真回退非 stub）；`openGallery(assetId|[])`（入队 pendingImports + 切 Gallery 页，`renderGallery` 触发投递；已在 Gallery 页则立即投递）；`consume(id|[])`（释放桥接 token，服务端副本交给服务端 TTL，不删）；`deliverPendingImports()`（Gallery 自己的 `renderGallery` 调用，交 `galleryImportAssets` 并在成功后 consume）；`getAsset`/`getAssetBlob`/`list`/`archiveStatus()`（缓存探测）。
- 规则：绝对路径永不过桥；`galleryState` 只由 Gallery 代码写；token 跨页面切换/cleanup 存活直到消费/释放/TTL（10 分钟，60s 懒清扫，`unref`）；pendingImports 队列不被 `cleanupGallery` 清空（切走再切回仍投递）。

## 8. 前端消费者（已落地）

- **Gallery 导入入口**（`web/playground/static-pg/gallery-io.js`）：`galleryImportAssets(assets)` — 按 `kind`/mime 分流：video → `buildBridgeVideoItem`（受控 URL 直流，`kind:'plain'` 项带 `assetId`）；archive/zip → 复用既有 zip 会话流（`addZipBlob`，按 assetId 去重）；其余 → `getAssetBlob` 取字节为普通图片项。`_bridgeImported` 去重（失败回滚 claim）；导入计数 toast（`mediaBridgeImported`）。这是桥接写 `galleryState` 的唯一通道。
- **Gallery 投递钩子**（`web/playground/static-pg/gallery.js`）：`renderGallery` 调 `MediaBridge.deliverPendingImports()`（切页回来补投递未消费 handoff）。
- **Download**（`web/static/download.js`）：`playVideo(taskId)` 重构——完成任务的输出注册为 MediaAsset（`kind:'video'`、`url=/api/downloads/{id}/file`、无绝对路径），`MediaBridge.register` 全部成功后再 `openGallery(ids)`；删除直写 `galleryState` 的旧路径。
- **GIF 编辑器**（`web/static/gif-editor.js`）：三条导出路径（GIF blob / PNG Sprite blob / ZIP pack 受控 URL）都在结果 modal 记 `lastResultAsset`，新增「Open in Gallery」按钮（`gifEditorOpenGallery`）→ `openResultInGallery()` 等待（可能仍在途的）`register()` 完成后 `openGallery`；`gif-editor.js` 不再创建下载 `<a>` 再 click（ZIP/PNG 改预览 + 受控下载 + 交接）。
- i18n 新增键（en/cn）：`mediaBridgeImported`/`mediaBridgeGalleryUnavailable`/`mediaBridgeAssetExpired`/`gifEditorOpenGallery`。

## 9. 与冻结计划的偏差（实施时记录，供 P3 评审）

1. `ReadEntry` 标识符按实现为**十进制索引或严格相对路径**（计划 §7.2 写的是 `{path...}` 纯路径）；`entrySelector` 拒绝通配符元字符。
2. `ReplaceZIP` 输出注册为**新 asset（owner=source ID）**而非直接原子换源——换源/交换由调用方决定，避免并发写回冲突损坏源（计划 §8.3 的"临时文件+原子 rename"约束由调用方落实）。
3. foundation `List` 返回**全部条目**（含目录，`IsDir` 标记）——collision map 必须覆盖全部条目；图片过滤留在 Gallery 层。
4. 7z/RAR 列表默认 `l -slt`、读走 stdout（`x -so`/`p`），**不在用户目录落盘**；pack 输入 staging 到私有 job 目录（`cmd.Dir`），条目名无绝对路径。
5. MediaBridge 的 `/api/archive/assets` 服务端镜像在 Archive API 可用时启用，不可用时客户端 blob 兜底到 TTL——**回退是真实的**（计划 §9.2 的"不保存大 Blob 永久副本"由 TTL+消费语义落实）。

## 10. 测试与验证现状

- `go build ./...` 与 `go vet ./...` 全绿（默认无 tag 构建，47 个 internal 包 + 新增 archive/archivetool/api-archive 全部编译）。
- `go test ./internal/archive/...` 通过；`internal/archivetool` 暂无独立测试文件（行为经 runner/API 层覆盖，待 P3 补）。
- `node --check web/static/media-bridge.js` / `media-bridge.test.js` 通过。
- 计划 §13 的完整验收矩阵（构建矩阵、跨格式行为、安全用例）以计划文档为准，P3/P4 完成后执行。

## 11. 源码锚点

| 文件 | 职责 |
|---|---|
| `internal/archive/types.go` | 冻结合同：Format/Source/SourceRef/AssetRef/MediaAsset/Entry/Manifest/Budget/Reader/Writer + 哨兵错误 |
| `internal/archive/path.go` | `StrictArchivePath`/`ValidateEntryPaths`/`IsDirEntry`/`windowsEquivKey` |
| `internal/archive/budget.go` | §4.3 默认常量 + `DefaultBudget`/`Tracker`/`CapReader`/`CountingWriter` |
| `internal/archive/zip_adapter.go` | `ZIP` adapter：`List`/`ReadEntry`/`Replace` + 自然排序 + `contentTypeForExt` |
| `internal/archive/zip_writer.go` | `NewZIPWriter`：`ReplaceZIP`（新 asset 输出）/`Pack`（严格名校验） |
| `internal/archive/tempstore.go` | owner/job 绑定临时资产库：Create/Open/Path/Release/Scavenge/Close |
| `internal/archive/charset.go` | 非 UTF-8 条目名 CJK 还原（镜像 gallery/charset.go） |
| `internal/archivetool/tool.go` | `Resolver`（配置→env→PATH + probe 缓存 30s）+ `ToolError` 种类 |
| `internal/archivetool/status.go` | `Status`/`ToolStatus` 响应形状 |
| `internal/archivetool/builders.go` | 7z/rar argv 构造（`-slt`/`x -so`/`lb`/`p` + pack）+ 输出上限 + MIME |
| `internal/archivetool/exec.go` | `runTool`/`runToolDir`：进程组、deadline、有界 stdout/stderr、退出码分类 |
| `internal/archivetool/parse.go` | `parseSevenZipSLT`/`parseRarLB`/`buildManifest`（严格校验+预算+自然排序） |
| `internal/archivetool/external.go` | `NewExternalReader`/`NewExternalWriter`：7z/RAR list/read/pack + 并发信号量 2 |
| `internal/archivetool/runner.go` | `Runner`：格式分派、Status、UpdateSettings、Scavenge/sweepOrphans、Close |
| `internal/api/archive/register.go` | `/api/archive` handler（路由表 + 错误映射 + detectFormat/mimeForName/kindForName） |
| `internal/api/apibase/deps.go` | `ArchiveRunner` 接口 + `ArchiveSettingsFn` 回调 |
| `internal/config/types.go` | `ArchiveConfig`（SevenZipPath/RarPath/TempDir） |
| `internal/config/paths.go` | `ResolveArchiveTempDir` |
| `internal/api/settings/register.go` | GET `archive` 对象 + presence-aware `archivePatch` + `applyArchiveUpdates` + `ArchiveSettingsFn` 推送 |
| `web/static/media-bridge.js` | MediaBridge 契约（register/openGallery/consume/deliverPendingImports/getAssetBlob/archiveStatus） |
| `web/static/media-bridge.test.js` | 桥接单元测试 seam（reset/setTtl/setNow/_internals） |
| `web/playground/static-pg/gallery-io.js` | `galleryImportAssets`（唯一桥接写入口）+ `buildBridgeVideoItem`/`importBridgeImageAsset`/`importBridgeArchiveAsset` |
| `web/playground/static-pg/gallery.js` | `renderGallery` 调 `deliverPendingImports` |
| `web/static/download.js` | `playVideo` 经 MediaBridge 交接（`kind:'video'` + 受控 URL） |
| `web/static/gif-editor.js` | `openResultInGallery`/`lastResultAsset` + 「Open in Gallery」按钮 |
| `web/static/index.html` / `index-nopg.html` | `<script src="/media-bridge.js">` 最先加载 |

## 12. 变更维护清单

| 触发变更 | 涉及源码 |
|---|---|
| 修改归档合同类型/哨兵错误 | `internal/archive/types.go`（冻结合同变更须先评审，计划 §4.1） |
| 修改严格路径校验 | `internal/archive/path.go` + `path_test.go`（遍历/盘符/UNC/ADS/保留名/等价碰撞矩阵） |
| 修改预算默认值 | `internal/archive/budget.go` 常量（§4.3 默认，Settings 不暴露） |
| 修改 ZIP list/read/replace 语义 | `internal/archive/zip_adapter.go` + `zip_adapter_test.go`；P3 迁移 Gallery 后与 `internal/gallery/zip*.go` 去重 |
| 修改 ZIP pack/replace 输出 | `internal/archive/zip_writer.go`（TempStore 输出，owner=source） |
| 修改临时资产生命周期 | `internal/archive/tempstore.go`（TTL/Scavenge/Close/owner-job 隔离） |
| 修改外部工具发现/探测 | `internal/archivetool/tool.go`（Resolver 优先级/缓存）+ `status.go` |
| 修改工具 argv | `internal/archivetool/builders.go`（必须保持 argv 数组 + 无 shell） |
| 修改子进程执行/超时/输出上限 | `internal/archivetool/exec.go`（进程组 + deadline + 有界 stdout/stderr） |
| 修改 7z/RAR 输出解析 | `internal/archivetool/parse.go`（`-slt`/`lb` 机器格式） |
| 修改归档 API 端点 | `internal/api/archive/register.go` + `internal/api/router.go`（挂载）/`internal/app/app.go`（runner 装配） |
| 修改归档配置/设置 | `internal/config/types.go`（ArchiveConfig）+ `paths.go`（ResolveArchiveTempDir）+ `internal/api/settings/register.go`（archivePatch presence-aware）+ `apibase/deps.go`（ArchiveSettingsFn） |
| 修改 MediaBridge 契约 | `web/static/media-bridge.js` + `media-bridge.test.js` + `i18n.js`（mediaBridge* 键）；加载顺序：两个 index.html 最先加载 |
| Gallery 归档迁移（P3，部分落地） | **已落地：** `internal/api/gallery/register.go`（`archiveBridge` + `SetArchive`）、`edit_handlers.go::galleryEditExtractZipEntry`（sourceId 分支）、`review_handlers.go`/`review_engine.go`（sourceId review + `readEntry` 闭包）、`internal/api/archive/register.go::zipReplace`（`POST /api/archive/zip-replace`）、router `galleryHandler.SetArchive(archiveHandler)`；前端 `gallery-io.js`（`getZipEntryBlob`/`rehydrateZipSession` sourceId 分支 + `_ARCHIVE_IMG_EXTS` 图片过滤）、`gallery-tree.js`（source 分组删除/释放）、`gallery-fullscreen.js`（`_zipReplaceDeleteEntries`）、`gallery-review.js`（sourceId 审核启动/轮询）、`gallery-edit.js`/`gallery-edit-batch.js`（extract 送 sourceId）。**保留的 legacy 调用方（勿删）**：`/api/gallery/zip/{sid}*`（GET/DELETE/touch）、`zip-from-path`、`/api/gallery/zip` 上传、`/edit/extract-zip-entry`（zipAbsPath/sessionId 分支）、`/edit/upload-temp`、`/edit/zip-outputs`、`/edit/zip-writeback`、`/api/gallery/zip-writeback`——FSAA/拖放/粘贴导入与 `kind:'zip'` on-disk 包仍走会话流；旧端点删除属计划 §7.2 后续（P3 收尾），**未执行** |
| Feature tags / build profiles（P5） | **第一阶段已落地**：`internal/feature` manifest + router/app `feature.Enabled` 门控 + `feature.Assets` 派生 static-pg 路由列表（`docs/build-variants.md`「编译裁剪边界」）。**feature_* tags 未实施**——真裁剪前置：tag 化 `internal/archive`/`archivetool`/`api/archive` 包本身 + 按 feature 拆 embed + index.html 脚本清单 manifest 化 + `build.ps1`/`build_mac.ps1` `-Features`；`internal/feature/feature_test.go` 锁定默认全启用合同 |
