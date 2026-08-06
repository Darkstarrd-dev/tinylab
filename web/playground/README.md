# TinyRouter Playground

Playground 的 canonical 前后端架构文档位于：

- [`docs/playground-architecture.md`](../../docs/playground-architecture.md)

后续设计、排障和评审请先读取该文档，再按其中“源码锚点”核对本次变更涉及的代码。

当前实现已经拆分为多个 `pg-*.js` 文件（位于 `static-pg/playground/` 子目录）；`playground/playground.js` 只保留兼容说明，不再是主模块。实际加载顺序以 `web/static/index.html` 为准；`static-pg` 按文件静态路由由 `internal/feature/feature.go` 的 `StaticFiles` manifest 经 `feature.Assets` 派生（`internal/api/router.go`）。
