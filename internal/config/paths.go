package config

import "path/filepath"

// ResolveDownloadProxy computes the yt-dlp --proxy URL from the download
// UseProxy toggle and the global upstream proxy config. Returns "" when
// downloads should not use a proxy (UseProxy off or upstream proxy unset).
func ResolveDownloadProxy(cfg *Config) string {
	if !cfg.Download.UseProxy || cfg.Proxy.Host == "" {
		return ""
	}
	port := cfg.Proxy.Port
	if port == "" {
		return "http://" + cfg.Proxy.Host
	}
	return "http://" + cfg.Proxy.Host + ":" + port
}

// ResolveTraceDir resolves the trace log directory. An empty logDir falls
// back to {configDir}/traces; a relative path is joined with configDir; an
// absolute path is used verbatim.
func ResolveTraceDir(logDir, configDir string) string {
	if logDir == "" {
		return filepath.Join(configDir, "traces")
	}
	if filepath.IsAbs(logDir) {
		return logDir
	}
	return filepath.Join(configDir, logDir)
}

// ResolveImageSaveDir resolves the image save directory. An empty imageSaveDir
// falls back to {configDir}/imgs (or "imgs" if configDir is empty); a relative
// path is joined with configDir; an absolute path is used verbatim.
func ResolveImageSaveDir(imageSaveDir, configDir string) string {
	if imageSaveDir == "" {
		if configDir != "" {
			return filepath.Join(configDir, "imgs")
		}
		return "imgs"
	}
	if filepath.IsAbs(imageSaveDir) {
		return imageSaveDir
	}
	if configDir != "" {
		return filepath.Join(configDir, imageSaveDir)
	}
	return imageSaveDir
}

// ResolveArchiveTempDir resolves the archive private workspace directory. An
// empty tempDir falls back to {configDir}/archives; a relative path is joined
// with configDir; an absolute path is used verbatim. The caller is
// responsible for creating the directory (0700) and failing closed when it
// cannot be created (archive capability disabled, core features unaffected).
func ResolveArchiveTempDir(tempDir, configDir string) string {
	if tempDir == "" {
		if configDir != "" {
			return filepath.Join(configDir, "archives")
		}
		return "archives"
	}
	if filepath.IsAbs(tempDir) {
		return tempDir
	}
	if configDir != "" {
		return filepath.Join(configDir, tempDir)
	}
	return tempDir
}
