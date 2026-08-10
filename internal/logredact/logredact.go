// Package logredact provides the shared credential masking rules used by
// request traces, monitor entries, probe results, and console request tags.
package logredact

import (
	"net/http"
	"net/url"
	"strings"
)

// MaskedValue is the fixed replacement used for credential values.
const MaskedValue = "******"

var keyHeaders = map[string]struct{}{
	"authorization":        {},
	"proxy-authorization":  {},
	"x-api-key":            {},
	"api-key":              {},
	"x-auth-token":         {},
	"x-access-token":       {},
	"x-token":              {},
	"token":                {},
	"x-goog-api-key":       {},
	"x-rapidapi-key":       {},
	"x-amz-security-token": {},
	"x-amz-credential":     {},
	"x-claude-api-key":     {},
	"anthropic-api-key":    {},
}

var keyQueryParams = map[string]struct{}{
	"key":          {},
	"apikey":       {},
	"api_key":      {},
	"token":        {},
	"access_token": {},
	"auth":         {},
	"secret":       {},
	"password":     {},
	"signature":    {},
	"sig":          {},
}

// IsKeyHeader reports whether name conventionally carries an API credential.
func IsKeyHeader(name string) bool {
	_, ok := keyHeaders[strings.ToLower(strings.TrimSpace(name))]
	return ok
}

// MaskString replaces the supplied credential in value while preserving every
// other byte of the value.
func MaskString(value, credential string) string {
	if value == "" || credential == "" {
		return value
	}
	masked := strings.ReplaceAll(value, credential, MaskedValue)
	if escaped := url.QueryEscape(credential); escaped != credential {
		masked = strings.ReplaceAll(masked, escaped, MaskedValue)
	}
	if escaped := url.PathEscape(credential); escaped != credential {
		masked = strings.ReplaceAll(masked, escaped, MaskedValue)
	}
	return masked
}

// maskHeaderValue masks a key-bearing header while preserving an auth scheme.
func maskHeaderValue(name, value, key string) string {
	masked := MaskString(value, key)
	if masked != value {
		return masked
	}
	if !IsKeyHeader(name) {
		return value
	}
	if idx := strings.IndexAny(value, " \t"); idx > 0 {
		return value[:idx+1] + MaskedValue
	}
	return MaskedValue
}

// MaskHeaderMap returns a copy of headers with credential values masked.
func MaskHeaderMap(headers map[string][]string, key string) map[string][]string {
	if headers == nil {
		return nil
	}
	out := make(map[string][]string, len(headers))
	for name, values := range headers {
		masked := make([]string, len(values))
		for i, value := range values {
			masked[i] = maskHeaderValue(name, value, key)
		}
		out[name] = masked
	}
	return out
}

// MaskHTTPHeaders returns a copy of an HTTP header map with credential values
// masked.
func MaskHTTPHeaders(headers http.Header, key string) http.Header {
	if headers == nil {
		return nil
	}
	return http.Header(MaskHeaderMap(headers, key))
}

// MaskURL preserves the URL while masking credential-bearing userinfo and
// query values. When key is known, only that key is replaced in ordinary URL
// values; when it is unavailable, conventional credential query names are
// masked as a read-time fallback for legacy trace files.
func MaskURL(raw, key string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return MaskString(raw, key)
	}
	if u.User != nil {
		username := u.User.Username()
		if password, ok := u.User.Password(); ok {
			if key == "" || password == key || strings.Contains(password, MaskedValue) {
				u.User = url.UserPassword(username, MaskedValue)
			}
		}
	}
	q := u.Query()
	for name, values := range q {
		for i, value := range values {
			masked := MaskString(value, key)
			if masked == value {
				if _, ok := keyQueryParams[strings.ToLower(name)]; ok && key == "" {
					masked = MaskedValue
				}
			}
			values[i] = masked
		}
		q[name] = values
	}
	u.RawQuery = q.Encode()
	result := MaskString(u.String(), key)
	result = strings.ReplaceAll(result, "%2A", "*")
	return strings.ReplaceAll(result, "%2a", "*")
}
