package signaling

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"streamdrop/internal/session"
)

type Message struct {
	From string          `json:"from"`
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type Room struct {
	mu       sync.Mutex
	messages []Message
	waiters  []chan []Message
}

func (r *Room) Post(msg Message) {
	r.mu.Lock()
	r.messages = append(r.messages, msg)
	waiters := r.waiters
	r.waiters = nil
	r.mu.Unlock()
	for _, w := range waiters {
		select {
		case w <- []Message{msg}:
		default:
		}
	}
}

func (r *Room) WaitFor(from string, timeout time.Duration) []Message {
	r.mu.Lock()
	var matching []Message
	rest := make([]Message, 0, len(r.messages))
	for _, m := range r.messages {
		if m.From == from {
			matching = append(matching, m)
		} else {
			rest = append(rest, m)
		}
	}
	r.messages = rest
	if len(matching) > 0 {
		r.mu.Unlock()
		return matching
	}
	ch := make(chan []Message, 1)
	r.waiters = append(r.waiters, ch)
	r.mu.Unlock()

	select {
	case msgs := <-ch:
		// Filter by from again
		var filtered []Message
		for _, m := range msgs {
			if m.From == from {
				filtered = append(filtered, m)
			}
		}
		return filtered
	case <-time.After(timeout):
		return nil
	}
}

var (
	rooms   = map[string]*Room{}
	roomsMu sync.RWMutex
)

func GetOrCreateRoom(sessionID string) *Room {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	r, ok := rooms[sessionID]
	if !ok {
		r = &Room{}
		rooms[sessionID] = r
	}
	return r
}

func DeleteRoom(sessionID string) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	delete(rooms, sessionID)
}

func PostJSON(w http.ResponseWriter, r *http.Request, store *session.Store) {
	id := r.PathValue("id")
	s := store.ByID(id)
	if s == nil {
		http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
		return
	}
	var msg Message
	if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
		http.Error(w, `{"error":"bad_request"}`, http.StatusBadRequest)
		return
	}
	room := GetOrCreateRoom(id)
	room.Post(msg)
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

func PollJSON(w http.ResponseWriter, r *http.Request, store *session.Store) {
	id := r.PathValue("id")
	role := r.PathValue("role")
	s := store.ByID(id)
	if s == nil {
		http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
		return
	}
	from := "sender"
	if role == "sender" {
		from = "receiver"
	}
	room := GetOrCreateRoom(id)
	msgs := room.WaitFor(from, 25*time.Second)
	if msgs == nil {
		msgs = []Message{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(msgs)
}
