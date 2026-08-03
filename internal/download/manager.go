package download

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/console"
)

// Manager 管理下载任务队列和执行。
// 内存模式：无持久化，进程退出即丢失。
type Manager struct {
	mu       sync.RWMutex
	tasks    map[string]*Task
	order    []string
	executor *Executor
	settings RuntimeSettings
	logger   *console.Logger
	controls map[string]*taskControl // 每个任务的 context + cancel

	pendingCh chan string
	active    map[string]bool

	eventSubs map[chan Event]struct{}

	maxConcurrent int
	stopCh        chan struct{}
	wg            sync.WaitGroup
	started       bool
}

// taskControl 绑定每个任务的 context 与取消函数。
type taskControl struct {
	ctx    context.Context
	cancel context.CancelFunc
}

// NewManager 创建下载管理器。
func NewManager(settings RuntimeSettings, logger *console.Logger) *Manager {
	maxConcurrent := settings.MaxConcurrent
	if maxConcurrent <= 0 {
		maxConcurrent = 3
	}
	return &Manager{
		tasks:         make(map[string]*Task),
		order:         make([]string, 0),
		executor:      NewExecutor(settings, logger),
		settings:      settings,
		logger:        logger,
		controls:      make(map[string]*taskControl),
		pendingCh:     make(chan string, 100),
		active:        make(map[string]bool),
		eventSubs:     make(map[chan Event]struct{}),
		maxConcurrent: maxConcurrent,
		stopCh:        make(chan struct{}),
	}
}

// UpdateSettings 更新管理器与执行器的运行时设置（尤其是 yt-dlp / ffmpeg 路径），
// 使正在运行和后续的下载无需重启即可生效。
func (m *Manager) UpdateSettings(settings RuntimeSettings) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.settings = settings
	if m.executor != nil {
		m.executor.settings = settings
	}
	if settings.MaxConcurrent > 0 {
		m.maxConcurrent = settings.MaxConcurrent
	}
}

// Started 返回管理器是否已启动。
func (m *Manager) Started() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.started
}

// CreateTask 创建单个下载任务并加入队列。
// 返回任务 ID。
func (m *Manager) CreateTask(input CreateTaskInput) string {
	id := generateID()
	now := time.Now()
	task := &Task{
		ID:            id,
		URL:           input.URL,
		Type:          input.Type,
		Status:        StatusPending,
		Quality:       input.Quality,
		Container:     input.Container,
		DownloadDir:   input.DownloadDir,
		Title:         input.Title,
		Thumbnail:     input.Thumbnail,
		PlaylistID:    input.PlaylistID,
		PlaylistTitle: input.PlaylistTitle,
		PlaylistIndex: input.PlaylistIndex,
		PlaylistSize:  input.PlaylistSize,
		CreatedAt:     now,
	}
	if task.Type == "" {
		task.Type = TypeVideo
	}
	if task.Quality == "" {
		task.Quality = QualityBest
	}
	if task.Container == "" {
		task.Container = ContainerAuto
	}
	if task.DownloadDir == "" {
		task.DownloadDir = m.settings.DownloadDir
	}

	ctx, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	m.tasks[id] = task
	m.order = append(m.order, id)
	m.controls[id] = &taskControl{ctx: ctx, cancel: cancel}
	m.mu.Unlock()

	// 投递到队列（非阻塞失败时丢弃，但缓冲 100 足够）。
	select {
	case m.pendingCh <- id:
	default:
		// 队列满，立即标记错误。
		m.mu.Lock()
		delete(m.controls, id)
		m.mu.Unlock()
		m.finalizeTask(id, StatusError, "download queue is full", 0)
		return id
	}
	m.publishEvent(Event{Type: "queue-updated"})
	return id
}

// infoQueryTimeout bounds metadata queries: a stalled upstream (network hang,
// dead site) must not wedge the HTTP handler forever.
const infoQueryTimeout = 60 * time.Second

// GetVideoInfo 查询视频信息（不下载）。
func (m *Manager) GetVideoInfo(ctx context.Context, rawURL string) (*VideoInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, infoQueryTimeout)
	defer cancel()
	return m.executor.ExecuteInfo(ctx, rawURL)
}

// GetPlaylistInfo 查询播放列表信息（不下载）。
func (m *Manager) GetPlaylistInfo(ctx context.Context, rawURL string) (*PlaylistInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, infoQueryTimeout)
	defer cancel()
	return m.executor.ExecutePlaylistInfo(ctx, rawURL)
}

// ListTasks 返回所有任务（含已完成），按创建顺序。
func (m *Manager) ListTasks() []*Task {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]*Task, 0, len(m.order))
	for _, id := range m.order {
		if t, ok := m.tasks[id]; ok {
			result = append(result, m.snapshot(t))
		}
	}
	return result
}

// GetTask 返回指定任务的拷贝（含是否存在标志）。
func (m *Manager) GetTask(taskID string) (*Task, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	t, ok := m.tasks[taskID]
	if !ok {
		return nil, false
	}
	return m.snapshot(t), true
}

// snapshot 返回任务的深拷贝（不拷贝 LogTail）。
func (m *Manager) snapshot(t *Task) *Task {
	cp := *t
	cp.Progress = t.Progress
	return &cp
}

// isTerminal 判断状态是否为终态。
func isTerminal(s TaskStatus) bool {
	return s == StatusCompleted || s == StatusError || s == StatusCancelled
}

// generateID 生成 8 字节随机十六进制任务 ID。
func generateID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand 失败极罕见，退化为时间随机。
		return hex.EncodeToString([]byte(fmt.Sprintf("%d", time.Now().UnixNano())))
	}
	return hex.EncodeToString(b)
}

// fileSizeOf 返回文件大小（不存在返回错误）。
func fileSizeOf(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}
