package jethub

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
)

// SDK-HMAC-SHA256 request signing for Huawei Cloud (1:1 port of ref
// src/sign.ts signRequestHuawei). Used by CodeArts inference (P2.4 augment),
// queue status probing and credits endpoints (P2.6 claim).
//
// Contract notes preserved from the reference implementation:
//   - the canonical URI always ends with "/";
//   - x-sdk-date is the UTC timestamp compact form;
//   - x-sdk-content-sha256 signs the body hash;
//   - extra headers (e.g. maas_type: benefit) MUST participate in the
//     canonical computation and be sent verbatim — dropping them fails
//     server-side verification;
//   - the "host" header is signed but must be recomputed by the transport, so
//     SignHuaweiRequest does not emit it (callers rely on the actual dial);
//     the TS implementation sets host and callers skip it when applying.
func SignHuaweiRequest(ak, sk, securityToken, method, rawURL string, body []byte, extraHeaders map[string]string) (map[string]string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("jethub: parse sign url: %w", err)
	}
	uri := u.EscapedPath()
	if !strings.HasSuffix(uri, "/") {
		uri += "/"
	}
	query := strings.TrimPrefix(u.RawQuery, "")
	if query == "" {
		query = strings.TrimPrefix(u.RawQuery, "?")
	}
	dateStamp := time.Now().UTC().Format("20060102T150405Z")
	bodyHash := sha256Hex(body)

	headers := map[string]string{
		"x-sdk-date":           dateStamp,
		"x-sdk-content-sha256": bodyHash,
		"x-security-token":     securityToken,
	}
	for k, v := range extraHeaders {
		headers[strings.ToLower(k)] = v
	}
	if !strings.EqualFold(method, "GET") {
		headers["content-type"] = "application/json"
	}

	signed := make([]string, 0, len(headers))
	for k := range headers {
		signed = append(signed, k)
	}
	sort.Strings(signed)

	var lines []string
	for _, k := range signed {
		lines = append(lines, k+":"+headers[k])
	}
	canonicalRequest := strings.Join([]string{
		strings.ToUpper(method), uri, query, strings.Join(lines, "\n"), "", strings.Join(signed, ";"), bodyHash,
	}, "\n")
	canonicalHash := sha256Hex([]byte(canonicalRequest))
	stringToSign := "SDK-HMAC-SHA256\n" + dateStamp + "\n" + canonicalHash
	mac := hmac.New(sha256.New, []byte(sk))
	mac.Write([]byte(stringToSign))
	signature := hex.EncodeToString(mac.Sum(nil))

	headers["Authorization"] = fmt.Sprintf("SDK-HMAC-SHA256 Access=%s,SignedHeaders=%s,Signature=%s", ak, strings.Join(signed, ";"), signature)
	return headers, nil
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// ApplySignedHeaders copies signed headers onto an outbound request. Per the
// signedSnapRequest contract: host is skipped (transport-generated) and
// content-type is skipped (the caller sets its own value after).
func ApplySignedHeaders(set func(key, val string), signed map[string]string) {
	for k, v := range signed {
		lk := strings.ToLower(k)
		if lk == "host" || lk == "content-type" {
			continue
		}
		set(k, v)
	}
}
