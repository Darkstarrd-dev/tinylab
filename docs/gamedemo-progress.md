# Game Demo 进度文档

> Demo 页游戏插件架构的单一事实来源：游戏作为**磁盘插件**按需加载，改游戏代码不重编译、不重启进程。
> Assistant 测试台（ademoSM/物理/碰撞体）见 [`assistant-progress.md`](assistant-progress.md) §8，本文不重复；两者仅在暂停缝（§5）与 Demo 页共存布局上相交。
> 最后核对：2026-08-29（插件架构落地：Go 后端 + TRGames 宿主 + Phaser v4.2.1 vendor + survivor seed 游戏；CDP 实测热更新闭环 + v4 overlap 回调参数顺序陷阱）。

## 1. 功能面总览

| 层 | 位置 | 职责 |
|---|---|---|
| 配置 | `internal/config/types.go`（`GamesDir` 根字段，`yaml/json:"gamesDir,omitempty"`）、`internal/config/paths.go`（`ResolveGamesDir` 三段式：空→`{configDir}/games`、相对→拼 configDir、绝对→原样） | 游戏插件根目录解析；存档目录恒为 `{configDir}/gamedata`（无配置项） |
| API | `internal/api/games/register.go` | `GET /api/games` 列表（扫目录+manifest 校验+entry mtime）、`GET/PUT /api/games/{id}/state` 存档 KV（`fsutil.AtomicWrite`）；`SeedGames` 启动播种 |
| 路由 | `internal/api/router.go` | `/api` 组内 `r.Route("/games", ...)`（继承鉴权+1MB cap）；`r.Get("/games/*")` 磁盘静态（`StripPrefix`+`http.Dir`，no-store，**不鉴权**，注册在 `serveUI` 通配之前）；启动时 `MkdirAll`+`SeedGames`（seeded 列表 Info 日志） |
| 内嵌默认集 | `web/games.go`（无 build tag，`//go:embed all:games` → `web.Games`）、`web/games/<id>/` | 默认游戏的编译期副本；seed 仅在目标游戏目录**不存在**时复制，永不覆盖磁盘已有内容 |
| 前端宿主 | `web/static/demo-games.js` | `window.TRGames` 注册表、Phaser 懒加载、游戏脚本注入（mtime 缓存击穿）、host adapter、Demo 页游戏区 UI（选择/启动/停止/重载）、`__dgames` 测试缝 |
| 引擎 vendor | `web/static/vendor/phaser/`（`phaser.min.js` v4.2.1 + `README.md` 记录来源/SHA-256 + `LICENSE` MIT） | 经典 script UMD，`window.Phaser`；首次启动游戏时注入 `/vendor/phaser/phaser.min.js`，不经主页面预加载 |
| Seed 游戏 | `web/games/survivor/`（`game.json` + `main.js`） | 插件契约参考实现：吸血鬼幸存者式最小原型（详见 §6） |
| Demo 页集成 | `web/static/app.js`（`case 'demo'` 追加 `renderDemoGames`、切页 `cleanupDemoGames`）、`web/static/style.css`（`:has(.dg-root)` 布局门）、`web/static/i18n.js`（`demoGames*` en+zh）、两个 index 变体 script 标签 | 游戏区渲染在测试台下方；测试台布局在无游戏区时逐像素不变 |
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
    id: 'survivor',            // 必须等于 manifest id，正则 ^[A-Za-z0-9_-]{1,64}$
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

## 4. 热更新工作流

1. 改 `{configDir}/games/<id>/main.js` → 保存。
2. Demo 页游戏区点**重载**（`dg-reload`）：停当前游戏 → 删注册表条目 → 重拉 `/api/games` 拿新 mtime → 按 `?v=<新mtime>` 重新注入脚本 → 自动重启同一游戏。或手动 F5（no-store 头 + mtime query 双保险）。
3. **无 Go 编译、无进程重启**。实测（2026-08-29）：磁盘改 `PLAYER_SPEED 220→440` → 重载 → 500ms 位移 132px→220px，精确生效。

新增游戏 = 在 games 目录新建子目录放 manifest+入口，点重载即出现在下拉。**repo 内 `web/games/` 只是 seed 源**：磁盘目录已存在时 seed 整体跳过该游戏（用户改动永不被覆盖）；要更新已 seed 的默认游戏须手动同步或删除磁盘目录后重启（重新 seed）。

## 5. 前端宿主（demo-games.js）

- **注册表**：`dgRegistry[id] = {def, src}`；`dgLoadGame` 注入 `/games/<id>/<entry>?v=<mtime>`，onload 后校验 `TRGames.register` 已被调用（未调用 → "did not call TRGames.register" 错误入状态行）；同 id 在途注入去重（`dgLoadPromises`）。
- **Phaser 懒加载**：`dgLoadPhaser()` 首次启动游戏时注入 vendor script，单例 promise；`window.Phaser` 缺失则报错。主页面零启动成本。
- **启动/停止**：`dgLaunch` = loadPhaser → loadGame → stop 旧局 → 清舞台 → `def.launch(host)`；`dgStopGame` = destroy/dispose → 清舞台 DOM → 解除测试台暂停 → 同步按钮态。
- **测试台暂停缝**：游戏运行时经 `window.__ademo.setPaused(true)` 冻结测试台物理/SM（`ademoLoop` 跳过 step，画面定格；`assistant-demo.js` 唯一为此新增的代码，6 行 + `isPaused` 查询）。停止/切页恢复。避免 WASD 同时驱动游戏与测试台实体。
- **布局**：`:has(.dg-root)` 门控——有游戏区时 `#page-content` 变滚动 flex 列（测试台 `flex:1 1 0; min-height:340px`，游戏区 `46vh` 舞台）；无游戏区时测试台独占，CSS 零影响（VM 测试守护 `:has` 门存在）。
- **UI**：游戏下拉（title+version）/启动/停止/重载按钮 + 状态行；空列表显示占位 option。i18n 键 `demoGames*`（en+zh 各 9 个）。
- **测试缝**：`window.__dgames = {registry, current(), makeHost, fetchList, loadGame, launch, stop, idRe, setCurrent}`（`setCurrent` 为 VM 测试后门，角色同 petSM.register）。

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

- Go：`go build ./...` + `go build -tags "tray webview" ./...`；`go test ./internal/api/games/ ./internal/config/`（list 校验跳过 ×4、state 404/PUT/GET/非法 JSON/遍历 id、SeedGames 全复制/跳过已存在/权限 Windows 感知）。
- JS 回归：`node web/demo-games.test.js`（16 项：接线 ×6、注册表 ×3、adapter ×4、stop ×3）；`node web/assistant-demo.test.js`（34 项，demo 路由断言已随 `renderDemoGames` 接线更新）。
- 浏览器实测（隔离实例 20199 + headless CDP，2026-08-29）：`/api/games` 列表含 survivor（v=mtime）；`/games/survivor/main.js` 200 + no-store（**首轮 404 → StripPrefix 修复**）；state PUT/GET 回环 + `gamedata/survivor.json` 落盘；游戏区渲染 + 下拉填充；启动后 Phaser 4.2.1 加载、canvas 挂载、测试台暂停；WASD 位移精确（220px/s × 0.6s = 132px）；敌机追击/自动炮塔击杀/受击 hp-1 且玩家存活（v4 参数顺序修复后）；gameOver 遮罩 + best 405 存档 PUT + R 重开 + best 回读；停止后 canvas 移除 + 暂停解除 + 按钮态同步；**热更新闭环：磁盘改速度 220→440 → 重载按钮 → 位移 220px/500ms 精确生效**。
- 已知非 bug：CDP `keyboard.press('r')`（down+up 同帧）偶发不触发 JustDown 重开，hold 400ms 必触发——CDP 时序假象，真机按键无此问题。

## 9. 变更维护清单（改这些必须同步本文）

| 变更 | 同步位置 |
|---|---|
| `GamesDir` 配置 / `ResolveGamesDir` 语义 | §1 配置行、`config/types.go`+`paths.go`+`paths_test.go`、PROJECT_MAP §3 |
| 插件契约（manifest 字段、TRGames.register、host adapter 面） | §2/§5、`demo-games.js` 头注释、`internal/api/games/register.go` 包注释、seed 游戏参考实现 |
| `/api/games*` 端点 / `/games/*` 静态 / seed 语义 | §3/§4、`register.go`+`register_test.go`、`router.go`、PROJECT_MAP §10 |
| Phaser 版本升级 / v4 新陷阱 | §1 vendor 行、§6、`vendor/phaser/README.md`（版本+SHA-256） |
| Demo 页游戏区 UI / 布局门 / 暂停缝 | §5、`demo-games.js`、`style.css`、`i18n.js`、`assistant-progress.md` §8（测试台侧） |
| seed 游戏增删 / 默认集内容 | §1 seed 行、`web/games/`、§8 验证行、PROJECT_MAP §18 |
| 运行时目录约定（games/gamedata） | §1、PROJECT_MAP §21 |

## 10. 路线图与框架决策记录

- **框架决策（2026-08-29 用户拍板）**：引入 Phaser **v4 最新版**（非 v3 稳定线），目的含熟悉 v4 实现；接受生态示例偏 v3 的代价（§6 陷阱自行趟平）。
- **插件化决策**：游戏=磁盘插件（§2），不为游戏内容重编译；模拟经营类若不需引擎可直接 vanilla 实现为插件（host 不强制用 Phaser）。
- **计划游戏**：①模拟经营 → ②吸血鬼幸存者（survivor seed 即原型起点，含 §6 教训）→ ③platformer / 横竖版飞机 → ④塔防。assistant 联动（`sheetImageUrl`/`llmChat`）已备，按需接入。
- **未做（刻意）**：fsnotify+SSE 自动重载（手动重载已够用）、游戏逻辑共享层入 embed（等第二个游戏沉淀出共性再说）、存档版本迁移机制。
