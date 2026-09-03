package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/util"
)

func (h *Handler) handleProxy(w http.ResponseWriter, r *http.Request, path string, entryFormat combo.EntryFormat) {
	defer r.Body.Close()
	// 32 MB 代理请求体上限（LLM prompt 可能很大，32MB 足够）
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read request body")
		return
	}

	var parsed map[string]any
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	modelStr, _ := parsed["model"].(string)
	if modelStr == "" {
		writeError(w, http.StatusBadRequest, "missing 'model' field")
		return
	}

	isStream := false
	if s, ok := parsed["stream"].(bool); ok {
		isStream = s
	}

	msgCount := 0
	if msgs, ok := parsed["messages"].([]any); ok {
		msgCount = len(msgs)
	}

	// sessionKey is an inferred per-conversation hash (system + first user
	// message root). Empty for single-shot/non-chat requests → ungrouped.
	sessionKey := sessionKeyFromMessages(parsed)

	if h.comboRes.IsComboName(modelStr) {
		h.handleCombo(w, r, modelStr, bodyBytes, parsed, isStream, msgCount, path, entryFormat, sessionKey)
		return
	}

	if qs, ok := h.quickSlots.GetQuickSlotByName(modelStr); ok {
		models := qs.Models
		idx := qs.SelectedIndex
		if idx < 0 || idx >= len(models) {
			idx = 0
		}
		if idx < len(models) {
			modelStr = models[idx]
		} else {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("quickslot %s has no models", modelStr))
			return
		}
	}

	if h.comboRes.IsComboName(modelStr) {
		h.handleCombo(w, r, modelStr, bodyBytes, parsed, isStream, msgCount, path, entryFormat, sessionKey)
		return
	}

	providerID, upstreamModel := util.SplitModel(modelStr)
	if providerID == "" {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid model format: %s (expected provider/model)", modelStr))
		return
	}

	// Resolve prefix to actual provider ID
	provider, ok := h.providers.GetProviderByPrefix(providerID)
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown provider prefix: %s", providerID))
		return
	}
	providerID = provider.ID

	// Clean up potential duplicate provider prefix/ID in upstreamModel
	for {
		trimmed := false
		if provider.Prefix != "" && strings.HasPrefix(upstreamModel, provider.Prefix+"/") {
			upstreamModel = strings.TrimPrefix(upstreamModel, provider.Prefix+"/")
			trimmed = true
		}
		if provider.ID != "" && strings.HasPrefix(upstreamModel, provider.ID+"/") {
			upstreamModel = strings.TrimPrefix(upstreamModel, provider.ID+"/")
			trimmed = true
		}
		if !trimmed {
			break
		}
	}

	// NOTE: entry-format ↔ provider protocol matching was removed. TinyLab
	// fronts aggregating proxies (e.g. newapi / 2api) that serve multiple
	// protocols from the same provider, and capabilities are per-model rather
	// than per-provider. Whatever protocol the client requests, the proxy
	// forwards it upstream; rejection (if any) is the upstream's call, not ours.
	// The anthropic vs OpenAI upstream construction is still chosen by
	// entryFormat (see forwardUpstream), so proto routing continues to work.

	// Resolve alias to real model ID: if the user specified an alias, find
	// the actual model ID before forwarding to the upstream.
	originalModel := upstreamModel
	if realID, found := h.aliases.ResolveModelAlias(provider.Prefix, upstreamModel); found {
		upstreamModel = realID
	}

	// NIM providers must not participate in Combo routing: the model name
	// carries a nv/* prefix and never matches a combo name, so no combo
	// resolution is attempted for them — fall through to the forward path.
	if ok, _ := h.forwardWithRetry(w, r, providerID, upstreamModel, path, bodyBytes, parsed, isStream, msgCount, "", provider.Name, entryFormat, originalModel, sessionKey); !ok {
		writeError(w, http.StatusBadGateway, "all keys exhausted")
	}
}
