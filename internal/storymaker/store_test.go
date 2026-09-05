package storymaker

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestStore_BasicAndSecurityContracts(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "storymaker_test_*")
	if err != nil {
		t.Fatalf("create temp dir: %v", err)
	}
	defer func() { _ = os.RemoveAll(tempDir) }()

	store, err := Open(tempDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = store.Close() }()

	// 1. Default prompts seeded
	prompt, err := store.GetPrompt("m0-arch")
	if err != nil {
		t.Fatalf("get prompt: %v", err)
	}
	if prompt == "" || prompt != DefaultPrompts["m0-arch"] {
		t.Errorf("default prompt mismatch or empty: got %q", prompt)
	}

	// 2. Prompt override
	customPrompt := "自定义系统提示词"
	if err := store.SetPrompt("m0-arch", customPrompt); err != nil {
		t.Fatalf("set prompt: %v", err)
	}
	newPrompt, err := store.GetPrompt("m0-arch")
	if err != nil {
		t.Fatalf("get updated prompt: %v", err)
	}
	if newPrompt != customPrompt {
		t.Errorf("prompt override failed: got %q, want %q", newPrompt, customPrompt)
	}

	// 3. Upsert-only contract: SyncAll must not delete missing records
	book1 := Book{ID: "b1", Title: "Book 1", Type: BookTypeProject, CreatedAt: NowRFC3339()}
	book2 := Book{ID: "b2", Title: "Book 2", Type: BookTypeProject, CreatedAt: NowRFC3339()}
	if err := store.SaveBook(book1); err != nil {
		t.Fatalf("save book1: %v", err)
	}
	if err := store.SaveBook(book2); err != nil {
		t.Fatalf("save book2: %v", err)
	}

	// Update b1 only via SyncAll
	b1Updated := Book{ID: "b1", Title: "Book 1 Updated", Type: BookTypeProject, CreatedAt: book1.CreatedAt}
	b1Data, _ := json.Marshal(b1Updated)
	if err := store.SyncAll("books", []GenericEntity{{ID: "b1", Data: b1Data}}); err != nil {
		t.Fatalf("syncAll: %v", err)
	}

	// Verify b2 still exists!
	books, err := store.GetBooks()
	if err != nil {
		t.Fatalf("get books: %v", err)
	}
	if len(books) != 2 {
		t.Fatalf("expected 2 books, got %d", len(books))
	}
	b1Got, _ := store.GetBook("b1")
	if b1Got == nil || b1Got.Title != "Book 1 Updated" {
		t.Errorf("expected b1 updated title, got %+v", b1Got)
	}

	// 4. DeleteEntities whitelist check
	if err := store.DeleteEntities("malicious_table", []string{"1"}); err == nil {
		t.Errorf("expected error on non-whitelisted table, got nil")
	}

	// 5. ReadAll row-level fault tolerance (corrupt JSON row does not break read)
	_, err = store.db.Exec("INSERT INTO books (id, data) VALUES (?, ?)", "bad_row", "{invalid_json")
	if err != nil {
		t.Fatalf("insert corrupt row: %v", err)
	}
	booksAfterCorrupt, err := store.GetBooks()
	if err != nil {
		t.Fatalf("get books with corrupt row: %v", err)
	}
	if len(booksAfterCorrupt) != 2 {
		t.Errorf("expected corrupt row to be safely ignored, got %d books", len(booksAfterCorrupt))
	}

	// 6. DeleteBook cascade
	if err := store.DeleteBook("b1"); err != nil {
		t.Fatalf("delete book b1: %v", err)
	}
	b1Deleted, _ := store.GetBook("b1")
	if b1Deleted != nil {
		t.Errorf("b1 still exists after DeleteBook")
	}

	// 7. Verify images dir
	if store.ImagesDir() != filepath.Join(tempDir, "images") {
		t.Errorf("images dir mismatch: %s", store.ImagesDir())
	}
}

func TestStore_ContextAssembler(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "storymaker_assembler_test_*")
	if err != nil {
		t.Fatalf("create temp dir: %v", err)
	}
	defer func() { _ = os.RemoveAll(tempDir) }()

	store, err := Open(tempDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = store.Close() }()

	book := Book{ID: "bk1", Title: "测试小说", GlobalSummary: "全局故事摘要", Type: BookTypeProject, CreatedAt: NowRFC3339()}
	_ = store.SaveBook(book)

	arch := NovelArchitecture{ID: "bk1", BookID: "bk1", Seed: "种子设定", CharacterDynamics: "角色动力学", WorldBuilding: "世界观", PlotStructure: "三幕情节"}
	_ = store.SaveArchitecture(arch)

	_ = store.AppendOutline("bk1", []OutlineNode{
		{ID: "o1", Order: 1, Title: "序章", Summary: "序章大纲"},
		{ID: "o2", Order: 2, Title: "第一章", Summary: "第一章大纲"},
		{ID: "o3", Order: 3, Title: "第二章", Summary: "第二章大纲"},
	})

	_ = store.SaveChapter(Chapter{ID: "c1", BookID: "bk1", Index: 1, Title: "序章", Content: "序章正文...", Summary: "序章定稿摘要", Status: ChapterStatusFinal})

	card := EntityCard{ID: "hero1", BookID: "bk1", Type: EntityTypeCharacter, Name: "主角张三", Description: "少年剑客", Fields: map[string]string{"武器": "玄铁剑"}}
	_ = store.SaveCard(card)

	scene := SimScene{ID: "sc1", BookID: "bk1", Desc: "山门前", Goal: "拜师考核", PresentCharacterIDs: []string{"hero1"}}
	sceneData, _ := json.Marshal(scene)
	_ = store.SyncAll("scenes", []GenericEntity{{ID: "sc1", Data: sceneData}})

	frag := SimFragment{ID: "fr1", SceneID: "sc1", CharacterID: "hero1", AdoptedText: "张三拔剑而起", Order: 1}
	fragData, _ := json.Marshal(frag)
	_ = store.SyncAll("fragments", []GenericEntity{{ID: "fr1", Data: fragData}})

	chapIdx := 2
	scID := "sc1"
	targetChar := "hero1"
	ctx, err := AssembleContext(store, AssembleInput{
		BookID:            "bk1",
		ChapterIndex:      &chapIdx,
		SceneID:           &scID,
		TargetCharacterID: &targetChar,
	})
	if err != nil {
		t.Fatalf("assemble context: %v", err)
	}

	if ctx.GlobalSummary != "全局故事摘要" {
		t.Errorf("globalSummary mismatch: got %q", ctx.GlobalSummary)
	}
	if ctx.PrevChapterSummary != "序章定稿摘要" {
		t.Errorf("prevChapterSummary mismatch: got %q", ctx.PrevChapterSummary)
	}
	if ctx.CurrentOutline == nil || ctx.CurrentOutline.Title != "第一章" {
		t.Errorf("currentOutline mismatch: %+v", ctx.CurrentOutline)
	}
	if ctx.NextOutline == nil || ctx.NextOutline.Title != "第二章" {
		t.Errorf("nextOutline mismatch: %+v", ctx.NextOutline)
	}
	if len(ctx.AdoptedFragments) != 1 || ctx.AdoptedFragments[0] != "张三拔剑而起" {
		t.Errorf("adoptedFragments mismatch: %v", ctx.AdoptedFragments)
	}
	if ctx.TargetCharacter == nil || ctx.TargetCharacter.Name != "主角张三" {
		t.Errorf("targetCharacter mismatch: %+v", ctx.TargetCharacter)
	}
	if len(ctx.PresentCharacters) != 1 || ctx.PresentCharacters[0].Name != "主角张三" {
		t.Errorf("presentCharacters mismatch: %v", ctx.PresentCharacters)
	}
}
