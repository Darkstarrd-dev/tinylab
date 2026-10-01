package jethub

import (
	"encoding/json"
	"fmt"
	"time"
)

// 备份导出/导入 —— 与原版 Jet Hub 备份格式双向兼容（§1.5，实测自
// ref types.ts BackupPayload / backup-crypto.js）。
//
// 分工：**载荷组装与导入在本端（Go，可单测逐字段比对）**；加密壳在浏览器
// （crypto.subtle PBKDF2(310000)+AES-GCM，明文备份 JSON 不经过日志/进程内存
// —— 与原版同 API 同参数，导出的加密壳可被原版恢复，原版备份可被本端恢复）。

const (
	// BackupFormat is the original plugin's BACKUP_FORMAT (self-contained,
	// DSH-version independent).
	BackupFormat = "dsh-codearts-auth/backup"
	// BackupVersion is the original plugin's BACKUP_VERSION.
	BackupVersion = 1
)

// BackupPayload mirrors ref types.ts BackupPayload field-for-field:
//   - credentials 值是凭据 JSON **原文字符串**（与存储形态一致，导入直接回写
//     不重新序列化，避免字段丢失或变形）；
//   - accounts 是账号池索引（accountEntry 与原版 ProviderAccountEntry 同构，
//     见 manager.go 的注释）；
//   - disabledModels 是模型黑名单（provider → 模型 id → true）；
//   - permanentLocks 是「锁定永久积分」provider 级开关（仅 true 值有效，
//     与原版 sanitizePermanentLocks 一致）；loomyPermanentLocked 是旧版
//     Loomy 专用兼容字段（仅在没有 permanentLocks 表时生效）。
type BackupPayload struct {
	Format         string                     `json:"format"`
	Version        int                        `json:"version"`
	ExportedAt     string                     `json:"exportedAt"`
	Credentials    map[string]string          `json:"credentials"`
	Accounts       []accountEntry             `json:"accounts"`
	DisabledModels map[string]map[string]bool `json:"disabledModels"`
	PermanentLocks map[string]bool            `json:"permanentLocks,omitempty"`
	// LoomyPermanentLocked mirrors ref types.ts 的 legacy 兼容字段（指针区分
	// 缺省与 false；原版 locksFromPayload 的三分支语义）。
	LoomyPermanentLocked *bool `json:"loomyPermanentLocked,omitempty"`
}

// ExportBackup assembles the original-compatible plaintext payload. Warnings
// list account ids whose credential was missing (export continues — the
// original does the same: 凭据缺失/损坏不中断导出).
func (m *Manager) ExportBackup() (*BackupPayload, []string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	accounts := make([]accountEntry, 0, len(m.accounts.Accounts))
	credentials := map[string]string{}
	var warnings []string
	for _, entry := range m.accounts.Accounts {
		accounts = append(accounts, entry)
		raw, ok := m.credentials[entry.Provider][entry.CredentialRef]
		if !ok {
			warnings = append(warnings, entry.ID)
			continue
		}
		credentials[entry.CredentialRef] = string(raw)
	}
	disabled := m.accounts.DisabledModels
	if disabled == nil {
		disabled = map[string]map[string]bool{}
	}
	// Sanitized lock copy (true values only) — caller holds m.mu.RLock, so
	// read the map inline instead of via the locking snapshot helper.
	locks := map[string]bool{}
	for p, v := range m.accounts.PermanentLocks {
		if v {
			locks[p] = true
		}
	}
	return &BackupPayload{
		Format:         BackupFormat,
		Version:        BackupVersion,
		ExportedAt:     time.Now().UTC().Format(time.RFC3339),
		Credentials:    credentials,
		Accounts:       accounts,
		DisabledModels: disabled,
		PermanentLocks: locks,
	}, warnings
}

// ImportBackup: 账号按**原 id** upsert（同 id 整体替换——与 JetHubState 同构
// 的整体替换语义，导入幂等），凭据 JSON **原文直存**（不重新序列化），黑名单
// **整体替换**。返回 (导入数, 替换数, 警告)。
func (m *Manager) ImportBackup(payload *BackupPayload) (imported, skipped int, warnings []string, err error) {
	if payload == nil {
		return 0, 0, nil, fmt.Errorf("jethub: empty backup payload")
	}
	if payload.Format != BackupFormat {
		return 0, 0, nil, fmt.Errorf("jethub: unsupported backup format %q (want %q)", payload.Format, BackupFormat)
	}
	if payload.Version != BackupVersion {
		return 0, 0, nil, fmt.Errorf("jethub: unsupported backup version %d (want %d)", payload.Version, BackupVersion)
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	refProvider := map[string]string{}
	for _, entry := range payload.Accounts {
		if entry.ID == "" || entry.Provider == "" || entry.CredentialRef == "" {
			warnings = append(warnings, "跳过无效账号条目: "+entry.ID)
			continue
		}
		refProvider[entry.CredentialRef] = entry.Provider
		replaced := false
		for i := range m.accounts.Accounts {
			if m.accounts.Accounts[i].ID == entry.ID {
				m.accounts.Accounts[i] = entry
				replaced = true
				break
			}
		}
		if replaced {
			skipped++
			continue
		}
		m.accounts.Accounts = append(m.accounts.Accounts, entry)
		imported++
	}
	for ref, credJSON := range payload.Credentials {
		provider := refProvider[ref]
		if provider == "" {
			warnings = append(warnings, "凭据无对应账号，跳过: "+ref)
			continue
		}
		if _, ok := m.credentials[provider]; !ok {
			m.credentials[provider] = map[string]json.RawMessage{}
		}
		// ⚠️ 原文直存：凭据字段由各 provider 的实现按 ref types.ts 1:1 消费，
		// 任何重新序列化都可能丢字段或变形（§1.5 兼容语义的核心）。
		m.credentials[provider][ref] = json.RawMessage(credJSON)
	}
	disabled := payload.DisabledModels
	if disabled == nil {
		disabled = map[string]map[string]bool{}
	}
	m.accounts.DisabledModels = disabled

	// 「锁定永久积分」：镜像原版 locksFromPayload 的三分支语义——
	//   ① 有 permanentLocks 表 → 消费该表（整体替换，脏值过滤）；
	//   ② 仅有 loomyPermanentLocked（旧版导出）→ 只落 loomy 一键；
	//   ③ 两者皆无 → undefined = 保持当前值不变。
	if payload.PermanentLocks != nil {
		locks := map[string]bool{}
		for p, v := range payload.PermanentLocks {
			if v { // 脏值过滤与原版 sanitizePermanentLocks 一致：只留 true
				locks[p] = true
			}
		}
		m.accounts.PermanentLocks = locks
	} else if payload.LoomyPermanentLocked != nil {
		locks := map[string]bool{}
		for p := range m.accounts.PermanentLocks {
			if p != "loomy" {
				locks[p] = m.accounts.PermanentLocks[p]
			}
		}
		if *payload.LoomyPermanentLocked {
			locks["loomy"] = true
		}
		m.accounts.PermanentLocks = locks
	}
	if m.accounts.PermanentLocks == nil {
		m.accounts.PermanentLocks = map[string]bool{}
	}

	if err := m.saveAccountsLocked(); err != nil {
		return imported, skipped, warnings, err
	}
	if err := m.saveCredentialsLocked(); err != nil {
		return imported, skipped, warnings, err
	}
	return imported, skipped, warnings, nil
}
