package jethub

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Qoder protocol constants — 1:1 from ref qoder.ts / qoder-oauth.ts /
// qoder-product.ts. Distinctive: PKCE device-code polling (NO local port),
// renewal body needs machine_id, encrypted inference via embedded WASM.
const (
	qoderDeviceSelectPath = "/device/selectAccounts" // authBase
	qoderPollPath         = "/api/v1/deviceToken/poll" // openApiBase
	qoderRefreshPath      = "/api/v1/deviceToken/refresh" // openApiBase
	qoderUserinfoPath     = "/api/v1/userinfo" // openApiBase
	qoderPublicChatPath   = "/model/v1/chat/completions" // inferBase (公开端点)
	qoderEncryptedChatPath = "/algo/api/v2/service/pro/sse/agent_chat_generation" // encryptedInferBase

	qoderLoginTimeout    = 5 * timeMinute
	qoderPollInterval    = timeSecond
	qoderPollMaxFailures = 5
	// qoderOAuthTimeout: server error prefix for deterministic errors.
	qoderServerErrorPrefix = "登录服务返回异常"
)

// qoderClientMetadata is the CLI identity for the infer envelope (vs the
// '10' sash identity — TWO different identities, never merge).
var qoderClientMetadata = map[string]string{
	"client_type": "5", "business_product": "cli",
	"business_type": "agent", "scene": "assistant",
}

// randIntn returns a non-negative random int < n.
func randIntn(n int) int {
	if n <= 1 {
		return 0
	}
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		now := time.Now().UnixNano()
		return int(now % int64(n))
	}
	v := uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
	return int(v % uint32(n))
}

// qoderProductConfig is one Qoder product's differential config.
type qoderProductConfig struct {
	ID                string
	DisplayName       string
	AuthBase          string
	OpenAPIBase       string
	InferBase         string
	EncryptedInferBase string
	ClientID          string
	UserAgentPrefix   string
	SashClientType    string
}

// qoderProducts: two products, same protocol family (shared implementation —
// never fork the files; the AGENTS.md rule is "新增同族产品不要复制实现文件").
var qoderProducts = map[string]*qoderProductConfig{
	"qoder": {
		ID: "qoder", DisplayName: "Qoder",
		AuthBase: "https://qoder.com", OpenAPIBase: "https://openapi.qoder.sh",
		// ⚠️ inferBase ≠ encryptedInferBase hosts! (api2-v2 vs api2 — mixing 404s.)
		InferBase: "https://api2-v2.qoder.sh", EncryptedInferBase: "https://api2.qoder.sh",
		ClientID: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb", // = J_a (prod; G_a is test-only)
		UserAgentPrefix: "qoder", SashClientType: "10",
	},
	"qodercn": {
		ID: "qodercn", DisplayName: "Qoder (中国版)",
		AuthBase: "https://qoder.cn", OpenAPIBase: "https://openapi.qoder.com.cn",
		// ⚠️ CN has NO public OpenAI endpoint (503s) — inferBase is a
		// dead-config marker equal to encryptedInferBase; never request it.
		InferBase: "https://gateway.qoder.com.cn", EncryptedInferBase: "https://gateway.qoder.com.cn",
		ClientID: "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa", // CN asar Vpe.authClientIds.prod
		UserAgentPrefix: "qoder", SashClientType: "10",
	},
}

// qoderPKCEAlphabet is the RFC 7636 unreserved set (66 chars).
const qoderPKCEAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

// QoderCredential mirrors ref qoder.ts. security_oauth_token and access_token
// are WRITTEN TWICE with the same value (the client reads
// security_oauth_token ?? access_token — dual-write covers both paths).
// machine_id is plugin-generated + persisted (renewal body needs it).
type QoderCredential struct {
	SecurityOauthToken string `json:"security_oauth_token"`
	AccessToken        string `json:"access_token"`
	RefreshToken       string `json:"refresh_token,omitempty"`
	ExpireTime         int64  `json:"expire_time,omitempty"` // ms
	RefreshExpireTime  int64  `json:"refresh_token_expire_time,omitempty"`
	MachineID          string `json:"machine_id"`
	// UID is REQUIRED for encrypted inference (generate_runtime_auth_fields
	// derives from it; missing → hangs or fails).
	UID      string `json:"uid,omitempty"`
	Nickname string `json:"nickname,omitempty"`
}

// qoderTokenPayload is the normalized poll/refresh payload (login uses
// `token`, renewal uses `device_token` — both accepted).
type qoderTokenPayload struct {
	AccessToken          string
	RefreshToken         string
	ExpiresAt            int64
	RefreshTokenExpireAt int64
	UID                  string
	UserName             string
}

// readQoderTimestamp: ISO or seconds/ms numbers; NEVER 0 (unknown ≠ 1970).
func readQoderTimestamp(value any) int64 {
	if f, ok := value.(float64); ok && f > 0 {
		if f < 1e12 {
			return int64(f) * 1000
		}
		return int64(f)
	}
	if s, ok := value.(string); ok && s != "" {
		return parseISOTime(s)
	}
	return 0
}

// parseQoderTokenPayload: garbage input → empty accessToken (caller judges).
func parseQoderTokenPayload(value map[string]any) *qoderTokenPayload {
	if value == nil {
		return &qoderTokenPayload{}
	}
	readStr := func(keys ...string) string {
		for _, k := range keys {
			if s, ok := value[k].(string); ok && s != "" {
				return s
			}
		}
		return ""
	}
	return &qoderTokenPayload{
		AccessToken:          readStr("token", "device_token", "access_token"),
		RefreshToken:         readStr("refresh_token", "refreshToken"),
		ExpiresAt:            readQoderTimestamp(firstOf(value["expires_at"], value["expiresAt"])),
		RefreshTokenExpireAt: readQoderTimestamp(firstOf(value["refresh_token_expires_at"], value["refreshTokenExpiresAt"])),
		// ⚠️ user_id/user_name are REQUIRED for encrypted inference (missing
		// them historically forced the public endpoint — a real defect).
		UID:      readStr("user_id", "userId"),
		UserName: readStr("user_name", "userName"),
	}
}

// BuildQoderCredential assembles the persisted credential. Nickname prefers
// the explicit userinfo value over the device-response user_name (the poll
// response reliably LACKS user_name — verified across 4 accounts; the ONLY
// reliable source is a follow-up userinfo call).
func BuildQoderCredential(payload *qoderTokenPayload, machineID, nickname string) *QoderCredential {
	if payload == nil {
		return nil
	}
	display := firstNonEmpty(nickname, payload.UserName)
	cred := &QoderCredential{
		SecurityOauthToken: payload.AccessToken,
		AccessToken:        payload.AccessToken,
		RefreshToken:       payload.RefreshToken,
		ExpireTime:         payload.ExpiresAt,
		RefreshExpireTime:  payload.RefreshTokenExpireAt,
		MachineID:          machineID,
		UID:                payload.UID,
		Nickname:           display,
	}
	return cred
}

// QoderExpiresAtMs: 0 = unknown (never judged expired on unknown).
func QoderExpiresAtMs(cred *QoderCredential) int64 { return cred.ExpireTime }

// QoderRefreshable: refresh_token present (regardless of expiry).
func QoderRefreshable(cred *QoderCredential) bool { return cred.RefreshToken != "" }

// qoderRefreshBody: only refresh_token + machine_id (the machine_token field
// comes from the UMID subsystem we do not have).
func QoderRefreshBody(cred *QoderCredential) string {
	data, _ := json.Marshal(map[string]string{
		"refresh_token": cred.RefreshToken, "machine_id": cred.MachineID,
	})
	return string(data)
}

// QoderBearerToken: security_oauth_token first (source a6e() order).
func QoderBearerToken(cred *QoderCredential) string {
	return firstNonEmpty(cred.SecurityOauthToken, cred.AccessToken)
}

// applyQoderRefresh merges the renewal payload. ⚠️ machine_id/uid/nickname
// are KEPT (absent from renewal responses; losing uid breaks encrypted
// inference; losing refresh_token turns a renewable credential dead).
func applyQoderRefresh(previous *QoderCredential, payload *qoderTokenPayload) *QoderCredential {
	next := BuildQoderCredential(payload, previous.MachineID, previous.Nickname)
	if next.RefreshToken == "" {
		next.RefreshToken = previous.RefreshToken
	}
	if next.UID == "" {
		next.UID = previous.UID
	}
	return next
}

// CreateQoderPKCE: verifier 43..128 chars from the RFC unreserved set;
// challenge = base64url(sha256(verifier)) WITHOUT padding (padding fails
// server validation).
func CreateQoderPKCE() (verifier, challenge string, err error) {
	length := 43 + randIntn(86)
	raw := make([]byte, length)
	if _, err := rand.Read(raw); err != nil {
		return "", "", fmt.Errorf("jethub: qoder pkce rand: %w", err)
	}
	var b strings.Builder
	for _, x := range raw {
		b.WriteByte(qoderPKCEAlphabet[int(x)%len(qoderPKCEAlphabet)])
	}
	verifier = b.String()
	sum := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(sum[:])
	return verifier, challenge, nil
}

// qoderDeviceSession is one login session.
type qoderDeviceSession struct {
	Verifier  string
	Challenge string
	Nonce     string
	MachineID string
}

func createQoderDeviceSession(machineID string) *qoderDeviceSession {
	verifier, challenge, _ := CreateQoderPKCE()
	return &qoderDeviceSession{
		Verifier: verifier, Challenge: challenge,
		Nonce: lobsteraiRandomID(), MachineID: machineID,
	}
}

// BuildQoderAuthURL: `{authBase}/device/selectAccounts?challenge&method&nonce&machine_id&client_id`.
// ⚠️ client_id = product.ClientID (= J_a, prod) — using G_a makes the
// authorization callback fail with 参数无效 (the 2026-09-30 misread).
func BuildQoderAuthURL(session *qoderDeviceSession, p *qoderProductConfig) string {
	return p.AuthBase + qoderDeviceSelectPath + "?" + urlValues{
		"challenge": session.Challenge, "challenge_method": "S256",
		"nonce": session.Nonce, "machine_id": session.MachineID,
		"client_id": p.ClientID,
	}.encode()
}

// BuildQoderPollURL: ⚠️ hangs off openApiBase (NOT authBase — qoder.com's
// same path returns 401; openapi returns 404 = "not ready yet").
func BuildQoderPollURL(session *qoderDeviceSession, p *qoderProductConfig) string {
	return p.OpenAPIBase + qoderPollPath + "?" + urlValues{
		"nonce": session.Nonce, "verifier": session.Verifier,
		"challenge_method": "S256",
	}.encode()
}

// PollQoderDeviceToken polls until tokens arrive. ⚠️ 404 means "user has not
// authorized yet" — KEEP POLLING (the endpoint is auth-exempt; a nonexistent
// path returns 401, so 404 is the business-layer not-ready signal). Network
// failures tolerate qoderPollMaxFailures consecutive; other non-2xx (5xx) is
// a server fault, not "waiting".
func (m *Manager) PollQoderDeviceToken(ctx context.Context, provider string, session *qoderDeviceSession, p *qoderProductConfig) (*qoderTokenPayload, error) {
	pollURL := BuildQoderPollURL(session, p)
	deadline := nowMillis() + int64(qoderLoginTimeout)
	failures := 0
	for nowMillis() < deadline {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timeAfter(timeSecond):
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "application/json")
		resp, err := m.httpClient(provider).Do(req)
		if err != nil {
			failures++
			if failures >= qoderPollMaxFailures {
				return nil, fmt.Errorf("无法连接 Qoder 登录服务（连续 %d 次失败）：%v", failures, err)
			}
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		failures = 0
		if resp.StatusCode == http.StatusNotFound {
			continue // ⚠️ not-ready ≠ error
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("%s（HTTP %d）", qoderServerErrorPrefix, resp.StatusCode)
		}
		var payload map[string]any
		_ = json.Unmarshal(raw, &payload)
		parsed := parseQoderTokenPayload(payload)
		if parsed.AccessToken != "" {
			return parsed, nil
		}
		// 2xx but no token yet → keep polling.
	}
	return nil, fmt.Errorf("登录等待已超时，请重新发起登录")
}

// FetchQoderUserNickname: GET /api/v1/userinfo `name` — the ONLY reliable
// nickname source (device-code responses never carry user_name; 4 accounts
// verified). Failure → "" (never fails the login; caller falls back to the
// account id).
func (m *Manager) FetchQoderUserNickname(ctx context.Context, cred *QoderCredential) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		qoderProducts["qoder"].OpenAPIBase+qoderUserinfoPath, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+QoderBearerToken(cred))
	resp, err := m.httpClient("qoder").Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		return ""
	}
	return strings.TrimSpace(jsonStringField(body, "name"))
}

// QoderRandomMachineID generates the plugin-persisted random machine id
// (NOT a hardware fingerprint — the plugin cannot spawn the client's
// runtime-info; a stable random UUID per account is what the client needs).
func QoderRandomMachineID() string { return qoderRandomID() }

// init registers the qoder token extractors (both products share it).
func init() {
	extractor := func(provider string) tokenExtractor {
		return func(cred jsonRaw) (string, error) {
			var c QoderCredential
			if err := jsonUnmarshal(cred, &c); err != nil {
				return "", fmt.Errorf("jethub: parse %s credential: %w", provider, err)
			}
			return QoderBearerToken(&c), nil
		}
	}
	RegisterTokenExtractor("qoder", extractor("qoder"))
	RegisterTokenExtractor("qodercn", extractor("qodercn"))
}
