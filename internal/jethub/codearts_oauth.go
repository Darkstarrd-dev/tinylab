package jethub

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"time"
)

// CodeArts OAuth constants (1:1 from ref src/oauth.ts).
const (
	// CodeArtsClientID is the CodeArts Agent OAuth client_id (its URI scheme).
	CodeArtsClientID = "codearts-agent"
	// CodeArtsRedirectPath is the local callback path.
	CodeArtsRedirectPath = "/oauth/callback"
	// CodeArtsPortalAuthorizeBase is the new-style IAM OAuth portal endpoint.
	CodeArtsPortalAuthorizeBase = "https://codearts.huaweicloud.com/portal/authorize"
	// CodeArtsPortalLoginBase is the portal login result page.
	CodeArtsPortalLoginBase = "https://codearts.huaweicloud.com/portal/login"
	// CodeArtsPortalLoginPluginName / Version are reverse-engineered constants
	// the portal expects (they are NOT the plugin's own version).
	CodeArtsPortalLoginPluginName    = "snap_AIIDE"
	CodeArtsPortalLoginPluginVersion = "5.2.0"
	// Grant types.
	GrantAuthorizationCode = "authorization_code"
	GrantRefreshToken      = "refresh_token"
)

// codeartsSTSURL is the Huawei STS token endpoint. Var (not const) so tests
// can point it at a mock server via setSTSURL.
var codeartsSTSURL = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens"

// setSTSURL overrides the STS endpoint (test hook).
func setSTSURL(u string) { codeartsSTSURL = u }

// DpopPublicJwk is a DPoP ES256 public JWK (no private material).
type DpopPublicJwk struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

// DpopPrivateJwk additionally carries the private scalar d (persisted with
// the credential, §1.5 CodeArtsCredential.dpop_private_key_jwk).
type DpopPrivateJwk struct {
	DpopPublicJwk
	D string `json:"d"`
}

// PkcePair is a verifier + S256 challenge pair.
type PkcePair struct {
	CodeVerifier  string `json:"codeVerifier"`
	CodeChallenge string `json:"codeChallenge"`
}

// GeneratePkcePair returns a PKCE pair: verifier = 48 random bytes base64url,
// challenge = SHA-256(verifier) base64url (identical to the plugin).
func GeneratePkcePair() (PkcePair, error) {
	raw := make([]byte, 48)
	if _, err := rand.Read(raw); err != nil {
		return PkcePair{}, fmt.Errorf("jethub: pkce rand: %w", err)
	}
	verifier := base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(verifier))
	return PkcePair{
		CodeVerifier:  verifier,
		CodeChallenge: base64.RawURLEncoding.EncodeToString(sum[:]),
	}, nil
}

// GenerateDpopKeyPair creates an ES256 (P-256) key pair in JWK form.
func GenerateDpopKeyPair() (DpopPrivateJwk, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return DpopPrivateJwk{}, fmt.Errorf("jethub: dpop keygen: %w", err)
	}
	return dpopJwkFromKey(key), nil
}

func dpopJwkFromKey(key *ecdsa.PrivateKey) DpopPrivateJwk {
	return DpopPrivateJwk{
		DpopPublicJwk: DpopPublicJwk{
			Kty: "EC",
			Crv: "P-256",
			X:   base64.RawURLEncoding.EncodeToString(key.PublicKey.X.Bytes()),
			Y:   base64.RawURLEncoding.EncodeToString(key.PublicKey.Y.Bytes()),
		},
		D: base64.RawURLEncoding.EncodeToString(key.D.Bytes()),
	}
}

// KeyPairFromStoredJwk restores the ECDSA key from a persisted private JWK
// (the public part is rebuilt from x/y — identical to the plugin's
// keyPairFromStoredJwk).
func KeyPairFromStoredJwk(jwk DpopPrivateJwk) (*ecdsa.PrivateKey, error) {
	if jwk.Kty != "EC" || jwk.Crv != "P-256" {
		return nil, errors.New("jethub: unsupported dpop jwk (want EC P-256)")
	}
	x, err := base64.RawURLEncoding.DecodeString(jwk.X)
	if err != nil {
		return nil, fmt.Errorf("jethub: dpop jwk x: %w", err)
	}
	y, err := base64.RawURLEncoding.DecodeString(jwk.Y)
	if err != nil {
		return nil, fmt.Errorf("jethub: dpop jwk y: %w", err)
	}
	d, err := base64.RawURLEncoding.DecodeString(jwk.D)
	if err != nil {
		return nil, fmt.Errorf("jethub: dpop jwk d: %w", err)
	}
	pub := ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
	priv := &ecdsa.PrivateKey{PublicKey: pub, D: new(big.Int).SetBytes(d)}
	return priv, nil
}

// SignDpopJws signs a dpop+jwt JWS with the ES256 private key. Claims are
// htm/htu/iat/jti; the protected header carries alg/typ/jwk (public part).
func SignDpopJws(priv *ecdsa.PrivateKey, htm, htu string) (string, error) {
	if priv == nil {
		return "", errors.New("jethub: nil dpop key")
	}
	now := time.Now().Unix()
	jtiRaw := make([]byte, 32)
	if _, err := rand.Read(jtiRaw); err != nil {
		return "", fmt.Errorf("jethub: jti rand: %w", err)
	}
	jti := make([]byte, len(jtiRaw)*2)
	const hexDigits = "0123456789abcdef"
	for i, b := range jtiRaw {
		jti[i*2] = hexDigits[b>>4]
		jti[i*2+1] = hexDigits[b&0x0f]
	}
	header := map[string]any{
		"alg": "ES256",
		"typ": "dpop+jwt",
		"jwk": DpopPublicJwk{Kty: "EC", Crv: "P-256",
			X: base64.RawURLEncoding.EncodeToString(priv.PublicKey.X.Bytes()),
			Y: base64.RawURLEncoding.EncodeToString(priv.PublicKey.Y.Bytes())},
	}
	payload := map[string]any{
		"htm": htm,
		"htu": htu,
		"iat": now,
		"jti": string(jti),
	}
	hb, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	pb, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(pb)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		return "", fmt.Errorf("jethub: dpop sign: %w", err)
	}
	// JWS ES256 signature = raw r||s, each padded to the curve size (32 bytes).
	sig := make([]byte, 64)
	rBytes := r.Bytes()
	sBytes := s.Bytes()
	copy(sig[32-len(rBytes):32], rBytes)
	copy(sig[64-len(sBytes):64], sBytes)
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// CodeArtsCredential mirrors ref src/types.ts CodeArtsCredential field-for-
// field (backup compatibility §1.5 requires the exact names).
type CodeArtsCredential struct {
	AccessKeyID     string          `json:"access_key_id"`
	SecretAccessKey string          `json:"secret_access_key"`
	SecurityToken   string          `json:"security_token"`
	ExpiresAt       string          `json:"expires_at"`
	DomainID        string          `json:"domain_id,omitempty"`
	UserID          string          `json:"user_id,omitempty"`
	UserName        string          `json:"user_name,omitempty"`
	RefreshToken    string          `json:"refresh_token,omitempty"`
	CodeVerifier    string          `json:"code_verifier,omitempty"`
	DpopPrivateJwk  *DpopPrivateJwk `json:"dpop_private_key_jwk,omitempty"`
	// ModelRateLimits is framework-attached runtime metadata preserved across
	// refreshes (same field as the plugin).
	ModelRateLimits map[string]any  `json:"model_rate_limits,omitempty"`
}

// CodeArtsTokenResponse is /v1/oauth2/tokens response (subset used).
type CodeArtsTokenResponse struct {
	Credentials *struct {
		AccessKeyID   string `json:"access_key_id"`
		SecretAccessKey string `json:"secret_access_key"`
		SecurityToken string `json:"security_token"`
		Expiration    string `json:"expiration"`
	} `json:"credentials"`
	RefreshToken string `json:"refresh_token"`
	Error        string `json:"error"`
	ErrorCode    string `json:"error_code"`
	ErrorMsg     string `json:"error_msg"`
}

// ErrRefreshTokenExpired marks terminal refresh failure (invalid_grant /
// ExpiredRefreshToken / InvalidDPoPHeader) — the scheduler stops renewing.
var ErrRefreshTokenExpired = errors.New("jethub: refresh token expired")

// ClassifyTokenError maps a token endpoint failure to the terminal
// RefreshTokenExpired error or a transient error (decision from ref oauth.ts).
func ClassifyTokenError(resp *CodeArtsTokenResponse) error {
	if resp == nil {
		return errors.New("jethub: token request failed")
	}
	msg := fmt.Sprintf("jethub: token request failed: %s %s", resp.Error, resp.ErrorCode)
	if resp.Error == "invalid_grant" ||
		contains(resp.ErrorCode, "ExpiredRefreshToken") ||
		contains(resp.ErrorCode, "InvalidDPoPHeader") {
		return ErrRefreshTokenExpired
	}
	return errors.New(msg)
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && indexOfStr(s, sub) >= 0
}

// init registers the codearts key extractor.
//
// ⚠️ **真实缺陷（用户实测「codearts agent 可添加，但按 prefix 取不到模型、无法
// 调用」）**：CodeArts 凭据是 SDK-HMAC 的 `access_key_id`/`secret_access_key`/
// `security_token`，**根本没有 `access_token` 字段**，于是通用提取器返回空串 →
// `Bridge.SyncKeys` 跳过该账号 → 可用 Key 数为 0 → **桥接 provider 被整个移除**
// （前缀还存着，但 registry 里没有对应 provider：模型列表看不到、`{prefix}/{model}`
// 也无从路由）。其它 10 个 provider 的凭据都自带 `access_token`（或已注册专属
// 提取器），只有 codearts 是“无令牌”的签名型凭据。
//
// 这里用 `security_token`（临时凭据，本质就是令牌；退一步用 access_key_id）。
// ⚠️ 它**不参与出站鉴权**：codearts 的 augmenter 用 ak/sk 重新签名并覆盖全部出站
// 头，`Key.Key` 只用于轮询选号、用量归属与日志遮蔽。
func init() {
	RegisterTokenExtractor("codearts", func(cred jsonRaw) (string, error) {
		var c CodeArtsCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", errors.New("jethub: parse codearts credential: " + err.Error())
		}
		if c.SecurityToken != "" {
			return c.SecurityToken, nil
		}
		if c.AccessKeyID != "" {
			return c.AccessKeyID, nil
		}
		// 兜底：非真实形状的凭据（手写/旧夹具）若带 access_token 则用它。让账号
		// 仍被桥接，由 augmenter 报「凭据不完整（需重新登录）」这种**明确**错误，
		// 而不是静默把 provider 从 registry 摘掉（那正是本缺陷的症状）。
		var generic struct {
			AccessToken string `json:"access_token"`
		}
		_ = jsonUnmarshal(cred, &generic)
		return generic.AccessToken, nil
	})
}

func indexOfStr(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// CredentialFromTokenResponse assembles the persisted credential JSON
// (identical semantics to the plugin's credentialFromTokenResponse). The
// privateJwk parameter is the freshly generated (or persisted) DPoP key.
func CredentialFromTokenResponse(token *CodeArtsTokenResponse, pkce PkcePair, privateJwk *DpopPrivateJwk) *CodeArtsCredential {
	cred := &CodeArtsCredential{CodeVerifier: pkce.CodeVerifier}
	if token != nil {
		if token.Credentials != nil {
			cred.AccessKeyID = token.Credentials.AccessKeyID
			cred.SecretAccessKey = token.Credentials.SecretAccessKey
			cred.SecurityToken = token.Credentials.SecurityToken
			cred.ExpiresAt = token.Credentials.Expiration
		}
		cred.RefreshToken = token.RefreshToken
	}
	cred.DpopPrivateJwk = privateJwk
	return cred
}
