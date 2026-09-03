# TinyLab Combo 组合策略架构

> **文档定位：** `internal/combo/` 包实现的 canonical 架构事实基线。后续设计、排障和代码评审应先读取本文，再按“源码锚点”核对本次变更涉及的局部代码。
>
> **最后核对：** 2026-07-25，仓库工作区（`main`）。本文描述的是当时源码的实际行为，不把规划或历史设计稿当作现状。**本轮修复：** combo warning 输出从 `log.Printf` 改为 `fmt.Fprintf(os.Stderr, …)`（resolver.go:91），符合「log 仅限 main.go」规则。

## 1. 范围与结论

`internal/combo/` 是 TinyLab 的 **Combo 组合策略模块**，把“组合名（combo name）”解析为一个有序的 `ComboPlan`（`[]ModelTarget`）交由 proxy 驱动执行。它自身不做 HTTP 转发、SSE、用量记录、key 轮询或冷却记账——这些仍由 proxy / rotation 负责。combo 只是**名称 → 执行计划**的解析层。

- **谁调用它：** `internal/proxy/` 通过 `ComboResolver` 接口（proxy/interfaces.go:61-64）注入 `*combo.Resolver`，在 `handleProxy` 先以 `IsComboName` 判断请求 `model` 是否为 combo 名（forward.go:46-49），是则走 `handleCombo` 调 `Resolve` 取计划并按策略驱动（forward.go:87-122）；`internal/app/app.go` 作为组合根构造 `Resolver` 并挂 `SetStateHook` 持久化 `state.yaml`（app.go:127、168）。
- **它调用谁：** `registry.Registry`（读 combo/provider 定义、`GetComboByName` 查名、`GetProviderByPrefix` 解前缀、`ListCombos`）、`config`（Combo / ModelDef 定义）、`state`（ComboSnapshot 持久化）。combo 不写文件，状态变更经注入的 `onStateChange` 旁路回调触发。

```mermaid
flowchart LR
    Proxy["proxy.Handler (ComboResolver)"]
    Res["combo.Resolver"]
    Reg["registry.Registry"]
    Cfg["config (Combo / ModelDef)"]
    Hook["onStateChange 钩子 -> state.yaml"]

    Proxy -->|"IsComboName / Resolve"| Res
    Res -->|"GetComboByName / GetProviderByPrefix / ListCombos"| Reg
    Res -->|"读 Combo.Strategy/Models、ModelDef.QuotaType"| Cfg
    Res -->|"状态变更回调"| Hook
```

本文的核心结论：

1. **round-robin 只把 `Targets[0]` 暴露给 proxy：** 跨 target 的旋转由 per-combo 计数器（`comboState`）驱动，返回时把当前 index 旋到切片首位（rotateTargets:134-161），proxy 只读 `plan.Targets[0]`（forward.go:108-111）；它**不是**跨 target 的 failover 循环，失败不会切下一个 target。
2. **greedy-squirrel 按配额层级排序：** `unlimited → limited → paid`，每层内保持原始顺序，未知 QuotaType 落入 `limited` 桶（sortTargetsByTier:204-223）。
3. **ModelTarget.ProviderID 存的是真实 provider ID，不是前缀：** `Resolve` 经 `GetProviderByPrefix` 解出 provider 后写入 `provider.ID`（resolver.go:89-94）。
4. **配额层级挂在 ModelDef 上，不挂在 Combo 上：** `QuotaType` 来自 `config.ModelDef`（types.go:32-34），Combo 只持有字符串 `Models`（types.go:129-136），无 `QuotaTier` 字段；缺失时 `Resolve` 兜底为 `"limited"`（resolver.go:107-109）。
5. **combo 自己持有轮转状态：** `Resolver.state map[string]*comboState`（resolver.go:45）由本包拥有并持久化；这与 rotation 把全部 per-key 状态委托给 `registry.KeyRuntimeState` 的归属边界相反（见第 3、9 节）。

## 2. 事实优先级

出现冲突时按以下优先级判断：

1. 当前源码和测试（`internal/combo/*`、`internal/proxy/interfaces.go`、`internal/proxy/forward.go`、`internal/config/types.go`、`internal/config/defaults.go`、`internal/registry/combos.go`、`internal/util/util.go`、`internal/state/state.go`、`internal/app/app.go` 的相关集成）；
2. 本文；
3. `AGENTS.md` / `PROJECT_MAP.md`（仅作模块边界与约定背景）；
4. 历史提交信息（仅作历史背景）。

AGENTS.md 不精确之处（以本文源码锚点为准）：

- **轮转状态归属：** AGENTS.md §6 把 Combo 描述为“移植自 9router combo.js”；实际 combo 的轮转状态（index/consecCount）由 `internal/combo` 自己持有（resolver.go:50-53、45），而非复用 rotation 的 registry 状态；只有 key 选择/冷却仍经过 rotation。
- **sticky 阈值：** AGENTS.md 用“stickyLimit”泛指；combo 的 round-robin 粘性阈值在源码中**硬编码为 3**（resolver.go:146 `if st.consecCount > 3`），不可通过配置调整。

## 3. Resolver 与归属边界

### 3.1 Resolver 结构体与构造（resolver.go:41-48、55-58）

```go
type Resolver struct {
    reg   *registry.Registry
    mu    sync.Mutex
    state map[string]*comboState // combo name → rotation state

    onStateChange func() // injected by main.go for state persistence
}
```

`New(reg)` 只存 registry 指针并初始化 `state` map，**不**分配运行时状态（resolver.go:55-58）。`SetStateHook`（resolver.go:163-168）注入 `onStateChange` 回调，每次轮转状态变更后由 `rotateTargets` 调用（resolver.go:151-153）。

### 3.2 ComboResolver 接口（proxy/interfaces.go:61-64）

```go
type ComboResolver interface {
    IsComboName(name string) bool
    Resolve(name string) (*combo.ComboPlan, error)
}
```

`*combo.Resolver` 结构性满足该接口，proxy 不再依赖具体类型（proxy/interfaces.go:58-64 注释）。

### 3.3 组合根接线（app.go:127、165、168）

`app.go` 在 `Init` 中：`a.comboRes = combo.New(a.reg)`（app.go:127）；持久化启用时 `state.WithComboStateProvider(a.comboRes.SnapshotComboStates, a.comboRes.RestoreComboState)`（app.go:165），并在 `comboRes.SetStateHook(a.stateManager.ScheduleWrite)`（app.go:168）把状态变更接到 `state.yaml` 写入调度。Restore 在 `Run` 早期、HTTP 服务启动前完成（app.go:200-208）。

### 3.4 归属边界：状态归 combo，而非 registry

rotation 的 per-key 状态完全由 `registry` 拥有（见 rotation-architecture.md §3.3）；而 combo 的轮转状态 `comboState{index, consecCount}` 由 `Resolver.state` map 自己持有（resolver.go:45、50-53）。combo 只在 `Resolve`/`rotateTargets` 内读自己的 map，唯一向 registry 取的是 combo/provider 定义（只读、无状态写入）。这是与 rotation 的关键对比点。

## 4. IsComboName（resolver.go:234-238）

```go
func (r *Resolver) IsComboName(name string) bool {
    _, ok := r.reg.GetComboByName(name)
    return ok
}
```

精确按 combo `Name` 字段匹配 `registry.GetComboByName`（registry/combos.go:15-25），**不做任何前缀/格式启发式判断**。proxy 在 `handleProxy` 最先调用它（forward.go:46-49），combo 名优先于 quickslot（forward.go:51）和普通 `provider/model`（forward.go:65-77）——即若 combo 名与 provider 前缀或 quickslot 名撞名，combo 胜出。

## 5. Resolve 算法（resolver.go:70-132）

按顺序：

1. **查 combo：** `r.reg.GetComboByName(comboName)`（resolver.go:71）；不存在 → 返回 `(nil, nil)`（resolver.go:72-74），proxy 在 `handleCombo` 内写 400 `combo not found or empty` 并返回（forward.go:93-94）。
2. **disabled 守卫：** `combo.Disabled` 为真 → 返回错误 `combo is disabled: ...`（resolver.go:75-77），proxy 写 400（forward.go:89-91）。
3. **遍历 Models 构建 targets（resolver.go:79-111）：**
   - `isModelDisabled(m, combo.DisabledModels)` 为真（精确相等）→ 跳过（resolver.go:81-83、225-232）；
   - `prefix, model := util.SplitModel(m)`（resolver.go:84），`prefix==""`（无 `/`）→ 跳过（resolver.go:85-87）；
   - `provider, ok := r.reg.GetProviderByPrefix(prefix)`（resolver.go:89），未命中 → `fmt.Fprintf(os.Stderr, …)` 警告并跳过（resolver.go:90-93）；
   - **Alias 解析**：`r.reg.ResolveModelAlias(prefix, model)`（resolver.go:97），若命中则用真实 ID 替换 `model`（resolver.go:98-99）；因为 API 返回的 model 列表使用 alias（如果有），combo 配置中存储的也是 `prefix/alias`，所以需要先解析为真实 ID 再匹配 provider 的 Models 列表中的 QuotaType；
   - 构建 `ModelTarget{ProviderID: provider.ID, Model: model}`（resolver.go:94），遍历 `provider.Models` 按 `md.ID == model` 取 `QuotaType`（resolver.go:101-106），空则兜底 `"limited"`（resolver.go:107-109）；
   - append（resolver.go:110）。
4. **空 targets：** `len(targets)==0` → 返回 `(nil, nil)`（resolver.go:116-118）。
5. **构造计划 + 策略后处理（resolver.go:120-131）：** `Strategy: combo.Strategy`；`round-robin` → `rotateTargets`（resolver.go:125-126）；`greedy-squirrel` → `sortTargetsByTier`（resolver.go:127-128）；其余策略（含 `fallback` 与未知值）保持配置顺序原样。

```mermaid
flowchart TD
    A["GetComboByName (71)"] -->|"不存在"| E1["nil, nil"]
    A -->|"存在"| B{"Disabled?"}
    B -->|"是"| E2["error -> proxy 400"]
    B -->|"否"| C["遍历 Models (79-111)"]
    C -->|"DisabledModels 命中"| C
    C -->|"SplitModel 无 /"| C
    C -->|"前缀未命中 provider"| C
    C -->|"命中"| D["append ModelTarget (含 QuotaType 兜底 limited)"]
    D --> F{"len(targets)==0?"}
    F -->|"是"| E3["nil, nil"]
    F -->|"否"| G{"Strategy?"}
    G -->|"round-robin"| R["rotateTargets (125-126)"]
    G -->|"greedy-squirrel"| S["sortTargetsByTier (127-128)"]
    G -->|"fallback / 其它"| N["保持配置顺序"]
    R --> H["返回 ComboPlan"]
    S --> H
    N --> H
```

## 6. 三种策略与目标排序

### 6.1 fallback（配置顺序）

`Resolve` 对 fallback 不做后处理，targets 即 `combo.Models` 的解析结果顺序。proxy 在 `handleCombo` 内 `for _, target := range plan.Targets` 顺序尝试，`forwardWithRetry` 成功即 `return`，失败继续下一个（forward.go:100-106）；全部失败写 502（forward.go:106）。这是跨 target 的 failover，但发生在 proxy 层，而非 combo 内。

### 6.2 round-robin（粘性轮转）

`rotateTargets`（resolver.go:134-161）在 `mu` 锁内：

1. 取/建 `comboState{index:0, consecCount:0}`（resolver.go:139-143）；
2. `consecCount++`；若 `consecCount > 3`（`st.index = (st.index+1) % len(targets); consecCount = 1`）（resolver.go:145-149）——**粘性阈值硬编码 3**；
3. 触发 `onStateChange`（resolver.go:151-153）；
4. 返回把 `st.index` 旋到首位的切片副本（resolver.go:155-160）。

proxy 只取 `plan.Targets[0]`（forward.go:108-111），失败写 502（forward.go:110）。**跨 target 切换是“请求计数轮转”，不构成失败回退**——某 target 的 key 全部耗尽时该请求直接 502，不会自动跳到下一个 target。

### 6.3 greedy-squirrel（配额层级排序）

`sortTargetsByTier`（resolver.go:204-223）把 targets 分三组：`unlimited` / `limited`（default 分支，含未知 QuotaType）/ `paid`，按 `unlimited → limited → paid` 顺序拼接，`append` 保持各桶内原始顺序。proxy 行为与 fallback 相同：顺序尝试、首个成功返回（forward.go:112-118），全部失败写 502（forward.go:118）。

### 6.4 三策略对比

| 策略 | combo 内后处理 | target 顺序 | proxy 驱动（forward.go） | 失败语义 |
|---|---|---|---|---|
| `fallback` | 无（保持配置顺序） | 同 `Models` | 顺序迭代 + 首个成功返回（100-106） | 跨 target failover（proxy 层） |
| `round-robin` | `rotateTargets`（93-94） | 每次把当前 index 旋到首位 | 只取 `Targets[0]`（108-111） | 不跨 target 回退，耗尽即 502 |
| `greedy-squirrel` | `sortTargetsByTier`（95-96） | unlimited→limited→paid | 顺序迭代 + 首个成功返回（112-118） | 跨 target failover（proxy 层） |

未知 strategy 字符串会落入 table 的“其它”行：`Resolve` 不后处理，`handleCombo` 的 `switch` `default` 分支写 400（forward.go:119-120）。

## 7. 模型字符串与配额层级

- **字符串格式：** `combo.Models` 元素为 `"prefix/model"`，`util.SplitModel` 在**第一个** `/` 处切分（util/util.go:6-13）。`"a/b/c"` → `("a","b/c")`（测试 resolver_test.go:222-236 验证）；无 `/` → `("", 原串)`（resolver.go:85-87 跳过）。
- **前缀解析：** `prefix` 经 `GetProviderByPrefix` 解出 provider（resolver.go:89），`ModelTarget.ProviderID` 存 `provider.ID` 而非 `prefix`（resolver.go:94）；`ModelTarget.Model` 存切分后的剩余部分。
- **Alias 解析：** 当 model 设置了 alias 时，API 返回 `prefix/alias`，combo 配置中存储的也是 `prefix/alias`。Resolver 在解析时会先通过 `ResolveModelAlias`（resolver.go:97）将 alias 解析为真实 model ID，再进行 QuotaType 匹配（resolver.go:107-110）。
- **配额层级来源：** `QuotaType` 来自 `config.ModelDef`（types.go:32-34），按 `provider.Models` 中 `md.ID == model` 匹配（resolver.go:101-106）。`finalizeConfig` 把空 `QuotaType` 填 `"limited"`（defaults.go:98-100）；`Resolve` 内若仍取不到也兜底 `"limited"`（resolver.go:107-109）。
- **层级判定：** `sortTargetsByTier` 的 `switch`（resolver.go:207-216）：`"unlimited"` / `"paid"` 各有专属桶，`default`（含任意未知字符串、空串）落入 `limited` 桶——**不做 QuotaType 合法性校验**。

## 8. 配置集成

### 8.1 config.Combo（types.go:129-136）

```go
type Combo struct {
    ID             string   `yaml:"id" json:"id"`
    Name           string   `yaml:"name" json:"name"`
    Strategy       string   `yaml:"strategy" json:"strategy"`
    Models         []string `yaml:"models" json:"models"`
    Disabled       bool     `yaml:"disabled,omitempty" json:"disabled,omitempty"`
    DisabledModels []string `yaml:"disabledModels,omitempty" json:"disabledModels,omitempty"`
}
```

注意 **Combo 上没有 QuotaTier 字段**——配额层级是 per-model 的（在 `provider.Models[].QuotaType`，即 `ModelDef`），combo 只在 `Models` 里写 `"prefix/model"` 字符串（types.go:133）。

`config.Combos` 是 `[]Combo`（types.go:211，对应 defaults.go 中的 `Combos`）。默认值空切片 `[]Combo{}`（defaults.go:55）。

### 8.2 config.yaml 形态

```yaml
combos:
  - id: c1
    name: mycombo
    strategy: fallback          # fallback | round-robin | greedy-squirrel
    models:
      - deepseek/deepseek-chat   # prefix/model
      - openai/gpt-4o
    disabled: false
    disabledModels:
      - openai/gpt-4o
providers:
  - id: deepseek
    prefix: deepseek
    models:
      - id: deepseek-chat
        quotaType: limited       # unlimited | limited | paid（缺省 limited）
```

## 9. 状态模型与持久化

| 结构体 | 位置 | 字段 / 用途 |
|---|---|---|
| `ModelTarget` | resolver.go:28-33 | 解析出的 `ProviderID` / `Model` / `QuotaType` |
| `ComboPlan` | resolver.go:35-39 | `Strategy` + `Targets []ModelTarget`（greedy-squirrel 内部按层排序） |
| `Resolver` | resolver.go:41-48 | `reg` / `mu` / `state map[string]*comboState` / `onStateChange`（**自持轮转状态**） |
| `comboState` | resolver.go:50-53 | `index int` / `consecCount int`（per-combo 轮转游标，仅 round-robin 用） |
| `config.Combo` | types.go:129-136 | combo 配置：`ID`/`Name`/`Strategy`/`Models`/`Disabled`/`DisabledModels` |
| `config.ModelDef` | types.go:32-34 | `ID` / `QuotaType`（配额层级挂在模型上） |
| `state.ComboSnapshot` | state/state.go:41-44 | 持久化子集：`Index` / `ConsecCount` |

**持久化：**

- `SnapshotComboStates`（resolver.go:170-183）：在 `mu` 锁内遍历 `state` map，按 **combo 名** 为 key 输出 `state.ComboSnapshot{Index, ConsecCount}`（注意 key 是 `state.yaml` 中 combos map 的 key，即 combo 名）。
- `RestoreComboState`（resolver.go:185-202）：先 `GetComboByName(id)` 复查（resolver.go:187-189），不存在报错；再 `mu` 锁内写回 `index`/`consecCount`（resolver.go:193-200）。因按名复查，**被改名的 combo 会丢失其持久化状态**（旧名找不到新名，新名新建空 state）。
- `SetStateHook`（resolver.go:163-168）在 `rotateTargets` 每次轮转后触发 `onStateChange`，由 `app.go` 接到 `stateManager.ScheduleWrite`（app.go:168）去抖动写 `state.yaml`。

**归属边界重申：** combo 的轮转状态（`comboState`）由 `Resolver.state` 自持并持久化；这与 rotation 把 per-key 状态委托给 `registry.KeyRuntimeState` 相反——combo 不依赖 registry 保存任何运行时游标。

## 10. 并发模型

- **单一 `sync.Mutex`（resolver.go:44）：** 保护 `state map[string]*comboState` 的全部读写。`SnapshotComboStates`（resolver.go:171-172）、`RestoreComboState`（resolver.go:190-191）、`rotateTargets`（resolver.go:135-136）、`SetStateHook`（resolver.go:164-165）均加同一把锁。
- **临界区短：** `rotateTargets` 仅在锁内完成“取/建 state → 计数/轮转 → 复制切片 → 触发回调”，不跨 registry 调用、不阻塞转发。
- **无 per-combo 锁：** 锁是 resolver 级单锁，所有 combo 共享；高频跨 combo 并发时彼此串行，但仅影响轮转计数更新，不在锁内做网络 IO。
- **IsComboName / Resolve 读取：** 二者经 `registry` 的 `cfgMu.RLock` 读配置（registry/combos.go:16-17），与 combo 的 `mu` 互不嵌套。

## 11. 已知约束与风险

1. **round-robin 只暴露 `Targets[0]`：** 跨 target 旋转是 per-combo 计数轮转，proxy 不跨 target 回退（forward.go:108-111），某 target key 全耗尽直接 502。
2. **sticky 阈值硬编码 3：** resolver.go:146 `if st.consecCount > 3`，无配置项，不可调。
3. **未知 strategy 静默当配置顺序处理：** `Resolve` 不后处理，`handleCombo` 的 `default` 才报 400（forward.go:119-120）；即配置写错策略名时，combo 仍会"成功"解析，直到 proxy 路由时才 400。
4. **无 QuotaType 校验：** 任意字符串落入 `limited` 桶（resolver.go:214-215），不会报错或告警。
5. **DisabledModels 仅精确匹配：** `isModelDisabled` 用 `d == model` 全等（resolver.go:225-231），不支持前缀/通配；且匹配的是完整 `"prefix/model"` 串。
6. **未知 provider 前缀静默跳过：** `GetProviderByPrefix` 未命中只 `log.Printf` 警告（resolver.go:90-93），不报错；该 model 从 targets 消失，可能使 combo 变空 → `Resolve` 返回 `(nil, nil)` → proxy 写 400（forward.go:93-94）。
7. **重复 model 产生重复 target：** 同一 `"prefix/model"` 出现多次会生成多个 `ModelTarget`（resolver.go:79-111 无去重）。
8. **combo 名优先于 provider/quickslot 碰撞：** `IsComboName` 最先判定（forward.go:46-49），撞名时 combo 胜出。
9. **RestoreComboState 丢弃改名 combo 的状态：** 按名复查（resolver.go:187-189），旧名状态不复用到新名。
10. **空 `Models` → `(nil, nil)`：** proxy 当作“非 combo”处理，写 400 `combo not found or empty`（forward.go:93-94）而非 502。
11. **disabled combo 返回 error：** proxy 写 400（forward.go:89-91），不是 404/502。

## 12. 测试与验证现状

### 12.1 测试文件与覆盖（resolver_test.go）

| 测试函数 | 覆盖内容（锚点） |
|---|---|
| `TestResolve_NotFound` | 未知 combo → `plan==nil` 且无 error（resolver_test.go:24-33） |
| `TestResolve_Fallback` | fallback 保持配置顺序，`Targets[0].ProviderID=="p1"`、`[1].ProviderID=="p2"`，ProviderID 为真实 ID（35-65） |
| `TestResolve_RoundRobin_Sticky` | 连续 3 次 `Targets[0]` 均为 p1（粘性阈值为 3）（67-85） |
| `TestResolve_RoundRobin_Rotate` | 第 4 次调用 `Targets[0]` 轮转到 p2（87-106） |
| `TestResolve_EmptyModels` | 空 `Models` → `plan==nil`（108-119） |
| `TestResolve_InvalidModelFormat` | 无 `/` 的 model → `plan==nil`（121-132） |
| `TestResolve_GreedySquirrel_TierOrdering` | unlimited→limited→paid 排序（134-175） |
| `TestResolve_GreedySquirrel_UnknownQuotaDefaultsLimited` | 空 QuotaType 兜底 limited（177-208） |
| `TestIsComboName` | 存在/不存在 combo 名判定正确（210-220） |
| `TestSplitModel` | `deepseek/deepseek-chat`、`no-slash`、`a/b/c` 切分（222-237） |

共 10 个测试函数，覆盖解析主路径、三种策略、disabled 守卫之外的空/非法输入与 QuotaType 兜底。

### 12.2 已测 vs 未测

- **已测：** fallback/round-robin/greedy-squirrel 的计划构造与排序；粘性 3 与轮转；空/无斜杠/未命中 QuotaType；`IsComboName`；`SplitModel`。
- **未充分覆盖（按源码锚点）：**
  - **disabled combo 错误路径：** resolver.go:75-77 返回 error，但无测试；proxy 写 400（forward.go:89-91）也未在 combo 包内测。
  - **DisabledModels 过滤：** isModelDisabled 分支（resolver.go:81-83、225-232）无测试。
  - **未知 provider 前缀跳过 + 警告：** resolver.go:90-93 无测试（仅日志，无断言）。
  - **SnapshotComboStates / RestoreComboState 往返：** resolver.go:170-202 无测试；改名丢状态（#9）未验证。
  - **SetStateHook 触发：** resolver.go:163-168、151-153 的回调未被任何测试验证。
  - **ListCombos 透传：** resolver.go:240-243 无测试。
  - **未知 strategy 透传：** `Resolve` 不后处理、`handleCombo` 报 400 的路径（forward.go:119-120）无测试。
  - **重复 model 去重行为：** resolver.go:79-111 不去重（#7）无测试。

### 12.3 建议验证命令

```powershell
go test ./internal/combo/...
go test ./...
go build -o tinylab .
```

涉及 Resolve 策略、配额排序、状态持久化的修改，应优先跑 `resolver_test.go`，并手工用浏览器构造 combo 请求验证轮转分布与重启后游标恢复。

## 13. 源码锚点

本包（internal/combo）：

- `resolver.go`：ModelTarget（28-33）、ComboPlan（35-39）、Resolver 结构体（41-48）、comboState（50-53）、New（55-58）、Resolve 算法（70-132）、rotateTargets（134-161）、SetStateHook（163-168）、SnapshotComboStates（170-183）、RestoreComboState（185-202）、sortTargetsByTier（204-223）、isModelDisabled（225-232）、IsComboName（234-238）、ListCombos（240-243）。

外部依赖：

- `internal/proxy/interfaces.go`：ComboResolver 接口（61-64）。
- `internal/proxy/forward.go`：handleProxy 先判 IsComboName（46-49）、handleCombo 按策略驱动（87-122，含 fallback 100-106、round-robin 108-111、greedy-squirrel 112-118、未知策略 400 119-120、disabled error 400 89-91）。
- `internal/config/types.go`：Combo（129-136）、ModelDef（32-34）、Combos 字段（211）。
- `internal/config/defaults.go`：Combos 默认空（55）、ModelDef 空 QuotaType 填 limited（98-100）。
- `internal/registry/combos.go`：GetComboByName（15-25）、**GetComboByID（73-84，供 combo 批量测速排序 handler 使用）**、ListCombos（7-13）。
- `internal/util/util.go`：SplitModel 首个 `/` 切分（6-13）。
- `internal/state/state.go`：ComboSnapshot（41-44）、Snapshot.Combos（17-22）、Save 原子写（79-96）。
- `internal/app/app.go`：combo 接线 New（127）、WithComboStateProvider（165）、SetStateHook（168）、Restore（200-208）。

### 13.1 关联功能：Combo 批量测速排序（不在本包，但读写 Combo 模型顺序）

`internal/api/combo_speedtest.go` 实现的 `speedTestCombo` handler（`POST /api/combos/{id}/speed-test`，SSE 流式）不属于 `internal/combo` 包，但**直接读写 Combo 的 `Models` 与 `DisabledModels` 字段顺序**：

- 调 `registry.GetComboByID` 取 combo，把 `Models` + `DisabledModels` 拼成全部待测模型列表。
- 全并发（goroutine + channel）对每个模型发起流式 `/v1/chat/completions` 请求（prompt "请写一篇约1000字的短篇小说"、`max_tokens:1200`、`stream:true`），测量 TTFT 与 TokensPerSec；单模型早停 60 chunks 或 30 秒；整体 60 秒超时。
- 复用 `proxy.BuildUpstreamURL` / `proxy.SSELineBuffer` / `proxy.SSEDataPayloads` / `util.ExtractTokens` / `internal/api/probe_common.go::extractContentFromSSE` / `firstActiveKey` / `proxyHandler.ManagementClient`；**不**走 `proxy/handleProxy` 转发路径（无重试/故障转移/配额记账副作用）。
- **持久化排序结果**：按 `TokensPerSec` 降序（失败排末尾）排序后，分别回填到 `Models` 与 `DisabledModels`（保留各模型原 disabled 标识），再调 `registry.UpdateCombo` + `saveConfig` 写入 `config.yaml`。
- SSE 事件：`meta`（total） → 每个 `model` 完成时推送 → `done`（含 `newModels` / `newDisabled` / `newOrder`）。

前端入口：`web/static/combos.js` 的编辑模态框"批量测速并排序"按钮调 `runComboSpeedTest`，按 `event: model` 实时更新行内速度状态，`event: done` 后重置 `comboEditingModels/DisabledModels` 并 `renderComboModelsList()`。

## 14. 变更维护清单

| 变更类型 | 必查位置 |
|---|---|
| 新增/修改策略 | resolver.go Resolve（70-132）+ rotateTargets（134-161）/sortTargetsByTier（204-223）+ proxy/forward.go handleCombo（87-122） |
| 修改配额层级 | sortTargetsByTier（207-216）+ config/types.go ModelDef.QuotaType（32-34）+ defaults.go（98-100）+ resolver.go 兜底 limited（107-109）+ alias 解析 resolver.go:97-99 |
| 修改 combo 配置 | config/types.go Combo（129-136）+ defaults.go Combos（55）+ registry/combos.go 读写 |
| 修改状态持久化 | resolver.go SnapshotComboStates（170-183）/RestoreComboState（185-202）+ state/state.go ComboSnapshot（41-44）+ app.go 接线（165、168） |
| 修改 Combo 批量测速排序 | api/combo_speedtest.go（speedTestCombo + probeComboModel）+ registry/combos.go GetComboByID + api/router.go（路由注册）+ web/static/combos.js runComboSpeedTest + web/static/i18n.js comboSpeedTest* 键 |
| 清理 combo 无效引用 | registry/sweep.go（SweepStaleComboModels + isRefAliveLocked：provider 前缀+模型 ID/别名存活判定）+ registry DeleteProvider/DeleteModel 内联自动 sweep + api/combos/register.go（POST /api/combos/cleanup，经 SaveConfigAndReload 持久化）+ web/static/combos.js cleanupStaleCombos + settings.js combos header 清理按钮 + i18n.js cleanupStale* 键 |
| 修改 model 字符串格式 | util/util.go SplitModel（6-13）+ resolver.go Resolve 遍历与 SplitModel 调用（79-111） |
| 修改接口契约 | proxy/interfaces.go ComboResolver（61-64）须与 resolver.go 方法签名同步 |
