package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pion/webrtc/v3"
	"nhooyr.io/websocket"
)

var (
	magic     = []byte{0x53, 0x44, 0x31}
	headerLen = 3 + 4 + 12
)

type sessionRes struct {
	ID          string `json:"id"`
	UploadToken string `json:"uploadToken"`
	DownloadTok string `json:"downloadToken"`
}

type metaRes struct {
	ID          string      `json:"id"`
	DownloadTok string      `json:"downloadToken"`
	FileName    string      `json:"fileName"`
	IceServers  []iceServer `json:"iceServers"`
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type signalMsg struct {
	Type    string          `json:"type"`
	From    string          `json:"from,omitempty"`
	To      string          `json:"to,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type sdpPayload struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type icePayload struct {
	Candidate webrtc.ICECandidateInit `json:"candidate"`
}

func main() {
	if len(os.Args) < 2 {
		printHelp()
		os.Exit(1)
	}

	cmd := os.Args[1]
	switch cmd {
	case "send":
		sendCmd(os.Args[2:])
	case "receive", "recv":
		recvCmd(os.Args[2:])
	default:
		printHelp()
		os.Exit(1)
	}
}

func printHelp() {
	fmt.Println(`streamdrop

Usage:
  streamdrop send <file> [--server <url>]
  streamdrop receive "<share-url>" [--server <url>]
`)
}

func sendCmd(args []string) {
	fs := flag.NewFlagSet("send", flag.ExitOnError)
	serverFlag := fs.String("server", "", "server URL")
	_ = fs.Parse(args)
	if fs.NArg() < 1 {
		printHelp()
		os.Exit(1)
	}
	filePath := fs.Arg(0)
	server := normalizeServer(firstNonEmpty(*serverFlag, os.Getenv("STREAMDROP_SERVER"), "http://localhost:3000"))

	if err := runSend(context.Background(), server, filePath); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

func recvCmd(args []string) {
	fs := flag.NewFlagSet("receive", flag.ExitOnError)
	serverFlag := fs.String("server", "", "server URL override")
	_ = fs.Parse(args)
	if fs.NArg() < 1 {
		printHelp()
		os.Exit(1)
	}
	in := fs.Arg(0)

	share, err := parseShare(in)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}

	server := normalizeServer(firstNonEmpty(*serverFlag, os.Getenv("STREAMDROP_SERVER"), share.Server, "http://localhost:3000"))
	if err := runReceive(context.Background(), server, share); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

func runSend(ctx context.Context, server string, filePath string) error {
	st, err := os.Stat(filePath)
	if err != nil {
		return err
	}
	if st.IsDir() {
		return errors.New("directories not supported")
	}

	fileName := filepath.Base(filePath)
	sess, err := createSession(ctx, server, fileName)
	if err != nil {
		return err
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	keyFrag := base64urlEncode(key)
	shareURL := fmt.Sprintf("%s/%s#%s,%s", server, sess.ID, keyFrag, url.QueryEscape(fileName))

	fmt.Println("Share URL:", shareURL)

	meta, err := getMeta(ctx, server, sess.ID)
	if err != nil {
		return err
	}

	sendCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	go func() {
		_ = runRelaySender(sendCtx, server, sess, filePath, key)
	}()

	_ = runP2PSender(sendCtx, server, sess, meta, filePath, key)
	return nil
}

func runReceive(ctx context.Context, server string, share shareInfo) error {
	meta, err := getMeta(ctx, server, share.ID)
	if err != nil {
		return err
	}

	outName := share.FileName
	if outName == "" {
		outName = meta.FileName
	}
	if outName == "" {
		outName = "streamdrop.bin"
	}
	outName = safeFileName(outName)

	outPath := "./" + outName
	tmpPath := outPath + ".part"

	if err := os.Remove(tmpPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}

	p2pCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()

	rc, err := tryP2PReceive(p2pCtx, server, share.ID, meta.DownloadTok, meta.IceServers)
	if err == nil && rc != nil {
		defer rc.Close()
		if err := decryptToFile(ctx, rc, tmpPath, share.Key, share.ID); err != nil {
			return err
		}
		return finalize(tmpPath, outPath)
	}

	req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/d/%s", server, meta.DownloadTok), nil)
	if err != nil {
		return err
	}
	req.Header.Set("accept", "application/octet-stream")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("download_failed_%d %s", res.StatusCode, strings.TrimSpace(string(b)))
	}

	if err := decryptToFile(ctx, res.Body, tmpPath, share.Key, share.ID); err != nil {
		return err
	}
	return finalize(tmpPath, outPath)
}

func finalize(tmpPath, outPath string) error {
	if err := os.Remove(outPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(tmpPath, outPath); err != nil {
		return err
	}
	fmt.Println("Saved:", outPath)
	return nil
}

func createSession(ctx context.Context, server, fileName string) (*sessionRes, error) {
	u := fmt.Sprintf("%s/session?name=%s", server, url.QueryEscape(fileName))
	req, err := http.NewRequestWithContext(ctx, "POST", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return nil, fmt.Errorf("session_failed_%d %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	var out sessionRes
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.ID == "" || out.UploadToken == "" || out.DownloadTok == "" {
		return nil, errors.New("bad_session")
	}
	return &out, nil
}

func getMeta(ctx context.Context, server, id string) (*metaRes, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/meta/%s", server, url.PathEscape(id)), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return nil, fmt.Errorf("meta_failed_%d %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	var out metaRes
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

func runRelaySender(ctx context.Context, server string, sess *sessionRes, filePath string, key []byte) error {
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		ok := waitReceiver(ctx, server, sess.ID)
		if !ok {
			continue
		}
		for {
			ch := claim(ctx, server, sess.UploadToken)
			if ch == "" {
				break
			}
			f, err := os.Open(filePath)
			if err != nil {
				return err
			}
			r, err := newEncryptReader(f, key, sess.ID, 256*1024)
			if err != nil {
				f.Close()
				return err
			}
			u := fmt.Sprintf("%s/upload/%s/%s", server, sess.UploadToken, url.PathEscape(ch))
			req, err := http.NewRequestWithContext(ctx, "PUT", u, io.NopCloser(r))
			if err != nil {
				f.Close()
				return err
			}
			req.Header.Set("content-type", "application/octet-stream")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				f.Close()
				continue
			}
			io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
			res.Body.Close()
			f.Close()
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func waitReceiver(ctx context.Context, server, id string) bool {
	req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/wait-receiver/%s", server, url.PathEscape(id)), nil)
	if err != nil {
		return false
	}
	req.Header.Set("accept", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var body struct {
		OK bool `json:"ok"`
	}
	_ = json.NewDecoder(res.Body).Decode(&body)
	return body.OK
}

func claim(ctx context.Context, server, ut string) string {
	req, err := http.NewRequestWithContext(ctx, "POST", fmt.Sprintf("%s/claim/%s", server, url.PathEscape(ut)), nil)
	if err != nil {
		return ""
	}
	req.Header.Set("accept", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode == 204 {
		return ""
	}
	var body struct {
		ChannelID string `json:"channelId"`
	}
	_ = json.NewDecoder(res.Body).Decode(&body)
	return body.ChannelID
}

func tryP2PReceive(ctx context.Context, server, id, dt string, ice []iceServer) (io.ReadCloser, error) {
	wsURL := toWS(server) + "/signal/" + url.PathEscape(id) + "?dt=" + url.QueryEscape(dt)
	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return nil, err
	}

	cfg := webrtc.Configuration{ICEServers: toICEServers(ice)}
	pc, err := webrtc.NewPeerConnection(cfg)
	if err != nil {
		c.Close(websocket.StatusNormalClosure, "")
		return nil, err
	}

	pipeR, pipeW := io.Pipe()

	dc, err := pc.CreateDataChannel("streamdrop", &webrtc.DataChannelInit{Ordered: ptr(true)})
	if err != nil {
		pc.Close()
		c.Close(websocket.StatusNormalClosure, "")
		return nil, err
	}

	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if len(m.Data) == 0 {
			return
		}
		_, _ = pipeW.Write(m.Data)
	})

	dc.OnClose(func() {
		pipeW.Close()
	})

	pc.OnICECandidate(func(cand *webrtc.ICECandidate) {
		if cand == nil {
			return
		}
		p := icePayload{Candidate: cand.ToJSON()}
		b, _ := json.Marshal(p)
		_ = writeSignal(ctx, c, signalMsg{Type: "ice", Payload: b})
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		pc.Close()
		c.Close(websocket.StatusNormalClosure, "")
		return nil, err
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		pc.Close()
		c.Close(websocket.StatusNormalClosure, "")
		return nil, err
	}
	{
		p := sdpPayload{Type: pc.LocalDescription().Type.String(), SDP: pc.LocalDescription().SDP}
		b, _ := json.Marshal(p)
		if err := writeSignal(ctx, c, signalMsg{Type: "offer", Payload: b}); err != nil {
			pc.Close()
			c.Close(websocket.StatusNormalClosure, "")
			return nil, err
		}
	}

	go readSignalLoop(ctx, c, func(m signalMsg) {
		switch m.Type {
		case "answer":
			var p sdpPayload
			if json.Unmarshal(m.Payload, &p) != nil {
				return
			}
			_ = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: p.SDP})
		case "ice":
			var p icePayload
			if json.Unmarshal(m.Payload, &p) != nil {
				return
			}
			_ = pc.AddICECandidate(p.Candidate)
		}
	})

	select {
	case <-ctx.Done():
		pc.Close()
		c.Close(websocket.StatusNormalClosure, "")
		return nil, ctx.Err()
	case <-dataChannelOpen(dc):
	}

	return &wrappedReadCloser{
		r: pipeR,
		closeFn: func() error {
			pc.Close()
			c.Close(websocket.StatusNormalClosure, "")
			return nil
		},
	}, nil
}

func runP2PSender(ctx context.Context, server string, sess *sessionRes, meta *metaRes, filePath string, key []byte) error {
	wsURL := toWS(server) + "/signal/" + url.PathEscape(sess.ID) + "?ut=" + url.QueryEscape(sess.UploadToken)
	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return err
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	cfg := webrtc.Configuration{ICEServers: toICEServers(meta.IceServers)}
	type peer struct {
		pc *webrtc.PeerConnection
	}
	peers := map[string]*peer{}

	handleOffer := func(from string, p sdpPayload) {
		if _, ok := peers[from]; ok {
			return
		}
		pc, err := webrtc.NewPeerConnection(cfg)
		if err != nil {
			return
		}
		peers[from] = &peer{pc: pc}

		pc.OnICECandidate(func(cand *webrtc.ICECandidate) {
			if cand == nil {
				return
			}
			b, _ := json.Marshal(icePayload{Candidate: cand.ToJSON()})
			_ = writeSignal(ctx, c, signalMsg{Type: "ice", To: from, Payload: b})
		})

		pc.OnDataChannel(func(dc *webrtc.DataChannel) {
			dc.OnOpen(func() {
				go func() {
					_ = sendEncryptedOverDataChannel(ctx, filePath, key, sess.ID, dc)
					dc.Close()
					pc.Close()
					delete(peers, from)
				}()
			})
		})

		_ = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: p.SDP})
		answer, err := pc.CreateAnswer(nil)
		if err != nil {
			pc.Close()
			delete(peers, from)
			return
		}
		_ = pc.SetLocalDescription(answer)
		b, _ := json.Marshal(sdpPayload{Type: pc.LocalDescription().Type.String(), SDP: pc.LocalDescription().SDP})
		_ = writeSignal(ctx, c, signalMsg{Type: "answer", To: from, Payload: b})
	}

	go readSignalLoop(ctx, c, func(m signalMsg) {
		switch m.Type {
		case "offer":
			var p sdpPayload
			if json.Unmarshal(m.Payload, &p) != nil {
				return
			}
			handleOffer(m.From, p)
		case "ice":
			var p icePayload
			if json.Unmarshal(m.Payload, &p) != nil {
				return
			}
			if m.From == "" {
				return
			}
			if peer := peers[m.From]; peer != nil {
				_ = peer.pc.AddICECandidate(p.Candidate)
			}
		}
	})

	<-ctx.Done()
	return ctx.Err()
}

func sendEncryptedOverDataChannel(ctx context.Context, filePath string, key []byte, sessionID string, dc *webrtc.DataChannel) error {
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	r, err := newEncryptReader(f, key, sessionID, 256*1024)
	if err != nil {
		return err
	}
	buf := make([]byte, 64*1024)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		n, err := r.Read(buf)
		if n > 0 {
			if sendErr := dc.Send(buf[:n]); sendErr != nil {
				return sendErr
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func decryptToFile(ctx context.Context, r io.Reader, outPath string, key []byte, sessionID string) error {
	out, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer out.Close()

	dec, err := newDecryptReader(r, key, sessionID)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, &ctxReader{ctx: ctx, r: dec})
	if err != nil {
		return err
	}
	return out.Close()
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if c.ctx.Err() != nil {
		return 0, c.ctx.Err()
	}
	return c.r.Read(p)
}

type shareInfo struct {
	Server   string
	ID       string
	Key      []byte
	FileName string
}

func parseShare(in string) (shareInfo, error) {
	s := strings.TrimSpace(in)
	if !strings.Contains(s, "#") {
		return shareInfo{}, errors.New("missing fragment key")
	}
	u, err := url.Parse(s)
	if err != nil {
		return shareInfo{}, err
	}
	id := strings.Trim(strings.TrimPrefix(u.Path, "/"), " ")
	if strings.Contains(id, "/") {
		id = strings.Split(id, "/")[0]
	}
	if id == "" {
		return shareInfo{}, errors.New("missing id")
	}
	frag := strings.TrimPrefix(u.Fragment, "#")
	parts := strings.Split(frag, ",")
	keyFrag := parts[0]
	key, err := base64urlDecode(keyFrag)
	if err != nil || len(key) != 32 {
		return shareInfo{}, errors.New("bad key")
	}
	name := ""
	if len(parts) > 1 {
		n, _ := url.QueryUnescape(strings.Join(parts[1:], ","))
		name = n
	}
	return shareInfo{Server: u.Scheme + "://" + u.Host, ID: id, Key: key, FileName: name}, nil
}

func safeFileName(s string) string {
	s = filepath.Base(s)
	s = strings.ReplaceAll(s, "\n", "")
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\"", "")
	s = strings.TrimSpace(s)
	if s == "" {
		return "streamdrop.bin"
	}
	return s
}

func normalizeServer(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, "/")
	return s
}

func firstNonEmpty(v ...string) string {
	for _, x := range v {
		x = strings.TrimSpace(x)
		if x != "" {
			return x
		}
	}
	return ""
}

func base64urlEncode(b []byte) string {
	return strings.TrimRight(base64.URLEncoding.EncodeToString(b), "=")
}

func base64urlDecode(s string) ([]byte, error) {
	if m := len(s) % 4; m != 0 {
		s += strings.Repeat("=", 4-m)
	}
	return base64.URLEncoding.DecodeString(s)
}

func toWS(httpOrigin string) string {
	if strings.HasPrefix(httpOrigin, "https://") {
		return "wss://" + strings.TrimPrefix(httpOrigin, "https://")
	}
	if strings.HasPrefix(httpOrigin, "http://") {
		return "ws://" + strings.TrimPrefix(httpOrigin, "http://")
	}
	return "ws://" + strings.TrimPrefix(httpOrigin, "ws://")
}

func toICEServers(in []iceServer) []webrtc.ICEServer {
	out := make([]webrtc.ICEServer, 0, len(in))
	for _, s := range in {
		if len(s.URLs) == 0 {
			continue
		}
		out = append(out, webrtc.ICEServer{
			URLs:       s.URLs,
			Username:   s.Username,
			Credential: s.Credential,
		})
	}
	return out
}

func readSignalLoop(ctx context.Context, c *websocket.Conn, fn func(signalMsg)) {
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		var m signalMsg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		fn(m)
	}
}

func writeSignal(ctx context.Context, c *websocket.Conn, m signalMsg) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return c.Write(ctx, websocket.MessageText, b)
}

func dataChannelOpen(dc *webrtc.DataChannel) <-chan struct{} {
	ch := make(chan struct{})
	dc.OnOpen(func() {
		close(ch)
	})
	return ch
}

func ptr[T any](v T) *T { return &v }

type wrappedReadCloser struct {
	r       io.ReadCloser
	closeFn func() error
}

func (w *wrappedReadCloser) Read(p []byte) (int, error) { return w.r.Read(p) }
func (w *wrappedReadCloser) Close() error {
	_ = w.r.Close()
	if w.closeFn != nil {
		return w.closeFn()
	}
	return nil
}

type encryptReader struct {
	r          io.Reader
	gcm        cipher.AEAD
	sessionID  string
	chunkSize  uint32
	baseIV     [12]byte
	chunkIndex uint32
	buf        []byte
	tmp        []byte
	eof        bool
}

func newEncryptReader(r io.Reader, key []byte, sessionID string, chunkSize uint32) (*encryptReader, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	var baseIV [12]byte
	if _, err := rand.Read(baseIV[:]); err != nil {
		return nil, err
	}
	h := make([]byte, headerLen)
	copy(h[0:3], magic)
	binary.BigEndian.PutUint32(h[3:7], chunkSize)
	copy(h[7:19], baseIV[:])
	return &encryptReader{
		r:         r,
		gcm:       gcm,
		sessionID: sessionID,
		chunkSize: chunkSize,
		baseIV:    baseIV,
		buf:       h,
		tmp:       make([]byte, 0, chunkSize),
	}, nil
}

func (e *encryptReader) Read(p []byte) (int, error) {
	if len(e.buf) > 0 {
		n := copy(p, e.buf)
		e.buf = e.buf[n:]
		return n, nil
	}
	if e.eof && len(e.tmp) == 0 {
		return 0, io.EOF
	}
	for uint32(len(e.tmp)) < e.chunkSize && !e.eof {
		need := int(e.chunkSize) - len(e.tmp)
		b := make([]byte, need)
		n, err := e.r.Read(b)
		if n > 0 {
			e.tmp = append(e.tmp, b[:n]...)
		}
		if err == io.EOF {
			e.eof = true
		} else if err != nil {
			return 0, err
		}
		if n == 0 && err == nil {
			break
		}
	}
	if len(e.tmp) == 0 && e.eof {
		return 0, io.EOF
	}
	var chunk []byte
	if uint32(len(e.tmp)) >= e.chunkSize {
		chunk = e.tmp[:e.chunkSize]
		e.tmp = e.tmp[e.chunkSize:]
	} else {
		chunk = e.tmp
		e.tmp = nil
	}
	frame, err := e.encryptFrame(chunk)
	if err != nil {
		return 0, err
	}
	e.chunkIndex++
	e.buf = frame
	return e.Read(p)
}

func (e *encryptReader) encryptFrame(plain []byte) ([]byte, error) {
	iv := deriveIV(e.baseIV[:], e.chunkIndex)
	aad := []byte(fmt.Sprintf("streamdrop/v1|%s|%d", e.sessionID, e.chunkIndex))
	ciphertext := e.gcm.Seal(nil, iv, plain, aad)
	out := make([]byte, 8+len(ciphertext))
	binary.BigEndian.PutUint32(out[0:4], e.chunkIndex)
	binary.BigEndian.PutUint32(out[4:8], uint32(len(ciphertext)))
	copy(out[8:], ciphertext)
	return out, nil
}

type decryptReader struct {
	r         io.Reader
	gcm       cipher.AEAD
	sessionID string
	header    []byte
	baseIV    []byte
	expect    uint32
	buf       []byte
}

func newDecryptReader(r io.Reader, key []byte, sessionID string) (*decryptReader, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	h := make([]byte, headerLen)
	if _, err := io.ReadFull(r, h); err != nil {
		return nil, err
	}
	if !bytes.Equal(h[0:3], magic) {
		return nil, errors.New("bad_magic")
	}
	base := make([]byte, 12)
	copy(base, h[7:19])
	return &decryptReader{r: r, gcm: gcm, sessionID: sessionID, baseIV: base, expect: 0}, nil
}

func (d *decryptReader) Read(p []byte) (int, error) {
	if len(d.buf) > 0 {
		n := copy(p, d.buf)
		d.buf = d.buf[n:]
		return n, nil
	}
	h := make([]byte, 8)
	if _, err := io.ReadFull(d.r, h); err != nil {
		return 0, err
	}
	chunkIndex := binary.BigEndian.Uint32(h[0:4])
	cipherLen := binary.BigEndian.Uint32(h[4:8])
	if chunkIndex != d.expect {
		return 0, errors.New("bad_chunk_index")
	}
	ciphertext := make([]byte, cipherLen)
	if _, err := io.ReadFull(d.r, ciphertext); err != nil {
		return 0, err
	}
	iv := deriveIV(d.baseIV, chunkIndex)
	aad := []byte(fmt.Sprintf("streamdrop/v1|%s|%d", d.sessionID, chunkIndex))
	plain, err := d.gcm.Open(nil, iv, ciphertext, aad)
	if err != nil {
		return 0, err
	}
	d.expect++
	d.buf = plain
	return d.Read(p)
}

func deriveIV(base []byte, chunkIndex uint32) []byte {
	iv := make([]byte, 12)
	copy(iv, base)
	iv[8] ^= byte(chunkIndex >> 24)
	iv[9] ^= byte(chunkIndex >> 16)
	iv[10] ^= byte(chunkIndex >> 8)
	iv[11] ^= byte(chunkIndex)
	return iv
}
