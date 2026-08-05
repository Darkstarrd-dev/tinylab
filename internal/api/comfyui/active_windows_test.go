package comfyui

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestReadActiveWorkflowFromLevelDB(t *testing.T) {
	dir := t.TempDir()
	data := []byte("Comfy.Workflow.LastActivePath:personal?\x01{" + `"workspaceId":"personal","path":"workflows/current.json"}`)
	if err := os.WriteFile(filepath.Join(dir, "000001.log"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := readActiveWorkflowFromDir(dir)
	if err != nil {
		t.Fatalf("readActiveWorkflowFromDir() error = %v", err)
	}
	if got.Path != "current.json" || got.Workspace != "personal" {
		t.Fatalf("active = %+v", got)
	}
}

func TestValidComfyWorkflowPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"workflows/current.json", true},
		{"workflows/sub/current.json", true},
		{"current.json", false},
		{"workflows/../current.json", false},
		{"workflows/current.txt", false},
	}
	for _, tc := range cases {
		if got := validComfyWorkflowPath(tc.path); got != tc.want {
			t.Errorf("validComfyWorkflowPath(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}

func TestJSONAfterKey(t *testing.T) {
	value, ok := jsonAfterKey([]byte("metadata {\"path\":\"workflows/current.json\"} trailing"))
	if !ok {
		t.Fatal("jsonAfterKey() did not find JSON")
	}
	var got map[string]string
	if err := json.Unmarshal(value, &got); err != nil || got["path"] != "workflows/current.json" {
		t.Fatalf("value = %s, err = %v", value, err)
	}
}

func TestActiveWorkflowUnavailableOutsideWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows-specific discovery is covered by the integration test")
	}
	if _, err := readActiveWorkflow(); err == nil {
		t.Fatal("readActiveWorkflow() unexpectedly succeeded outside Windows")
	}
}

func TestInstalledComfyDesktopActiveWorkflow(t *testing.T) {
	if os.Getenv("TINYROUTER_ACTIVE_INTEGRATION") != "1" {
		t.Skip("set TINYROUTER_ACTIVE_INTEGRATION=1 to inspect the installed Comfy Desktop store")
	}
	got, err := readActiveWorkflow()
	if err != nil {
		t.Fatalf("readActiveWorkflow() error = %v", err)
	}
	if got.Path == "" {
		t.Fatal("active workflow path is empty")
	}
	t.Logf("active workflow path=%s workspace=%s", got.Path, got.Workspace)
}
