export type SessionStatus = "waiting" | "active" | "done"

export type Waiter = { resolve: () => void; reject: (err: Error) => void }

export type Channel = {
  id: string
  controller: ReadableStreamDefaultController<Uint8Array>
  claimed: boolean
  sending: boolean
  createdAt: number
}

export type Session = {
  id: string
  uploadToken: string
  downloadToken: string
  fileName?: string
  downloadCount: number
  liveSinks: Set<(data: string) => void>
  uploaded: boolean
  tempFilePath?: string
  uploadWaiters: Set<Waiter>
  downloadDoneWaiters: Set<Waiter>
  createdAt: number
  lastTouchedAt: number
  deleteTimer?: Timer
  status: SessionStatus
  activeSenders: number
  receivers: Set<WritableStreamDefaultWriter<Uint8Array>>
  channels: Map<string, Channel>
  xfrChannels: Map<string, Channel>
  xfrWaiters: Set<Waiter>
  receiverWaiters: Set<Waiter>
}

const DEFAULT_MAX_RECEIVERS = 1000
const DEFAULT_MAX_SESSIONS = 10000
const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000
const DEFAULT_REAPER_INTERVAL_MS = 60 * 1000

const sessionsById = new Map<string, Session>()
const sessionsByUploadToken = new Map<string, Session>()
const sessionsByDownloadToken = new Map<string, Session>()

export function getMaxReceivers() {
  return getEnvPositiveInt("MAX_RECEIVERS", DEFAULT_MAX_RECEIVERS)
}

export function getSessionCount() {
  return sessionsById.size
}

export function getMaxSessions() {
  return getEnvPositiveInt("MAX_SESSIONS", DEFAULT_MAX_SESSIONS)
}

export function createSession(now = Date.now()): Session | null {
  if (sessionsById.size >= getMaxSessions()) return null
  const id = randomId(10)
  const uploadToken = randomToken()
  const downloadToken = randomToken()
  const session: Session = {
    id,
    uploadToken,
    downloadToken,
    createdAt: now,
    lastTouchedAt: now,
    status: "waiting",
    activeSenders: 0,
    receivers: new Set(),
    channels: new Map(),
    xfrChannels: new Map(),
    xfrWaiters: new Set(),
    receiverWaiters: new Set(),
    downloadCount: 0,
    liveSinks: new Set(),
    uploaded: false,
    uploadWaiters: new Set(),
    downloadDoneWaiters: new Set(),
  }

  sessionsById.set(id, session)
  sessionsByUploadToken.set(uploadToken, session)
  sessionsByDownloadToken.set(downloadToken, session)
  return session
}

export function getSessionById(id: string) {
  const s = sessionsById.get(id)
  if (s) s.lastTouchedAt = Date.now()
  return s
}

export function getSessionByUploadToken(uploadToken: string) {
  const s = sessionsByUploadToken.get(uploadToken)
  if (s) s.lastTouchedAt = Date.now()
  return s
}

export function getSessionByDownloadToken(downloadToken: string) {
  const s = sessionsByDownloadToken.get(downloadToken)
  if (s) s.lastTouchedAt = Date.now()
  return s
}

export function deleteSession(session: Session) {
  sessionsById.delete(session.id)
  sessionsByUploadToken.delete(session.uploadToken)
  sessionsByDownloadToken.delete(session.downloadToken)
}

export function notifyReceiverAvailable(session: Session) {
  for (const w of session.receiverWaiters) w.resolve()
  session.receiverWaiters.clear()
}

export function waitForReceiver(session: Session) {
  if (session.receivers.size > 0 || session.channels.size > 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => session.receiverWaiters.add({ resolve, reject }))
}

export function waitForReceiverWithTimeout(session: Session, timeoutMs: number, signal?: AbortSignal) {
  if (session.receivers.size > 0 || session.channels.size > 0) return Promise.resolve(true)

  return new Promise<boolean>((resolve) => {
    const waiter: Waiter = {
      resolve: () => {
        cleanup()
        resolve(true)
      },
      reject: () => {
        cleanup()
        resolve(false)
      },
    }

    const onAbort = () => {
      cleanup()
      resolve(false)
    }

    const cleanup = () => {
      session.receiverWaiters.delete(waiter)
      if (t) clearTimeout(t)
      if (signal) signal.removeEventListener("abort", onAbort)
    }

    session.receiverWaiters.add(waiter)

    let t: Timer | undefined
    if (timeoutMs > 0) {
      t = setTimeout(() => {
        cleanup()
        resolve(false)
      }, timeoutMs)
    }

    if (signal) signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function removeReceiver(session: Session, writer: WritableStreamDefaultWriter<Uint8Array>) {
  session.receivers.delete(writer)
}

export function startSessionReaper() {
  const ttlMs = getEnvPositiveInt("SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS)
  const intervalMs = getEnvPositiveInt("REAPER_INTERVAL_MS", DEFAULT_REAPER_INTERVAL_MS)
  const run = () => {
    const now = Date.now()
    for (const session of sessionsById.values()) {
      if (now - session.lastTouchedAt <= ttlMs) continue
      if (session.status === "active") continue
      if (session.activeSenders > 0) continue
      if (session.receivers.size > 0) continue
      if (session.channels.size > 0) continue
      if (session.xfrChannels.size > 0) continue
      if (session.liveSinks.size > 0) continue
      for (const w of session.uploadWaiters) w.reject(new Error("session_expired"))
      for (const w of session.receiverWaiters) w.reject(new Error("session_expired"))
      for (const w of session.xfrWaiters) w.reject(new Error("session_expired"))
      for (const w of session.downloadDoneWaiters) w.reject(new Error("session_expired"))
      deleteSession(session)
    }
  }

  const t = setInterval(run, intervalMs)
  run()
  return () => clearInterval(t)
}

function getEnvPositiveInt(name: string, fallback: number) {
  const raw = Bun.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

function randomId(byteLen: number) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLen))).slice(0, 12)
}

function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

function base64url(bytes: Uint8Array) {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}
