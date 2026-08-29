# TinyRouter 全项目审核修复实施计划

> **文档用途**：本文件是 `2026-08-29` 全项目 9 域代码审核（正确性/安全性/性能/并发）与模块化/文件规模复核的**合并执行路线**。后续所有修复应以本文件的任务编号、证据、验收合同为准；不得只修单个症状而保留同类漏洞。新对话加载本文件即可直接实施。
>
> **文档状态**：待执行（2026-08-29 基线）。前两轮审核（`audit_fix.md` Phase A-F）已完成，本计划针对**新发现**的系统性风险与文件超规模问题。
>
> **编制日期**：2026-08-29
> **基线提交**：当前 HEAD（审核期间未修改源码）

---

## 0. 执行摘要

### 0.1 修复顺序（强制）
```
Phase 1 — 止血（安全边界，1-2 天）
  ├── P0-01 路径边界三处 + Editor 一处（HasPrefix 门控）
  ├── P0-02 SSRF 防御断层（Music/Image 统一 outbound.Policy）
  ├── P0-03 InFlight 泄漏（Monitor/CoreInfra 取消分支配对）
  └── P0-04 配置并发 Lost-Update（Save 互斥 + 随机 tmp）

Phase 2 — 防 OOM（资源边界，1 周）
  ├── P0-05 非流式 256MiB 全量缓冲（分级预算）
  ├── P0-06 GIF/视频导入无预算（W*H*N*4 预检）
  ├── P0-07 Gallery zip-writeback / Music transcode 全量常驻（流式）
  └── P0-08 Gallery session_store expireLocked 遍历删除裂缝

Phase 3 — 正确性（P1，2 周）
  ├── P1-01 Playground searchHistory 引用共享 + Google 非流式断裂
  ├── P1-02 Download SSE 丢事件 + 并发不生效 + 相对路径放行
  ├── P1-03 Editor replaceDocTree 丢文件 + rename 不同步 _imgs
  ├── P1-04 Gallery batch 无并发上限 + 白名单三处不一致
  ├── P1-05 Demo 宿主裸 fetch 缺鉴权 + entry 编码 404
  ├── P1-06 Settings 跨域快捷键冲突 + Proxy 全量覆盖语义
  └── P1-07 Monitor currentKey 与 SelectKey 语义漂移

Phase 4 — 文件拆分（可维护性，2-4 周）
  ├── P2-01 style.css 6,442 行 → 按页面拆 6 文件
  ├── P2-02 gif-editor.js 2,994 行 → 按 stage/input/transparency-ui/actions 拆
  ├── P2-03 app.js 1,661 行 → 按 router/modal/shortcuts/auth/demo 拆
  ├── P2-04 providers.js 2,042 行 → 按 list/detail/models/keys 拆
  ├── P2-05 download.js 1,527 行 → 按 list/sse/detail/settings/input 拆
  ├── P2-06 pg-ui.js 2,021 行 → 按 events/params/reqleft 拆
  └── P2-07 internal/api/router.go 741 行 → 按域拆注册函数

Phase 5 — 加固与文档同步（持续）
  └── 回填 5 份 architecture 文档 + PROJECT_MAP.md §24 + 本文件状态
```

### 0.2 禁止的处理方式
- 只在前端隐藏路径字段，后端仍信任绝对路径
- 只做 `filepath.Clean`，不做 canonical root containment（`Abs+Clean+HasPrefix`）
- 只对初始 URL 做 DNS 检查，不处理重定向/DNS rebinding/二次解析
- 只限制单个 ZIP/session，不限制总内存/总磁盘/并发/生命周期
- 保留旧的任意路径 legacy endpoint 作为永久 alias
- 用「仅监听 localhost」替代认证、授权和路径边界
- 只加互斥锁不改变 `.tmp` 固定路径的并发写竞争

---

## 1. 审核上下文与基线

### 1.1 仓库和提交基线
- **仓库**：`Z:/Playground/tinyrouter`
- **审核 HEAD**：当前 HEAD（2026-08-29）
- **审核范围**：9 域（Settings / Monitor / Playground / Core Infra / Download / GIF Editor / Editor Suite / Gallery+Music / Demo）+ 模块化复核
- **审核期间未修改源码、配置或测试**
- **审核产出**：`docs/audit_fix.md`（第一轮，Phase A-F 已完成）+ 本文件（第二轮，Phase 1-5）

### 1.2 技术和部署事实
- Go 1.25+；chi 路由；YAML 配置；原生 JavaScript；无数据库、ORM 或 SQL 层
- HTTP 服务仅监听 localhost，但本地进程、本地网页、同站点不同端口页面和拥有管理会话的调用者仍属于必须考虑的攻击者
- `/v1/*` 当前设计为 OpenAI 兼容本地代理，不走应用层管理认证；这不是默认安全边界
- `/api/*` 管理面依赖可选 `PasswordEnabled`，默认关闭时 `AuthMiddleware` 直接放行
- `config.yaml` 中 API Key 的 AES-256-GCM 加密路径存在，但密码关闭时配置和 API 响应仍可能包含明文 Key

### 1.3 既有方案和必须继承的合同
本方案必须继承并落实：
- `docs/audit_fix.md` Phase A-F：已完成的 22 项安全修复（路径能力、owner-session、SSRF、CSRF、资源上限等）
- `docs/archive_compatibility_plan.md` §4、§7、§8、§12、§13：`sourceId`/`assetId`、严格路径、owner/job、root containment、预算、生命周期、旧接口迁移删除
- `docs/config-registry-state-architecture.md`：配置/Registry/State 所有权、原子持久化、reload merge、配置并发边界
- `docs/playground-architecture.md`：Playground 前后端契约、SSE 透传、多协议分支
- `docs/download-architecture.md`：yt-dlp 队列生命周期、参数构造、SSE 进度

### 1.4 已执行验证
```text
go build ./...                        pass
go vet ./...                          pass
go test ./...                         pass（38 包 ok，含 race）
node --check 各前端入口                 pass
govulncheck ./...                     pass（0 affected）
```
**限制**：本计划中的问题均为**新发现**，现有测试主要验证正常行为，不覆盖本文件的路径、认证、SSRF、并发、资源上限和拆分合同。

---

## 2. Phase 1 — 止血（安全边界）

### 2.1 P0-01 路径边界三处 + Editor 一处

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P0-01a | `internal/api/fsbrowse/register.go:52-61` | `resolveBrowseInitialDir` 对不存在的 `initialPath` 无条件 `MkdirAll(initialPath,0755)`，已认证用户可任意创建目录 | `os.MkdirAll(initialPath, 0o755)` 无 `HasPrefix` 校验 |
| P0-01b | `internal/api/download/register.go:370-430` | `playDownloadFile` 直接 `http.ServeFile(w,r,path)` 任意绝对路径；`extractSavedFilePath` 的 `absPath` 未校验在 `DownloadDir` 子树 | `http.ServeFile(w, r, path)` 无 `HasPrefix` 校验 |
| P0-01c | `internal/api/download/register.go:30-65` | `validateDownloadDir` 对相对路径放行（`filepath.IsAbs` 才校验子树），`"evil"` 直接通过 | `if filepath.IsAbs(cleaned)` 分支缺失 |
| P0-01d | `internal/api/textreview/export.go:58-70` | `export-split` 接受客户端任意 `TargetDir` 并直接 `MkdirAll + AtomicWrite`，可向服务端任意可写路径落盘 zip | `os.MkdirAll(req.TargetDir, 0755)` 无 `docDir` 约束 |
| P0-01e | `internal/api/editor/register.go:660-670` | `editorDeleteFile` `os.RemoveAll(oldName_imgs)` 不校验目录属主，可误删其他文件同名 `_imgs` | `os.RemoveAll(filepath.Join(docDir, oldName+"_imgs"))` 无能力校验 |

#### 修复方案
**统一层**：在 `internal/fsutil/` 新增 `PathGuard`：
```go
// PathGuard 提供 canonical root containment 校验
func PathGuard(root string, target string) (string, error) {
    absRoot, err := filepath.Abs(root)
    if err != nil { return "", err }
    absTarget, err := filepath.Abs(target)
    if err != nil { return "", err }
    cleanTarget := filepath.Clean(absTarget)
    if !strings.HasPrefix(cleanTarget, absRoot+string(os.PathSeparator)) && cleanTarget != absRoot {
        return "", fmt.Errorf("path outside allowed root: %s", target)
    }
    return cleanTarget, nil
}
```

**逐点修复**：
1. `fsbrowse/register.go:52-61`：`resolveBrowseInitialDir` 仅当 `initialPath` 在 `configDir` 子树内才 `MkdirAll`，否则返回空让前端回退到默认位置；记录审计日志
2. `download/register.go:370-430`：`playDownloadFile`/`openDownloadDir` 前二次校验 `absPath` 必须 `HasPrefix(Abs(DownloadDir)+sep)`，否则 403；`extractSavedFilePath` 成功后做 `Abs+Clean+子树检查`
3. `download/register.go:30-65`：`validateDownloadDir` 统一 `Abs` 化校验：若 `dir` 非空则 `Abs(cleaned)` 必须在 `Abs(defaultDir)` 子树内（相对路径先 `Join Abs(defaultDir)` 再校验，或直接拒绝相对路径）
4. `textreview/export.go:58-70`：`export-split` 的 `TargetDir` 必须 `HasPrefix(Abs(docDir)+sep)`，否则 400；`ZipName` 已 `sanitizeFilename`，保持
5. `editor/register.go:660-670`：`editorDeleteFile` 删除 `_imgs` 前校验 `pathGrant` 能力，或至少校验 `oldName` 与当前文件绑定

#### 验收合同
- [ ] `PathGuard` 单测覆盖 `../`/`..\\`/`/`/`C:\` 等逃逸路径
- [ ] 五个调用点全部通过 `PathGuard` 校验，测试用例验证 403/400
- [ ] `go test -race ./internal/api/...` 通过

---

### 2.2 P0-02 SSRF 防御断层

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P0-02a | `internal/api/music/register.go:104` | `proxy` 任意 URL 裸 `http.Client` 无 `outbound.Policy`，可探测内网/云 metadata | `http.Get(rawURL)` 无 `ssrfPolicy` |
| P0-02b | `internal/api/music/register.go:280-383` | `download` 任意 URL 裸 `http.Client` 无 `outbound.Policy` + 无 `LimitReader` | `io.Copy(w, resp.Body)` 无上限 |
| P0-02c | `internal/api/music/playlists.go:88-105` | `importPlaylistURL` 裸 `http.Get` 无超时/上下文，`MaxBytesReader` 在客户端响应 body 上无效 | `http.Get(url)` + `io.ReadAll` |
| P0-02d | `internal/api/image/register.go:110-190` | `image-proxy` 有 `ssrfPolicy.CheckHost` 首跳校验，但 `http.Client` 未配 `CheckRedirect`，重定向后可二次 SSRF | `http.Client` 无 `CheckRedirect` |

#### 修复方案
**统一层**：复用 `internal/outbound.Policy`（已存在），扩展 `CheckRedirect`：
```go
// HTTPClient 返回带 SSRF 校验的 http.Client
func (p *Policy) HTTPClient() *http.Client {
    return &http.Client{
        Timeout: p.timeout,
        CheckRedirect: func(req *http.Request, via []*http.Request) error {
            if len(via) >= 10 { return fmt.Errorf("too many redirects") }
            return p.CheckHost(req.Context(), req.URL)
        },
    }
}
```

**逐点修复**：
1. `music/register.go:104`：`proxy` 改用 `ssrfPolicy.HTTPClient()` + `CheckRedirect` 二次校验
2. `music/register.go:280-383`：`download` 改用 `ssrfPolicy.HTTPClient()` + `LimitReader(32<<20)` + `MaxBytesReader` 服务端侧
3. `music/playlists.go:88-105`：`importPlaylistURL` 改用 `ssrfPolicy.HTTPClient()` + `io.LimitReader(resp.Body, 5<<20)` + `Content-Length` 预检
4. `image/register.go:110-190`：`image-proxy` 的 `http.Client` 配 `CheckRedirect` 二次校验

**Bilibili 固定 host 白名单**：`bilibiliSearch`/`bilibiliResolve` 目标 host 固定 `api.bilibili.com`，非任意输入，但建议加 `AllowedHosts` 白名单防御纵深。

#### 验收合同
- [ ] `ssrfPolicy.HTTPClient()` 单测覆盖 `127.0.0.1`/`169.254.x`/`::1`/重定向后私有地址
- [ ] Music 三处调用点全部通过 `ssrfPolicy`，测试用例验证 403/413
- [ ] `image-proxy` 重定向测试：首跳公网 → 重定向私有地址被拒

---

### 2.3 P0-03 InFlight 泄漏（Monitor/CoreInfra 取消分支配对）

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P0-03a | `internal/proxy/forward_retry.go:111-115` | HardLimit 取消分支未 `DecInFlight()` + `Remove()` + `Signal()` | `return false, ""` 前无配对 |
| P0-03b | `internal/proxy/forward_retry.go:123-127` | NIM 取消分支未 `DecInFlight()` + `Remove()` + `Signal()` | 同上 |
| P0-03c | `internal/api/monitor/register.go:45-60` | `decInFlightForKeyID` 按 KeyID 首匹配，跨 Provider KeyID 碰撞扣错 key | `Entry` 无 `ProviderID` 字段 |

#### 修复方案
1. `forward_retry.go:111-127`：HardLimit/NIM 取消分支统一补：
```go
if canceled {
    p.DecInFlight(entryID)
    p.Remove(entryID)
    p.Signal()
    return false, ""
}
```
2. `monitor/register.go:45-60`：`Entry` 增 `ProviderID` 字段，`decInFlightForKeyID` 按 `(ProviderID, KeyID)` 精确匹配

#### 验收合同
- [ ] `forward_retry.go` 取消分支单测：验证 `DecInFlight` 计数正确
- [ ] `monitor/register.go` 跨 Provider KeyID 碰撞测试：验证扣减正确 key
- [ ] `go test -race ./internal/proxy/...` 通过

---

### 2.4 P0-04 配置并发 Lost-Update（Save 互斥 + 随机 tmp）

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P0-04a | `internal/api/providers/register.go:150` | `SaveConfig` 无锁，两标签页同时改端口+添加 Provider 互相覆盖 | `Reg.SaveConfig` 无互斥 |
| P0-04b | `internal/api/settings/register.go:351` | `SaveConfigAndReload` 无锁，同上 | 同上 |
| P0-04c | `internal/fsutil/atomic.go:30` | `AtomicWrite` 固定 `path+".tmp"`，并发写竞争截断 `.tmp` | `tmp := path + ".tmp"` |
| P0-04d | `internal/config/persistence.go:95-130` | `.tmp` 解析分支用 `yaml.NewDecoder{KnownFields:true}` 裸解析，不走 `decodeConfig` 的 deprecated strip，携带旧字段的 pending 保存被判 corrupt 丢失 | 第三分支 `yaml.NewDecoder` |

#### 修复方案
1. `internal/api/settings/register.go`：新增 `Deps.cfgSaveMu sync.Mutex`，所有 `Save*` 路径串行化
2. `internal/api/providers/register.go`：复用同一 `cfgSaveMu`
3. `internal/fsutil/atomic.go:30`：`AtomicWrite` 改随机后缀：
```go
tmp := fmt.Sprintf("%s.tmp.%d", path, time.Now().UnixNano())
```
4. `persistence.go:95-130`：`.tmp` 解析分支改走 `decodeConfig`（含 `stripPaths` + `convertLegacyAssistantFields`）

#### 验收合同
- [ ] 并发 Save 测试：10 并发 `SaveConfig` + `SaveConfigAndReload`，验证最终配置一致
- [ ] `AtomicWrite` 并发测试：10 并发写同文件，验证 `.tmp` 不竞争
- [ ] `.tmp` 解析测试：携带 `paths`/`assistant` 旧字段的 `.tmp` 能正确迁移

---

## 3. Phase 2 — 防 OOM（资源边界）

### 3.1 P0-05 非流式 256MiB 全量缓冲（分级预算）

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P0-05a | `internal/proxy/stream.go:430` | `passThroughResponse` 全量 `ReadAll(256MiB)`，20 并发即 5GiB 堆 | `io.ReadAll(io.LimitReader(resp.Body, budget+1))` |
| P0-05b | `internal/proxy/stream.go:300-380` | 图像/大文本非流式同样全量缓冲 | 同上 |

#### 修复方案
分级预算：
- 文本（`text/*`/`application/json`）：32MiB
- 图像（`image/*`）：流式 `io.Copy` 不缓冲
- 其他：16MiB

`stream.go:430` 改：
```go
budget := maxPassThroughBody // 256MiB 默认
if strings.HasPrefix(contentType, "image/") {
    // 流式不缓冲
    io.Copy(w, resp.Body)
    return
} else if strings.HasPrefix(contentType, "text/") || strings.HasPrefix(contentType, "application/json") {
    budget = 32 << 20 // 32MiB
} else {
    budget = 16 << 20 // 16MiB
}
body, err := io.ReadAll(io.LimitReader(resp.Body, budget+1))
```

#### 验收合同
- [ ] 图像非流式测试：验证流式 `io.Copy` 不缓冲
- [ ] 文本非流式测试：验证 32MiB 超限 413
- [ ] 内存压测：20 并发图像请求，堆增长 < 100MB

---

### 3.2 P0-06 GIF/视频导入无预算（W*H*N*4 预检）

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P0-06a | `web/static/gif-editor/gif-editor-import.js:210-310` | `compositeGifFrames` 每帧 3 个全尺寸 canvas（prev/patch/snap），500帧×800×600×3 ≈ 2.8GiB | `prevStateCanvas`/`patchCanvas`/`snapCanvas` 每帧新建 |
| P0-06b | `web/static/gif-editor/gif-editor-import.js:commitVideoDraft` | 视频采样无预算，30fps×10s 4K ≈ 9GiB | 无 `frameCount*W*H*4` 预算 |

#### 修复方案
1. `gif-editor-import.js:210-310`：导入前预检：
```js
const budget = 2 << 30; // 2GiB
const estimated = frameCount * width * height * 4 * 3; // 3 canvas
if (estimated > budget) {
    throw new Error(`导入超出预算：${formatBytes(estimated)} > ${formatBytes(budget)}`);
}
```
2. `gif-editor-import.js:commitVideoDraft`：视频采样前预检：
```js
const budget = 4 << 30; // 4GiB
const estimated = frameCount * width * height * 4;
if (estimated > budget) { ... }
```
3. 复用 canvas：`prevStateCanvas`/`patchCanvas`/`snapCanvas` 改为复用而非每帧新建

#### 验收合同
- [ ] 导入预检测试：500帧 800×600 触发预算拒绝
- [ ] 视频采样预检测试：30fps×10s 4K 触发预算拒绝
- [ ] 内存压测：导入 100 帧后堆增长 < 500MB

---

### 3.3 P0-07 Gallery zip-writeback / Music transcode 全量常驻（流式）

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P0-07a | `internal/api/gallery/edit_handlers.go:700-750` | `zip-writeback` 全量 `os.ReadFile(target)` 无预算，`replacements` `io.ReadAll` 全量常驻 | `os.ReadFile(target)` 无 `LimitReader` |
| P0-07b | `internal/api/music/transcode.go:18-44` | `runFFmpegTranscode` 将整段音频读入 `input []byte` 再 `bytes.Buffer` 输出，200MB 输入可膨胀为 400MB+ WAV | `bytes.Buffer` 无上限 |

#### 修复方案
1. `gallery/edit_handlers.go:700-750`：
   - 引入 `archive.DefaultBudget().MaxOutputBytes` + `maxZipDiskSize` 双重熔断
   - 流式 `Replace`：`zip.Reader` 流式拷贝而非全量 `[]byte`
   - 替换数与单项大小逐项限流，超限 413
2. `music/transcode.go:18-44`：
   - 改 pipe 流式：`stdinPipe`/`stdoutPipe` 边读边写
   - 或 tmp file + 限输出（如 300MB）
   - 并发数与输入时长双维度限流，超限 413

#### 验收合同
- [ ] zip-writeback 测试：100×10MB 替换触发 413
- [ ] transcode 测试：200MB 输入触发 413 或流式完成
- [ ] 内存压测：zip-writeback 后堆增长 < 200MB

---

### 3.4 P0-08 Gallery session_store expireLocked 遍历删除裂缝

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P0-08 | `internal/api/gallery/session_store.go:112-122` | `expireLocked` 在遍历 `s.order` 期间同步调用 `removeLocked` 改 `s.order`，导致跳过/漏删过期 session | `for _, id := range s.order { s.removeLocked(id) }` |

#### 修复方案
`session_store.go:112-122` 改为收集待删 ids 后二次删除：
```go
func (s *SessionStore) expireLocked(now time.Time) {
    var expired []string
    for _, id := range s.order {
        if s.sessions[id].Expired(now) {
            expired = append(expired, id)
        }
    }
    for _, id := range expired {
        s.removeLocked(id)
    }
}
```

#### 验收合同
- [ ] `TestSessionStore_TTLExpireSkips`：连续过期 3+ 项全部正确删除
- [ ] `go test -race ./internal/api/gallery/...` 通过

---

## 4. Phase 3 — 正确性（P1）

### 4.1 P1-01 Playground searchHistory 引用共享 + Google 非流式断裂

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P1-01a | `web/playground/static-pg/playground/pg-state.js:119-130` | `searchHistory.messages` 与 `windows[0].messages` 同引用，污染 + `localStorage` 4MB 溢出静默丢弃 | `windows[i].messages = msgs` 直接赋值 |
| P1-01b | `web/playground/static-pg/playground/pg-stream.js:216` | `pgSendNonStream` 硬编码 `/v1/chat/completions`，Google 模型非流式 100% 失败 | `var url = '/v1/chat/completions';` 无 `isGoogle` 分支 |
| P1-01c | `web/playground/static-pg/playground/pg-image-tasks.js:35-38` | `effectiveConcurrency` 取 `activeWin` 而非 `task.winIndex`，切窗放大后台限额 | `pgState.activeWin.config.imgConcurrency` |

#### 修复方案
1. `pg-state.js:119-130`：`pgSyncSearchMessages` 改浅拷贝隔离：
```js
windows[i].messages = msgs.map(m => ({ ...m }));
```
2. `pg-stream.js:216`：抽 `pgChatUrl()`：
```js
function pgChatUrl(isGoogle) {
    return isGoogle ? '/v1beta/models/...:generateContent' : '/v1/chat/completions';
}
```
3. `pg-image-tasks.js:35-38`：`effectiveConcurrency` 按 `task.winIndex` 读取对应窗口配置

#### 验收合同
- [ ] searchHistory 污染测试：切窗后 history 不串
- [ ] Google 非流式测试：验证 `generateContent` 路径正确
- [ ] 并发限额测试：切窗后后台任务仍按原窗口限额

---

### 4.2 P1-02 Download SSE 丢事件 + 并发不生效 + 相对路径放行

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P1-02a | `web/static/download.js:740-780` | SSE 事件非阻塞丢弃 + 前端无 `Last-Event-ID`/全量补齐，重连或突发进度下 UI 永久错位 | `publishEvent` 满则丢弃 |
| P1-02b | `internal/download/manager.go:72-82` | `UpdateSettings` 改 `maxConcurrent` 不扩缩 worker，运行时不生效 | 仅更新字段，不增减 goroutine |
| P1-02c | `internal/api/download/register.go:30-65` | `validateDownloadDir` 放行相对路径 | 见 P0-01c |

#### 修复方案
1. `download.js:740-780`：前端 `onerror` 重连后调用 `loadDownloadTasks()` 全量校正；或 SSE 通道加单调 `seq` 并在重连时携带 `Last-Event-ID`
2. `manager.go:72-82`：`UpdateSettings` 对比新旧值：增加则 `wg.Add(1) + go worker()`，减少则通过 `stopCh` + 新 channel 或令牌桶限流
3. `download/register.go:30-65`：见 P0-01c 修复

#### 验收合同
- [ ] SSE 重连测试：重连后 UI 状态与后端一致
- [ ] 并发扩缩测试：改 `maxConcurrent` 后 worker 数实时变化
- [ ] 相对路径测试：`"evil"` 被 400 拒绝

---

### 4.3 P1-03 Editor replaceDocTree 丢文件 + rename 不同步 _imgs

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P1-03a | `web/static/utility/editor/editor_workspace.js:369-400` | `replaceDocTree` 全量替换 `memory.nodes = nextNodes` 丢弃本地未落盘文件 | 无合并逻辑 |
| P1-03b | `internal/api/editor/register.go:404-410` | `editorRename` 只 `os.Rename(target, newPath)`，未同步重命名 `oldName_imgs` 目录 | 无 `os.Rename(imgsDir, newImgsDir)` |
| P1-03c | `internal/api/textreview/sessions.go` | 会话无 TTL/容量上限，无界常驻至 OOM | 无 `Sweep/TTL` |

#### 修复方案
1. `editor_workspace.js:369-400`：`replaceDocTree` 合并保留本地节点：
```js
const localOnly = memory.nodes.filter(n => !nextNodes.find(nn => nn.id === n.id) && n.isLocal);
memory.nodes = [...nextNodes, ...localOnly];
```
2. `editor/register.go:404-410`：`editorRename` 成功后同步：
```go
if imgsDir := filepath.Join(docDir, oldName+"_imgs"); fileExists(imgsDir) {
    newImgsDir := filepath.Join(docDir, newName+"_imgs")
    os.Rename(imgsDir, newImgsDir)
}
```
3. `textreview/sessions.go`：加 `Sweep` 定时清理 + `maxSessions`/`maxBytes` 熔断

#### 验收合同
- [ ] replaceDocTree 测试：本地未落盘文件保留
- [ ] rename 测试：`_imgs` 目录同步重命名
- [ ] 会话 TTL 测试：过期会话被清理

---

### 4.4 P1-04 Gallery batch 无并发上限 + 白名单三处不一致

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P1-04a | `web/playground/static-pg/gallery/gallery-edit-batch.js:237-310` | 批量编辑无并发上限，50-200 并发 429 雪崩 | 无 `runWithConcurrency` |
| P1-04b | `web/playground/static-pg/gallery/gallery-state.js:6` vs `gallery-io.js:28` vs `internal/api/gallery/fs_handlers.go:15-25` | 三处白名单不一致：前端 `SUPPORTED_IMG_EXTS` 含 `avif`，`_ARCHIVE_IMG_EXTS` 与后端 `galleryImgExts` 未含 | 前端 `avif` 可见，zip 内不可见 |

#### 修复方案
1. `gallery-edit-batch.js:237-310`：引入 `runWithConcurrency(cap=4~6)` 或服务端队列
2. 白名单单源：抽 `internal/gallery.SupportedExts` 常量，前端/后端共用

#### 验收合同
- [ ] batch 并发测试：50 任务无 429 雪崩
- [ ] 白名单一致性测试：三处 `isSupported` 返回一致

---

### 4.5 P1-05 Demo 宿主裸 fetch 缺鉴权 + entry 编码 404

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P1-05a | `web/static/demo-games.js:95/148/157/167/178` | 宿主裸 `fetch("/api/games")` 未带 `Authorization`，密码保护开启后 401 列表空白 | 无 `Authorization` 头 |
| P1-05b | `web/static/demo-games.js:118` | `encodeURIComponent(entry)` 整体编码，`entry="assets/main.js"` 404 | `assets%2Fmain.js` |
| P1-05c | `web/static/assistant-demo.js:834-843` | `ademoPaused` 仅门控 `ademoStep`/`ademoSM.tick`，`ademoOnKeyDown` 无 `ademoPaused` 判断，退出游戏后幽灵滑行 | `ademoKeys` 仍被改写 |

#### 修复方案
1. `demo-games.js`：宿主切 `apiFetch`（带 `Authorization`）
2. `demo-games.js:118`：`entry` 按段编码：
```js
const url = '/games/' + id + '/' + entry.split('/').map(encodeURIComponent).join('/');
```
3. `assistant-demo.js:834-843`：`ademoOnKeyDown` 加 `ademoPaused` 门控

#### 验收合同
- [ ] 密码保护开启后 `/api/games` 200
- [ ] `assets/main.js` 200
- [ ] 暂停后按键无效

---

### 4.6 P1-06 Settings 跨域快捷键冲突 + Proxy 全量覆盖语义

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P1-06a | `web/static/settings/settings_shortcuts.js:241` | `findConflict(region, ...)` 仅同 region，`saveShortcutsModal` 同样仅同 region，跨域冲突放行（Global F6 与 Gallery 快捷键同值，Gallery 永远饥饿） | 无跨 region 校验 |
| P1-06b | `internal/api/settings/register.go:221-227` | `updates.Proxy != nil` 即整表覆盖，前端仅 PATCH `proxy` 无钥匙级合并语义 | 全量覆盖 |

#### 修复方案
1. `settings_shortcuts.js:241`：`findConflict` 加跨 region 校验：
```js
function findConflict(region, key, value) {
    // 同 region 校验 + 跨 region 冲突检测（如 Global 与 Gallery）
}
```
2. `settings/register.go:221-227`：Proxy 改按 key 级 merge：
```go
if updates.Proxy != nil {
    for k, v := range updates.Proxy {
        cfg.Proxy[k] = v // 而非 cfg.Proxy = updates.Proxy
    }
}
```

#### 验收合同
- [ ] 跨域冲突测试：Global F6 与 Gallery F6 触发冲突提示
- [ ] Proxy merge 测试：PATCH `{proxy:{a:1}}` 保留 `{b:2}`

---

### 4.7 P1-07 Monitor currentKey 与 SelectKey 语义漂移

#### 问题清单
| 编号 | 文件 | 问题 | 证据 |
|---|---|---|---|
| P1-07 | `internal/api/monitor/register.go:480-620` | `currentKey` 仅用 `IsActive+ModelLocks`，未调用 `IsNIMEnabled`/`filterNIMCandidates`/`ManualKey`，与 `getModelKeys` 的可用性判定不一致 | 未展开状态显示的 `in-use` 与展开后的置顶行不一致 |

#### 修复方案
`monitor/register.go:480-620`：`currentKey` 复用 `rotation.Selector` 的可用性判定，或至少加 `IsNIMEnabled`/`ManualKey` 过滤

#### 验收合同
- [ ] currentKey 一致性测试：未展开与展开后显示一致

---

## 5. Phase 4 — 文件拆分（可维护性）

### 5.1 P2-01 `style.css` 6,442 行 → 按页面拆 6 文件

#### 拆分方案
- 保留 `style.css` 为共享层（~1,500 行：变量/组件/通用类）
- 按页面拆：
  - `style-settings.css`（~800 行）
  - `style-monitor.css`（~600 行）
  - `style-download.css`（~500 行）
  - `style-demo.css`（~400 行）
  - `style-utility.css`（~800 行）
  - `style-music.css`（~300 行）

#### 验收合同
- [ ] 拆分后 `go build ./...` 通过
- [ ] 各页面样式无回归（手测）

---

### 5.2 P2-02 `gif-editor.js` 2,994 行 → 按 stage/input/transparency-ui/actions 拆

#### 拆分方案
- `gif-editor.js` 保留：核心生命周期 + `core.commands` 暴露
- 抽 `gif-editor-page.js`（模板+生命周期，~500 行）
- 抽 `gif-editor-stage.js`（draw/pan/zoom/gizmo/hit test，~600 行）
- 抽 `gif-editor-transparency-ui.js`（trans 面板交互，~700 行）
- 抽 `gif-editor-input.js`（bindEvents drag/drop/paste/keyboard，~800 行）
- 抽 `gif-editor-actions.js`（add text/image、batch delete/keep、layer ops，~400 行）

#### 验收合同
- [ ] 拆分后 `node --check` 全部通过
- [ ] `core.commands.*` 与 `GifEditorCore` 暴露不变
- [ ] 手测 GIF 编辑全流程无回归

---

### 5.3 P2-03 `app.js` 1,661 行 → 按 router/modal/shortcuts/auth/demo 拆

#### 拆分方案
- `app.js` 保留：入口 + 初始化
- 抽 `app-router.js`（navigateTo + cleanup + page lifecycle）
- 抽 `app-modal.js`（openModal/closeModalOverlay/dismissTopModal）
- 抽 `app-shortcuts.js`（全局 keydown/Escape 钩子）
- 抽 `app-i18n-boot.js`（i18n start/refresh）
- 抽 `app-auth.js`（登录/会话守卫）
- 抽 `app-demo.js`（demo 页装载与清理）

#### 验收合同
- [ ] 拆分后 `node --check` 全部通过
- [ ] `navigateTo/topOpenModal/openModelPickerModal` 等全局保持原位
- [ ] 手测路由/弹窗/快捷键无回归

---

### 5.4 P2-04 `providers.js` 2,042 行 → 按 list/detail/models/keys 拆

#### 拆分方案
- `providers.js` 保留：列表+卡片
- 抽 `providers-detail.js`（详情页）
- 抽 `providers-models.js`（模型 CRUD + alias 管理）
- 抽 `providers-keys.js`（Key CRUD + 测试）

#### 验收合同
- [ ] 拆分后 `node --check` 全部通过
- [ ] 手测 Provider 全流程无回归

---

### 5.5 P2-05 `download.js` 1,527 行 → 按 list/sse/detail/settings/input 拆

#### 拆分方案
- `download.js` 保留：入口 + 顶部输入 + 状态机
- 抽 `download-list.js`（任务列表渲染+多选+排序）
- 抽 `download-sse.js`（EventSource 生命周期 + 断线重连）
- 抽 `download-detail.js`（右侧详情面板）
- 抽 `download-settings.js`（弹窗与路径设置）

#### 验收合同
- [ ] 拆分后 `node --check` 全部通过
- [ ] 手测下载全流程无回归

---

### 5.6 P2-06 `pg-ui.js` 2,021 行 → 按 events/params/reqleft 拆

#### 拆分方案
- `pg-ui.js` 保留：pane 布局 + 模式切换 + sidebar 渲染核心
- 抽 `pg-ui-events.js`（所有 `pgOn*` 事件处理 + 快捷键）
- 抽 `pg-ui-params.js`（`pgRenderImageParams`/`pgRenderComfyPanel` 参数面板与模型选择）
- 抽 `pg-ui-reqleft.js`（Request Left 轮询与渲染）

#### 验收合同
- [ ] 拆分后 `node --check` 全部通过
- [ ] `window.pgRenderSidebar` 等全局函数名不变
- [ ] 手测 Playground 全流程无回归

---

### 5.7 P2-07 `internal/api/router.go` 741 行 → 按域拆注册函数

#### 拆分方案
- `router.go` 保留：核心 `/api` + `/v1` 骨架
- 抽 `router_proxy.go`（Proxy 相关路由）
- 抽 `router_playground.go`（Playground 相关路由）
- 抽 `router_utility.go`（Utility 相关路由）
- 抽 `router_demo.go`（Demo 相关路由）

#### 验收合同
- [ ] 拆分后 `go build ./...` 通过
- [ ] 路由测试全部通过

---

## 6. Phase 5 — 加固与文档同步

### 6.1 回填 5 份 architecture 文档 + PROJECT_MAP.md §24

#### 需要更新的文档
| 文档 | 更新内容 |
|---|---|
| `docs/proxy-architecture.md` | 分级预算（文本32MiB/图像流式）+ InFlight 泄漏修复 |
| `docs/rotation-architecture.md` | `IsDailyQuota429` 放宽 + `manualPins` 快照拷贝 |
| `docs/download-architecture.md` | 磁盘水位拒绝 + 播放列表上限 + `--max-filesize` + 并发扩缩 |
| `docs/config-registry-state-architecture.md` | `cfgSaveMu` 串行化 + 随机 tmp + `.tmp` 解析走 `decodeConfig` |
| `docs/playground-architecture.md` | searchHistory 隔离 + `pgChatUrl()` + `providerRunning` 按 `winIndex` |
| `PROJECT_MAP.md` §24 | 文件拆分后的新文件清单 |

#### 验收合同
- [ ] 5 份文档的「最后核对」行更新为当前日期
- [ ] `PROJECT_MAP.md` §24 的文件清单与实际一致

---

## 7. 全局验收门禁

### 7.1 代码门禁
```text
go build ./...                        pass
go vet ./...                          pass
go test ./...                         pass（38 包 ok）
go test -race ./...                   pass
node --check 各前端入口                 pass
govulncheck ./...                     pass（0 affected）
```

### 7.2 安全门禁
- [ ] 路径边界：五处调用点全部通过 `PathGuard`，测试用例验证 403/400
- [ ] SSRF：Music/Image 全部通过 `ssrfPolicy.HTTPClient()`，重定向二次校验
- [ ] InFlight：取消分支配对 `DecInFlight+Remove+Signal`
- [ ] 配置并发：10 并发 Save 无 Lost-Update，`.tmp` 不竞争

### 7.3 资源门禁
- [ ] 非流式分级预算：文本32MiB/图像流式
- [ ] GIF/视频导入预算：`W*H*N*4` 预检
- [ ] zip-writeback/transcode 流式：无全量常驻
- [ ] session_store TTL：过期正确删除

### 7.4 正确性门禁
- [ ] Playground：searchHistory 不串、Google 非流式正确、并发限额按 winIndex
- [ ] Download：SSE 重连一致、并发扩缩生效、相对路径拒绝
- [ ] Editor：replaceDocTree 保留本地、rename 同步 _imgs、会话 TTL
- [ ] Gallery：batch 无 429 雪崩、白名单一致
- [ ] Demo：宿主带鉴权、entry 编码正确、暂停门控按键
- [ ] Settings：跨域快捷键冲突、Proxy merge
- [ ] Monitor：currentKey 与 SelectKey 一致

### 7.5 拆分门禁
- [ ] 拆分后 `go build ./...` + `node --check` 全部通过
- [ ] 全局函数名/暴露接口不变
- [ ] 手测全流程无回归

---

## 8. 附录

### 8.1 新增遗漏清单（第二轮复核新增）
| 编号 | 域 | 问题 | 修复 |
|---|---|---|---|
| S-EN-1 | Settings | `Settings PATCH` 走 `SaveConfigAndReload`，Provider/Combo 走 `SaveConfig`，运行时收敛不一致 | 统一所有写配置路径走 `SaveConfigAndReload` |
| M-EN-1 | Monitor | `refreshAllKeyDetails` 每个 quota bar 一次 `fetchModelKeyDetail`，50 bar 即 50 并发 | 加 `runWithConcurrency(6)` |
| PG-EN-1 | Playground | ModelScope 轮询无 AbortController 链，取消后仍每 2s 持续到 60 次 | `delayThen` 接受 `signal` |
| G-EN-1 | Gallery+Music | Music `download` 未校验 `musicDir` 根目录合法性，可写盘根 | `musicDir()` 加 `Abs+Clean+HasPrefix(AllowedRoot)` |
| G-EN-2 | Gallery | `galleryTree` 与 `galleryIO` 的扩展名白名单与后端 `galleryImgExts` 不同步 | 抽单源常量 `internal/gallery.SupportedExts` |
| DE-EN-1 | Demo | `survivor` 插件 `llmChat` 走裸 `fetch` 无鉴权头 | 确认 `/v1` 鉴权语义 |
| E-EN-1 | Editor | `editorRename` 不同步 `oldName_imgs` 目录 | 同步 `os.Rename(imgsDir, newImgsDir)` |
| E-EN-2 | Editor | TextReview 会话无 TTL/容量上限 | 加 `Sweep` + `maxSessions`/`maxBytes` |
| D-EN-1 | Download | `Stop` 后 `pendingCh` 残留，热重启场景旧任务被新 worker 消费 | `Stop` 时 drain+close `pendingCh` |

### 8.2 拆分原则（统一执行）
- **每次拆分保持所有全局函数名不变**（外部调用方通过 `window.XXX` 调用，移动文件不改变语义约定）
- **HTML/CSS/JS 不拆**到 < 50 行的碎片化模块
- **vendor 不拆**（保留原库形态）
- **拆分后同步 PROJECT_MAP.md §24 与相关 architecture 文档**
- **保证 `go build ./...` 与 `node --check` 全部通过**

### 8.3 拆分前一致性约束
拆分后，务必保持：
- `pg-ui.js` 的 window 函数注册表不变（`window.pgRenderSidebar` 等）
- `gif-editor.js` 中 `core.commands.*` 与 `GifEditorCore` 暴露不变
- `app.js` 中 `navigateTo/topOpenModal/openModelPickerModal` 等全局保持原位
- `download.js` 中 `renderDownload` 与 SSE 入口可单独 import，或维护 `window.downloadEntry` 依赖顺序

---

## 9. 修复提交规范

每个 Phase 完成后提交一次：
```
Phase 1: fix(security): remediate path boundary, SSRF, inflight leak, config race
Phase 2: fix(resource): add budget, streaming, session TTL
Phase 3: fix(correctness): playground history, download SSE, editor rename, gallery batch
Phase 4: refactor(frontend): split style.css, gif-editor, app, providers, download, pg-ui
Phase 5: docs(architecture): sync 5 architecture docs + PROJECT_MAP.md
```

---

**文档结束。**
