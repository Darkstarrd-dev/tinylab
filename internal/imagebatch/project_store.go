package imagebatch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

const manifestName = "project.json"

type ProjectStore struct {
	root  string
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func NewProjectStore(root string) (*ProjectStore, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("image root is required")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(abs, 0755); err != nil {
		return nil, err
	}
	return &ProjectStore{root: abs, locks: make(map[string]*sync.Mutex)}, nil
}
func (s *ProjectStore) Root() string { return s.root }
func (s *ProjectStore) projectLock(slug string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := s.locks[slug]
	if l == nil {
		l = &sync.Mutex{}
		s.locks[slug] = l
	}
	return l
}
func (s *ProjectStore) dir(slug string) (string, error) { return ProjectDir(s.root, slug) }

func (s *ProjectStore) CreateProject(p Project) error {
	if err := p.ValidateManifest(); err != nil {
		return err
	}
	d, err := s.dir(p.Slug)
	if err != nil {
		return err
	}
	l := s.projectLock(p.Slug)
	l.Lock()
	defer l.Unlock()
	if _, err = os.Stat(d); err == nil {
		return fmt.Errorf("project already exists: %s", p.Slug)
	} else if !os.IsNotExist(err) {
		return err
	}
	if err = os.MkdirAll(d, 0755); err != nil {
		return err
	}
	if err = s.saveUnlocked(d, p); err != nil {
		_ = os.RemoveAll(d)
		return err
	}
	return nil
}
func (s *ProjectStore) SaveProject(p Project) error {
	if err := p.ValidateManifest(); err != nil {
		return err
	}
	d, err := s.dir(p.Slug)
	if err != nil {
		return err
	}
	l := s.projectLock(p.Slug)
	l.Lock()
	defer l.Unlock()
	if st, e := os.Stat(d); e != nil || !st.IsDir() {
		if e == nil {
			e = errors.New("project path is not directory")
		}
		return e
	}
	return s.saveUnlocked(d, p)
}
func (s *ProjectStore) saveUnlocked(d string, p Project) error {
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp, err := os.CreateTemp(d, ".project-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err = tmp.Write(b); err == nil {
		err = tmp.Sync()
	}
	cerr := tmp.Close()
	if err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(d, manifestName))
}
func (s *ProjectStore) LoadProject(slug string) (Project, error) {
	d, err := s.dir(slug)
	if err != nil {
		return Project{}, err
	}
	l := s.projectLock(slug)
	l.Lock()
	defer l.Unlock()
	b, err := os.ReadFile(filepath.Join(d, manifestName))
	if err != nil {
		return Project{}, err
	}
	var p Project
	if err = json.Unmarshal(b, &p); err != nil {
		return Project{}, err
	}
	if err = p.ValidateManifest(); err != nil {
		return Project{}, err
	}
	return p, nil
}
func (s *ProjectStore) ListProjects() ([]Project, error) {
	es, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	out := make([]Project, 0)
	for _, e := range es {
		if !e.IsDir() {
			continue
		}
		p, err := s.LoadProject(e.Name())
		if err != nil {
			continue
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Slug < out[j].Slug })
	return out, nil
}
func (s *ProjectStore) Save(p Project) error              { return s.SaveProject(p) }
func (s *ProjectStore) Load(slug string) (Project, error) { return s.LoadProject(slug) }
func (s *ProjectStore) List() ([]Project, error)          { return s.ListProjects() }

func projectMap(p Project) (map[string]any, error) {
	b, e := json.Marshal(p)
	if e != nil {
		return nil, e
	}
	var m map[string]any
	e = json.Unmarshal(b, &m)
	return m, e
}
func (s *ProjectStore) ExportProject(slug string, format string) ([]byte, error) {
	p, e := s.LoadProject(slug)
	if e != nil {
		return nil, e
	}
	switch strings.ToLower(format) {
	case "", "json":
		return json.MarshalIndent(p, "", "  ")
	case "yaml", "yml":
		m, e := projectMap(p)
		if e != nil {
			return nil, e
		}
		return yaml.Marshal(m)
	default:
		return nil, errors.New("unsupported export format")
	}
}
func (s *ProjectStore) Export(slug, format string) ([]byte, error) {
	return s.ExportProject(slug, format)
}
func (s *ProjectStore) ImportProject(data []byte, format string, slugOverride string) (Project, error) {
	var p Project
	var raw []byte
	var err error
	switch strings.ToLower(format) {
	case "", "json":
		raw = data
	case "yaml", "yml":
		var m map[string]any
		if err = yaml.Unmarshal(data, &m); err == nil {
			raw, err = json.Marshal(m)
		}
	default:
		return p, errors.New("unsupported import format")
	}
	if err != nil {
		return p, err
	}
	if err = json.Unmarshal(raw, &p); err != nil {
		return p, err
	}
	if slugOverride != "" {
		if !IsSafeSlug(slugOverride) {
			return p, errors.New("invalid slug")
		}
		p.Slug = slugOverride
	}
	if err = p.ValidateManifest(); err != nil {
		return p, err
	}
	if err = s.validateImportedPaths(p); err != nil {
		return p, err
	}
	if err = s.CreateProject(p); err != nil {
		return p, err
	}
	return p, nil
}
func (s *ProjectStore) validateImportedPaths(p Project) error {
	for _, pr := range p.Prompts {
		for _, v := range pr.Variants {
			if v.RelativePath != "" {
				if _, e := ResolveAssetPath(s.root, p.Slug, v.RelativePath); e != nil {
					return e
				}
				if _, _, _, e := ParseSlotPath(v.RelativePath); e != nil {
					return e
				}
			}
		}
	}
	return nil
}
func (s *ProjectStore) Import(data []byte, format, slug string) (Project, error) {
	return s.ImportProject(data, format, slug)
}

func decodeImage(data []byte) (w, h int, err error) {
	if len(data) == 0 {
		return 0, 0, errors.New("empty image")
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, fmt.Errorf("invalid image: %w", err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return 0, 0, errors.New("invalid image dimensions")
	}
	return cfg.Width, cfg.Height, nil
}
func (s *ProjectStore) WriteSlot(slug string, promptIndex, variantIndex int, asset GeneratedAsset) (string, error) {
	ext := asset.Extension
	if ext == "" {
		ext = extensionForMIME(asset.MIME)
	}
	rel, err := SlotRelativePath(promptIndex, variantIndex, ext)
	if err != nil {
		return "", err
	}
	w, h, err := decodeImage(asset.Bytes)
	if err != nil {
		return "", err
	}
	d, err := s.dir(slug)
	if err != nil {
		return "", err
	}
	l := s.projectLock(slug)
	l.Lock()
	defer l.Unlock()
	slot, err := ResolveAssetPath(s.root, slug, rel)
	if err != nil {
		return "", err
	}
	if _, err = os.Stat(slot); err == nil {
		return "", errors.New("slot already exists")
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err = os.MkdirAll(filepath.Dir(slot), 0755); err != nil {
		return "", err
	}
	tmp, err := os.OpenFile(slot+".part", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err = io.Copy(tmp, bytes.NewReader(asset.Bytes)); err == nil {
		err = tmp.Sync()
	}
	cerr := tmp.Close()
	if err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if err = os.Rename(tmpName, slot); err != nil {
		return "", err
	}
	_ = d
	_ = w
	_ = h
	return rel, nil
}
func extensionForMIME(m string) string {
	switch strings.ToLower(strings.TrimSpace(strings.Split(m, ";")[0])) {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/bmp":
		return ".bmp"
	case "image/tiff":
		return ".tiff"
	}
	return ""
}

// Ensure no accidental giant raw metadata or image bytes enter manifests.
var _ = time.Now

func (s *ProjectStore) Create(ctx context.Context, p Project) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	return s.CreateProject(p)
}
func (s *ProjectStore) Get(ctx context.Context, id string) (Project, error) {
	select {
	case <-ctx.Done():
		return Project{}, ctx.Err()
	default:
	}
	if p, e := s.LoadProject(id); e == nil && p.ProjectID == id {
		return p, nil
	}
	ps, e := s.ListProjects()
	if e != nil {
		return Project{}, e
	}
	for _, p := range ps {
		if p.ProjectID == id {
			return p, nil
		}
	}
	return Project{}, os.ErrNotExist
}
func (s *ProjectStore) ListContext(ctx context.Context) ([]Project, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	return s.ListProjects()
}
func (s *ProjectStore) ReconcileContext(ctx context.Context, p *Project) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	if p == nil {
		return errors.New("nil project")
	}
	rr, e := NewReconciler(s).ReconcileProject(*p)
	if e == nil {
		*p = rr.Project
	}
	return e
}
func (s *ProjectStore) WriteAsset(ctx context.Context, p Project, promptIndex, variantIndex int, a GeneratedAsset) (Asset, error) {
	select {
	case <-ctx.Done():
		return Asset{}, ctx.Err()
	default:
	}
	rel, e := s.WriteSlot(p.Slug, promptIndex, variantIndex, a)
	if e != nil {
		return Asset{}, e
	}
	full := filepath.Join(s.root, p.Slug, filepath.FromSlash(rel))
	st, e := os.Stat(full)
	if e != nil {
		return Asset{}, e
	}
	w, h, e := decodeImageFile(full)
	if e != nil {
		return Asset{}, e
	}
	return Asset{ID: fmt.Sprintf("p%04d-v%04d", promptIndex, variantIndex), RelativePath: rel, MIME: a.MIME, Extension: filepath.Ext(rel), Width: w, Height: h, Bytes: st.Size(), Meta: a.Meta}, nil
}
func (s *ProjectStore) Reconcile(ctx context.Context, p *Project) error {
	return s.ReconcileContext(ctx, p)
}

// AssetPath resolves an asset identifier to a controlled project-relative file.
func (s *ProjectStore) AssetPath(ctx context.Context, projectID, assetID string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	projects, err := s.ListProjects()
	if err != nil {
		return "", err
	}
	for _, p := range projects {
		if p.ProjectID != projectID {
			continue
		}
		for _, prompt := range p.Prompts {
			for _, variant := range prompt.Variants {
				if variant.Asset != nil && variant.Asset.ID == assetID {
					return ResolveAssetPath(s.root, p.Slug, variant.Asset.RelativePath)
				}
				if variant.ID == assetID && variant.RelativePath != "" {
					return ResolveAssetPath(s.root, p.Slug, variant.RelativePath)
				}
			}
		}
	}
	return "", os.ErrNotExist
}
