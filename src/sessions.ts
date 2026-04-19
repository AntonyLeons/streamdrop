export type SessionStatus = "waiting" | "active" | "done"

export type Waiter = { resolve: () => void; reject: (err: Error) => void }

export type Session = {
  id: string
  uploadToken: string
  downloadToken: string
  createdAt: number
  deleteTimer?: Timer
  status: SessionStatus
  senderAttached: boolean
  receivers: Set<WritableStreamDefaultWriter<Uint8Array>>
  receiverWaiters: Set<Waiter>
}


const MAX_RECEIVERS = 100

const sessionsById = new Map<string, Session>()
const sessionsByUploadToken = new Map<string, Session>()
const sessionsByDownloadToken = new Map<string, Session>()

export function getMaxReceivers() {
  return MAX_RECEIVERS
}

export function createSession(now = Date.now()): Session {
  const id = randomId(10)
  const uploadToken = randomToken()
  const downloadToken = randomToken()
  const session: Session = {
    id,
    uploadToken,
    downloadToken,
    createdAt: now,
    status: "waiting",
    senderAttached: false,
    receivers: new Set(),
    receiverWaiters: new Set(),
  }

  sessionsById.set(id, session)
  sessionsByUploadToken.set(uploadToken, session)
  sessionsByDownloadToken.set(downloadToken, session)
  return session
}

export function getSessionById(id: string) {
  return sessionsById.get(id)
}

export function getSessionByUploadToken(uploadToken: string) {
  return sessionsByUploadToken.get(uploadToken)
}

export function getSessionByDownloadToken(downloadToken: string) {
  return sessionsByDownloadToken.get(downloadToken)
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
  if (session.receivers.size > 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => session.receiverWaiters.add({ resolve, reject }))
}

export function removeReceiver(session: Session, writer: WritableStreamDefaultWriter<Uint8Array>) {
  session.receivers.delete(writer)
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
