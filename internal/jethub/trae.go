package jethub

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// TRAE (字节跳动) protocol constants — 1:1 from ref trae.ts / trae-product.ts /
// trae-oauth.ts. Five protocol differences from other providers: ExchangeToken
// (rotating refreshToken), Cloud-IDE-JWT auth family, OpenAI→SOLO body
// conversion, SOLO custom SSE events, and per-account machine/device ids.
const (
	traeChatPath        = "/api/agent/v3/llm_utils_chat"
	traeModelsPath      = "/api/ide/v1/get_detail_param"
	traeBatchModelsPath = "/api/ide/v1/batch_get_detail_param"
	traeExchangePath    = "/cloudide/api/v3/trae/oauth/ExchangeToken"
	traeUserInfoPath    = "/cloudide/api/v3/trae/GetUserInfo"
	traeCheckinStatus   = "/trae/api/v2/ug/checkin_credits/status"
	traeCheckinClaim    = "/trae/api/v2/ug/checkin_credits/claim"
	traeEntUsagePath    = "/trae/api/v2/pay/ide_user_ent_usage"
	traeCallbackPath    = "/authorize"
	traeRequestTimeout  = 30 * time.Second
	traeLoginTimeout    = 10 * time.Minute
	traeCallbackPort    = 18080
)

// TRAE host split (ref trae-product.ts): three separate hosts. Vars so tests
// can repoint ExchangeToken/GetUserInfo at mock servers.
var (
	traeAgentHost   = "https://trae-api-cn.mchost.guru"
	traeUGHost      = "https://api.trae.cn"
	traeOAuthHost   = "https://api.trae.com.cn"
	traeConsoleHost = "https://www.trae.cn"
)

// TraeProduct is the TRAE product config.
var traeProduct = &traeProductConfig{
	ID: "trae", DisplayName: "TRAE",
	ClientID: "en1oxy7wnw8j9n", AppID: "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
	AppVersion: "0.1.52", AppVersionCode: "20260811", DeviceBrand: "Apple",
	OSVersion: "macOS 15.7.4", Function: "solo_work_lite",
	PluginVersion: "2.3.62834", UserAgent: "Trae/0.1.52",
}

type traeProductConfig struct {
	ID             string
	DisplayName    string
	ClientID       string
	AppID          string
	AppVersion     string
	AppVersionCode string
	DeviceBrand    string
	OSVersion      string
	Function       string
	PluginVersion  string
	UserAgent      string
}

// TraeCredential mirrors ref trae.ts (snake_case 1:1 for backup §1.5).
// machine_id/device_id are GENERATED AT LOGIN and persisted forever —
// re-generating them per-session trips risk control.
type TraeCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresAt    string `json:"expires_at,omitempty"`
	UID          string `json:"uid"`
	Nickname     string `json:"nickname,omitempty"`
	/* Masked mobile (NonPlainTextMobile, e.g. 130******00) — the only usable
	/* account disambiguator (ScreenName is auto-generated 用户+uid). */
	Phone      string `json:"phone,omitempty"`
	Email      string `json:"email,omitempty"`
	MachineID  string `json:"machine_id"`
	DeviceID   string `json:"device_id"`
	Domain     string `json:"domain,omitempty"`
	APIHost    string `json:"api_host,omitempty"`
	Enterprise string `json:"enterprise_id,omitempty"`
}

// traeCredentialExpiresAtMs parses ms/sec/ISO with JWT exp fallback.
func traeCredentialExpiresAtMs(cred *TraeCredential) int64 {
	if raw := cred.ExpiresAt; raw != "" {
		if isAllDigits(raw) {
			n := parsePositiveInt(raw)
			if n > 1_000_000_000_000 {
				return n
			}
			return n * 1000
		}
		if ms := parseISOTime(raw); ms > 0 {
			return ms
		}
	}
	return jwtExpiresAtMs(cred.AccessToken)
}

// traeSOLOHeaders builds the SOLO chat header family (Authorization /
// X-Cloudide-Token / X-Ide-Token all carry the token; missing any one is
// rejected by the upstream in practice).
func traeSOLOHeaders(cred *TraeCredential, stream bool, machineIDGeneration int) map[string]string {
	accept := "application/json"
	if stream {
		accept = "text/event-stream"
	}
	h := map[string]string{
		"Content-Type": "application/json", "Accept": accept,
		"User-Agent":           traeProduct.UserAgent,
		"Authorization":        "Cloud-IDE-JWT " + cred.AccessToken,
		"X-Cloudide-Token":     cred.AccessToken,
		"X-Ide-Token":          cred.AccessToken,
		"X-Uid":                cred.UID,
		"X-App-Id":             traeProduct.AppID,
		"X-App-Version":        "default",
		"X-Ide-Version":        traeProduct.AppVersion,
		"X-Ide-Version-Code":   traeProduct.AppVersionCode,
		"X-App-Version-Code":   traeProduct.AppVersionCode,
		"X-Ide-Version-Type":   "stable",
		"X-Device-Type":        "macos",
		"X-OS-Version":         traeProduct.OSVersion,
		"X-Device-Brand":       traeProduct.DeviceBrand,
		"Request-Traffic-Type": "prod",
	}
	if cred.MachineID != "" {
		h["X-Machine-Id"] = DeriveRotatingMachineID(cred.MachineID, machineIDGeneration)
	}
	if cred.DeviceID != "" {
		h["X-Device-Id"] = cred.DeviceID
	}
	return h
}

// traeUgHeaders builds the checkin/credits header family.
func traeUgHeaders(cred *TraeCredential, checkinDeviceGeneration int) map[string]string {
	h := map[string]string{
		"Content-Type": "application/json", "Accept": "application/json",
		"User-Agent":    traeProduct.UserAgent,
		"Authorization": "Cloud-IDE-JWT " + cred.AccessToken,
		"X-User-Region": "CN",
	}
	if cred.DeviceID != "" {
		h["X-Device-Id"] = DeriveCheckinDeviceID(cred.DeviceID, checkinDeviceGeneration)
	}
	return h
}

// traeOAuthHeaders: ExchangeToken/GetUserInfo (UA only; GetUserInfo adds
// X-Cloudide-Token at the call site).
func traeOAuthHeaders() map[string]string {
	return map[string]string{
		"Content-Type": "application/json", "Accept": "application/json",
		"User-Agent": traeProduct.UserAgent,
	}
}

// GenerateTraeMachineID / DeviceID: hex32, generated at login and persisted.
func GenerateTraeMachineID() string { return traeRandomHex32() }
func GenerateTraeDeviceID() string  { return traeRandomHex32() }

func traeRandomHex32() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		now := nowMillis()
		for i := range b {
			b[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	return hex.EncodeToString(b[:])
}

// DeriveCheckinDeviceID derives a checkin device id from (base, generation).
// Business code 9074 rate-limits by device_id, not account — bumping the
// generation yields a fresh deterministic id and unblocks the claim.
// Truncated to 32 hex chars (protocol format); generation<=0 → base verbatim.
func DeriveCheckinDeviceID(base string, generation int) string {
	if generation <= 0 {
		return base
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s#gen%d", base, generation)))
	return hex.EncodeToString(sum[:])[:32]
}

// DeriveRotatingMachineID is the opt-in machine-fingerprint rotation
// (DEFAULT OFF — device identity stability beats risk-control evasion).
func DeriveRotatingMachineID(base string, generation int) string {
	if generation <= 0 {
		return base
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s#machine%d", base, generation)))
	return hex.EncodeToString(sum[:])[:32]
}

// seededStream is the SHA-256 deterministic pseudo-random stream (ref
// device_map.rs): SHA256(utf8(salt:seed) ++ counterBE32) chained to n bytes.
func traeSeededStream(seed, salt string, n int) []byte {
	prefix := salt + ":" + seed
	var out []byte
	counter := 0
	for len(out) < n {
		counterBuf := []byte{
			byte(counter >> 24), byte(counter >> 16), byte(counter >> 8), byte(counter),
		}
		sum := sha256.Sum256(append([]byte(prefix), counterBuf...))
		out = append(out, sum[:]...)
		if len(out) >= n {
			out = out[:n]
		}
		counter++
	}
	return out
}

// traeSeededDigits derives an n-digit deterministic number string.
func traeSeededDigits(n int, seed, salt string) string {
	bs := traeSeededStream(seed, salt, n)
	var b strings.Builder
	for _, x := range bs {
		b.WriteByte('0' + x%10)
	}
	return b.String()
}

// traeSeededUUID derives a deterministic UUID v4 form from user_id.
func traeSeededUUID(seed, salt string) string {
	bs := traeSeededStream(seed, salt, 16)
	bs[6] = (bs[6] & 0x0F) | 0x40 // version 4
	bs[8] = (bs[8] & 0x3F) | 0x80 // variant RFC 4122
	hs := hex.EncodeToString(bs)
	return hs[0:8] + "-" + hs[8:12] + "-" + hs[12:16] + "-" + hs[16:20] + "-" + hs[20:32]
}

// traeSeededHex32 derives a deterministic 64-hex session id.
func traeSeededHex64(seed, salt string) string {
	bs := traeSeededStream(seed, salt, 32)
	return hex.EncodeToString(bs)
}

// TraeMachineTraceID = last 16 chars of machineId+deviceId concat
// (Go callback.go:55-63).
func TraeMachineTraceID(machineID, deviceID string) string {
	s := machineID + deviceID
	if len(s) <= 16 {
		return s
	}
	return s[len(s)-16:]
}
