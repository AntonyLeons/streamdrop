export const serverStats = {
  totalSessions: 0,
  totalBytes: 0n,
  totalFiles: 0,
}

export const monthlyStats = {
  month: new Date().toISOString().slice(0, 7),
  totalSessions: 0,
  totalBytes: 0n,
  totalFiles: 0,
}

let cachedMonth = monthlyStats.month
let cachedMonthTimestamp = Date.now()

function checkMonth() {
  const now = Date.now()
  if (now - cachedMonthTimestamp < 60_000) return
  cachedMonthTimestamp = now
  const currentMonth = new Date().toISOString().slice(0, 7)
  if (cachedMonth !== currentMonth) {
    cachedMonth = currentMonth
    monthlyStats.month = currentMonth
    monthlyStats.totalSessions = 0
    monthlyStats.totalBytes = 0n
    monthlyStats.totalFiles = 0
  }
}

let pendingBytes = 0

export function incrementBytes(bytes: number) {
  pendingBytes += bytes
  if (pendingBytes >= 1_048_576) {
    const flush = BigInt(pendingBytes)
    serverStats.totalBytes += flush
    monthlyStats.totalBytes += flush
    pendingBytes = 0
    checkMonth()
  }
}

function flushBytes() {
  if (pendingBytes > 0) {
    const flush = BigInt(pendingBytes)
    serverStats.totalBytes += flush
    monthlyStats.totalBytes += flush
    pendingBytes = 0
  }
}

export function incrementSessions() {
  flushBytes()
  checkMonth()
  serverStats.totalSessions++
  monthlyStats.totalSessions++
}

export function incrementFiles() {
  flushBytes()
  checkMonth()
  serverStats.totalFiles++
  monthlyStats.totalFiles++
}

export function getStats(activeSessions: number, activeTransfers: number) {
  flushBytes()
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