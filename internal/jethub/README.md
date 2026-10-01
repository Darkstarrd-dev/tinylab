# internal/jethub — Free Hub provider family

文件命名约定：

- `<provider>.go` — provider 主体（注册、模型表、状态页路由）
- `<provider>_auth.go` / `<provider>_credits.go` / `<provider>_augment.go` /
  `<provider>_convert.go` / `<provider>_stream.go` — 该 provider 的登录/鉴权、
  余额积分、Augment 分发、协议转换与流式适配等家族文件
- 共享层：`accountpool.go`（账号池）、`backup.go`（备份双向兼容）、
  `bridge.go`（registry 桥接）、`qoderwasm*.go`（WASM 加密推理桥）等

**不要为 11 个 provider 抽象统一 interface —— 协议差异是本质复杂度，不是偶然
重复。** 每家上游的登录流、签名、积分口径与流式行为都不同；强行收敛只会把
真实差异藏进配置开关。新增 provider 时按上述命名落一个新家族即可。
