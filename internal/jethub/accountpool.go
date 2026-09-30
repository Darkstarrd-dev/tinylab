package jethub

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

// AccountPool implements the provider account selection semantics ported from
// the plugin's src/account-pool.ts: enabled accounts only, per-model rate
// limit filtering, manual (array) order as candidate priority, exclusion
// support for request-level rotation.
//
// It is a pure policy type: the Manager provides the snapshot, the pool picks.
type AccountPool struct {
	m *Manager
}

// NewAccountPool wraps a Manager with selection helpers.
func NewAccountPool(m *Manager) *AccountPool { return &AccountPool{m: m} }

// NewAccountID generates an account id of the shape {provider}-{8hex} and a
// credential ref {PROVIDER}_ACCOUNT_{HEX} matching the original plugin's
// naming (§1.5 ProviderAccountEntry.credentialRef).
func NewAccountID(provider string) (id, credentialRef string) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failing is catastrophic; fall back to time-based uniqueness
		// rather than panicking (AGENTS.md: no panic).
		now := time.Now().UnixNano()
		b[0] = byte(now)
		b[1] = byte(now >> 8)
		b[2] = byte(now >> 16)
		b[3] = byte(now >> 24)
	}
	short := hex.EncodeToString(b[:])
	return provider + "-" + short, strings.ToUpper(provider) + "_ACCOUNT_" + strings.ToUpper(short)
}

// GetAvailableAccount returns the first usable account for provider+model:
// enabled, credential present, not rate-limited for the model, not in the
// exclude set. Manual array order is the candidate priority (no re-sorting —
// matches the plugin's "manual order first, rate-limit exemption" semantics).
func (p *AccountPool) GetAvailableAccount(provider, modelID string, excludeAccountIDs map[string]bool) (*Account, error) {
	accounts := p.m.Accounts(provider)
	now := time.Now().UnixMilli()
	for i := range accounts {
		a := accounts[i]
		if !a.Enabled {
			continue
		}
		if excludeAccountIDs[a.ID] {
			continue
		}
		if _, ok := p.m.Credential(provider, a.CredentialRef); !ok {
			continue
		}
		if modelID != "" {
			if resetAt, ok := a.ModelRateLimits[modelID]; ok && resetAt > 0 && now < resetAt {
				continue
			}
		}
		return &a, nil
	}
	if len(accounts) == 0 {
		return nil, fmt.Errorf("jethub: no accounts for provider %s", provider)
	}
	return nil, fmt.Errorf("jethub: no available account for %s/%s", provider, modelID)
}

// SortedByRateLimitReset returns accounts ordered by their per-model reset
// time ascending (earliest expiring first), used by UI hints. Enabled only.
func (p *AccountPool) SortedByRateLimitReset(provider, modelID string) []Account {
	accounts := p.m.Accounts(provider)
	now := time.Now().UnixMilli()
	out := make([]Account, 0, len(accounts))
	for _, a := range accounts {
		if !a.Enabled {
			continue
		}
		if resetAt, ok := a.ModelRateLimits[modelID]; ok && resetAt > 0 && now < resetAt {
			a.ExpiresAt = resetAt // surface the reset time for display
		}
		out = append(out, a)
	}
	sort.SliceStable(out, func(i, j int) bool {
		ri, _ := out[i].ModelRateLimits[modelID]
		rj, _ := out[j].ModelRateLimits[modelID]
		return ri < rj
	})
	return out
}
