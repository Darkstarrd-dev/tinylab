package download

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/console"
)

// ErrCancelled is returned when a download is cancelled via context.
var ErrCancelled = errors.New("cancelled")

// Executor 负责单个下载任务的 yt-dlp 进程管理。
// 移植自 VidBee YtDlpExecutor，简化为不依赖外部队列接口的独立执行器。
type Executor struct {
	settings RuntimeSettings
	logger   *console.Logger
}

// NewExecutor 创建执行器。
func NewExecutor(settings RuntimeSettings, logger *console.Logger) *Executor {
	return &Executor{settings: settings, logger: logger}
}

// Execute 执行一次 yt-dlp 下载，阻塞直到完成或取消。
// 通过 context.Context 实现取消（SIGTERM 进程树）。
// 通过 progressCh 推送进度更新（非阻塞）。
//
// 返回：输出文件路径（如果成功）、完整 stdout 日志、错误（如果失败）。
func (e *Executor) Execute(ctx context.Context, task *Task, progressCh chan<- Progress) (string, string, error) {
	ytDlpPath, err := e.resolveYtDlpPath()
	if err != nil {
		return "", "", err
	}
	if _, err := e.resolveFfmpegPath(); err != nil {
		return "", "", err
	}

	args := BuildDownloadArgs(task.URL, task.Type, task.Quality, task.Container,
		task.DownloadDir, e.settings.ConcurrentFragments, e.settings)

	cmd := exec.CommandContext(ctx, ytDlpPath, args...)
	setupProcessGroup(cmd)
	// Bound Wait: if Cancel kills the tree but a grandchild keeps a pipe open,
	// Wait must not block forever after the 5s grace period.
	cmd.WaitDelay = 5 * time.Second

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", "", fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", "", fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return "", "", fmt.Errorf("start yt-dlp: %w", err)
	}

	// 取消时杀整棵进程树（yt-dlp + ffmpeg 子进程）。
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			return killProcessTree(cmd.Process.Pid)
		}
		return nil
	}

	var (
		stdoutTail = newTailBuffer(64 * 1024) // 64KB buffer for full output log
		stderrTail = newTailBuffer(64 * 1024)
		processing bool
		mu         sync.Mutex
	)
	// Prepend the full command line to the log output so users can verify
	// type/quality/container settings in View Log.
	cmdLine := FormatYtDlpCommand(ytDlpPath, args)
	stdoutTail.Append("[command] " + cmdLine + "\n")

	// Post cmdLine immediately so UI starts updating right away.
	select {
	case progressCh <- Progress{LogLine: "[command] " + cmdLine}:
	default:
	}

	// 扫描 stderr（用于错误分类），同时累积尾部缓冲。
	go func() {
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			mu.Lock()
			stderrTail.Append(line + "\n")
			mu.Unlock()

			select {
			case progressCh <- Progress{LogLine: line}:
			default:
			}
		}
	}()

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		mu.Lock()
		stdoutTail.Append(line + "\n")
		mu.Unlock()

		if hasPostprocessSignal(line) {
			processing = true
		}
		p, ok := parseProgressLine(line)
		if !ok {
			p = Progress{}
		}
		if processing {
			p.Processing = true
		}
		p.LogLine = line

		select {
		case progressCh <- p:
		default:
		}
	}

	if err := cmd.Wait(); err != nil {
		if ctx.Err() == context.Canceled {
			mu.Lock()
			log := stdoutTail.Read()
			mu.Unlock()
			return "", log, ErrCancelled
		}
		mu.Lock()
		stderrText := stderrTail.Read()
		log := stdoutTail.Read()
		mu.Unlock()
		return "", log, classifyExitError(stderrText)
	}

	mu.Lock()
	tail := stdoutTail.Read()
	mu.Unlock()
	filePath := extractSavedFilePath(tail)
	if filePath == "" {
		return "", tail, fmt.Errorf("yt-dlp finished but output file path not found")
	}
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return "", tail, fmt.Errorf("failed to resolve output path: %w", err)
	}
	filePath = absPath
	if info, statErr := os.Stat(filePath); statErr != nil || info.Size() == 0 {
		return "", tail, fmt.Errorf("downloaded file missing or empty: %s", filePath)
	}
	return filePath, tail, nil
}

// ExecuteInfo 执行 yt-dlp -j 查询视频信息，返回解析后的 VideoInfo。
func (e *Executor) ExecuteInfo(ctx context.Context, rawURL string) (*VideoInfo, error) {
	ytDlpPath, err := e.resolveYtDlpPath()
	if err != nil {
		return nil, err
	}
	args := BuildVideoInfoArgs(rawURL, e.settings)
	out, stderr, err := e.runCapture(ctx, ytDlpPath, args)
	if err != nil {
		return nil, wrapInfoError(err, stderr)
	}
	return parseVideoInfoJSON(out)
}

// ExecutePlaylistInfo 执行 yt-dlp -J --flat-playlist 查询播放列表信息。
func (e *Executor) ExecutePlaylistInfo(ctx context.Context, rawURL string) (*PlaylistInfo, error) {
	ytDlpPath, err := e.resolveYtDlpPath()
	if err != nil {
		return nil, err
	}
	args := BuildPlaylistInfoArgs(rawURL, e.settings)
	out, stderr, err := e.runCapture(ctx, ytDlpPath, args)
	if err != nil {
		return nil, wrapInfoError(err, stderr)
	}
	return parsePlaylistInfoJSON(out)
}

// runCapture 运行 yt-dlp 并捕获全部 stdout 与 stderr。
func (e *Executor) runCapture(ctx context.Context, ytDlpPath string, args []string) ([]byte, string, error) {
	cmd := exec.CommandContext(ctx, ytDlpPath, args...)
	setupProcessGroup(cmd)
	cmd.WaitDelay = 5 * time.Second
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			return killProcessTree(cmd.Process.Pid)
		}
		return nil
	}
	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf
	runErr := cmd.Run()
	if ctx.Err() == context.Canceled {
		return nil, stderrBuf.String(), ErrCancelled
	}
	if runErr != nil {
		return stdoutBuf.Bytes(), stderrBuf.String(), runErr
	}
	return stdoutBuf.Bytes(), stderrBuf.String(), nil
}

// killProcessTree 与 setupProcessGroup 的平台相关实现见
// kill_unix.go（!windows）与 kill_windows.go（windows）。
