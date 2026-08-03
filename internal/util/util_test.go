package util

import "testing"

func TestSplitModel(t *testing.T) {
	tests := []struct {
		input        string
		wantProvider string
		wantModel    string
	}{
		{"provider/model", "provider", "model"},
		{"provider/model/extra", "provider", "model/extra"},
		{"nomodel", "", "nomodel"},
		{"", "", ""},
	}
	for _, tc := range tests {
		gotProvider, gotModel := SplitModel(tc.input)
		if gotProvider != tc.wantProvider || gotModel != tc.wantModel {
			t.Errorf("SplitModel(%q) = (%q, %q), want (%q, %q)",
				tc.input, gotProvider, gotModel, tc.wantProvider, tc.wantModel)
		}
	}
}

func TestTruncStr(t *testing.T) {
	tests := []struct {
		input string
		n     int
		want  string
	}{
		{"hello", 10, "hello"},
		{"hello world", 5, "hello..."},
		{"", 5, ""},
		{"abc", 3, "abc"},
	}
	for _, tc := range tests {
		got := TruncStr(tc.input, tc.n)
		if got != tc.want {
			t.Errorf("TruncStr(%q, %d) = %q, want %q", tc.input, tc.n, got, tc.want)
		}
	}
}

func TestExtractTokens(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantIn  int
		wantOut int
	}{
		{
			name:   "standard OpenAI",
			input:  `{"usage":{"prompt_tokens":10,"completion_tokens":20}}`,
			wantIn: 10, wantOut: 20,
		},
		{
			name:   "Anthropic",
			input:  `{"usage":{"input_tokens":5,"output_tokens":15}}`,
			wantIn: 5, wantOut: 15,
		},
		{
			name:   "no usage field",
			input:  `{"choices":[]}`,
			wantIn: 0, wantOut: 0,
		},
		{
			name:   "only total_tokens",
			input:  `{"usage":{"total_tokens":42}}`,
			wantIn: 42, wantOut: 0,
		},
		{
			name:   "invalid JSON",
			input:  `{"bad"`,
			wantIn: 0, wantOut: 0,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotIn, gotOut := ExtractTokens([]byte(tc.input))
			if gotIn != tc.wantIn || gotOut != tc.wantOut {
				t.Errorf("ExtractTokens(%q) = (%d, %d), want (%d, %d)",
					tc.input, gotIn, gotOut, tc.wantIn, tc.wantOut)
			}
		})
	}
}
