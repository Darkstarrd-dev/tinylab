package imagebatch

import (
	"context"
	"errors"
	"math/rand/v2"
	"strings"
	"time"
)

type Scheduler struct{ manager *Manager }

func (s Scheduler) Run(ctx context.Context, r *runtime) {
	m := s.manager
	var previousStart time.Time
	for {
		r.mu.Lock()
		if r.stop == "immediate" {
			r.project.Status = ProjectCanceled
			p := r.project
			r.mu.Unlock()
			_ = m.store.Save(context.Background(), p)
			return
		}
		if r.pause {
			r.project.Status = ProjectPaused
			p := r.project
			r.mu.Unlock()
			_ = m.store.Save(context.Background(), p)
			select {
			case <-ctx.Done():
				s.interrupt(r)
				return
			case <-r.wake:
				continue
			}
		}
		if r.stop == "after-current" {
			r.project.Status = ProjectCompleted
			p := r.project
			r.mu.Unlock()
			_ = m.store.Save(context.Background(), p)
			return
		}
		pi, vi := findNextVariant(&r.project)
		if pi < 0 {
			r.project.Status = ProjectCompleted
			r.project.Stats.Recompute(r.project.Prompts)
			p := r.project
			r.mu.Unlock()
			_ = m.store.Save(context.Background(), p)
			r.emit(Event{Type: EventProjectCompleted, ProjectID: p.ProjectID, At: time.Now().UTC()})
			return
		}
		prompt := r.project.Prompts[pi]
		variant := &r.project.Prompts[pi].Variants[vi]
		variant.Status = VariantRunning
		variant.Attempt++
		variant.Seed = CalculateSeed(r.project.BatchConfig.SeedMode, r.project.BatchConfig.BaseSeed, prompt.Index, variant.Index, prompt.Quantity)
		project := r.project
		project.SchedulerCursor = Cursor{PromptIndex: prompt.Index, VariantIndex: variant.Index}
		project.Status = ProjectRunning
		r.project = project
		prompt = project.Prompts[pi]
		variant = &project.Prompts[pi].Variants[vi]
		r.mu.Unlock()
		_ = m.store.Save(context.Background(), project)

		if !previousStart.IsZero() {
			wait := time.Duration(project.BatchConfig.IntervalMs)*time.Millisecond - time.Since(previousStart)
			if wait > 0 && !sleepContext(ctx, wait) {
				s.interrupt(r)
				return
			}
		}
		previousStart = time.Now().UTC()
		r.emit(Event{Type: EventVariantStarted, ProjectID: project.ProjectID, PromptID: prompt.ID, VariantID: variant.ID, At: previousStart})
		req := ImageGenerationRequest{
			ProjectID: project.ProjectID, PromptID: prompt.ID, VariantID: variant.ID,
			Model: project.ImageConfig.Model, Protocol: project.ImageConfig.Protocol,
			Endpoint: project.ImageConfig.Endpoint, Prompt: prompt.FinalPrompt,
			PromptFormat: prompt.FinalFormat, NegativePrompt: prompt.NegativePrompt,
			Params: project.ImageConfig.Params, Seed: variant.Seed,
		}

		var result ImageGenerationResult
		var genErr error
		maxAttempts := project.BatchConfig.MaxRetries + 1
		for attempt := 1; attempt <= maxAttempts; attempt++ {
			if ctx.Err() != nil {
				s.interrupt(r)
				return
			}
			result, genErr = m.generator.Generate(ctx, req)
			if genErr == nil {
				break
			}
			if !retryable(genErr) || attempt >= maxAttempts {
				break
			}
			delay := retryDelay(project.BatchConfig, attempt)
			r.emit(Event{Type: EventVariantRetryWait, ProjectID: project.ProjectID, PromptID: prompt.ID, VariantID: variant.ID, At: time.Now().UTC(), Data: delay.String()})
			if !sleepContext(ctx, delay) {
				s.interrupt(r)
				return
			}
		}
		if genErr != nil {
			interrupted := errors.Is(genErr, context.Canceled) || ctx.Err() != nil
			s.finishError(r, prompt.ID, variant.ID, genErr, interrupted)
			if interrupted {
				return
			}
			r.mu.Lock()
			stopOnError := r.project.BatchConfig.OnError == OnErrorStop
			r.mu.Unlock()
			if stopOnError {
				return
			}
			continue
		}
		if len(result.Assets) == 0 {
			s.finishError(r, prompt.ID, variant.ID, errors.New("generator returned no assets"), false)
			continue
		}
		asset, writeErr := m.store.WriteAsset(context.Background(), project, prompt.Index, variant.Index, result.Assets[0])
		if writeErr != nil {
			s.finishError(r, prompt.ID, variant.ID, writeErr, false)
			continue
		}

		r.mu.Lock()
		var target *Variant
		for pidx := range r.project.Prompts {
			if r.project.Prompts[pidx].ID != prompt.ID {
				continue
			}
			for vidx := range r.project.Prompts[pidx].Variants {
				if r.project.Prompts[pidx].Variants[vidx].ID == variant.ID {
					target = &r.project.Prompts[pidx].Variants[vidx]
					break
				}
			}
		}
		if target != nil && target.Status != VariantSucceeded {
			target.Status = VariantSucceeded
			target.Asset = &asset
			target.RelativePath, target.MIME = asset.RelativePath, asset.MIME
			target.Width, target.Height, target.Bytes = asset.Width, asset.Height, asset.Bytes
			target.DurationMs, target.CreatedAt, target.LastError = result.Duration.Milliseconds(), time.Now().UTC(), ""
			r.project.Stats.Recompute(r.project.Prompts)
		}
		p := r.project
		r.mu.Unlock()
		_ = m.store.Save(context.Background(), p)
		r.emit(Event{Type: EventVariantCompleted, ProjectID: p.ProjectID, PromptID: prompt.ID, VariantID: variant.ID, At: time.Now().UTC()})
	}
}

func (s Scheduler) interrupt(r *runtime) {
	r.mu.Lock()
	var promptID, variantID string
	for pi := range r.project.Prompts {
		for vi := range r.project.Prompts[pi].Variants {
			if r.project.Prompts[pi].Variants[vi].Status == VariantRunning {
				promptID, variantID = r.project.Prompts[pi].ID, r.project.Prompts[pi].Variants[vi].ID
				break
			}
		}
		if promptID != "" {
			break
		}
	}
	r.mu.Unlock()
	if promptID != "" {
		s.finishError(r, promptID, variantID, context.Canceled, true)
	}
}

func (s Scheduler) finishError(r *runtime, promptID, variantID string, err error, interrupted bool) {
	r.mu.Lock()
	for pi := range r.project.Prompts {
		if r.project.Prompts[pi].ID != promptID {
			continue
		}
		for vi := range r.project.Prompts[pi].Variants {
			v := &r.project.Prompts[pi].Variants[vi]
			if v.ID == variantID {
				if interrupted {
					v.Status = VariantInterrupted
				} else {
					v.Status = VariantFailed
				}
				v.LastError = err.Error()
			}
		}
	}
	r.project.Stats.Recompute(r.project.Prompts)
	p := r.project
	r.mu.Unlock()
	_ = s.manager.store.Save(context.Background(), p)
	typ := EventVariantFailed
	if interrupted {
		typ = EventVariantInterrupted
	}
	r.emit(Event{Type: typ, ProjectID: p.ProjectID, PromptID: promptID, VariantID: variantID, At: time.Now().UTC(), Data: err.Error()})
}

func sleepContext(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return true
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func retryable(err error) bool {
	if errors.Is(err, context.Canceled) {
		return false
	}
	s := strings.ToLower(err.Error())
	for _, token := range []string{"429", "500", "502", "503", "timeout", "temporarily unavailable", "connection reset", "eof"} {
		if strings.Contains(s, token) {
			return true
		}
	}
	return false
}

func retryDelay(c BatchConfig, attempt int) time.Duration {
	d := time.Duration(c.RetryDelayMs) * time.Millisecond
	if d <= 0 {
		return 0
	}
	if c.RetryBackoff == BackoffExponential || c.RetryBackoff == BackoffExponentialJitter {
		d *= time.Duration(1 << min(attempt-1, 10))
		if c.RetryBackoff == BackoffExponentialJitter {
			d += time.Duration(rand.Int64N(int64(d/4) + 1))
		}
	}
	return d
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
