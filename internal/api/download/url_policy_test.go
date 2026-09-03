package download

import (
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/outbound"
)

// F-16: download URLs are pre-flighted under the outbound SSRF policy before
// yt-dlp is spawned.

func TestValidateDownloadURLRejectsSSRF(t *testing.T) {
	blocked := []string{
		"http://127.0.0.1:8080/video.mp4",
		"http://localhost/clip",
		"http://169.254.169.254/latest/meta-data",
		"http://10.0.0.5/x",
		"http://192.168.1.1/x",
		"http://user:pass@example.com/v",
		"ftp://example.com/v",
		"http://example.com:6379/",
	}
	for _, u := range blocked {
		if err := validateDownloadURL(u); err == nil {
			t.Errorf("%q: expected rejection", u)
		}
	}
}

func TestValidateDownloadURLAllowsPublic(t *testing.T) {
	// Hostname-based public URLs pass structural validation; the DNS layer is
	// network-dependent, so assert only the structural layer offline.
	for _, u := range []string{
		"https://www.youtube.com/watch?v=abc",
		"https://example.com/video.mp4",
		"http://example.com:8080/v",
	} {
		if _, err := outbound.ValidateURL(u); err != nil {
			t.Errorf("%q: structural validation failed: %v", u, err)
		}
	}
}

func TestValidateDownloadURLRejectsNonHTTP(t *testing.T) {
	for _, u := range []string{"ftp://x.com/f", "file:///etc/passwd", "rtmp://x.com/live"} {
		err := validateDownloadURL(u)
		if err == nil || !strings.Contains(err.Error(), "scheme") {
			t.Errorf("%q: got %v, want scheme rejection", u, err)
		}
	}
}
