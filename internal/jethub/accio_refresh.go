package jethub

// Accio 续期（refresh_token 会**轮换**——按最坏假设设防，ref §10 U-A）——
// codearts/officeace 同款三件套（ref cf5edab / accio-auth.ts 文件头，三条
// 规则**必须一起**）：
//
//  1. **per-credentialRef 串行**：三条入口（调度器 / 手动「续期」按钮 /
//     推理路径 401 兜底）会并发进入同一个 ref；refresh 会轮换 refresh_token，
//     先到者换新、后到者拿旧的那份去请求 ⇒ invalid_grant。锁内重读让等锁者
//     看到新凭据、少烧一次续期请求。
//  2. **lead-time**：access_token 寿命约 30 天、调度器 30 分钟一轮 —— 距过期
//     还早时只对账池值、不发请求。
//  3. **判终态前重读**：续期被拒时先确认「是不是别处已经续成功了」（磁盘上的
//     refresh_token 已不等于本次用的那份 ⇒ 服务端烧的是旧的，那是好消息）。
//
// ⚠️ 判终态只认 accioTerminalRefreshMarkers（invalid_grant / NOT_LOGIN 家族）；
// 泛化 401/403、网络抖动一律按可重试的普通失败处理。

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// lockAccioRefresh serializes refreshes per credentialRef（codearts
// lockCodeartsRefresh 同款：不同账号的 refresh_token 独立，分桶避免无谓互踩）.
func (m *Manager) lockAccioRefresh(ref string) func() {
	v, _ := m.accioRefreshLocks.LoadOrStore(ref, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// accioCredential reads + parses one account's stored credential
// (nil, nil when absent).
func (m *Manager) accioCredential(acc *Account) (*AccioCredential, error) {
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		return nil, nil
	}
	var cred AccioCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse accio credential %s: %w", acc.ID, err)
	}
	return &cred, nil
}

// accioCredentialFor resolves + validates the credential behind a rotation key
// id (the augmenter/customizer path).
func (m *Manager) accioCredentialFor(keyID string) (*AccioCredential, error) {
	acc, ok := m.FindAccount(keyID)
	if !ok || acc.Provider != "accio" {
		return nil, fmt.Errorf("jethub: account %s not found for accio", keyID)
	}
	cred, err := m.accioCredential(&acc)
	if err != nil {
		return nil, err
	}
	if cred == nil {
		return nil, fmt.Errorf("jethub: credential missing for accio account %s", keyID)
	}
	if cred.AccessToken == "" {
		return nil, fmt.Errorf("jethub: accio 凭据不完整（缺 access_token），请重新登录（账号 %s）", keyID)
	}
	return cred, nil
}

// RefreshAccioAccount renews one stored credential via the rotating
// refresh_token (调度器 + 面板「续期」按钮 + 401 兜底共用).
func (m *Manager) RefreshAccioAccount(ctx context.Context, accountID string) error {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "accio" {
		return ErrNotFound
	}
	cred, err := m.accioCredential(&acc)
	if err != nil {
		return err
	}
	if cred == nil {
		return fmt.Errorf("jethub: credential missing for %s", accountID)
	}
	if !accioRefreshable(cred) {
		return fmt.Errorf("jethub: 无 refresh_token，请重新登录")
	}

	// 串行 + 锁内重读：另一个调用者可能刚续期成功（换新即作废旧 token，并发
	// 消费必然「1 成功 N invalid_grant」）。
	unlock := m.lockAccioRefresh(acc.CredentialRef)
	defer unlock()
	latest, err := m.accioCredential(&acc)
	if err != nil {
		return err
	}
	if latest == nil || !accioRefreshable(latest) {
		return fmt.Errorf("jethub: 无 refresh_token，请重新登录")
	}
	// 锁内重读后仍在有效期内 ⇒ 不发请求（ref cf5edab：等锁期间已被他处续好的
	// 第二个调用者少烧一次续期请求）。
	if !accioShouldRefreshNow(latest, nowMillis()) {
		if m.logger != nil {
			m.logger.Info("[jethub] accio 账号 %s 凭据仍在有效期内（可能已被他处续期），跳过本次续期请求", accountID)
		}
		return nil
	}
	return m.refreshAccioLocked(ctx, &acc, latest)
}

// refreshAccioLocked performs the exchange + persistence. The caller holds the
// per-credentialRef lock.
func (m *Manager) refreshAccioLocked(ctx context.Context, acc *Account, cred *AccioCredential) error {
	token, err := refreshAccioCredential(ctx, cred)
	if err != nil {
		if err == ErrRefreshTokenExpired {
			// 判终态前先重读（规则 3）：refresh_token 已被他处换新 ⇒
			// 「别人已经续成功」，不是「本账号不可续期」—— 不作废账号。
			if latest, rerr := m.accioCredential(acc); rerr == nil && latest != nil && latest.RefreshToken != cred.RefreshToken {
				if m.logger != nil {
					m.logger.Warn("[jethub] accio 账号 %s: refresh_token 已被他处续期，本次失败不按终态处理", acc.ID)
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

	next := &AccioCredential{
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		ExpiresAtMs:  token.ExpiresAtMs,
		Sgcookie:     token.Sgcookie,
		Region:       cred.Region,
		UserID:       cred.UserID,
		AccioID:      cred.AccioID,
		Nickname:     cred.Nickname,
	}
	if next.RefreshToken == "" {
		// 服务端未下发新 refresh_token（理论上不发生）：保留旧的，避免把可续期
		// 凭据静默降级成不可续期。
		next.RefreshToken = cred.RefreshToken
	}
	if next.Sgcookie == "" {
		next.Sgcookie = cred.Sgcookie
	}
	raw, err := json.Marshal(next)
	if err != nil {
		return err
	}
	// ⚠️ 立即落盘：refresh 轮换意味着此刻旧 token 可能已被作废，落盘前被打断
	// = 新 token 永久丢失（officeace_refresh.go 文件头的同一条纪律）。
	// SetCredential 同时刷新账号显示字段并触发桥接同步。
	return m.SetCredential(acc.Provider, acc.CredentialRef, raw, accioCredentialExpiresAt(next), accioRefreshable(next))
}

// RefreshAllAccio renews every accio account whose credential material is
// complete and whose expiry falls inside the lead window (including disabled
// ones — disabled only affects selection, not credential health).
//
// ⚠️ `refreshable` 只是**凭据材料的镜像**：每轮按凭据对账、值变化才写盘（被误标
// 的账号下一轮自愈）；绝不能拿它当调度判据（codearts cf5edab 第 1 条同款教训）。
func (m *Manager) RefreshAllAccio(ctx context.Context) {
	for _, acc := range m.Accounts("accio") {
		cred, err := m.accioCredential(&acc)
		if err != nil {
			if m.logger != nil {
				m.logger.Warn("[jethub] accio 账号 %s 凭据解析失败: %v", acc.ID, err)
			}
			continue
		}
		want := accioRefreshable(cred)
		if acc.Refreshable != want {
			_ = m.UpdateAccount(acc.ID, func(a *Account) { a.Refreshable = want })
		}
		if !want || !accioShouldRefreshNow(cred, nowMillis()) {
			continue
		}
		if err := m.RefreshAccioAccount(ctx, acc.ID); err != nil {
			if m.logger != nil {
				m.logger.Warn("[jethub] accio 账号 %s 续期失败: %v", acc.ID, err)
			}
		}
	}
}

// CompleteAccioLogin persists a finished login: stores the credential on the
// account's ref and back-fills the nickname (userinfo 的 userName，缺省回落
// "Accio " + user_id 前缀；再缺省保留面板占位名).
func (m *Manager) CompleteAccioLogin(accountID string, credentialJSON []byte, expiresAt int64, refreshable bool) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, credentialJSON, expiresAt, refreshable); err != nil {
		return err
	}
	var cred AccioCredential
	if err := jsonUnmarshal(credentialJSON, &cred); err == nil {
		nickname := ""
		if cred.Nickname != "" {
			nickname = "Accio " + cred.Nickname
		} else if cred.UserID != "" {
			nickname = "Accio " + cred.UserID
		}
		if len(nickname) > 24 {
			nickname = nickname[:24]
		}
		if nickname != "" {
			_ = m.UpdateAccount(accountID, func(a *Account) { a.Nickname = nickname })
		}
	}
	return nil
}

// AccioOutcomeMeta exposes the LoginOutcome display hints to the API layer
// (expiry + refreshability).
func AccioOutcomeMeta(cred *AccioCredential) (expiresAt int64, refreshable bool) {
	return accioCredentialExpiresAt(cred), accioRefreshable(cred)
}
