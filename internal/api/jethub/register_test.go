package jethub

import (
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

// modelDisplayParts：倍率解析的三种来源形态（alias 内嵌 / note 段 / 无倍率）。
// 形态逐条对照 internal/jethub 的产品表（raccoon / loomy / qoder / codearts）。
func TestModelDisplayParts(t *testing.T) {
	cases := []struct {
		name string
		md   config.ModelDef
		want string
		rate string
	}{
		{"alias 内嵌倍率 (raccoon)", config.ModelDef{ID: "sn-glm-5-3", Alias: "GLM-5-3 · x0.75"}, "GLM-5-3", "x0.75"},
		{"alias 内嵌免费 (raccoon)", config.ModelDef{ID: "sn-1", Alias: "SenseNova-6.8-Flash · 免费", Note: "ctx 256000"}, "SenseNova-6.8-Flash", "免费"},
		{"alias 促销价 (raccoon)", config.ModelDef{ID: "sn-2", Alias: "GLM-5-3-Flash · x0.2→x0.1"}, "GLM-5-3-Flash", "x0.2→x0.1"},
		{"note 段倍率 (qoder)", config.ModelDef{ID: "ultimate", Alias: "Ultimate", Note: "ctx 1000000; x2; efforts xhigh"}, "Ultimate", "x2"},
		{"note 免费 (qoder)", config.ModelDef{ID: "qfmodel", Alias: "Qwen3.8-Flash", Note: "ctx 1000000; FREE (x0); efforts"}, "Qwen3.8-Flash", "免费"},
		{"1 倍也要显示 (qoder)", config.ModelDef{ID: "sn-kimi-k3", Alias: "Kimi-K3", Note: "ctx 1000000; x1"}, "Kimi-K3", "x1"},
		{"无倍率不编造 (codearts)", config.ModelDef{ID: "GLM-5.2", Note: "ctx 202752"}, "GLM-5.2", ""},
		{"无 alias 退化成 id (trae)", config.ModelDef{ID: "glm-5.2", Note: "ctx 200000"}, "glm-5.2", ""},
		{"note 的非倍率段不误判", config.ModelDef{ID: "m1", Alias: "M1", Note: "ctx 1048576; max 63999; free"}, "M1", ""},
	}
	for _, tc := range cases {
		gotName, gotRate := modelDisplayParts(tc.md)
		if gotName != tc.want || gotRate != tc.rate {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", tc.name, gotName, gotRate, tc.want, tc.rate)
		}
	}
}
