package download

import "context"

// CreatePlaylistTask 创建播放列表下载任务。
// 先查询播放列表信息，然后为每个条目创建子任务。
// 返回：所有创建的任务 ID 列表、播放列表标题、错误（如果有）。
// ctx 上的超时（infoQueryTimeout）防止上游卡死挂起请求。
func (m *Manager) CreatePlaylistTask(ctx context.Context, input CreateTaskInput) ([]string, string, error) {
	ctx, cancel := context.WithTimeout(ctx, infoQueryTimeout)
	defer cancel()
	info, err := m.executor.ExecutePlaylistInfo(ctx, input.URL)
	if err != nil {
		return nil, "", err
	}
	title := info.Title
	size := len(info.Entries)
	// 如果指定了 SelectedIndices，则只在其中出现（1-based）的条目里下载，
	// 但保留原始播放列表大小 size 以便任务卡片显示 "3 / 10"。
	entries := info.Entries
	if len(input.SelectedIndices) > 0 {
		selected := make(map[int]bool, len(input.SelectedIndices))
		for _, idx := range input.SelectedIndices {
			selected[idx] = true
		}
		filtered := make([]PlaylistEntry, 0, len(input.SelectedIndices))
		for _, entry := range info.Entries {
			if selected[entry.Index] {
				filtered = append(filtered, entry)
			}
		}
		entries = filtered
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		childURL := entry.URL
		if childURL == "" {
			childURL = input.URL
		}
		childInput := CreateTaskInput{
			URL:           childURL,
			Type:          input.Type,
			Quality:       input.Quality,
			Container:     input.Container,
			DownloadDir:   input.DownloadDir,
			PlaylistID:    info.ID,
			PlaylistTitle: title,
			PlaylistIndex: entry.Index,
			PlaylistSize:  size,
			Title:         entry.Title,
			Thumbnail:     entry.Thumbnail,
		}
		ids = append(ids, m.CreateTask(childInput))
	}
	return ids, title, nil
}
