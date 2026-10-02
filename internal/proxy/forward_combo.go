package proxy

import (
	"fmt"
	"net/http"

	"github.com/tinylab/tinylab/internal/combo"
)

func (h *Handler) handleCombo(w http.ResponseWriter, r *http.Request, comboName string, bodyBytes []byte, parsed map[string]any, isStream bool, msgCount int, path string, entryFormat combo.EntryFormat, sessionKey string) {
	plan, err := h.comboRes.Resolve(comboName, entryFormat)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if plan == nil || len(plan.Targets) == 0 {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("combo not found or empty: %s", comboName))
		return
	}

	comboLabel := fmt.Sprintf("[combo:%s] ", comboName)
	switch plan.Strategy {
	case "fallback":
		lastReqID := ""
		for _, target := range plan.Targets {
			ok, id := h.forwardWithRetry(w, r, target.ProviderID, target.Model, path, bodyBytes, parsed, isStream, msgCount, comboLabel, "", entryFormat, "", sessionKey)
			if ok {
				return
			}
			lastReqID = id
		}
		writeProxyError(w, lastReqID, nil, http.StatusBadGateway, fmt.Sprintf("all keys exhausted for combo: %s", comboName))
	case "round-robin":
		target := plan.Targets[0]
		if ok, id := h.forwardWithRetry(w, r, target.ProviderID, target.Model, path, bodyBytes, parsed, isStream, msgCount, comboLabel, "", entryFormat, "", sessionKey); !ok {
			writeProxyError(w, id, nil, http.StatusBadGateway, fmt.Sprintf("all keys exhausted for combo: %s", comboName))
		}
	case "greedy-squirrel":
		lastReqID := ""
		for _, target := range plan.Targets {
			ok, id := h.forwardWithRetry(w, r, target.ProviderID, target.Model, path, bodyBytes, parsed, isStream, msgCount, comboLabel, "", entryFormat, "", sessionKey)
			if ok {
				return
			}
			lastReqID = id
		}
		writeProxyError(w, lastReqID, nil, http.StatusBadGateway, fmt.Sprintf("all keys exhausted for combo: %s", comboName))
	default:
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown combo strategy: %s", plan.Strategy))
	}
}
