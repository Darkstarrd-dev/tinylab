# Game Demo 进度文档

> Demo 页游戏插件架构的单一事实来源：游戏作为**磁盘插件**按需加载，改游戏代码不重编译、不重启进程。
> Assistant 测试台（ademoSM/物理/碰撞体）见 [`assistant-progress.md`](assistant-progress.md) §8，本文不重复；两者仅在暂停缝（§5）与 Demo 页共存布局上相交。
> 最后核对：2026-08-31（分阶段示例 Unit01~06 + 按需播种：移除启动自动 SeedGames，新增 POST /api/games/seed；web/games/* 为 Unit01~06 六个独立示例，Designer “Example Unit” 按钮与 collapse explorer 同列，svg+tooltip，按需创建示例，用户可在 Explorer 删除以腾出下拉；旧 example 单 survivor 包已移除，见 §1 Seed/Unit 与 §8 验证增补）。

## 1. 功能面总览

| 层 | 位置 | 职责 |
|---|---|---|
| 配置 | `internal/config/types.go`（`GamesDir` 根字段，`yaml/json:"gamesDir,omitempty"`）、`internal/config/paths.go`（`ResolveGamesDir` 三段式：空→`{configDir}/games`、相对→拼 configDir、绝对→原样） | 游戏插件根目录解析；存档目录恒为 `{configDir}/gamedata`（无配置项） |
| API | `internal/api/games/register.go`（`SeedGames/SeedFromEmbedded/CtxWithSrcFS/SetEmbeddedGames`）、`internal/api/settings/register.go`（GamesDir 搬移 + 迁移后按需 SeedFromEmbedded）、`internal/app/app.go`（启动时 `fs.Sub(web.Games,"games")`→`games.SetEmbeddedGames` 注册内嵌集） | `GET /api/games` 列表（扫目录+manifest 校验+entry mtime）、`POST /api/games/seed` 按需播种（复制内嵌集 Unit01~06 到磁盘，已存在跳过，返回 `{seeded,skipped}`）、`GET/PUT /api/games/{id}/state` 存档 KV（`fsutil.AtomicWrite`）；`GET /api/settings` 暴露 `gamesDir`/`configDir`，`PATCH /api/settings` 的 `gamesDir` 变更触发目录创建→顶层条目移动（`os.Rename` 失败回退递归拷贝）→已存在目标跳过不覆盖→空旧目录移除→空新目录 `SeedFromEmbedded` |
| 路由 | `internal/api/router.go` + `internal/api/router_demo.go` + `web/games.go` | `/api` 组内 `r.Route("/games", ...)`（继承鉴权+1MB cap，含 `POST /seed`）；`r.Get("/games/*")` 磁盘静态（`StripPrefix`+`http.Dir`，no-store，**不鉴权**，注册在 `serveUI` 通配之前）；`registerDemoStatic` 仅 `MkdirAll`+挂载静态，**启动不再自动播种**，由 Designer “Example Unit” 按钮按需 `POST /api/games/seed` |
| Path Settings | `web/static/download.js`（`openPathSettingsModal` 的 `gamesDir` 行）、`web/static/settings/settings_modal.js`（`openPathModal` 全量 sections 含 `gamesDir`）、`web/static/i18n.js`（`gamesDir/gamesDirDesc/gamesDirMoved` en+cn） | 统一 Path Settings 弹窗：Default Games Dir 行（placeholder `configDir/games`），PATCH 后自动迁移磁盘内容 |
| 内嵌默认集 | `web/games.go`（无 build tag，`//go:embed all:games` → `web.Games`）、`web/games/Unit0{1..6}/` | 编译期内嵌的六个分阶段示例（Unit01 Hello / Unit02 Sprites / Unit03 Input+Physics / Unit04 Tweens&Time / Unit05 Camera&Particles / Unit06 Mini Survivor，中文注释充足，参考 C:/omp/Phaser 分阶段教学改编为 TRGames host 容器形态）；按需 `POST /api/games/seed` 时复制到磁盘，已存在的不覆盖 |
| 前端宿主 | `web/static/demo-games.js` | `window.TRGames` 注册表、Phaser 懒加载、游戏脚本注入（mtime 缓存击穿）、host adapter、Demo 页游戏区 UI（选择/启动/停止/重载）、`__dgames` 测试缝 |
| 引擎 vendor | `web/static/vendor/phaser/`（`phaser.min.js` v4.2.1 + `README.md` 记录来源/SHA-256 + `LICENSE` MIT） | 经典 script UMD，`window.Phaser`；首次启动游戏时注入 `/vendor/phaser/phaser.min.js`，不经主页面预加载 |
| Demo 页集成 | `web/static/app-demo.js`（`DEMO_TOOLS=[ademo,tilemap,design]` 下拉：`demoActiveTool/demoMenuOpen` 状态机、`renderDemoWithMenu` 按需渲染（ademo=Assistant Demo、tilemap=TileMap Editor、design=Game Designer）、`F6→toggleDemoMenu`）、`web/static/app-router.js`（`case ademo/tilemap/design→renderDemoWithMenu`、离开清理 `cleanupGameDesigner`）、`web/static/auth.js`（`#demo-menu` 三件套：click/mousemove/keydown）、`web/static/style-editor.css`（`.dgn-root` 作用域、`.dgn-stage/.dgn-status`）、`web/static/i18n.js`（`design/designer*` en+cn + `designerExampleUnits/designerExampleSeeding/designerExampleSeeded/designerExampleExists`）、两个 index 变体 `.demo-nav-wrap#demo-menu`+`demo-designer.js` 脚本 | Demo 导航与 Utility/Gallery 同构：点击 toggle + 外部点击关闭 + Esc 关闭 + 页内再次触发 toggle（hover 已移除）；`localStorage.demoActiveTool` 持久化；`ademo` 页内 `Games` 切换按钮已移除（与下拉重复） |
| Game Designer | `web/static/demo-designer.js`（独立 Demo 工具 `GameDesigner.render/cleanup`：复用 `EditorLayout` 工厂（tree/input/gutter/status）+ `?root=games` 的 editor 后端（tree/open/save/delete 均 scope 到 games 目录）+ Phaser 预览（Blob 注入 `TRGames.register` 的 entry → `__dgames.loadPhaser/injectScript/makeHost` → `launch`）；经 Demo 下拉 `design` 项渲染；**与 collapse explorer 同列**的 `Example Unit` 按钮（`.dgn-example-unit`，svg+tooltip `designerExampleUnits`，按需 `POST /api/games/seed` 后 `dgnLoadTree`）） | games 作用域的文件编辑（新建项目=`game.json{ id=目录名, entry: main.js}`+`main.js` 模板→`TRGames.register/Phaser.Game`、`Ctrl+S`、新建文件、删除项目/文件）+ 右侧 Phaser 实时预览（`Run/Reload` Blob 热注入，`Stop` 销毁）；藏 markdown 控件（`.dgn-root`）、显 `JS`/`Saved/Preview error` 状态；工具内增删改经 `GET /api/games` 立即出现在 `Demo→Games` 下拉。示例：Designer 内点 `Example Unit`（与 collapse explorer 同列）按需创建 Unit01~06，已存在的跳过；用户可在 Explorer 删除已建示例以腾出 Demo Games 下拉 |
| TileMap Editor | `web/static/utility/editor/tilemap_editor.js`（独立 Demo 工具：画布+调色板+图层面板；Tiled JSON 直出→Phaser `tilemapTiledJSON`；经 Demo 下拉 `tilemap` 项渲染，不再包裹 `renderEditor` 注入类别 Tab） | Tiled JSON 编辑器，参考 Godot TileSet/TileMapLayer + Tiled TMJ；导出与 Phaser 4 `make.tilemap/addTilesetImage/createLayer` 契约一致 |
| 运行时目录 | `{configDir}/games/`（插件）、`{configDir}/gamedata/{id}.json`（存档） | gitignored 运行时数据，首次运行生成（类比 config.yaml） |

## 2. 插件结构约定（游戏开发契约）

```
{configDir}/games/<id>/
  game.json          # 必需：{"id","title","version","entry"}
  main.js            # entry 指定的入口（默认 main.js），classic script
  ...                # 任意资产，经 /games/<id>/<path> 原样访问（no-store）
```

- **manifest 校验**（`loadManifest`）：`id` 必须等于目录名；`title`、`entry` 必填；entry 不得逃逸游戏目录（`withinDir`）且文件必须存在。任一不满足 → 列表跳过 + Warn 日志。
- **入口脚本**：classic script（非 module），加载时**同步**调用：
  ```js
  window.TRGames.register({
    id: 'example',            // 必须等于 manifest id，正则 ^[A-Za-z0-9_-]{1,64}$
    title: 'Survivor',
    launch: function (host) {  // 在 host.container 内启动游戏
      return new Phaser.Game({...});   // 返回值见下
    }
  });
  ```
- **launch 返回值**：Phaser.Game 实例（宿主经 `.destroy(true)` 销毁）**或**任意带 `.dispose()` 的句柄；销毁异常被吞掉（不得阻断页面导航）。重复 register 同 id / 缺 launch / 非法 id → throw。
- **host adapter**（宿主提供给游戏的唯一接口面）：
  | 字段 | 类型 | 说明 |
  |---|---|---|
  | `container` | HTMLElement | 空舞台元素，canvas 挂载于此 |
  | `width`/`height` | number | 启动时舞台 CSS px（之后不跟踪 resize，重启适应） |
  | `phaser` | window.Phaser | 保证入口执行前已加载 |
  | `saveState(obj)` | Promise | `PUT /api/games/<id>/state`，任意 JSON ≤1MB |
  | `loadState()` | Promise\<obj\|null\> | 无存档 → null（404 映射） |
  | `sheetImageUrl(name)` | string | `/api/assistant/sheet-image/{name}`，复用 assistant spritesheet 服务 |
  | `llmChat({model,messages})` | Promise\<parsed\> | `POST /v1/chat/completions`（stream:false）透传代理解析后 JSON |
- **测试缝**：游戏应暴露 `window.__trgame = {game, getState()}` 供 CDP 断言（survivor 参考实现）。
- **不得依赖**宿主 UI 全局（`t`/`escapeHtml`/DOM 结构）；游戏内文本直接英文原文。saveState 失败不得破坏游戏流程（参考实现 try/catch + then 双忽略）。

## 3. HTTP 契约

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/games` | 是（/api 组） | `{"games":[{id,title,version,entry,v}]}`；`v` = entry 文件 mtime UnixMilli（前端缓存击穿用）；games 目录不存在 → `{"games":[]}` |
| `GET /api/games/{id}/state` | 是 | 200 + 原样 JSON 字节；无文件 → 404；id 非法（正则外/路径分隔符）→ 400 |
| `PUT /api/games/{id}/state` | 是（1MB cap） | body 必须 `json.Valid`；原子写 `{configDir}/gamedata/{id}.json` → `{"ok":true}` |
| `GET /games/<id>/*` | **否**（与主静态同惯例） | 磁盘原样服务 + `no-store`；`http.StripPrefix("/games/")`（**必须**，否则 FileServer 按完整 URL.Path 找 `{gamesDir}/games/...` → 404） |
| `GET /api/editor/tree?root=games` 等 `POST /api/editor/{open,save,delete}?root=games` | 是（/api 组，+1MB cap 同 doc） | games 作用域：`?root=games` 时复用同一 editor 后端走 `{gamesDir}/` 根（`baseDir/resolveFileIn`）；`tree` 列 games 树、`open/save` 读写文件（含 `fileId` 含斜杠的嵌套文件）、`delete` 递归删顶层游戏目录（仅 `top-level`+`root=games`） |

## 4. 热更新工作流

1. 改 `{configDir}/games/<id>/main.js` → 保存。
2. Demo 页游戏区点**重载**（`dg-reload`）：停当前游戏 → 删注册表条目 → 重拉 `/api/games` 拿新 mtime → 按 `?v=<新mtime>` 重新注入脚本 → 自动重启同一游戏。或手动 F5（no-store 头 + mtime query 双保险）。
3. **无 Go 编译、无进程重启**。实测（2026-08-29）：磁盘改 `PLAYER_SPEED 220→440` → 重载 → 500ms 位移 132px→220px，精确生效。

新增游戏 = 在 games 目录新建子目录放 manifest+入口，点重载即出现在下拉。**repo 内 `web/games/` 只是按需 seed 源**：磁盘目录已存在时 `POST /api/games/seed` 跳过该游戏（永不覆盖用户改动，且启动不再自动播种）；要更新已 seed 的默认游戏须手动同步或在 Designer 的 Explorer 删除该 Unit 目录后再次点 “Example Unit” 重新创建。

## 5. 前端宿主（demo-games.js）

- **注册表**：`dgRegistry[id] = {def, src}`；`dgLoadGame` 注入 `/games/<id>/<entry>?v=<mtime>`，onload 后校验 `TRGames.register` 已被调用（未调用 → "did not call TRGames.register" 错误入状态行）；同 id 在途注入去重（`dgLoadPromises`）。
- **Phaser 懒加载**：`dgLoadPhaser()` 首次启动游戏时注入 vendor script，单例 promise；`window.Phaser` 缺失则报错。主页面零启动成本。
- **启动/停止**：`dgLaunch` = loadPhaser → loadGame → stop 旧局 → 清舞台 → `def.launch(host)`；`dgStopGame` = destroy/dispose → 清舞台 DOM → 解除测试台暂停 → 同步按钮态。
- **测试台暂停缝**：游戏运行时经 `window.__ademo.setPaused(true)` 冻结测试台物理/SM（`ademoLoop` 跳过 step，画面定格；`assistant-demo.js` 唯一为此新增的代码，6 行 + `isPaused` 查询）。停止/切页恢复。避免 WASD 同时驱动游戏与测试台实体。
- **布局**：`:has(.dg-root)` 门控——有游戏区时 `#page-content` 变滚动 flex 列（测试台 `flex:1 1 0; min-height:340px`，游戏区 `46vh` 舞台）；无游戏区时测试台独占，CSS 零影响（VM 测试守护 `:has` 门存在）。
- **UI**：游戏下拉（title+version）/启动/停止/重载按钮 + 状态行；空列表显示占位 option。i18n 键 `demoGames*`（en+zh 各 9 个）。
- **测试缝**：`window.__dgames = {registry, current(), makeHost, fetchList, loadGame, launch, stop, idRe, loadPhaser, injectScript, setCurrent}`（`setCurrent` 为 VM 测试后门，角色同 petSM.register；`loadPhaser/injectScript` 为 Designer Blob 预览复用面）。
- **Designer 缝**：`GameDesigner` 仅经 `EditorLayout`/editor 后端 games 作用域 + 该宿主缝实现预览，不复制宿主逻辑；失败（未 register/加载失败）进 `.dgn-status`。

## 6. Phaser v4.2.1 实战注意事项（CDP 实证）

1. **overlap 回调参数顺序与 v3 不同**（本轮最大的坑）：`overlap(group, gameObject, cb)` 的 cb 首参在 v4.2.1 是 **gameObject 而非 group child**。survivor 初版 `onPlayerHit(enemy)` 按 v3 顺序取首参 → 玩家受击时 `enemy.destroy()` 实际销毁了**玩家**（`active=false`、移出 display list），下一帧 `update` 对已销毁精灵 `setVelocity` 抛异常 → 场景 update 永久冻结（timeSec 定格、输入失效，但 world 已设速度继续积分 → "敌人还在动"假象）。**survivor 回调已改为参数顺序无关写法**（`this.bullets.contains(a) ? a : b` / `a === this.player ? b : a`）。后续游戏一律照此办理。
2. **物理精灵 `setPosition` 不可靠用于传送**：敌机 `setPosition` 到玩家身上不触发 overlap（body 位置未被改写，下一帧 body 积分覆盖回 transform）。传送应操作 body（`body.reset(x,y)`）。
3. 已验证可用 API：`physics.add.sprite/group/overlap`、`generateTexture`（Graphics 运行时造纹理，零资产）、`time.addEvent` 循环、`addKeys('W,A,S,D,...')` + `update()` 轮询、`JustDown` 重开键、`scene.restart()`（含 best 从 `loadState` 恢复）。CDP `page.keyboard` 驱动有效。
4. vendor 选择 v4 是**刻意的**（用户决策：熟悉新版实现，不要求稳定/兼容）；v4 于 2026-04 发布，生态示例仍以 v3 为主，照抄 v3 示例时须警惕本条 1。

## 7. 边界与代价（用户已确认接受）

- **插件 = 同域可信 JS**，非沙箱：游戏脚本可调用全部 `/api`（本地单机信任模型，与主静态一致）；插件面向自己/可信作者。
- **分发形态**：游戏在磁盘，单二进制不再自包含全部游戏内容；seed 保证空目录有默认集。
- **测试边界**：VM 测试（`web/demo-games.test.js` 16 项）只护宿主机制（注册表契约/adapter 线形/stop 语义/接线）；**游戏内部逻辑不进 VM 测试**，靠隔离实例 headless CDP 实测（本次验证方式即范例）。
- **重编译边界**：adapter、phaser vendor、共享逻辑在 embed 内，改动仍需重编译——刻意切分：稳定低频在 embed，高频内容在磁盘。
- **存档边界**：`/api/games/{id}/state` 是每游戏单 JSON 槽（≤1MB），无版本/分片；更大需求出现时再演进，不预建。

## 8. 验证

- Go：`go build ./...` + `go build -tags "tray webview" ./...`；`go test ./internal/api/games/ ./internal/config/ ./internal/api/editor/`（games: list 校验跳过 ×4、state 404/PUT/GET/非法 JSON/遍历 id、POST /api/games/seed 全复制/跳过已存在/部分失败清理 + SeedGames；editor: `TestEditorGamesRoot_TreeAndSaveAndOpenAndDelete` 的 games 作用域 5 场景；config: ResolveGamesDir 等）。
- JS 回归：`node web/demo-games.test.js`（17 项：接线 ×6、注册表 ×3、adapter ×4、stop ×3、Designer 缝 ×1）；`node web/demo-designer.test.js`（14 项：index 菜单/`demo-designer.js` 顺序/`app-demo` 4 项/`app-router` 2 项/i18n 1 项/编辑器调用 1 项/manifest 1 项/Blob 预览 1 项/`EditorLayout`/modal 1 项/导出 1 项）；`node web/assistant-demo.test.js`（34 项）。
- 浏览器实测（隔离实例 20199 + headless CDP，2026-08-29）：`/api/games` 列表含 Unit01~06（按需 `POST /api/games/seed` 后，空启动 `{games:[]}`，seed 后 6 个 v=mtime）；`/games/Unit01/main.js` 200 + no-store（**首轮 404 → StripPrefix 修复**）；state PUT/GET 回环 + `gamedata/Unit01.json` 落盘；游戏区渲染 + 下拉填充；启动后 Phaser 4.2.1 加载、canvas 挂载、测试台暂停；WASD 位移精确（220px/s × 0.6s = 132px）；敌机追击/自动炮塔击杀/受击 hp-1 且玩家存活（v4 参数顺序修复后）；gameOver 遮罩 + best 存档 PUT + R 重开 + best 回读；停止后 canvas 移除 + 暂停解除 + 按钮态同步；**热更新闭环：磁盘改速度 220→440 → 重载按钮 → 位移 220px/500ms 精确生效**。2026-08-31 增补：Designer “Example Unit” 按钮与 collapse explorer 同列，点后 `POST /api/games/seed → {seeded:6}`，Explorer 删 Unit 后再次点仅补回缺失。
- 2026-08-30 Designer 闭环（隔离实例+CDP，TDD 14 项通过：`GET /api/editor/tree?root=games`/save/open/delete 顶层递归/遍历拒绝、demo-designer/design 菜单/`case design`/blob 预览/`dgn-root`）：Design 新建 `designtest`→`Run`→`.dgn-stage canvas`→改速未保存→`Reload` 命中→`Ctrl+S` 后 `GET /api/games v` 刷新→切 ademo→Games 下拉含新游戏并可 Launch→回 Design `Delete`→`/api/games` 回退；Utility Editor docDir 树/保存回退无影响。
- 已知非 bug：CDP `keyboard.press('r')`（down+up 同帧）偶发不触发 JustDown 重开，hold 400ms 必触发——CDP 时序假象，真机按键无此问题。

## 9. 变更维护清单（改这些必须同步本文）

| 变更 | 同步位置 |
|---|---|
| `GamesDir` 配置 / `ResolveGamesDir` / Path Settings 行 | §1 配置/Path Settings 行、`config/types.go`+`paths.go`+`paths_test.go`、`internal/api/settings/register.go`（搬移+Seed）、`web/static/download.js`+`settings_modal.js`+`i18n.js`、PROJECT_MAP §3 |
| 插件契约（manifest 字段、TRGames.register、host adapter 面） | §2/§5、`demo-games.js` 头注释、`internal/api/games/register.go` 包注释、seed 游戏参考实现 |
| `/api/games*` 端点 / `/games/*` 静态 / seed 语义 | §3/§4、`register.go`+`register_test.go`、`router.go`、PROJECT_MAP §10 |
| Phaser 版本升级 / v4 新陷阱 | §1 vendor 行、§6、`vendor/phaser/README.md`（版本+SHA-256） |
| Demo 页游戏区 UI / 布局门 / 暂停缝 | §5、`demo-games.js`、`style.css`、`i18n.js`、`assistant-progress.md` §8（测试台侧） |
| seed 游戏增删 / 默认集内容 | §1 seed 行、`web/games/`、§8 验证行、PROJECT_MAP §18 |
| Game Designer（design=Game Designer） | §1-§5、本表、`internal/api/editor/register.go`（`?root=games`）、`web/static/demo-designer.js`/`app-demo.js`/`app-router.js`/`i18n.js`/`style-editor.css`、两个 index 变体 |
| 运行时目录约定（games/gamedata） | §1、PROJECT_MAP §21 |

## 10. 路线图与框架决策记录

- **框架决策（2026-08-29 用户拍板）**：引入 Phaser **v4 最新版**（非 v3 稳定线），目的含熟悉 v4 实现；接受生态示例偏 v3 的代价（§6 陷阱自行趟平）。
- **插件化决策**：游戏=磁盘插件（§2），不为游戏内容重编译；模拟经营类若不需引擎可直接 vanilla 实现为插件（host 不强制用 Phaser）。
- **计划游戏**：①模拟经营 → ②吸血鬼幸存者（现为 `example` 演示包，原 `survivor` 起点，含 §6 教训）→ ③platformer / 横竖版飞机 → ④塔防。assistant 联动（`sheetImageUrl`/`llmChat`）已备，按需接入。
- **未做（刻意）**：fsnotify+SSE 自动重载（手动重载已够用）、游戏逻辑共享层入 embed（等第二个游戏沉淀出共性再说）、存档版本迁移机制。
