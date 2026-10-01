package jethub

import (
	"fmt"
	"strings"
	"time"
)

// Buddy (CodeBuddy/WorkBuddy) product configuration — 1:1 from ref
// src/product.ts. The two products share one protocol; everything differs
// through the product config (endpoint / platform / UA / attribution).
const (
	// Buddy header family (ref buddy.ts HTTP_HEADER_*).
	buddyHeaderDomain          = "X-Domain"
	buddyHeaderEnterpriseID    = "X-Enterprise-Id"
	buddyHeaderTenantID        = "X-Tenant-Id"
	buddyHeaderNoAuthorization = "X-No-Authorization"
	buddyHeaderNoUserID        = "X-No-User-Id"
	buddyHeaderNoEnterpriseID  = "X-No-Enterprise-Id"
	buddyHeaderNoDeptInfo      = "X-No-Department-Info"
	buddyHeaderRefreshToken    = "X-Refresh-Token"
	buddyHeaderRefreshSource   = "X-Auth-Refresh-Source"
	buddyHeaderProduct         = "X-Product"
	buddyHeaderProductCode     = "X-Product-Code"

	buddyAuthStatePath   = "/v2/plugin/auth/state"
	buddyAuthTokenPath   = "/v2/plugin/auth/token"
	buddyLoginAccPath    = "/v2/plugin/login/account"
	buddyAuthRefreshPath = "/v2/plugin/auth/token/refresh"
	buddyConfigPath      = "/v3/config"
	buddyChatPath        = "/v2/chat/completions"
	// scoped enterprise models endpoint (personal scope for individual accounts)
	buddyScopedModelsPath = "/console/enterprises/personal/models"

	buddyLoginTimeout     = 5 * timeMinute
	buddyPollInterval     = timeSecond
	buddyStateReqTimeout  = 10 * timeSecond
	buddyRequestTimeout   = 60 * timeSecond
	buddyAuthRefreshSrc   = "ide-main"
	buddyDeploymentType   = "SaaS"
	codeTokenNotReadyCode = 11217
	codeAcctNotReadyCode  = 12151
)

// timeMinute etc. keep the constant block above tidy.
const (
	timeSecond = time.Second
	timeMinute = time.Minute
)

// BuddyProduct is one CodeBuddy-family product's differential config.
type BuddyProduct struct {
	ID              string // "buddy" | "workbuddy"
	Platform        string
	Endpoint        string
	APIDomain       string
	DisplayName     string
	ProductCode     string
	UserAgent       string
	AttributionName string
	ClientVersion   string
	CLIVersion      string
	CredPrefix      string // credential ref prefix: BUDDY_ / WORKBUDDY_
	AppendSession   bool
	PluginVersion   string
	// UA rules by model family (international version splits CN/Intl models).
	UAByModelFamily []buddyUARule
}

type buddyUARule struct {
	Match string
	UA    string
}

// WorkBuddy UA forms (ref product.ts).
const (
	workbuddyUAIntl = "WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2"
	workbuddyUACN   = "WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2"
)

// buddyProductsMap is the registry of CodeBuddy-family products (var so
// tests can point endpoints at mock servers).
var buddyProductsMap = map[string]*BuddyProduct{
	"buddy": {
		ID: "buddy", Platform: "ide",
		Endpoint: "https://copilot.tencent.com", APIDomain: "copilot.tencent.com",
		DisplayName: "CodeBuddy", ProductCode: "codebuddy",
		UserAgent: "CodeBuddyIDE/1.106.1", AttributionName: "CodeBuddy",
		ClientVersion: "1.106.1", CLIVersion: "2.137.1",
		CredPrefix: "BUDDY", AppendSession: false,
	},
	"workbuddy": {
		ID: "workbuddy", Platform: "workbuddy-ai",
		Endpoint: "https://www.workbuddy.ai", APIDomain: "www.workbuddy.ai",
		DisplayName: "WorkBuddy", ProductCode: "workbuddy",
		UserAgent: workbuddyUAIntl, AttributionName: "WorkBuddy",
		ClientVersion: "5.5.2", CLIVersion: "5.5.2",
		CredPrefix: "WORKBUDDY", AppendSession: true, PluginVersion: "5.5.2",
		UAByModelFamily: []buddyUARule{
			{"gpt-", workbuddyUAIntl}, {"gemini-", workbuddyUAIntl}, {"claude-", workbuddyUAIntl},
			{"glm-", workbuddyUACN}, {"hy", workbuddyUACN}, {"kimi-", workbuddyUACN}, {"minimax-", workbuddyUACN},
		},
	},
}

// BuddyProducts returns the two CodeBuddy-family products.
func BuddyProducts() map[string]*BuddyProduct { return buddyProductsMap }

// resolveBuddyUserAgent applies the per-model-family UA rules (first match
// wins; fallback to product default).
func resolveBuddyUserAgent(p *BuddyProduct, model string) string {
	for _, rule := range p.UAByModelFamily {
		if strings.HasPrefix(model, rule.Match) {
			return rule.UA
		}
	}
	return p.UserAgent
}

// BuddyCredential mirrors ref buddy.ts BuddyCredential (JSON field names are
// the backup-compat contract §1.5).
type BuddyCredential struct {
	AccessToken     string `json:"access_token"`
	RefreshToken    string `json:"refresh_token"`
	ExpiresAt       string `json:"expires_at,omitempty"`
	RefreshExpireAt string `json:"refresh_expires_at,omitempty"`
	TokenType       string `json:"token_type,omitempty"`
	Scope           string `json:"scope,omitempty"`
	Domain          string `json:"domain,omitempty"`
	UserID          string `json:"user_id,omitempty"`
	Nickname        string `json:"nickname,omitempty"`
	EnterpriseID    string `json:"enterprise_id,omitempty"`
	AccountType     string `json:"account_type,omitempty"`
}

// buddyTokenExpiryMs parses expires_at (ms timestamp / sec timestamp / ISO)
// with a JWT exp fallback; 0 when unknown.
func buddyTokenExpiryMs(cred *BuddyCredential) int64 {
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

// jwtExpiresAtMs / jwtIssuedAtMs / jwtNickname / jwtSubject read claims from
// an access token without verification (display + scheduling only).
func jwtExpiresAtMs(token string) int64 { return jwtClaimMs(token, "exp") }
func jwtIssuedAtMs(token string) int64  { return jwtClaimMs(token, "iat") }
func jwtNickname(token string) string {
	for _, key := range []string{"nickname", "preferred_username", "name"} {
		if v := jwtClaimString(token, key); v != "" {
			return v
		}
	}
	return ""
}

func jwtSubject(token string) string { return jwtClaimString(token, "sub") }

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func parsePositiveInt(s string) int64 {
	var n int64
	for _, c := range s {
		n = n*10 + int64(c-'0')
		if n > 1<<62 {
			return 0
		}
	}
	return n
}

// buddyGenericToken extracts the bearer token for bridge Keys. Buddy keys ARE
// the access_token, so the generic extractor suffices — but register it
// explicitly for clarity.
func init() {
	RegisterTokenExtractor("buddy", func(cred jsonRaw) (string, error) {
		var c BuddyCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", fmt.Errorf("jethub: parse buddy credential: %w", err)
		}
		return c.AccessToken, nil
	})
	RegisterTokenExtractor("workbuddy", func(cred jsonRaw) (string, error) {
		var c BuddyCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", fmt.Errorf("jethub: parse workbuddy credential: %w", err)
		}
		return c.AccessToken, nil
	})
}
