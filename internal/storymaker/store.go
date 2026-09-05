package storymaker

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

// AllowedTables lists all valid entity table names.
var AllowedTables = map[string]bool{
	"books":            true,
	"chapters":         true,
	"cards":            true,
	"outline":          true,
	"scenes":           true,
	"fragments":        true,
	"state_events":     true,
	"issues":           true,
	"architectures":    true,
	"merge_candidates": true,
	"prompts":          true,
}

// Store wraps SQLite operations for storymaker.
type Store struct {
	db  *sql.DB
	dir string
	mu  sync.RWMutex
}

// Open initializes the story SQLite database at {storyDir}/story.db.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create story dir: %w", err)
	}
	imagesDir := filepath.Join(dir, "images")
	if err := os.MkdirAll(imagesDir, 0755); err != nil {
		return nil, fmt.Errorf("create story images dir: %w", err)
	}

	dbPath := filepath.Join(dir, "story.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite db: %w", err)
	}

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping sqlite db: %w", err)
	}

	// Apply WAL and busy timeout pragmas matching novelhelper db.ts
	if _, err := db.Exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("set db pragmas: %w", err)
	}

	// Create tables if not exist
	for table := range AllowedTables {
		query := fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s (id TEXT PRIMARY KEY, data TEXT NOT NULL)", table)
		if _, err := db.Exec(query); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("create table %s: %w", table, err)
		}
	}

	s := &Store{
		db:  db,
		dir: dir,
	}

	// Seed default prompts if missing
	if err := s.seedDefaultPrompts(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("seed default prompts: %w", err)
	}

	return s, nil
}

// Dir returns the base directory of this store.
func (s *Store) Dir() string {
	return s.dir
}

// ImagesDir returns the images directory of this store.
func (s *Store) ImagesDir() string {
	return filepath.Join(s.dir, "images")
}

// Close closes the underlying SQLite database.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return nil
	}
	err := s.db.Close()
	s.db = nil
	return err
}

func (s *Store) seedDefaultPrompts() error {
	for k, prompt := range DefaultPrompts {
		var exists int
		err := s.db.QueryRow("SELECT 1 FROM prompts WHERE id = ?", k).Scan(&exists)
		if err == sql.ErrNoRows {
			dataBytes, _ := json.Marshal(map[string]string{"content": prompt})
			_, err = s.db.Exec("INSERT INTO prompts (id, data) VALUES (?, ?)", k, string(dataBytes))
			if err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
	}
	return nil
}

// SyncAll implements the safe upsert contract: inserts or updates entities, never deletes.
func (s *Store) SyncAll(table string, entities []GenericEntity) error {
	if !AllowedTables[table] {
		return fmt.Errorf("disallowed table: %s", table)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.Prepare(fmt.Sprintf("INSERT INTO %s (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", table))
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()

	for _, e := range entities {
		if e.ID == "" {
			continue
		}
		if _, err := stmt.Exec(e.ID, string(e.Data)); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// ReadAll returns all entities from a table with row-level error tolerance.
func (s *Store) ReadAll(table string) ([]GenericEntity, error) {
	if !AllowedTables[table] {
		return nil, fmt.Errorf("disallowed table: %s", table)
	}
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(fmt.Sprintf("SELECT id, data FROM %s", table))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var results []GenericEntity
	for rows.Next() {
		var id string
		var raw string
		if err := rows.Scan(&id, &raw); err != nil {
			continue
		}
		// Validate JSON
		if !json.Valid([]byte(raw)) {
			continue
		}
		results = append(results, GenericEntity{
			ID:   id,
			Data: json.RawMessage(raw),
		})
	}
	return results, rows.Err()
}

// DeleteEntities deletes entities by IDs from a whitelisted table.
func (s *Store) DeleteEntities(table string, ids []string) error {
	if !AllowedTables[table] {
		return fmt.Errorf("disallowed table: %s", table)
	}
	if len(ids) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.Prepare(fmt.Sprintf("DELETE FROM %s WHERE id = ?", table))
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()

	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, err := stmt.Exec(id); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// GetBooks returns all books.
func (s *Store) GetBooks() ([]Book, error) {
	raws, err := s.ReadAll("books")
	if err != nil {
		return nil, err
	}
	books := make([]Book, 0, len(raws))
	for _, r := range raws {
		var b Book
		if err := json.Unmarshal(r.Data, &b); err == nil {
			books = append(books, b)
		}
	}
	// Sort by createdAt desc
	sort.Slice(books, func(i, j int) bool {
		return books[i].CreatedAt > books[j].CreatedAt
	})
	return books, nil
}

// GetBook returns one book by ID.
func (s *Store) GetBook(id string) (*Book, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var raw string
	err := s.db.QueryRow("SELECT data FROM books WHERE id = ?", id).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var b Book
	if err := json.Unmarshal([]byte(raw), &b); err != nil {
		return nil, err
	}
	return &b, nil
}

// SaveBook upserts one book.
func (s *Store) SaveBook(b Book) error {
	data, err := json.Marshal(b)
	if err != nil {
		return err
	}
	return s.SyncAll("books", []GenericEntity{{ID: b.ID, Data: data}})
}

// PatchBook modifies title, author, and platform of a book.
func (s *Store) PatchBook(id string, title, author, platform *string) (*Book, error) {
	b, err := s.GetBook(id)
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, fmt.Errorf("book not found")
	}
	if title != nil {
		b.Title = *title
	}
	if author != nil {
		b.Author = *author
	}
	if platform != nil {
		b.Platform = *platform
	}
	if err := s.SaveBook(*b); err != nil {
		return nil, err
	}
	return b, nil
}

// DeleteBook deletes a book and cascade deletes associated data.
func (s *Store) DeleteBook(id string) error {
	// First collect associated IDs
	allChapters, _ := s.GetChapters(id)
	var chapterIDs []string
	for _, c := range allChapters {
		chapterIDs = append(chapterIDs, c.ID)
	}

	allCards, _ := s.GetCards(id)
	var cardIDs []string
	for _, c := range allCards {
		cardIDs = append(cardIDs, c.ID)
	}

	allOutline, _ := s.GetOutline(id)
	var outlineIDs []string
	for _, o := range allOutline {
		outlineIDs = append(outlineIDs, o.ID)
	}

	allScenes, _ := s.GetScenes(id)
	var sceneIDs []string
	for _, sc := range allScenes {
		sceneIDs = append(sceneIDs, sc.ID)
	}

	_ = s.DeleteEntities("chapters", chapterIDs)
	_ = s.DeleteEntities("cards", cardIDs)
	_ = s.DeleteEntities("outline", outlineIDs)
	_ = s.DeleteEntities("scenes", sceneIDs)
	_ = s.DeleteEntities("architectures", []string{id})
	return s.DeleteEntities("books", []string{id})
}

// ExportBookTxt compiles all chapters into a plain text string.
func (s *Store) ExportBookTxt(bookID string) (string, error) {
	b, err := s.GetBook(bookID)
	if err != nil {
		return "", err
	}
	if b == nil {
		return "", fmt.Errorf("book not found")
	}
	chapters, err := s.GetChapters(bookID)
	if err != nil {
		return "", err
	}
	sort.Slice(chapters, func(i, j int) bool {
		return chapters[i].Index < chapters[j].Index
	})

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("%s\n\n", b.Title))
	if b.Author != "" {
		sb.WriteString(fmt.Sprintf("作者：%s\n\n", b.Author))
	}
	for _, c := range chapters {
		sb.WriteString(fmt.Sprintf("第%d章 %s\n\n", c.Index, c.Title))
		sb.WriteString(c.Content)
		sb.WriteString("\n\n")
	}
	return sb.String(), nil
}

// GetChapters returns chapters of a book.
func (s *Store) GetChapters(bookID string) ([]Chapter, error) {
	raws, err := s.ReadAll("chapters")
	if err != nil {
		return nil, err
	}
	var res []Chapter
	for _, r := range raws {
		var c Chapter
		if err := json.Unmarshal(r.Data, &c); err == nil && (bookID == "" || c.BookID == bookID) {
			res = append(res, c)
		}
	}
	sort.Slice(res, func(i, j int) bool {
		return res[i].Index < res[j].Index
	})
	return res, nil
}

// SaveChapter upserts a chapter.
func (s *Store) SaveChapter(c Chapter) error {
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return s.SyncAll("chapters", []GenericEntity{{ID: c.ID, Data: data}})
}

// GetCards returns cards belonging to a book or shared cards when bookID=="".
func (s *Store) GetCards(bookID string) ([]EntityCard, error) {
	raws, err := s.ReadAll("cards")
	if err != nil {
		return nil, err
	}
	var res []EntityCard
	for _, r := range raws {
		var c EntityCard
		if err := json.Unmarshal(r.Data, &c); err == nil {
			if bookID == "" || c.BookID == bookID || c.BookID == "" {
				res = append(res, c)
			}
		}
	}
	return res, nil
}

// SaveCard upserts an entity card.
func (s *Store) SaveCard(c EntityCard) error {
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return s.SyncAll("cards", []GenericEntity{{ID: c.ID, Data: data}})
}

// GetOutline returns outline nodes for a book.
func (s *Store) GetOutline(bookID string) ([]OutlineNode, error) {
	raws, err := s.ReadAll("outline")
	if err != nil {
		return nil, err
	}
	var res []OutlineNode
	for _, r := range raws {
		var n OutlineNode
		if err := json.Unmarshal(r.Data, &n); err == nil && (bookID == "" || n.BookID == bookID) {
			res = append(res, n)
		}
	}
	sort.Slice(res, func(i, j int) bool {
		return res[i].Order < res[j].Order
	})
	return res, nil
}

// AppendOutline appends outline nodes to a book.
func (s *Store) AppendOutline(bookID string, nodes []OutlineNode) error {
	var entities []GenericEntity
	for _, n := range nodes {
		n.BookID = bookID
		data, err := json.Marshal(n)
		if err != nil {
			continue
		}
		entities = append(entities, GenericEntity{ID: n.ID, Data: data})
	}
	return s.SyncAll("outline", entities)
}

// GetArchitecture returns the architecture for a book.
func (s *Store) GetArchitecture(bookID string) (*NovelArchitecture, error) {
	raws, err := s.ReadAll("architectures")
	if err != nil {
		return nil, err
	}
	for _, r := range raws {
		var arch NovelArchitecture
		if err := json.Unmarshal(r.Data, &arch); err == nil && arch.BookID == bookID {
			return &arch, nil
		}
	}
	return nil, nil
}

// SaveArchitecture upserts the architecture for a book.
func (s *Store) SaveArchitecture(arch NovelArchitecture) error {
	data, err := json.Marshal(arch)
	if err != nil {
		return err
	}
	return s.SyncAll("architectures", []GenericEntity{{ID: arch.ID, Data: data}})
}

// GetScenes returns scenes for a book.
func (s *Store) GetScenes(bookID string) ([]SimScene, error) {
	raws, err := s.ReadAll("scenes")
	if err != nil {
		return nil, err
	}
	var res []SimScene
	for _, r := range raws {
		var sc SimScene
		if err := json.Unmarshal(r.Data, &sc); err == nil && (bookID == "" || sc.BookID == bookID) {
			res = append(res, sc)
		}
	}
	return res, nil
}

// GetFragments returns fragments for a scene.
func (s *Store) GetFragments(sceneID string) ([]SimFragment, error) {
	raws, err := s.ReadAll("fragments")
	if err != nil {
		return nil, err
	}
	var res []SimFragment
	for _, r := range raws {
		var f SimFragment
		if err := json.Unmarshal(r.Data, &f); err == nil && (sceneID == "" || f.SceneID == sceneID) {
			res = append(res, f)
		}
	}
	sort.Slice(res, func(i, j int) bool {
		return res[i].Order < res[j].Order
	})
	return res, nil
}

// GetPrompt retrieves a prompt by key, falling back to built-in default.
func (s *Store) GetPrompt(key string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var raw string
	err := s.db.QueryRow("SELECT data FROM prompts WHERE id = ?", key).Scan(&raw)
	if err == sql.ErrNoRows {
		if def, ok := DefaultPrompts[key]; ok {
			return def, nil
		}
		return "", nil
	}
	if err != nil {
		return "", err
	}

	var m map[string]string
	if err := json.Unmarshal([]byte(raw), &m); err == nil {
		if c, ok := m["content"]; ok && c != "" {
			return c, nil
		}
	}
	if def, ok := DefaultPrompts[key]; ok {
		return def, nil
	}
	return "", nil
}

// SetPrompt stores a prompt override by key.
func (s *Store) SetPrompt(key, content string) error {
	dataBytes, err := json.Marshal(map[string]string{"content": content})
	if err != nil {
		return err
	}
	return s.SyncAll("prompts", []GenericEntity{{ID: key, Data: dataBytes}})
}

// SaveScene upserts a simulation scene.
func (s *Store) SaveScene(sc SimScene) error {
	data, err := json.Marshal(sc)
	if err != nil {
		return err
	}
	return s.SyncAll("scenes", []GenericEntity{{ID: sc.ID, Data: data}})
}

// SaveFragment upserts a simulation fragment.
func (s *Store) SaveFragment(f SimFragment) error {
	data, err := json.Marshal(f)
	if err != nil {
		return err
	}
	return s.SyncAll("fragments", []GenericEntity{{ID: f.ID, Data: data}})
}

// GetIssues returns consistency issues for a book.
func (s *Store) GetIssues(bookID string) ([]ConsistencyIssue, error) {
	raws, err := s.ReadAll("issues")
	if err != nil {
		return nil, err
	}
	var res []ConsistencyIssue
	for _, r := range raws {
		var is ConsistencyIssue
		if err := json.Unmarshal(r.Data, &is); err == nil && (bookID == "" || is.BookID == bookID) {
			res = append(res, is)
		}
	}
	return res, nil
}

// SaveIssue upserts a consistency issue.
func (s *Store) SaveIssue(issue ConsistencyIssue) error {
	data, err := json.Marshal(issue)
	if err != nil {
		return err
	}
	return s.SyncAll("issues", []GenericEntity{{ID: issue.ID, Data: data}})
}

// GetStateEvents returns state events for a book.
func (s *Store) GetStateEvents(bookID string) ([]StateEvent, error) {
	raws, err := s.ReadAll("state_events")
	if err != nil {
		return nil, err
	}
	var res []StateEvent
	for _, r := range raws {
		var se StateEvent
		if err := json.Unmarshal(r.Data, &se); err == nil && (bookID == "" || se.BookID == bookID) {
			res = append(res, se)
		}
	}
	sort.Slice(res, func(i, j int) bool {
		return res[i].CreatedAt < res[j].CreatedAt
	})
	return res, nil
}

// GetMergeCandidates returns merge candidates.
func (s *Store) GetMergeCandidates() ([]MergeCandidate, error) {
	raws, err := s.ReadAll("merge_candidates")
	if err != nil {
		return nil, err
	}
	var res []MergeCandidate
	for _, r := range raws {
		var mc MergeCandidate
		if err := json.Unmarshal(r.Data, &mc); err == nil {
			res = append(res, mc)
		}
	}
	return res, nil
}

// SaveMergeCandidate upserts a merge candidate.
func (s *Store) SaveMergeCandidate(mc MergeCandidate) error {
	data, err := json.Marshal(mc)
	if err != nil {
		return err
	}
	return s.SyncAll("merge_candidates", []GenericEntity{{ID: mc.ID, Data: data}})
}
