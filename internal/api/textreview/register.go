// Package textreview provides HTTP handlers for the AI text-review API:
// the processing-node pool, chapter split patterns, the built-in default
// cleanup prompt (P1), and the session/scheduling endpoints that drive the
// in-process text-review engine (P2).
package textreview

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	tr "github.com/tinyrouter/tinyrouter/internal/textreview"
)

// defaultCleanSystemPrompt is the built-in cleanup prompt returned by
// /prompt-default, transplanted from novelhelper (v2 M1_CLEAN_SYSTEM_PROMPT).
// 在原 v2 prompt 基础之上追加「输出格式（多章分段）」要求：对应 novelhelper
// 批处理协议（docs/M1_text_cleaning.md §3.3：系统提示词附严格指令——必须返回
// N 段、保留 ===CHAPTER_ID:=== 标记、不得合并/遗漏）与 proxy_call.go 中
// batchInstruction 的既有分段协议，确保模型按章节标记分段输出。
const defaultCleanSystemPrompt = `你是一位专业的小说文本编辑。你拿到的章节来自网络流传的 TXT 文件，发布渠道在正文中植入了大量推广 QQ 群的广告杂讯。你的任务是清除杂讯、尽可能恢复作者原文。

## 先理解杂讯的原理（这决定你能否识别没见过的变种）

这些杂讯不是写给人眼看的，而是针对"听书"（TTS 朗读）的：人眼阅读时会自动跳过乱字符并在脑内复原句子，但朗读软件会把它们逐字念出来——广告商利用这一点，把 QQ 群号用"念出来同音"的各种写法拆碎混进正文，让听书的读者听到群号；同时夹入不会被念出来的符号与不可见字符作干扰。由此可知杂讯的两个特征：
- 删掉它，句子恢复通顺；留着它，朗读会被打断——满足这一条的就是杂讯；
- 数字会以任意"同音/同形"写法出现：阿拉伯与全角数字（371、８９３）、汉字大小写（三七一、叁柒壹）、谐音字（吆=1 贰=2 伞=3 肆寺似=4 柳遛=6 柒漆气=7 扒吧疤=8 玖久韭=9 邻零=0）、带圈/带括号数字（②、⒍、（一））、拼音（jiu、ba、liu）、罗马数字（IX）；"群/说/小"等关键词写作变体字（羣峮裙囷宭、説裞、仦）。

## 删除规则

1. 整块广告：加群邀请、网盘链接与密码、群号列表、盗版声明（如【本作品来自互联网…】）、阅读 App 推广、<img> 等 HTML 标签，整段删除。
2. 句中穿插的群号碎片与符号杂讯：连同夹带的变体字、多余空格一起删除；碎片常把词语或人名从中间劈开，删除后必须把词语复原——
   例：「毛小説羣89利兰」→「毛利兰」；「公  3气1漆平竞（二）9吆伊9争」→「公平竞争」。
3. 行首藏号：连续多行的行首各多出一个无关字符（纵向连读是群号或广告词）时，逐行删除该行首字符。
4. 平台水印：如「（看暴爽小说，就上飞卢小说网！）」这类嵌在句中的括注，整段删除；注意与作者本人的括号旁白区分（旁白与情节相关，水印与情节无关）。
5. 格式：把 3 行以上的连续空行压缩为 1 行，其余不改变段落结构。

## 默读测试（拿不准时的判定法）

把句子在心里默读一遍：跳过该字符串后句子才通顺、且它与情节无关，删；它是句子的有机组成部分，保留。

## 保留红线（错删比漏删严重）

- 不改写、不润色：不改变作者的用词、标点与风格。半角省略号「...」、破折号、拟声词、重复标点（"痛痛痛痛！"）都是作者文风，原样保留。
- 正文里的真实数字（"一千八百万次""十六岁""明天8k"）不是杂讯，保留。
- 成片的"乱码状文字"若删掉后句子出现缺口（说明它占位着原文，是编码损坏），原样保留，不要尝试修复或删除。
- 作者本人的话：ps 求票、请假说明、求鲜花等，原样保留。
- 有任何疑问时保留原文。

## 输出格式（多章分段）

一次请求可能包含多个章节，也可能只有一个章节：
- 多章时：正文必须按输入顺序逐章分段输出。每段以 ===CHAPTER_ID:章节序号=== 开头（与输入中的标记一致，不得改动），段与段之间用 <<<|||CHAPTER_SEP|||>>> 分隔。输出段数必须与输入章数完全一致，逐章一一对应，不得合并、遗漏或调换章节。
- 单章时：直接输出该章清理后的正文，不添加任何标记或格式包装。

直接输出清理后的正文，不附加任何解释。`

// Handler wires up the text-review configuration routes. P2 adds session/
// scheduling endpoints backed by a lazily-constructed Engine.
type Handler struct {
	d       *apibase.Deps
	engine  *tr.Engine
	cleaner tr.Cleaner // optional test injection; nil uses the real ProxyCleaner
}

// NewHandler creates a new text-review Handler bound to the given deps.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// SetCleanerForTest injects a fake Cleaner for unit testing the session
// endpoints without a live proxy. Production code never calls this.
func (h *Handler) SetCleanerForTest(c tr.Cleaner) { h.cleaner = c }

// engineOnce lazily builds the Engine on first use. The cleaner defaults to a
// ProxyCleaner bound to the deps; tests override via SetCleanerForTest.
func (h *Handler) engineOnce() *tr.Engine {
	if h.engine != nil {
		return h.engine
	}
	cleaner := h.cleaner
	if cleaner == nil {
		cleaner = tr.NewProxyCleaner(h.d)
	}
	h.engine = tr.NewEngine(cleaner, NewRegistryPersister(h.d), h.d.Logger)
	return h.engine
}

// Register registers the text-review routes on the given router. The caller
// mounts this handler under the /api/text-review group (auth-gated, 32 MiB
// body limit), so the routes resolve at:
//
//	GET    /api/text-review/review-nodes          list the processing-node pool
//	POST   /api/text-review/review-nodes          upsert a node (create if no ID, update if ID)
//	DELETE /api/text-review/review-nodes/{id}     delete a node
//	GET    /api/text-review/split-patterns        list chapter-detection patterns
//	POST   /api/text-review/split-patterns        upsert a pattern (by key)
//	DELETE /api/text-review/split-patterns/{key}  delete a pattern
//	GET    /api/text-review/prompt-default        built-in default cleanup prompt
//	POST   /api/text-review/sessions              create + start a review session
//	GET    /api/text-review/sessions/{id}         full session snapshot
//	GET    /api/text-review/sessions/{id}/events SSE live stream (chunks + status)
//	POST   /api/text-review/sessions/{id}/pause  pause the dispatcher
//	POST   /api/text-review/sessions/{id}/resume resume the dispatcher
//	POST   /api/text-review/sessions/{id}/chapters/{idx}/reprocess  re-clean one chapter
//	DELETE /api/text-review/sessions/{id}   cancel + remove a session
func (h *Handler) Register(r chi.Router) {
	r.Get("/review-nodes", h.listReviewNodes)
	r.Post("/review-nodes", h.upsertReviewNode)
	r.Delete("/review-nodes/{id}", h.deleteReviewNode)

	r.Get("/split-patterns", h.listSplitPatterns)
	r.Post("/split-patterns", h.upsertSplitPattern)
	r.Delete("/split-patterns/{key}", h.deleteSplitPattern)

	r.Get("/prompt-default", h.getPromptDefault)
	r.Post("/prompt-default", h.savePromptDefault)

	// Sessions + scheduling (P2).
	r.Post("/sessions", h.createSession)
	r.Get("/sessions/{id}", h.getSession)
	r.Get("/sessions/{id}/events", h.sessionEvents)
	r.Post("/sessions/{id}/pause", h.pauseSession)
	r.Post("/sessions/{id}/resume", h.resumeSession)
	r.Post("/sessions/{id}/stop", h.stopSession)
	r.Post("/sessions/{id}/chapters/{idx}/reprocess", h.reprocessChapter)
	r.Delete("/sessions/{id}", h.deleteSession)
	r.Post("/clear", h.clearAllSessions)
}

// listReviewNodes returns the text-review processing-node pool.
// GET /api/text-review/review-nodes
func (h *Handler) listReviewNodes(w http.ResponseWriter, r *http.Request) {
	nodes := h.d.Reg.ListTextReviewNodes()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"nodes": nodes})
}

// upsertReviewNode handles both create (no ID) and update (with ID) operations.
// POST /api/text-review/review-nodes
func (h *Handler) upsertReviewNode(w http.ResponseWriter, r *http.Request) {
	var n config.TextReviewNode
	if err := json.NewDecoder(r.Body).Decode(&n); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	if n.ID == "" {
		// Create
		n.ID = apibase.GenerateID("trn")
		h.d.Reg.AddTextReviewNode(n)
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{"node": n})
	} else {
		// Update
		if h.d.Reg.UpdateTextReviewNode(n.ID, n) {
			cfg := h.d.Reg.Config()
			if err := h.d.SaveConfig(&cfg); err != nil {
				apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"ok": true})
		} else {
			apibase.WriteAPIError(w, http.StatusNotFound, "review node not found")
		}
	}
}

// deleteReviewNode deletes a text-review node by ID.
// DELETE /api/text-review/review-nodes/{id}
func (h *Handler) deleteReviewNode(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if h.d.Reg.DeleteTextReviewNode(id) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "review node not found")
	}
}

// listSplitPatterns returns the chapter-detection split patterns.
// GET /api/text-review/split-patterns
func (h *Handler) listSplitPatterns(w http.ResponseWriter, r *http.Request) {
	patterns := h.d.Reg.ListSplitPatterns()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"patterns": patterns})
}

// upsertSplitPattern handles upsert-by-key: if a pattern with the given key
// exists it is updated, otherwise a new one is created. A non-empty key is
// required (it is the pattern's stable identifier).
// POST /api/text-review/split-patterns
func (h *Handler) upsertSplitPattern(w http.ResponseWriter, r *http.Request) {
	var p config.SplitPattern
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if p.Key == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "key is required")
		return
	}

	created := !h.d.Reg.UpdateSplitPattern(p.Key, p)
	if created {
		h.d.Reg.AddSplitPattern(p)
	}
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfig(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if created {
		w.WriteHeader(http.StatusCreated)
	}
	json.NewEncoder(w).Encode(map[string]any{"pattern": p})
}

// deleteSplitPattern deletes a split pattern by key.
// DELETE /api/text-review/split-patterns/{key}
func (h *Handler) deleteSplitPattern(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if h.d.Reg.DeleteSplitPattern(key) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "split pattern not found")
	}
}

// getPromptDefault returns the active default cleanup system prompt and the built-in fallback prompt.
// GET /api/text-review/prompt-default
func (h *Handler) getPromptDefault(w http.ResponseWriter, r *http.Request) {
	prompt := h.d.Reg.GetTextReviewPrompt()
	if prompt == "" {
		prompt = defaultCleanSystemPrompt
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"systemPrompt":  prompt,
		"builtinPrompt": defaultCleanSystemPrompt,
	})
}

type savePromptRequest struct {
	SystemPrompt string `json:"systemPrompt"`
}

// savePromptDefault updates the default cleanup system prompt and persists it to config.yaml.
// POST /api/text-review/prompt-default
func (h *Handler) savePromptDefault(w http.ResponseWriter, r *http.Request) {
	var req savePromptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	h.d.Reg.SetTextReviewPrompt(req.SystemPrompt)
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfig(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	effective := req.SystemPrompt
	if effective == "" {
		effective = defaultCleanSystemPrompt
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":            true,
		"systemPrompt":  effective,
		"builtinPrompt": defaultCleanSystemPrompt,
	})
}
