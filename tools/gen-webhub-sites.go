// Command gen-webhub-sites converts the upstream universal-web-api site rule
// file (ref/universal-web-api/config/sites.json) into the Go rule table
// internal/webhub/sites.go.
//
// It is a ONE-SHOT code generator, not a runtime dependency: webhub must never
// read sites.json at runtime (that would drag the Python upstream's file into
// the single-binary deliverable and couple releases to its layout).
//
// Usage:
//
//	go run ./tools/gen-webhub-sites.go -in ref/universal-web-api/config/sites.json \
//	    -out internal/webhub/sites.go [-pin 29d9685]
//
// ⚠️ The OUTPUT IS GENERATED — never hand-edit internal/webhub/sites.go. When
// upstream rules change, re-run this tool (see docs/webhub-upstream-sync.md).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
)

// rawSite mirrors the per-domain shape of upstream sites.json. Only the fields
// this project ports are declared; everything else (image/audio capture, file
// paste tuning, anti-detection scripts, …) is intentionally dropped — see
// docs/webhub-upstream-sync.md §5 (不搬清单).
type rawSite struct {
	Presets       map[string]rawPreset `json:"presets"`
	DefaultPreset string               `json:"default_preset"`
}

type rawPreset struct {
	Selectors    map[string]string `json:"selectors"`
	StreamConfig rawStream         `json:"stream_config"`
	Workflow     []rawStep         `json:"workflow"`
}

type rawStream struct {
	Mode        string          `json:"mode"`
	HardTimeout float64         `json:"hard_timeout"`
	Network     *rawStreamNet   `json:"network"`
	Poll        json.RawMessage `json:"poll"`
}

type rawStreamNet struct {
	ListenPattern string `json:"listen_pattern"`
	Parser        string `json:"parser"`
}

type rawStep struct {
	Action   string          `json:"action"`
	Target   string          `json:"target"`
	Optional bool            `json:"optional"`
	Label    string          `json:"label"`
	Value    json.RawMessage `json:"value"`
}

func main() {
	in := flag.String("in", "ref/universal-web-api/config/sites.json", "upstream sites.json path")
	out := flag.String("out", "internal/webhub/sites.go", "generated Go file path")
	pin := flag.String("pin", "", "upstream commit pin recorded in the header")
	flag.Parse()

	raw, err := os.ReadFile(*in)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gen-webhub-sites: read %s: %v\n", *in, err)
		os.Exit(1)
	}
	var parsed map[string]rawSite
	if err := json.Unmarshal(raw, &parsed); err != nil {
		fmt.Fprintf(os.Stderr, "gen-webhub-sites: parse: %v\n", err)
		os.Exit(1)
	}

	domains := make([]string, 0, len(parsed))
	for domain := range parsed {
		if domain == "_global" {
			continue
		}
		domains = append(domains, domain)
	}
	sort.Strings(domains)

	var b strings.Builder
	b.WriteString(headerComment(*in, *pin, domains))
	for _, domain := range domains {
		site := parsed[domain]
		presetNames := make([]string, 0, len(site.Presets))
		for name := range site.Presets {
			presetNames = append(presetNames, name)
		}
		sort.Strings(presetNames)
		b.WriteString(fmt.Sprintf("\t{\n\t\tDomain:        %s,\n", goString(domain)))
		b.WriteString(fmt.Sprintf("\t\tDefaultPreset: %s,\n", goString(site.DefaultPreset)))
		b.WriteString("\t\tPresets: []Preset{\n")
		for _, name := range presetNames {
			p := site.Presets[name]
			b.WriteString(fmt.Sprintf("\t\t\t{\n\t\t\t\tName: %s,\n", goString(name)))
			b.WriteString("\t\t\t\tSelectors: map[string]string{\n")
			keys := make([]string, 0, len(p.Selectors))
			for k := range p.Selectors {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if strings.TrimSpace(p.Selectors[k]) == "" {
					continue // null / empty selectors are absent, not ""
				}
				b.WriteString(fmt.Sprintf("\t\t\t\t\t%s: %s,\n", goString(k), goString(p.Selectors[k])))
			}
			b.WriteString("\t\t\t\t},\n")
			b.WriteString(fmt.Sprintf("\t\t\t\tStream: StreamConfig{Mode: %s, HardTimeoutSec: %g",
				goString(p.StreamConfig.Mode), p.StreamConfig.HardTimeout))
			if p.StreamConfig.Network != nil {
				b.WriteString(fmt.Sprintf(", ListenPattern: %s, Parser: %s",
					goString(p.StreamConfig.Network.ListenPattern), goString(p.StreamConfig.Network.Parser)))
			}
			b.WriteString("},\n")
			b.WriteString("\t\t\t\tWorkflow: []Step{\n")
			writeSteps(&b, p.Workflow, 4)
			b.WriteString("\t\t\t\t},\n")
			b.WriteString("\t\t\t},\n")
		}
		b.WriteString("\t\t},\n")
		b.WriteString("\t},\n")
	}
	b.WriteString("}\n")

	if err := os.WriteFile(*out, []byte(b.String()), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "gen-webhub-sites: write %s: %v\n", *out, err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "gen-webhub-sites: wrote %s (%d sites)\n", *out, len(domains))
}

// writeSteps emits one flattened step list. GROUP steps are inlined in order
// (their `steps` run as part of the same sequence) so the interpreter stays a
// single flat loop.
func writeSteps(b *strings.Builder, steps []rawStep, depth int) {
	pad := strings.Repeat("\t", depth)
	for _, st := range steps {
		action := strings.ToUpper(strings.TrimSpace(st.Action))
		if action == "GROUP" {
			var group struct {
				Steps []rawStep `json:"steps"`
			}
			if len(st.Value) > 0 {
				_ = json.Unmarshal(st.Value, &group)
			}
			writeSteps(b, group.Steps, depth)
			continue
		}
		seconds := 0.0
		if action == "WAIT" {
			// WAIT's payload is a bare number of seconds (upstream
			// workflow[].value). Preserving it matters: these are real
			// settle delays between a click and the next action.
			if n := len(st.Value); n > 0 && st.Value[0] != 'n' {
				_ = json.Unmarshal(st.Value, &seconds)
			}
		}
		b.WriteString(fmt.Sprintf("%s{Action: %s, Target: %s, Optional: %t, Seconds: %g, Label: %s},\n",
			pad, goString(action), goString(st.Target), st.Optional, seconds, goString(truncate(st.Label, 80))))
	}
}

func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

// goString renders s as a Go interpreted string literal (UTF-8 kept readable;
// only the characters that must be escaped are escaped).
func goString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	// JSON string literals are a subset of Go's for our data (no invalid
	// UTF-8, no \u0000 issues in practice); keep them as-is.
	return string(b)
}

func headerComment(in, pin string, domains []string) string {
	pinNote := "unknown"
	if pin != "" {
		pinNote = pin
	}
	return fmt.Sprintf(`// Code generated by tools/gen-webhub-sites.go — DO NOT EDIT.
//
// Source: %s (upstream universal-web-api, pin %s).
//
// ⚠️ 这是一个**生成文件**：规则来自上游的声明式 JSON。上游规则变化时重跑
//
//	go run ./tools/gen-webhub-sites.go -in <upstream sites.json> -out internal/webhub/sites.go
//
// 而不是手工改本文件（禁止手工编辑，见 docs/webhub-upstream-sync.md）。
//
// 只搬「填充输入 → 发送 → 增量监听」这条链路需要的字段：selectors /
// stream_config(mode, hard_timeout, listen_pattern, parser) / workflow。
// 上游的图片/音频采集、文件粘贴调参、反检测脚本等一律不搬（不搬清单 §5）。
//
// 站点 (%d): %s

package webhub

// siteRules is the transplanted upstream rule table: one entry per supported
// site domain. Domains are the normalized lowercase hostnames used for both
// tab matching and model-id routing.
var siteRules = []SiteRule{
`, in, pinNote, len(domains), strings.Join(domains, ", "))
}
