package storymaker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/tinylab/tinylab/internal/fsutil"
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

// Store wraps in-memory map + JSON file group operations for storymaker.
type Store struct {
	tables map[string]map[string]json.RawMessage // table -> id -> data
	dir    string
	mu     sync.RWMutex
}

// Open initializes the story store at {storyDir}, loading {table}.json files.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create story dir: %w", err)
	}
	imagesDir := filepath.Join(dir, "images")
	if err := os.MkdirAll(imagesDir, 0755); err != nil {
		return nil, fmt.Errorf("create story images dir: %w", err)
	}

	tables := make(map[string]map[string]json.RawMessage, len(AllowedTables))
	for table := range AllowedTables {
		filePath := filepath.Join(dir, table+".json")
		tableMap, err := loadTableFile(filePath)
		if err != nil {
			tableMap = make(map[string]json.RawMessage)
		}
		tables[table] = tableMap
	}

	s := &Store{
		tables: tables,
		dir:    dir,
	}

	// Seed default prompts if missing
	if err := s.seedDefaultPrompts(); err != nil {
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

// Close resets in-memory tables.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tables = nil
	return nil
}

func (s *Store) saveTable(table string) error {
	filePath := filepath.Join(s.dir, table+".json")
	tbl := s.tables[table]
	if tbl == nil {
		tbl = make(map[string]json.RawMessage)
	}
	data, err := json.Marshal(tbl)
	if err != nil {
		return err
	}
	return fsutil.AtomicWrite(filePath, data, 0600)
}

func loadTableFile(filePath string) (map[string]json.RawMessage, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return make(map[string]json.RawMessage), nil
	}
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return make(map[string]json.RawMessage), nil
	}

	var rawMap map[string]json.RawMessage
	if err := json.Unmarshal(data, &rawMap); err == nil {
		result := make(map[string]json.RawMessage, len(rawMap))
		for k, v := range rawMap {
			if k != "" && json.Valid(v) {
				result[k] = v
			}
		}
		return result, nil
	}

	// Fallback: parse entries with error tolerance for corrupted/bad rows
	return parseTolerantEntries(data), nil
}

// parseTolerantEntries extracts valid JSON object fields from potentially corrupted JSON text.
func parseTolerantEntries(data []byte) map[string]json.RawMessage {
	result := make(map[string]json.RawMessage)
	n := len(data)
	i := 0

	for i < n {
		// Look for key start: quote '"'
		for i < n && data[i] != '"' {
			i++
		}
		if i >= n {
			break
		}
		// Parse string key
		keyStart := i + 1
		i++
		escaped := false
		for i < n {
			if escaped {
				escaped = false
				i++
				continue
			}
			if data[i] == '\\' {
				escaped = true
				i++
				continue
			}
			if data[i] == '"' {
				break
			}
			i++
		}
		if i >= n {
			break
		}
		key := string(data[keyStart:i])
		i++ // skip closing '"'

		// Skip whitespace to find ':'
		for i < n && (data[i] == ' ' || data[i] == '\t' || data[i] == '\r' || data[i] == '\n') {
			i++
		}
		if i >= n || data[i] != ':' {
			continue
		}
		i++ // skip ':'

		// Skip whitespace after ':'
		for i < n && (data[i] == ' ' || data[i] == '\t' || data[i] == '\r' || data[i] == '\n') {
			i++
		}
		if i >= n {
			break
		}

		// Find start and end of value
		valStart := i
		var valEnd int
		ch := data[i]

		if ch == '{' || ch == '[' {
			openChar := ch
			closeChar := byte('}')
			if openChar == '[' {
				closeChar = ']'
			}
			depth := 0
			inStr := false
			strEsc := false
			found := false
			for i < n {
				c := data[i]
				if inStr {
					if strEsc {
						strEsc = false
					} else if c == '\\' {
						strEsc = true
					} else if c == '"' {
						inStr = false
					}
					i++
					continue
				}
				if c == '"' {
					inStr = true
					i++
					continue
				}
				if c == openChar {
					depth++
				} else if c == closeChar {
					depth--
					if depth == 0 {
						i++
						valEnd = i
						found = true
						break
					}
				}
				i++
			}
			if !found {
				// Malformed, skip this entry and continue scanning
				continue
			}
		} else if ch == '"' {
			// String value
			i++
			inEsc := false
			found := false
			for i < n {
				if inEsc {
					inEsc = false
					i++
					continue
				}
				if data[i] == '\\' {
					inEsc = true
					i++
					continue
				}
				if data[i] == '"' {
					i++
					valEnd = i
					found = true
					break
				}
				i++
			}
			if !found {
				continue
			}
		} else {
			// Literal (number, boolean, null)
			for i < n && data[i] != ',' && data[i] != '}' && data[i] != ']' && data[i] != ' ' && data[i] != '\t' && data[i] != '\r' && data[i] != '\n' {
				i++
			}
			valEnd = i
		}

		candidate := data[valStart:valEnd]
		if key != "" && json.Valid(candidate) {
			result[key] = json.RawMessage(candidate)
		}
	}

	return result
}

func (s *Store) seedDefaultPrompts() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	tbl := s.tables["prompts"]
	if tbl == nil {
		tbl = make(map[string]json.RawMessage)
		s.tables["prompts"] = tbl
	}
	modified := false
	for k, prompt := range DefaultPrompts {
		if _, ok := tbl[k]; !ok {
			dataBytes, _ := json.Marshal(map[string]string{"content": prompt})
			tbl[k] = dataBytes
			modified = true
		}
	}
	if modified {
		return s.saveTable("prompts")
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

	tbl := s.tables[table]
	if tbl == nil {
		tbl = make(map[string]json.RawMessage)
		s.tables[table] = tbl
	}

	for _, e := range entities {
		if e.ID == "" {
			continue
		}
		if !json.Valid(e.Data) {
			continue
		}
		tbl[e.ID] = e.Data
	}

	return s.saveTable(table)
}

// ReadAll returns all entities from a table with row-level error tolerance.
func (s *Store) ReadAll(table string) ([]GenericEntity, error) {
	if !AllowedTables[table] {
		return nil, fmt.Errorf("disallowed table: %s", table)
	}
	s.mu.RLock()
	defer s.mu.RUnlock()

	tbl := s.tables[table]
	var results []GenericEntity
	for id, raw := range tbl {
		if !json.Valid(raw) {
			continue
		}
		results = append(results, GenericEntity{
			ID:   id,
			Data: raw,
		})
	}
	return results, nil
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

	tbl := s.tables[table]
	if tbl != nil {
		for _, id := range ids {
			if id == "" {
				continue
			}
			delete(tbl, id)
		}
	}

	return s.saveTable(table)
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

	tbl := s.tables["books"]
	if tbl == nil {
		return nil, nil
	}
	raw, ok := tbl[id]
	if !ok {
		return nil, nil
	}
	var b Book
	if err := json.Unmarshal(raw, &b); err != nil {
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

	tbl := s.tables["prompts"]
	if tbl != nil {
		if raw, ok := tbl[key]; ok {
			var m map[string]string
			if err := json.Unmarshal(raw, &m); err == nil {
				if c, ok := m["content"]; ok && c != "" {
					return c, nil
				}
			}
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
