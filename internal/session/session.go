package session

import (
	"crypto/rand"
	"encoding/base64"
	"io"
	"sync"
	"time"
)

type RawChannel struct {
	ID      string
	Claimed bool
	Sending bool

	pr *io.PipeReader
	pw *io.PipeWriter
}

func (rc *RawChannel) Reader() *io.PipeReader { return rc.pr }
func (rc *RawChannel) Writer() *io.PipeWriter { return rc.pw }
func (rc *RawChannel) Close()                 { rc.pw.Close(); rc.pr.Close() }

type Session struct {
	ID            string
	UploadToken   string
	DownloadToken string
	FileName      string
	FileSize      int64
	CreatedAt     time.Time
	LastTouched   time.Time
	Status        string
	ActiveSenders int

	relay     *Relay
	receiverC chan struct{}
	mu        sync.Mutex

	rawMu       sync.Mutex
	rawChannels []*RawChannel
}

func (s *Session) AddRawChannel() *RawChannel {
	pr, pw := io.Pipe()
	ch := &RawChannel{
		ID:   randomToken(12),
		pr:   pr,
		pw:   pw,
	}
	s.rawMu.Lock()
	s.rawChannels = append(s.rawChannels, ch)
	s.rawMu.Unlock()
	return ch
}

func (s *Session) ClaimRawChannel(channelID string) *RawChannel {
	s.rawMu.Lock()
	defer s.rawMu.Unlock()
	for _, ch := range s.rawChannels {
		if ch.ID == channelID && !ch.Claimed {
			ch.Claimed = true
			return ch
		}
	}
	return nil
}

func (s *Session) FindUnclaimedRawChannel() *RawChannel {
	s.rawMu.Lock()
	defer s.rawMu.Unlock()
	for _, ch := range s.rawChannels {
		if !ch.Claimed {
			return ch
		}
	}
	return nil
}

// ClaimAndSendRawChannel marks a channel as claimed and sets sending.
// Returns nil if channel doesn't exist or is already sending.
func (s *Session) ClaimAndSendRawChannel(channelID string) *RawChannel {
	s.rawMu.Lock()
	defer s.rawMu.Unlock()
	for _, ch := range s.rawChannels {
		if ch.ID == channelID {
			if ch.Sending {
				return nil
			}
			ch.Claimed = true
			ch.Sending = true
			return ch
		}
	}
	return nil
}

func (s *Session) DeleteRawChannel(channelID string) {
	s.rawMu.Lock()
	defer s.rawMu.Unlock()
	for i, ch := range s.rawChannels {
		if ch.ID == channelID {
			ch.Close()
			s.rawChannels = append(s.rawChannels[:i], s.rawChannels[i+1:]...)
			return
		}
	}
}

func (s *Session) Touch() { s.LastTouched = time.Now() }

func (s *Session) Relay() *Relay {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.relay == nil {
		pr, pw := io.Pipe()
		s.relay = &Relay{pr: pr, pw: pw, uploadCh: make(chan struct{}, 1)}
	}
	return s.relay
}

func (s *Session) ReceiverReady() chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.receiverC == nil {
		s.receiverC = make(chan struct{}, 1)
	}
	return s.receiverC
}

func (s *Session) NotifyReceiver() {
	s.mu.Lock()
	c := s.receiverC
	s.mu.Unlock()
	if c != nil {
		select {
		case c <- struct{}{}:
		default:
		}
	}
}

type Relay struct {
	pr        *io.PipeReader
	pw        *io.PipeWriter
	uploadCh  chan struct{}
	mu        sync.Mutex
	Uploading bool
}

func (r *Relay) PR() *io.PipeReader  { return r.pr }
func (r *Relay) PW() *io.PipeWriter  { return r.pw }

func (r *Relay) WaitUpload(timeout time.Duration) bool {
	select {
	case <-r.uploadCh:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (r *Relay) StartUpload() {
	r.mu.Lock()
	r.Uploading = true
	r.mu.Unlock()
	select {
	case r.uploadCh <- struct{}{}:
	default:
	}
}

func (r *Relay) Done() {
	r.mu.Lock()
	r.Uploading = false
	r.mu.Unlock()
}

type Store struct {
	mu       sync.RWMutex
	byID     map[string]*Session
	byUpload map[string]*Session
	byDownl  map[string]*Session
}

func NewStore() *Store {
	return &Store{
		byID:     make(map[string]*Session),
		byUpload: make(map[string]*Session),
		byDownl:  make(map[string]*Session),
	}
}

func (st *Store) Create(fileName string, fileSize int64) *Session {
	s := &Session{
		ID:            randomToken(10),
		UploadToken:   randomToken(32),
		DownloadToken: randomToken(32),
		FileName:      fileName,
		FileSize:      fileSize,
		CreatedAt:     time.Now(),
		LastTouched:   time.Now(),
		Status:        "waiting",
	}
	st.mu.Lock()
	st.byID[s.ID] = s
	st.byUpload[s.UploadToken] = s
	st.byDownl[s.DownloadToken] = s
	st.mu.Unlock()
	return s
}

func (st *Store) ByID(id string) *Session {
	st.mu.RLock()
	s := st.byID[id]
	st.mu.RUnlock()
	if s != nil {
		s.Touch()
	}
	return s
}

func (st *Store) ByUploadToken(token string) *Session {
	st.mu.RLock()
	s := st.byUpload[token]
	st.mu.RUnlock()
	if s != nil {
		s.Touch()
	}
	return s
}

func (st *Store) ByDownloadToken(token string) *Session {
	st.mu.RLock()
	s := st.byDownl[token]
	st.mu.RUnlock()
	if s != nil {
		s.Touch()
	}
	return s
}

func (st *Store) Delete(s *Session) {
	st.mu.Lock()
	defer st.mu.Unlock()
	delete(st.byID, s.ID)
	delete(st.byUpload, s.UploadToken)
	delete(st.byDownl, s.DownloadToken)
}

func (st *Store) Count() int {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return len(st.byID)
}

func (st *Store) Reap(ttl time.Duration) int {
	now := time.Now()
	st.mu.Lock()
	defer st.mu.Unlock()
	var removed int
	for id, s := range st.byID {
		if now.Sub(s.LastTouched) > ttl && s.ActiveSenders == 0 {
			delete(st.byID, id)
			delete(st.byUpload, s.UploadToken)
			delete(st.byDownl, s.DownloadToken)
			removed++
		}
	}
	return removed
}

func (st *Store) ActiveTransferCount() int {
	st.mu.RLock()
	defer st.mu.RUnlock()
	var n int
	for _, s := range st.byID {
		if s.ActiveSenders > 0 {
			n++
		}
	}
	return n
}

func randomToken(byteLen int) string {
	b := make([]byte, byteLen)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
