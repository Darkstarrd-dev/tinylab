package webhub

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// findChromium 的候选路径解析（mock 文件系统 + mock PATH）。
func TestFindChromiumCandidatePaths(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "chrome.exe")
	if err := os.WriteFile(bin, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A directory named like a browser must NOT be accepted.
	dirAsBin := filepath.Join(dir, "edgedir")
	if err := os.MkdirAll(dirAsBin, 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := findChromium([]string{"", dirAsBin, bin}, func(string) (string, error) {
		t.Fatal("PATH must not be consulted when a candidate exists")
		return "", nil
	})
	if err != nil {
		t.Fatalf("findChromium: %v", err)
	}
	if got != bin {
		t.Fatalf("got %q, want %q", got, bin)
	}
}

// 候选全空（例如未设置 %ProgramFiles(x86)%）时必须跳过而不是 stat("")。
func TestFindChromiumSkipsEmptyCandidates(t *testing.T) {
	looked := 0
	got, err := findChromium([]string{"", ""}, func(name string) (string, error) {
		looked++
		return "/usr/bin/" + name, nil
	})
	if err != nil {
		t.Fatalf("findChromium: %v", err)
	}
	if !strings.Contains(got, "chrome") {
		t.Fatalf("PATH fallback = %q, want the chrome lookup", got)
	}
	if looked != 1 {
		t.Fatalf("PATH lookups = %d, want 1 (first hit wins)", looked)
	}
}

// 没有任何浏览器时必须返回 ErrNoBrowser（UI 直接展示该文案）。
func TestFindChromiumNotFound(t *testing.T) {
	if _, err := findChromium(nil, func(string) (string, error) {
		return "", os.ErrNotExist
	}); err != ErrNoBrowser {
		t.Fatalf("err = %v, want ErrNoBrowser", err)
	}
}

// LaunchArgs 必须带上独立 profile + 调试端口，且避免 UWA 的 9222。
func TestLaunchArgs(t *testing.T) {
	args := strings.Join(LaunchArgs(LaunchSpec{
		Bin:        "/bin/chrome",
		ProfileDir: "/data/profile",
		Port:       0,
		Headless:   true,
	}), " ")
	if !strings.Contains(args, "--remote-debugging-port=9333") {
		t.Fatalf("default port missing: %s", args)
	}
	if !strings.Contains(args, "--user-data-dir=/data/profile") {
		t.Fatalf("profile dir missing: %s", args)
	}
	if !strings.Contains(args, "--headless=new") {
		t.Fatalf("headless flag missing: %s", args)
	}
	if strings.Contains(args, "9222") {
		t.Fatalf("must not collide with UWA's 9222: %s", args)
	}
	// 显式端口必须生效。
	if a := strings.Join(LaunchArgs(LaunchSpec{Port: 9444}), " "); !strings.Contains(a, "--remote-debugging-port=9444") {
		t.Fatalf("explicit port ignored: %s", a)
	}
}

// Launch 拒绝空 profile —— 登录态必须落在一个真实持久目录里。
func TestLaunchRejectsEmptyProfile(t *testing.T) {
	if _, err := Launch(LaunchSpec{Bin: "/bin/chrome"}); err == nil {
		t.Fatal("expected an error for an empty profile dir")
	}
	if _, err := Launch(LaunchSpec{ProfileDir: t.TempDir()}); err == nil {
		t.Fatal("expected an error for an empty binary")
	}
}

// 平台候选表必须覆盖真实安装位置（本项目的实测环境：Windows Chrome/Edge）。
func TestCandidatePathsCoverPlatform(t *testing.T) {
	got := candidateChromiumPaths()
	if len(got) == 0 {
		t.Fatal("no candidates")
	}
	joined := strings.Join(got, "|")
	switch runtime.GOOS {
	case "windows":
		if !strings.Contains(joined, "chrome.exe") || !strings.Contains(joined, "msedge.exe") {
			t.Fatalf("windows candidates missing chrome/edge: %s", joined)
		}
	case "darwin":
		if !strings.Contains(joined, "Google Chrome.app") {
			t.Fatalf("mac candidates missing Chrome: %s", joined)
		}
	default:
		if !strings.Contains(joined, "/usr/bin/") {
			t.Fatalf("linux candidates missing /usr/bin: %s", joined)
		}
	}
}

// profile 目录必须是持久固定目录（登录态跨进程存活）。
func TestResolveProfileDir(t *testing.T) {
	wantDefault, err := filepath.Abs(filepath.Join("/cfg", "webhub", "profile"))
	if err != nil {
		t.Fatal(err)
	}
	if got := ResolveProfileDir("", "/cfg"); got != wantDefault {
		t.Fatalf("default = %q", got)
	}
	wantCustom, err := filepath.Abs(filepath.Join("/cfg", "custom"))
	if err != nil {
		t.Fatal(err)
	}
	if got := ResolveProfileDir("custom", "/cfg"); got != wantCustom {
		t.Fatalf("relative = %q", got)
	}
	abs := filepath.Join(t.TempDir(), "profile")
	if got := ResolveProfileDir(abs, "/cfg"); got != abs {
		t.Fatalf("absolute = %q, want %q", got, abs)
	}
}

// 缺陷 21（2026-10-03）：app 以相对 configDir 启动时，profile 目录曾以相对
// 路径进入 Chrome 的 --user-data-dir=，Chrome 静默失败（~60ms 退出码 0，
// 无日志、不建 profile、不绑调试端口）⇒ 永远 "devtools not ready"。
// 解析结果必须是绝对路径。
func TestResolveProfileDirAlwaysAbsolute(t *testing.T) {
	// 模拟相对 configDir：传入 "."（app 以 CWD 发现 config 的部署形态）。
	for _, dir := range []string{"", ".", "webhub"} {
		got := ResolveProfileDir(dir, ".")
		if !filepath.IsAbs(got) {
			t.Fatalf("ResolveProfileDir(%q, \".\") = %q, want absolute", dir, got)
		}
	}
	// configDir 为空的兜底分支同样必须绝对。
	if got := ResolveProfileDir("", ""); !filepath.IsAbs(got) {
		t.Fatalf("ResolveProfileDir(\"\", \"\") = %q, want absolute", got)
	}
}
