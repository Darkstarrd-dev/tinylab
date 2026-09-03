---
name: tinylab-password-protection-audit
description: "Audit findings and remediation (IMPLEMENTED 2026-07-31) for TinyLab's password protection: SecurityConfig/encrypt/decrypt chain, AuthMiddleware/LoginHandler/session store, toggle-on-without-password bug, defensive-bypass security hole, savePasswordModal double-PATCH, and login failure auto-exit"
---

# TinyLab Password Protection Audit & Remediation

**Status: IMPLEMENTED 2026-07-31 (增补#27)**

## Feature Architecture (12+ files)

### Config Layer
- `config/types.go:189-194` — `SecurityConfig{PasswordEnabled, PasswordEncrypted, EncryptionKey}`
- `config/crypto.go` — `GenerateKey` (32-byte AES-256), `Encrypt`/`Decrypt` (AES-GCM), `encryptKeysCopy` (deep-copies cfg, encrypts API keys with `enc:` prefix)
- `config/persistence.go:173-186` — `Save`: only calls `encryptKeysCopy` when `PasswordEnabled && EncryptionKey != ""`; otherwise writes plaintext
- `config/defaults.go:143-167` (UPDATED) — `finalizeConfig`: now includes Security consistency normalization BEFORE API key decryption. If `PasswordEnabled=true` but `PasswordEncrypted==""` or `EncryptionKey==""` → normalize to `false` + stderr warning. Also warns about orphaned `enc:`-prefixed keys when protection is disabled.

### Auth Layer
- `auth/handler.go:112-115` — `isAuthEnabled()`: returns `cfg.Security.PasswordEnabled`
- `auth/handler.go:118-135` — `AuthMiddleware`: requires valid session cookie when enabled, returns 401 if absent
- `auth/handler.go:155-198` (UPDATED) — `LoginHandler`: defensive bypass REMOVED. Was: `PasswordEncrypted==""` → grant session for ANY password (security hole). Now: returns HTTP 500 error. finalizeConfig normalization makes this branch unreachable at runtime; serves as defense-in-depth.
- `auth/handler.go:42` — `SessionStore`: in-memory Go map, lost on restart (by design)
- `auth/handler.go:73-83` — `SetSessionCookie`: `MaxAge: 0` (browser session cookie)
- `auth/rate_limit.go` — 5 attempts/min, 1 min block

### Settings API
- `settings/register.go:41-74` — `getSettings`: returns `{passwordEnabled, hasPassword}` (NOT actual password)
- `settings/register.go:173-200` (UPDATED) — `updateSettings` security handler: now REJECTS `passwordEnabled=true` without password when `PasswordEncrypted==""` (returns 400). Password field still generates key + encrypts + sets `PasswordEnabled=true`.
- `api/router.go:320-416` — `/api/*` group has AuthMiddleware; static UI does NOT (correct for SPA)

### Frontend (ALL UPDATED)
- `endpoint.js:439-462` — `togglePasswordProtection`: enabling now opens password modal instead of direct PATCH
- `endpoint.js:585-599` — `openPasswordModal`: removed misleading "Current Password" field; uses `hasPassword` hint + new password input only
- `endpoint.js:1039-1057` — `savePasswordModal`: fixed from dual-PATCH to single PATCH `{security:{password:<value>}}`
- `endpoint.js` — dead `savePassword` function DELETED
- `auth.js:67-101` — `handleLogin`: failure no longer auto-exits after 2s; allows retry (re-enable button, clear input, refocus)
- `i18n.js:266,756` — added `passwordChangeHint` (EN+ZH); updated `wrongPassword` to remove "App will exit"

## Issues Found & Remediation Status

### P0 — FIXED
1. **Toggle-on without password**: FIXED — frontend opens modal + backend rejects 400
2. **Inconsistent state (PasswordEnabled=true, no password)**: FIXED — finalizeConfig normalizes to false + LoginHandler returns 500 instead of granting access
3. **Direct config.yaml edit bypass**: PARTIALLY FIXED — finalizeConfig normalizes inconsistent state on startup; cannot prevent editing but eliminates the dangerous middle state

### P1 — MITIGATED
4. **Orphaned enc: keys**: MITIGATED — finalizeConfig warns about undecryptable `enc:`-prefixed keys when protection is disabled

### P2 — FIXED
5. Session cookie MaxAge=0: NOT CHANGED (by design per AGENTS.md)
6. "Current Password" field always empty: FIXED — field removed
7. savePasswordModal double-PATCH: FIXED — single PATCH
8. Login failure auto-exit: FIXED — allows retry
9. Dead `savePassword` code: FIXED — deleted

### P3 — NOTED, NOT FIXED
10. No password complexity: not addressed
11. Static UI without auth: correct for SPA, noted

## Tests Added
- `auth/auth_test.go:TestLoginHandler_RejectsInconsistentState` — verifies 500 on inconsistent state
- `config/config_test.go:TestFinalizeConfig_NormalizesPasswordEnabledWithoutPassword` — verifies normalization + warning
- `config/config_test.go:TestFinalizeConfig_KeepsPasswordEnabledWithPassword` — verifies valid config stays enabled

## Key Design Decision
The core principle: **once enabled, password protection must be effective**. The system cannot enter "enabled but ineffective" or "enabled but bypassable" states. Three layers of defense:
1. **Frontend**: toggle-on opens modal forcing password entry
2. **Backend API**: rejects enable-without-password (400)
3. **Config load**: finalizeConfig normalizes inconsistent state to disabled on every startup
