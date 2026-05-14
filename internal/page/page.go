package page

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

func findRoot() string {
	dir, _ := os.Getwd()
	for {
		if _, err := os.Stat(filepath.Join(dir, "templates")); err == nil {
			return filepath.Join(dir, "templates")
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

var (
	tmplDir    = findRoot()
	tmplCache  = map[string]string{}
	tmplMu     sync.RWMutex
)

func readTemplate(path string) string {
	tmplMu.RLock()
	cached, ok := tmplCache[path]
	tmplMu.RUnlock()
	if ok {
		return cached
	}
	b, err := os.ReadFile(filepath.Join(tmplDir, path))
	if err != nil {
		return ""
	}
	s := string(b)
	// Resolve partial includes
	s = resolvePartials(s, 0)
	tmplMu.Lock()
	tmplCache[path] = s
	tmplMu.Unlock()
	return s
}

func resolvePartials(html string, depth int) string {
	if depth > 10 {
		return html
	}
	for {
		idx := strings.Index(html, "<!--#include partial=\"")
		if idx < 0 {
			break
		}
		end := strings.Index(html[idx:], "\"-->")
		if end < 0 {
			break
		}
		name := html[idx+22 : idx+end]
		partial := readTemplate(filepath.Join("partials", name))
		html = html[:idx] + partial + html[idx+end+4:]
	}
	if strings.Contains(html, "<!--#include") {
		return resolvePartials(html, depth+1)
	}
	return html
}

func apply(html string, vars map[string]string) string {
	for k, v := range vars {
		html = strings.ReplaceAll(html, "{{"+k+"}}", v)
	}
	return html
}

func Upload(w io.Writer, sessionID, config, serverURL, nonce string) error {
	html := readTemplate("upload.html")
	html = apply(html, map[string]string{
		"session_id": sessionID,
		"config":     config,
		"server_url": serverURL,
		"nonce":      nonce,
		"title":      "StreamDrop",
		"heading":    "StreamDrop",
		"subtitle":   "End-to-end encrypted. Zero storage. Real-time.",
	})
	_, err := io.WriteString(w, html)
	return err
}

func Download(w io.Writer, sessionID, config, serverURL, nonce string) error {
	html := readTemplate("download.html")
	html = apply(html, map[string]string{
		"session_id": sessionID,
		"config":     config,
		"server_url": serverURL,
		"nonce":      nonce,
		"title":      "Receive",
		"heading":    "Receive",
		"subtitle":   "Decryption happens locally in your browser. The server never sees your file.",
	})
	_, err := io.WriteString(w, html)
	return err
}

func NotFound(w io.Writer, nonce string) error {
	html := readTemplate("not-found.html")
	html = apply(html, map[string]string{
		"nonce":    nonce,
		"title":    "Not Found",
		"heading":  "Not Found",
		"subtitle": "This session doesn't exist or has expired.",
	})
	_, err := io.WriteString(w, html)
	return err
}

func ServiceUnavailable(w io.Writer, nonce string) error {
	html := readTemplate("service-unavailable.html")
	html = apply(html, map[string]string{
		"nonce":    nonce,
		"title":    "Unavailable",
		"heading":  "Service Unavailable",
		"subtitle": "Server is at capacity. Try again later.",
	})
	_, err := io.WriteString(w, html)
	return err
}

func Privacy(w io.Writer, nonce string) error {
	html := readTemplate("privacy.html")
	html = apply(html, map[string]string{"nonce": nonce})
	_, err := io.WriteString(w, html)
	return err
}

func Terms(w io.Writer, nonce string) error {
	html := readTemplate("terms.html")
	html = apply(html, map[string]string{"nonce": nonce})
	_, err := io.WriteString(w, html)
	return err
}
