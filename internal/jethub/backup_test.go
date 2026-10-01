package jethub

import (
	"encoding/json"
	"testing"
)

// 备份往返：字段形态与原版 BackupPayload 逐字段比对（§1.5/P4.9 反向兼容验证）。
func TestBackupExportShapeAndRoundtrip(t *testing.T) {
	m := newTestManager(t).m
	id, ref := NewAccountID("qoder")
	if err := m.AddAccount(Account{ID: id, Provider: "qoder", Nickname: "小七",
		Enabled: true, CredentialRef: ref, CreatedAt: 1700000000000}); err != nil {
		t.Fatal(err)
	}
	cred := &QoderCredential{SecurityOauthToken: "tok-1", AccessToken: "tok-1",
		RefreshToken: "rt-1", MachineID: "mid-1", UID: "uid-1", Nickname: "小七"}
	credJSON, _ := json.Marshal(cred)
	if err := m.SetCredential("qoder", ref, credJSON, 1700000100000, true); err != nil {
		t.Fatal(err)
	}
	if err := m.SetModelDisabled("qoder", "auto", true); err != nil {
		t.Fatal(err)
	}

	payload, warnings := m.ExportBackup()
	if len(warnings) != 0 {
		t.Fatalf("no warnings expected: %v", warnings)
	}
	// ⚠️ 逐字段比对原版 BackupPayload（ref types.ts）。
	if payload.Format != "dsh-codearts-auth/backup" {
		t.Fatalf("format: %q", payload.Format)
	}
	if payload.Version != 1 {
		t.Fatalf("version: %d", payload.Version)
	}
	if payload.ExportedAt == "" {
		t.Fatal("exportedAt required")
	}
	if len(payload.Accounts) != 1 {
		t.Fatalf("accounts: %d", len(payload.Accounts))
	}
	entry := payload.Accounts[0]
	if entry.ID != id || entry.Provider != "qoder" || entry.Nickname != "小七" ||
		!entry.Enabled || entry.CredentialRef != ref || entry.CreatedAt != 1700000000000 {
		t.Fatalf("account entry mismatch: %+v", entry)
	}
	// credentials 按 credentialRef 索引、值为 JSON 原文字符串。
	raw, ok := payload.Credentials[ref]
	if !ok {
		t.Fatalf("credentials keyed by ref: %v", payload.Credentials)
	}
	var back QoderCredential
	if err := json.Unmarshal([]byte(raw), &back); err != nil || back.UID != "uid-1" || back.MachineID != "mid-1" {
		t.Fatalf("credential roundtrip: %q (%v)", raw, err)
	}
	if !payload.DisabledModels["qoder"]["auto"] {
		t.Fatalf("disabledModels: %v", payload.DisabledModels)
	}

	// 往返：第二个管理器导入后账号 id/凭据/黑名单全部还原。
	m2 := newTestManager(t).m
	imported, skipped, warnings2, err := m2.ImportBackup(payload)
	if err != nil || imported != 1 || skipped != 0 || len(warnings2) != 0 {
		t.Fatalf("import: imported=%d skipped=%d warnings=%v err=%v", imported, skipped, warnings2, err)
	}
	acc, ok := m2.FindAccount(id)
	if !ok || acc.Provider != "qoder" || acc.Nickname != "小七" || acc.CredentialRef != ref {
		t.Fatalf("imported account: %+v (%v)", acc, ok)
	}
	got, ok := m2.Credential("qoder", ref)
	if !ok {
		t.Fatal("imported credential missing")
	}
	var gotCred QoderCredential
	if err := json.Unmarshal(got, &gotCred); err != nil || gotCred.RefreshToken != "rt-1" || gotCred.UID != "uid-1" {
		t.Fatalf("imported credential content: %s (%v)", string(got), err)
	}
	if !m2.DisabledModels("qoder")["auto"] {
		t.Fatal("imported blacklist lost")
	}
}

// 幂等：同一 payload 再导入 = 全部替换计数（不产生重复账号）。
func TestBackupImportIdempotent(t *testing.T) {
	m := newTestManager(t).m
	id, ref := NewAccountID("codearts")
	if err := m.AddAccount(Account{ID: id, Provider: "codearts", Nickname: "a",
		Enabled: true, CredentialRef: ref, CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	payload, _ := m.ExportBackup()
	if _, skipped, _, err := m.ImportBackup(payload); err != nil || skipped != 1 {
		t.Fatalf("re-import must replace: skipped=%d err=%v", skipped, err)
	}
	if got := len(m.Accounts("codearts")); got != 1 {
		t.Fatalf("duplicate accounts after re-import: %d", got)
	}
}

// 拒绝：格式/版本不符、payload 为 nil。
func TestBackupImportRejectsForeignFormats(t *testing.T) {
	m := newTestManager(t).m
	if _, _, _, err := m.ImportBackup(nil); err == nil {
		t.Fatal("nil payload must error")
	}
	bad := &BackupPayload{Format: "other", Version: 1}
	if _, _, _, err := m.ImportBackup(bad); err == nil {
		t.Fatal("foreign format must error")
	}
	badVer := &BackupPayload{Format: BackupFormat, Version: 99}
	if _, _, _, err := m.ImportBackup(badVer); err == nil {
		t.Fatal("foreign version must error")
	}
}

// 「锁定永久积分」随备份双向迁移：导出写 permanentLocks（只留 true），导入
// 整体替换；旧版导出（仅有 loomyPermanentLocked）按原版 locksFromPayload 的
// 三分支语义落 loomy 一键；两者皆缺省 = 保持当前值。
func TestBackupPermanentLocksRoundtrip(t *testing.T) {
	m := newTestManager(t).m
	if err := m.SetPermanentLocked("buddy", true); err != nil {
		t.Fatal(err)
	}
	if err := m.SetPermanentLocked("loomy", true); err != nil {
		t.Fatal(err)
	}
	payload, _ := m.ExportBackup()
	if !payload.PermanentLocks["buddy"] || !payload.PermanentLocks["loomy"] {
		t.Fatalf("exported locks: %v", payload.PermanentLocks)
	}
	// 生成一份带 false 脏值的表，验证导出过滤（sanitize 只留 true）。
	m2 := newTestManager(t).m
	payload2 := &BackupPayload{
		Format: BackupFormat, Version: BackupVersion, ExportedAt: "t",
		Credentials:    map[string]string{},
		DisabledModels: map[string]map[string]bool{},
		PermanentLocks: map[string]bool{"buddy": true, "loomy": false, "workbuddy": true},
	}
	if _, _, _, err := m2.ImportBackup(payload2); err != nil {
		t.Fatal(err)
	}
	if !m2.PermanentLocked("buddy") || m2.PermanentLocked("loomy") || !m2.PermanentLocked("workbuddy") {
		t.Fatalf("lock table after import: %v", m2.PermanentLocksSnapshot())
	}
	// 旧版导出：无 permanentLocks 表 + loomyPermanentLocked=true → 只落 loomy。
	m3 := newTestManager(t).m
	_ = m3.SetPermanentLocked("buddy", true)
	trueVal := true
	payload3 := &BackupPayload{
		Format: BackupFormat, Version: BackupVersion, ExportedAt: "t",
		Credentials:          map[string]string{},
		DisabledModels:       map[string]map[string]bool{},
		LoomyPermanentLocked: &trueVal,
	}
	if _, _, _, err := m3.ImportBackup(payload3); err != nil {
		t.Fatal(err)
	}
	if !m3.PermanentLocked("loomy") || !m3.PermanentLocked("buddy") {
		t.Fatalf("legacy loomy lock import: %v", m3.PermanentLocksSnapshot())
	}
	// 两者皆缺省 → 保持当前值（undefined 语义）。
	if err := m3.SetPermanentLocked("buddy", false); err != nil {
		t.Fatal(err)
	}
	payload4 := &BackupPayload{
		Format: BackupFormat, Version: BackupVersion, ExportedAt: "t",
		Credentials:    map[string]string{},
		DisabledModels: map[string]map[string]bool{},
	}
	if _, _, _, err := m3.ImportBackup(payload4); err != nil {
		t.Fatal(err)
	}
	if !m3.PermanentLocked("loomy") || m3.PermanentLocked("buddy") {
		t.Fatalf("absent lock fields must keep current state: %v", m3.PermanentLocksSnapshot())
	}
}
