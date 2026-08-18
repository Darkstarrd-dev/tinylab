package assistant

import (
	"context"
	"sync"
	"time"
)

// Job is one periodic task the assistant can run on the user's behalf (e.g.
// cleaning expired trace logs). It mirrors the project's existing SweepTraces
// retention sweep as the first built-in job.
type Job struct {
	Name        string `json:"name"`        // stable id, e.g. "clean-traces"
	IntervalSec int    `json:"intervalSec"` // run cadence in seconds
}

// Scheduler tracks and executes periodic jobs the assistant knows about.
type Scheduler struct {
	mu      sync.RWMutex
	jobs    map[string]Job
	running bool
	cancel  context.CancelFunc
	runner  func(name string)
	wg      sync.WaitGroup
}

// NewScheduler returns an empty scheduler.
func NewScheduler() *Scheduler {
	return &Scheduler{
		jobs: make(map[string]Job),
	}
}

// RegisterJob adds (or replaces) a periodic job. A job with an empty name is ignored.
func (s *Scheduler) RegisterJob(j Job) {
	if j.Name == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.jobs[j.Name] = j
}

// RemoveJob removes a job by name.
func (s *Scheduler) RemoveJob(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.jobs, name)
}

// Has reports whether the named job is registered.
func (s *Scheduler) Has(name string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.jobs[name]
	return ok
}

// Get returns the Job configuration by name.
func (s *Scheduler) Get(name string) (Job, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	j, ok := s.jobs[name]
	return j, ok
}

// Count returns the number of registered jobs.
func (s *Scheduler) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.jobs)
}

// Jobs returns a snapshot copy of all registered jobs.
func (s *Scheduler) Jobs() []Job {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := make([]Job, 0, len(s.jobs))
	for _, j := range s.jobs {
		list = append(list, j)
	}
	return list
}

// Start spawns background runner goroutines for each registered job.
// It stops automatically when ctx is canceled or Stop() is called.
func (s *Scheduler) Start(ctx context.Context, runner func(name string)) {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	schedCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.runner = runner
	s.running = true

	// Take snapshot of jobs to spawn
	jobList := make([]Job, 0, len(s.jobs))
	for _, j := range s.jobs {
		jobList = append(jobList, j)
	}
	s.mu.Unlock()

	for _, j := range jobList {
		if j.IntervalSec <= 0 {
			continue
		}
		s.wg.Add(1)
		go s.runJob(schedCtx, j.Name, time.Duration(j.IntervalSec)*time.Second)
	}
}

func (s *Scheduler) runJob(ctx context.Context, name string, interval time.Duration) {
	defer s.wg.Done()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.RLock()
			runner := s.runner
			_, exists := s.jobs[name]
			s.mu.RUnlock()

			if exists && runner != nil {
				runner(name)
			}
		}
	}
}

// Stop terminates all running scheduler goroutines and waits for completion.
func (s *Scheduler) Stop() {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return
	}
	if s.cancel != nil {
		s.cancel()
	}
	s.running = false
	s.mu.Unlock()

	s.wg.Wait()
}
