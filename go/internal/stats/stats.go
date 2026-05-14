package stats

import (
	"sync"
	"sync/atomic"
	"time"
)

var (
	totalSessions atomic.Int64
	totalBytes    atomic.Int64
	totalFiles    atomic.Int64
	startTime     = time.Now()
)

type Monthly struct {
	Month         string `json:"month"`
	TotalSessions int64  `json:"total_sessions"`
	TotalBytes    int64  `json:"total_bytes"`
	TotalFiles    int64  `json:"total_files"`
}

var (
	mu            sync.Mutex
	currentMonth  string
	monthSessions int64
	monthBytes    int64
	monthFiles    int64
)

func checkMonth() {
	m := time.Now().Format("2006-01")
	if m != currentMonth {
		currentMonth = m
		monthSessions = 0
		monthBytes = 0
		monthFiles = 0
	}
}

func IncSessions() {
	totalSessions.Add(1)
	mu.Lock()
	checkMonth()
	monthSessions++
	mu.Unlock()
}

func IncFiles() {
	totalFiles.Add(1)
	mu.Lock()
	checkMonth()
	monthFiles++
	mu.Unlock()
}

func AddBytes(n int) {
	totalBytes.Add(int64(n))
	mu.Lock()
	checkMonth()
	monthBytes += int64(n)
	mu.Unlock()
}

type Snapshot struct {
	TotalSessions  int64    `json:"total_sessions"`
	TotalBytes     int64    `json:"total_bytes"`
	TotalFiles     int64    `json:"total_files"`
	Monthly        *Monthly `json:"monthly"`
	ActiveSessions int64    `json:"active_sessions"`
	ActiveXfers    int64    `json:"active_transfers"`
	Uptime         string   `json:"uptime"`
}

func GetSnapshot(activeSessions, activeXfers int64) *Snapshot {
	mu.Lock()
	checkMonth()
	m := &Monthly{
		Month:         currentMonth,
		TotalSessions: monthSessions,
		TotalBytes:    monthBytes,
		TotalFiles:    monthFiles,
	}
	mu.Unlock()
	return &Snapshot{
		TotalSessions:  totalSessions.Load(),
		TotalBytes:     totalBytes.Load(),
		TotalFiles:     totalFiles.Load(),
		Monthly:        m,
		ActiveSessions: activeSessions,
		ActiveXfers:    activeXfers,
		Uptime:         time.Since(startTime).Round(time.Second).String(),
	}
}
