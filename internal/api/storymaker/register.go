// Package storymaker implements the Story Maker utility API endpoints.
package storymaker

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/storymaker"
)

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func timestampNow() int64 {
	return time.Now().UnixMilli()
}

// Handler manages storymaker HTTP endpoints.
type Handler struct {
	d     *apibase.Deps
	Store *storymaker.Store
}

// NewHandler constructs a storymaker API handler.
func NewHandler(d *apibase.Deps, s *storymaker.Store) *Handler {
	return &Handler{
		d:     d,
		Store: s,
	}
}

// Register wires all storymaker endpoints onto the router.
func (h *Handler) Register(r chi.Router) {
	// Book management
	r.Get("/books", h.getBooks)
	r.Post("/books", h.createBook)
	r.Patch("/books/{id}", h.patchBook)
	r.Delete("/books/{id}", h.deleteBook)
	r.Get("/books/{id}/export", h.exportBook)

	// Outline
	r.Get("/outline", h.getOutline)
	r.Post("/outline:append", h.appendOutline)

	// AI Generation - M0
	r.Post("/arch-input", h.generateArchInput)
	r.Post("/arch", h.generateArch)
	r.Post("/blueprint", h.generateBlueprint)

	// AI Generation - M2
	r.Post("/extract-entities", h.extractEntities)
	r.Post("/generate-card", h.generateCard)
	r.Post("/card-profiles", h.generateCardProfiles)
	r.Post("/generate-cards-batch", h.generateCardsBatch)
	r.Post("/card-image-prompts", h.generateCardImagePrompts)

	// AI Generation - M3 & M4
	r.Post("/simulate", h.simulateCharacter)
	r.Post("/draft", h.generateDraft)

	// AI Generation - M5
	r.Post("/finalize", h.finalizeChapter)
	r.Post("/consistency", h.checkConsistency)

	// Role Chat
	r.Post("/chat", h.roleChat)

	// Prompts override registry
	r.Get("/prompts/{key}", h.getPrompt)
	r.Put("/prompts/{key}", h.putPrompt)

	// Cards
	r.Get("/cards", h.getCards)
	r.Post("/cards", h.saveCard)
	r.Delete("/cards/{id}", h.deleteCard)

	// Chapters
	r.Get("/chapters", h.getChapters)
	r.Post("/chapters", h.saveChapter)
	r.Patch("/chapters/{id}", h.patchChapter)
	r.Delete("/chapters/{id}", h.deleteChapter)

	// Architecture
	r.Get("/architecture", h.getArchitecture)
	r.Post("/architecture", h.saveArchitecture)

	// Scenes & Fragments
	r.Get("/scenes", h.getScenes)
	r.Post("/scenes", h.saveScene)
	r.Delete("/scenes/{id}", h.deleteScene)
	r.Get("/fragments", h.getFragments)
	r.Post("/fragments", h.saveFragment)
	r.Delete("/fragments/{id}", h.deleteFragment)

	// Issues & State Events
	r.Get("/issues", h.getIssues)
	r.Patch("/issues/{id}", h.patchIssue)
	r.Get("/state-events", h.getStateEvents)

	// Merge Candidates
	r.Get("/merge-candidates", h.getMergeCandidates)
	r.Post("/merge-candidates", h.saveMergeCandidate)
	r.Delete("/merge-candidates/{id}", h.deleteMergeCandidate)
}

func (h *Handler) getBooks(w http.ResponseWriter, r *http.Request) {
	books, err := h.Store.GetBooks()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "get books: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"books": books})
}

func (h *Handler) createBook(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title    string              `json:"title"`
		Type     storymaker.BookType `json:"type"`
		Author   string              `json:"author,omitempty"`
		Platform string              `json:"platform,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "title is required")
		return
	}
	if body.Type == "" {
		body.Type = storymaker.BookTypeProject
	}
	bookID := fmt.Sprintf("bk_%d", timestampNow())
	now := storymaker.NowRFC3339()
	book := storymaker.Book{
		ID:        bookID,
		Title:     body.Title,
		Type:      body.Type,
		Author:    body.Author,
		Platform:  body.Platform,
		CreatedAt: now,
	}
	if err := h.Store.SaveBook(book); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "save book: "+err.Error())
		return
	}
	// Initialize empty architecture shell for project book
	if book.Type == storymaker.BookTypeProject {
		_ = h.Store.SaveArchitecture(storymaker.NovelArchitecture{
			ID:        bookID,
			BookID:    bookID,
			UpdatedAt: now,
		})
	}
	writeJSON(w, http.StatusOK, book)
}

func (h *Handler) patchBook(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "book id is required")
		return
	}
	var body struct {
		Title    *string `json:"title"`
		Author   *string `json:"author"`
		Platform *string `json:"platform"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	updated, err := h.Store.PatchBook(id, body.Title, body.Author, body.Platform)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "patch book: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (h *Handler) deleteBook(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "book id is required")
		return
	}
	if err := h.Store.DeleteBook(id); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "delete book: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) exportBook(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "book id is required")
		return
	}
	txt, err := h.Store.ExportBookTxt(id)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "export book: "+err.Error())
		return
	}
	book, _ := h.Store.GetBook(id)
	filename := "book.txt"
	if book != nil && book.Title != "" {
		filename = url.QueryEscape(book.Title) + ".txt"
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", filename))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(txt))
}

func (h *Handler) getOutline(w http.ResponseWriter, r *http.Request) {
	bookID := r.URL.Query().Get("bookId")
	outline, err := h.Store.GetOutline(bookID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "get outline: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"outline": outline})
}

func (h *Handler) appendOutline(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BookID string                  `json:"bookId"`
		Nodes  []storymaker.OutlineNode `json:"nodes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.BookID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "bookId is required")
		return
	}
	if err := h.Store.AppendOutline(body.BookID, body.Nodes); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "append outline: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// sseFlusher sets up SSE headers and returns flusher.
func sseFlusher(w http.ResponseWriter) (http.Flusher, bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	return flusher, true
}

func writeSSEDelta(w http.ResponseWriter, flusher http.Flusher, delta string) {
	payload, _ := json.Marshal(map[string]string{"delta": delta})
	_, _ = fmt.Fprintf(w, "data: %s\n\n", string(payload))
	flusher.Flush()
}

func writeSSEEvent(w http.ResponseWriter, flusher http.Flusher, event string, data any) {
	payload, _ := json.Marshal(data)
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(payload))
	flusher.Flush()
}

func (h *Handler) generateArchInput(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model        string `json:"model"`
		Topic        string `json:"topic,omitempty"`
		Genre        string `json:"genre,omitempty"`
		Chapters     int    `json:"chapters,omitempty"`
		Guidance     string `json:"guidance,omitempty"`
		SystemPrompt string `json:"systemPrompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model is required")
		return
	}

	flusher, ok := sseFlusher(w)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	sysPrompt := body.SystemPrompt
	if sysPrompt == "" {
		sysPrompt, _ = h.Store.GetPrompt("m0-arch-input")
	}

	userParts := []string{}
	if body.Topic != "" {
		userParts = append(userParts, "灵感/主题："+body.Topic)
	}
	if body.Genre != "" {
		userParts = append(userParts, "偏好类型："+body.Genre)
	}
	if body.Chapters > 0 {
		userParts = append(userParts, fmt.Sprintf("预估总章节数：%d", body.Chapters))
	}
	if body.Guidance != "" {
		userParts = append(userParts, "已有思路/梗概："+body.Guidance)
	}
	userPrompt := strings.Join(userParts, "\n")
	if userPrompt == "" {
		userPrompt = "请自由发挥创意，生成一个有趣的小说创作方向。"
	}

	messages := []ChatMessage{
		{Role: "system", Content: sysPrompt},
		{Role: "user", Content: userPrompt},
	}

	_ = callProxyStreaming(r.Context(), h.d, body.Model, messages, "storymaker:arch-input", func(delta string) {
		writeSSEDelta(w, flusher, delta)
	})
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	flusher.Flush()
}

func (h *Handler) generateArch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model        string `json:"model"`
		Topic        string `json:"topic"`
		Genre        string `json:"genre,omitempty"`
		Chapters     int    `json:"chapters,omitempty"`
		Guidance     string `json:"guidance,omitempty"`
		SystemPrompt string `json:"systemPrompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" || strings.TrimSpace(body.Topic) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model and topic are required")
		return
	}

	flusher, ok := sseFlusher(w)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	sysPrompt := body.SystemPrompt
	if sysPrompt == "" {
		sysPrompt, _ = h.Store.GetPrompt("m0-arch")
	}

	userParts := []string{"主题：" + strings.TrimSpace(body.Topic)}
	if body.Genre != "" {
		userParts = append(userParts, "类型："+body.Genre)
	}
	if body.Chapters > 0 {
		userParts = append(userParts, fmt.Sprintf("预估总章节数：%d", body.Chapters))
	}
	if body.Guidance != "" {
		userParts = append(userParts, "核心梗概 / 指导："+body.Guidance)
	}
	userParts = append(userParts, "", "请按工作方法与输出格式，生成这部小说的总体架构。")
	userPrompt := strings.Join(userParts, "\n")

	messages := []ChatMessage{
		{Role: "system", Content: sysPrompt},
		{Role: "user", Content: userPrompt},
	}

	_ = callProxyStreaming(r.Context(), h.d, body.Model, messages, "storymaker:arch", func(delta string) {
		writeSSEDelta(w, flusher, delta)
	})
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	flusher.Flush()
}

func (h *Handler) generateBlueprint(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model             string `json:"model"`
		Architecture      string `json:"architecture"`
		ExistingDirectory string `json:"existingDirectory,omitempty"`
		TotalChapters     int    `json:"totalChapters,omitempty"`
		StartChapter      int    `json:"startChapter,omitempty"`
		SystemPrompt      string `json:"systemPrompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" || strings.TrimSpace(body.Architecture) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model and architecture are required")
		return
	}

	flusher, ok := sseFlusher(w)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	begin := body.StartChapter
	if begin <= 0 {
		begin = 1
	}
	total := body.TotalChapters
	if total <= 0 {
		total = 30
	}
	end := begin + 19
	if end > total {
		end = total
	}

	sysPrompt := body.SystemPrompt
	if sysPrompt == "" {
		sysPrompt, _ = h.Store.GetPrompt("m0-blueprint")
	}

	userParts := []string{
		"【已确认的小说架构】",
		strings.TrimSpace(body.Architecture),
		"",
	}
	if strings.TrimSpace(body.ExistingDirectory) != "" {
		userParts = append(userParts, fmt.Sprintf("【已有章节目录（请保持连贯，从第 %d 章续写）】\n%s", begin, strings.TrimSpace(body.ExistingDirectory)))
	} else {
		userParts = append(userParts, fmt.Sprintf("本次从第 %d 章开始生成。", begin))
	}
	userParts = append(userParts, "", fmt.Sprintf("全书共约 %d 章，本次生成第 %d–%d 章的蓝图（不超过 20 章）。", total, begin, end), "请按输出格式逐章生成。")
	userPrompt := strings.Join(userParts, "\n")

	messages := []ChatMessage{
		{Role: "system", Content: sysPrompt},
		{Role: "user", Content: userPrompt},
	}

	_ = callProxyStreaming(r.Context(), h.d, body.Model, messages, "storymaker:blueprint", func(delta string) {
		writeSSEDelta(w, flusher, delta)
	})
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	flusher.Flush()
}

func (h *Handler) extractEntities(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model             string   `json:"model"`
		BookID            string   `json:"bookId"`
		ChapterIDs        []string `json:"chapterIds"`
		ExistingCardNames []string `json:"existingCardNames,omitempty"`
		SystemPrompt      string   `json:"systemPrompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" || len(body.ChapterIDs) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model and chapterIds are required")
		return
	}

	flusher, ok := sseFlusher(w)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	allChapters, _ := h.Store.GetChapters(body.BookID)
	targetChapters := make([]storymaker.Chapter, 0, len(body.ChapterIDs))
	chapMap := make(map[string]storymaker.Chapter)
	for _, c := range allChapters {
		chapMap[c.ID] = c
	}
	for _, id := range body.ChapterIDs {
		if c, exists := chapMap[id]; exists {
			targetChapters = append(targetChapters, c)
		}
	}

	if len(targetChapters) == 0 {
		writeSSEEvent(w, flusher, "error", map[string]string{"message": "未找到有效章节"})
		return
	}

	sysPrompt := body.SystemPrompt
	if sysPrompt == "" {
		sysPrompt, _ = h.Store.GetPrompt("m2-extract")
	}

	writeSSEEvent(w, flusher, "progress", map[string]any{"stage": "extracting", "total": len(targetChapters), "current": 0})

	var extractedCards []storymaker.EntityCard
	for i, ch := range targetChapters {
		userPrompt := fmt.Sprintf("【第 %d 章 %s】\n\n%s\n\n已存在实体名：%s\n\n请提取新实体。",
			ch.Index, ch.Title, ch.Content, strings.Join(body.ExistingCardNames, "、"))

		messages := []ChatMessage{
			{Role: "system", Content: sysPrompt},
			{Role: "user", Content: userPrompt},
		}

		resp, err := callProxyComplete(r.Context(), h.d, body.Model, messages, "storymaker:extract-entities")
		if err == nil {
			cleaned := stripMarkdownFence(resp)
			var rawList []struct {
				Type        storymaker.EntityType `json:"type"`
				Name        string                `json:"name"`
				Description string                `json:"description"`
				Fields      map[string]string     `json:"fields"`
				Excerpt     string                `json:"excerpt"`
			}
			if err := json.Unmarshal([]byte(cleaned), &rawList); err == nil {
				for _, item := range rawList {
					if item.Name == "" {
						continue
					}
					cardID := fmt.Sprintf("card_%d_%d", timestampNow(), len(extractedCards))
					c := storymaker.EntityCard{
						ID:          cardID,
						BookID:      body.BookID,
						Type:        item.Type,
						Name:        item.Name,
						Aliases:     []string{},
						Fields:      item.Fields,
						Description: item.Description,
						Refs: []storymaker.EntityRef{
							{ChapterID: ch.ID, Excerpt: item.Excerpt},
						},
						UpdatedAt: storymaker.NowRFC3339(),
					}
					extractedCards = append(extractedCards, c)
					writeSSEEvent(w, flusher, "entity", c)
				}
			}
		}
		writeSSEEvent(w, flusher, "progress", map[string]any{"stage": "extracting", "total": len(targetChapters), "current": i + 1})
	}

	writeSSEEvent(w, flusher, "done", map[string]any{"cards": extractedCards, "mergeCandidates": []any{}})
}

func (h *Handler) generateCard(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model        string `json:"model"`
		Type         string `json:"type"`
		Instruction  string `json:"instruction,omitempty"`
		Mode         string `json:"mode,omitempty"`
		ExistingCard string `json:"existingCard,omitempty"`
		SystemPrompt string `json:"systemPrompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" || body.Type == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model and type are required")
		return
	}

	sysPrompt := body.SystemPrompt
	if sysPrompt == "" {
		sysPrompt, _ = h.Store.GetPrompt("m2-card-single")
	}

	isEnrich := body.Mode == "enrich"
	userParts := []string{
		fmt.Sprintf("实体类型（type）：%s", strings.TrimSpace(body.Type)),
	}
	if isEnrich {
		userParts = append(userParts, "模式：enrich（在已有卡片基础上丰富扩写）", "\n【已有卡片内容】\n"+body.ExistingCard)
	} else {
		userParts = append(userParts, "模式：create（从零创作）")
	}
	if strings.TrimSpace(body.Instruction) != "" {
		userParts = append(userParts, "\n【用户描述/指令】\n"+strings.TrimSpace(body.Instruction))
	} else {
		userParts = append(userParts, "\n【用户描述/指令】\n（用户未提供具体描述）请自由随机创作一个该类型的设定：自行决定全部细节（姓名/外貌/性格/能力/背景等），追求新颖、有记忆点、避免俗套与雷同。")
	}
	userParts = append(userParts, "\n请按输出格式生成单个 JSON 对象。")
	userPrompt := strings.Join(userParts, "\n")

	messages := []ChatMessage{
		{Role: "system", Content: sysPrompt},
		{Role: "user", Content: userPrompt},
	}

	resp, err := callProxyComplete(r.Context(), h.d, body.Model, messages, "storymaker:generate-card")
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "generate card: "+err.Error())
		return
	}

	cleaned := stripMarkdownFence(resp)
	var cardData map[string]any
	if err := json.Unmarshal([]byte(cleaned), &cardData); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "parse generated card json: "+err.Error()+", raw: "+resp)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"card": cardData})
}

func (h *Handler) generateCardProfiles(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model        string `json:"model"`
		Type         string `json:"type"`
		Count        int    `json:"count,omitempty"`
		Instruction  string `json:"instruction,omitempty"`
		SystemPrompt string `json:"systemPrompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" || body.Type == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model and type are required")
		return
	}
	if body.Count <= 0 {
		body.Count = 3
	}

	sysPrompt := body.SystemPrompt
	if sysPrompt == "" {
		sysPrompt, _ = h.Store.GetPrompt("m2-card-profiles")
	}

	userPrompt := fmt.Sprintf("实体类型：%s\n需要的侧写数量：%d\n整体要求/主题：%s\n\n请按输出格式输出单个 JSON 对象。",
		body.Type, body.Count, body.Instruction)

	messages := []ChatMessage{
		{Role: "system", Content: sysPrompt},
		{Role: "user", Content: userPrompt},
	}

	resp, err := callProxyComplete(r.Context(), h.d, body.Model, messages, "storymaker:card-profiles")
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "generate card profiles: "+err.Error())
		return
	}

	cleaned := stripMarkdownFence(resp)
	var out struct {
		Profiles []struct {
			Name  string `json:"name"`
			Brief string `json:"brief"`
		} `json:"profiles"`
	}
	if err := json.Unmarshal([]byte(cleaned), &out); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "parse profiles json: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) generateCardsBatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model        string `json:"model"`
		Type         string `json:"type"`
		Profiles     []struct {
			Name  string `json:"name"`
			Brief string `json:"brief"`
		} `json:"profiles"`
		Instruction  string `json:"instruction,omitempty"`
		SystemPrompt string `json:"systemPrompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" || body.Type == "" || len(body.Profiles) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model, type and profiles are required")
		return
	}

	sysPrompt := body.SystemPrompt
	if sysPrompt == "" {
		sysPrompt, _ = h.Store.GetPrompt("m2-cards-batch")
	}

	profilesBytes, _ := json.Marshal(body.Profiles)
	userPrompt := fmt.Sprintf("实体类型：%s\n【侧写列表】\n%s\n\n整体要求：%s\n\n请按输出格式输出一个 JSON 数组，顺序一一对应。",
		body.Type, string(profilesBytes), body.Instruction)

	messages := []ChatMessage{
		{Role: "system", Content: sysPrompt},
		{Role: "user", Content: userPrompt},
	}

	resp, err := callProxyComplete(r.Context(), h.d, body.Model, messages, "storymaker:generate-cards-batch")
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "generate cards batch: "+err.Error())
		return
	}

	cleaned := stripMarkdownFence(resp)
	var cards []map[string]any
	if err := json.Unmarshal([]byte(cleaned), &cards); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "parse cards batch json: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cards": cards})
}

func (h *Handler) generateCardImagePrompts(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model           string `json:"model"`
		CardDescription string `json:"cardDescription"`
		Intent          string `json:"intent"`
		Count           int    `json:"count,omitempty"`
		SystemPrompt    string `json:"systemPrompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" || strings.TrimSpace(body.CardDescription) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model and cardDescription are required")
		return
	}
	if body.Count <= 0 {
		body.Count = 3
	}

	sysPrompt := body.SystemPrompt
	if sysPrompt == "" {
		sysPrompt, _ = h.Store.GetPrompt("m2-card-image-prompts")
	}

	userPrompt := fmt.Sprintf("【卡片设定描述】\n%s\n\n用户意图：%s\n需要的提示词数量：%d\n\n请按输出格式生成 JSON 对象。",
		body.CardDescription, body.Intent, body.Count)

	messages := []ChatMessage{
		{Role: "system", Content: sysPrompt},
		{Role: "user", Content: userPrompt},
	}

	resp, err := callProxyComplete(r.Context(), h.d, body.Model, messages, "storymaker:card-image-prompts")
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "generate card image prompts: "+err.Error())
		return
	}

	cleaned := stripMarkdownFence(resp)
	var out struct {
		Prompts []struct {
			Label  string `json:"label"`
			Prompt string `json:"prompt"`
		} `json:"prompts"`
	}
	if err := json.Unmarshal([]byte(cleaned), &out); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "parse prompts json: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) simulateCharacter(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model             string                   `json:"model"`
		Context           storymaker.AssembleInput `json:"context"`
		CandidateCount    int                      `json:"candidateCount,omitempty"`
		SystemPrompt      string                   `json:"systemPrompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" || body.Context.BookID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model and context.bookId are required")
		return
	}
	if body.CandidateCount <= 0 {
		body.CandidateCount = 2
	}

	flusher, ok := sseFlusher(w)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	ctx, err := storymaker.AssembleContext(h.Store, body.Context)
	if err != nil {
		writeSSEEvent(w, flusher, "error", map[string]string{"message": err.Error()})
		return
	}

	sysPrompt := body.SystemPrompt
	if sysPrompt == "" {
		sysPrompt, _ = h.Store.GetPrompt("m3-simulate")
	}

	userParts := []string{}
	if ctx.Scene != nil {
		userParts = append(userParts, "# 当前场景", "环境："+ctx.Scene.Desc, "目标："+ctx.Scene.Goal, "前情："+ctx.Scene.PrevSummary, "")
	}
	if ctx.TargetCharacter != nil {
		userParts = append(userParts, "# 目标角色", "姓名："+ctx.TargetCharacter.Name, "设定："+ctx.TargetCharacter.Description, "语言风格："+ctx.TargetCharacter.StyleNote, "")
		if len(ctx.TargetCharacter.StyleExamples) > 0 {
			userParts = append(userParts, "台词示例："+strings.Join(ctx.TargetCharacter.StyleExamples, " / "))
		}
	}
	if len(ctx.PresentCharacters) > 0 {
		names := make([]string, len(ctx.PresentCharacters))
		for idx, c := range ctx.PresentCharacters {
			names[idx] = c.Name
		}
		userParts = append(userParts, "# 在场其他角色："+strings.Join(names, "、"), "")
	}
	if len(ctx.AdoptedFragments) > 0 {
		userParts = append(userParts, "# 本场景已有片段：", strings.Join(ctx.AdoptedFragments, "\n"), "")
	}
	userParts = append(userParts, "请直接输出该角色的自然反应片段（200-400字）。")
	userPrompt := strings.Join(userParts, "\n")

	for i := 0; i < body.CandidateCount; i++ {
		candIdx := i
		messages := []ChatMessage{
			{Role: "system", Content: sysPrompt},
			{Role: "user", Content: userPrompt},
		}
		_ = callProxyStreaming(r.Context(), h.d, body.Model, messages, "storymaker:simulate", func(delta string) {
			payload, _ := json.Marshal(map[string]any{"candidateIdx": candIdx, "delta": delta})
			_, _ = fmt.Fprintf(w, "event: delta\ndata: %s\n\n", string(payload))
			flusher.Flush()
		})
	}

	_, _ = fmt.Fprint(w, "event: done\ndata: {}\n\n")
	flusher.Flush()
}

func (h *Handler) generateDraft(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model           string                   `json:"model"`
		Context         storymaker.AssembleInput `json:"context"`
		UserGuidance    string                   `json:"userGuidance,omitempty"`
		TargetWordCount int                      `json:"targetWordCount,omitempty"`
		SystemPrompt    string                   `json:"systemPrompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" || body.Context.BookID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model and context.bookId are required")
		return
	}

	flusher, ok := sseFlusher(w)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	ctx, err := storymaker.AssembleContext(h.Store, body.Context)
	if err != nil {
		writeSSEEvent(w, flusher, "error", map[string]string{"message": err.Error()})
		return
	}

	sysPrompt := body.SystemPrompt
	if sysPrompt == "" {
		sysPrompt, _ = h.Store.GetPrompt("m4-draft")
	}

	sections := []string{"# 小说架构"}
	if ctx.Architecture != nil {
		sections = append(sections,
			"## 核心种子\n"+ctx.Architecture.Seed,
			"## 角色动力学\n"+ctx.Architecture.CharacterDynamics,
			"## 世界观\n"+ctx.Architecture.WorldBuilding,
			"## 三幕式情节\n"+ctx.Architecture.PlotStructure,
		)
	} else {
		sections = append(sections, "（无架构）")
	}

	sections = append(sections, "", "# 本章蓝图")
	if ctx.CurrentOutline != nil {
		sections = append(sections,
			fmt.Sprintf("第 %d 章 %s", ctx.CurrentOutline.Order, ctx.CurrentOutline.Title),
			"定位："+ctx.CurrentOutline.Positioning,
			"核心作用："+ctx.CurrentOutline.Role,
			"悬念密度："+ctx.CurrentOutline.SuspenseDensity,
			"伏笔："+ctx.CurrentOutline.Foreshadow,
			"简述："+ctx.CurrentOutline.Summary,
		)
	} else {
		sections = append(sections, "（无蓝图）")
	}

	sections = append(sections, "", "# 下章蓝图（用于承上启下）")
	if ctx.NextOutline != nil {
		sections = append(sections, fmt.Sprintf("第 %d 章 %s：%s", ctx.NextOutline.Order, ctx.NextOutline.Title, ctx.NextOutline.Summary))
	} else {
		sections = append(sections, "（无）")
	}

	sections = append(sections, "", "# 前文摘要")
	if ctx.GlobalSummary != "" {
		sections = append(sections, "【全局滚动摘要】\n"+ctx.GlobalSummary)
	}
	if ctx.PrevChapterSummary != "" {
		sections = append(sections, "【上一章摘要】\n"+ctx.PrevChapterSummary)
	}

	if len(ctx.AdoptedFragments) > 0 {
		sections = append(sections, "", "# 已采纳推演片段（必须完整嵌入正文作为硬约束）")
		for i, frag := range ctx.AdoptedFragments {
			sections = append(sections, fmt.Sprintf("【片段 %d】\n%s", i+1, frag))
		}
	}

	if body.UserGuidance != "" {
		sections = append(sections, "", "# 用户额外指导", body.UserGuidance)
	}
	targetWords := 3000
	if body.TargetWordCount > 0 {
		targetWords = body.TargetWordCount
	}
	sections = append(sections, "", fmt.Sprintf("目标字数：%d 字左右。请直接输出正文。", targetWords))

	userPrompt := strings.Join(sections, "\n")

	messages := []ChatMessage{
		{Role: "system", Content: sysPrompt},
		{Role: "user", Content: userPrompt},
	}

	_ = callProxyStreaming(r.Context(), h.d, body.Model, messages, "storymaker:draft", func(delta string) {
		writeSSEDelta(w, flusher, delta)
	})
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	flusher.Flush()
}

func (h *Handler) finalizeChapter(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model                 string `json:"model"`
		BookID                string `json:"bookId,omitempty"`
		ChapterID             string `json:"chapterId,omitempty"`
		ChapterText           string `json:"chapterText"`
		ExistingGlobalSummary string `json:"existingGlobalSummary,omitempty"`
		ExistingStates        string `json:"existingStates,omitempty"`
		SystemPrompt          string `json:"systemPrompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" || strings.TrimSpace(body.ChapterText) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model and chapterText are required")
		return
	}

	sysPrompt := body.SystemPrompt
	if sysPrompt == "" {
		sysPrompt, _ = h.Store.GetPrompt("m5-finalize")
	}

	userParts := []string{
		"【本章正文】",
		body.ChapterText,
		"",
	}
	if body.ExistingGlobalSummary != "" {
		userParts = append(userParts, "【现有全局摘要】\n"+body.ExistingGlobalSummary, "")
	}
	if body.ExistingStates != "" {
		userParts = append(userParts, "【现有角色状态】\n"+body.ExistingStates, "")
	}
	userParts = append(userParts, "请按输出格式生成定稿 JSON 对象。")
	userPrompt := strings.Join(userParts, "\n")

	messages := []ChatMessage{
		{Role: "system", Content: sysPrompt},
		{Role: "user", Content: userPrompt},
	}

	resp, err := callProxyComplete(r.Context(), h.d, body.Model, messages, "storymaker:finalize")
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "finalize chapter: "+err.Error())
		return
	}

	cleaned := stripMarkdownFence(resp)
	var out struct {
		ChapterSummary     string `json:"chapterSummary"`
		GlobalSummaryDelta string `json:"globalSummaryDelta"`
		StateEvents        []struct {
			CharacterID string `json:"characterId"`
			Type        string `json:"type"`
			Description string `json:"description"`
			Timestamp   string `json:"timestamp"`
		} `json:"stateEvents"`
	}
	if err := json.Unmarshal([]byte(cleaned), &out); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "parse finalize json: "+err.Error())
		return
	}

	// Persist state events if bookId and chapterId provided
	if body.BookID != "" && body.ChapterID != "" {
		var entities []storymaker.GenericEntity
		for _, se := range out.StateEvents {
			evID := fmt.Sprintf("ev_%d_%s", timestampNow(), se.CharacterID)
			ev := storymaker.StateEvent{
				ID:          evID,
				BookID:      body.BookID,
				ChapterID:   body.ChapterID,
				EntityID:    se.CharacterID,
				EventType:   storymaker.StateEventType(se.Type),
				Description: se.Description,
				CreatedAt:   storymaker.NowRFC3339(),
			}
			evBytes, _ := json.Marshal(ev)
			entities = append(entities, storymaker.GenericEntity{ID: evID, Data: evBytes})
		}
		if len(entities) > 0 {
			_ = h.Store.SyncAll("state_events", entities)
		}
	}

	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) checkConsistency(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model           string `json:"model"`
		BookID          string `json:"bookId,omitempty"`
		ChapterID       string `json:"chapterId,omitempty"`
		ChapterText     string `json:"chapterText"`
		Architecture    string `json:"architecture,omitempty"`
		CharacterStates string `json:"characterStates,omitempty"`
		PreviousSummary string `json:"previousSummary,omitempty"`
		SystemPrompt    string `json:"systemPrompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" || strings.TrimSpace(body.ChapterText) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model and chapterText are required")
		return
	}

	sysPrompt := body.SystemPrompt
	if sysPrompt == "" {
		sysPrompt, _ = h.Store.GetPrompt("m5-consistency")
	}

	userParts := []string{
		"【待审校章节正文】",
		body.ChapterText,
		"",
	}
	if body.Architecture != "" {
		userParts = append(userParts, "【小说架构】\n"+body.Architecture, "")
	}
	if body.CharacterStates != "" {
		userParts = append(userParts, "【角色状态】\n"+body.CharacterStates, "")
	}
	if body.PreviousSummary != "" {
		userParts = append(userParts, "【前文摘要】\n"+body.PreviousSummary, "")
	}
	userParts = append(userParts, "请进行三维度审校，按输出格式生成 JSON。")
	userPrompt := strings.Join(userParts, "\n")

	messages := []ChatMessage{
		{Role: "system", Content: sysPrompt},
		{Role: "user", Content: userPrompt},
	}

	resp, err := callProxyComplete(r.Context(), h.d, body.Model, messages, "storymaker:consistency")
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "consistency check: "+err.Error())
		return
	}

	cleaned := stripMarkdownFence(resp)
	var out struct {
		Status string `json:"status"`
		Issues []struct {
			Severity    string `json:"severity"`
			Dimension   string `json:"dimension"`
			Description string `json:"description"`
			Suggestion  string `json:"suggestion"`
		} `json:"issues"`
	}
	if err := json.Unmarshal([]byte(cleaned), &out); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "parse consistency json: "+err.Error())
		return
	}

	var savedIssues []storymaker.ConsistencyIssue
	if body.BookID != "" && body.ChapterID != "" {
		var entities []storymaker.GenericEntity
		for _, is := range out.Issues {
			level := storymaker.IssueLevelWarning
			if is.Severity == "严重" || is.Severity == "error" {
				level = storymaker.IssueLevelError
			}
			issID := fmt.Sprintf("iss_%d", timestampNow())
			issue := storymaker.ConsistencyIssue{
				ID:             issID,
				BookID:         body.BookID,
				ChapterID:      body.ChapterID,
				Type:           is.Dimension,
				Level:          level,
				Description:    is.Description,
				RelatedCardIDs: []string{},
				Suggestion:     is.Suggestion,
				Status:         storymaker.IssueStatusOpen,
			}
			issBytes, _ := json.Marshal(issue)
			entities = append(entities, storymaker.GenericEntity{ID: issID, Data: issBytes})
			savedIssues = append(savedIssues, issue)
		}
		if len(entities) > 0 {
			_ = h.Store.SyncAll("issues", entities)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status": out.Status,
		"issues": savedIssues,
	})
}

func (h *Handler) roleChat(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model    string        `json:"model"`
		Messages []ChatMessage `json:"messages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Model == "" || len(body.Messages) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model and messages are required")
		return
	}

	flusher, ok := sseFlusher(w)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	_ = callProxyStreaming(r.Context(), h.d, body.Model, body.Messages, "storymaker:chat", func(delta string) {
		writeSSEDelta(w, flusher, delta)
	})
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	flusher.Flush()
}

func (h *Handler) getPrompt(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if key == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "prompt key is required")
		return
	}
	prompt, err := h.Store.GetPrompt(key)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "get prompt: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"key": key, "content": prompt})
}

func (h *Handler) putPrompt(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if key == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "prompt key is required")
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if err := h.Store.SetPrompt(key, body.Content); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "set prompt: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) getCards(w http.ResponseWriter, r *http.Request) {
	bookID := r.URL.Query().Get("bookId")
	cards, err := h.Store.GetCards(bookID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "get cards: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cards": cards})
}

func (h *Handler) saveCard(w http.ResponseWriter, r *http.Request) {
	var c storymaker.EntityCard
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if strings.TrimSpace(c.Name) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "card name is required")
		return
	}
	if c.ID == "" {
		c.ID = fmt.Sprintf("card_%d", timestampNow())
	}
	c.UpdatedAt = storymaker.NowRFC3339()
	if c.Fields == nil {
		c.Fields = make(map[string]string)
	}
	if c.Aliases == nil {
		c.Aliases = []string{}
	}
	if c.Refs == nil {
		c.Refs = []storymaker.EntityRef{}
	}
	if c.Images == nil {
		c.Images = []storymaker.CardImage{}
	}
	if err := h.Store.SaveCard(c); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "save card: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (h *Handler) deleteCard(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "card id is required")
		return
	}
	if err := h.Store.DeleteEntities("cards", []string{id}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "delete card: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) getChapters(w http.ResponseWriter, r *http.Request) {
	bookID := r.URL.Query().Get("bookId")
	chapters, err := h.Store.GetChapters(bookID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "get chapters: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"chapters": chapters})
}

func (h *Handler) saveChapter(w http.ResponseWriter, r *http.Request) {
	var c storymaker.Chapter
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if c.ID == "" {
		c.ID = fmt.Sprintf("ch_%d", timestampNow())
	}
	if c.Status == "" {
		c.Status = storymaker.ChapterStatusDraft
	}
	c.UpdatedAt = storymaker.NowRFC3339()
	if err := h.Store.SaveChapter(c); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "save chapter: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (h *Handler) patchChapter(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "chapter id is required")
		return
	}
	raws, err := h.Store.ReadAll("chapters")
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "read chapters: "+err.Error())
		return
	}
	var existing *storymaker.Chapter
	for _, rItem := range raws {
		if rItem.ID == id {
			var ch storymaker.Chapter
			if err := json.Unmarshal(rItem.Data, &ch); err == nil {
				existing = &ch
				break
			}
		}
	}
	if existing == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "chapter not found")
		return
	}

	var body struct {
		Title   *string                   `json:"title"`
		Content *string                   `json:"content"`
		Status  *storymaker.ChapterStatus `json:"status"`
		Summary *string                   `json:"summary"`
		Index   *int                      `json:"index"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if body.Title != nil {
		existing.Title = *body.Title
	}
	if body.Content != nil {
		existing.Content = *body.Content
	}
	if body.Status != nil {
		existing.Status = *body.Status
	}
	if body.Summary != nil {
		existing.Summary = *body.Summary
	}
	if body.Index != nil {
		existing.Index = *body.Index
	}
	existing.UpdatedAt = storymaker.NowRFC3339()

	if err := h.Store.SaveChapter(*existing); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "save chapter: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, existing)
}

func (h *Handler) deleteChapter(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "chapter id is required")
		return
	}
	if err := h.Store.DeleteEntities("chapters", []string{id}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "delete chapter: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) getArchitecture(w http.ResponseWriter, r *http.Request) {
	bookID := r.URL.Query().Get("bookId")
	if bookID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "bookId is required")
		return
	}
	arch, err := h.Store.GetArchitecture(bookID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "get arch: "+err.Error())
		return
	}
	if arch == nil {
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	writeJSON(w, http.StatusOK, arch)
}

func (h *Handler) saveArchitecture(w http.ResponseWriter, r *http.Request) {
	var arch storymaker.NovelArchitecture
	if err := json.NewDecoder(r.Body).Decode(&arch); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if arch.BookID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "bookId is required")
		return
	}
	if arch.ID == "" {
		arch.ID = arch.BookID
	}
	arch.UpdatedAt = storymaker.NowRFC3339()
	if err := h.Store.SaveArchitecture(arch); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "save arch: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, arch)
}

func (h *Handler) getScenes(w http.ResponseWriter, r *http.Request) {
	bookID := r.URL.Query().Get("bookId")
	scenes, err := h.Store.GetScenes(bookID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "get scenes: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scenes": scenes})
}

func (h *Handler) saveScene(w http.ResponseWriter, r *http.Request) {
	var sc storymaker.SimScene
	if err := json.NewDecoder(r.Body).Decode(&sc); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if sc.ID == "" {
		sc.ID = fmt.Sprintf("sc_%d", timestampNow())
	}
	if sc.CreatedAt == "" {
		sc.CreatedAt = storymaker.NowRFC3339()
	}
	if sc.PresentCharacterIDs == nil {
		sc.PresentCharacterIDs = []string{}
	}
	if err := h.Store.SaveScene(sc); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "save scene: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sc)
}

func (h *Handler) deleteScene(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "scene id is required")
		return
	}
	if err := h.Store.DeleteEntities("scenes", []string{id}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "delete scene: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) getFragments(w http.ResponseWriter, r *http.Request) {
	sceneID := r.URL.Query().Get("sceneId")
	fragments, err := h.Store.GetFragments(sceneID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "get fragments: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"fragments": fragments})
}

func (h *Handler) saveFragment(w http.ResponseWriter, r *http.Request) {
	var f storymaker.SimFragment
	if err := json.NewDecoder(r.Body).Decode(&f); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if f.ID == "" {
		f.ID = fmt.Sprintf("frag_%d", timestampNow())
	}
	if f.CreatedAt == "" {
		f.CreatedAt = storymaker.NowRFC3339()
	}
	if f.Candidates == nil {
		f.Candidates = []storymaker.SimCandidate{}
	}
	if err := h.Store.SaveFragment(f); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "save fragment: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, f)
}

func (h *Handler) deleteFragment(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "fragment id is required")
		return
	}
	if err := h.Store.DeleteEntities("fragments", []string{id}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "delete fragment: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) getIssues(w http.ResponseWriter, r *http.Request) {
	bookID := r.URL.Query().Get("bookId")
	issues, err := h.Store.GetIssues(bookID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "get issues: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"issues": issues})
}

func (h *Handler) patchIssue(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "issue id is required")
		return
	}
	var body struct {
		Status storymaker.IssueStatus `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	raws, err := h.Store.ReadAll("issues")
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "read issues: "+err.Error())
		return
	}
	var existing *storymaker.ConsistencyIssue
	for _, rItem := range raws {
		if rItem.ID == id {
			var is storymaker.ConsistencyIssue
			if err := json.Unmarshal(rItem.Data, &is); err == nil {
				existing = &is
				break
			}
		}
	}
	if existing == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "issue not found")
		return
	}
	existing.Status = body.Status
	if err := h.Store.SaveIssue(*existing); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "save issue: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, existing)
}

func (h *Handler) getStateEvents(w http.ResponseWriter, r *http.Request) {
	bookID := r.URL.Query().Get("bookId")
	events, err := h.Store.GetStateEvents(bookID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "get state events: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"stateEvents": events})
}

func (h *Handler) getMergeCandidates(w http.ResponseWriter, r *http.Request) {
	candidates, err := h.Store.GetMergeCandidates()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "get merge candidates: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mergeCandidates": candidates})
}

func (h *Handler) saveMergeCandidate(w http.ResponseWriter, r *http.Request) {
	var mc storymaker.MergeCandidate
	if err := json.NewDecoder(r.Body).Decode(&mc); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if mc.ID == "" {
		mc.ID = fmt.Sprintf("mc_%d", timestampNow())
	}
	if mc.Status == "" {
		mc.Status = "pending"
	}
	if err := h.Store.SaveMergeCandidate(mc); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "save merge candidate: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, mc)
}

func (h *Handler) deleteMergeCandidate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "merge candidate id is required")
		return
	}
	if err := h.Store.DeleteEntities("merge_candidates", []string{id}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "delete merge candidate: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
