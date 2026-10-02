package webhub

import (
	"log"
	"path/filepath"
)

// ResolveProfileDir resolves the persistent browser profile directory webhub
// launches Chrome with. An empty dir falls back to {configDir}/webhub/profile
// (or "webhub/profile" when configDir is empty); a relative path is joined
// with configDir; an absolute path is used verbatim.
//
// ⚠️ Persistence is a hard requirement, not an implementation detail: the
// login state lives in this directory. Pointing it at a temp dir makes the
// user re-authenticate on every process start.
//
// ⚠️ 结果必须是绝对路径（2026-10-03 用户实测缺陷 21）：app 以相对 configDir
// 启动时（Explorer 双击启动，config 发现基于进程 CWD），此前会把
// `webhub\webhub\profile` 这样的**相对路径**原样塞进 Chrome 的
// `--user-data-dir=`——Chrome 对相对 user-data-dir 的处理是静默失败
// （stub 进程 ~60ms 退出码 0，无任何 stderr/日志，profile 不创建、调试端口
// 不绑定），外部表现恰是「devtools not ready after 20s」。 absolutize 兜底
// 由本函数与 config.ResolveWebHubDir 共同保证。
func ResolveProfileDir(dir, configDir string) string {
	abs := func(p string) string {
		a, err := filepath.Abs(p)
		if err != nil {
			// os.Getwd failing means the process CWD was deleted; nothing
			// Chrome-friendly can be derived anyway.
			log.Printf("webhub: absolutize profile dir %q: %v", p, err)
			return p
		}
		return a
	}
	if dir == "" {
		if configDir == "" {
			return abs(filepath.Join("webhub", "profile"))
		}
		return abs(filepath.Join(configDir, "webhub", "profile"))
	}
	if filepath.IsAbs(dir) {
		return dir
	}
	if configDir != "" {
		return abs(filepath.Join(configDir, dir))
	}
	return abs(dir)
}
