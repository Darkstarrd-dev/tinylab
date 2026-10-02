// Package webhub implements the Web Hub provider bridge: it drives the AI web
// front-ends the user is already signed into (chat.deepseek.com, chatgpt.com,
// …) through the Chrome DevTools Protocol and exposes each as a normal
// OpenAI-compatible provider ({prefix}/{modelID}).
//
// It is the sibling of internal/jethub but differs in mechanism: jethub is an
// HTTP protocol bridge (real upstream endpoints, credentials on disk), webhub
// is a BROWSER PAGE DRIVER — there is no upstream endpoint, no credential
// storage, and requests are served by operating a real page over CDP.
//
// Upstream reference: ref/universal-web-api (AGPL-3.0, Python). Only its
// LOGIC and RULE DATA were ported; the implementation here is Go + chromedp.
//
// Boundary discipline (same red line as jethub): internal/proxy never imports
// this package. Bridging goes through the narrow proxy.RequestCustomizer
// interface with the APIType=="webhub" marker.
package webhub

// APIType is the config.Provider.APIType value that marks a webhub-bridged
// provider. The proxy compares against it to route a request to the
// RequestCustomizer instead of building a real HTTP upstream URL.
const APIType = "webhub"

// IDPrefix is prepended to a site domain when registering the bridged provider
// in the registry (e.g. "webhub-chat.deepseek.com").
const IDPrefix = "webhub-"

// ProviderID returns the bridged provider ID for a site domain.
func ProviderID(site string) string { return IDPrefix + site }

// SiteFromProviderID strips the webhub prefix from a bridged provider ID.
// ok is false when the ID does not carry the prefix.
func SiteFromProviderID(id string) (site string, ok bool) {
	if len(id) > len(IDPrefix) && id[:len(IDPrefix)] == IDPrefix {
		return id[len(IDPrefix):], true
	}
	return "", false
}

// SyntheticKeyID is the single rotation key registered on every bridged
// webhub provider. It carries NO credential semantics — webhub has no API
// key; the value exists only so rotation has something to count and usage has
// something to attribute to. It must never be used for outbound auth.
const SyntheticKeyID = "browser-session"

// SyntheticKeyValue is the (constant) synthetic key value. Never sent anywhere.
const SyntheticKeyValue = "webhub-browser-session"
