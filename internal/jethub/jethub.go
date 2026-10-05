// Package jethub implements the Free Hub provider bridge: it manages third
// party LLM accounts (credentials, account pools, prefixes) and exposes them
// through the project's normal proxy pipeline as dynamically registered
// providers (config.Provider with APIType "jethub").
//
// The package owns two storage files under {configDir}/jethub:
//   - credentials.json (AES-GCM encrypted, sensitive)
//   - accounts.json    (plain atomic write, non-sensitive index)
//
// It bridges to the proxy via the narrow proxy.RequestAugmenter interface —
// the proxy never imports this package.
package jethub

// APIType is the config.Provider.APIType value that marks a bridged provider.
const APIType = "jethub"

// IDPrefix is prepended to a provider id when registering a bridged provider
// in the registry (e.g. "jethub-codearts").
const IDPrefix = "jethub-"

// anonymousKeyPriorityBase is the rotation priority floor for a provider's
// anonymous channel(s): they always sort **after** every keyed account, in the
// user's stored order among themselves (see Bridge.SyncKeys). It is a position,
// not a privilege downgrade — the anonymous account can still be reordered,
// disabled and deleted like any other.
const anonymousKeyPriorityBase = 100

// ProviderID returns the bridged provider ID for a jethub provider name.
func ProviderID(provider string) string { return IDPrefix + provider }

// ProviderNameFromID strips the jethub prefix from a bridged provider ID.
// ok is false when the ID does not carry the prefix.
func ProviderNameFromID(id string) (provider string, ok bool) {
	if len(id) > len(IDPrefix) && id[:len(IDPrefix)] == IDPrefix {
		return id[len(IDPrefix):], true
	}
	return "", false
}
