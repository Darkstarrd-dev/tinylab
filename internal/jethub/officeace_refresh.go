package jethub

// OfficeAce STS 续期（refresh_token 一次性）—— codearts 同款三件套
// （ref cf5edab / officeace §2，三条规则**必须一起**）：
//
//  1. **per-credentialRef 串行**：三条入口（调度器 / 手动「续期」按钮 / 401 兜底）
//     会并发进入同一个 ref；refresh_token 一次性，先到者消费掉、后到者拿
//     STS5.1806。锁内重读让等锁者看到新凭据、少烧一个一次性 token。
//  2. **lead-time**：STS 寿命约 2 小时、调度器 30 分钟一轮 —— 无条件续期等于
//     一天烧 48 个一次性 token。距过期还早时只对账池值、不发请求。
//  3. **判终态前重读**：续期被拒时先确认「是不是别处已经续成功了」（磁盘上的
//     refresh_token 已不等于本次用的那份 ⇒ 服务端烧的是旧的，那是好消息）。
//
// ⚠️ STS 刷新成功即旧 refresh_token 作废 —— 新凭据必须**立即**落盘（顺序不能反），
// 否则进程被打断时新 token 永久丢失、只能重新登录（ref 模块头的死循环教训）。

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// lockOfficeaceRefresh serializes refreshes per credentialRef. Each ref gets
// its own mutex: different accounts' refresh tokens are independent, and a
// shared lock would stall B behind A for no reason (ref per-ref 分桶注释).
func (m *Manager) lockOfficeaceRefresh(ref string) func() {
	v, _ := m.officeaceRefreshLocks.LoadOrStore(ref, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// RefreshOfficeaceAccount renews one stored credential via the one-time
// refresh_token (Manager-facing entry: 调度器 + 面板「续期」按钮共用).
func (m *Manager) RefreshOfficeaceAccount(ctx context.Context, accountID string) error {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "officeace" {
		return ErrNotFound
	}
	cred, err := m.officeaceCredential(&acc)
	if err != nil {
		return err
	}
	if cred == nil {
		return fmt.Errorf("jethub: credential missing for %s", accountID)
	}
	if !officeaceRefreshable(cred) {
		return fmt.Errorf("jethub: 无 refresh_token，请重新登录")
	}

	// 串行 + 锁内重读：另一个调用者可能刚续期成功（换新即作废旧 token，并发
	// 消费必然「1 成功 N invalid_grant」）。
	unlock := m.lockOfficeaceRefresh(acc.CredentialRef)
	defer unlock()
	latest, err := m.officeaceCredential(&acc)
	if err != nil {
		return err
	}
	if latest == nil || !officeaceRefreshable(latest) {
		return fmt.Errorf("jethub: 无 refresh_token，请重新登录")
	}
	// 锁内重读后仍在有效期内 ⇒ 不发请求（少烧一个一次性 refresh_token）。
	if !officeaceShouldRefreshNow(latest, nowMillis()) {
		if m.logger != nil {
			m.logger.Info("[jethub] officeace 账号 %s 凭据仍在有效期内（可能已被他处续期），跳过本次续期请求", accountID)
		}
		return nil
	}
	return m.refreshOfficeaceLocked(ctx, &acc, latest)
}

// refreshOfficeaceLocked performs the exchange + persistence. The caller holds
// the per-credentialRef lock.
func (m *Manager) refreshOfficeaceLocked(ctx context.Context, acc *Account, cred *OfficeAceCredential) error {
	priv, err := KeyPairFromStoredJwk(*cred.DpopPrivateJwk)
	if err != nil {
		return err
	}
	token, err := exchangeOfficeaceRefreshToken(ctx, cred.RefreshToken, priv)
	if err != nil {
		if err == ErrRefreshTokenExpired {
			// 判终态前先重读（规则 3）：refresh_token 已被他处换新 ⇒
			// 「别人已经续成功」，不是「本账号不可续期」—— 不作废账号。
			if latest, rerr := m.officeaceCredential(acc); rerr == nil && latest != nil && latest.RefreshToken != cred.RefreshToken {
				if m.logger != nil {
					m.logger.Warn("[jethub] officeace 账号 %s: refresh_token 已被他处续期，本次 invalid_grant 不按终态处理", acc.ID)
				}
				return nil
			}
			// 真终态：标记不可续期（调度器与 UI 停止按可续期处理）。只在值
			// 变化时写 —— 账号文件整体重写，调度器 30 分钟一轮。
			if acc.Refreshable {
				_ = m.UpdateAccount(acc.ID, func(a *Account) { a.Refreshable = false })
			}
		}
		return err
	}

	next := &OfficeAceCredential{
		ModelAppKey:    cred.ModelAppKey,
		ModelAppSecret: cred.ModelAppSecret,
		MaasBaseUrl:    cred.MaasBaseUrl,
		Access:         token.Credentials.AccessKeyID,
		Secret:         token.Credentials.SecretAccessKey,
		SecurityToken:  token.Credentials.SecurityToken,
		ProjectID:      token.Credentials.ProjectID,
		ExpiresAt:      token.Credentials.Expiration,
		RefreshToken:   token.RefreshToken,
		DpopPrivateJwk: cred.DpopPrivateJwk,
		DisplayName:    cred.DisplayName,
		AccountID:      cred.AccountID,
	}
	if next.RefreshToken == "" {
		// STS 未下发新 refresh_token（理论上不发生）：保留旧的，避免把可续期
		// 凭据静默降级成不可续期。
		next.RefreshToken = cred.RefreshToken
	}
	if next.ProjectID == "" {
		next.ProjectID = cred.ProjectID
	}
	// modelInfo 里的 MaaS 凭据可能轮换：拉取失败不回滚 STS（推理凭据可能仍有效，
	// ref doRefreshCredential 的同款宽容）。
	if err := officeaceFetchModelInfo(ctx, m, next); err != nil && m.logger != nil {
		m.logger.Warn("[jethub] officeace 账号 %s 续期后刷新 modelInfo 失败（保留原 MaaS 凭据）: %v", acc.ID, err)
	}
	raw, err := json.Marshal(next)
	if err != nil {
		return err
	}
	// ⚠️ 立即落盘：此刻旧 refresh_token 已被服务端作废，落盘前被打断 = 新 token
	// 永久丢失。SetCredential 同时刷新账号显示字段并触发桥接同步。
	return m.SetCredential(acc.Provider, acc.CredentialRef, raw, officeaceCredentialExpiresAt(next), officeaceRefreshable(next))
}

// RefreshAllOfficeace renews every officeace account whose credential material
// is complete and whose STS expiry falls inside the lead window (including
// disabled ones — disabled only affects selection, not credential health).
//
// ⚠️ `refreshable` 只是**凭据材料的镜像**：每轮按凭据对账、值变化才写盘（被误标
// 的账号下一轮自愈）；绝不能拿它当调度判据（codearts cf5edab 第 1 条同款教训）。
func (m *Manager) RefreshAllOfficeace(ctx context.Context) {
	for _, acc := range m.Accounts("officeace") {
		cred, err := m.officeaceCredential(&acc)
		if err != nil {
			if m.logger != nil {
				m.logger.Warn("[jethub] officeace 账号 %s 凭据解析失败: %v", acc.ID, err)
			}
			continue
		}
		want := officeaceRefreshable(cred)
		if acc.Refreshable != want {
			_ = m.UpdateAccount(acc.ID, func(a *Account) { a.Refreshable = want })
		}
		if !want || !officeaceShouldRefreshNow(cred, nowMillis()) {
			continue
		}
		if err := m.RefreshOfficeaceAccount(ctx, acc.ID); err != nil {
			if m.logger != nil {
				m.logger.Warn("[jethub] officeace 账号 %s 续期失败: %v", acc.ID, err)
			}
		}
	}
}
