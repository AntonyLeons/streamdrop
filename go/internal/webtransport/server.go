package webtransport

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"streamdrop/internal/session"
	"streamdrop/internal/stats"
	"time"

	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

type Server struct {
	wtServer *webtransport.Server
}

type controlMsg struct {
	Type          string `json:"type"`
	UploadToken   string `json:"uploadToken,omitempty"`
	DownloadToken string `json:"downloadToken,omitempty"`
	SessionID     string `json:"sessionId,omitempty"`
}

func New(addr, certFile, keyFile string, store *session.Store) (*Server, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}

	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"h3"},
	}

	wtSrv := &webtransport.Server{
		H3: &http3.Server{
			Addr:      addr,
			TLSConfig: tlsCfg,
		},
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/wt", func(w http.ResponseWriter, r *http.Request) {
		wtSession, err := wtSrv.Upgrade(w, r)
		if err != nil {
			log.Printf("wt upgrade error: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		handleSession(wtSession, store)
	})
	wtSrv.H3.Handler = mux

	return &Server{wtServer: wtSrv}, nil
}

func (s *Server) Start() error {
	log.Printf("webtransport listening on %s", s.wtServer.H3.Addr)
	return s.wtServer.ListenAndServe()
}

func (s *Server) Close() error {
	return s.wtServer.Close()
}

func handleSession(wtSession *webtransport.Session, store *session.Store) {
	defer wtSession.CloseWithError(0, "closing")

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	stream, err := wtSession.AcceptStream(ctx)
	if err != nil {
		return
	}
	defer stream.Close()

	var msg controlMsg
	dec := json.NewDecoder(stream)
	if err := dec.Decode(&msg); err != nil {
		return
	}

	switch msg.Type {
	case "upload":
		handleUpload(stream, &msg, store)
	case "download":
		handleDownload(stream, &msg, store)
	default:
		json.NewEncoder(stream).Encode(map[string]string{"error": "unknown_type"})
	}
}

func handleUpload(stream *webtransport.Stream, msg *controlMsg, store *session.Store) {
	sess := store.ByUploadToken(msg.UploadToken)
	if sess == nil {
		json.NewEncoder(stream).Encode(map[string]string{"error": "not_found"})
		return
	}

	rpipe := sess.Relay()
	rpipe.StartUpload()
	sess.Status = "active"
	sess.ActiveSenders++
	defer func() {
		rpipe.Done()
		sess.ActiveSenders--
		if sess.ActiveSenders == 0 && sess.Status == "active" {
			sess.Status = "waiting"
		}
	}()

	json.NewEncoder(stream).Encode(map[string]string{"ok": "true"})

	buf := make([]byte, 65536)
	for {
		n, err := stream.Read(buf)
		if n > 0 {
			stats.AddBytes(n)
			if _, werr := rpipe.PW().Write(buf[:n]); werr != nil {
				log.Printf("wt relay write: %v", werr)
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

func handleDownload(stream *webtransport.Stream, msg *controlMsg, store *session.Store) {
	const waitTimeout = 120 * time.Second

	sess := store.ByDownloadToken(msg.DownloadToken)
	if sess == nil {
		json.NewEncoder(stream).Encode(map[string]string{"error": "not_found"})
		return
	}

	rpipe := sess.Relay()

	if !rpipe.Uploading {
		sess.NotifyReceiver()
		if !rpipe.WaitUpload(waitTimeout) {
			json.NewEncoder(stream).Encode(map[string]string{"error": "no_upload"})
			return
		}
	}

	json.NewEncoder(stream).Encode(map[string]string{"ok": "true"})

	buf := make([]byte, 65536)
	for {
		n, err := rpipe.PR().Read(buf)
		if n > 0 {
			if _, werr := stream.Write(buf[:n]); werr != nil {
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
}
