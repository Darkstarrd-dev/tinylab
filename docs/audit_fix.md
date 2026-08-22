# TinyRouter 发布前全库审核修复方案

> 文档用途：本文件是发布前修复流程的执行上下文、任务分解、验收合同和发布门禁。后续处理应以本文件的任务编号、接口合同和验收条件为准；不得只修复单个症状而保留同类路径/认证/资源漏洞。
>
> 文档状态：执行中（Phase A–F 已按本方案实施并已提交（修复提交 `2bc4637`，security(audit): remediate pre-release findings），2026-08-09；`go build ./...`/`go vet ./...`/`go test ./...` 全绿；**`go test -race ./...` 全量通过**（38 包 ok；修复 textreview 测试 harness 同步 + mediaedit `cmd.Cancel` 先于 `cmd.Start`）；**`govulncheck v1.6.0` 零漏洞**（0 affected/0 called，DB 2026-07-27；chi v5.2.2 + toolchain go1.26.5）；**F-29 修复完成**（owner 中间件双挂载 + session purge，owner 隔离测试全绿）；**F-23 控制台日志消毒已补**（`sanitize` + `emit` 出口）；**GIF 编辑器导出合同已迁移 assetId**（`gif-editor-export.js` + `gif-editor-export-contract.test.js` PASS，F-03 证据）；**F-15 确定性预算/清理测试全绿**（session 413/429/pin/TTL、tempstore 配额、archive 422/503），**真实 HTTP 压力 harness 被工具文件系统 split-brain 阻塞未跑成（bash 与 node/write 对 `%TEMP%` 看到不同文件系统，hub spawn 构建产物 ENOENT），F-15 保持 partial**；附录 B 状态表已按源码+测试证据更新；**跨平台构建（GOOS=darwin/windows 交叉编译）与浏览器 smoke 仍未执行**；发布门禁 §8 与完成定义 §10 尚未全部满足）
>
> 方案版本：1.0
>
> 编制日期：2026-08-09

---

## 0. 执行摘要

当前版本不得直接发布。审核发现的主要风险不是单点输入校验错误，而是同一个架构问题在多个模块重复出现：浏览器可以直接提交服务端物理路径，管理路由的认证是可选的，临时资源没有统一 owner/session 能力模型，外部 URL/外部工具也没有按调用场景统一约束。

修复必须按以下顺序执行：

1. 先冻结并收紧安全边界，阻断任意路径 API、明文凭证回传、无认证管理 API 和 CSRF。
2. 再引入统一的 path grant / asset capability / owner-session 合同，迁移 Editor、Gallery、FileTransfer、Archive 旧路径。
3. 再修复 SSRF、ffprobe、外部工具、macOS AppleScript 和 HTML iframe 隔离。
4. 再修复 7z 逻辑、响应/SSE/临时文件资源上限、配置 reload 和并发缺陷。
5. 最后运行完整测试、竞态检查、依赖漏洞扫描、跨平台构建和浏览器安全 smoke，满足全部发布门禁后才允许发布。

禁止的处理方式：

- 只在前端隐藏路径字段，后端仍信任绝对路径；
- 只增加 `filepath.Clean`，不做 canonical root containment；
- 只把 Cookie 设为 HttpOnly/SameSite，却不做 CSRF/Origin 校验；
- 只对初始 URL 做 DNS 检查，却不处理重定向、DNS rebinding 或外部工具的二次解析；
- 只限制单个 ZIP/session，不限制总内存、总磁盘、并发和生命周期；
- 保留旧的任意路径 legacy endpoint 作为永久 alias；
- 用“仅监听 localhost”替代认证、授权和路径边界。

---

## 1. 审核上下文与基线

### 1.1 仓库和提交基线

- 仓库：`Z:/Playground/tinyrouter`
- 审核 HEAD：`c099129`
- HEAD 提交信息：`fix(editor): resolve history clear bug, iframe styling corruption, and statusbar theme integration`
- 审核期间未修改源码、配置或测试。
- 审核期间的用户外部文件变更必须保留，不得通过 reset、checkout、clean 或删除操作覆盖。审核过程中该文件状态曾显示为 `Qwen3.6-27B-DSpark.gguf` 的未提交变化；执行修复前必须重新确认其状态并单独保护。

### 1.2 技术和部署事实

- Go 1.25+；chi 路由；YAML 配置；原生 JavaScript；无数据库、ORM 或 SQL 层。
- HTTP 服务仅监听 localhost，但本地进程、本地网页、同站点不同端口页面和拥有管理会话的调用者仍属于必须考虑的攻击者。
- `/v1/*` 当前设计为 OpenAI 兼容本地代理，不走应用层管理认证；这不是默认安全边界，必须在发布文档和 API 合同中明确。
- `/api/*` 管理面、Gallery、Archive、Editor、FileTransfer 当前依赖可选 `PasswordEnabled`。默认关闭时 `AuthMiddleware` 直接放行。
- `config.yaml` 中 API Key 的 AES-256-GCM 加密路径存在，但密码关闭时配置和 API 响应仍可能包含明文 Key。

### 1.3 已执行验证

已观察到：

```text
go test ./...                         31 packages ok, 22 packages without tests
go build ./...                        pass
go vet ./...                          pass
关键 API/Archive/Proxy 测试              pass
node --check editor_shell.js          pass
node --check editor_markdown.js       pass
node --check editor.js                 pass
```

限制：

```text
go test -race ...                      受 runtime/cgo 构建失败影响，未完成
govulncheck ./...                      本机未安装，未完成 Go 漏洞数据库扫描
```

这些门禁通过不代表安全问题已修复；现有测试主要验证正常行为，不覆盖本文件的路径、认证、SSRF、owner、资源上限和隔离合同。

### 1.4 既有方案和必须继承的合同

本方案必须继承并落实：

- `docs/archive_compatibility_plan.md` §4、§7、§8、§12、§13：`sourceId`/`assetId`、严格路径、owner/job、root containment、预算、生命周期、旧接口迁移删除、归档测试矩阵。
- `docs/config-registry-state-architecture.md`：配置/Registry/State 所有权、原子持久化、reload merge、配置并发边界。
- `docs/proxy-architecture.md`：`/v1` 路由边界、重试、SSE、用量、Trace 和上游 URL 构造。
- `PROJECT_MAP.md` §23–§24：当前 Archive P3 仍部分落地，旧 Gallery 任意路径/legacy 端点仍保留；所有实现完成后必须同步模块地图和受影响架构文档。

---

## 2. 审核范围、白名单和排除项

### 2.1 优先关注的安全白名单

只把下列类别作为安全漏洞结论：

- SQL 注入/命令注入；
- 反序列化漏洞；
- SSRF；
- 路径遍历/任意文件读写；
- 权限绕过/认证缺陷；
- 硬编码凭证。

输入校验中的高可信 XSS 也纳入本方案，因为 Editor iframe 能执行同源管理 API 请求，实际影响超出普通显示问题。

### 2.2 明确不作为漏洞的内容

- 普通变量命名、注释密度和代码风格；
- 不能由外部输入触发的理论空指针；
- 不可利用的内部函数调用；
- 单纯性能建议，除非可造成有明确输入路径的 DoS；
- 没有证据的 Mermaid/第三方未知绕过猜测；
- `X-TinyRouter-Source` 欺骗、日志换行等低影响完整性问题，除非后续实现把它们变成授权依据。

---

## 3. 统一安全目标和不可变约束

### 3.1 管理认证目标

推荐目标：

- `/api/*` 管理面是否启用密码保护由 `Security.PasswordEnabled` 决定；关闭时管理路由直接放行，首次启动和关闭保护均不得强制 setup 弹窗。
- 仅当 `PasswordEnabled=true` 时，进入管理 UI 需要有效 session；状态变更请求还需 session-bound CSRF、Origin/Referer 和 JSON/multipart Content-Type。
- `PasswordEnabled=false` 配置保持开放管理语义，不迁移为 setup-required；`POST /api/auth/setup` 仅作为用户主动启用密码的可选 bootstrap。
- `/v1/*` 是否保持无应用层认证必须作为显式兼容决策。保持本地代理语义，但不允许 `/v1` 获得配置修改能力，也不把 `/v1` 误称为管理认证。

该产品决策接受“关闭密码时不提供本地管理面进程隔离”的风险；密码开启后仍由 session/CSRF 门禁保护管理接口。

### 3.2 CSRF 目标

所有带 Cookie 的状态变更请求必须同时满足：

1. 有效 session；
2. 有效 CSRF token，token 与 session 绑定；
3. `Origin`/`Referer` 符合当前本地管理 origin；
4. JSON API 强制 `Content-Type: application/json`；
5. multipart 上传使用独立 CSRF 校验；
6. 错误响应不能泄露内部路径、命令、凭证或完整上游 body。

`HttpOnly`、`SameSite=Lax` 只作为纵深防御，不得作为唯一 CSRF 控制。

### 3.3 物理路径目标

浏览器不得直接提交可执行的服务端绝对路径作为资源身份。所有跨请求资源必须使用：

- `assetId`：单个服务端资源；
- `sourceId`：已登记归档源；
- `jobId`：后台任务；
- `pathGrantId`：由服务端 picker/显式用户授权生成的一次性或短 TTL 路径能力。

服务端路径必须满足：

- `filepath.Abs` 后做 canonical/realpath 解析；
- 检查 root containment；
- 拒绝符号链接逃逸；
- 拒绝 `..`、绝对路径、UNC、盘符、NUL、ADS、控制字符和 Windows 保留设备名；
- 读、写、删除、回写分别声明能力，不以“能读”推导“能写/删”；
- response 只返回资源 ID 和必要元数据，不返回物理路径。

### 3.4 外部出站目标目标

必须按调用场景区分：

| 场景 | 默认策略 |
|---|---|
| 图片代理/保存图片 | 禁止 loopback/private/link-local/multicast/unspecified；重定向逐跳检查；DNS rebinding 防护 |
| AnySearch extract | 只发送到固定 AnySearch endpoint；用户 URL 作为上游参数时按 AnySearch 合同处理，不直接由 TinyRouter fetch |
| Provider 管理探测 | 默认拒绝私网目标；若必须支持本地 Provider，使用显式 `allowPrivateProvider` 能力并要求认证 |
| 已登记 Provider 的 `/v1` 代理 | 允许产品支持的本地 Provider，但 Provider 注册/修改必须受管理认证保护；不允许匿名创建任意 BaseURL |
| ffprobe/ffmpeg | 只允许服务端已登记的本地 asset，强制 `file` 协议 |
| yt-dlp 下载 | 初始 URL、重定向、解析目标都必须符合下载 SSRF 策略；必须用受控重定向测试证明 |

### 3.5 外部进程目标

- 所有进程必须使用 argv，不得使用 shell 拼接；
- 配置路径必须是已存在的 regular file，且不能位于不可信可写目录；
- 进程拥有 context deadline、process group、stdout/stderr 上限和取消清理；
- 外部工具路径变更必须经认证、审计和显式确认；
- ffmpeg filter 参数必须使用专用 escape 或枚举白名单，不能把路径/字体名/语言值直接拼接到 filter graph。

---

## 4. 问题清单和修复任务映射

严重度定义：

- **P0**：可直接导致任意文件泄露/破坏或安全边界失效，发布阻断。
- **P1**：高可信认证、SSRF、命令执行、跨会话越权或同源管理 API 执行，发布阻断。
- **P2**：可利用的 DoS、逻辑错误、错误处理、依赖和维护缺陷；必须在发布前完成，除非有明确风险接受。
- **P3**：低危维护问题或文档漂移；不能阻塞安全修复，但必须登记和安排。

| ID | 问题 | 主要位置 | 级别 | 处理阶段 |
|---|---|---|---|---|
| F-01 | FileTransfer 任意路径读取并上传匿名外部服务 | `internal/filetransfer/upload.go` | P0 | A/B |
| F-02 | Editor open/save/delete/image/session-images 任意文件操作 | `internal/api/editor/register.go` | P0 | A/B |
| F-03 | Gallery 任意 file/list-dir/zip/path/edit/writeback/delete | `internal/api/gallery/*` | P0 | A/B |
| F-04 | 默认管理 API 放行并回传明文 Key | `auth/providers/keys/settings` | P1 | A |
| F-05 | Cookie 管理 API 无 CSRF/Origin/Content-Type 防护 | `router.go`, auth/settings | P1 | A |
| F-06 | Provider BaseURL SSRF，probe 响应回显 | providers/probe/urlutil | P1 | C |
| F-07 | ffprobe 接受网络 URL 形成 SSRF | gallery/mediaedit | P1 | C |
| F-08 | yt-dlp/ffmpeg/7z/RAR 配置路径可触发任意程序 | settings/download/media/archive | P1 | C |
| F-09 | macOS AppleScript 路径拼接注入 | `fsutil/open_other.go` | P1 | C |
| F-10 | HTML iframe `srcdoc` 无 sandbox，同源执行 | `editor_shell.js` | P1 | C |
| F-11 | Archive source/asset 无 owner/session 授权 | `archive/tempstore.go`, API archive | P1 | B |
| F-12 | `/v1` 绕过管理密码，使用配置 Key | `router.go`, proxy | P1/决策项 | A |
| F-13 | 7z SLT header 被当作 archive entry | `archivetool/parse.go` | P1 | D |
| F-14 | 非流式 response/SSE 单行无界内存 | proxy/sse/probe | P2 | D |
| F-15 | Gallery temp、ZIP session、Archive workspace 资源无总量约束 | gallery/archive/mediaedit | P2 | D |
| F-16 | download/ffprobe URL 重定向 SSRF 风险 | download/mediaedit | P2/P1 待验证 | C |
| F-17 | reload 不传播 Proxy/Trace/Archive/Download runtime | settings/app | P2 | E |
| F-18 | Registry Config 浅拷贝导致并发读写 race | registry/config | P2 | E |
| F-19 | combo stickyLimit 硬编码 3 | combo | P2 | E |
| F-20 | 解密失败静默保留 `enc:` | config/defaults.go | P2 | E |
| F-21 | state key 序列化/恢复不对称 | registry/state, state/manager | P2 | E |
| F-22 | Trace 全文件读取后分页 | api/trace | P2 | E |
| F-23 | 自定义 Header、URL userinfo、响应 Header 日志脱敏不完整 | proxy/request_log/monitor | P2 | C/E |
| F-24 | DOMPurify 3.2.6 已有 CVE，需升级 3.2.7 | vendored bundles | P1/P2 | F |
| F-25 | Mermaid bundle 版本未钉定且疑似旧线 | vendor/docs | P2 | F |
| F-26 | 登录限速器把 malformed 400 当成功重置 | auth/rate_limit.go | P2 | A |
| F-27 | Gallery/Archive 临时文件成功路径未清理 | gallery/edit_handlers.go | P2 | D |
| F-28 | Gallery `OutputName`/`OutputDir` 与 writeback 路径未统一授权 | mediaedit/gallery | P0 | B |
| F-29 | Archive 资源 ID 可跨会话读/改/删 | archive/tempstore/API | P1 | B |
| F-30 | Gallery `list-dir` 返回绝对路径和任意目录元数据 | gallery/fs_handlers.go | P0 | B |

---

## 5. 分阶段实施方案

## Phase A：认证、CSRF、凭证回传和发布止血

### A-1. 建立管理认证状态机

涉及：

- `internal/api/auth/handler.go`
- `internal/api/auth/rate_limit.go`
- `internal/api/router.go`
- `internal/config/types.go`
- `internal/config/defaults.go`
- `internal/api/settings/register.go`
- `web/static/auth.js`
- `web/static/settings/*`

实施：

1. 保留三种可观察状态：开放管理（未启用密码）、已设置密码且已保护、配置不一致（由 `finalizeConfig` 归一化并告警）。
2. `PasswordEnabled=false` 时所有管理路由直接访问；`PasswordEnabled=true` 时除公开 auth status/login/setup 外，管理路由必须有 session。
3. 关闭密码保护清除 `PasswordEncrypted`/`EncryptionKey`，随后页面切换与刷新仍保持开放管理，不得重新触发 setup-required。
4. session token 保持密码学随机；增加 session 生命周期、注销、清空和必要的 session owner 信息。
5. `/v1` 是否加认证不在 A-1 中偷偷改变。保持协议兼容并明确“这是代理入口，不是管理认证”；若产品要求密码阻止本地程序使用 Key，另开兼容变更启用 `/v1` token/session gate。

验收：

- 开放管理模式下 `/api/providers`、`/api/keys`、`/api/settings` 可直接访问，`/api/auth/status` 返回 `setupRequired:false` 和已认证状态，不返回强制 setup 弹窗信号；
- 显式启用密码后，正确登录可访问；错误/过期/注销 session 全部拒绝；
- 关闭密码保护后清除密码密文和加密密钥，页面切换/刷新仍可访问管理路由；
- 旧 config migration 不丢 Provider/Key，但不再直接泄露；
- `/v1` 行为与最终产品决策一致，并有测试固定。

### A-2. 凭证输出最小化

实施：

- 新建公开 DTO，不直接 JSON encode `config.Provider`、`config.Key`；
- Provider 列表只返回 `id/name/prefix/baseUrl/apiType/models/keyCount/hasKey`；
- Key 列表只返回 `id/name/account/priority/isActive/maskedKey`；
- `maskedKey` 不可逆，短 Key 全部显示为 `***`，长 Key 只保留末 4 位；
- `AnySearch.APIKey` 只返回 `hasApiKey`；
- 创建/更新接口成功响应不返回完整 Key；
- Probe/monitor/trace 的请求 Header 统一掩码 `Authorization`、`X-Api-Key`、`Cookie`、`Set-Cookie`、`Proxy-Authorization`、`WWW-Authenticate`、`X-Goog-Api-Key` 以及自定义敏感头；
- URL 输出统一使用 `redactURL`，移除 userinfo 和 query 中的 credential-like 参数；
- 错误响应不回传完整上游响应体。

验收：

- API、Monitor、Trace、Probe 所有响应使用 fixture 扫描，不能出现测试 Key 的完整值；
- Provider/Key API 的旧字段兼容性由前端测试确认；
- 日志文件和 SSE 日志事件均不含敏感 Header/URL。

### A-3. CSRF 和登录限速

实施：

- session 建立后签发 session-bound CSRF token；
- 所有 POST/PUT/PATCH/DELETE 管理路由要求 `X-CSRF-Token`；
- 校验 `Origin`，允许当前 `http://127.0.0.1:<port>`、`http://localhost:<port>` 和 WebView2 实际 origin；拒绝任意外部 Origin；
- JSON API 强制 `Content-Type: application/json`；multipart 单独校验 CSRF；
- 修复 `loginResponseWriter`：不把所有非 401 都当成成功；malformed JSON 应计入失败或至少不能清空失败计数；成功只由 LoginHandler 明确通知 limiter；覆盖隐式 200 `Write` 路径；
- 登录失败返回统一错误，不泄露密码配置状态。

验收：

- 无 CSRF token 的 simple POST 无法修改 Settings、Provider、Key、FileTransfer、Editor、Gallery、Archive；
- 外部 Origin 即使带 Cookie 也被拒绝；
- 5 次错误密码后，malformed body 不能重置限制；
- 正确登录、注销、过期和并发登录的计数行为有单元测试。

---

## Phase B：统一 Path Grant、Asset Capability 和 owner/session

### B-1. 统一服务端资源合同

复用 `internal/archive` 既有合同，补齐以下能力，不再为 Editor/Gallery/FileTransfer 各自实现路径校验：

```go
type OwnerID string
type SessionID string

type PathGrant struct {
    ID        string
    Owner     OwnerID
    Session   SessionID
    Path      string // server-side only
    Operation GrantOperation // read/write/delete/export
    ExpiresAt time.Time
}

type AssetRef struct {
    ID        string
    Owner     OwnerID
    JobID     string
    Name      string
    MIME      string
    Size      int64
    Path      string // server-side only
    ExpiresAt time.Time
}
```

约束：

- `Path` 不出现在浏览器 JSON 合同；
- `Open/Stat/Release/Replace` 必须接收 owner/session/job 上下文；
- 读取和修改必须验证能力类型；
- ID 不能仅靠随机性作为授权；
- TTL、引用计数、显式 release、失败/取消 cleanup、启动 scavenger 全部由资源存储层负责；
- 所有新资源 workspace 0700，文件 0600，输出目录不可被跨 owner 访问。

### B-2. FileTransfer 迁移

涉及：

- `internal/filetransfer/upload.go`
- `internal/api/router.go`
- `web/static/filetransfer.js`
- `internal/config-registry-state` 相关文档

实施：

1. 删除 `paths` 直接接受本机路径的能力。
2. 浏览器通过服务端 picker/drag-drop 注册文件，服务端生成短 TTL `pathGrantId` 或直接复制到私有 upload workspace。
3. Upload 只接收 `grantId`/`assetId`，验证 owner/session 和 `export` 权限。
4. 目录导入需设置最大文件数、单文件大小、总大小、扫描深度和总耗时。
5. 外部临时服务上传前再次显示外发确认；失败时清理 archive buffer/temp file。
6. `path-info` 不接受任意路径；只能查询已登记 grant 的元数据。
7. 响应不返回本机绝对路径。

验收：

- 直接提交 `/etc/passwd`、`C:\Users\...`、UNC、符号链接、`..` 均拒绝；
- grant 过期、跨 session、错误 operation 均拒绝；
- 只能上传用户显式选择的资源；
- ZIP 外发 fixture 可验证内容来源和清理；
- 总文件数/总字节/扫描超时均有测试。

### B-3. Editor 迁移

涉及：

- `internal/api/editor/register.go`
- `web/static/utility/editor/editor_shell.js`
- `web/static/utility/editor/editor.js`
- `web/static/utility/editor/editor_workspace.js`
- `web/static/utility/editor/editor_commands.js`

实施：

- `/tree` 返回相对于 doc root 的资源节点和 `fileId`，不返回绝对 `Path`；
- `/open` 接收 `fileId` 或一次性 `pathGrantId`；
- `/save`、`/delete` 接收服务端 file ID；
- `/image` 接收 `assetId`/受控相对 entry，不接受任意 `path`；
- session images 存入当前 editor job workspace，文件名服务端生成；
- 旧绝对路径字段进入兼容期时只允许已登记 legacy grant，兼容期结束返回 410；
- 文件读取、写入、删除分别检查能力和 owner；
- 所有成功/失败/取消路径清理临时图片和草稿映射。

验收：

- `../../`、绝对路径、Windows drive、UNC、符号链接都被拒绝；
- docDir 外文件不能通过 `/open`、`/save`、`/delete`、`/image` 访问；
- 保存和重命名仍能维持 Editor 当前 UI 体验；
- 旧 API 不再接受任意物理路径。

### B-4. Gallery/MediaEdit 迁移

涉及：

- `internal/api/gallery/fs_handlers.go`
- `internal/api/gallery/zip_handlers.go`
- `internal/api/gallery/edit_handlers.go`
- `internal/api/gallery/session_store.go`
- `internal/mediaedit/manager.go`
- `internal/mediaedit/args.go`
- `web/playground/static-pg/gallery/*`

实施：

1. `/gallery/file` 改为 `assetId` 或 `sourceId + strict entryPath`。
2. `/list-dir` 改为已授权 directory grant；只返回相对路径和 metadata，不返回绝对路径。
3. 删除、zip 输出、zip writeback、edit input/output 全部接收 asset/job ID。
4. 删除旧 `zipAbsPath`、`archivePath`、`filePath`、`outputDir` 任意路径合同；兼容期返回明确 deprecation/410，不保留永久 alias。
5. `OutputName` 只接受 safe basename/stem；`OutputDir` 必须是已授权 output workspace；`CleanUp` 只能删除同 owner/job 登记的输入。
6. `subtitlePath`、`upload-temp`、`extract-zip-entry` 改为 assetId，成功/失败/取消均由 job cleanup；前端只持有 token。
7. media edit 设置输入文件必须来自本地 asset，不允许 ffprobe 直接收到网络 URL。
8. SubtitlePath 使用 `escapeFilterPath` 或服务端生成的安全临时 basename；FontName/Language 使用白名单或严格字符集；禁止任意 filter graph 注入。
9. Gallery session 增加总 bytes、TTL、pin budget、并发上传上限；不能因全部 pinned 而无限超额。

验收：

- 任意路径读取/写入/删除集成测试全部返回 400/403/404；
- 跨 session asset/source 使用返回 403；
- `zip-writeback` 只能回写登记 source；失败不破坏原源；
- `OutputName=../../x`、符号链接、跨 job fileId 全部拒绝；
- temp file 在成功、失败、取消、超时和重启 scavenger 后均清理；
- 旧路径端点移除或返回 410，前端无旧调用。

### B-5. Archive owner/session 修复

涉及：

- `internal/archive/tempstore.go`
- `internal/api/archive/register.go`
- `internal/api/gallery/register.go`
- `docs/archive_compatibility_plan.md`

实施：

- `TempStore.Open/Stat/Release/Path` 增加 owner/session/job 参数；
- source registry 保存 owner/session/job；
- `getAsset`、`pack`、`zipReplace`、`release` 验证 owner；
- sourceId/assetId 不能跨会话使用，即便知道 ID 也返回 403；
- 增加每 owner 资产数量、总 bytes、单 job bytes 和全局 bytes 上限；
- Scavenge 改为启动 + 周期运行；关闭/失败/取消立即清理；
- 资源 response 只返回 ID、name、mime、size、kind，不返回 Path。

验收：

- 两个独立 session 的跨资源 read/pack/replace/release 全部拒绝；
- owner 释放不会删除另一 owner 资源；
- 24 小时 TTL、周期 scavenger、崩溃恢复和磁盘配额有测试；
- 与 `docs/archive_compatibility_plan.md` §7/§13.1 全部一致。

---

## Phase C：SSRF、外部工具和 HTML 隔离

### C-1. 统一 SSRF 客户端

涉及：

- `internal/api/apibase/deps.go`
- `internal/urlutil/*`
- `internal/api/providers/register.go`
- `internal/api/probe/*`
- `internal/api/image/register.go`
- `internal/download/*`
- `internal/imagebatch/remote_generator.go`

实施：

- 建立按场景配置的 `OutboundPolicy`；
- 解析 URL 时拒绝非允许 scheme、空 host、userinfo 凭证和异常端口；
- DNS 解析后检查全部 IP；
- 使用自定义 `DialContext` 将已验证 IP 与连接绑定，防 DNS rebinding；
- `CheckRedirect` 每跳重新校验并限制次数；
- 不把完整上游错误 body 返回客户端；
- Provider create/update/validate/test-proto 统一调用政策；
- Provider 的私网目标只能通过显式认证设置允许，不能由匿名请求开启；
- 图片代理和 image save 默认拒绝私网；
- Download 用受控重定向 fixture 验证 yt-dlp 行为。如果无法保证外部工具逐跳 SSRF 安全，必须改为代理下载、限制域名或禁用该能力，而不是假设初始 DNS 检查足够。

验收：

- `127.0.0.1`、`::1`、RFC1918、169.254.169.254、组播、未指定地址全部按策略拒绝；
- public→private redirect 拒绝；
- DNS 首次解析 public、第二次解析 private 的 fixture 拒绝；
- Provider 响应头/body 不再把内部敏感内容无条件回显；
- 显式 local Provider 兼容路径有单独测试和 UI 警示。

### C-2. ffprobe/ffmpeg 协议和 filter 安全

涉及：

- `internal/mediaedit/probe.go`
- `internal/mediaedit/executor.go`
- `internal/mediaedit/args.go`
- Gallery edit handlers

实施：

- 输入只能来自 asset store 的本地路径；
- 使用 ffmpeg/ffprobe 的协议白名单，仅允许 `file`；
- 对 `SubtitlePath` 使用安全转义并限制在当前 job workspace；
- FontName、Language、Operation、Codec、Container 等全部枚举/字符集校验；
- 为 FFmpeg 设置正常运行 deadline，不仅依赖取消；
- 输出和临时文件进入 job 私有目录；
- 成功/失败/取消/超时统一 cleanup。

验收：

- `http://`, `https://`, `tcp://`, `rtmp://` 输入全部拒绝；
- filter 特殊字符 fixture 不改变 argv/filter 结构；
- ffprobe 无法访问内部 HTTP service；
- FFmpeg 进程组、超时和清理测试通过。

### C-3. 外部工具路径执行控制

涉及：

- `internal/api/settings/register.go`
- `internal/mediaedit/binary.go`
- `internal/download/executor.go`
- `internal/archivetool/*`

实施：

- 设置值只能是 canonical regular executable；
- 禁止目录可写、临时目录、用户上传目录作为工具路径；
- 在 Windows 检查扩展名和实际文件；在 Unix/macOS 检查 executable bit；
- 工具变更需要认证、确认和日志，但日志不含完整敏感路径之外的秘密；
- 统一 `runExternalTool`：argv、deadline、process group、stdout/stderr bound、取消 cleanup；
- 工具探测不能通过任意用户输入的 path 直接执行；
- macOS picker 使用参数化 AppleScript：不要把 `initialDir` 直接拼接到脚本文本，或使用安全 escape 函数并用 fixture 验证引号、反斜杠、换行和 AppleScript token。

验收：

- 配置不存在、目录、可写目录 executable、相对路径、带控制字符值全部拒绝；
- 成功触发的工具 argv 可记录但不泄露 Key；
- macOS AppleScript escape 测试证明输入不能闭合脚本字符串；
- Windows/macOS/Linux 交叉构建通过。

### C-4. HTML iframe 隔离

涉及：

- `web/static/utility/editor/editor_shell.js`
- `internal/api/router.go`
- Editor preview 相关 CSS/测试

推荐实现：

1. 首选独立 origin/独立静态资源上下文；
2. 最低限度为 iframe 设置无权限 `sandbox`；
3. 不允许 `allow-scripts allow-same-origin` 组合；
4. 若需要 TOC，使用 postMessage 且只传结构化、无凭证消息；
5. HTML preview 不能 fetch 管理 API；
6. Markdown 预览继续使用 DOMPurify，HTML iframe 与 Markdown sanitized preview 不得混用安全假设。

验收：

- `srcdoc` 中的 `<script>`, `fetch('/api/providers')`, `parent.document` 无法读取或修改管理 UI；
- HTML、Markdown、TOC、dark/light theme 和 WebView2 预览仍工作；
- 浏览器 smoke 覆盖 password on/off、iframe 加载、切换文件和销毁 cleanup。

---

## Phase D：Archive/Proxy 逻辑和资源边界

### D-1. 修复 7z SLT parser

涉及：

- `internal/archivetool/parse.go`
- `internal/archivetool/external.go`
- `internal/archivetool/builders.go`

实施：

- 识别 7z `-slt` 的 archive header block；
- 只有包含有效 entry 元数据的 block 才转为 `rawEntry`；
- 绝对 `src.Path` 不能进入 `ValidateEntryPaths`；
- 对空、目录、非 ASCII、损坏、重复和异常 block 明确处理。

验收：

- fixture 包含 `Path = C:\archive.7z` header 和多个真实 entry；
- 7z source 注册/list/read 通过；
- RAR fallback 不受影响；
- `StrictArchivePath` 仍拒绝真实恶意绝对/盘符条目。

### D-2. Proxy/SSE 响应预算

涉及：

- `internal/proxy/stream.go`
- `internal/sse/sse.go`
- `internal/api/probe/register.go`
- `internal/api/providers/register.go`
- `internal/api/combos/register.go`

实施：

- 非流式客户端响应采用明确最大响应预算；超过预算返回受控错误或中断，不再 `io.ReadAll` 无上限；
- usage/trace capture 预算与客户端传输预算分开；
- `SSELineBuffer` 增加最大单行长度和总缓冲预算；
- Probe/Combo 共用 bound reader 和 line buffer；
- stream context、upstream timeout、client disconnect 和 cancellation 全部覆盖；
- 大响应测试不得依赖完整内存副本。

验收：

- 200MB/超过上限 response 不导致无界 RSS；
- 无换行 SSE 超过 line cap 后关闭请求并记录受控错误；
- 正常长 SSE、Anthropic SSE、Responses SSE 和 usage capture 仍通过；
- 客户端断开后 upstream/body/process 均释放。

### D-3. 临时文件、内存和并发预算

实施：

- Gallery upload/extract/subtitle 成功路径登记 asset 并自动 cleanup；
- ZIP session 增加总 bytes、TTL、pin budget、并发上传上限；
- Archive 增加全局/owner/job bytes 和数量上限；
- Archive scavenger 周期运行并清理孤儿；
- MediaEdit 使用 semaphore 限制运行中的 ffmpeg 数，超过上限返回 429/503；
- Combo speed test 设置最大模型数、并发数和总耗时；
- Trace API 使用 streaming pagination/early stop，不把完整日志文件先加载到内存；
- 所有计时器、订阅、HTTP body、临时文件、子进程都有 defer/取消路径。

验收：

- 上传/编辑/归档压力测试在内存、CPU、临时磁盘和进程数上有固定上限；
- 失败、取消、超时和进程重启后无残留；
- 超额请求返回稳定的 413/429/503，不返回 200 假成功。

---

## Phase E：配置、状态、错误处理和代码质量

### E-1. Reload 完整传播

`POST /api/reload` 必须与 Settings PATCH 使用同一 runtime convergence 函数，至少同步：

- Registry config；
- Rotation settings；
- Proxy URL/timeout；
- Trace log directory and logging flags；
- Archive runner settings/probe cache；
- Download manager settings；
- Image/doc path derived dirs；
- Feature runtime state（若存在）。

要求：磁盘配置、内存配置、运行时组件和 API GET 结果一致，并有外部编辑 config → reload 的集成测试。

### E-2. Registry 深拷贝和并发契约

推荐：

- `Registry.Config()` 返回完整深拷贝；或
- 提供带读锁的 `SnapshotConfig`，Save 在快照完成后只操作独立副本；
- 禁止 handler 获取浅拷贝后异步 marshal 共享切片；
- 明确 `cfgMu → stateMu → keyState.mu` 锁顺序；
- 新增 `go test -race` 覆盖 Provider/Key/Settings 并发 PATCH 和 Save/Reload。

### E-3. 逻辑修复

- Combo 使用有效配置的 stickyLimit，不硬编码 3；轮转计数按实际选择/发送语义确定；
- Key 解密失败必须记录可审计错误并将 Key 标记不可用，不把 `enc:` 当作真实凭证发给上游；
- state 使用结构化 providerID/keyID 字段或长度前缀，避免 `/` 与 `::` 不对称；兼容迁移旧 state；
- Gallery ZIP output、Editor session image、archive writeback 对 `Open/Copy/Close/ZipWriter.Close/AtomicWrite` 错误显式传播；不能失败仍返回 `ok:true`；
- 登录 rate limiter 修复 malformed body 和 implicit Write 路径；
- 统一用户可见错误：内部绝对路径、命令行、上游响应原文和凭证不得出现在错误响应。

### E-4. 日志和 Trace 安全

- `maskHeaderMap` 与 `redactAuth` 改为集中式敏感头集合；
- URL userinfo、query 参数中的 `key/token/secret/password/signature` 统一剥离；
- response headers 默认只保留安全 allowlist，或对 Cookie/认证头统一掩码；
- Trace 查询返回字段使用 DTO，不直接回传原始 `traceLine`；
- `q`、date、reqID 过滤继续严格校验，分页读取使用上限和 context；
- 禁止控制台日志输出 CR/LF/ANSI 控制字符导致日志伪造。

---

## Phase F：依赖、文档和兼容迁移

### F-1. 第三方依赖

- 升级两份 DOMPurify bundle 至 3.2.7 或更高兼容版本，更新 `README.md`、来源和 SHA-256；
- 明确 Mermaid 精确版本，优先升级到当前受支持版本；重新验证 `securityLevel`、SVG、Mermaid、KaTeX 和 Markdown pipeline；
- 为未标版本的 diff-match-patch、Prism、Turndown、Mermaid 补充精确来源/版本；
- 安装 `govulncheck` 并运行 `govulncheck ./...`；保存扫描版本、日期和结果；
- Go module 只在漏洞扫描和完整测试通过后升级，避免把依赖升级与安全边界重构混在同一个不可诊断提交。

### F-2. 旧 API 迁移

按 `docs/archive_compatibility_plan.md` §7.2、§8、§12 执行：

1. 先让前端只调用 sourceId/assetId 新合同；
2. 后端在兼容期记录旧路径调用并返回 deprecation；
3. 补齐所有前端、测试、文档和构建 manifest；
4. 旧任意 path endpoint 返回 410 并删除实现；
5. 不保留永久 shim；
6. 更新 `PROJECT_MAP.md`、`docs/archive-architecture.md`、`docs/playground-architecture.md`、`docs/config-registry-state-architecture.md`、`docs/proxy-architecture.md`、`docs/download-architecture.md` 的最后核对行和变更维护清单。

### F-3. 兼容性决策记录

必须在实施前冻结以下决定：

- `/v1` 是否继续无应用层认证；保持协议兼容，但文档明确其只能代表本地代理，不代表管理认证；
- 无密码配置是否保持开放管理；本次按产品要求不迁移为 setup-required，只有显式开启密码保护才进入登录门禁；
- 是否继续支持任意用户选择的本地目录；推荐支持 picker/grant，而不是任意路径 API；
- Download 是否允许公共 URL 重定向；必须以受控 SSRF fixture 的结果决定；
- 7z/RAR 只读和 ZIP writeback 的能力边界；继续继承现有 Archive 计划。
## 6. 测试和验收矩阵

### 6.1 安全单元测试

必须新增或补齐：

| 测试组 | 必测内容 |
|---|---|
| Auth | setup-required、session 过期、注销、错误密码、malformed body 限速、并发登录 |
| CSRF | 缺 token、错误 token、错误 Origin、错误 Content-Type、multipart token |
| Secrets | Provider/Key/Settings/Probe/Monitor/Trace 不返回完整 Key/Header/URL secret |
| Path | `../`、编码 traversal、绝对路径、盘符、UNC、NUL、ADS、设备名、符号链接、root sibling |
| Grants | grant TTL、owner/session 隔离、operation read/write/delete/export、重复消费 |
| Gallery | file/list-dir/zip-from-path/zip-writeback/edit 全部拒绝任意 path |
| Auth | 开放管理模式、主动 setup、密码登录、session 过期、注销、错误密码、malformed body 限速、并发登录 |
| SSRF | loopback/private/link-local/multicast、redirect、DNS rebinding、userinfo、异常 scheme |
| ffprobe | http/https/rtmp/tcp input 拒绝，file-only 通过 |
| Tools | 工具路径校验、argv、timeout、process group、Windows/macOS/Linux |
| iframe | script/fetch/parent/document 在 preview 中不可用 |
| Archive | 7z header、RAR、owner、budget、writeback、scavenge、越权 |
| Resource | response cap、SSE line cap、session bytes、archive disk cap、ffmpeg concurrency |

### 6.2 集成和浏览器测试

- 认证关闭/开启/迁移三种配置下测试管理路由；
- 从恶意 localhost 页面发起 simple POST，确认 CSRF 失败；
- Editor HTML/Markdown preview、TOC、WebView2 和页面切换；
- Gallery drag/drop/paste/picker/rehydrate/编辑/删除/回写；
- Archive ZIP/7z/RAR list/read/release/pack/writeback；
- Download public URL、redirect-to-private、DNS rebind fixture；
- 失败/取消/超时/刷新/重启后的资源清理；
- 每个 build profile 检查不包含的路由、脚本和运行时组件确实不存在。

### 6.3 静态和运行门禁

发布前必须全部通过：

```text
gofmt -l .                                      # 无输出
go test ./...
go test -race ./...
go vet ./...
govulncheck ./...
go build ./...
GOOS=windows GOARCH=amd64 go build ./...
GOOS=darwin GOARCH=arm64 go build ./...
GOOS=darwin GOARCH=amd64 go build ./...
node --check <所有受影响 JS>
```

此外需要：

- 真实 HTTP 安全 smoke；
- 浏览器 iframe/CSRF smoke；
- 临时目录、Archive workspace 和日志目录清理检查；
- 依赖版本和 vendor SHA 核对；
- release artifact 不含测试 Key、绝对路径、trace secret 和临时资源。

---

## 7. 提交和实施顺序

建议按以下提交边界执行，便于回滚和审核：

1. `security(auth): enforce management setup/session boundary and CSRF`
2. `security(secrets): redact credential-bearing API and trace DTOs`
3. `security(capability): add owner-bound path grants and asset lifecycle`
4. `security(filetransfer): remove raw path upload and migrate grants`
5. `security(editor): migrate file APIs to fileId/pathGrant`
6. `security(gallery): remove arbitrary path APIs and bind media jobs`
7. `security(archive): bind sources/assets to owner and enforce budgets`
8. `security(outbound): harden SSRF and external tool execution`
9. `security(preview): sandbox or isolate HTML iframe`
10. `fix(archive): parse 7z SLT header correctly`
11. `fix(proxy): cap response and SSE buffers`
12. `fix(config): complete reload, deep snapshots and state migration`
13. `chore(deps): upgrade DOMPurify/Mermaid and run vulnerability scan`
14. `docs(audit): sync architecture docs, PROJECT_MAP and release evidence`

每个提交必须：

- 包含对应测试；
- 不修改用户外部文件；
- 不把未修复的旧 endpoint 继续暴露为兼容 alias；
- 更新受影响的架构文档最后核对行和源码锚点；
- 通过该提交范围内的最小测试后再进入下一阶段。

---

## 8. 发布门禁和风险接受规则

### 8.1 不可接受的残留

以下任一项存在，发布状态必须为 BLOCKED：

- 客户端可提交任意绝对路径并到达 `ReadFile/Open/Create/Write/Remove/ServeFile/ffprobe/ffmpeg`；
- FileTransfer 可通过请求体指定本机路径并上传外部服务；
- 管理 API 默认无认证并返回完整 Key；
- Cookie 管理 API 无 CSRF/Origin 防护；
- Provider/ffprobe 能够访问未授权私网目标；
- 外部工具路径可由未授权请求设置或执行；
- HTML preview 可执行同源脚本并调用管理 API；
- Asset/source 可跨 owner/session 读、改、删；
- 7z source 注册/list 仍失败；
- response/SSE/session/archive 没有明确上限；
- `go test -race`、`govulncheck` 或跨平台构建未完成。

### 8.2 可以单独记录但不能隐瞒的决策项

- `/v1` 是否需要认证；
- 私有 Provider 是否允许连接 localhost；
- Download 是否允许跟随公共 URL 到私网；
- 关闭密码时是否允许开放管理；本次产品决策为允许，且必须覆盖启动、关闭保护后页面切换和刷新；
- Mermaid 升级造成的渲染兼容性。

这些决策必须记录影响、替代方案、验证证据和责任人；不能用“localhost only”或“管理员可操作”作为无证据的风险豁免。

---

## 9. 文档同步要求

本方案执行过程中，涉及以下文件/包时必须在同一轮代码变更中同步文档：

- `internal/api/router.go`、auth、settings、providers、keys：更新 `PROJECT_MAP.md`、`docs/config-registry-state-architecture.md`；
- `internal/api/editor`、`internal/api/gallery`、`internal/filetransfer`、`internal/archive`、`internal/archivetool`：更新 `PROJECT_MAP.md`、`docs/archive_compatibility_plan.md`、`docs/playground-architecture.md`、`docs/config-registry-state-architecture.md`；
- `internal/proxy`、`internal/sse`、`internal/urlutil`：更新 `PROJECT_MAP.md`、`docs/proxy-architecture.md`；
- `internal/download`、`internal/fsutil`：更新 `PROJECT_MAP.md`、`docs/download-architecture.md`、`docs/config-registry-state-architecture.md`；
- vendor 变更：更新来源、版本、许可证和 SHA 记录；
- 旧 endpoint 删除：同步前端脚本清单、feature manifest、测试和 API 文档。

文档中的源码行号会因修复变化，必须改为稳定的文件/符号锚点，不能保留失效行号。

---

## 10. 完成定义

本方案只有在以下条件全部满足时才算完成：

1. P0/P1 全部关闭并有可复现安全测试；
2. P2 资源和逻辑问题全部修复或有书面、可追踪风险接受；
3. 所有旧任意 path API 已迁移并删除/410；
4. owner/session/asset/path grant 合同在 Editor、Gallery、FileTransfer、Archive 中统一；
5. `/api` 认证/CSRF 和凭证输出门禁通过；
6. SSRF、ffprobe、外部工具、AppleScript、iframe 隔离测试通过；
7. 7z/ZIP/RAR 归档和媒体交接回归通过；
8. response/SSE/temp/disk/CPU/concurrency 预算通过压力测试；
9. `go test ./...`、`go test -race ./...`、`go vet ./...`、`govulncheck ./...`、构建变体和 JS 门禁全部通过；
10. `PROJECT_MAP.md`、相关 `docs/*-architecture.md`、Archive plan、vendor 版本记录同步完成；
11. release artifact 和运行时目录审计通过，不含完整凭证、绝对路径、旧 trace 或残留 temp；
12. 审核报告中的每个 finding 都有状态：`fixed`、`verified accepted` 或 `not applicable`，不得留空。

---

## 附录 A：受影响源码索引

### 认证与管理 API

- `internal/api/router.go`
- `internal/api/auth/handler.go`
- `internal/api/auth/rate_limit.go`
- `internal/api/settings/register.go`
- `internal/api/providers/register.go`
- `internal/api/keys/register.go`
- `internal/api/probe/register.go`
- `internal/api/trace/register.go`
- `internal/config/defaults.go`
- `internal/config/types.go`

### 文件和媒体资源

- `internal/filetransfer/upload.go`
- `internal/api/editor/register.go`
- `web/static/utility/editor/editor_shell.js`
- `web/static/utility/editor/editor.js`
- `internal/api/gallery/fs_handlers.go`
- `internal/api/gallery/zip_handlers.go`
- `internal/api/gallery/edit_handlers.go`
- `internal/api/gallery/session_store.go`
- `internal/mediaedit/args.go`
- `internal/mediaedit/probe.go`
- `internal/mediaedit/executor.go`
- `internal/mediaedit/manager.go`
- `internal/fsutil/open_windows.go`
- `internal/fsutil/open_other.go`

### Archive

- `internal/archive/path.go`
- `internal/archive/tempstore.go`
- `internal/archivetool/parse.go`
- `internal/archivetool/external.go`
- `internal/archivetool/runner.go`
- `internal/archivetool/exec.go`
- `internal/api/archive/register.go`
- `docs/archive_compatibility_plan.md`

### Proxy、下载和配置状态

- `internal/proxy/upstream.go`
- `internal/proxy/stream.go`
- `internal/proxy/forward_retry.go`
- `internal/proxy/request_log.go`
- `internal/sse/sse.go`
- `internal/api/download/register.go`
- `internal/download/executor.go`
- `internal/registry/registry.go`
- `internal/registry/state.go`
- `internal/state/manager.go`
- `internal/combo/resolver.go`

### 依赖

- `web/static/vendor/utility-editor/dompurify/purify.min.js`
- `web/playground/static-pg/vendor/purify.min.js`
- `web/playground/static-pg/vendor/mermaid.min.js`
- `go.mod`
- `go.sum`

---

## 附录 B：Finding 状态表

> 2026-08-09 执行后按当前源码/测试证据更新（状态含 `fixed`/`partial`/`pending`/`decision-required`；未验证项保持原状态并注明）。历史模板行已替换，不删除历史证据原则由本表各行"备注"延续。

| ID | 状态 | 修复提交 | 测试/证据 | 风险接受人 | 备注 |
|---|---|---|---|---|---|
| F-01 | fixed | 2bc4637，Phase B | `internal/filetransfer/upload_test.go`；`Upload`/`collectParts` 只接受 multipart 或 `pathGrantId`（`h.grants.Resolve(owner, id, OpExport)`），raw `paths` 400/410；`/paste` 剪贴板→export grants；`path-info` 仅查已登记 grant；上限 500MiB/2000 文件/1GiB/深 32/30s | | 见 `internal/filetransfer/upload.go` 包文档（F-01/B-2 合同） |
| F-02 | fixed | 2bc4637，Phase B | `internal/api/editor/register_test.go`（traversal/410/grant）；`resolveDocFile`（`pathgrant.StrictRel`+`realPathWithin` 符号链接包含）、`openTarget`/`saveTarget`/`deleteTarget` 仅 `fileId`/`pathGrantId`，raw `path`→410；`maxOpenSize` 16MiB；`/upload-image` 白名单+服务端文件名 | | 前端 `editor_shell.js`/`editor.js` 已同步 fileId/pathGrantId |
| F-03 | fixed | 2bc4637，Phase B | 后端：`fs_handlers.go`/`zip_handlers.go`/`edit_handlers.go` 全部端点 grantId/assetId/sourceId，raw path→410（`register_grant_test.go`/`edit_handlers_test.go`）；**前端已迁移**：`gallery-edit-operations.js::_startJob` 发 `{inputAssetId | inputGrantId+inputRel, operation, subtitleAssetId, outputName}`、`zip-outputs`→`{assetIds,zipName,cleanUp}`、`edit/zip-writeback`→`{sessionId,grantId,entries}`、`/fs` 删除与 `/file` 读取→`grantId+rel`、`zip-replace`→`{sourceId,deletes}`；无活跃旧合同请求（剩余 `zipAbsPath`/`rootDirPath` 引用为**永不赋值的死分支**）；**GIF 编辑器导出合同亦已迁移（2026-08-09）：** `web/static/gif-editor/gif-editor-export.js` ZIP 导出改为 上传帧→`assetId` → `POST /api/archive/pack`（或 legacy `zip-outputs` `{assetIds}`）→ 经受控 `/api/gallery/file?assetId=` 下载（不再读 `tempPath`/`paths`）；`web/gif-editor-export-contract.test.js`（零依赖 Node VM 合同测试：upload-temp→assetId、zip-outputs body 无 `paths` 键、assetId 下载）PASS | | 残留功能缺陷（非安全）：`gallery-edit.js` 单 zip 条目 extract→edit 仍读已移除的 `data.tempPath`（后端只回 `assetId`）→ 该流程 probe 拿不到输入（`gallery-edit-batch.js:340` 的批量流与 GIF 导出已正确用 `data.assetId`）；登记为待修 |
| F-04 | fixed | 2bc4637，Phase A + optional-protection correction | `internal/api/api_test.go::TestNoPassword_AllowsManagementRoutes`/`TestDisablePassword_RemainsOpenForNavigation`；`auth_test.go::TestAuthStatusHandler_DisabledProtection`/`TestAuthMiddleware_DisabledProtectionAllowsManagement`/`TestSetupHandler_EnablesProtectionOnDemand`；Provider/Key DTO 泄漏扫描 | | `PasswordEnabled=false` 时管理路由直接放行、状态不返回 setup-required；显式 setup 或 Settings 密码弹窗才开启保护 |
| F-05 | fixed | 2bc4637，Phase A + optional-protection correction | `api_test.go::TestCSRF_BlocksSimplePOST`（PATCH 无 token→403）；`auth_test.go`（Origin/Content-Type/会话生命周期）；`web/static/auth.js` 全局 fetch 注入 `X-CSRF-Token` | | 仅保护开启时执行 session-bound token + Origin/Referer + JSON/multipart；开放管理模式不触发登录/设置密码弹窗 |
| F-06 | fixed | 2bc4637，Phase C | `internal/outbound/outbound_test.go`（7 测试：结构/IP 矩阵/DNS rebinding/重定向）；`probe_proto_test.go`；`Deps.ManagementClient` + `Provider.AllowPrivateNetwork`；providers `maxModelsResponseBytes` 8MiB 有界 | | probe/combos/image/download/imagebatch 统一 outbound 策略。**2026-08-22 补齐 opt-in UI：** `ProviderDTO` 增 `allowPrivateNetwork`、`UpdateProvider` 写回该字段、`validateProvider` 接受 `allowPrivate` 参数、providers.js 编辑/新建表单增开关——本地服务（Ollama/vLLM 等）可经 UI 启用 |
| F-07 | fixed | 2bc4637，Phase C | `internal/mediaedit/mediaedit_security_test.go`（6 测试）；`validateLocalMediaInput`/`validateSubtitleInput` + `-protocol_whitelist file`（probe/executor） | | ffprobe 不再接受网络 URL |
| F-08 | fixed | 2bc4637，Phase C | `internal/procutil/toolpath_test.go`（2）+ `internal/archivetool/tool_test.go`（7：MissingPath/DirectoryRejected/TempDirRejected/ControlCharsRejected/ValidExecutable 等）；`archivetool/tool.go::validateTool` 已迁移 `procutil.ValidateExecutable`（F-08 合同注释）；settings Download 路径 PATCH、`download/binary.go::resolveConfiguredTool`、`mediaedit/binary.go::validateResolvedTool` 均已接入；`go test ./internal/archivetool/ ./internal/procutil/ ./internal/download/` ok | | 工具路径校验点全部迁移完成 |
| F-09 | fixed | 2bc4637，Phase C | `internal/fsutil/open_other_test.go`（`TestOSAPickerScriptIsParameterized`/`TestOSAPickerKindIsFixed`，`!windows`）；`pickerEnvVar="TR_PICKER_INITIAL_DIR"` 环境传递，脚本字节级固定 | | 恶意 initialDir 无法注入 AppleScript |
| F-12 | decision-required | —（决策已记录） | `internal/api/router.go`：`/v1/*` 仍位于 `AuthMiddleware` 之外；无应用层认证、无配置修改能力 | | 决策：保持本地代理入口语义（Phase A 报告 + `docs/proxy-architecture.md` §3 同步）；若需密码阻止本地程序用 Key，另开兼容变更 |
| F-13 | fixed | 2bc4637，Phase D | `internal/archivetool/parse_test.go`：`TestParseSevenZipSLT`（含绝对路径 header fixture）/`_HeaderOnly`/`_NoEntryMetaBlock`/`_EmptyPathBlock`；`go test ./internal/archivetool/` ok | | header block 不再转 rawEntry，绝对归档路径不进 `ValidateEntryPaths` |
| F-14 | fixed | 2bc4637，Phase D | `internal/sse/sse_test.go`（3 预算测试）；`internal/proxy` 全量 ok（44s，含 `TestPassThrough_LargeBodyStreamsFully` 64MiB < 256MiB cap）；probe/combos/providers 有界读取 | | `passThroughResponse` 256MiB 预算+受控 502；SSE 1MiB/行 8MiB 总缓冲；usage 捕获预算分离 |
| F-15 | partial | 2bc4637，Phase D/B | 确定性预算/清理测试已补（`resource-pressure`，2026-08-09）：`internal/api/gallery/session_budget_test.go`（`TestSessionStore_TooLargeRejected` 413/`ByteBudgetEviction`/`PinBudgetRefused`/`TTLExpiry`/`TestGalleryUpload_Semaphore429`（无 slot 泄漏）/`TooLarge413`）、`internal/archive/tempstore_test.go`（`TestTempStore_QuotaFailureLeavesNoFile`/`QuotaRace_RollsBackFile`）、`internal/api/archive/register_test.go`（`TestWriteStoreError_BudgetMaps422`/`Closed503`）；`session_store.go` 增加 `maxSessions`/`maxBytes`/`maxPinnedBytes` 字段（行为不变，使 2GiB/4GiB 可测）；配合既有 mediaedit 信号量 4 测试 + combo speed-test caps + trace 预算测试，`go test ./... -count=1` exit 0；确定性测试持续全绿 | | **保持 partial（真实 HTTP 压力 harness 未跑成）**：`f15-pressure-stress` 尝试启动真实服务做压力测试时被**工具文件系统 split-brain 阻塞**——bash 工具与 node/write 工具对 `%TEMP%` 看到不同文件系统（bash 的 `mkdir`/`go build` 落在 FS_B 的工作区，node 写入的 `config.yaml`/marker 落在 FS_A），hub spawn 启动构建产物 ENOENT，压力 harness 无法触达二进制，最终未执行；§D-3 验收的"压力测试"（高并发/大体积下的内存、CPU、临时盘上限实测与无残留）因此无证据；combo `speedTestTotalMaxSec` 60s 墙钟因需 60s 等待不可测（常量强制） |
| F-16 | fixed | 2bc4637，Phase C | `internal/download/ssrfproxy.go`：本地正向 SSRF 代理（`newSSRFProxy`/`handlePlain`/`handleConnect`/`injectProxy`/`ensureProxyArg`）——yt-dlp 经 `--proxy` 指向它，初始 URL、**每个重定向跳、每个媒体分片**都在建连前逐跳重校验（DNS 逐跳解析 + 已校验 IP 字面量固定拨号防 rebinding，CONNECT 隧道同样固定）；`executor.go::Execute`/`ExecuteInfo` 均接入；用户自配 `DownloadConfig.Proxy` 时显式 opt-out（不装本地代理）。`internal/download/ssrfproxy_test.go` 7 测试（含 `TestSSRFProxyRejectsRedirectToPrivate` 受控重定向 fixture、`TestSSRFProxyConnectBlocksPrivateTarget`）；`internal/api/download/url_policy_test.go`（3）保留初始预检；`go test ./internal/download/` ok | | 审计 §3.4/§C-1 的"受控重定向证明"已由 `TestSSRFProxyRejectsRedirectToPrivate` 落实；§8.2 决策项"Download 是否允许公共 URL 重定向"由实现定案：公共重定向经逐跳重校验代理放行、public→private 拒绝；自配代理 = 显式 opt-out |
| F-17 | fixed | 2bc4637，Phase E | `internal/api/settings/converge_test.go`；`reload` 先 `validateProxyConfig` 再 `Reg.Reload(cfg)`+`convergeRuntime(cfg)`；`updateSettings` 委托同一收敛点 | | 磁盘配置/内存配置/运行时组件/API GET 收敛；外部编辑 config→reload 集成测试见 converge_test |
| F-18 | fixed | 2bc4637，Phase E | `internal/registry/deepcopy_test.go`；`Registry.Config()` → `cloneConfig`（JSON round-trip 深拷贝） | | handler 不再拿共享切片 |
| F-19 | fixed | 2bc4637，Phase E | `internal/combo/resolver_test.go`（+2）；`effectiveStickyLimit()` 读 `RotationSettings()`，≤0 回退 3 | | 不再硬编码 3 |
| F-20 | fixed | 2bc4637，Phase E | `internal/config/decrypt_fail_test.go`；解密失败 → stderr 审计告警 + `k.IsActive=false`，`enc:` 原值保留 | | 密文绝不发上游 |
| F-21 | fixed | 2bc4637，Phase E | `internal/registry/state_key_test.go`；`KeySnapshot.ProviderID/KeyID` + `EncodeSnapshotKey` 长度前缀；`Restore` 兼容 结构化→长度前缀→legacy `::` | | `convertKey` 已删；`cfgMu→stateMu` 锁序显式化 |
| F-22 | fixed | 2bc4637，Phase E（phase-e-trace） | `internal/api/trace/register.go`：`traceIndexDTO`/`traceDetailDTO` 秘密安全投影（排除 `finalKey`/`finalKeyName`/`upstreamURL`/`upstreamURLBase`，不依赖 writer 侧掩码）、`maskHeaderMap`/`maskHeaderValue`/`maskToken` 幂等重掩码、`normalizeTraceDate`（日历合法日期）、`matchIndexFilters`、`newTraceScanner`（1MiB 行上限）、`countIndexMatches`/`collectIndexPage` 两遍流式分页 + `collectDetailPage`、`writeIndexEnvelope`/`writeReqEnvelope` 增量输出；上限 `limit` 默认 200 最大 1000、`maxReqDetailLines` 1000、`maxTraceResponseBytes` 16MiB、`maxQFilterLen`/`maxReqIDLen` 256；超限页面置 `"truncated":true`、取消不输出。`internal/api/trace/register_test.go` 28 测试（新增 10：LargeFileStreaming/PaginationBoundaries/QFilterTooLong/ImpossibleDate/ReqIDTooLong/ReqLargeFileTruncation/ReqResponseByteBudget/ReqSecretSafeDTO/2×ContextCancellation），`go test ./internal/api/trace/` ok | | `/index` 与 `/req/{reqID}` 均流式有界读取，不再整文件加载内存 |
| F-23 | fixed | 2bc4637，Phase E + final-hardening | `internal/proxy` 全量 ok（44s）；`sensitiveHeaderNames`/`isSecretHeader`/`maskHeaderMap`/`isCustomSecretHeader`/`redactURL`；recorder 响应头掩码 + `upstreamURL` redact；**E-4 控制台日志消毒已补（final-hardening，2026-08-09）：** `internal/console/logger.go::sanitize`（C0 0x00–0x1F + DEL 0x7F → 可见转义 `\n`/`\r`/`\t`/`\xNN`，Unicode 原样）+ `Logger.emit` 单一出口（Log/Info/Warn/Error/Debug 全经此，先消毒再 stdout/ring/SSE）；`logger_test.go` 6 新测试（`TestLogger_Sanitize_NoLineForging`/`_NoTerminalEscapes`/`_SubscriberNoControlBytes`/`_UnicodePreserved`/`TestSanitize_AllControlBytes`/`_StdoutNoLineForging`），`go test ./internal/console/` ok | | E-4 全部落实；无残留子项 |
> **2026-08-10 后续本地可观测性调整：** F-22/F-23 的“字段白名单/广泛脱敏”不符合 TinyRouter 纯本地诊断用途，已由 `internal/logredact` 重新收敛为“仅 Provider Key 值替换为 `******`”。Trace API 恢复完整动态字段，Recent Requests/Probe 恢复完整 Body、Header、URL、决策与 provenance；`TestTraceReq_TransparentRecord`、完整 Body、Key 固定掩码回归测试已更新；流式分页、取消处理、上游传输预算和 Console 控制字符转义仍保留。该调整是明确的本地部署可观测性取舍，不恢复任何完整 Provider Key。
| F-24 | fixed | 2bc4637，Phase F | 两份 bundle 均 DOMPurify **3.4.13**；`static-pg/vendor/README.md` SHA-256 `9ab3d44d…`；`playground-markdown.test.js`/`media-bridge.test.js` PASS | | 来源/许可证已记录；**依赖门禁（2026-08-09）：** chi v5.2.1→**v5.2.2**（修复 GO-2025-3770/GHSA-vrw8-fxc6-2r93 RedirectSlashes open redirect；仓库仅 import `middleware.Recoverer`/`RequestID`，RealIP/RedirectSlashes 未引用）、`toolchain go1.26.5`（修复 GO-2026-5856 crypto/tls ECH）、`govulncheck v1.6.0` 全仓 0 affected/0 called |
| F-25 | fixed | 2bc4637，Phase F | `mermaid.min.js` **11.16.1**（esbuild UMD 自包含）；README + `LICENSE.mermaid`；`securityLevel:'strict'` headless Chrome 渲染验证 | | 版本已钉定；依赖门禁同 F-24 行（govulncheck v1.6.0 零漏洞证据） |
| F-26 | fixed | 2bc4637，Phase A | `internal/api/auth/auth_test.go`（26 测试）；`loginResponseWriter` 只记 ≥400 失败、成功仅 `loginGuard.Success()` 显式记账 | | malformed body/隐式 200 不再重置计数 |
| F-27 | fixed | 2bc4637，Phase D | `internal/api/gallery/tempfile.go`（注册成功 + 24h TTL + 小时/启动 sweep）；gallery 测试 ok；archive scavenger | | subtitle/upload-temp/extract-zip-entry 成功路径登记 |
| F-28 | fixed | 2bc4637，Phase B | `edit_handlers_test.go`/`register_grant_test.go`；`resolveMediaInput`（asset/grant, owner 绑定）、`sanitizeOutputStem`、`zip-outputs`/`zip-writeback` assetIds/grantId（raw→410） | | 输出经 `assetStore` 登记（jobOutputs jobID→assetID） |
| F-29 | fixed | 2bc4637，Phase B + owner-isolation-fix | 缺陷（非视觉 HTTP smoke 发现）：(A) `owner.Middleware` 在 `/api/gallery` 路由组与 gallery `Register` 双挂载 → 首次请求发两个不同 `tinyrouter_owner` Set-Cookie，context owner 与浏览器保留 cookie 漂移；(B) `session_store.go` get/touch/update/pin 对任何 owner 不匹配都 `removeLocked` → 已知 sessionId 的外部探测会**清空 owner 会话**。修复（已核对源码）：(A) 移除 router.go 重复挂载，单一边界留在 gallery `Register`（与 archive/editor/filetransfer 一致）；(B) get/touch/update/pin 对 owner 不匹配**失败关闭且不删除不修改**（TTL 惰性驱逐仅限 owner 自己的会话）。测试：`session_owner_test.go`（新）+ `register_grant_test.go`（`ownerTransport`/`foreignClient`）+ `register_test.go`/`api_test.go`——`TestGallery_OwnerCookieIssuedOnce`（恰好一个 Set-Cookie）/`TestGallery_OwnerBoundSessionIsolation`（外部读/touch/条目删/会话删/review-pin 均不 purge）/`TestSessionStore_ForeignAccessNeverPurgesOwnerSession`/`_MissingSession`/`TestSessionStore_OwnerAccessStillEvictsExpired`；`go test ./internal/api/...` 13 包 ok | | 修复后已按源码+测试复核；HTTP smoke 的 42/43 断言（setup-required 5/5、CSRF 11/11、DTO 3/3、raw path 410 9/9、SSRF 代理 4/4、iframe sandbox DOM 扫描）亦为旁证 |
| F-30 | fixed | 2bc4637，Phase B | `fs_handlers.go` `galleryFsEntry{name,rel,size,kind}`（无绝对路径）+ `listGalleryFiles` 仅 rel；`register_grant_test.go` | | `list-dir`/`file`/`open-dir` 响应不含本机路径 |

> 状态语义：`fixed`=后端+前端/测试按验收落地且已按源码核对；`partial`=部分落地，备注列出剩余项；`pending`=未实施；`decision-required`=需产品决策（当前保持推荐项）。"修复提交"列已记录实施阶段与修复提交 `2bc4637`（security(audit): remediate pre-release findings）。F-12 为决策项无代码变更。风险接受人待发布评审指派。
