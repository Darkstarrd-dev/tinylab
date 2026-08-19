# 小精灵助手实施计划

> 自包含、可直接实施。背景见 [`docs/assistant_contract_research.md`](docs/assistant_contract_research.md)。
> 实施全程不得改 `cmd/assistant-bench/` 与 `autoresearch.sh`（off-limits judge）。

## 0. 当前状态（已建成，可直接复用）

**契约系统已就绪并验证（bench 100% / drift 已实证）**：

- `internal/assistant/semantics.json`——**唯一真相源**：`{rules:[{tool,method,path,needsModel,keywords[],all[],none[],desc}], jobs:[{name,intervalSec}]}`。当前 24 rules / 22 distinct tools / 2 jobs。
- `internal/assistant/catalog.go`——`LoadContract() (*Contract,error)`（`//go:embed`）；`(*Contract) BuildAssistant(routeSet map[string]bool, hasModelRoute bool) (*Assistant, []string)`：契约规则只在 `(method,path)∈routeSet` 注册工具+加分类规则，其余收集为 drift。**零手维护工具表/规则表。**
- `internal/assistant/assistant.go`——`Assistant`：`Classify(intent string) []string`、`Resolve(name string) (ToolSpec,bool)`、`Scheduler() *Scheduler`（`Has(name) bool`）、`HasModelRoute() bool`、`Registry() *ToolRegistry`（`Count() int`）。`ToolSpec{Name,Method,Path,NeedsModel}`，`MethodPath()`→`"METHOD path"`。`Scheduler.RegisterJob(Job{Name,IntervalSec})`。
- `cmd/assistant-bench/main.go`——裁决 bench：进程内构造真实 `*api.Router`，`chi.Walk` 得 179 条真实路由作 `routeSet`，`LoadContract`+`BuildAssistant`，跑 30 意图 → `assistant_readiness = dispatch_f1 × contract_health`。

**真实路由获取（实施时复用）**：`api.New(reg,cfg,configPath,usageBuf,pgUsage,quotaTracker,logger,proxyHandler,shutdown,selector,comboRes,downloadMgr) *Router` → `(*Router).Routes(proxyHandler) http.Handler` → 断言 `chi.Router` → `chi.Walk(cr, func(method,route string, _ http.Handler, _ ...func(http.Handler)http.Handler) error{...})`。`PasswordEnabled=false` 开放管理路由（仅 walking 不发请求，鉴权无关）。

**关键 API 锚点**（实施时直接引用）：
- `apibase.Deps{Reg, ProxyHandler, Logger, …}`（`internal/api/apibase/deps.go`）——所有 `internal/api/*` 子包 handler 的共享依赖。
- `proxy.Handler` 方法（`internal/proxy/handler.go`）：`ChatCompletions/ImagesGenerations/ImagesEdits/Embeddings(w,r)`、`TaskGet(w,r,taskID,modelStr)`、`ListModels`。`/v1/chat/completions` **已透明透传 `tool_calls`**。
- `proxy.Handler.SweepTraces(ctx, retainDays, maxDiskMB)`（`request_log.go`）——定时清理原型。
- 子包 handler 装配范式（见 `internal/api/editor/register.go`、`internal/api/imagebatch/register.go`）：`type Handler struct{d *apibase.Deps; …}` + `Register(r chi.Router)`，在 `router.go::Routes` 内 `r.Route("/api/<area>", func(r){ r.Use(authHandler.AuthMiddleware); h.Register(r) })` 挂载。

## 1. 实施目标

把契约系统从"静态 dispatch 大脑"升级为**端到端可用的小精灵**：
1. 真实 `/api/assistant/*` 端点：把契约 catalog 暴露成 OpenAI tool schema；接收用户意图或客户端 `tool_calls`，dispatch 到真实路由；SSE 流式回传进度。
2. Scheduler 物化：把 `clean-traces/clean-traces-daily` 落成 goroutine（复用 `SweepTraces`），暴露 `/api/assistant/jobs` CRUD。
3. gap 检测（bench 增强）：报告 `chi.Walk` 中存在但契约未覆盖的"能力路由"，引导补契约（补 added-feature 同步的另一面）。
4. 前端"跳转/直接执行"：assistant 返回 tool+route，前端按 route 跳页或直接调 `/api`。
5. LLM tool-calling 分类器：用项目自身 `/v1/chat/completions`（透传 `tool_calls`）替换关键词大脑，覆盖开放词表意图。

## 2. 契约格式参考（扩展时遵循）

新增能力 = 在 `semantics.json` 加 rule（同步规范）。bench 会在下次运行校验其 `(method,path)` ∈ 真实 chi 路由集，否则 drift→readiness 下降。示例（加"重命名文档"能力）：
```jsonc
{"tool":"editor.rename","method":"POST","path":"/api/editor/rename",
 "keywords":["重命名","改名","rename"],"desc":"重命名文档"}
```

## 3. 不变量（不可破坏）

- `cmd/assistant-bench/` 与 `autoresearch.sh` 不可改（judge 固定）。
- `internal/assistant/catalog.go` 保持"零手维护"——`LoadContract`+`BuildAssistant` 是助手知识的**唯一**入口；新增能力**只能**改 `semantics.json`，不可在 Go 里硬编码 tool/rule。
- 每次新增/删除真实路由，必须同步 `semantics.json`（加/删 rule）；bench 的 drift 检测会强制。
- 不引入数据库/前端框架/对外鉴权/格式转换（遵守 `AGENTS.md`）。

---

## 任务 A：真实 `/api/assistant` 端点

**目标**：把契约 catalog 暴露成 OpenAI tool schema；接收意图→分类→dispatch 到真实路由；SSE 流式回传。

**涉及文件（新建）**：`internal/api/assistant/handler.go`、`internal/api/assistant/register.go`、`internal/api/assistant/schema.go`；**改**：`internal/api/router.go`（挂载）。

**步骤**：
1. 新建 `internal/api/assistant` 包，`type Handler struct{ d *apibase.Deps; a *assistant.Assistant }`。`New(d *apibase.Deps, a *assistant.Assistant) *Handler`。`a` 由调用方在 `app.go`/`router.go` 用 `BuildAssistant(realRouteSet, true)` 构造（realRouteSet 在 server 启动后 `chi.Walk` 取得——见任务 A.5）。
2. `schema.go`：`ToolSchema(r assistant.SemRule) map[string]any`→`{type:"function", function:{name:r.Tool, description:r.Desc, parameters:{type:"object", properties:{}, required:[]}}}`（初期参数最小；按路由逐步细化）。
3. `register.go`：`Register(r chi.Router)` 挂 `GET /api/assistant/tools`（返回所有 wired tool 的 schema 列表）、`POST /api/assistant/dispatch`（body `{intent}` 或 `{tool_calls:[...]}`）、`GET /api/assistant/jobs`（任务 B）。
4. `handler.go::dispatch`：
   - 输入 `{intent}`：`a.Classify(intent)`→工具列表→对每个 `Resolve` 取 `ToolSpec`→执行（A.6）。
   - 输入 `{tool_calls}`：直接按 tool name `Resolve`→执行。
   - 流式：用 `internal/sse` 或 `http.Flusher` 逐工具回传 `{tool, route, status, result}`。
5. **realRouteSet 获取**：在 `internal/app/app.go::Run` 启动 HTTP server 后，对 `apiRouter.Routes(proxyHandler)` 调 `chi.Walk` 一次取得真实路由集（与 bench 同法），构造 `*assistant.Assistant` 注入 handler。或：handler 内部 lazy 构造（首请求时 walk 自身 router）。
6. **dispatch 执行真实路由**：两种实现择一——
   - (推荐) **内部子请求**：`http.NewRequest(method, "http://"+addr+path, body)` 复用 server 的 `http.Client`（同源 localhost，免鉴权或带内部 session）；优点：走完整中间件链、owner/path-grant、配额记账一致。
   - 或 **直接调 handler**：对 `/v1/*` 直接调 `d.ProxyHandler.ChatCompletions(w,r)` 等；对 `/api/*` 需 re-resolve 子 handler——较碎，不推荐。
   注：图片生成等会真实打上游 LLM（需配置 provider/key）；dispatch 应捕获上游错误并回传。

**验收**：`GET /api/assistant/tools` 返回 22 条 schema；`POST /api/assistant/dispatch {"intent":"生成一张猫的图片"}` 返回 `{tool:"image.generate", route:"POST /v1/images/generations"}` 并（若配好 key）触发真实生成；`go build ./...` 通过；`go test ./internal/api/assistant/` 覆盖 dispatch 路由解析。

**验证**：`curl http://127.0.0.1:20128/api/assistant/tools`；对 dispatch 做 httptest（mock 上游验证转发）。

---

## 任务 B：Scheduler 物化 + jobs CRUD

**目标**：把契约 `jobs` 落成真实 goroutine；暴露 CRUD。

**涉及文件**：`internal/assistant/scheduler.go`（**新建**，扩 `Scheduler`）、`internal/api/assistant/jobs.go`；**改**：`internal/app/app.go`（启动 goroutine）。

**步骤**：
1. `internal/assistant/scheduler.go`：`Scheduler` 增字段 `stop chan struct{}`、`runner func(name string)`。`Start(ctx, runner)`：对每个 job 起 `time.Ticker(intervalSec)` goroutine 调 `runner(name)`，`ctx.Done()` 退出。
2. `runner` 实现：`clean-traces/clean-traces-daily`→`proxyHandler.SweepTraces(ctx, retainDays, maxDiskMB)`（复用现有 sweep 逻辑，传入 `cfg.Trace.RetainDays/MaxDiskMB`）。`SweepTraces` 现已是"立即一次+每小时循环"，故物化时让 daily job 调 `sweepTracesOnce`（导出它）或独立按日 tick。
3. `jobs.go`：`GET /api/assistant/jobs`（列 job+状态）、`POST /api/assistant/jobs`（注册新 job——写回 `semantics.json`？或运行态 map）、`DELETE /api/assistant/jobs/{name}`。**注意**：CRUD 改契约需落盘 `semantics.json`（持久化）或仅运行态——初版做运行态 map，持久化留后续。
4. `app.go::Run`：`a.Scheduler().Start(shutdownCtx, runnerFn)`。

**验收**：`clean-traces` goroutine 启动且按 interval 跑；`GET /api/assistant/jobs` 返回 2 个 job；进程退出不泄漏（`ctx.Done()` 停）。

**验证**：单元测试 `TestSchedulerStartStop`（fake runner 计数）；手动 `kill` 后无残留 goroutine。

---

## 任务 C：gap 检测（bench 增强，需新段）

**目标**：bench 报告 `chi.Walk` 中存在但契约未覆盖的"能力路由"（补 added-feature 同步的另一面：drift 抓删、gap 抓漏加）。

**涉及文件**：`cmd/assistant-bench/main.go`（**需 `init_experiment new_segment:true` 后才可改**，当前 off-limits）、`internal/assistant/catalog.go`（加 `(*Contract) Gaps(routeSet) []string`）。

**步骤**：
1. `catalog.go`：`(*Contract) Gaps(routeSet map[string]bool) []string`——返回 routeSet 中**没有任何契约 rule 覆盖**的 `/v1/*`+`/api/*` 路由（排除框架路由：`/v1/tasks`、`/api/auth/*`、static）。auto-derived，非 manifest。
2. bench：算 `gaps := contract.Gaps(routeSet)`，打印 `# GAPS: <count> uncontracted capability routes: …`（截断展示）；加 `METRIC contract_gaps=<n>`。
3. **不**把 gaps 计入 `assistant_readiness`（覆盖 CRUD 子路由非有意义目标，避免噪声压指标）；仅信息性引导。

**验收**：bench 打印 gap 列表；`contract_gaps` 数稳定；`assistant_readiness` 不变（仍 dispatch_f1×contract_health）。

**验证**：在 `semantics.json` 删一条 rule → 对应路由进 gap 列表 → drift=0（契约没引用它）但 gap+1。这证明 gap 与 drift 是双向互补。

**注意**：此任务改 judge → 必须先 `init_experiment(new_segment:true)` 重建 baseline。

---

## 任务 D：前端"跳转/直接执行"

**目标**：assistant 返回 `{tool, route}`，前端按 route 跳页或直接调 `/api`。

**涉及文件**：`web/static/app.js`（或新建 `assistant.js`）、`web/static/index.html`。

**步骤**：
1. 新增小精灵入口（Floating button / 命令面板）。输入意图→`POST /api/assistant/dispatch {"intent":...}`。
2. 收 `{tool, route, status}`：若 `route` 属可跳页能力（editor/gallery/monitor/providers），`location.hash` 跳转；若是动作（download.create/trace.clear），直接 `fetch(route, {method, body})` 执行并 toast 反馈。
3. SSE 订阅 `/api/assistant/dispatch`（任务 A 改流式）显示进度。

**验收**：输入"打开我的笔记"跳转 Editor 页；输入"清理日志"执行 `POST /api/traces/clear` 并 toast 成功。

**验证**：浏览器手动 + `web/*.test.js`（项目有 `web/provider-keys.test.js` 等先例）。

---

## 任务 E：LLM tool-calling 分类器（覆盖开放词表）

**目标**：用项目自身 `/v1/chat/completions`（已透传 `tool_calls`）替换关键词大脑，覆盖任意自然语言意图。

**涉及文件**：`internal/assistant/llm_classifier.go`（**新建**）、`internal/api/assistant/dispatch.go`。

**步骤**：
1. `llm_classifier.go`：`LLMClassifier{ client *http.Client; addr string; tools []assistant.SemRule }`。`Classify(ctx, intent) ([]string, error)`：构造 OpenAI 请求 `{model, messages:[{role:system, content:"根据用户意图选择工具，从提供的 tools 中选"},{role:user, content:intent}], tools:<schema>, tool_choice:"auto"}` → `POST http://addr/v1/chat/completions`（走项目代理，复用 Key 轮询/Combo）→ 解析 `tool_calls[].function.name`。
2. dispatch 端点优先用 `LLMClassifier`，关键词分类器作 fallback（无可用 key/上游失败时）。
3. **不**进 bench 指标（无网络、需真实 LLM）——bench 仍测关键词大脑+契约系统；LLM 路径是产品泛化层，用集成测试/手动验证。

**验收**：配置好 provider/key 后，"画一只赛博朋克猫"等开放词表意图能被 LLM 选到 `image.generate`；上游不可用时 fallback 到关键词分类。

**验证**：手动 + httptest mock `/v1/chat/completions` 返回 `tool_calls`。

---

## 4. 建议实施顺序与依赖

1. **A**（真实端点）——核心，其余依赖它。先做 catalog→schema 暴露 + intent→dispatch，再 SSE。
2. **B**（Scheduler 物化）——独立，可并行。
3. **D**（前端）——依赖 A 的端点。
4. **E**（LLM 分类器）——依赖 A；替换/增强关键词大脑。
5. **C**（gap 检测）——bench 增强，独立但需新段；可随时做。

每完成一步：`go build ./...` + `go test ./...` + `bash autoresearch.sh`（确认 bench 仍 100%/0 drift，契约未被破坏）。新增能力后更新 `semantics.json`，跑 bench 确认 drift=0。

## 5. 反 gaming / 诚实约束

- 不为提分而改 judge（`cmd/assistant-bench`、`autoresearch.sh` off-limits）。
- 新能力只在 `semantics.json` 加 rule（不在 Go 硬编码），bench 强制 `(method,path)` 真实。
- gap 检测不压 readiness（避免覆盖 CRUD 噪声虚低指标）。
- LLM 分类器不入 bench（无网络、需真实 LLM），仅产品层。
- 关键词大脑在固定 30 意图已 100%——不在该固定集上继续调参（过拟合）。
