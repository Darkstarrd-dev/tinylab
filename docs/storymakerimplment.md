# Story Maker 迁移计划（novelhelper → TinyRouter Utility）

> **最后核对（2026-09-06，Story Maker 全量国际化与中英文多语言对齐）：** 完善全套 321 个 `story*` i18n 词条（`web/static/i18n.js` `L.en` 与 `L.cn` 100% 对称），全面重构 `storymaker.js`、`story-home.js`、`story-m0.js`、`story-m2.js`、`story-m3.js`、`story-m4.js`、`story-m5.js`、`story-batch.js`、`story-rolechat.js` 杜绝 UI 中文泄露，并确保 LLM 协议与数据存储契约安全。

## Context

将 `Z:/Playground/novelhelper` 小说生成部分迁移为 TinyRouter `Utility` 下新模块 `Story Maker`。
范围为截图侧边栏 8 项：书库概览 / M0立项架构 / M2设定卡片 / M3角色推演 / M4章节生成 / M5章节管理 / 批量生产 / 角色交流。
书库概览中的清理功能不迁（已在 utility→text review）。新模块保留原侧边栏版式但只保留文本内容并接入本项目 theme 系统；
各分页样式使用本项目 theme tokens + 自定义控件；模型选择用 text review step2/3 同款选择器；对照编辑用 text editor + step4 differ 设计；
图片生成用 playground→image 已有模块。持久化沿用原项目 SQLite（用户明确要求保留，仅 StoryMaker 单模块破例放宽本仓库禁 DB 规则）：
Go 标准库只有 `database/sql` 接口、不自带 sqlite 驱动，必须新增纯 Go 驱动 `modernc.org/sqlite`
（cgo 的 `mattn/go-sqlite3` 与全矩阵 `CGO_ENABLED=0` 冲突，禁用，依据 `build.ps1:132`/`build_mac.ps1:50` 已核实）。
DB 文件落在新增的 Default Story Path（默认 `<运行目录>/Story`，即 `{configDir}/Story`）下。LLM/图片走现有 `/v1/*` 代理。

## Approach

### Step 1 — Utility 注册与空壳挂载（前后端接线）

- 前端 `web/static/app-router.js`：`UTILITY_TOOLS` 数组末尾追加 `{ id: 'storyMaker', labelKey: 'storyMaker', requiresPlayground: true }`；
  `utilityHasTool` 加分支 `storyMaker → typeof window.renderStoryMaker === 'function'`；
  `utilityToolLifecycle` hooks 表加 `storyMaker: { suspend: 'suspendStoryMaker', resume: 'resumeStoryMaker' }`
  （suspend 关闭本模块 SSE/定时器，resume 为 noop；两者必须存在且为 window 全局函数，否则切页泄漏）；
  `renderUtility` 加分支 `if (utilityActiveTool === 'storyMaker') return window.renderStoryMaker(container);`；
  `navigateTo` switch 加 `case 'storyMaker': utilityActiveTool = 'storyMaker'; updateUtilityNavLabel(); return renderUtility(container);`；
  `navigateTo` 的 `!preserveUtilityState` 清理块加 `if (page !== 'storyMaker' && typeof cleanupStoryMaker === 'function') cleanupStoryMaker();`
  （与 `cleanupTextReview/cleanupGifEditor` 同列）；`isFullHeight` 条件式加 `|| page === 'storyMaker' || activeTool === 'storyMaker'`。
- `web/static/index.html` 与 `web/static/index-nopg.html`：`#utility-menu` 各加
  `<button type="button" role="menuitem" data-utility-tool="storyMaker">Story Maker</button>`；
  脚本块按序追加 `utility/story/storymaker.js`（shell）+ 各分页脚本 + `utility/story/storymaker.css`（link）。
  顺序约束：`vendor/diff.min.js` → `utility/editor/editor.js`（diff 引擎）→ `editor_textreview_diff.js`（applier）→ story 脚本。
  nopg 语义：入口 `requiresPlayground:true` + `utilityHasTool` 因 `window.__hasPlayground===false` 直接返回 false 隐藏菜单项；
  story 脚本在 nopg 仍加载无害，但 `renderStoryMaker` 永不被调用，不报错。
- `web/static/i18n.js`：en（`i18n.js:280` 附近）+cn（`:1239` 附近）各加
  `storyMaker: 'Story Maker' / '故事工坊'`（沿用 `updateUtilityNavLabel/updateUtilityMenuState` 自动拾取，无需改 auth.js/shortcuts）。
  并在同一文件为 8 个侧栏子项与各页可见文本新增 en+cn key（`storyHome/storyM0/storyM2/storyM3/storyM4/storyM5/storyBatch/storyRoleChat` 及按钮/空态/确认文案），
  禁止在 story 脚本中硬编码中文字面量。
- 后端新建 `internal/api/storymaker/register.go`：`type Handler struct{ Store *storymaker.Store; d *apibase.Deps }`
  （包 `internal/storymaker` 为存储层；handler 包 `internal/api/storymaker`；`apibase.Deps` 含 `ProxyHandler *proxy.Handler`，
  `Reg *registry.Registry`，`ConfigPath string`，已在 `apibase/deps.go:35` 核实）、
  `func NewHandler(d *apibase.Deps, s *storymaker.Store) *Handler`、`func (h *Handler) Register(r chi.Router)` 挂载下述路由并写路由文档注释（仿 `textreview/register.go:122` 风格）。
  LLM 中继正统写法（照搬 `internal/textreview/proxy_call.go:defaultProxyCaller.call` + `streaming_writer.go`，禁止 loopback HTTP）：
  组 OpenAI body `{model, messages:[{role:system},{role:user}], stream:true}`，
  `model` 由 `resolveModel` 归一（`/api/models` 的 `m.id` 即 `prefix/modelID` wire-ready 形，`forward_request.go:70-77` 按首段切分匹配 `Provider.Prefix`；
  `combo` 名直透；`textreview/proxy_call.go:resolveModel` 为唯一参照实现，Story 页照抄该函数，禁止自创拆分），
  `req := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(body))` + `X-TinyLab-Provenance: storymaker:<op>`，
  `go h.d.ProxyHandler.ChatCompletions(srw, req)` 并发消费 `srw.chunks` 逐行转 SSE 给前端（`Flusher` 逐 chunk 写，不缓冲攒包）。
  路由表（`Register` 内按此顺序挂载）：
  `GET /books` / `POST /books` / `PATCH /books/{id}` / `DELETE /books/{id}` / `GET /books/{id}/export?format=txt`
  / `GET /outline?bookId=` / `POST /outline:append`
  / `POST /arch-input|/arch|/blueprint`（SSE） / `POST /extract-entities`（SSE progress/entity/merge/done）
  / `POST /generate-card|/card-profiles|/generate-cards-batch` / `POST /simulate`（SSE） / `POST /draft`（SSE）
  / `POST /finalize` / `POST /consistency` / `POST /chat`（SSE） / `GET|PUT /prompts/{key}`。
- `go.mod` 新增 `modernc.org/sqlite`（执行 `go get modernc.org/sqlite && go mod tidy` 取最新纯 Go 版 pinned 到 go.mod；
  `database/sql` 兼容，保持 `CGO_ENABLED=0` 与 Windows→darwin 交叉编译；`mattn/go-sqlite3` 需 cgo/gcc，禁用）。
  新建 `internal/storymaker/store.go`：`import _ "modernc.org/sqlite"`，`type Store struct{ DB *sql.DB; dir string }`，
  `func Open(dir string) (*Store, error)` 打开 `{storyDir}/story.db`（`sql.Open("sqlite", dsn)`，`db.Ping()` 后建表；
  DSN 形如 `file:<dbPath>?cache=shared` 并执行 `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000`，
  照搬原项目 `db.ts:getDb` 的 WAL + 5000ms 超时；modernc DSN 的 `_pragma` 参数写法 unverified — confirm first，落地以 `sql.Open` 成功 + `PRAGMA` 生效为准），
  建表沿用原项目文档式契约（`Z:/Playground/novelhelper/server/src/store/db.ts` ENTITIES）：
  每实体一张表 `(id TEXT PRIMARY KEY, data TEXT NOT NULL)`，表集合
  `books/chapters/cards/outline/scenes/fragments/state_events/issues/architectures/merge_candidates/prompts`
  （`prompts` 存各页 prompt 覆盖，key 即 prompt key；不移植 `test_history/chat_sessions`（节点测试不在范围）、
  `chunk_meta/vec_chunks`（sqlite-vec 无纯 Go 等价，v1 不做 RAG）；图片只存文件 URL/路径，绝不存 BLOB）。
  写入语义照搬原项目安全契约：`syncAll` 只 upsert（`INSERT … ON CONFLICT(id) DO UPDATE`），永不删除；
  删除走白名单 `deleteEntities(table, ids)`；`readAll` 逐行容错（单行 JSON 坏跳过并继续）。
  `storyDir` 经 `config.ResolveStoryDir(cfg.StoryDir, filepath.Dir(configPath))` 解析，`Open` 前 `MkdirAll`，
  images 子目录 `{storyDir}/images` 随建；绝不使用 raw path，只收 id/JSON body。
- `internal/api/router.go` `Routes()` 构造 `storymaker.NewHandler` 并传入 `registerUtilityRoutes`；
  `internal/api/router_utility.go` 加 `r.Route("/api/storymaker", AuthMiddleware + MaxBytesReader 32MiB + feature.Enabled(feature.Editor))`。
  Body 上限 32MiB 与 editor/text-review 对齐（章节批量大文本）。
- `internal/feature/feature.go`：`registerDefaults` 的 Editor `StaticFiles` 列表中插入 story 脚本/CSS
-  （位置：`editor_textreview_step4.js` 之后、`editor_textreview.js` 之前，即倒数第三位起；
-  `feature_test.go:202 TestEditorReviewAssetLoadsLast` 强制末两位为 `editor_textreview.js`→`review.js`，story 资产绝不插进末两位）。
-  `index.html`/`index-nopg.html` 的 `<script>` 顺序与 feature 列表保持一致（story `<script>` 同样插在 `editor_textreview.js` 之前、`review.js` 保持末位），防止加载序漂移。

### Step 1B — Default Story Path 配置链路（Settings→Path Settings）

- `internal/config/types.go`：`MusicDir` 旁加 `StoryDir string \`yaml:"storyDir,omitempty" json:"storyDir,omitempty"\``，
  注释 `Managed via Settings → Path Settings → Default Story Path`。
- `internal/config/paths.go`：加 `ResolveStoryDir` 照抄 `ResolveMusicDir` 三段式（空→`{configDir}/Story`，configDir 空则 `"Story"`；
  相对→join；绝对→原样）；`paths_test.go` 加 `TestResolveStoryDir` 镜像既有表测。
- `internal/api/settings/register.go`：GET map 加 `"storyDir": cfg.StoryDir`；updates struct 加 `StoryDir *string`；
  PATCH 照抄 MusicDir 分支（含 `fsutil.PathGuard` 收敛到 configDir 内，报错 `storyDir must be inside config directory`；
  nil=不动，空串=显式恢复默认）。切换目录不搬运旧 DB（只改指向，重启生效），避免误覆。
- `web/static/download-settings.js`：`openPathSettingsModal` 头注释 sections 列表加 `storyDir`，加 row 段
  （读 `res.storyDir`，placeholder/初始 `configDir + '/Story'`，`browseRow('storyDir', 'modal-dl-story-dir', …, 'directory', null, …)`），
  save 段加 `payload.storyDir`。
- `web/static/settings/settings_modal.js`：`openPathModal` sections 加 `storyDir:true`；
  `web/static/i18n.js` en+cn 镜像 musicDir 行加 `storyDir/storyDirDesc`（默认 `{configDir}/Story`）。
- 本模块后端根目录一律 `ResolveStoryDir` 结果，永不相对 CWD。

### Step 2 — Story Maker 壳 + 左侧边栏（版式复刻、仅文本）

- 新建 `web/static/utility/story/storymaker.css`：只用 theme tokens
  (`background:var(--glass-bg); border:1px solid var(--glass-border); color:var(--text); --accent; --radius-md`)，
  禁止 antd 样式与字面色。布局：`.sm-layout`（左 220px 侧栏 + 右内容区），侧栏项沿用 `.utility-menu button` 视觉（含 `::before` 指示条 + `aria-current="page"`）。
- 新建 `web/static/utility/story/storymaker.js`：暴露
  `window.renderStoryMaker(container)` / `window.suspendStoryMaker` / `window.resumeStoryMaker` / `window.cleanupStoryMaker`。
  `renderStoryMaker` 渲染 8 项侧栏（书库概览/M0/M2/M3/M4/M5/批量生产/角色交流，图标用纯文本或现有 svg，不引入 antd icons），
  点击切换调用对应 `storyRender<Home|M0|M2|M3|M4|M5|Batch|RoleChat>(contentEl, ctx)`；`ctx = { store: storyApi, t }`。
  切换页时调用上页 `cleanup`（关 SSE/定时器，仿 `trCleanupStep4`）。空/缺/冲突处理：无 book 时各页显示空态 + “去书库新建”按钮，不抛错。

### Step 3 — 书库概览页（`story-home.js`）

- 复刻 `novelhelper/frontend/src/pages/home/index.tsx` 表格列：书名/类型（project=作品/reference=素材）/作者/平台/章节数/卡片数/创建时间/操作（查看/编辑 title-author-platform/导出 txt/删除 confirm）。
- 数据经新后端：`GET /api/storymaker/books`、`POST /api/storymaker/books`（新建 project + 首条 architecture 空壳）、
  `PATCH /api/storymaker/books/{id}`、`DELETE /api/storymaker/books/{id}`、`GET /api/storymaker/books/{id}/export?format=txt`（Blob 下载）。
  类型：`Book{id,title,author,platform,type:project|reference,createdAt}`、`Chapter{id,bookId,title,status:raw|cleaned|draft|final,updatedAt}`（对齐 novelhelper `types.ts`，仅取用字段）。
- 控件：过滤/按钮用 `renderCustomSelectHtml`（类型过滤）+ 原生 button；删除用 `confirmModal`（`app-modal.js`）。

### Step 4 — M0 立项架构（`story-m0.js`，SSE）

- 复刻 `m0-architecture/index.tsx`：输入 topic/genre/chapters（默认 30，`renderStepperHtml`）/guidance + 4 字段 arch 编辑器（seed/characterDynamics/worldBuilding/plotStructure）+ blueprint 预览表 + 采纳按钮。
- 模型选择：arch/blueprint 各一个 `.tr-model-select-btn` 风格按钮（仿 `editor_textreview_step2.js:570` / `step3.js:454` 结构），
  直接调用 `pgOpenModelPicker(cur, cb, {kindFilter:'text'})`（`pg-modal.js:741`；`app-modal.js:77` 的 `openModelPickerModal(cur, cb)` 会吞掉 `opts`，
  text/image 过滤必须走 `pgOpenModelPicker` 第三参）。选择值存页面态为 `{value, label}`（`value` 即 `GET /api/models` 的 `m.id`，
  如需展示 provider 前缀由调用方自行拼接如 Step3 的 `providerId/modelId`），不再做 novelhelper node-pool `ModuleKey/moduleMapping`。
  该 `value` 直接作为后端 `POST /api/storymaker/*` 请求体 `model` 字段；后端原样填入 `/v1/chat/completions` 的 `model`。
  `providerId/modelId` 拆分与 `realModelId` 归一不可在 Story 页实现（那是 Step3 自管 `window._trS3ModalModels` 缓存的私活），
  若 `m.id` 非 wire-ready 由后端透传报错向上抛，不在本计划兜底。
- 后端 `POST /api/storymaker/arch-input|/arch|/blueprint`（SSE透传）：handler 将请求体 `{model, params}` 经站内 `/v1/chat/completions` 代理转发（复用 rotation/重试），
  前端用 `fetch + ReadableStream` 逐 chunk 追加文本（仿 text-review SSE 消费，不引入 `parseSSE/streamSSE` 新依赖）。
  `adoptArch` → `POST /api/storymaker/books`（新建 project Book + architecture）；`adoptBlueprint` → `POST /api/storymaker/outline:append`。
- Prompt 覆盖：页内 `<details>` 折叠 textarea（arch-input/arch/blueprint 三 key），`GET/PUT /api/storymaker/prompts/{key}`，替代 `PromptEditorButton/PROMPT_REGISTRY`。

### Step 5 — M2 设定卡片（`story-m2.js`，图片走 playground 模块）

- 复刻 `m2-cards`：scope（all/project）+ typeFilter（all/character/location/item/skill/faction）+ keyword（`renderCustomSelectHtml` 下拉 + search input）+ Tabs（卡片/合并）+ CardGrid（查看/编辑/删除/生图）+ ExtractModal + CardEditorModal（手动/AI）+ BatchCardModal + ImageBatchModal。
- 类型：`EntityCard{id,bookId,type,name,summary,detail,refs,images:CardImage{url}[]}`、`MergeCandidate`（对齐 `types.ts`）。
- 模型选择：extract 用 `pgOpenModelPicker(cur, cb, {kindFilter:'text'})`；生图用 `pgOpenModelPicker(cur, cb, {kindFilter:'image'})`
  （`pg-modal.js:764-771` 按 `m.kind` 过滤；禁止经 `openModelPickerModal` 桥接，同 Step 4 原因）。
- 文本后端：`POST /api/storymaker/extract-entities`（SSE progress/entity/merge/done）、`/generate-card|/card-profiles|/generate-cards-batch`（JSON/SSE 二选一，与 M0 同管线）。
- 图片后端：不新建图片协议。唯一入口 `pgTaskEnqueue(winIndex, prompt, snapshot)`（`pg-image-tasks.js:175`，已核实签名）：
  Story M2 调用 `pgTaskEnqueue(pgState.activeWin, prompt, {protocol, model, params:{imgSubmitCount}})`，
  返回 `generation`（含 `assets[]`），底层走 `POST /v1/images/generations|edits` + modelscope `/v1/tasks/{id}` 轮询
  （`pg-image-model.js:remoteSubmit`）。注意 `pgTaskEnqueue` 强依赖 playground 窗口态（`pgWinAt(winIndex)` + `w.config`），
  不能在 Story 页独立构造假 window 调用低阶 `pgImageBuildRequest/PlanUnits/ExecUnit`（三者签名已核实存在，但 `w` 必须是真实 `pgState.windows` 元素）；
  如需自定义 UI，复用 `snapshot` 参数透传 protocol/model/params 而不是自建 window。卡片图片落盘只存 URL
  （`GET /api/image-proxy?url=` 代理显示，`pg-modal.js:517 pgImageProxyURL`），与 `CardImage` 约定一致。
  并发数用 `renderStepperHtml`（默认 3，上限硬上限 8，与 `pg-image-tasks.js:39 Math.min(8, v||1)` 一致）。
  Story 页使用 `pgTaskEnqueue/pgOpenModelPicker` 的前提是 playground 脚本已随 `index.html` 全局加载（静态 `<script>`，见 `index.html:200-271` 区段）；
  若未来该加载被 nopg/裁剪破坏，fallback 为 Story 自渲染模型列表 modal + 直接 `fetch('/v1/images/generations')`，但当前构建不要求实现该 fallback。

### Step 6 — M3 角色推演（`story-m3.js`）+ M4 章节生成（`story-m4.js`）

- M3 复刻 `m3-simulate/index.tsx`：场景 select（`renderCustomSelectHtml`）+ 目标角色 select + 新建场景表单 + 双候选展示 + 采纳→sequence（上移/下移/删除）+ 上下文 `<details>` 预览。
  后端 `POST /api/storymaker/simulate{bookId,sceneId,targetCharacterId,candidateCount:2}`（SSE 双候选，context 由后端 6 组件 Assembler 简化版组装：book+scene+target card+outline slice+prev summary）。
  Prompt 覆盖 `m3-simulate` 同 Step 4 机制。存储 `scenes/fragments{SimScene,SimFragment{candidates,adoptedText,order}}`。
- M4 复刻 `m4-generate/index.tsx`（mock 单页版转正）：大纲节点 select + summaryDraft 可编辑 + 已采纳片段 checkbox 硬约束（未勾选片段绝不进 prompt）+ 生成 + draft 编辑 + 保存（覆盖 confirm）。
  后端 `POST /api/storymaker/draft{bookId,chapterIndex,userGuidance,targetWordCount}`（SSE，走 `/v1/chat/completions`）。
  对照编辑：draft 新旧文本对比用 `editorAlignedDiff(oldText,newText)`（`editor.js:19`，依赖 `/vendor/diff.min.js`）+
  `TR.applyLineDecisions(rows, decisions)`（`editor_textreview_diff.js`）自绘两列接受/拒绝/改写行（accept/reject/edit + 批量 + 重置），样式抄 step4 的 `.tr-s4-*` 但换 `.sm-diff-*` 类名 + theme tokens；
  不直接复用 `trRenderStep4`（其 state 与 text-review session 强耦合）。

### Step 7 — M5 章节管理（`story-m5.js`）+ 批量生产（`story-batch.js`）

- M5 复刻 `m5-chapters/index.tsx`：book select + Tabs（章节管理/状态时间线）+ 章节 Table（#/标题→viewer Drawer/状态 Tag/字数/大纲节点/冲突数/更新/操作：定稿+检查(draft)/手动检查/退回草稿(final)）+ viewer 抽屉（编辑/保存，final 编辑降级 draft）+ report 抽屉（忽略/已处理）+ 时间线角色 select。
  后端 `POST /api/storymaker/finalize{chapterText,existingGlobalSummary,existingStates}→{summary,stateEvents}`、
  `POST /api/storymaker/consistency{chapterText,...}→{issues:ConsistencyIssue[]}`（均为 SSE/JSON，走 `/v1/chat/completions`）。
  类型 `StateEvent{location|relationship|injury|possession|death|other}`、`ConsistencyIssue{error|warning,open|ignored|resolved,relatedCardIds}`（只取用字段）。
  章节 diff 同 Step 6 自绘两列（finalize 前后对照）。
- 批量复刻 `batch-generate/index.tsx + real/batch.ts`：章节多选 + start/pause/resume/stop + `TaskState{pending/drafting/finalizing/completed/failed,progress}` Progress/List。
  调度放在前端 worker-loop（`pickLeastLoaded` 简化为顺序轮询已选 text 模型），按序串行 draft→finalize、fail-fast 写 `chapters`；
  Prompt 覆盖 `m4-draft/m5-finalize` 同 Step 4。取消用 AbortController（仿 role-chat inflight map）。

### Step 8 — 角色交流（`story-rolechat.js`）

- 复刻 `role-chat/index.tsx + roleChatEngine.ts`：参与者（卡多选 + 逐卡模型按钮 `pgOpenModelPicker(cur, cb, {kindFilter:'text'})`）+ 场景设定 + 发送（顺序 `respondParticipant`）+ 自动循环（mode/count-duration/variance/cooldown/reactionDelay，abortRef + 切页 cancel）+ per-participant 实时推理视图 + sidebar/export JSON。
- 后端仅需 `POST /api/storymaker/chat{messages,model}` SSE 中继到 `/v1/chat/completions`（替代 novelhelper 通用 `/api/llm/chat`）；
  system prompt 沿用 `buildRoleSystemPrompt` 语义（own→assistant、others 合并 user、前缀缓存确定性），以前端函数实现。
  存储：内存运行态 + `autoConfig` 经 `PUT /api/storymaker/prompts/rolechat-auto` 持久化；会话导出 JSON Blob 下载（仿 `trS4Download`）。

## Critical files & anchors

- `Z:/Playground/novelhelper/server/src/store/db.ts` — ENTITIES 文档式表集 + upsert-only/显删/逐行容错契约 + WAL/`busy_timeout=5000`，sqlite schema 唯一来源。
- `Z:/Playground/novelhelper/frontend/src/services/types.ts` — Book/Chapter/EntityCard/OutlineNode/SimScene/SimFragment/StateEvent/ConsistencyIssue/RoleChat* 全量类型契约。
- `Z:/Playground/tinyrouter/web/static/app-router.js` — UTILITY_TOOLS/dispatch/lifecycle，新工具唯一注册点。
- `Z:/Playground/tinyrouter/internal/api/settings/register.go` — GET map + presence-aware PATCH + `fsutil.PathGuard` 收敛范式，StoryDir 镜像对象。
- `Z:/Playground/tinyrouter/web/playground/static-pg/playground/pg-image-tasks.js` — `pgTaskEnqueue` 图片生成唯一入口。

## Verification

- `go build ./...`（`CGO_ENABLED=0` 矩阵不受影响，modernc 纯 Go）+ `go test ./internal/api/... ./internal/feature/... ./internal/config/... ./internal/storymaker/...`
  （含 `TestEditorReviewAssetLoadsLast` 类顺序测试 + 新增 `TestResolveStoryDir` + store 的 upsert-only/delete白名单/坏行容错单测）通过。
- 手动（默认构建 `go build -o tinylab .` 运行，打开 Utility→Story Maker）：
  1. 八项侧栏切换正常；light/dark + variant 切换下无字面色（全走 tokens）。
  2. 书库：新建 project → M0 生成 arch（SSE 逐字）→ 采纳成书 → blueprint 采纳进 outline。
  3. M2：extract 出卡 → AI 单卡 → 批量卡 → 选 image 模型 `pgTaskEnqueue` 出图并挂到卡片。
  4. M3 双候选采纳进 sequence；M4 片段勾选约束生效 + draft diff 接受/拒绝/改写落盘正确；M5 定稿→检查→忽略/已处理流转；批量 start→pause/resume→stop 状态机正确；角色交流双人发送 + 自动循环可取消 + 导出 JSON。
  5. `-tags nopg` 构建（`index-nopg.html`）下 Story Maker 因 `requiresPlayground` 隐藏且不报错。
  6. Settings→Path Settings 出现 Default Story Path（默认 `{configDir}/Story`），browse/保存/重启后 `GET /api/settings` 回显一致；
  Story Maker 内建书建卡后重启进程，书/卡/章节均从 `{storyDir}/story.db` 恢复（图片在 `{storyDir}/images` 为文件）。

## Assumptions & contingencies

- AGENTS.md 禁 DB 规则：经用户明确要求，仅 StoryMaker 单模块破例使用 SQLite（`modernc.org/sqlite`），其他模块仍禁 DB。
- `modernc.org/sqlite` 使各产物增大约 8–15MB（13 变体 + 2 mac 二进制全部受影响），故事文档负载可接受；
  若体积不可接受，备选是 store 换回文件 JSON（路由契约不变），需用户另行批准后才执行。
- LLM/图片全部走站内 `/v1/*` 代理 + `openModelPickerModal` 选择，不移植 novelhelper node-pool/`ModuleKey`/`moduleMapping`；若某页必须多节点调度，复用 `GET /api/models` 列表在前端轮询，仍不建新调度表。
- M4/M5 真实生成以 `services/real/generation.ts` 语义为准而非 mock 串联；mock 的“已死角色本地规则”不移植，一律走 `/consistency` 上游判定。
- 图片仅 M2 需要；若 M0/M4 提出封面/插图需求，同样调用 `pgTaskEnqueue`，不另建图片管线。

## Appendix — 执行上下文（实现者直读，无需回查原项目）

### A. Prompt 注册表（`novelhelper/server/src/prompts.ts:581-596`，13 key）
`m0-arch-input=ARCH_INPUT_PROMPT`（JSON `{topic,genre,guidance}`）/ `m0-arch=ARCH_SYSTEM_PROMPT`（四分区 `## 核心种子/角色动力学/世界观/三幕式情节`）
/ `m0-blueprint=BLUEPRINT_SYSTEM_PROMPT`（每章块 `第N章 [标题]` + 定位/核心作用/悬念密度/伏笔/认知颠覆★/简述，单次≤20章）
/ `m2-extract=EXTRACT_ENTITIES_SYSTEM_PROMPT` / `m2-card-single=GENERATE_CARD_SYSTEM_PROMPT`
/ `m2-card-image-prompts=CARD_IMAGE_PROMPTS_SYSTEM_PROMPT` / `m2-card-profiles=GENERATE_CARD_PROFILES_SYSTEM_PROMPT`
/ `m2-cards-batch=GENERATE_CARDS_BATCH_SYSTEM_PROMPT` / `m3-simulate=SIMULATE_CHARACTER_SYSTEM_PROMPT`
/ `m4-draft=DRAFT_SYSTEM_PROMPT` / `m5-finalize=FINALIZE_SYSTEM_PROMPT` / `m5-consistency=CONSISTENCY_SYSTEM_PROMPT`。
Story 后端 `prompts` 表初始值即以上常量全文（从 `prompts.ts` 逐字拷贝）；`GET|PUT /api/storymaker/prompts/{key}` 覆盖；缺 key 回退常量。
M0 前端解析照搬 `m0-architecture/parse.ts`：`ARCH_SECTION_MAP`（核心种子/种子→seed，角色动力学/角色动态→characterDynamics，
世界观/世界构建→worldBuilding，三幕式情节/三幕式/情节架构→plotStructure，按 `## ` 切分，失配拼尾不丢；全无分区塞 seed），
蓝图按行首 `第N章` 分块、`field(name)` 取 `名：`后内容、`parseTwist` 数★1–5。

### B. 存储实体字段（`novelhelper/.../services/types.ts` 全量照搬 JSON `data`）
`Book{id,title,type:project|reference,createdAt,globalSummary?,author?,platform?}`
`Chapter{id,bookId,index,title,content,status:raw|cleaned|draft|final,outlineNodeId?,summary?,updatedAt}`
`EntityCard{id,bookId,type:character|location|item|skill|faction,name,aliases[],fields{},description,styleNote?,styleExamples[],refs[]{chapterId,excerpt},images?[]{id,url,prompt,group?,createdAt},coverImageId?,updatedAt}`
`OutlineNode{id,bookId,volume,title,summary,order,positioning?,role?,suspenseDensity?,foreshadow?,twistLevel?}`
`NovelArchitecture{id,bookId,seed,characterDynamics,worldBuilding,plotStructure,updatedAt}`（一书一条）
`SimScene{id,bookId,desc,goal,prevSummary,presentCharacterIds[],createdAt}`
`SimFragment{id,sceneId,characterId,candidates[]{id,text},adoptedText?,order,createdAt}`
`StateEvent{id,bookId,chapterId,entityId,eventType:location|relationship|injury|possession|death|other,description,createdAt}`
`ConsistencyIssue{id,bookId,chapterId,type,level:error|warning,description,relatedCardIds[],suggestion,status:open|ignored|resolved}`
`RoleChat` 仅内存（`Participant{id,name,cardId,nodeId→改存model,avatar?,color,status}`/`Message{id,participantId,participantName,content,timestamp,isUser?}`/
`AutoConfig{mode:count|time,count,duration,variance,cooldownBase,cooldownVariance,reactionDelayMin,Max}`），`autoConfig` 存 `prompts/rolechat-auto`。
`MergeCandidate{id,cardAId,cardBId,similarity,status:pending|merged|kept}`。
`BookType reference|project` 空串 bookId 素材归属、`ChapterStatus`、`EntityType`、`IssueLevel/Status` 枚举原样。
`readAll` 逐行 `JSON.parse` try/catch 跳坏行；`syncAll` 仅 `INSERT ON CONFLICT DO UPDATE`；删走 `deleteEntities` 白名单表名校验。

### C. 各端点 user prompt 组装（后端拼装，前端只传 inputs + systemPrompt 覆盖）
`arch-input{topic?,genre?,chapters?,guidance?}`→user 原样拼输入；`arch{topic,genre,guidance}`→user 拼三者；
`blueprint{architecture,existingOutline?,startChapter}`→user 拼架构+已有目录+起始章；
`extract{chapters[]{title,content},existingNames[]}`→user 拼章节+已有名，SSE 事件 `progress{stage:extracting|embedding|merging,current,total}`/`entity{card}`/`merge{candidate}`/`done{cards,mergeCandidates}`；
`generate-card{type,instruction,mode:create|enrich,existingCard?}`→`{card:GeneratedCard{name,aliases,description,fields,styleNote?,styleExamples?}}`
（`serializeCardForEnrich` 格式 `名称/别名/描述/字段/语言风格/台词例句`）；`card-profiles{type,count,instruction}`→`{profiles[]{name,brief}}`；
`generate-cards-batch{type,profiles[],instruction}`→`{cards[]}`；`card-image-prompts{cardDescription,intent,count}`→`{prompts[]{label,prompt}}`；
`simulate{scene,targetCard,candidateCount:2}`→user 拼场景+目标卡+在场卡，SSE `delta{candidateIdx,delta}` 双路累积；
`draft{assembled, userGuidance?,targetWordCount?}`（`assembled` 见 D）→纯文本 SSE；
`finalize{chapterText,existingGlobalSummary?,existingStates?}`→流式 JSON 去 ```json 围栏后 `JSON.parse` 得 `{chapterSummary,globalSummaryDelta,stateEvents[]{characterId,type,description,timestamp}}`；
`consistency{chapterText,architecture?,characterStates?,previousSummary?}`→同理得 `{status:通过|警告|严重错误,issues[]{severity:严重|警告|提示,dimension:角色一致性|世界观逻辑|剧情连贯性,description,suggestion}}`，
后端映射 severity→error|warning、dimension+description→type/description 存 `issues` 表；
`chat{messages[{role:system|user|assistant,content}],model}`→OpenAI SSE 直透（role-chat 专用）。
`buildRoleSystemPrompt(card,sceneSetting)` 逐行：扮演声明+别名+`【角色设定】description`+`【属性】fields`+`【语言风格】styleNote`+
`【台词示例】styleExamples`+`【当前场景】sceneSetting`+只输出本人发言约束；`buildParticipantMessages` 自己→assistant、他人（含用户）`发言者：内容`合并 user 交替，
空流兜底 user `（请根据你的角色设定，开启对话）`，保证 prompt cache 前缀稳定。
批量 `startBatchGenerate` 语义：任务 `{chapterId,outlineNodeId,draftContext,existingGlobalSummary?,existingStates?}` 按序 draft→finalize 串行，
单任务失败 `onError` 后 `stopped=true` 清空队列 + abort 在途（fail-fast 防剧情崩坏）；`pause/resume/stop` + `updateNodes` 照搬 `batch.ts:124-234`。
M4/M5 以 `real/generation.ts` 为准，mock 已死角色规则不移植。

### D. Context Assembler（后端 `assembleContext` 照搬 `contextAssembler.ts:63-131`，RAG 除外）
输入 `{bookId,chapterIndex?,sceneId?,targetCharacterId?}`；输出 `{architecture,currentOutline(order===index),nextOutline(order===index+1),
globalSummary,prevChapterSummary(index-1 的 summary),characterTimeline(该角色 state_events 按 createdAt 升序),adoptedFragments(该 scene 已采纳按 order 升序),
scene,targetCharacter,presentCharacters}`。RAG（`rag/queryVectorStore/vec_chunks`）v1 不做，输入 `rag?` 直接忽略。
M3 user=scene+target+present+characterTimeline+adoptedFragments；M4 user=currentOutline+adoptedFragments(勾选子集)+prevChapterSummary+globalSummary+characterTimeline。

### E. 前端集成清单（新文件与依赖）
新文件：`web/static/utility/story/storymaker.css` + `storymaker.js`（shell：`renderStoryMaker/suspendStoryMaker/resumeStoryMaker/cleanupStoryMaker`）
+ `story-home.js`/`story-m0.js`/`story-m2.js`/`story-m3.js`/`story-m4.js`/`story-m5.js`/`story-batch.js`/`story-rolechat.js`
（各暴露 `storyRender<Home|M0|M2|M3|M4|M5|Batch|RoleChat>(el,ctx)` + `storyCleanup<Name>()`），`ctx={api:{get,post,patch,del,sse}, t}`。
依赖（禁止自研）：`renderCustomSelectHtml/renderStepperHtml`（`app.js:411,495` 全局函数）/`confirmModal`/`browseRow` 弹窗范式
（`download-settings.js:openPathSettingsModal`）/`editorAlignedDiff`（`editor.js:19`，需 `/vendor/diff.min.js` 先加载）
+`TR.applyLineDecisions`（`editor_textreview_diff.js:38`）/`pgOpenModelPicker(cur,cb,{kindFilter})`（`pg-modal.js:741`）
+`pgTaskEnqueue`（`pg-image-tasks.js:175`）/SSE `fetch+ReadableStream`（仿 text-review 消费）。
主题：全样式走 `var(--glass-bg/--glass-border/--text/--text-secondary/--accent/--radius-md)`（`theme.js` ThemeSystem + `style.css` tokens），无字面色/antd。
文件头注释写清依赖脚本顺序；`cleanupStoryMaker` 关闭全部分页 SSE/AbortController/定时器。

### F. 落盘说明
本文件为执行唯一依据；实施时另存为 `docs/storymakerimplment.md`（注意拼写与用户指定一致）后按序执行 Step 1→1B→2→…→8，每步后跑 Verification 对应项。

### G. 样式修正维护记录（2026-09-06）
1. **Books 页面按钮高度对齐**：`.sm-page-actions .btn` 与 `.custom-select-trigger` 均统一定义为 `height: 36px`，`box-sizing: border-box`；`story-home.js` 头部筛选下拉包装容器与组件高度统一定为 36px，解决原本 38px/29px 高度不一致与不对齐问题。
2. **下拉菜单与触发器间距**：为 `.sm-page-container .custom-select-menu` 与 `.modal .custom-select-menu` 统一定义 `top: calc(100% + 6px)`，消除 wrapper 高度错配导致的倒扣重叠，保留紧凑且舒适的呼吸间隙，且不影响选项交互与操作。
3. **New Book 弹窗自定义下拉菜单**：将 New Book 弹窗内的 Type 原生 `<select>` 替换为项目标准 `renderCustomSelectHtml('sm-new-type-wrap', 'sm-new-type', ...)`，并在确认创建时保持读取底层 select 的值；弹窗使用项目标准 `.modal`、`.modal-footer` 与 `overflow: visible`，确保完全契合暗黑毛玻璃风格与防裁剪。
4. **移除冗余关闭按钮**：移除弹窗头部原有的 `modal-close-btn`（`[x]`），保留底部 Cancel/Confirm 按钮及遮罩点击关闭。
5. **移除侧边栏与空态图形**：从 `storymaker.js` 侧栏标题中移除 `📖`、从 8 个 Tab 按钮中移除 `📚/🏛️/🃏/🎭/✍️/📑/⚡/💬` 等 emoji 图标，从空态页面移除 `Go to Books` 上方的 `📖` 图标，仅保留清爽的纯文字与操作按钮。
