package gallery

import (
	"archive/zip"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestExcludeStore_LifecycleAndPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "excludehash.txt")

	store, err := NewExcludeStore(path)
	if err != nil {
		t.Fatalf("NewExcludeStore missing file: %v", err)
	}
	if store.Count() != 0 {
		t.Fatalf("initial Count = %d, want 0", store.Count())
	}

	payload := []byte("sample-ad-image-bytes")
	sha, sz, crc, err := ComputeFingerprint(bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("ComputeFingerprint: %v", err)
	}

	added, dup, count, err := store.Add(ExcludeHashEntry{
		SHA256:   sha,
		Size:     sz,
		CRC32:    crc,
		HasCRC32: true,
		Name:     "ad_tail.png",
	})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if !added || dup || count != 1 {
		t.Fatalf("Add = (%v, %v, %d), want (true, false, 1)", added, dup, count)
	}

	// Duplicate add must be idempotent.
	added2, dup2, count2, err := store.Add(ExcludeHashEntry{SHA256: strings.ToUpper(sha), Size: sz, CRC32: crc, HasCRC32: true})
	if err != nil {
		t.Fatalf("duplicate Add: %v", err)
	}
	if added2 || !dup2 || count2 != 1 {
		t.Fatalf("duplicate Add = (%v, %v, %d), want (false, true, 1)", added2, dup2, count2)
	}

	// Reload from disk and verify fields survived.
	reloaded, err := NewExcludeStore(path)
	if err != nil {
		t.Fatalf("reload NewExcludeStore: %v", err)
	}
	if reloaded.Count() != 1 || !reloaded.HasSHA256(sha) {
		t.Fatalf("reloaded store missing entry %s (count=%d)", sha, reloaded.Count())
	}

	// Remove missing hash -> removed=false.
	otherSHA := strings.Repeat("b", 64)
	removedMiss, countMiss, err := reloaded.Remove(otherSHA)
	if err != nil || removedMiss || countMiss != 1 {
		t.Fatalf("Remove missing = (%v, %d, %v), want (false, 1, nil)", removedMiss, countMiss, err)
	}

	// Remove existing hash -> removed=true and persisted.
	removed, countAfter, err := reloaded.Remove(sha)
	if err != nil || !removed || countAfter != 0 {
		t.Fatalf("Remove existing = (%v, %d, %v), want (true, 0, nil)", removed, countAfter, err)
	}

	reloaded2, err := NewExcludeStore(path)
	if err != nil {
		t.Fatalf("reload2: %v", err)
	}
	if reloaded2.Count() != 0 {
		t.Fatalf("reloaded2 Count = %d, want 0", reloaded2.Count())
	}
}

func TestExcludeStore_ManualBareHashAndMightMatchMatrix(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "excludehash.txt")

	bareSHA := strings.Repeat("a", 64)
	fullPayload := []byte("exact-payload-data")
	fullSHA, fullSize, fullCRC, _ := ComputeFingerprint(bytes.NewReader(fullPayload))

	// First test sized+crc only.
	store, err := NewExcludeStore(path)
	if err != nil {
		t.Fatalf("NewExcludeStore: %v", err)
	}
	// Empty store short-circuits.
	if store.MightMatch(fullSize, fullCRC, true) {
		t.Fatal("empty store must not MightMatch")
	}

	if _, _, _, err := store.Add(ExcludeHashEntry{SHA256: fullSHA, Size: fullSize, CRC32: fullCRC, HasCRC32: true}); err != nil {
		t.Fatal(err)
	}
	if store.MightMatch(fullSize+1, fullCRC, true) {
		t.Fatal("different size should not MightMatch")
	}
	if store.MightMatch(fullSize, fullCRC^1, true) {
		t.Fatal("same size + different CRC32 should not MightMatch")
	}
	if !store.MightMatch(fullSize, 0, false) {
		t.Fatal("same size without CRC32 should MightMatch")
	}
	if !store.MightMatch(fullSize, fullCRC, true) {
		t.Fatal("same size + same CRC32 should MightMatch")
	}

	// Manually append a bare sha256 line + comments.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	manual := string(raw) + "\n# manual comment\n" + bareSHA + "\nnot-a-hash\n"
	if err := os.WriteFile(path, []byte(manual), 0644); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewExcludeStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Count() != 2 || !reloaded.HasSHA256(bareSHA) {
		t.Fatalf("manual bare hash load failed, count=%d", reloaded.Count())
	}
	_, _, hasUnsized := reloaded.Summary()
	if !hasUnsized {
		t.Fatal("expected hasUnsized=true when bare sha256 entry exists")
	}
	if !reloaded.MightMatch(999999, 123, true) {
		t.Fatal("unsized entry must force MightMatch=true")
	}
}

func TestExcludeStore_ConcurrentRace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "excludehash.txt")
	store, err := NewExcludeStore(path)
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sha, sz, crc, _ := ComputeFingerprint(strings.NewReader(fmt.Sprintf("item-%d", idx%4)))
			_, _, _, _ = store.Add(ExcludeHashEntry{SHA256: sha, Size: sz, CRC32: crc, HasCRC32: true, Name: "img.png"})
			_ = store.MightMatch(sz, crc, true)
			_ = store.HasSHA256(sha)
			_, _, _ = store.Summary()
		}(i)
	}
	wg.Wait()
	if store.Count() != 4 {
		t.Fatalf("Count = %d, want 4 distinct hashes", store.Count())
	}
}

func TestMatchZipEntries_Cascade(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	adBytes := []byte("ad-image-content-123456")
	for i := 1; i <= 20; i++ {
		name := fmt.Sprintf("pack/%02d.png", i)
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if i > 15 {
			_, _ = w.Write(adBytes)
		} else {
			_, _ = fmt.Fprintf(w, "story-page-%02d-unique-content", i)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	store, _ := NewExcludeStore("")
	sha, sz, crc, _ := ComputeFingerprint(bytes.NewReader(adBytes))
	_, _, _, _ = store.Add(ExcludeHashEntry{SHA256: sha, Size: sz, CRC32: crc, HasCRC32: true})

	tail10 := make([]string, 0, 10)
	for i := 11; i <= 20; i++ {
		tail10 = append(tail10, fmt.Sprintf("pack/%02d.png", i))
	}
	zipBytes := buf.Bytes()
	matched, matchedHashes, err := MatchZipEntries(bytes.NewReader(zipBytes), int64(len(zipBytes)), tail10, store)
	if err != nil {
		t.Fatalf("MatchZipEntries: %v", err)
	}
	if len(matched) != 5 {
		t.Fatalf("matched len = %d (%v), want 5", len(matched), matched)
	}
	for i := 16; i <= 20; i++ {
		p := fmt.Sprintf("pack/%02d.png", i)
		if matchedHashes[p] != sha {
			t.Errorf("matchedHashes[%s] = %q, want %q", p, matchedHashes[p], sha)
		}
	}
}
