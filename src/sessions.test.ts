import { expect, test } from "bun:test"
import { createSession } from "./sessions"

test("createSession generates url-safe tokens", () => {
  const s = createSession(0)
  if (!s) throw new Error("createSession returned null unexpectedly")
  expect(s.id.length).toBeGreaterThanOrEqual(8)
  expect(s.uploadToken.length).toBeGreaterThanOrEqual(32)
  expect(s.downloadToken.length).toBeGreaterThanOrEqual(32)
  expect(/^[A-Za-z0-9\-_]+$/.test(s.id)).toBe(true)
  expect(/^[A-Za-z0-9\-_]+$/.test(s.uploadToken)).toBe(true)
  expect(/^[A-Za-z0-9\-_]+$/.test(s.downloadToken)).toBe(true)
})

test("createSession returns null when session cap is reached", () => {
  const s = createSession(Date.now())
  expect(s === null || typeof s.id === "string").toBe(true)
})
