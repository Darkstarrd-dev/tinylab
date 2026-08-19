# Image Batch Project 整改方案

> 基于 `C:\Tools\TinyRouter\docs\review.md`（审核报告 §4 Image Batch）与问题 2 修复方案重新设计的统一整改方案
> 范围：Image Batch Project 模块（三种输出格式提示词设计 + 异步 Provider 生成 + 整体功能对齐）
> 状态：**已按确认决策实施**（json 结构化创作→自然语言；Booru tag 不拆分；不纳入 AI Review；A+B 同批、C 收尾）。
> 关联：`docs/image_batch_project_flow_review.md`（流程审核文稿，§15 为本方案前身的问题初查）

---

## 0. 问题对齐与事实基线

### 0.1 问题 1 — 三种输出格式设计（非 UI 缺失）

**核查结论**：格式选择器 UI 在源码、新建构建、**部署实例（端口 20102）** 三处均存在且可用。

证据：
- 源码 `pg-image-batch.js:194-218`：`planningHtml()` 渲染 `Output format` + `#pg-img-batch-format`，选项 natural/tag/json。
- 部署实例实测：`curl http://127.0.0.1:20102/playground/pg-image-batch.js` 含 `pg-img-batch-format-wrap` + `formatOpts` + `esc(text('format'))`（行 194/216）。
- headless Chrome 实测：选择器渲染、点击 Tag 值正确写入。

**问题 1 的实质 = 审核报告 §4.4 所述三种格式（natural / tag / json）的提示词设计与语义规范缺失**，对应报告 P0-1 / P0-3 / P1-1 / P1-2 / P1-3：

| 报告条目 | 缺陷 | 代码事实 |
|---|---|---|
| §4.2.2 / P0-1 | Transform 提示词无输出 Schema | `projects.go:30` `Convert each prompt to format {format}. Preserve naturalPrompt exactly. Input: {items}` —— 未说明返回 `{"format","items"}` 结构 |
| §4.4.2 / P1-2 | tag 格式规范缺失（Booru？权重？顺序？） | 提示词仅 "Convert to format tag"，无规范 |
| §4.4.3 / P0-3 | json Schema 缺失 + 传递方式未定义 | **实测**：`types.go:124` `FinalPromptObject` 存于 manifest，但 `scheduler.go:82` 只把 `FinalPrompt`（字符串）传入 `ImageGenerationRequest`；`remote_generator.go:98` `body["prompt"]=req.Prompt`、`comfy_generator.go:240` `inputs["text"]=req.Prompt` —— **`FinalPromptObject` 从不传入任何 generator** |
| §4.2.1 / P1-1 | Planning 约束不足（id 格式/quantity 范围/negative 继承/容错） | 提示词未说明 `id` 规则、quantity 范围、negative 继承语义 |
| §4.5 / P1-3 | Transform 输出格式未校验 | 后端只校验 format 一致 + 条数一致 + naturalPrompt 回写，不校验 finalPrompt 是否符合格式语义 |

### 0.2 问题 2 — 异步 Provider 生成全失败

根因（`remote_generator.go`，自 `06101fa` 起未实现 ModelScope 异步契约）：

1. 提交不带 `X-Modelscope-Async-Mode: true`（手动画布流程带，已验证）。
2. 响应只认 OpenAI `data[]`，不认 ModelScope `output.results`/`output_images`/`task_status` → `data` 空且顶层无 `task_id` → `"image response contains no assets"`，variant 秒失败（不可重试，maxRetries 无效）→ 顺序进下一张 → 整批 0 图。
3. `pollTask` 调 `caller.ImageTask`，`proxy.Handler` 从未实现该接口（注释 "normal proxy does not need to implement it"）→ 报 `"image provider returned an asynchronous task"`。
4. 轮询请求缺 `?model=` 与 `X-Modelscope-Task-Type: image_generation` 头；节奏 300×200ms 与已验证流程（60×2s + 10s 单次超时）不一致。
5. 附加：批量强制补 `n:1`（手动画布不强制），ModelScope 可能 400。

### 0.3 不在本次范围

- AI Review 提示词缺失（报告 §2 / P0-2）—— 属 Gallery 模块，另立整改。
- ComfyUI 元数据读取器（报告 §5）—— 已合格，不动。
- CSS / GIF（报告 §1 / §3）—— 另行处理。

---

## Part A — 问题 1：三种输出格式设计整改

### A1. Planning 提示词约束补充（P1-1）

**System prompt 增强**（容错）：

```
Return raw JSON only. No code blocks, no backticks, no explanations. Start with { and end with }.
Preserve the user's subject and intent.
```

**User prompt 增补约束**（id / quantity / negative 继承）：

```
Create a JSON image plan for these requirements: {requirements}
Use this as the default negative prompt unless an item specifies otherwise: {defaultNegativePrompt}
Default quantity: {defaultQuantity}
Return {"title":string,"items":[{"id":unique alphanumeric string (max 128 chars)","title":string,"naturalPrompt":string,"negativePrompt":string,"quantity":integer 1-100}]}
```

要点：
- `id`：明确 "unique alphanumeric string (max 128 chars)"，与后端 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` 对齐。
- `quantity`：明确 "integer 1-100"。
- negative 继承：从 "Default negative prompt: X" 改为 "Use this as the default unless an item specifies otherwise: X"，消除"全部 items 必须用此"的歧义。
- 自定义提示词（🔍 弹窗）仍整体替换，版本号写入 manifest `promptPlan.promptVersion`。

### A2. Transform 提示词输出 Schema + 三格式规范（P0-1 / P1-2）

重写 Transform user prompt（固定模板），显式输出 Schema + 三格式规范 + 示例：

```
Convert each prompt to format "{format}". Return JSON: {"format":"{format}","items":[same array, same order, same count, each naturalPrompt preserved exactly, with finalPrompt set to the converted text]}.

Format rules:
- natural: a clear descriptive sentence or phrase. Example finalPrompt: "a cyberpunk street warrior with a chrome arm in a neon-lit alley, cinematic lighting"
- tag: comma-separated Booru-style tags. Start with character count/gender (1girl, 2boys, solo), then subject, action, environment, art style, quality. Use underscores for multi-word tags (chrome_arm). Separate with ", ". Optional weight: (tag:1.2). Example finalPrompt: "1girl, cyberpunk, street_warrior, chrome_arm, neon_lighting, night, high_quality"
- json: set finalPromptObject to {"subject","action","environment","composition","style","lighting","quality","negative"} and set finalPrompt to a natural-language sentence compiled from those fields (NOT the raw JSON). Example finalPromptObject: {"subject":"cyberpunk street warrior","action":"standing","environment":"neon alley","composition":"full body","style":"cyberpunk","lighting":"neon rim","quality":"high","negative":"lowres"}; Example finalPrompt: "a cyberpunk street warrior standing in a neon alley, full body, cyberpunk style, neon rim lighting, high quality"

Input: {items JSON}
```

要点：
- 显式返回 Schema `{"format","items":[...]}`，明确"同序、同数、naturalPrompt 原样保留"。
- natural：完整描述句指引 + 示例。
- tag：Booru 风格规范（人物数量前缀 → 主体 → 动作 → 环境 → 风格 → 质量；下划线；逗号空格分隔；可选权重 `(tag:1.2)`）+ 示例。
- json：明确 8 字段 Schema + **finalPrompt = 自然语言拼接（非裸 JSON）**，finalPromptObject = 结构（UI 编辑/展示用）。

### A3. JSON 格式传递方式明确（P0-3）

**设计决策**：json 格式 = 结构化创作 → 自动编译为自然语言；生成时只发送 `req.Prompt`（= `FinalPrompt` 字符串），`FinalPromptObject` 仅作 UI 元数据，不传入 generator。

依据（代码实测）：
- `scheduler.go:82` `req.Prompt = prompt.FinalPrompt`（字符串）。
- `remote_generator.go:98` `body["prompt"] = req.Prompt`；`comfy_generator.go:240` `inputs["text"] = req.Prompt`。
- `FinalPromptObject` 从不传入任何 generator —— 本方案明确此为**设计意图**，并要求 transform 对 json 同时产出可用 `finalPrompt`（自然语言）与 `finalPromptObject`（结构）。

落地：
- A2 的 json 规则已要求模型产出 `finalPrompt`（自然语言拼接）+ `finalPromptObject`（结构）。
- 后端 `Validate`（A4）校验 json 项 `finalPromptObject` 含必需字段且 `finalPrompt` 非空。
- 前端 `transformItems` json 校验保持（失败标 `_invalid` 禁用启动）。
- 文档（playground-architecture.md）显式记录："json 为结构化创作模式，finalPromptObject 不发往 API，仅 UI 展示/编辑；生成用 finalPrompt。"

### A4. Transform 格式特定校验（P1-3）

后端 `Validate`（`types.go`）对 transform 输出增加格式语义校验：
- natural：`finalPrompt` 非空。
- tag：`finalPrompt` 非空且匹配 `^[^,]+(,\s*[^,]+)*$`（逗号分隔，允许 `(tag:1.2)` 与下划线）；非法 → 错误详情带格式提示。
- json：`finalPromptObject` 可解析为对象且含 `subject`（至少）；`finalPrompt` 非空。

前端 `transformItems`：tag 失败增加格式提示文案；json 失败保持 `_invalid` 标记。

### A5. 提示词版本管理（报告 §8）

- manifest `promptPlan.planVersion` / `promptPlan.transformVersion` 记录提示词版本（已有 `planVersion=1`，新增 `transformVersion=1`）。
- 自定义提示词 `customSystemPrompt` / `customUserPrompt` 已写入 manifest（planning）；transform 仍固定模板（不支持自定义），版本号记录其模板版本。

---

## Part B — 问题 2：异步 Provider 生成整改

### B1. `proxy.Handler` 实现 `ImageTask`（接口接线）

`internal/proxy/handler.go` 新增：

```go
func (h *Handler) ImageTask(w http.ResponseWriter, r *http.Request) {
    // 解析 /v1/tasks/{taskID}?model={provider/model} → 委托 TaskGet
    taskID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/tasks/"), "/")
    if taskID == "" || strings.ContainsAny(taskID, "/\\") {
        writeError(w, http.StatusBadRequest, "invalid task id"); return
    }
    h.TaskGet(w, r, taskID, r.URL.Query().Get("model"))
}
```

复用现有 `TaskGet`（provider 解析 + key 选择 + 上游 GET 转发 + 头透传 `X-Modelscope-Task-Type`）。手动画布已验证该链路。

### B2. ModelScope 异步提交头 + n:1 处理

`remote_generator.go` `Generate`：
- `protocol == "modelscope"`（或 model 前缀）时设置 `X-Modelscope-Async-Mode: true`。
- 该协议下不强制补 `n:1`（与手动画布 body 构造一致）；其他协议保持现有 `n:1` 默认。

### B3. 宽容响应解析

`remote_generator.go` 新增辅助函数（解析 ModelScope/DashScope 多形态）：
- `modelscopeTaskID`：从 `task_id` / `output.task_id` / `result.task_id` / `request_id` / `data[0].task_id` 提取。
- `modelscopeItems`：从 `output_images` / `data` / `results` / `output.output_images` / `output.results` / `output.images` / `image_url` / `output.image_url` 提取图片（字符串 URL 或 `{url|image_url|oss_url}` 或 `{b64_json|base64}`），去重，回填 `revised_prompt`。
- `modelscopeStatus` / `modelscopeDecision` / `modelscopeMessage`：状态判定与错误信息。

`Generate` 流程改为：提交 → 解析 `taskID` + `items`；有图直接用；仅 `taskID` 则轮询；都无 → `"image response contains no assets"`。

### B4. `pollTask` 重写

- URL：`/v1/tasks/{id}?model={req.Model}`（带 provider 前缀，`TaskGet` 的 `SplitModel` 需要）。
- 头：`X-Modelscope-Task-Type: image_generation` + `X-TinyRouter-Source: playground-batch`。
- 状态判定：`task_status`/`status`/`output.*/data[0].task_status` → SUCCEED/SUCCESS/COMPLETE/DONE=done、FAIL/ERROR/CANCEL=failed、其余 pending。
- 节奏：上限 60 次、间隔 2s、单次尝试 10s 超时（对齐手动画布 `MODELSCOPE_MAX_POLLS=60`/`MODELSCOPE_POLL_MS=2000`/`MODELSCOPE_ATTEMPT_TIMEOUT_MS=10000`）。
- **done 且取到真实图片才返回资产**；failed → 错误；超时 → `"image task polling timed out"`。

### B5. 测试

`internal/imagebatch/adapters_test.go` 新增（复用 `fakeImageProxy` 模式）：
1. async 提交返回 `task_id` → 轮询两次后返回图片 URL → `Generate` 成功取回资产。
2. 轮询 `status=failed` → 错误。
3. 提交直接带 `output.results` 图 → 免轮询直接成功。
4. 非 modelscope 协议仍强制 `n:1` 且不带异步头（防回归）。
5. `proxy.Handler.ImageTask` 路由测试（`internal/proxy`）。

---

## Part C — 整体功能对齐

### C1. 文档同步（AGENTS.md 强制）

- `docs/playground-architecture.md`：新增"三种输出格式规范"章节（A2 全文）、"json 传递方式"（A3）、"ModelScope 异步生成链路 + ImageTask 接口"（B1-B4）；更新"最后核对"行与变更维护清单。
- `PROJECT_MAP.md` §24：同步 imagebatch 涉及条目（`internal/imagebatch/remote_generator.go` 新增辅助函数、`internal/proxy/handler.go` 新增 `ImageTask`）。
- `docs/image_batch_project_flow_review.md` §12/§13：更新提示词清单（A2 新模板）与结果契约（A4 校验）。

### C2. 验证矩阵

- `go test ./internal/imagebatch/... ./internal/proxy/...`（B5 + A4 校验测试）。
- `go build -tags playground`。
- headless Chrome 冒烟：
  - 三格式：natural → GPT Image；tag → ComfyUI（CLIPTextEncode）；json → 拼接自然语言发 GPT Image。
  - ModelScope：批量项目 Start → variant 逐个 succeeded + `imgs/<slug>/p####/v####` 落盘 + dashboard 显示图片 + `lastError` 为空。
  - 失败路径：ModelScope 任务 failed → variant failed + `lastError` 带上游详情 + `onError` 配置生效。

### C3. 部署同步

- 重新构建 `tinyrouter-webview-pg-stripped.exe` 替换 `C:\Tools\TinyRouter\`（当前部署实例 20102 为今日 11:45 构建，整改后重建替换）。
- 替换前备份当前 `state.yaml` / `imgs/`。

---

## 6. 实施优先级与顺序

| 优先级 | 项 | 依赖 |
|---|---|---|
| **P0** | B1-B5（问题 2 阻断：异步生成） | 无 |
| **P0** | A2 / A3（提示词 Schema + json 传递） | 无 |
| **P1** | A1（Planning 约束） | A2 同批改提示词 |
| **P1** | A4（格式校验） | A2 |
| **P2** | A5（版本管理） | A1/A2 |
| **P2** | C1（文档同步） | A/B 全部完成 |
| **P2** | C2（验证矩阵） | A/B 全部完成 |
| **P2** | C3（部署同步） | C2 通过 |

建议单次实施 A+B（同一批提示词与生成整改），再 C 收尾，避免提示词模板与校验/文档分批脱节。

---

## 7. 风险与对齐点

- **ModelScope API 实际响应形态**：方案基于已验证的手动画布流程契约（`pg-image-model.js` 的 `modelscopeCanonical`/`modelscopePoll`）；实施时以真实 ModelScope 调用复核 `output.results`/`task_status` 字段名。
- **json → 自然语言拼接质量**：依赖 helper model 把结构字段编译为可用句子；A2 示例约束模型行为，A4 校验兜底。
- **tag 权重语法兼容性**：`(tag:1.2)` 在不同 SD 模型/ComfyUI 节点间兼容性差异；方案默认可选，用户可编辑 finalPrompt 微调。
- **`FinalPromptObject` 不发 API**：明确为设计意图，非缺陷；若未来某 API 原生支持结构输入再扩展。

---

## 8. 审核决策点（需用户确认）

1. **json 格式语义**：确认采用"结构化创作 → 编译为自然语言"（A3），而非"裸 JSON 字符串直发 API"。
2. **tag 格式目标**：确认 Booru 风格（A2），是否需要长期拆分 `tag-sd` / `tag-dalle` 子格式（报告 §4.4.2 长期建议）。
3. **AI Review 提示词（报告 P0-2）**：是否纳入本次整改（当前划出范围，属 Gallery 模块）。
4. **实施批次**：A+B 同批，C 收尾；或分两批（先 B 阻断修复，再 A 提示词）。
