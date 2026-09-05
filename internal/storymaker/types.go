package storymaker

import (
	"encoding/json"
	"time"
)

// BookType represents the type of book.
type BookType string

const (
	BookTypeReference BookType = "reference"
	BookTypeProject   BookType = "project"
)

// Book models a story book or reference book.
type Book struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Type          BookType `json:"type"`
	CreatedAt     string   `json:"createdAt"`
	GlobalSummary string   `json:"globalSummary,omitempty"`
	Author        string   `json:"author,omitempty"`
	Platform      string   `json:"platform,omitempty"`
}

// ChapterStatus models chapter status.
type ChapterStatus string

const (
	ChapterStatusRaw     ChapterStatus = "raw"
	ChapterStatusCleaned ChapterStatus = "cleaned"
	ChapterStatusDraft   ChapterStatus = "draft"
	ChapterStatusFinal   ChapterStatus = "final"
)

// Chapter models one chapter in a book.
type Chapter struct {
	ID            string        `json:"id"`
	BookID        string        `json:"bookId"`
	Index         int           `json:"index"`
	Title         string        `json:"title"`
	Content       string        `json:"content"`
	Status        ChapterStatus `json:"status"`
	OutlineNodeID string        `json:"outlineNodeId,omitempty"`
	Summary       string        `json:"summary,omitempty"`
	UpdatedAt     string        `json:"updatedAt"`
}

// EntityType models entity card categories.
type EntityType string

const (
	EntityTypeCharacter EntityType = "character"
	EntityTypeLocation  EntityType = "location"
	EntityTypeItem      EntityType = "item"
	EntityTypeSkill     EntityType = "skill"
	EntityTypeFaction   EntityType = "faction"
)

// EntityRef models an excerpt reference to a chapter.
type EntityRef struct {
	ChapterID string `json:"chapterId"`
	Excerpt   string `json:"excerpt"`
}

// CardImage models an image asset attached to a card.
type CardImage struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	Prompt    string `json:"prompt"`
	Group     string `json:"group,omitempty"`
	CreatedAt string `json:"createdAt"`
}

// EntityCard models a setting card.
type EntityCard struct {
	ID            string            `json:"id"`
	BookID        string            `json:"bookId"` // empty string for shared library materials
	Type          EntityType        `json:"type"`
	Name          string            `json:"name"`
	Aliases       []string          `json:"aliases"`
	Fields        map[string]string `json:"fields"`
	Description   string            `json:"description"`
	StyleNote     string            `json:"styleNote,omitempty"`
	StyleExamples []string          `json:"styleExamples,omitempty"`
	Refs          []EntityRef       `json:"refs"`
	Images        []CardImage       `json:"images,omitempty"`
	CoverImageID  string            `json:"coverImageId,omitempty"`
	UpdatedAt     string            `json:"updatedAt"`
}

// OutlineNode models one node in a book's outline.
type OutlineNode struct {
	ID              string `json:"id"`
	BookID          string `json:"bookId"`
	Volume          string `json:"volume"`
	Title           string `json:"title"`
	Summary         string `json:"summary"`
	Order           int    `json:"order"`
	Positioning     string `json:"positioning,omitempty"`
	Role            string `json:"role,omitempty"`
	SuspenseDensity string `json:"suspenseDensity,omitempty"`
	Foreshadow      string `json:"foreshadow,omitempty"`
	TwistLevel      int    `json:"twistLevel,omitempty"`
}

// NovelArchitecture models snowflake architecture for a book.
type NovelArchitecture struct {
	ID                string `json:"id"`
	BookID            string `json:"bookId"`
	Seed              string `json:"seed"`
	CharacterDynamics string `json:"characterDynamics"`
	WorldBuilding     string `json:"worldBuilding"`
	PlotStructure     string `json:"plotStructure"`
	UpdatedAt         string `json:"updatedAt"`
}

// SimScene models a simulation scene in M3.
type SimScene struct {
	ID                  string   `json:"id"`
	BookID              string   `json:"bookId"`
	Desc                string   `json:"desc"`
	Goal                string   `json:"goal"`
	PrevSummary         string   `json:"prevSummary"`
	PresentCharacterIDs []string `json:"presentCharacterIds"`
	CreatedAt           string   `json:"createdAt"`
}

// SimFragment models one simulated character fragment.
type SimFragment struct {
	ID          string         `json:"id"`
	SceneID     string         `json:"sceneId"`
	CharacterID string         `json:"characterId"`
	Candidates  []SimCandidate `json:"candidates"`
	AdoptedText string         `json:"adoptedText,omitempty"`
	Order       int            `json:"order"`
	CreatedAt   string         `json:"createdAt"`
}

// SimCandidate models one candidate response in a fragment.
type SimCandidate struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// StateEventType models state change events.
type StateEventType string

const (
	StateEventLocation     StateEventType = "location"
	StateEventRelationship StateEventType = "relationship"
	StateEventInjury       StateEventType = "injury"
	StateEventPossession   StateEventType = "possession"
	StateEventDeath        StateEventType = "death"
	StateEventOther        StateEventType = "other"
)

// StateEvent models character/world state change event.
type StateEvent struct {
	ID          string         `json:"id"`
	BookID      string         `json:"bookId"`
	ChapterID   string         `json:"chapterId"`
	EntityID    string         `json:"entityId"`
	EventType   StateEventType `json:"eventType"`
	Description string         `json:"description"`
	CreatedAt   string         `json:"createdAt"`
}

// IssueLevel models consistency issue severity.
type IssueLevel string

const (
	IssueLevelError   IssueLevel = "error"
	IssueLevelWarning IssueLevel = "warning"
)

// IssueStatus models consistency issue resolution state.
type IssueStatus string

const (
	IssueStatusOpen     IssueStatus = "open"
	IssueStatusIgnored  IssueStatus = "ignored"
	IssueStatusResolved IssueStatus = "resolved"
)

// ConsistencyIssue models a flagged plot/character inconsistency.
type ConsistencyIssue struct {
	ID             string      `json:"id"`
	BookID         string      `json:"bookId"`
	ChapterID      string      `json:"chapterId"`
	Type           string      `json:"type"`
	Level          IssueLevel  `json:"level"`
	Description    string      `json:"description"`
	RelatedCardIDs []string    `json:"relatedCardIds"`
	Suggestion     string      `json:"suggestion"`
	Status         IssueStatus `json:"status"`
}

// MergeCandidate models card deduplication/merging candidate pair.
type MergeCandidate struct {
	ID         string  `json:"id"`
	CardAID    string  `json:"cardAId"`
	CardBID    string  `json:"cardBId"`
	Similarity float64 `json:"similarity"`
	Status     string  `json:"status"` // pending | merged | kept
}

// GenericEntity wraps any entity with an ID and raw JSON data.
type GenericEntity struct {
	ID   string          `json:"id"`
	Data json.RawMessage `json:"data"`
}

// NowRFC3339 returns current UTC time formatted as ISO/RFC3339 string.
func NowRFC3339() string {
	return time.Now().UTC().Format(time.RFC3339)
}
