package anysearch

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client is an AnySearch JSON-RPC API client for performing web searches
// and URL extraction through the AnySearch MCP endpoint.
type Client struct {
	httpClient *http.Client
	apiKey     string
}

const (
	endpoint     = "https://api.anysearch.com/mcp"
	clientHeader = "skill/3.0.0"
)

// New creates a new AnySearch client with the given API key. An empty apiKey
// is allowed and results in anonymous access with lower rate limits.
func New(apiKey string) *Client {
	return &Client{
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		apiKey: apiKey,
	}
}

// Search calls the "search" tool on the AnySearch API. query is required;
// domain, subDomain, subDomainParams, and maxResults are optional.
func (c *Client) Search(query string, domain, subDomain string, subDomainParams map[string]interface{}, maxResults int) (string, error) {
	args := map[string]interface{}{
		"query": query,
	}
	if domain != "" {
		args["domain"] = domain
	}
	if subDomain != "" {
		args["sub_domain"] = subDomain
	}
	if subDomainParams != nil {
		args["sub_domain_params"] = subDomainParams
	}
	if maxResults > 0 {
		if maxResults > 10 {
			maxResults = 10
		}
		args["max_results"] = maxResults
	}
	return c.callAPI("search", args)
}

// GetSubDomains calls the "get_sub_domains" tool to list sub-domains for a given domain.
func (c *Client) GetSubDomains(domain string) (string, error) {
	args := map[string]interface{}{
		"domain": domain,
	}
	return c.callAPI("get_sub_domains", args)
}

// Extract calls the "extract" tool to extract content from a URL.
func (c *Client) Extract(rawURL string) (string, error) {
	args := map[string]interface{}{
		"url": rawURL,
	}
	return c.callAPI("extract", args)
}

// callAPI sends a JSON-RPC request to the AnySearch API and returns the
// text content from the response.
func (c *Client) callAPI(toolName string, arguments map[string]interface{}) (string, error) {
	payload := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]interface{}{
			"name":      toolName,
			"arguments": arguments,
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("anysearch: failed to marshal request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("anysearch: failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Anysearch-Client", clientHeader)
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("anysearch: request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("anysearch: failed to read response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("anysearch: upstream returned %d: %s", resp.StatusCode, string(respBody))
	}

	var rpcResponse struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      int             `json:"id"`
		Result  json.RawMessage `json:"result,omitempty"`
		Error   *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(respBody, &rpcResponse); err != nil {
		return "", fmt.Errorf("anysearch: failed to parse response: %w", err)
	}

	if rpcResponse.Error != nil {
		return "", fmt.Errorf("anysearch: API error (%d): %s", rpcResponse.Error.Code, rpcResponse.Error.Message)
	}

	if rpcResponse.Result == nil {
		return "", fmt.Errorf("anysearch: empty response")
	}

	// Try to extract text content from result.content[]
	var result struct {
		Content []struct {
			Type string          `json:"type"`
			Text string          `json:"text,omitempty"`
			Raw  json.RawMessage `json:"raw,omitempty"`
		} `json:"content"`
	}
	if err := json.Unmarshal(rpcResponse.Result, &result); err == nil {
		for _, c := range result.Content {
			if c.Type == "text" && c.Text != "" {
				return c.Text, nil
			}
		}
	}

	// Fallback: return the raw result as JSON
	raw, _ := json.Marshal(rpcResponse.Result)
	return string(raw), nil
}
