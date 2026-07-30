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
