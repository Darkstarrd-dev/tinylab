package jethub

import "encoding/json"

// jsonUnmarshal is a tiny indirection so bridge.go stays readable.
func jsonUnmarshal(data []byte, v any) error { return json.Unmarshal(data, v) }
