package webhub

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// driverRequestTimeout bounds one whole site turn (open tab + workflow +
// watch). It is the outer safety net under the preset's own hard_timeout.
const driverRequestTimeout = 600 * time.Second

// Driver executes one chat turn against a site's page.
//
// ⚠️ CONCURRENCY: every site has ONE browser session, and a single logged-in
// page can only carry one conversation at a time. Requests for the same site
// therefore go through a FIFO queue and run strictly one after another; a
// second request waits rather than interleaving into the first reply.
//
// This is a deliberate, documented limitation (architecture §4.3), not an
// oversight: without it two prompts would land in the same composer and both
// replies would be garbage.
type Driver struct {
	sessions *SessionManager
	manager  *Manager

	mu sync.Mutex
	// queues holds one serialized worker per site.
	queues map[string]*siteQueue
}

// siteQueue is the FIFO gate for one site.
//
// It is a buffered channel holding exactly one token: acquiring takes the
// token, releasing puts it back. A buffered channel's senders are woken in
// FIFO order by the Go runtime, so this gives strict first-come-first-served
// without a hand-rolled waiter list (the first implementation counted
// waiters in a shared depth counter and deadlocked).
type siteQueue struct {
	token chan struct{}
}

func newSiteQueue() *siteQueue {
	q := &siteQueue{token: make(chan struct{}, 1)}
	q.token <- struct{}{} // start free
	return q
}

// NewDriver creates a driver over the given session manager.
func NewDriver(m *Manager) *Driver {
	d := &Driver{queues: map[string]*siteQueue{}}
	if m != nil {
		d.sessions = m.Sessions()
		d.manager = m
	}
	if d.sessions == nil {
		d.sessions = NewSessionManager("")
	}
	return d
}

// SetSessions replaces the session manager (used in tests).
func (d *Driver) SetSessions(s *SessionManager) {
	d.mu.Lock()
	d.sessions = s
	d.mu.Unlock()
}

func (d *Driver) sessionsLocked() *SessionManager { return d.sessions }

// queueFor returns (creating on demand) the FIFO gate for a site.
func (d *Driver) queueFor(site string) *siteQueue {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.queues == nil {
		d.queues = map[string]*siteQueue{}
	}
	q, ok := d.queues[site]
	if !ok {
		q = newSiteQueue()
		d.queues[site] = q
	}
	return q
}

// acquire enters the site's FIFO and returns a release func the caller MUST
// call (defer). Waiting honors ctx so a canceled client request leaves the
// queue instead of blocking behind a long reply; the overall wait is also
// capped so a wedged turn can never hold the site forever.
func (d *Driver) acquire(ctx context.Context, site string) (release func(), err error) {
	q := d.queueFor(site)
	return q.acquire(ctx, site)
}

func (q *siteQueue) acquire(ctx context.Context, site string) (func(), error) {
	deadline := time.After(driverRequestTimeout)
	select {
	case <-q.token:
		var once sync.Once
		return func() {
			once.Do(func() {
				select {
				case q.token <- struct{}{}:
				default:
				}
			})
		}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-deadline:
		return nil, fmt.Errorf("webhub: timed out waiting for the %s session", site)
	}
}

// ChatRequest is one site turn as the bridge sees it.
type ChatRequest struct {
	// Site is the site domain.
	Site string
	// Preset pins a preset name ("" = the site default).
	Preset string
	// Prompt is the assembled prompt text.
	Prompt string
	// Stream, when set, receives each delta as it is produced.
	Stream bool
	// OnDelta receives incremental text (only consulted when Stream).
	OnDelta func(string)
}

// ChatResult is one completed site turn.
type ChatResult struct {
	Text              string
	FirstContentAfter time.Duration
	Resyncs           int
	StepsSkipped      int
}

// Chat runs one turn against the site's page: attach → (serialize) → workflow
// → watch. It returns the full reply text; when req.Stream is set, deltas are
// pushed to req.OnDelta as they arrive.
func (d *Driver) Chat(ctx context.Context, req ChatRequest) (ChatResult, error) {
	var res ChatResult
	site := normalizeDomain(req.Site)
	rule := SiteRuleByDomain(site)
	if rule == nil {
		return res, fmt.Errorf("webhub: unsupported site %q", req.Site)
	}
	preset := rule.PresetByName(req.Preset)
	if preset == nil {
		preset = rule.Default()
	}
	if preset == nil {
		return res, fmt.Errorf("webhub: site %q has no usable preset", site)
	}
	if req.Prompt == "" {
		return res, fmt.Errorf("webhub: empty prompt")
	}

	runCtx, cancel := context.WithTimeout(ctx, driverRequestTimeout)
	defer cancel()

	release, err := d.acquire(runCtx, site)
	if err != nil {
		return res, err
	}
	defer release()

	sessions := d.sessionsLocked()
	if sessions == nil {
		return res, ErrNotConnected
	}
	session, err := sessions.Open(runCtx, site)
	if err != nil {
		return res, err
	}
	page := NewPage(session.Context())

	out, err := RunWorkflow(runCtx, page, preset, RunOptions{
		Prompt:  req.Prompt,
		Budget:  budgetFor(preset.Stream),
		OnDelta: req.OnDelta,
	})
	res.Text = out.Text
	res.FirstContentAfter = out.FirstContentAfter
	res.Resyncs = out.Resyncs
	res.StepsSkipped = out.StepsSkipped
	if err != nil {
		return res, err
	}
	if d.manager != nil {
		d.manager.MarkOK(site)
	}
	return res, nil
}

// BuildPrompt assembles the prompt sent to a page from an OpenAI-style request
// body. Web pages have no notion of roles or tool calls, so the messages are
// flattened into a readable transcript — the only representation a chat UI can
// act on.
//
// Rules (mirroring upstream's prompt handling, minus its padding/splitting
// tricks which exist to dodge input length heuristics — not ported, see
// webhub-upstream-sync.md §5):
//   - system messages are emitted first as a "System:" block;
//   - each user/assistant turn becomes "User:" / "Assistant:";
//   - multi-part content is flattened to its text parts (images cannot be
//     pasted through this path);
//   - tool messages are rendered as "Tool result:" so the page at least sees
//     the data, though it cannot call tools.
//
// When the transcript is a single user message and there is no system prompt,
// the bare text is sent (no "User:" prefix) — the common single-shot case
// should not be decorated.
func BuildPrompt(body []byte) (string, error) {
	var parsed struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &parsed); err != nil {
			return "", fmt.Errorf("webhub: parse request body: %w", err)
		}
	}
	var sb strings.Builder
	var system []string
	var turns []string
	for _, m := range parsed.Messages {
		text := flattenContent(m.Content)
		if text == "" {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(m.Role)) {
		case "system":
			system = append(system, text)
		case "assistant":
			turns = append(turns, "Assistant: "+text)
		case "tool":
			turns = append(turns, "Tool result: "+text)
		default:
			turns = append(turns, "User: "+text)
		}
	}
	if len(system) > 0 {
		sb.WriteString("System: " + strings.Join(system, "\n") + "\n\n")
	}
	if len(turns) == 1 && len(system) == 0 && strings.HasPrefix(turns[0], "User: ") {
		sb.WriteString(strings.TrimPrefix(turns[0], "User: "))
		return sb.String(), nil
	}
	sb.WriteString(strings.Join(turns, "\n"))
	return strings.TrimSpace(sb.String()), nil
}

// flattenContent extracts the text of an OpenAI message content field, which
// is either a string or an array of {type,text} parts.
func flattenContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err != nil {
		return ""
	}
	var sb strings.Builder
	for _, p := range parts {
		if p.Type == "text" && p.Text != "" {
			if sb.Len() > 0 {
				sb.WriteString("\n")
			}
			sb.WriteString(p.Text)
		}
	}
	return sb.String()
}
