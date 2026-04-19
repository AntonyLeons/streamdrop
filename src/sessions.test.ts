import { expect, test } from "bun:test"
import { createSession, deleteSession, getMaxSessions, getSessionCount } from "./sessions"

test("createSession generates url-safe tokens", () => {
  const s = createSession(0)
  if (!s) throw new Error("createSession returned null unexpectedly")
  expect(s.id.length).toBeGreaterThanOrEqual(8)
  expect(s.uploadToken.length).toBeGreaterThanOrEqual(32)
  expect(s.downloadToken.length).toBeGreaterThanOrEqual(32)
  expect(/^[A-Za-z0-9\-_]+$/.test(s.id)).toBe(true)
  expect(/^[A-Za-z0-9\-_]+$/.test(s.uploadToken)).toBe(true)
  expect(/^[A-Za-z0-9\-_]+$/.test(s.downloadToken)).toBe(true)
  deleteSession(s)
})

test("createSession returns null when session cap is reached", () => {
  const old = Bun.env.MAX_SESSIONS
  const created = []
  try {
    Bun.env.MAX_SESSIONS = String(getSessionCount() + 1)
    const s = createSession(Date.now())
    if (s) created.push(s)
    expect(getMaxSessions()).toBeGreaterThan(0)
    expect(createSession(Date.now())).toBe(null)
  } finally {
    for (const s of created) deleteSession(s)
    if (old === undefined) delete Bun.env.MAX_SESSIONS
    else Bun.env.MAX_SESSIONS = old
  }
})
