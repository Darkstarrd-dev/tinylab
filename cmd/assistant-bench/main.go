// Command assistant-bench measures TinyLab's "小精灵" assistant dispatch
// readiness under a CONTRACT-DRIVEN design: the assistant's capability
// knowledge comes solely from internal/assistant/semantics.json (the
// contract), not hand-maintained Go code. The bench constructs the real
// *api.Router in-process, walks its chi routes (the ground truth of what the
// project actually exposes), and intersects the contract with that route set.
//
// A contract rule only "wires" if its (method, path) is a real registered
// route; rules referencing removed routes are reported as drift — a sync
// violation. The score is the mean per-intent F1 (precision×recall over the
// ground-truth tool set), gated on model routing and scheduled jobs, multiplied
// by a contract-health factor (1 − drift fraction): a drifted contract breaks
// the assistant, so readiness cannot reach 100% while the contract is out of
// sync with the project.
//
// Output (stdout): one METRIC line per metric, then a per-intent breakdown.
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

	"github.com/tinylab/tinylab/internal/api"
	"github.com/tinylab/tinylab/internal/assistant"
	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/download"
	"github.com/tinylab/tinylab/internal/proxy"
	"github.com/tinylab/tinylab/internal/registry"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/usage"
)

// scenario is one fixed user intent the assistant must dispatch. required is
// the ground-truth set of tools (the judge's answer key); the assistant never
// sees it. needsModel gates on the model-routing layer. scheduledJob, when
// non-empty, requires that job registered for full credit (else capped at
// half). An empty required set marks an out-of-scope intent: it scores
// perfectly only when the assistant classifies nothing (precision guard).
type scenario struct {
	id           string
	intent       string
	required     []string
	needsModel   bool
	scheduledJob string
}

// scenarios is the deterministic workload (segment 3: contract-driven). 30
// intents spanning single/multi-step, CN+EN, scheduled maintenance,
// new-capability (providers/monitor/filetransfer/gallery/probe), alternate
// phrasings, and an out-of-scope precision guard.
var scenarios = []scenario{
	{id: "gen_image", intent: "帮我生成一张猫的图片", required: []string{"image.generate"}, needsModel: true},
	{id: "draw_image", intent: "帮我画一张夕阳的图", required: []string{"image.generate"}, needsModel: true},
	{id: "gen_image_batch", intent: "批量生成10张风景图", required: []string{"imagebatch.create"}, needsModel: true},
	{id: "edit_image", intent: "把这张图片编辑一下", required: []string{"image.edit"}, needsModel: true},
	{id: "write_doc_save", intent: "写一篇关于猫的文档并保存", required: []string{"editor.save"}},
	{id: "open_doc", intent: "打开我的笔记文件", required: []string{"editor.open"}},
	{id: "list_docs", intent: "看看文档目录里有什么", required: []string{"editor.tree"}},
	{id: "download_video", intent: "下载这个视频", required: []string{"download.create"}},
	{id: "video_info", intent: "查一下这个链接的视频信息", required: []string{"download.info"}},
	{id: "web_search", intent: "搜索一下最新的AI新闻", required: []string{"anysearch.search"}},
	{id: "web_extract", intent: "提取这个网页的正文", required: []string{"anysearch.extract"}},
	{id: "chat", intent: "和我聊聊今天的天气", required: []string{"chat"}, needsModel: true},
	{id: "embeddings", intent: "给这段文字生成向量", required: []string{"embeddings"}, needsModel: true},
	{id: "archive_pack", intent: "把这些文件打包成压缩包", required: []string{"archive.pack"}},
	{id: "text_review", intent: "帮我润色这篇小说", required: []string{"textreview.session"}},
	{id: "clean_logs", intent: "定时清理过期的日志", required: []string{"trace.clear"}, scheduledJob: "clean-traces"},
	{id: "gen_image_then_doc", intent: "先生成一张猫的图片，然后写一篇关于猫的文档并保存", required: []string{"image.generate", "editor.save"}, needsModel: true},
	{id: "tidy_traces_daily", intent: "每隔一天清理一次旧trace记录", required: []string{"trace.clear"}, scheduledJob: "clean-traces-daily"},

	{id: "list_providers", intent: "看看我配置了哪些provider", required: []string{"providers.list"}},
	{id: "view_monitor", intent: "看看当前的用量监控", required: []string{"monitor.view"}},
	{id: "view_quotas", intent: "查一下各模型的配额", required: []string{"monitor.quotas"}},
	{id: "upload_file", intent: "上传一个文件到本地", required: []string{"filetransfer.upload"}},
	{id: "convert_tiff", intent: "把这个tiff转一下格式", required: []string{"gallery.convert"}},
	{id: "probe_key", intent: "测试一下这个provider的key", required: []string{"probe.test"}},

	{id: "en_gen_image", intent: "generate an image of a cat", required: []string{"image.generate"}, needsModel: true},
	{id: "en_download", intent: "download this video", required: []string{"download.create"}},
	{id: "en_search", intent: "search the web for AI news", required: []string{"anysearch.search"}},

	{id: "make_image", intent: "帮我做个猫的图", required: []string{"image.generate"}, needsModel: true},
	{id: "save_alt", intent: "把这篇文章存档", required: []string{"editor.save"}},

	{id: "out_of_scope", intent: "今天几号了", required: nil},
}

func main() {
	routeSet, routesCount, err := buildRealRouteSet()
	if err != nil {
		fmt.Fprintf(os.Stderr, "assistant-bench: failed to build route set: %v\n", err)
		os.Exit(1)
	}

	// The assistant learns its capabilities SOLELY from the contract
	// (semantics.json), intersected with the real route set. The model-routing
	// layer is wired (constructed in buildRealRouteSet), so model intents are
	// eligible.
	contract, err := assistant.LoadContract()
	if err != nil {
		fmt.Fprintf(os.Stderr, "assistant-bench: load contract: %v\n", err)
		os.Exit(1)
	}
	a, drift := contract.BuildAssistant(routeSet, true /* model routing wired */)

	type row struct {
		scenario   scenario
		classified []string
		wired      []string
		precision  float64
		recall     float64
		f1         float64
		note       string
	}
	rows := make([]row, 0, len(scenarios))
	var sum float64
	var passedCount int

	for _, sc := range scenarios {
		classified := a.Classify(sc.intent)

		// wired: subset of classified tools that resolve to a REAL route.
		var wired []string
		for _, name := range classified {
			ts, ok := a.Resolve(name)
			if !ok {
				continue
			}
			if routeSet[ts.MethodPath()] {
				wired = append(wired, name)
			}
		}

		reqSet := setOf(sc.required)
		wiredSet := setOf(wired)
		var correctAndWired int
		for t := range wiredSet {
			if reqSet[t] {
				correctAndWired++
			}
		}

		var precision, recall, f1 float64
		if len(sc.required) == 0 {
			// Out-of-scope intent: perfect iff the assistant classifies
			// nothing (no false-positive tools).
			if len(classified) == 0 {
				f1 = 1.0
			}
		} else {
			if len(classified) > 0 {
				precision = float64(correctAndWired) / float64(len(classified))
			}
			recall = float64(correctAndWired) / float64(len(sc.required))
			if precision+recall > 0 {
				f1 = 2 * precision * recall / (precision + recall)
			}
		}

		note := ""
		if sc.needsModel && !a.HasModelRoute() {
			f1 = 0
			note = "model-route missing"
		}
		if sc.scheduledJob != "" && !a.Scheduler().Has(sc.scheduledJob) {
			f1 *= 0.5
			note = "job '" + sc.scheduledJob + "' not registered"
		}
		if note == "" && f1 == 1.0 {
			note = "ok"
		} else if note == "" && f1 == 0 && len(sc.required) == 0 {
			note = "over-fired (precision)"
		} else if note == "" {
			note = "miss"
		}

		sum += f1
		if f1 == 1.0 {
			passedCount++
		}
		rows = append(rows, row{sc, classified, wired, precision, recall, f1, note})
	}

	meanF1 := sum / float64(len(scenarios))
	// Contract health: a drifted contract (rules referencing removed routes)
	// breaks the assistant, so readiness cannot reach 100% while out of sync.
	distinct := len(contract.DistinctTools())
	health := 1.0
	if distinct > 0 && len(drift) > 0 {
		health = 1.0 - float64(len(drift))/float64(distinct)
	}
	readiness := meanF1 * 100.0 * health

	fmt.Printf("METRIC assistant_readiness=%.4f\n", readiness)
	fmt.Printf("METRIC scenarios_passed=%d\n", passedCount)
	fmt.Printf("METRIC scenarios_total=%d\n", len(scenarios))
	fmt.Printf("METRIC dispatch_f1=%.4f\n", meanF1*100.0)
	fmt.Printf("METRIC contract_health=%.4f\n", health)
	fmt.Printf("METRIC contract_drift=%d\n", len(drift))
	fmt.Printf("METRIC contract_tools=%d\n", distinct)
	fmt.Printf("METRIC wired_tools=%d\n", a.Registry().Count())
	fmt.Printf("METRIC scheduled_jobs=%d\n", a.Scheduler().Count())
	fmt.Printf("METRIC routes_surface=%d\n", routesCount)

	if len(drift) > 0 {
		fmt.Printf("# DRIFT: contract references routes the project no longer serves: %s\n", strings.Join(drift, ", "))
	}

	// Breakdown for iteration debugging.
	fmt.Println("\n# assistant-bench dispatch breakdown")
	fmt.Printf("# %-20s %5s %5s %5s  %-28s %s\n", "scenario", "prec", "rec", "f1", "classified", "note")
	for _, r := range rows {
		fmt.Printf("# %-20s %5.2f %5.2f %5.2f  %-28s %s\n",
			r.scenario.id, r.precision, r.recall, r.f1,
			strings.Join(r.classified, "+"), r.note)
	}
	fmt.Printf("# readiness = %.2f%% (dispatch_f1=%.2f%% × contract_health=%.2f; %d/%d intents exact)\n",
		readiness, meanF1*100.0, health, passedCount, len(scenarios))
}

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

	tmpDir, err := os.MkdirTemp("", "assistant-bench-*")
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

func setOf(items []string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, x := range items {
		m[x] = true
	}
	return m
}
