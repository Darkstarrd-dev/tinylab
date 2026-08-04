package imagebatch

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

type Store interface {
	Create(context.Context, Project) error
	Get(context.Context, string) (Project, error)
	List(context.Context) ([]Project, error)
	Save(context.Context, Project) error
	Reconcile(context.Context, *Project) error
	WriteAsset(context.Context, Project, int, int, GeneratedAsset) (Asset, error)
	AssetPath(context.Context, string, string) (string, error)
	Import(context.Context, []byte, string) (Project, error)
}

type managerStore struct{ s *ProjectStore }

func (a managerStore) Create(ctx context.Context, p Project) error         { return a.s.Create(ctx, p) }
func (a managerStore) Get(ctx context.Context, id string) (Project, error) { return a.s.Get(ctx, id) }
func (a managerStore) List(ctx context.Context) ([]Project, error)         { return a.s.ListContext(ctx) }
func (a managerStore) Save(ctx context.Context, p Project) error           { return a.s.SaveProject(p) }
func (a managerStore) Reconcile(ctx context.Context, p *Project) error     { return a.s.Reconcile(ctx, p) }
func (a managerStore) WriteAsset(ctx context.Context, p Project, pi, vi int, g GeneratedAsset) (Asset, error) {
	return a.s.WriteAsset(ctx, p, pi, vi, g)
}
func (a managerStore) AssetPath(ctx context.Context, id, assetID string) (string, error) {
	return a.s.AssetPath(ctx, id, assetID)
}
func (a managerStore) Import(ctx context.Context, data []byte, format string) (Project, error) {
	if err := ctx.Err(); err != nil {
		return Project{}, err
	}
	return a.s.ImportProject(data, format, "")
}

type Manager struct {
	mu        sync.RWMutex
	store     Store
	generator ImageGenerator
	runtimes  map[string]*runtime
	ctx       context.Context
	cancel    context.CancelFunc
}
type runtime struct {
	project Project
	mu      sync.Mutex
	wake    chan struct{}
	pause   bool
	stop    string
	cancel  context.CancelFunc
	done    chan struct{}
	subs    map[chan Event]struct{}
}

func NewManager(store any, generator ImageGenerator) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	var st Store
	switch s := store.(type) {
	case Store:
		st = s
	case *ProjectStore:
		st = managerStore{s}
	default:
		panic("imagebatch: invalid store")
	}
	return &Manager{store: st, generator: generator, runtimes: map[string]*runtime{}, ctx: ctx, cancel: cancel}
}

func (m *Manager) Create(ctx context.Context, p *Project) (*Project, error) {
	if p == nil {
		return nil, errors.New("project is required")
	}
	project := *p
	if project.ProjectID == "" {
		project.ProjectID = fmt.Sprintf("imgproj-%x", time.Now().UnixNano())
	}
	if project.CreatedAt.IsZero() {
		project.CreatedAt = time.Now().UTC()
	}
	project.UpdatedAt = time.Now().UTC()
	if project.SchemaVersion == 0 {
		project.SchemaVersion = 1
	}
	if project.BatchConfig.RetryBackoff == "" {
		project.BatchConfig.RetryBackoff = BackoffExponentialJitter
	}
	if project.BatchConfig.OnError == "" {
		project.BatchConfig.OnError = OnErrorContinue
	}
	if project.BatchConfig.SeedMode == "" {
		project.BatchConfig.SeedMode = SeedProviderControlled
	}
	for pi := range project.Prompts {
		if project.Prompts[pi].Index == 0 {
			project.Prompts[pi].Index = pi + 1
		}
		if project.Prompts[pi].FinalFormat == "" {
			project.Prompts[pi].FinalFormat = FormatNatural
		}
		for vi := len(project.Prompts[pi].Variants); vi < project.Prompts[pi].Quantity; vi++ {
			idx := vi + 1
			id := fmt.Sprintf("%s-v%04d", project.Prompts[pi].ID, idx)
			seed := CalculateSeed(project.BatchConfig.SeedMode, project.BatchConfig.BaseSeed, project.Prompts[pi].Index, idx, project.Prompts[pi].Quantity)
			project.Prompts[pi].Variants = append(project.Prompts[pi].Variants, Variant{ID: id, Index: idx, Status: VariantPending, Seed: seed})
		}
	}
	project.Status = ProjectQueued
	project.Stats.Recompute(project.Prompts)
	if err := project.ValidateManifest(); err != nil {
		return nil, err
	}
	if err := m.store.Create(ctx, project); err != nil {
		return nil, err
	}
	r := m.addRuntime(project)
	if m.generator != nil {
		if err := m.startRuntime(r); err != nil {
			return nil, err
		}
	}
	return cloneProject(&project), nil
}
func cloneProject(p *Project) *Project {
	if p == nil {
		return nil
	}
	c := *p
	c.Prompts = append([]Prompt(nil), p.Prompts...)
	for i := range c.Prompts {
		c.Prompts[i].Variants = append([]Variant(nil), p.Prompts[i].Variants...)
	}
	return &c
}
func (m *Manager) addRuntime(p Project) *runtime {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.runtimes[p.ProjectID]; r != nil {
		r.mu.Lock()
		r.project = p
		r.mu.Unlock()
		return r
	}
	r := &runtime{project: p, wake: make(chan struct{}, 1), done: make(chan struct{}), subs: map[chan Event]struct{}{}}
	m.runtimes[p.ProjectID] = r
	return r
}
func (m *Manager) runtimeFor(ctx context.Context, id string) (*runtime, error) {
	m.mu.RLock()
	r := m.runtimes[id]
	m.mu.RUnlock()
	if r != nil {
		return r, nil
	}
	p, e := m.store.Get(ctx, id)
	if e != nil {
		return nil, e
	}
	return m.addRuntime(p), nil
}
func (m *Manager) Get(ctx context.Context, id string) (*Project, error) {
	r, e := m.runtimeFor(ctx, id)
	if e != nil {
		return nil, e
	}
	r.mu.Lock()
	p := cloneProject(&r.project)
	r.mu.Unlock()
	return p, nil
}
func (m *Manager) Snapshot(ctx context.Context, id string) (*Project, error) { return m.Get(ctx, id) }
func (m *Manager) List(ctx context.Context) ([]*Project, error) {
	ps, e := m.store.List(ctx)
	if e != nil {
		return nil, e
	}
	out := make([]*Project, 0, len(ps))
	for i := range ps {
		out = append(out, cloneProject(&ps[i]))
	}
	return out, nil
}
func (m *Manager) Import(ctx context.Context, data []byte, format string) (*Project, error) {
	p, e := m.store.Import(ctx, data, format)
	if e != nil {
		return nil, e
	}
	r := m.addRuntime(p)
	if m.generator != nil {
		if e = m.startRuntime(r); e != nil {
			return nil, e
		}
	}
	return cloneProject(&p), nil
}
func (m *Manager) Reconcile(ctx context.Context, id string) (*Project, error) {
	r, e := m.runtimeFor(ctx, id)
	if e != nil {
		return nil, e
	}
	r.mu.Lock()
	e = m.store.Reconcile(ctx, &r.project)
	p := cloneProject(&r.project)
	if e == nil {
		r.project.UpdatedAt = time.Now().UTC()
		r.project.Stats.Recompute(r.project.Prompts)
		p = cloneProject(&r.project)
	}
	r.mu.Unlock()
	if e != nil {
		return nil, e
	}
	if e = m.store.Save(ctx, *p); e == nil {
		r.emit(Event{Type: EventProjectReconciled, ProjectID: id, At: time.Now().UTC()})
	}
	return p, e
}
func (m *Manager) startRuntime(r *runtime) error {
	r.mu.Lock()
	if r.cancel != nil {
		r.mu.Unlock()
		return nil
	}
	r.pause = false
	r.stop = ""
	r.done = make(chan struct{})
	ctx, cancel := context.WithCancel(m.ctx)
	r.cancel = cancel
	r.project.Status = ProjectRunning
	p := r.project
	r.mu.Unlock()
	if e := m.store.Save(context.Background(), p); e != nil {
		cancel()
		r.mu.Lock()
		r.cancel = nil
		r.mu.Unlock()
		return e
	}
	go m.run(ctx, r)
	return nil
}
func (m *Manager) Start(ctx context.Context, id string) error {
	r, e := m.runtimeFor(ctx, id)
	if e != nil {
		return e
	}
	return m.startRuntime(r)
}
func (m *Manager) Pause(ctx context.Context, id string) (*Project, error) {
	r, e := m.runtimeFor(ctx, id)
	if e != nil {
		return nil, e
	}
	r.mu.Lock()
	r.pause = true
	r.project.Status = ProjectPaused
	p := cloneProject(&r.project)
	r.mu.Unlock()
	if e = m.store.Save(ctx, *p); e != nil {
		return nil, e
	}
	r.emit(Event{Type: EventProjectStatus, ProjectID: id, At: time.Now().UTC(), Data: ProjectPaused})
	return p, nil
}
func (m *Manager) Resume(ctx context.Context, id string) (*Project, error) {
	r, e := m.runtimeFor(ctx, id)
	if e != nil {
		return nil, e
	}
	r.mu.Lock()
	r.pause = false
	r.stop = ""
	r.project.Status = ProjectQueued
	p := cloneProject(&r.project)
	r.mu.Unlock()
	if e = m.store.Save(ctx, *p); e != nil {
		return nil, e
	}
	if e = m.startRuntime(r); e != nil {
		return nil, e
	}
	return m.Get(ctx, id)
}
func (m *Manager) Stop(ctx context.Context, id, mode string) (*Project, error) {
	if mode != "after-current" && mode != "immediate" {
		return nil, errors.New("invalid stop mode")
	}
	r, e := m.runtimeFor(ctx, id)
	if e != nil {
		return nil, e
	}
	r.mu.Lock()
	r.stop = mode
	r.project.Status = ProjectStopping
	cancel := r.cancel
	p := cloneProject(&r.project)
	r.mu.Unlock()
	if mode == "immediate" && cancel != nil {
		cancel()
	}
	select {
	case r.wake <- struct{}{}:
	default:
	}
	if e = m.store.Save(ctx, *p); e != nil {
		return nil, e
	}
	return m.Get(ctx, id)
}
func (m *Manager) Retry(ctx context.Context, id, promptID, variantID string) (*Project, error) {
	r, err := m.runtimeFor(ctx, id)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	found := false
	retryableVariant := false
	for pi := range r.project.Prompts {
		if r.project.Prompts[pi].ID != promptID {
			continue
		}
		for vi := range r.project.Prompts[pi].Variants {
			v := &r.project.Prompts[pi].Variants[vi]
			if v.ID != variantID {
				continue
			}
			found = true
			if v.Status == VariantFailed || v.Status == VariantInterrupted {
				v.Status, v.LastError, v.Attempt = VariantPending, "", 0
				retryableVariant = true
			}
		}
	}
	p := cloneProject(&r.project)
	r.mu.Unlock()
	if !found || !retryableVariant {
		return nil, errors.New("variant not found or not retryable")
	}
	if err = m.store.Save(ctx, *p); err != nil {
		return nil, err
	}
	if err = m.startRuntime(r); err != nil {
		return nil, err
	}
	return m.Get(ctx, id)
}
func (m *Manager) Subscribe(ctx context.Context, id string) (<-chan Event, error) {
	r, e := m.runtimeFor(ctx, id)
	if e != nil {
		return nil, e
	}
	ch := make(chan Event, 32)
	r.mu.Lock()
	r.subs[ch] = struct{}{}
	r.mu.Unlock()
	go func() {
		<-ctx.Done()
		r.mu.Lock()
		if _, ok := r.subs[ch]; ok {
			delete(r.subs, ch)
			close(ch)
		}
		r.mu.Unlock()
	}()
	return ch, nil
}
func (r *runtime) emit(ev Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for ch := range r.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}
func (m *Manager) Shutdown() {
	m.cancel()
	m.mu.RLock()
	for _, r := range m.runtimes {
		r.mu.Lock()
		if r.cancel != nil {
			r.cancel()
		}
		r.mu.Unlock()
	}
	m.mu.RUnlock()
}
func (m *Manager) run(ctx context.Context, r *runtime) {
	defer func() { r.mu.Lock(); r.cancel = nil; r.mu.Unlock(); close(r.done) }()
	Scheduler{manager: m}.Run(ctx, r)
}
func findNextVariant(p *Project) (int, int) {
	for pi := range p.Prompts {
		for vi := range p.Prompts[pi].Variants {
			s := p.Prompts[pi].Variants[vi].Status
			if s == VariantPending || s == VariantRetryWait {
				return pi, vi
			}
		}
	}
	return -1, -1
}
func findVariant(p *Project) (*Prompt, *Variant) {
	pi, vi := findNextVariant(p)
	if pi < 0 {
		return nil, nil
	}
	return &p.Prompts[pi], &p.Prompts[pi].Variants[vi]
}
func (m *Manager) AssetPath(ctx context.Context, id, assetID string) (string, error) {
	return m.store.AssetPath(ctx, id, assetID)
}
