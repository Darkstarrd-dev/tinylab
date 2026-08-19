// Command assistant-product-bench measures TinyRouter's 小精灵 (sprite)
// assistant PRODUCT readiness across five dimensions the follow-up research
// targets: (1) a dedicated Assistant settings entry, (2) a draggable dock,
// (3) model-assisted (LLM) dispatch, (4) reply correctness on tricky
// disambiguation intents, and (5) a working systray "release pet" path.
//
// It is a no-network, deterministic harness: it constructs the real *api.Router
// in-process (mirroring cmd/assistant-bench), walks its chi routes, loads the
// contract (semantics.json), and runs the assistant's keyword classifier on a
// curated set of tricky intents whose ground truth is known. The four
// non-behavioral dimensions are measured by structural source scans (the
// presence of the feature's wiring in the real source files), which is honest
// about whether each product feature has been implemented.
//
// Primary metric: assistant_product_readiness, a weighted composite (0..100,
// higher is better). Secondary metrics expose each dimension plus a contract
// drift regression guard (must stay 0 so product work never breaks the
// contract).
//
// Output (stdout): one METRIC line per metric, then a per-dimension breakdown.
// Exit 0 on success, non-zero on construction failure.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/tinyrouter/tinyrouter/internal/api"
	"github.com/tinyrouter/tinyrouter/internal/assistant"
	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/download"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

// correctnessScenario is one tricky user intent with a known answer key. A
// scenario is correct iff every required tool is classified (and wired to a
// real route) AND no forbidden tool is. required=nil marks an out-of-scope
// intent that must classify nothing. These intents deliberately target the
// disambiguation gaps the keyword classifier currently gets wrong (e.g.
// "播放视频" must NOT route to download.create, and "画一只猫" SHOULD route to
// image.generate but the all:["图"] clause blocks it). Fixing the contract
// rules (semantics.json) raises the score; this is the genuinely iteratable
// dimension.
type correctnessScenario struct {
	id        string
	intent    string
	required  []string // must all be classified+wired
	forbidden []string // none may be classified+wired
}

var correctnessScenarios = []correctnessScenario{
	// Over-matching: "视频" alone currently fires download.create.
	{id: "play_video", intent: "我想要播放视频", forbidden: []string{"download.create"}},
	{id: "watch_video", intent: "我想看视频", forbidden: []string{"download.create"}},
	{id: "play_video_short", intent: "播放视频", forbidden: []string{"download.create"}},
	{id: "video_player_where", intent: "视频播放器在哪", forbidden: []string{"download.create"}},
	{id: "how_to_play", intent: "怎么播放视频", forbidden: []string{"download.create"}},
	// Recall gap: image.generate requires all:["图"], so "画一只猫" misses.
	{id: "draw_no_tu", intent: "帮我画一只猫", required: []string{"image.generate"}},
	// Clear positives (regression anchors).
	{id: "download_video", intent: "下载这个视频", required: []string{"download.create"}},
	{id: "gen_image", intent: "帮我生成一张猫的图片", required: []string{"image.generate"}},
	// Disambiguation (one rule must win, the other must stay silent).
	{id: "batch_image", intent: "批量生成图片", required: []string{"imagebatch.create"}, forbidden: []string{"image.generate"}},
	{id: "edit_image", intent: "编辑这张图片", required: []string{"image.edit"}, forbidden: []string{"image.generate"}},
	{id: "probe_vs_providers", intent: "测试一下这个provider的key", required: []string{"probe.test"}, forbidden: []string{"providers.list"}},
	{id: "quota_vs_monitor", intent: "查一下各模型的配额", required: []string{"monitor.quotas"}, forbidden: []string{"monitor.view"}},
	{id: "monitor_vs_quota", intent: "看看当前的用量监控", required: []string{"monitor.view"}, forbidden: []string{"monitor.quotas"}},
	{id: "open_vs_save", intent: "打开我的笔记文件", required: []string{"editor.open"}, forbidden: []string{"editor.save"}},
	// Out-of-scope precision guard.
	{id: "out_of_scope", intent: "今天几号了", forbidden: []string{"download.create", "chat", "image.generate"}},
	// --- Adversarial hardening: latent disambiguation gaps not covered by
	// the original 15. Each probes an over-match or recall hole the keyword
	// contract should but does not yet handle. ---
	// probe.test over-matches "测试" for non-provider tests (network speed).
	{id: "test_network_speed", intent: "测试一下网络速度", forbidden: []string{"probe.test"}},
	// providers.list none:["key"] over-blocks "查看provider的key" (recall gap).
	{id: "view_provider_keys", intent: "查看provider的key列表", required: []string{"providers.list"}, forbidden: []string{"probe.test"}},
	// monitor.view over-matches "监控" when the intent is to clean (precision).
	{id: "clean_monitor_logs", intent: "清理过期的监控日志", required: []string{"trace.clear"}, forbidden: []string{"monitor.view"}},
	// image.edit only matches exact "改图"; "改一下这张图" misses (recall gap).
	{id: "edit_image_rephrase", intent: "改一下这张图", required: []string{"image.edit"}, forbidden: []string{"image.generate"}},
	// Positive precision anchors (already pass — guard against regressions).
	{id: "draw_table", intent: "画个表格", forbidden: []string{"image.generate"}},
	{id: "download_audio", intent: "下载这首歌", required: []string{"download.create"}},
	// --- Round 2 adversarial: web-search/extract over-match on 搜索/提取. ---
	{id: "search_local_files", intent: "搜索本地的文件", forbidden: []string{"anysearch.search"}},
	{id: "extract_audio_from_video", intent: "提取视频里的音频", forbidden: []string{"anysearch.extract"}},
	{id: "web_search_news", intent: "搜索一下最新的AI新闻", required: []string{"anysearch.search"}},
}

func main() {
	routeSet, routesCount, err := buildRealRouteSet()
	if err != nil {
		fmt.Fprintf(os.Stderr, "assistant-product-bench: failed to build route set: %v\n", err)
		os.Exit(1)
	}

	contract, err := assistant.LoadContract()
	if err != nil {
		fmt.Fprintf(os.Stderr, "assistant-product-bench: load contract: %v\n", err)
		os.Exit(1)
	}
	a, drift := contract.BuildAssistant(routeSet, true /* model routing wired */)

	// --- Dimension 4: reply correctness (behavioral) ---
	correctness, correctRows := scoreCorrectness(a, routeSet)

	// --- Dimensions 1,2,3,5: structural source scans ---
	settings, settingsRows := scoreSettingsCoverage()
	dock, dockRows := scoreDockInteractivity()
	llm, llmRows := scoreLLMDispatch()
	pet, petRows := scorePetRelease()

	// --- Regression: contract drift must stay 0 ---
	distinct := len(contract.DistinctTools())
	health := 1.0
	if distinct > 0 && len(drift) > 0 {
		health = 1.0 - float64(len(drift))/float64(distinct)
	}

	// Composite primary (higher is better). Correctness is the behavioral core
	// and carries the most weight; the four structural enablers share the rest.
	productReadiness := 0.15*settings + 0.15*dock + 0.20*llm + 0.30*correctness + 0.20*pet

	fmt.Printf("METRIC assistant_product_readiness=%.4f\n", productReadiness)
	fmt.Printf("METRIC settings_coverage=%.4f\n", settings)
	fmt.Printf("METRIC dock_interactivity=%.4f\n", dock)
	fmt.Printf("METRIC llm_dispatch_wired=%.4f\n", llm)
	fmt.Printf("METRIC reply_correctness=%.4f\n", correctness)
	fmt.Printf("METRIC pet_release_wired=%.4f\n", pet)
	fmt.Printf("METRIC contract_drift=%d\n", len(drift))
	fmt.Printf("METRIC contract_health=%.4f\n", health)
	fmt.Printf("METRIC contract_tools=%d\n", distinct)
	fmt.Printf("METRIC wired_tools=%d\n", a.Registry().Count())
	fmt.Printf("METRIC routes_surface=%d\n", routesCount)

	if len(drift) > 0 {
		fmt.Printf("# DRIFT: contract references routes the project no longer serves: %s\n", strings.Join(drift, ", "))
	}

	fmt.Println("\n# assistant-product-bench — reply correctness (dimension 4, behavioral)")
	fmt.Printf("# %-22s %-7s %-7s  %-28s %s\n", "scenario", "req", "forbid", "classified", "verdict")
	for _, r := range correctRows {
		fmt.Printf("# %-22s %-7t %-7t  %-28s %s\n", r.id, r.reqOK, r.forbidOK, strings.Join(r.classified, "+"), r.verdict)
	}

	fmt.Println("\n# assistant-product-bench — structural dimensions")
	printRows("settings", settingsRows)
	printRows("dock", dockRows)
	printRows("llm", llmRows)
	printRows("pet", petRows)

	fmt.Printf("\n# product_readiness = %.2f%% (settings=%.1f%% dock=%.1f%% llm=%.1f%% correctness=%.1f%% pet=%.1f%%); contract_drift=%d\n",
		productReadiness, settings, dock, llm, correctness, pet, len(drift))
}

// --- correctness scoring -----------------------------------------------------

type correctnessRow struct {
	id         string
	classified []string
	reqOK      bool
	forbidOK   bool
	verdict    string
}

func scoreCorrectness(a *assistant.Assistant, routeSet map[string]bool) (float64, []correctnessRow) {
	rows := make([]correctnessRow, 0, len(correctnessScenarios))
	var passed int
	for _, sc := range correctnessScenarios {
		classified := a.Classify(sc.intent)
		// wired subset: tools that resolve to a real registered route.
		wired := make(map[string]bool)
		var wiredList []string
		for _, name := range classified {
			ts, ok := a.Resolve(name)
			if !ok {
				continue
			}
			if routeSet[ts.MethodPath()] {
				if !wired[name] {
					wiredList = append(wiredList, name)
				}
				wired[name] = true
			}
		}
		reqOK := true
		for _, t := range sc.required {
			if !wired[t] {
				reqOK = false
			}
		}
		forbidOK := true
		for _, t := range sc.forbidden {
			if wired[t] {
				forbidOK = false
			}
		}
		correct := reqOK && forbidOK
		// Out-of-scope (nil required) must classify nothing.
		if sc.required == nil && len(wiredList) > 0 {
			correct = false
		}
		verdict := "FAIL"
		if correct {
			passed++
			verdict = "ok"
		}
		rows = append(rows, correctnessRow{sc.id, wiredList, reqOK, forbidOK, verdict})
	}
	return 100.0 * float64(passed) / float64(len(correctnessScenarios)), rows
}

// --- structural scan helpers ------------------------------------------------

type feat struct {
	name string
	ok   bool
	note string
}

func dimensionScore(feats []feat) float64 {
	if len(feats) == 0 {
		return 0
	}
	var passed int
	for _, f := range feats {
		if f.ok {
			passed++
		}
	}
	return 100.0 * float64(passed) / float64(len(feats))
}

func printRows(label string, feats []feat) {
	fmt.Printf("# [%s] %.1f%% (%d/%d)\n", label, dimensionScore(feats), countOK(feats), len(feats))
	for _, f := range feats {
		mark := "x"
		if f.ok {
			mark = "v"
		}
		fmt.Printf("#   [%s] %-34s %s\n", mark, f.name, f.note)
	}
}

func countOK(feats []feat) int {
	var n int
	for _, f := range feats {
		if f.ok {
			n++
		}
	}
	return n
}

// readFile loads a source file relative to the repo root (the bench runs from
// the repo root via autoresearch.sh). A missing file yields "".
func readFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func contains(hay, needle string) bool {
	return strings.Contains(hay, needle)
}

func containsCI(hay, needle string) bool {
	return strings.Contains(strings.ToLower(hay), strings.ToLower(needle))
}

func containsAnyCI(hay string, needles []string) bool {
	for _, n := range needles {
		if containsCI(hay, n) {
			return true
		}
	}
	return false
}


// --- Dimension 1: Assistant settings entry (model, spritesheet, ...) --------

func scoreSettingsCoverage() (float64, []feat) {
	types := readFile("internal/config/types.go")
	settingsModal := readFile("web/static/settings/settings_modal.js")
	i18n := readFile("web/static/i18n.js")

	feats := []feat{
		{name: "config.Assistant type/section", ok: containsCI(types, "Assistant"), note: "internal/config/types.go"},
		{name: "config assistant model field", ok: containsCI(types, "Assistant") && containsCI(types, "Model"), note: "types.go: Assistant+Model"},
		{name: "config spritesheet path field", ok: containsAnyCI(types, []string{"Spritesheet", "SpriteSheet", "SheetPath", "SpritePath"}), note: "types.go"},
		{name: "settings modal assistant section", ok: containsCI(settingsModal, "assistant") || containsCI(settingsModal, "小精灵"), note: "settings_modal.js"},
		{name: "settings modal sprite/spritesheet UI", ok: containsAnyCI(settingsModal, []string{"spritesheet", "spriteSheet", "sprite-sheet"}), note: "settings_modal.js"},
		{name: "settings sidebar assistant row", ok: containsAnyCI(readFile("web/static/settings/settings.js"), []string{"openAssistantModal", "assistantSettings"}), note: "settings.js (settings-page left sidebar)"},
		{name: "i18n assistant-settings keys", ok: containsAnyCI(i18n, []string{"assistantSettings", "assistantModel", "assistantSprite"}), note: "i18n.js"},
	}
	return dimensionScore(feats), feats
}

// --- Dimension 2: Draggable dock (left/right/anywhere, persisted) -----------

func scoreDockInteractivity() (float64, []feat) {
	sprite := readFile("web/static/sprite.js")
	css := readFile("web/static/style.css")

	feats := []feat{
		{name: "dock element created", ok: contains(sprite, "sprite-dock"), note: "sprite.js"},
		{name: "dock mousedown drag start", ok: contains(sprite, "mousedown"), note: "sprite.js"},
		{name: "dock mousemove drag", ok: contains(sprite, "mousemove"), note: "sprite.js"},
		{name: "dock mouseup drag end", ok: contains(sprite, "mouseup"), note: "sprite.js"},
		{name: "dock position persisted", ok: contains(sprite, "localStorage"), note: "sprite.js"},
		{name: "drag state variable", ok: containsAnyCI(sprite, []string{"isDragging", "isDrag", "dragging"}), note: "sprite.js"},
		{name: "dock dynamic side/position set", ok: containsAnyCI(sprite, []string{"dock.style.left", "dock.style.right", "dockEl.style.left", "dockEl.style.right", "dock.style.top"}), note: "sprite.js: dock.style.*"},
		{name: "css dock not hard-pinned right", ok: !contains(css, ".sprite-dock {") || containsAnyCI(css, []string{".sprite-dock.dragging", ".sprite-dock.left", "sprite-dock[data-side"}), note: "style.css: dock side variant"},
	}
	return dimensionScore(feats), feats
}
// --- Dimension 3: LLM-assisted dispatch (model classifier + fallback) ------

func scoreLLMDispatch() (float64, []feat) {
	handler := readFile("internal/api/assistant/handler.go")
	types := readFile("internal/config/types.go")

	feats := []feat{
		{name: "llm_classifier.go exists", ok: fileExists("internal/assistant/llm_classifier.go"), note: "internal/assistant/"},
		{name: "handler calls LLM classifier", ok: containsAnyCI(handler, []string{"llm", "LLMClassifier", "Classifier", "ClassifyLLM"}), note: "handler.go"},
		{name: "keyword fallback present", ok: contains(handler, "Classify("), note: "handler.go: ast.Classify"},
		{name: "LLM uses /v1/chat/completions", ok: fileExists("internal/assistant/llm_classifier.go") && containsAnyCI(readFile("internal/assistant/llm_classifier.go"), []string{"chat/completions", "/v1/chat"}), note: "llm_classifier.go"},
		{name: "config assistant model for LLM", ok: containsCI(types, "Assistant") && containsCI(types, "Model"), note: "types.go"},
		{name: "schema exported for tool-calling", ok: fileExists("internal/api/assistant/schema.go"), note: "api/assistant/schema.go"},
	}
	return dimensionScore(feats), feats
}

// --- Dimension 5: Systray "release pet" wiring + soundness -------------------

func scorePetRelease() (float64, []feat) {
	host := readFile("host_webview_windows.go")
	petHTML := readFile("web/static/sprite-pet.html")

	feats := []feat{
		{name: "systray 释放 menu item", ok: contains(host, "释放"), note: "host_webview_windows.go"},
		{name: "openPetWindow function", ok: contains(host, "openPetWindow"), note: "host"},
		{name: "borderless (wsPopup)", ok: contains(host, "wsPopup"), note: "host"},
		{name: "topmost window", ok: containsAnyCI(host, []string{"HWND_TOPMOST", "^uintptr(0)", "topmost", "HWND_TOPMOST"}), note: "host"},
		{name: "navigate to pet page", ok: contains(host, "sprite-pet.html"), note: "host"},
		{name: "sprite-pet.html exists", ok: fileExists("web/static/sprite-pet.html"), note: "web/static/"},
		{name: "pet page dispatch wired", ok: contains(petHTML, "/api/assistant/dispatch"), note: "sprite-pet.html"},
		{name: "host binds movePetWindow", ok: contains(host, "movePetWindow"), note: "host"},
		{name: "host binds closePetWindow", ok: contains(host, "closePetWindow"), note: "host"},
		{name: "pet window transparency", ok: containsAnyCI(host, []string{"SetLayeredWindowAttributes", "wsExLayered", "put_DefaultBackgroundColor", "DefaultBackgroundColor", "LWA_COLORKEY", "DwmExtendFrameIntoClientArea"}), note: "host: transparent bg"},
		{name: "pet uses spritesheet asset", ok: containsAnyCI(petHTML, []string{"spritesheet", "sprite.png", "drawImage", "background-position"}), note: "sprite-pet.html"},
		{name: "pet page drag (mousemove)", ok: contains(petHTML, "mousemove") || contains(petHTML, "movePetWindow"), note: "sprite-pet.html"},
	}
	return dimensionScore(feats), feats
}

// --- real route set construction (mirrors cmd/assistant-bench) --------------

// buildRealRouteSet constructs the real *api.Router in-process (mirroring the
// package's test harness, but with password protection off) and walks its chi
// router to collect the canonical "METHOD path" set of every registered /v1/*
// and /api/* route. No network, no live server.
func buildRealRouteSet() (map[string]bool, int, error) {
	cfg := config.DefaultConfig()
	cfg.Security = config.SecurityConfig{PasswordEnabled: false}
	cfg.Providers = []config.Provider{
		{
			ID: "bench-prov", Name: "Bench", Prefix: "bench", BaseURL: "https://api.bench.invalid",
			APIType: "openai-compatible", IsActive: true,
			Keys: []config.Key{{ID: "k1", Key: "sk-bench", Name: "Main", Priority: 1, IsActive: true}},
		},
	}

	tmpDir, err := os.MkdirTemp("", "assistant-product-bench-*")
	if err != nil {
		return nil, 0, fmt.Errorf("mkdir temp: %w", err)
	}
	defer os.RemoveAll(tmpDir)
	configPath := filepath.Join(tmpDir, "config.yaml")

	reg := registry.New(cfg)
	logger := console.New(100)
	usageBuf := usage.New(100)
	selector := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	proxyHandler := proxy.New(reg, selector, comboRes, usageBuf, usage.NewQuotaTracker(), logger, 0)
	apiRouter := api.New(
		reg, cfg, configPath, usageBuf, usage.New(50), usage.NewQuotaTracker(), logger,
		proxyHandler, context.CancelFunc(func() {}), selector, comboRes,
		download.NewManager(download.RuntimeSettings{}, logger),
	)
	handler := apiRouter.Routes(proxyHandler)

	cr, ok := handler.(chi.Router)
	if !ok {
		return nil, 0, fmt.Errorf("router is not a chi.Router (got %T)", handler)
	}

	routeSet := make(map[string]bool)
	var count int
	walkErr := chi.Walk(cr, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		p := assistant.NormalizePath(route)
		if !strings.HasPrefix(p, "/v1/") && !strings.HasPrefix(p, "/api/") {
			return nil
		}
		if method == http.MethodOptions || method == http.MethodHead {
			return nil
		}
		routeSet[method+" "+p] = true
		count++
		return nil
	})
	if walkErr != nil {
		return nil, 0, fmt.Errorf("walk routes: %w", walkErr)
	}
	return routeSet, count, nil
}
