package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"streamdrop/internal/middleware"
	"streamdrop/internal/page"
	"streamdrop/internal/relay"
	"streamdrop/internal/session"
	"streamdrop/internal/signaling"
	"streamdrop/internal/stats"
	"streamdrop/internal/webtransport"
)

var store = session.NewStore()

func main() {
	port := getEnv("PORT", "3000")
	sessionTTL := getDuration("SESSION_TTL", "12h")
	reaperInterval := getDuration("REAPER_INTERVAL", "1m")

	// Start session reaper
	go func() {
		for {
			time.Sleep(reaperInterval)
			removed := store.Reap(sessionTTL)
			if removed > 0 {
				log.Printf("reaped %d expired sessions", removed)
			}
		}
	}()

	mux := http.NewServeMux()

	// Static files
	staticDir := findStaticDir()
	if staticDir != "" {
		fs := http.FileServer(http.Dir(staticDir))
		mux.Handle("GET /static/", http.StripPrefix("/static/", fs))
	}
	// webrtc.js needs no-cache
	mux.HandleFunc("GET /static/webrtc.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, filepath.Join(staticDir, "static", "webrtc.js"))
	})

	// Health / Stats
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("GET /stats", func(w http.ResponseWriter, r *http.Request) {
		s := stats.GetSnapshot(int64(store.Count()), int64(store.ActiveTransferCount()))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s)
	})

	// Upload page (also supports JSON via Accept header)
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if acceptsJSON(r) {
			s := store.Create("", 0)
			if s == nil {
				http.Error(w, `{"error":"capacity"}`, http.StatusServiceUnavailable)
				return
			}
			stats.IncSessions()
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{
				"id":            s.ID,
				"uploadToken":   s.UploadToken,
				"downloadToken": s.DownloadToken,
			})
			return
		}
		s := store.Create("", 0)
		if s == nil {
			page.ServiceUnavailable(w, r.Header.Get("X-CSP-Nonce"))
			return
		}
		stats.IncSessions()
		config := configJSON(s)
		serverURL := getEnv("STREAMDROP_SERVER", "https://streamdrop.app")
		page.Upload(w, s.ID, config, serverURL, r.Header.Get("X-CSP-Nonce"))
	})

	// Download page (also supports JSON via Accept header)
	mux.HandleFunc("GET /{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "favicon.ico" || id == "robots.txt" {
			http.NotFound(w, r)
			return
		}
		s := store.ByID(id)
		if s == nil {
			if acceptsJSON(r) {
				http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
				return
			}
			page.NotFound(w, r.Header.Get("X-CSP-Nonce"))
			return
		}
		if acceptsJSON(r) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"id":            s.ID,
				"downloadToken": s.DownloadToken,
				"name":          s.FileName,
				"size":          s.FileSize,
			})
			return
		}
		config := `{"id":"` + s.ID + `","downloadToken":"` + s.DownloadToken + `","size":` + formatInt(s.FileSize) + `}`
		serverURL := getEnv("STREAMDROP_SERVER", "https://streamdrop.app")
		page.Download(w, s.ID, config, serverURL, r.Header.Get("X-CSP-Nonce"))
	})

	// Create session (API)
	mux.HandleFunc("POST /session", func(w http.ResponseWriter, r *http.Request) {
		if !isSameOrigin(r) {
			http.Error(w, `{"error":"cross_origin"}`, http.StatusForbidden)
			return
		}
		name := r.URL.Query().Get("name")
		size, _ := strconv.ParseInt(r.URL.Query().Get("size"), 10, 64)
		s := store.Create(name, size)
		if s == nil {
			http.Error(w, `{"error":"capacity"}`, http.StatusServiceUnavailable)
			return
		}
		stats.IncSessions()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"id":            s.ID,
			"uploadToken":   s.UploadToken,
			"downloadToken": s.DownloadToken,
		})
	})

	// Delete session
	mux.HandleFunc("DELETE /session/{uploadToken}", func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("uploadToken")
		s := store.ByUploadToken(token)
		if s == nil {
			http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
			return
		}
		store.Delete(s)
		signaling.DeleteRoom(s.ID)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})

	// Claim raw channel
	mux.HandleFunc("POST /claim/{uploadToken}", func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("uploadToken")
		s := store.ByUploadToken(token)
		if s == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		ch := s.FindUnclaimedRawChannel()
		if ch == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"channelId": ch.ID})
	})

	// Wait for receiver
	mux.HandleFunc("GET /wait-receiver/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		s := store.ByID(id)
		if s == nil {
			http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
			return
		}
		select {
		case <-s.ReceiverReady():
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"ok":true}`))
		case <-time.After(25 * time.Second):
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"ok":false}`))
		case <-r.Context().Done():
		}
	})

	// Ready (receiver signals readiness)
	mux.HandleFunc("POST /ready/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		s := store.ByID(id)
		if s == nil {
			http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
			return
		}
		s.NotifyReceiver()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})

	// Upload data
	mux.HandleFunc("PUT /upload/{uploadToken}", func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("uploadToken")
		s := store.ByUploadToken(token)
		if s == nil {
			http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
			return
		}
		relay.Upload(s, w, r)
	})

	// Download data
	mux.HandleFunc("GET /d/{downloadToken}", func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("downloadToken")
		s := store.ByDownloadToken(token)
		if s == nil {
			http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
			return
		}
		relay.Download(s, w, r)
	})

	// Raw upload (CLI mode)
	mux.HandleFunc("PUT /raw/upload/{uploadToken}/{channelId}", func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("uploadToken")
		s := store.ByUploadToken(token)
		if s == nil {
			http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
			return
		}
		relay.RawUpload(s, w, r)
	})

	// Raw download (CLI mode)
	mux.HandleFunc("GET /raw/d/{downloadToken}", func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("downloadToken")
		s := store.ByDownloadToken(token)
		if s == nil {
			http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
			return
		}
		relay.RawDownload(s, w, r)
	})

	// WebRTC signaling
	mux.HandleFunc("POST /signal/{id}", func(w http.ResponseWriter, r *http.Request) {
		signaling.PostJSON(w, r, store)
	})
	mux.HandleFunc("GET /signal/{id}/{role}", func(w http.ResponseWriter, r *http.Request) {
		signaling.PollJSON(w, r, store)
	})

	// Privacy / Terms
	mux.HandleFunc("GET /privacy", func(w http.ResponseWriter, r *http.Request) {
		page.Privacy(w, r.Header.Get("X-CSP-Nonce"))
	})
	mux.HandleFunc("GET /terms", func(w http.ResponseWriter, r *http.Request) {
		page.Terms(w, r.Header.Get("X-CSP-Nonce"))
	})

	handler := middleware.CORS(middleware.Security(mux))

	// Start WebTransport server
	wtAddr := getEnv("WT_ADDR", ":3001")
	certFile := getEnv("TLS_CERT", "/tmp/wt-cert.pem")
	keyFile := getEnv("TLS_KEY", "/tmp/wt-key.pem")
	wtServer, err := webtransport.New(wtAddr, certFile, keyFile, store)
	if err != nil {
		log.Printf("webtransport init: %v (skipping)", err)
	} else {
		go func() {
			if err := wtServer.Start(); err != nil {
				log.Printf("webtransport: %v", err)
			}
		}()
		defer wtServer.Close()
	}

	log.Printf("streamdrop-go listening on :%s", port)
	if err := http.ListenAndServe(":"+port, handler); err != nil {
		log.Fatal(err)
	}
}

func findStaticDir() string {
	dir, _ := os.Getwd()
	for {
		if _, err := os.Stat(filepath.Join(dir, "public", "static")); err == nil {
			return filepath.Join(dir, "public")
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func configJSON(s *session.Session) string {
	return `{"id":"` + s.ID + `","uploadToken":"` + s.UploadToken + `","downloadToken":"` + s.DownloadToken + `","size":` + formatInt(s.FileSize) + `}`
}

func formatInt(n int64) string {
	if n == 0 {
		return "0"
	}
	return strconv.FormatInt(n, 10)
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func getDuration(key, def string) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	d, _ := time.ParseDuration(def)
	return d
}

func acceptsJSON(r *http.Request) bool {
	accept := r.Header.Get("Accept")
	return strings.Contains(accept, "application/json") || strings.Contains(accept, "*/*")
}

func isSameOrigin(r *http.Request) bool {
	// Check Sec-Fetch-Site first (browser standard)
	secFetch := r.Header.Get("Sec-Fetch-Site")
	if secFetch == "same-origin" || secFetch == "same-site" || secFetch == "none" {
		return true
	}
	if secFetch == "cross-site" {
		return false
	}
	// Fall back to Origin header check
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // No origin header = not a browser request
	}
	// Compare origin with our own origin
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	expected := scheme + "://" + r.Host
	return origin == expected
}
