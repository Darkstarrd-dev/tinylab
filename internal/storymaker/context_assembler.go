package storymaker

import (
	"encoding/json"
	"sort"
)

// AssembleInput provides parameters for context assembly.
type AssembleInput struct {
	BookID            string  `json:"bookId"`
	ChapterIndex      *int    `json:"chapterIndex,omitempty"`
	SceneID           *string `json:"sceneId,omitempty"`
	TargetCharacterID *string `json:"targetCharacterId,omitempty"`
}

// AssembledContext contains assembled novel context for M3/M4 prompting.
type AssembledContext struct {
	BookID             string             `json:"bookId"`
	Architecture       *NovelArchitecture `json:"architecture,omitempty"`
	CurrentOutline     *OutlineNode       `json:"currentOutline,omitempty"`
	NextOutline        *OutlineNode       `json:"nextOutline,omitempty"`
	GlobalSummary      string             `json:"globalSummary"`
	PrevChapterSummary string             `json:"prevChapterSummary"`
	CharacterTimeline  []StateEvent       `json:"characterTimeline"`
	AdoptedFragments   []string           `json:"adoptedFragments"`
	Scene              *SimScene          `json:"scene,omitempty"`
	TargetCharacter    *EntityCard        `json:"targetCharacter,omitempty"`
	PresentCharacters  []EntityCard       `json:"presentCharacters"`
}

// AssembleContext constructs the full context for M3/M4 without RAG.
func AssembleContext(store *Store, input AssembleInput) (*AssembledContext, error) {
	ctx := &AssembledContext{
		BookID:             input.BookID,
		CharacterTimeline:  []StateEvent{},
		AdoptedFragments:   []string{},
		PresentCharacters:  []EntityCard{},
		GlobalSummary:      "",
		PrevChapterSummary: "",
	}

	book, _ := store.GetBook(input.BookID)
	if book != nil {
		ctx.GlobalSummary = book.GlobalSummary
	}

	ctx.Architecture, _ = store.GetArchitecture(input.BookID)

	if input.ChapterIndex != nil {
		idx := *input.ChapterIndex
		outlineList, _ := store.GetOutline(input.BookID)
		for _, o := range outlineList {
			if o.Order == idx {
				node := o
				ctx.CurrentOutline = &node
			} else if o.Order == idx+1 {
				node := o
				ctx.NextOutline = &node
			}
		}

		chapters, _ := store.GetChapters(input.BookID)
		for _, c := range chapters {
			if c.Index == idx-1 {
				ctx.PrevChapterSummary = c.Summary
				break
			}
		}
	}

	if input.TargetCharacterID != nil && *input.TargetCharacterID != "" {
		targetID := *input.TargetCharacterID
		rawEvents, _ := store.ReadAll("state_events")
		for _, r := range rawEvents {
			var ev StateEvent
			if err := json.Unmarshal(r.Data, &ev); err == nil {
				if ev.BookID == input.BookID && ev.EntityID == targetID {
					ctx.CharacterTimeline = append(ctx.CharacterTimeline, ev)
				}
			}
		}
		sort.Slice(ctx.CharacterTimeline, func(i, j int) bool {
			return ctx.CharacterTimeline[i].CreatedAt < ctx.CharacterTimeline[j].CreatedAt
		})

		allCards, _ := store.GetCards(input.BookID)
		for _, card := range allCards {
			if card.ID == targetID {
				target := card
				ctx.TargetCharacter = &target
				break
			}
		}
	}

	if input.SceneID != nil && *input.SceneID != "" {
		sceneID := *input.SceneID
		scenes, _ := store.GetScenes(input.BookID)
		for _, s := range scenes {
			if s.ID == sceneID {
				curScene := s
				ctx.Scene = &curScene
				break
			}
		}

		fragments, _ := store.GetFragments(sceneID)
		for _, f := range fragments {
			if f.AdoptedText != "" {
				ctx.AdoptedFragments = append(ctx.AdoptedFragments, f.AdoptedText)
			}
		}

		if ctx.Scene != nil && len(ctx.Scene.PresentCharacterIDs) > 0 {
			presentMap := make(map[string]bool)
			for _, pid := range ctx.Scene.PresentCharacterIDs {
				presentMap[pid] = true
			}
			allCards, _ := store.GetCards(input.BookID)
			for _, card := range allCards {
				if presentMap[card.ID] {
					ctx.PresentCharacters = append(ctx.PresentCharacters, card)
				}
			}
		}
	}

	return ctx, nil
}
