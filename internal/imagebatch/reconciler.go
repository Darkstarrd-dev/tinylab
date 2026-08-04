package imagebatch

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type FileClass string

const (
	FileValid   FileClass = "valid"
	FilePart    FileClass = "part"
	FileMissing FileClass = "missing"
	FileCorrupt FileClass = "corrupt"
	FileOrphan  FileClass = "orphan"
)

type ReconcileFile struct {
	RelativePath string
	Class        FileClass
	Bytes        int64
	Width        int
	Height       int
	Err          string
}
type ReconcileReport struct {
	Project Project
	Files   []ReconcileFile
	Changed bool
	Managed bool
}

type Reconciler struct{ Store *ProjectStore }

func NewReconciler(store *ProjectStore) *Reconciler { return &Reconciler{Store: store} }
func (r *Reconciler) Reconcile(slug string) (ReconcileReport, error) {
	if r == nil || r.Store == nil {
		return ReconcileReport{}, errors.New("nil reconciler store")
	}
	p, err := r.Store.LoadProject(slug)
	if err != nil {
		return ReconcileReport{}, err
	}
	return r.ReconcileProject(p)
}
func (r *Reconciler) ReconcileProject(p Project) (ReconcileReport, error) {
	if r == nil || r.Store == nil {
		return ReconcileReport{}, errors.New("nil reconciler store")
	}
	if err := p.ValidateManifest(); err != nil {
		return ReconcileReport{}, err
	}
	dir, err := r.Store.dir(p.Slug)
	if err != nil {
		return ReconcileReport{}, err
	}
	report := ReconcileReport{Project: p, Managed: true}
	expected := map[string]*Variant{}
	for pi := range p.Prompts {
		for vi := range p.Prompts[pi].Variants {
			v := &p.Prompts[pi].Variants[vi]
			if v.RelativePath != "" {
				expected[filepath.ToSlash(v.RelativePath)] = v
			} else if rel, e := SlotRelativePath(p.Prompts[pi].Index, v.Index, ".png"); e == nil {
				expected[rel] = v
			}
		}
	}
	seen := map[string]bool{}
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() {
			if path != dir && d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, e := filepath.Rel(dir, path)
		if e != nil {
			return e
		}
		rel = filepath.ToSlash(rel)
		if rel == manifestName {
			return nil
		}
		if strings.HasSuffix(strings.ToLower(rel), ".part") {
			report.Files = append(report.Files, ReconcileFile{RelativePath: rel, Class: FilePart})
			return nil
		}
		pi, vi, ext, e := ParseSlotPath(rel)
		if e != nil || pi < 1 || vi < 1 {
			report.Files = append(report.Files, ReconcileFile{RelativePath: rel, Class: FileOrphan})
			return nil
		}
		key := fmt.Sprintf("p%04d/v%04d%s", pi, vi, ext)
		st, e := os.Stat(path)
		if e != nil {
			return e
		}
		bytes := st.Size()
		w, h, de := decodeImageFile(path)
		if de != nil || bytes <= 0 {
			rf := ReconcileFile{RelativePath: rel, Class: FileCorrupt, Bytes: bytes, Width: w, Height: h}
			if de != nil {
				rf.Err = de.Error()
			}
			report.Files = append(report.Files, rf)
			return nil
		}
		rf := ReconcileFile{RelativePath: rel, Class: FileValid, Bytes: bytes, Width: w, Height: h}
		report.Files = append(report.Files, rf)
		if v := expected[key]; v != nil {
			seen[key] = true
			if v.Status != VariantSucceeded || v.RelativePath != rel || v.Bytes != bytes || v.Width != w || v.Height != h {
				v.Status = VariantSucceeded
				v.RelativePath = rel
				v.Bytes = bytes
				v.Width = w
				v.Height = h
				report.Changed = true
			}
		} else {
			rf.Class = FileOrphan
			report.Files[len(report.Files)-1] = rf
		}
		return nil
	})
	if err != nil {
		return report, err
	}
	for key, v := range expected {
		if seen[key] {
			continue
		}
		if v.Status == VariantSucceeded || v.Status == VariantRunning {
			v.Status = VariantInterrupted
			report.Changed = true
		} else if v.Status == VariantRetryWait {
			v.Status = VariantInterrupted
			report.Changed = true
		}
	}
	p.Stats.Recompute(p.Prompts)
	report.Project = p
	if report.Changed {
		if err = r.Store.SaveProject(p); err != nil {
			return report, err
		}
	}
	sort.Slice(report.Files, func(i, j int) bool { return report.Files[i].RelativePath < report.Files[j].RelativePath })
	return report, nil
}
func decodeImageFile(path string) (int, int, error) {
	f, e := os.Open(path)
	if e != nil {
		return 0, 0, e
	}
	defer f.Close()
	data, e := io.ReadAll(io.LimitReader(f, 32<<20))
	if e != nil {
		return 0, 0, e
	}
	return decodeImage(data)
}

// ScanUnmanaged reports image directories without a valid project manifest; they
// are intentionally never converted into runnable projects.
func (r *Reconciler) ScanUnmanaged() ([]string, error) {
	if r == nil || r.Store == nil {
		return nil, errors.New("nil reconciler store")
	}
	es, e := os.ReadDir(r.Store.root)
	if e != nil {
		return nil, e
	}
	out := []string{}
	for _, ent := range es {
		if !ent.IsDir() {
			continue
		}
		if _, e = os.Stat(filepath.Join(r.Store.root, ent.Name(), manifestName)); os.IsNotExist(e) {
			out = append(out, ent.Name())
		}
	}
	sort.Strings(out)
	return out, nil
}
