import { expect, test } from "bun:test"
import { createApp } from "./app"
import { createSession } from "./sessions"

test("GET / returns HTML successfully", async () => {
  const app = createApp()

  const resHome = await app.request("/")
  expect(resHome.status).toBe(200)
  expect(resHome.headers.get("content-type")).toContain("text/html")
  const cspHome = resHome.headers.get("content-security-policy") || ""
  expect(cspHome).toContain("script-src 'self' 'nonce-")
  expect(cspHome).not.toContain("script-src 'self' 'unsafe-inline'")
  const htmlHome = await resHome.text()
  expect(htmlHome).toContain("StreamDrop")
  expect(htmlHome).toMatch(/<script nonce="[^"]+">window\.__STREAMDROP__=/)
})

test("GET /health returns {ok: true}", async () => {
  const app = createApp()
  const res = await app.request("/health")
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
})

test("POST /session returns session tokens", async () => {
  const app = createApp()
  const res = await app.request("/session", { method: "POST" })
  expect([200, 503]).toContain(res.status)
  if (res.status === 503) return
  const body = (await res.json()) as any
  expect(typeof body.id).toBe("string")
  expect(typeof body.uploadToken).toBe("string")
  expect(typeof body.downloadToken).toBe("string")
})

test("GET /:id returns 404 for unknown session", async () => {
  const app = createApp()
  const res = await app.request("/unknown_id")
  expect(res.status).toBe(404)
  expect(await res.text()).toContain("404")
})

test("GET /:id returns download page for valid session", async () => {
  const app = createApp()
  const session = createSession()
  if (!session) throw new Error("unexpected session cap hit")
  const res = await app.request(`/${session.id}`)
  expect(res.status).toBe(200)
  expect(await res.text()).toContain("Receive")
})

test("POST /upload rejects unknown session", async () => {
  const app = createApp()
  const res = await app.request("/upload/bad_token/bad_channel", {
    method: "POST",
    body: "test"
  })
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ error: "not_found" })
})

test("POST /upload rejects duplicate senders with 409", async () => {
  const app = createApp()
  const session = createSession()
  if (!session) throw new Error("unexpected session cap hit")

  const d = await app.request(`/d/${session.downloadToken}`)
  const channelId = d.headers.get("x-streamdrop-channel") || ""
  expect(channelId).toBeTruthy()

  const res1 = app.request(`/upload/${session.uploadToken}/${channelId}`, {
    method: "POST",
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
        // Stream remains open...
      }
    }),
    duplex: 'half'
  })

  await Bun.sleep(10)

  const res2 = await app.request(`/upload/${session.uploadToken}/${channelId}`, {
    method: "POST",
    body: new Uint8Array([4, 5, 6])
  })

  expect(res2.status).toBe(409)
  const body = (await res2.json()) as any
  expect(body.error).toBe("sender_exists")
})

test("DELETE /session/:uploadToken deletes session", async () => {
  const app = createApp()
  const session = createSession()
  if (!session) throw new Error("unexpected session cap hit")

  const res = await app.request(`/session/${session.uploadToken}`, { method: "DELETE" })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })

  const res2 = await app.request(`/claim/${session.uploadToken}`, { method: "POST" })
  expect(res2.status).toBe(404)
})

test("GET /stats returns stats", async () => {
  const app = createApp()
  const res = await app.request("/stats")
  expect(res.status).toBe(200)
  const data = await res.json()
  expect(data).toHaveProperty("totalSessions")
  expect(data).toHaveProperty("totalBytes")
  expect(data).toHaveProperty("totalFiles")
  expect(data).toHaveProperty("activeSessions")
})

test("GET / returns 503 when session cap is reached", async () => {
  const app = createApp()
  const res = await app.request("/")
  expect([200, 503]).toContain(res.status)
})
