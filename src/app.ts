import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import {
  createSession,
  getMaxReceivers,
  getSessionByDownloadToken,
  getSessionById,
  getSessionByUploadToken,
  notifyReceiverAvailable,
  type Session,
  removeReceiver,
  deleteSession,
  waitForReceiver,
} from "./sessions"
import { streamSSE } from "hono/streaming"
import { renderDownloadPage, renderNotFoundPage, renderRecipesPage, renderUploadPage, renderServiceUnavailablePage } from "./pages"

export function createApp() {
  const app = new Hono()

  app.get("/static/vendor/qr-creator.min.js", async () => {
    const file = Bun.file(new URL("../node_modules/qr-creator/dist/qr-creator.min.js", import.meta.url))
    return new Response(file, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      },
    })
  })

  app.use("/static/*", serveStatic({ root: "./public" }))

  app.get("/health", (c) => c.json({ ok: true }))

  app.get("/", (c) => {
    const session = createSession()
    if (!session) return c.html(renderServiceUnavailablePage(), 503, { "cache-control": "no-store" })
    return c.html(renderUploadPage(session), 200, { "cache-control": "no-store" })
  })

  app.get("/recipes", (c) => {
    const uploadToken = c.req.query("ut") || undefined
    const downloadToken = c.req.query("dt") || undefined
    return c.html(renderRecipesPage({ uploadToken, downloadToken }), 200, { "cache-control": "no-store" })
  })

  app.get("/live/:id", (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.json({ error: "not_found" }, 404)

    if (session.deleteTimer) {
      clearTimeout(session.deleteTimer)
      session.deleteTimer = undefined
    }

    return streamSSE(c, async (stream) => {
      let active = true
      c.req.raw.signal.addEventListener("abort", () => {
        active = false
        session.deleteTimer = setTimeout(() => {
          for (const writer of session.receivers) writer.abort().catch(() => {})
          for (const w of session.receiverWaiters) w.reject(new Error("session_expired"))
          deleteSession(session)
        }, 30_000)
      })

      while (active) {
        try {
          await stream.writeSSE({ data: "ping" })
          await stream.sleep(15_000)
        } catch {
          break
        }
      }
    })
  })

  app.get("/:id", (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.html(renderNotFoundPage(), 404, { "cache-control": "no-store" })
    return c.html(renderDownloadPage(session), 200, { "cache-control": "no-store" })
  })

  app.on(["PUT", "POST"], "/upload/:uploadToken", async (c) => {
    const uploadToken = c.req.param("uploadToken")
    const session = getSessionByUploadToken(uploadToken)
    if (!session) return c.json({ error: "not_found" }, 404)
    if (session.status === "done") return c.json({ error: "done" }, 409)
    if (session.senderAttached) return c.json({ error: "sender_exists" }, 409)

    const body = c.req.raw.body
    if (!body) return c.json({ error: "missing_body" }, 400)

    session.senderAttached = true
    session.status = "active"

    try {
      await fanout(session, body)
    } catch (e) {
      const isAbort =
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && /abort|cancel|closed/i.test(e.message))
      if (!isAbort) throw e
    } finally {
      session.status = "done"
    }

    return c.json({ ok: true }, 200, { "cache-control": "no-store" })
  })

  app.get("/d/:downloadToken", async (c) => {
    const downloadToken = c.req.param("downloadToken")
    const session = getSessionByDownloadToken(downloadToken)
    if (!session) return c.json({ error: "not_found" }, 404)
    if (session.status === "done") return c.json({ error: "done" }, 410)
    if (session.receivers.size >= getMaxReceivers()) return c.json({ error: "too_many_receivers" }, 429)

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    session.receivers.add(writer)
    notifyReceiverAvailable(session)

    const onAbort = () => {
      removeReceiver(session, writer)
      writer.abort().catch(() => {})
    }

    c.req.raw.signal.addEventListener("abort", onAbort, { once: true })

    const headers = new Headers()
    headers.set("content-type", "application/octet-stream")
    headers.set("cache-control", "no-store")
    headers.set("accept-ranges", "none")
    headers.set("content-disposition", 'attachment; filename="streamdrop.enc"')

    return new Response(readable, { status: 200, headers })
  })

  return app
}

async function fanout(session: Session, sender: ReadableStream<Uint8Array>) {
  const reader = sender.getReader()

  try {
    while (true) {
      if (session.status === "done") break

      if (session.receivers.size === 0) {
        try {
          await waitForReceiver(session)
        } catch {
          break
        }
        if (session.receivers.size === 0) break
      }

      const { value, done } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue

      const writers = Array.from(session.receivers)
      const writePromises = writers.map((writer) => {
        return Promise.race([
          writer.write(value),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
        ]).catch(() => {
          session.receivers.delete(writer)
          writer.abort().catch(() => {})
        })
      })
      await Promise.all(writePromises)
    }
  } finally {
    const writers = Array.from(session.receivers)
    session.receivers.clear()
    await Promise.all(
      writers.map(async (w) => {
        try {
          await w.close()
        } catch {}
      }),
    )
  }
}
