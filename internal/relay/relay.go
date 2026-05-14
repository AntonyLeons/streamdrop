package relay

import (
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"streamdrop/internal/session"
	"streamdrop/internal/stats"
)

const waitTimeout = 120 * time.Second

func Upload(s *session.Session, w http.ResponseWriter, r *http.Request) {
	body := r.Body
	if body == nil {
		http.Error(w, "missing body", http.StatusBadRequest)
		return
	}
	defer body.Close()

	rpipe := s.Relay()
	rpipe.StartUpload()
	s.Status = "active"
	s.ActiveSenders++
	defer func() {
		rpipe.Done()
		s.ActiveSenders--
		if s.ActiveSenders == 0 && s.Status == "active" {
			s.Status = "waiting"
		}
	}()

	buf := make([]byte, 65536)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			stats.AddBytes(n)
			if _, werr := rpipe.PW().Write(buf[:n]); werr != nil {
				log.Printf("relay write: %v", werr)
				return
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return
		}
	}
	rpipe.PW().Close()
	stats.IncFiles()
}

func Download(s *session.Session, w http.ResponseWriter, r *http.Request) {
	rpipe := s.Relay()

	if !rpipe.Uploading {
		s.NotifyReceiver()
		if !rpipe.WaitUpload(waitTimeout) {
			http.Error(w, "no upload", http.StatusNotFound)
			return
		}
	}

	setDownloadHeaders(w, s, "streamdrop.enc")
	io.Copy(w, rpipe.PR())
}

func RawUpload(s *session.Session, w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	ch := s.ClaimAndSendRawChannel(channelID)
	if ch == nil {
		http.Error(w, `{"error":"channel_not_found"}`, http.StatusNotFound)
		return
	}

	// Capture filename from query param or x-file-name header
	if name := r.URL.Query().Get("name"); name != "" {
		s.FileName = safeFileName(name)
	}
	if name := r.Header.Get("x-file-name"); name != "" && s.FileName == "" {
		s.FileName = safeFileName(name)
	}

	s.ActiveSenders++
	s.Status = "active"

	body := r.Body
	if body == nil {
		body = http.NoBody
	}
	defer body.Close()

	buf := make([]byte, 65536)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			stats.AddBytes(n)
			if _, werr := ch.Writer().Write(buf[:n]); werr != nil {
				log.Printf("raw relay write: %v", werr)
				ch.Close()
				s.ActiveSenders--
				w.WriteHeader(http.StatusOK)
				w.Write([]byte(`{"ok":true}`))
				return
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			ch.Close()
			s.ActiveSenders--
			return
		}
	}
	ch.Writer().Close()
	stats.IncFiles()
	s.ActiveSenders--

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

func RawDownload(s *session.Session, w http.ResponseWriter, r *http.Request) {
	ch := s.AddRawChannel()
	s.NotifyReceiver()

	filename := s.FileName
	if filename == "" {
		filename = "streamdrop.bin"
	}

	setDownloadHeaders(w, s, filename)
	w.Header().Set("x-streamdrop-channel", ch.ID)

	// If the sender cancels or the channel is closed, abort the response
	ctx := r.Context()
	go func() {
		<-ctx.Done()
		ch.Close()
	}()

	io.Copy(w, ch.Reader())
	// Clean up after copy completes
	s.DeleteRawChannel(ch.ID)
}

func setDownloadHeaders(w http.ResponseWriter, s *session.Session, filename string) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Accept-Ranges", "none")
	w.Header().Set("X-Accel-Buffering", "no")
	SetDisposition(w, filename)
}

func SetDisposition(w http.ResponseWriter, filename string) {
	cleaned := safeFileName(filename)
	if cleaned == "" {
		cleaned = "file"
	}
	ascii := strings.Map(func(r rune) rune {
		if r >= 0x20 && r <= 0x7E && r != '"' && r != '\\' {
			return r
		}
		return '_'
	}, cleaned)
	if len(ascii) > 120 {
		ascii = ascii[:120]
	}
	if ascii == "" {
		ascii = "file"
	}
	utf8 := encodeRFC5987ValueChars(cleaned)
	w.Header().Set("Content-Disposition", `attachment; filename="`+ascii+`"; filename*=UTF-8''`+utf8)
}

func safeFileName(name string) string {
	name = strings.TrimSpace(name)
	// Strip directory path (take last segment)
	if idx := strings.LastIndexAny(name, `\/`); idx >= 0 {
		name = name[idx+1:]
	}
	name = strings.NewReplacer("\r", "", "\n", "", "\"", "").Replace(name)
	name = strings.TrimSpace(name)
	if len(name) > 120 {
		name = name[:120]
	}
	return name
}

func encodeRFC5987ValueChars(s string) string {
	var out strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			out.WriteRune(r)
		} else {
			out.WriteString("%")
			out.WriteString(strings.ToUpper(string([]byte{byte(r)})))
		}
	}
	return out.String()
}
