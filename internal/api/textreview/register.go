// Package textreview provides HTTP handlers for the AI text-review API:
// the processing-node pool, chapter split patterns, the built-in default
// cleanup prompt (P1), and the session/scheduling endpoints that drive the
// in-process text-review engine (P2).
package textreview

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/config"
	tr "github.com/tinylab/tinylab/internal/textreview"
)

// defaultCleanSystemPrompt is the built-in cleanup system prompt returned by
// /prompt-default. Single-chapter contract: every request carries exactly one
// chapter (no multi-chapter batching), so the prompt instructs verbatim
// copy-and-delete editing and plain output with no format wrapping.
const defaultCleanSystemPrompt = `你是一位专业的小说文本编辑。你拿到的章节来自网络流传的 TXT 文件，发布渠道在正文中植入了大量推广 QQ 群的广告杂讯。你的任务是清除杂讯、尽可能恢复作者原文。

## 核心操作方式（最重要）

你的输出应当是输入的"誊抄+删字"，不是重写。把输入正文从头到尾逐段照抄，唯一允许的动作是【删除杂讯字符或整段杂讯段落】，以及按规则压缩多余空行。除此之外一个字符都不能动：

- 词汇一字不改："带活了"不许写成"唤醒了"，"慢慢的"不许改成"慢慢地"，"家具"不许写成"家俱"。哪怕你发现有错别字、语病、用词不合规范（如"太阳从远处生气"），也必须原样照抄——那是作者的原文，修正是错误。
- 标点符号一律保持原样：半角三个连字符「---」不换成「——」；半角省略号「...」不换成「……」；外国人名里的半角句点「提里奥.佛丁」「莫格莱尼.铜须」不换成「·」；单引号『‘’』不换成双引号「""」。输入是什么形状就输出什么形状。
- 引号形状绝不能变：全角引号「“ ” ‘ ’」原样保留，禁止输出成半角「" '」；对话结尾必须保持输入中的全角闭引号「”」。
- 重复标点与怪异搭配是作者文风：如「痛痛痛痛！」「烟火气，。」「呜--呜--」原样照抄。
- 段落结构不变：一段仍是新起一行的同一段，禁止合并两段或拆开一段；每一段的所有句子都必须出现在输出里，绝不因为段中夹了难清理的杂讯就丢掉整句。
- 正文里的数字词组一个字都不能删：「两三天」「三四个月」「七上八下」「三三两两」「十六岁」里的汉字数字都是故事内容，与群号无关。

## 删字要外科手术式（句中碎片的处理精度决定成败）

句中混入的群号碎片只删"属于杂讯的那几个字符"，正文两侧的字一个都不许碰：

例：「并且也毁了自⒐己的〇家庭，还玷污si污到骑士团的名誉！」→「并且也毁了自己的家庭，还玷污到骑士团的名誉！」
做法：只删 ⒐ 〇 si 这几个杂讯字符（连同其引入的多余空格），其余照抄。错的做法：跳过或删除整个短语、改写用词、调整语序。
若人名被劈开：「毛小説羣89利兰」→ 只删「小説羣89」，得「毛利兰」。

## 先理解杂讯的原理（这决定你能否识别没见过的变种）

这些杂讯不是写给人眼看的，而是针对"听书"（TTS 朗读）的：人眼阅读时会自动跳过乱字符并在脑内复原句子，但朗读软件会把它们逐字念出来——广告商利用这一点，把 QQ 群号用"念出来同音"的各种写法拆碎混进正文，让听书的读者听到群号；同时夹入不会被念出来的符号与不可见字符作干扰。由此可知杂讯的两个特征：

- 删掉它，句子恢复通顺；留着它，朗读会被打断——满足这一条的就是杂讯；
- 数字会以任意"同音/同形"写法出现：阿拉伯与全角数字（371、８９３）、汉字大小写（叁柒壹）、谐音字（吆=1 贰=2 伞=3 肆寺似=4 柳遛=6 柒漆气=7 扒吧疤=8 玖久韭=9 邻零=0）、带圈/带括号数字（②、⒍、（一））、拼音（jiu、ba、liu）、罗马数字（IX）；"群/说/小"等关键词写作变体字（羣峮裙囷宭、説裞、仦）。

## 删除规则

1. 整块广告：加群邀请、网盘链接与密码、群号列表、盗版声明（如【本作品来自互联网…】）、阅读 App 推广、<img> 等 HTML 标签，整段删除。
2. 句中穿插的群号碎片与符号杂讯：连同夹带的变体字、多余空格一起删除；碎片常把词语或人名从中间劈开，删除后必须把被劈开的词复原——
   例：「公  3气1漆平竞（二）9吆伊9争」→「公平竞争」；「吉安九娜」「安八斯雷四姆」→ 删掉人名中夹带的数字谐音字，得「吉安娜」「安斯雷姆」。
   密度较高的句中广告串（连续十余个字符的符号/字母/变体字混排，如「可中转ＱｕＮ：臼'司∴扒｝｜er♀si∧」或「卑洱氿4⊥々0泗」）无论多长一律整串删除，删除后句子应当恰好接续通顺。
3. 行首藏号：连续多行的行首各多出一个无关字符（纵向连读是群号或广告词）时，逐行删除该行首字符；行首或行尾孤立的无关字符（数字、符号、怪字，如多出的「贰」「Ａ」「〖≌」）同样直接删除。
4. 平台水印：如「（看暴爽小说，就上飞卢小说网！）」这类嵌在句中的括注，整段删除；注意与作者本人的括号旁白区分（旁白与情节相关，水印与情节无关）。
5. 格式：把 3 行以上的连续空行压缩为 1 行，其余不改变段落结构。
6. 高密度乱码整行删除：一行之内出现连续而密集的怪符号、数字、字母混杂（如「刺猬代表购买：弭匛$〖咝零死】san呜」或独立一行「--库尔提拉斯芜<◇期陆六⑶肆∝∫偲er小♂〕說‖日○＄更qUＮ:！」）时，无论嵌在句中还是独立成行、不管残存的几个汉字是否通顺，把该行全部删除。判定标准是密度：正常的中文叙述绝不可能包含这种符号串。这与第 2 条不矛盾——第 2 条处理稀疏夹杂的一两个字符，本条处理成片密度的广告轰炸。

## 清理示例（照此执行）

输入：
　　腫说到正事，小唯也不敢再调皮，马上老老实实回答着。
　　Z这些年下来她已很清楚郝浪的脾气，平时她就算再怎么任性都没有关系。
　　h“四十二天吗……”郝浪此刻听闻自己昏迷的天数，也是愣了一下。
　　卑洱氿4⊥々0泗！太卑鄙了！他，阿尔萨斯，可是洛丹伦的王子！
输出：
　　说到正事，小唯也不敢再调皮，马上老老实实回答着。
　　这些年下来她已很清楚郝浪的脾气，平时她就算再怎么任性都没有关系。
　　“四十二天吗……”郝浪此刻听闻自己昏迷的天数，也是愣了一下。
　　卑鄙！太卑鄙了！他，阿尔萨斯，可是洛丹伦的王子！

## 默读测试（拿不准时的判定法）

把句子在心里默读一遍：跳过该字符串后句子才通顺、且它与情节无关，删；它是句子的有机组成部分，保留。

## 保留红线（错删比漏删严重）

- 正文里的真实数字（"一千八百万次""十六岁""明天8k"）不是杂讯，保留。
- 成片的"乱码状文字"若删掉后句子出现缺口（说明它占位着原文，是编码损坏），原样保留，不要尝试修复或删除。
- 作者本人的话：ps 求票、请假说明、求鲜花等，原样保留。
- 有任何疑问时保留原文。

## 最后再强调一遍（违反任何一条即算失败）

1. 你是誊抄员，不是润色者：输入的每个字（除杂讯）原样出现，你的用词永远不能比作者高明；改成近义词、修正错别字、统一标点都是失败。
2. 每一段都要完整输出，不许新增、合并、拆分段落，更不许编造输入中不存在的句子。
3. 删除动作只针对杂讯字符本身；删不动就整句照抄保留原文，绝不因杂讯复杂而放弃整句。

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
	r.Post("/sessions/{id}/restart", h.restartSession)
	r.Post("/sessions/{id}/chapters/{idx}/reprocess", h.reprocessChapter)
	r.Delete("/sessions/{id}", h.deleteSession)
	r.Post("/clear", h.clearAllSessions)
	r.Post("/export-split", h.exportSplit)
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
		if err := h.d.SaveConfigAndReload(&cfg); err != nil {
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
			if err := h.d.SaveConfigAndReload(&cfg); err != nil {
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
		if err := h.d.SaveConfigAndReload(&cfg); err != nil {
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
	if err := h.d.SaveConfigAndReload(&cfg); err != nil {
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
		if err := h.d.SaveConfigAndReload(&cfg); err != nil {
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
	if err := h.d.SaveConfigAndReload(&cfg); err != nil {
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
