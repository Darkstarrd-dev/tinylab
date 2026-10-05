package jethub

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestZcodeNeverReadsLocalClientData 是「不读本机 ZCode 客户端数据」这条红线的
// **源码级守卫**（2026-10-05，用户决定，对齐上游 commit 2e8bb86）。
//
// ## 为什么扫源码字面量，而不是断言函数不存在
//
// 断言「`zcodeImportLocalCredential` 不存在」只能挡住**原样搬回来**；任何人新写一个
// 别的名字的读取函数都能绕过它。字面量（凭据文件名、安装清单名、派生密钥前缀）是
// 那条路**绕不开**的东西 —— 要读那份文件就必须写出它的路径。上游的回归用例
// （`zcode-no-local-credential-read.spec.ts`）用的就是这个判据，并做过反向验证：
// 临时把路径加回去，用例立刻变红并指出文件名。
//
// ⚠️ 判据串在这里**拼接构造**，避免守卫文件自己命中自己的扫描（扫的是非测试源码）。
//
// ## 为什么必须有这条守卫（三条理由，写在这里以免将来被当成为难而为难）
//
//  1. **安全**：官方客户端用 sha256(平台 + 家目录 + 用户名) 派生 AES-256-GCM 密钥
//     加密凭据，算法公开可复现 —— 那条路等价于「任何本地进程都能解密用户的 ZCode
//     登录态」。本端具备这种能力是不可接受的。
//  2. **正确性**：它在 zai 渠道下双重失效（两个渠道的 `user_info` 结构不同），
//     导入结果 `user_id` 恒缺、账号标签退化成「设备xxxxxxxx」。
//  3. **一致性**：本端本来就有完整可用的 OAuth 设备授权流，旧路径是条更差的旁路。
func TestZcodeNeverReadsLocalClientData(t *testing.T) {
	forbidden := []string{
		"credentials" + ".json",       // 官方凭据文件名
		"telemetry-state" + ".json",   // 官方 device_mid 来源
		"zcode-install" + "-manifest", // 官方安装清单（版本探测）
		"enc:" + "v1:",                // 官方凭据密文前缀
		"ZCODE_CREDENTIAL" + "_SECRET", // 官方密钥的环境变量覆盖
		"zcode-credential" + "-fallback:", // 官方密钥派生前缀
	}
	files, err := filepath.Glob("zcode*.go")
	if err != nil {
		t.Fatal(err)
	}
	scanned := 0
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		scanned++
		src := string(raw)
		for _, needle := range forbidden {
			if strings.Contains(src, needle) {
				t.Errorf("%s 含 %q —— 「不读本机 ZCode 客户端数据」的红线被破坏了。"+
					"凭据只有一条来源：本插件自己的 OAuth 设备授权流（见 zcode.go 的包注释与 docs/jethub-upstream-sync.md R4）",
					name, needle)
			}
		}
	}
	if scanned == 0 {
		t.Fatal("扫了 0 个文件 —— 守卫本身失效了（枚举 broken，不是代码没问题）")
	}
}
