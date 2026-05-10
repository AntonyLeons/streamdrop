export const serverStats = {
  totalSessions: 0,
  totalBytes: 0n,
  totalFiles: 0,
}

export const monthlyStats = {
  month: new Date().toISOString().slice(0, 7), // e.g. "2026-05"
  totalSessions: 0,
  totalBytes: 0n,
  totalFiles: 0,
}

function checkMonth() {
  const currentMonth = new Date().toISOString().slice(0, 7)
  if (monthlyStats.month !== currentMonth) {
    monthlyStats.month = currentMonth
    monthlyStats.totalSessions = 0
    monthlyStats.totalBytes = 0n
    monthlyStats.totalFiles = 0
  }
}

export function incrementSessions() {
  checkMonth()
  serverStats.totalSessions++
  monthlyStats.totalSessions++
}

export function incrementBytes(bytes: number) {
  checkMonth()
  serverStats.totalBytes += BigInt(bytes)
  monthlyStats.totalBytes += BigInt(bytes)
}

export function incrementFiles() {
  checkMonth()
  serverStats.totalFiles++
  monthlyStats.totalFiles++
}

export function getStats(activeSessions: number, activeTransfers: number) {
  checkMonth()
  return {
    totalSessions: serverStats.totalSessions,
    totalBytes: serverStats.totalBytes.toString(),
    totalFiles: serverStats.totalFiles,
    monthly: {
      month: monthlyStats.month,
      totalSessions: monthlyStats.totalSessions,
      totalBytes: monthlyStats.totalBytes.toString(),
      totalFiles: monthlyStats.totalFiles,
    },
    activeSessions,
    activeTransfers,
    uptime: process.uptime(),
  }
}