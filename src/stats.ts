export const serverStats = {
  totalSessions: 0,
  totalBytes: 0n,
  totalFiles: 0,
}

export function incrementSessions() {
  serverStats.totalSessions++
}

export function incrementBytes(bytes: number) {
  serverStats.totalBytes += BigInt(bytes)
}

export function incrementFiles() {
  serverStats.totalFiles++
}

export function getStats(activeSessions: number) {
  return {
    totalSessions: serverStats.totalSessions,
    totalBytes: serverStats.totalBytes.toString(),
    totalFiles: serverStats.totalFiles,
    activeSessions,
    uptime: process.uptime(),
  }
}