package app

import (
	"io"
	"net/http"
	"strings"

	"github.com/tinylab/tinylab/internal/jethub"
	"github.com/tinylab/tinylab/internal/webhub"
)

// bridgedAugmenter dispatches the single injected proxy.RequestAugmenter slot
// to the owning hub by provider ID prefix.
//
// ⚠️ The proxy exposes exactly ONE augmenter slot
// (Handler.SetRequestAugmenter), and both hubs need it: jethub (HTTP protocol
// bridge) and webhub (browser page driver). Rather than letting whichever hub
// is wired last win, this dispatcher routes by APIType:
//
//	webhub-<domain>  → webhub bridge (no endpoint; drives a browser page)
//	jethub-<provider> → jethub bridge (real upstream URL/body/header rewrite)
//
// It implements all three optional capabilities (RequestCustomizer,
// ResponseInterceptor, plus the base Augment) so the proxy's type assertions
// succeed and the correct hub handles each call.
type bridgedAugmenter struct {
	jethub *jethub.Manager
	webhub *webhub.Bridge
}

// ownerFor reports which hub owns a bridged provider ID.
func ownerFor(providerID string) string {
	switch {
	case strings.HasPrefix(providerID, webhub.IDPrefix):
		return "webhub"
	case strings.HasPrefix(providerID, jethub.IDPrefix):
		return "jethub"
	}
	return ""
}

func (b *bridgedAugmenter) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	if ownerFor(providerID) == "webhub" && b.webhub != nil {
		return b.webhub.Augment(r, body, providerID, keyID, upstreamModel)
	}
	if b.jethub != nil {
		return b.jethub.Augment(r, body, providerID, keyID, upstreamModel)
	}
	return body, nil
}

func (b *bridgedAugmenter) Customize(r *http.Request, body []byte, providerID, keyID, upstreamModel string) (string, []byte, error) {
	if ownerFor(providerID) == "webhub" && b.webhub != nil {
		return b.webhub.Customize(r, body, providerID, keyID, upstreamModel)
	}
	if b.jethub != nil {
		return b.jethub.Customize(r, body, providerID, keyID, upstreamModel)
	}
	return "", body, nil
}

func (b *bridgedAugmenter) InterceptResponse(clientReq *http.Request, resp *http.Response, providerID, keyID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	if ownerFor(providerID) == "webhub" && b.webhub != nil {
		return b.webhub.InterceptResponse(clientReq, resp, providerID, keyID, upstreamModel, isStream)
	}
	if b.jethub != nil {
		return b.jethub.InterceptResponse(clientReq, resp, providerID, keyID, upstreamModel, isStream)
	}
	return nil, 0, nil
}
