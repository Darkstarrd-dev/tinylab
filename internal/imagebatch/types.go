// Package imagebatch contains the durable schema and validation primitives for
// Playground image batches. It deliberately has no HTTP, scheduler, or API-key
// concerns.
package imagebatch

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type ProjectStatus string
type VariantStatus string

type EventType string

const (
	ProjectDraft               ProjectStatus = "draft"
	ProjectPlanning            ProjectStatus = "planning"
	ProjectConverting          ProjectStatus = "converting"
	ProjectReview              ProjectStatus = "review"
	ProjectQueued              ProjectStatus = "queued"
	ProjectRunning             ProjectStatus = "running"
	ProjectPaused              ProjectStatus = "paused"
	ProjectStopping            ProjectStatus = "stopping"
	ProjectCompleted           ProjectStatus = "completed"
	ProjectCompletedWithErrors ProjectStatus = "completed_with_errors"
	ProjectFailed              ProjectStatus = "failed"
	ProjectCanceled            ProjectStatus = "canceled"

	VariantPending     VariantStatus = "pending"
	VariantRunning     VariantStatus = "running"
	VariantRetryWait   VariantStatus = "retry_wait"
	VariantSucceeded   VariantStatus = "succeeded"
	VariantFailed      VariantStatus = "failed"
	VariantInterrupted VariantStatus = "interrupted"
	VariantCanceled    VariantStatus = "canceled"
)

const (
	FormatNatural            = "natural"
	FormatTag                = "tag"
	FormatJSON               = "json"
	BackoffFixed             = "fixed"
	BackoffExponential       = "exponential"
	BackoffExponentialJitter = "exponential-jitter"
	OnErrorContinue          = "continue"
	OnErrorStop              = "stop"
	SeedRandom               = "random"
	SeedIncrement            = "increment"
	SeedFixedBasePlusOffset  = "fixed-base-plus-offset"
	SeedProviderControlled   = "provider-controlled"
)

const (
	MaxPromptQuantity = 100
	MaxPromptCount    = 10000
	MaxRetries        = 20
	MaxIntervalMs     = 24 * 60 * 60 * 1000
	MaxRetryDelayMs   = 24 * 60 * 60 * 1000
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
var safeSlug = regexp.MustCompile(`^[^/\\\x00-\x1f\x7f]+$`)

// ValidationError identifies a specific malformed schema field.
type ValidationError struct{ Field, Message string }

func (e *ValidationError) Error() string  { return e.Field + ": " + e.Message }
func invalid(field, message string) error { return &ValidationError{Field: field, Message: message} }

// Project is the on-disk project.json manifest.
type Project struct {
	SchemaVersion   int           `json:"schemaVersion"`
	ProjectID       string        `json:"projectId"`
	DisplayName     string        `json:"displayName"`
	Slug            string        `json:"slug"`
	Status          ProjectStatus `json:"status"`
	CreatedAt       time.Time     `json:"createdAt"`
	UpdatedAt       time.Time     `json:"updatedAt"`
	PromptPlan      PromptPlan    `json:"promptPlan"`
	ImageConfig     ImageConfig   `json:"imageConfig"`
	BatchConfig     BatchConfig   `json:"batchConfig"`
	Stats           Stats         `json:"stats"`
	SchedulerCursor Cursor        `json:"schedulerCursor"`
	Prompts         []Prompt      `json:"prompts"`
	LastError       string        `json:"lastError,omitempty"`
}

type PromptPlan struct {
	HelperModel       string `json:"helperModel"`
	SourceRequirement string `json:"sourceRequirement"`
	OutputFormat      string `json:"outputFormat"`
	PlanVersion       int    `json:"planVersion"`
}

type ImageConfig struct {
	Model    string         `json:"model"`
	Protocol string         `json:"protocol"`
	Endpoint string         `json:"endpoint"`
	Params   map[string]any `json:"params,omitempty"`
}

type BatchConfig struct {
	IntervalMs   int    `json:"intervalMs"`
	MaxRetries   int    `json:"maxRetries"`
	RetryDelayMs int    `json:"retryDelayMs"`
	RetryBackoff string `json:"retryBackoff"`
	OnError      string `json:"onError"`
	SeedMode     string `json:"seedMode"`
	BaseSeed     int64  `json:"baseSeed"`
}

type Prompt struct {
	ID                string    `json:"id"`
	Index             int       `json:"index"`
	Title             string    `json:"title"`
	NaturalPrompt     string    `json:"naturalPrompt"`
	FinalFormat       string    `json:"finalFormat"`
	FinalPrompt       string    `json:"finalPrompt"`
	FinalPromptObject any       `json:"finalPromptObject,omitempty"`
	NegativePrompt    string    `json:"negativePrompt,omitempty"`
	Quantity          int       `json:"quantity"`
	Variants          []Variant `json:"variants"`
}

type Variant struct {
	ID           string        `json:"id"`
	Index        int           `json:"index"`
	Status       VariantStatus `json:"status"`
	Seed         *int64        `json:"seed,omitempty"`
	Attempt      int           `json:"attempt"`
	RelativePath string        `json:"relativePath,omitempty"`
	Width        int           `json:"width,omitempty"`
	Height       int           `json:"height,omitempty"`
	Bytes        int64         `json:"bytes,omitempty"`
	MIME         string        `json:"mime,omitempty"`
	DurationMs   int64         `json:"durationMs,omitempty"`
	CreatedAt    time.Time     `json:"createdAt,omitempty"`
	LastError    string        `json:"lastError,omitempty"`
	Asset        *Asset        `json:"asset,omitempty"`
}

type Asset struct {
	ID           string         `json:"id"`
	RelativePath string         `json:"relativePath"`
	MIME         string         `json:"mime,omitempty"`
	Extension    string         `json:"extension,omitempty"`
	Width        int            `json:"width,omitempty"`
	Height       int            `json:"height,omitempty"`
	Bytes        int64          `json:"bytes,omitempty"`
	Meta         map[string]any `json:"meta,omitempty"`
}

type Stats struct {
	PromptCount   int `json:"promptCount"`
	TotalVariants int `json:"totalVariants"`
	Completed     int `json:"completed"`
	Running       int `json:"running"`
	Pending       int `json:"pending"`
	Failed        int `json:"failed"`
	Interrupted   int `json:"interrupted"`
	Canceled      int `json:"canceled"`
}

type Cursor struct {
	PromptIndex  int `json:"promptIndex"`
	VariantIndex int `json:"variantIndex"`
}

// Snapshot is intentionally the same wire shape as a manifest. It is a named
// alias so APIs can add a snapshot-specific method without duplicating schema.
type Snapshot = Project

// Plan is the structured planning response returned by the plan endpoint.
type Plan = PlanOutput

// BatchEvent is the SSE event wire schema.
type BatchEvent = Event

// Common aliases make status checks readable to callers without changing wire values.
const (
	StatusDraft               ProjectStatus = ProjectDraft
	StatusPlanning            ProjectStatus = ProjectPlanning
	StatusConverting          ProjectStatus = ProjectConverting
	StatusReview              ProjectStatus = ProjectReview
	StatusQueued              ProjectStatus = ProjectQueued
	StatusRunning             ProjectStatus = ProjectRunning
	StatusPaused              ProjectStatus = ProjectPaused
	StatusStopping            ProjectStatus = ProjectStopping
	StatusCompleted           ProjectStatus = ProjectCompleted
	StatusCompletedWithErrors ProjectStatus = ProjectCompletedWithErrors
	StatusFailed              ProjectStatus = ProjectFailed
	StatusCanceled            ProjectStatus = ProjectCanceled
	VariantStatusPending      VariantStatus = VariantPending
	VariantStatusRunning      VariantStatus = VariantRunning
	VariantStatusRetryWait    VariantStatus = VariantRetryWait
	VariantStatusSucceeded    VariantStatus = VariantSucceeded
	VariantStatusFailed       VariantStatus = VariantFailed
	VariantStatusInterrupted  VariantStatus = VariantInterrupted
	VariantStatusCanceled     VariantStatus = VariantCanceled
)

type Event struct {
	Type      EventType `json:"type"`
	ProjectID string    `json:"projectId"`
	PromptID  string    `json:"promptId,omitempty"`
	VariantID string    `json:"variantId,omitempty"`
	At        time.Time `json:"at"`
	Data      any       `json:"data,omitempty"`
}

const (
	EventProjectStatus      EventType = "project-status"
	EventPlanningStarted    EventType = "planning-started"
	EventPlanningCompleted  EventType = "planning-completed"
	EventTransformCompleted EventType = "transform-completed"
	EventVariantStarted     EventType = "variant-started"
	EventVariantRetryWait   EventType = "variant-retry-wait"
	EventVariantCompleted   EventType = "variant-completed"
	EventVariantFailed      EventType = "variant-failed"
	EventVariantInterrupted EventType = "variant-interrupted"
	EventProjectReconciled  EventType = "project-reconciled"
	EventProjectCompleted   EventType = "project-completed"
	EventProjectError       EventType = "project-error"
)

type GeneratedAsset struct {
	Bytes     []byte         `json:"-"`
	MIME      string         `json:"mime,omitempty"`
	Extension string         `json:"extension,omitempty"`
	Width     int            `json:"width,omitempty"`
	Height    int            `json:"height,omitempty"`
	Meta      map[string]any `json:"meta,omitempty"`
}

type ImageGenerationRequest struct {
	ProjectID      string         `json:"projectId"`
	PromptID       string         `json:"promptId"`
	VariantID      string         `json:"variantId"`
	Model          string         `json:"model"`
	Protocol       string         `json:"protocol"`
	Endpoint       string         `json:"endpoint"`
	Prompt         string         `json:"prompt"`
	PromptFormat   string         `json:"promptFormat"`
	NegativePrompt string         `json:"negativePrompt,omitempty"`
	Params         map[string]any `json:"params,omitempty"`
	Seed           *int64         `json:"seed,omitempty"`
}

type ImageGenerationResult struct {
	Assets        []GeneratedAsset `json:"assets"`
	RevisedPrompt string           `json:"revisedPrompt,omitempty"`
	Provider      string           `json:"provider,omitempty"`
	Key           string           `json:"-"`
	Duration      time.Duration    `json:"duration,omitempty"`
	RawMeta       map[string]any   `json:"-"`
}

type ImageGenerator interface {
	Generate(context.Context, ImageGenerationRequest) (ImageGenerationResult, error)
}

type PlanInput struct {
	HelperModel           string `json:"helperModel"`
	Requirements          string `json:"requirements"`
	DefaultNegativePrompt string `json:"defaultNegativePrompt,omitempty"`
	DefaultQuantity       int    `json:"defaultQuantity"`
}
type PlanItem struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	NaturalPrompt  string `json:"naturalPrompt"`
	NegativePrompt string `json:"negativePrompt,omitempty"`
	Quantity       int    `json:"quantity"`
}
type PlanOutput struct {
	Title string     `json:"title"`
	Items []PlanItem `json:"items"`
}
type TransformInput struct {
	HelperModel string   `json:"helperModel"`
	Format      string   `json:"format"`
	Items       []Prompt `json:"items"`
}
type TransformOutput struct {
	Format string   `json:"format"`
	Items  []Prompt `json:"items"`
}

func (p PlanInput) Validate() error {
	if strings.TrimSpace(p.HelperModel) == "" {
		return invalid("helperModel", "must not be empty")
	}
	if strings.TrimSpace(p.Requirements) == "" {
		return invalid("requirements", "must not be empty")
	}
	if p.DefaultQuantity < 1 || p.DefaultQuantity > MaxPromptQuantity {
		return invalid("defaultQuantity", "out of range")
	}
	return nil
}
func (p PlanOutput) Validate() error {
	if len(p.Items) == 0 {
		return invalid("items", "must not be empty")
	}
	seen := map[string]bool{}
	for i, v := range p.Items {
		if err := v.Validate(); err != nil {
			return fmt.Errorf("items[%d]: %w", i, err)
		}
		if seen[v.ID] {
			return invalid("items", "duplicate id")
		}
		seen[v.ID] = true
	}
	return nil
}
func (p PlanItem) Validate() error {
	if !safeID.MatchString(p.ID) {
		return invalid("id", "invalid id")
	}
	if strings.TrimSpace(p.NaturalPrompt) == "" {
		return invalid("naturalPrompt", "must not be empty")
	}
	if p.Quantity < 1 || p.Quantity > MaxPromptQuantity {
		return invalid("quantity", "out of range")
	}
	return nil
}
func (p TransformInput) Validate() error {
	if strings.TrimSpace(p.HelperModel) == "" {
		return invalid("helperModel", "must not be empty")
	}
	if !validFormat(p.Format) {
		return invalid("format", "invalid format")
	}
	if len(p.Items) == 0 {
		return invalid("items", "must not be empty")
	}
	seen := map[string]bool{}
	for i, v := range p.Items {
		if err := v.Validate(); err != nil {
			return fmt.Errorf("items[%d]: %w", i, err)
		}
		if seen[v.ID] {
			return invalid("items", "duplicate id")
		}
		seen[v.ID] = true
	}
	return nil
}
func (p TransformOutput) Validate() error {
	if !validFormat(p.Format) {
		return invalid("format", "invalid format")
	}
	if len(p.Items) == 0 {
		return invalid("items", "must not be empty")
	}
	for i, v := range p.Items {
		if err := v.Validate(); err != nil {
			return fmt.Errorf("items[%d]: %w", i, err)
		}
	}
	return nil
}

func validFormat(s string) bool { return s == FormatNatural || s == FormatTag || s == FormatJSON }
func (p PromptPlan) Validate() error {
	if p.PlanVersion < 1 {
		return invalid("planVersion", "must be positive")
	}
	if strings.TrimSpace(p.SourceRequirement) == "" {
		return invalid("sourceRequirement", "must not be empty")
	}
	if p.OutputFormat != "" && !validFormat(p.OutputFormat) {
		return invalid("outputFormat", "invalid format")
	}
	return nil
}
func (c ImageConfig) Validate() error {
	if strings.TrimSpace(c.Model) == "" {
		return invalid("model", "must not be empty")
	}
	if strings.TrimSpace(c.Protocol) == "" {
		return invalid("protocol", "must not be empty")
	}
	if c.Endpoint != "" {
		u, err := url.Parse(c.Endpoint)
		if err != nil || u.IsAbs() || strings.Contains(c.Endpoint, "\\") || strings.Contains(c.Endpoint, "..") {
			return invalid("endpoint", "must be a safe relative endpoint")
		}
	}
	return nil
}
func (c BatchConfig) Validate() error {
	if c.IntervalMs < 0 || c.IntervalMs > MaxIntervalMs {
		return invalid("intervalMs", "out of range")
	}
	if c.MaxRetries < 0 || c.MaxRetries > MaxRetries {
		return invalid("maxRetries", "out of range")
	}
	if c.RetryDelayMs < 0 || c.RetryDelayMs > MaxRetryDelayMs {
		return invalid("retryDelayMs", "out of range")
	}
	if c.RetryBackoff != BackoffFixed && c.RetryBackoff != BackoffExponential && c.RetryBackoff != BackoffExponentialJitter {
		return invalid("retryBackoff", "invalid backoff")
	}
	if c.OnError != "" && c.OnError != OnErrorContinue && c.OnError != OnErrorStop {
		return invalid("onError", "invalid policy")
	}
	switch c.SeedMode {
	case SeedRandom, SeedIncrement, SeedFixedBasePlusOffset, SeedProviderControlled:
	default:
		return invalid("seedMode", "invalid seed mode")
	}
	return nil
}
func (p Prompt) Validate() error {
	if !safeID.MatchString(p.ID) {
		return invalid("id", "invalid id")
	}
	if p.Index < 1 {
		return invalid("index", "must be positive")
	}
	if strings.TrimSpace(p.NaturalPrompt) == "" {
		return invalid("naturalPrompt", "must not be empty")
	}
	if !validFormat(p.FinalFormat) {
		return invalid("finalFormat", "invalid format")
	}
	if p.Quantity < 1 || p.Quantity > MaxPromptQuantity {
		return invalid("quantity", "out of range")
	}
	if len(p.Variants) > p.Quantity {
		return invalid("variants", "more variants than quantity")
	}
	seen := map[string]bool{}
	for i, v := range p.Variants {
		if err := v.Validate(); err != nil {
			return fmt.Errorf("variants[%d]: %w", i, err)
		}
		if seen[v.ID] {
			return invalid("variants", "duplicate id")
		}
		seen[v.ID] = true
	}
	return nil
}
func (v Variant) Validate() error {
	if !safeID.MatchString(v.ID) {
		return invalid("id", "invalid id")
	}
	if v.Index < 1 {
		return invalid("index", "must be positive")
	}
	switch v.Status {
	case VariantPending, VariantRunning, VariantRetryWait, VariantSucceeded, VariantFailed, VariantInterrupted, VariantCanceled:
	default:
		return invalid("status", "invalid status")
	}
	if v.Attempt < 0 || v.Attempt > MaxRetries+1 {
		return invalid("attempt", "out of range")
	}
	if v.RelativePath != "" && (strings.HasPrefix(v.RelativePath, "/") || strings.HasPrefix(v.RelativePath, "\\") || strings.Contains(v.RelativePath, "..")) {
		return invalid("relativePath", "unsafe path")
	}
	if v.Bytes < 0 || v.Width < 0 || v.Height < 0 || v.DurationMs < 0 {
		return invalid("asset", "negative metadata")
	}
	return nil
}
func (p Project) ValidateManifest() error {
	if p.SchemaVersion != 1 {
		return invalid("schemaVersion", "unsupported schema")
	}
	if !safeID.MatchString(p.ProjectID) {
		return invalid("projectId", "invalid id")
	}
	if strings.TrimSpace(p.DisplayName) == "" {
		return invalid("displayName", "must not be empty")
	}
	if !safeSlug.MatchString(p.Slug) || p.Slug == "." || p.Slug == ".." {
		return invalid("slug", "invalid slug")
	}
	switch p.Status {
	case ProjectDraft, ProjectPlanning, ProjectConverting, ProjectReview, ProjectQueued, ProjectRunning, ProjectPaused, ProjectStopping, ProjectCompleted, ProjectCompletedWithErrors, ProjectFailed, ProjectCanceled:
	default:
		return invalid("status", "invalid status")
	}
	if err := p.PromptPlan.Validate(); err != nil {
		return fmt.Errorf("promptPlan: %w", err)
	}
	if err := p.ImageConfig.Validate(); err != nil {
		return fmt.Errorf("imageConfig: %w", err)
	}
	if err := p.BatchConfig.Validate(); err != nil {
		return fmt.Errorf("batchConfig: %w", err)
	}
	if len(p.Prompts) == 0 || len(p.Prompts) > MaxPromptCount {
		return invalid("prompts", "invalid count")
	}
	seen := map[string]bool{}
	for i, v := range p.Prompts {
		if err := v.Validate(); err != nil {
			return fmt.Errorf("prompts[%d]: %w", i, err)
		}
		if seen[v.ID] {
			return invalid("prompts", "duplicate id")
		}
		seen[v.ID] = true
	}
	return nil
}

// Validate is the general manifest validation entrypoint.
func (p Project) Validate() error { return p.ValidateManifest() }

func (a Asset) Validate() error {
	if a.ID != "" && !safeID.MatchString(a.ID) {
		return invalid("id", "invalid id")
	}
	if err := ValidateRelativeAssetPath(a.RelativePath); err != nil {
		return err
	}
	if a.Bytes < 0 || a.Width < 0 || a.Height < 0 {
		return invalid("asset", "negative metadata")
	}
	return nil
}

// ValidateRelativeAssetPath is kept independent of paths.go so schema users
// can validate imported manifests without touching the filesystem.
func ValidateRelativeAssetPath(path string) error {
	if path == "" {
		return nil
	}
	if strings.HasPrefix(path, "/") || strings.HasPrefix(path, "\\") || strings.Contains(path, "\\") || strings.Contains(path, "..") {
		return invalid("relativePath", "unsafe path")
	}
	return nil
}
func (s Stats) Total() int { return s.TotalVariants }
func (s *Stats) Recompute(prompts []Prompt) {
	s.PromptCount = len(prompts)
	s.TotalVariants = 0
	s.Completed = 0
	s.Running = 0
	s.Pending = 0
	s.Failed = 0
	s.Interrupted = 0
	s.Canceled = 0
	for _, p := range prompts {
		s.TotalVariants += p.Quantity
		for _, v := range p.Variants {
			switch v.Status {
			case VariantSucceeded:
				s.Completed++
			case VariantRunning:
				s.Running++
			case VariantPending:
				s.Pending++
			case VariantFailed:
				s.Failed++
			case VariantInterrupted:
				s.Interrupted++
			case VariantCanceled:
				s.Canceled++
			}
		}
	}
}
func SeedForVariant(baseSeed int64, promptIndex, variantIndex, variantsPerPrompt int) int64 {
	if promptIndex < 1 {
		promptIndex = 1
	}
	if variantIndex < 1 {
		variantIndex = 1
	}
	if variantsPerPrompt < 1 {
		variantsPerPrompt = 1
	}
	return baseSeed + int64((promptIndex-1)*variantsPerPrompt+(variantIndex-1))
}
func CalculateSeed(mode string, baseSeed int64, promptIndex, variantIndex, variantsPerPrompt int) *int64 {
	switch mode {
	case SeedIncrement, SeedFixedBasePlusOffset:
		s := SeedForVariant(baseSeed, promptIndex, variantIndex, variantsPerPrompt)
		return &s
	case SeedProviderControlled:
		return nil
	case SeedRandom:
		return nil
	default:
		return nil
	}
}
