import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unlink } from "node:fs/promises"
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
  waitForReceiverWithTimeout,
} from "./sessions"
import { streamSSE } from "hono/streaming"
import {
  renderDownloadPage,
  renderNotFoundPage,
  renderRecipesPage,
  renderUploadPage,
  renderServiceUnavailablePage,
  renderXfrReceivePage,
  renderXfrSendPage,
} from "./pages"
import { getQRCodeVendorJS } from "./vendor/qrcode"

export function createApp() {
  const app = new Hono()

  app.use("*", async (c, next) => {
    await next()
    setSecurityHeaders(c.res.headers)
    return c.res
  })

  app.get("/static/app.css", async () => {
    const file = Bun.file(new URL("../public/static/app.css", import.meta.url))
    return new Response(file, {
      headers: {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "no-store",
      },
    })
  })

  app.get("/static/upload.js", async () => {
    const file = Bun.file(new URL("../public/static/upload.js", import.meta.url))
    return new Response(file, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    })
  })

  app.get("/static/download.js", async () => {
    const file = Bun.file(new URL("../public/static/download.js", import.meta.url))
    return new Response(file, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    })
  })

  app.get("/static/crypto.js", async () => {
    const file = Bun.file(new URL("../public/static/crypto.js", import.meta.url))
    return new Response(file, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    })
  })

  app.get("/static/vendor/qrcode.min.js", async () => {
    const text = await getQRCodeVendorJS()
    return new Response(text, {
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

  app.post("/session", (c) => {
    const session = createSession()
    if (!session) return c.json({ error: "at_capacity" }, 503, { "cache-control": "no-store" })
    const name = c.req.query("name") || undefined
    if (name) session.fileName = safeFileName(name) || undefined
    return c.json(
      { id: session.id, uploadToken: session.uploadToken, downloadToken: session.downloadToken },
      200,
      { "cache-control": "no-store" },
    )
  })

  app.delete("/session/:uploadToken", (c) => {
    const uploadToken = c.req.param("uploadToken")
    const session = getSessionByUploadToken(uploadToken)
    if (!session) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })

    for (const writer of session.receivers) writer.abort().catch(() => {})
    for (const w of session.receiverWaiters) w.reject(new Error("session_deleted"))
    cleanupSession(session)
    deleteSession(session)
    return c.json({ ok: true }, 200, { "cache-control": "no-store" })
  })

  app.get("/recipes", (c) => {
    const id = c.req.query("id") || undefined
    const uploadToken = c.req.query("ut") || undefined
    const downloadToken = c.req.query("dt") || undefined
    return c.html(renderRecipesPage({ id, uploadToken, downloadToken }), 200, { "cache-control": "no-store" })
  })

  app.get("/live/:id", (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.json({ error: "not_found" }, 404)

    if (session.deleteTimer) {
      clearTimeout(session.deleteTimer)
      session.deleteTimer = undefined
    }

    c.header("cache-control", "no-store")
    return streamSSE(c, async (stream) => {
      let active = true
      const sink = (data: string) => {
        stream.writeSSE({ data }).catch(() => {})
      }
      session.liveSinks.add(sink)
      sink(JSON.stringify({ type: "stats", downloads: session.downloadCount }))

      c.req.raw.signal.addEventListener("abort", () => {
        active = false
        session.liveSinks.delete(sink)
        session.deleteTimer = setTimeout(() => {
          for (const writer of session.receivers) writer.abort().catch(() => {})
          for (const w of session.receiverWaiters) w.reject(new Error("session_expired"))
          cleanupSession(session)
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

  app.get("/wait-receiver/:id", async (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })
    if (session.status === "done") return c.json({ error: "done" }, 410, { "cache-control": "no-store" })
    if (session.receivers.size > 0) return c.json({ ok: true }, 200, { "cache-control": "no-store" })

    const ok = await waitForReceiverWithTimeout(session, 25_000, c.req.raw.signal)
    return c.json({ ok }, 200, { "cache-control": "no-store" })
  })

  app.get("/xfr", async (c) => {
    const session = createSession()
    if (!session) return c.json({ error: "at_capacity" }, 503, { "cache-control": "no-store" })
    const origin = new URL(c.req.url).origin
    const transferUrl = `${origin}/xfr/${session.id}`
    const recvUrl = `${origin}/recv/${session.id}`

    const headers = new Headers()
    headers.set("cache-control", "no-store")
    headers.set("content-type", "text/plain; charset=utf-8")
    setAttachmentContentDisposition(headers, "xfr.txt")
    setHumanHeaders(headers, { transferUrl, recvUrl })
    const bodyText = await humanBodyTextAsync({ transferUrl, recvUrl })
    return new Response(bodyText, { status: 200, headers })
  })

  app.get("/xfr/", async (c) => {
    const session = createSession()
    if (!session) return c.json({ error: "at_capacity" }, 503, { "cache-control": "no-store" })
    const origin = new URL(c.req.url).origin
    const transferUrl = `${origin}/xfr/${session.id}`
    const recvUrl = `${origin}/recv/${session.id}`

    const headers = new Headers()
    headers.set("cache-control", "no-store")
    headers.set("content-type", "text/plain; charset=utf-8")
    setAttachmentContentDisposition(headers, "xfr.txt")
    setHumanHeaders(headers, { transferUrl, recvUrl })
    const bodyText = await humanBodyTextAsync({ transferUrl, recvUrl })
    return new Response(bodyText, { status: 200, headers })
  })

  app.get("/recv", (c) => {
    const session = createSession()
    if (!session) return c.html(renderServiceUnavailablePage(), 503, { "cache-control": "no-store" })
    return c.redirect(`/recv/${session.id}`)
  })

  app.on(["PUT", "POST"], "/xfr", (c) => {
    const session = createSession()
    if (!session) return c.json({ error: "at_capacity" }, 503, { "cache-control": "no-store" })
    const origin = new URL(c.req.url).origin
    const loc = `${origin}/xfr/${session.id}/`
    const transferUrl = `${origin}/xfr/${session.id}`
    const recvUrl = `${origin}/recv/${session.id}`

    const headers = new Headers()
    headers.set("cache-control", "no-store")
    headers.set("location", loc)
    headers.set("content-type", "text/plain; charset=utf-8")
    setHumanHeaders(headers, { transferUrl, recvUrl })
    return new Response(null, { status: 307, headers })
  })

  app.on(["PUT", "POST"], "/xfr/", (c) => {
    const session = createSession()
    if (!session) return c.json({ error: "at_capacity" }, 503, { "cache-control": "no-store" })
    const origin = new URL(c.req.url).origin
    const loc = `${origin}/xfr/${session.id}/`
    const transferUrl = `${origin}/xfr/${session.id}`
    const recvUrl = `${origin}/recv/${session.id}`

    const headers = new Headers()
    headers.set("cache-control", "no-store")
    headers.set("location", loc)
    headers.set("content-type", "text/plain; charset=utf-8")
    setHumanHeaders(headers, { transferUrl, recvUrl })
    return new Response(null, { status: 307, headers })
  })

  app.on(["PUT", "POST"], "/xfr/:fileName", (c) => {
    const fileName = c.req.param("fileName")
    const session = createSession()
    if (!session) return c.json({ error: "at_capacity" }, 503, { "cache-control": "no-store" })
    if (fileName) session.fileName = safeFileName(fileName) || undefined
    const origin = new URL(c.req.url).origin
    const loc = session.fileName
      ? `${origin}/xfr/${session.id}/${encodeURIComponent(session.fileName)}`
      : `${origin}/xfr/${session.id}/`

    const headers = new Headers()
    headers.set("cache-control", "no-store")
    headers.set("location", loc)
    headers.set("content-type", "text/plain; charset=utf-8")
    const transferUrl = session.fileName
      ? `${origin}/xfr/${session.id}/${encodeURIComponent(session.fileName)}`
      : `${origin}/xfr/${session.id}`
    const recvUrl = `${origin}/recv/${session.id}`
    setHumanHeaders(headers, { transferUrl, recvUrl })
    return new Response(null, { status: 307, headers })
  })

  app.on(["PUT", "POST"], "/xfr/:id/:fileName", async (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.json({ error: "not_found" }, 404)
    if (session.status === "done") return c.json({ error: "done" }, 409)
    if (session.senderAttached) return c.json({ error: "sender_exists" }, 409)

    const body = c.req.raw.body
    if (!body) return c.json({ error: "missing_body" }, 400)

    const fileName = c.req.param("fileName")
    if (fileName) session.fileName = safeFileName(fileName) || undefined

    session.senderAttached = true
    session.status = "active"

    const origin = new URL(c.req.url).origin
    const transferUrl = session.fileName
      ? `${origin}/xfr/${session.id}/${encodeURIComponent(session.fileName)}`
      : `${origin}/xfr/${session.id}`
    const recvUrl = `${origin}/recv/${session.id}`

    const tmpPath = join(tmpdir(), `streamdrop-xfr-${session.id}-${Date.now()}`)
    session.tempFilePath = tmpPath

    try {
      await writeBodyToTempFile(tmpPath, body, c.req.raw.signal)
      session.uploaded = true
      notifyUploadDone(session)
    } catch (e) {
      cleanupSession(session)
      throw e
    }

    const headers = new Headers()
    headers.set("cache-control", "no-store")
    headers.set("content-type", "text/plain; charset=utf-8")
    setHumanHeaders(headers, { transferUrl, recvUrl })

    const { readable, writable } = new TransformStream<string, string>()
    const writer = writable.getWriter()
    const bodyText = await humanBodyTextAsync({ transferUrl, recvUrl })
    await writer.write(bodyText).catch(() => {})

    ;(async () => {
      try {
        await waitForFirstDownloadDone(session, c.req.raw.signal)
      } finally {
        writer.close().catch(() => {})
      }
    })().catch(() => {})

    return new Response(readable, { status: 200, headers })
  })

  app.on(["PUT", "POST"], "/xfr/:id", async (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.json({ error: "not_found" }, 404)
    if (session.status === "done") return c.json({ error: "done" }, 409)
    if (session.senderAttached) return c.json({ error: "sender_exists" }, 409)

    const body = c.req.raw.body
    if (!body) return c.json({ error: "missing_body" }, 400)

    const name = c.req.query("name") || c.req.header("x-file-name") || undefined
    if (name) session.fileName = safeFileName(name) || undefined

    session.senderAttached = true
    session.status = "active"

    const origin = new URL(c.req.url).origin
    const transferUrl = session.fileName
      ? `${origin}/xfr/${session.id}/${encodeURIComponent(session.fileName)}`
      : `${origin}/xfr/${session.id}`
    const recvUrl = `${origin}/recv/${session.id}`

    const tmpPath = join(tmpdir(), `streamdrop-xfr-${session.id}-${Date.now()}`)
    session.tempFilePath = tmpPath

    try {
      await writeBodyToTempFile(tmpPath, body, c.req.raw.signal)
      session.uploaded = true
      notifyUploadDone(session)
    } catch (e) {
      cleanupSession(session)
      throw e
    }

    const headers = new Headers()
    headers.set("cache-control", "no-store")
    headers.set("content-type", "text/plain; charset=utf-8")
    setHumanHeaders(headers, { transferUrl, recvUrl })
    const { readable, writable } = new TransformStream<string, string>()
    const writer = writable.getWriter()
    const bodyText = await humanBodyTextAsync({ transferUrl, recvUrl })
    await writer.write(bodyText).catch(() => {})

    ;(async () => {
      try {
        await waitForFirstDownloadDone(session, c.req.raw.signal)
      } finally {
        writer.close().catch(() => {})
      }
    })().catch(() => {})

    return new Response(readable, { status: 200, headers })
  })

  app.get("/xfr/:id/:fileName", async (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.json({ error: "not_found" }, 404)
    if (session.status === "done") return c.json({ error: "done" }, 410)
    if (session.receivers.size >= getMaxReceivers()) return c.json({ error: "too_many_receivers" }, 429)

    const fileName = c.req.param("fileName")
    if (fileName && !session.fileName) session.fileName = safeFileName(fileName) || undefined

    if (!session.uploaded) {
      const ok = await waitForUploadWithTimeout(session, 0, c.req.raw.signal)
      if (!ok) return jsonResponse({ error: "aborted" }, 499)
    }

    if (session.uploaded && session.tempFilePath) {
      session.downloadCount++
      notifyLive(session)
      const filename = safeFileName(session.fileName) || "file"

      const headers = new Headers()
      headers.set("content-type", "application/octet-stream")
      headers.set("cache-control", "no-store")
      headers.set("accept-ranges", "none")
      setAttachmentContentDisposition(headers, filename)
      return new Response(createFileStreamWithDone(session), { status: 200, headers })
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    session.receivers.add(writer)
    notifyReceiverAvailable(session)

    const onAbort = () => {
      removeReceiver(session, writer)
      writer.abort().catch(() => {})
    }
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true })

    if (!session.senderAttached && !session.fileName) {
      await waitForSenderWithTimeout(session, 25_000, c.req.raw.signal)
    }

    session.downloadCount++
    notifyLive(session)

    const filename = safeFileName(session.fileName) || "file"

    const headers = new Headers()
    headers.set("content-type", "application/octet-stream")
    headers.set("cache-control", "no-store")
    headers.set("accept-ranges", "none")
    setAttachmentContentDisposition(headers, filename)
    return new Response(readable, { status: 200, headers })
  })

  app.get("/xfr/:id", async (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.json({ error: "not_found" }, 404)
    if (session.status === "done") return c.json({ error: "done" }, 410)
    if (session.receivers.size >= getMaxReceivers()) return c.json({ error: "too_many_receivers" }, 429)

    if (session.fileName) return c.redirect(`/xfr/${session.id}/${encodeURIComponent(session.fileName)}`)

    if (!session.uploaded) {
      const ok = await waitForUploadWithTimeout(session, 0, c.req.raw.signal)
      if (!ok) return jsonResponse({ error: "aborted" }, 499)
    }

    if (session.uploaded && session.tempFilePath) {
      session.downloadCount++
      notifyLive(session)
      const filename = safeFileName(session.fileName) || "file"

      const headers = new Headers()
      headers.set("content-type", "application/octet-stream")
      headers.set("cache-control", "no-store")
      headers.set("accept-ranges", "none")
      setAttachmentContentDisposition(headers, filename)
      return new Response(createFileStreamWithDone(session), { status: 200, headers })
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    session.receivers.add(writer)
    notifyReceiverAvailable(session)

    const onAbort = () => {
      removeReceiver(session, writer)
      writer.abort().catch(() => {})
    }
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true })

    if (!session.senderAttached && !session.fileName) {
      await waitForSenderWithTimeout(session, 25_000, c.req.raw.signal)
    }

    session.downloadCount++
    notifyLive(session)

    const origin = new URL(c.req.url).origin
    const filename = safeFileName(session.fileName) || "file"

    const headers = new Headers()
    headers.set("content-type", "application/octet-stream")
    headers.set("cache-control", "no-store")
    headers.set("accept-ranges", "none")
    setAttachmentContentDisposition(headers, filename)
    return new Response(readable, { status: 200, headers })
  })

  app.get("/recv/:id", async (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.html(renderNotFoundPage(), 404, { "cache-control": "no-store" })
    return c.html(renderXfrReceivePage(id), 200, { "cache-control": "no-store" })
  })

  app.get("/send/:id", async (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.html(renderNotFoundPage(), 404, { "cache-control": "no-store" })
    return c.html(renderXfrSendPage(id), 200, { "cache-control": "no-store" })
  })

  app.delete("/xfr/:id", (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })

    for (const writer of session.receivers) writer.abort().catch(() => {})
    for (const w of session.receiverWaiters) w.reject(new Error("session_deleted"))
    cleanupSession(session)
    deleteSession(session)
    return c.json({ ok: true }, 200, { "cache-control": "no-store" })
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
      const isReceiverLost = e instanceof Error && /receivers_lost/i.test(e.message)
      const isAbort =
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && /abort|cancel|closed/i.test(e.message))
      if (isReceiverLost) return c.json({ error: "receivers_lost" }, 409, { "cache-control": "no-store" })
      if (!isAbort) throw e
    } finally {
      session.senderAttached = false
      session.status = session.liveSinks.size > 0 ? "waiting" : "done"
    }

    return c.json({ ok: true }, 200, { "cache-control": "no-store" })
  })

  app.on(["PUT", "POST"], "/raw/upload/:uploadToken", async (c) => {
    const uploadToken = c.req.param("uploadToken")
    const session = getSessionByUploadToken(uploadToken)
    if (!session) return c.json({ error: "not_found" }, 404)
    if (session.status === "done") return c.json({ error: "done" }, 409)
    if (session.senderAttached) return c.json({ error: "sender_exists" }, 409)

    const body = c.req.raw.body
    if (!body) return c.json({ error: "missing_body" }, 400)

    const name = c.req.query("name") || c.req.header("x-file-name") || undefined
    if (name) session.fileName = safeFileName(name) || undefined

    session.senderAttached = true
    session.status = "active"

    try {
      await fanout(session, body)
    } catch (e) {
      const isReceiverLost = e instanceof Error && /receivers_lost/i.test(e.message)
      const isAbort =
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && /abort|cancel|closed/i.test(e.message))
      if (isReceiverLost) return c.json({ error: "receivers_lost" }, 409, { "cache-control": "no-store" })
      if (!isAbort) throw e
    } finally {
      session.senderAttached = false
      session.status = session.liveSinks.size > 0 ? "waiting" : "done"
    }

    return c.json({ ok: true }, 200, { "cache-control": "no-store" })
  })

  app.get("/d/:downloadToken", async (c) => {
    const downloadToken = c.req.param("downloadToken")
    const session = getSessionByDownloadToken(downloadToken)
    if (!session) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })
    if (session.status === "done") return c.json({ error: "done" }, 410, { "cache-control": "no-store" })
    if (session.receivers.size >= getMaxReceivers())
      return c.json({ error: "too_many_receivers" }, 429, { "cache-control": "no-store" })

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    session.receivers.add(writer)
    notifyReceiverAvailable(session)

    let counted = false
    const count = () => {
      if (counted) return
      counted = true
      session.downloadCount++
      notifyLive(session)
    }

    const onAbort = () => {
      removeReceiver(session, writer)
      writer.abort().catch(() => {})
      count()
    }

    c.req.raw.signal.addEventListener("abort", onAbort, { once: true })

    const headers = new Headers()
    headers.set("content-type", "application/octet-stream")
    headers.set("cache-control", "no-store")
    headers.set("accept-ranges", "none")
    setAttachmentContentDisposition(headers, "streamdrop.enc")

    return new Response(wrapReadableWithDone(readable, count), { status: 200, headers })
  })

  app.get("/raw/d/:downloadToken", async (c) => {
    const downloadToken = c.req.param("downloadToken")
    const session = getSessionByDownloadToken(downloadToken)
    if (!session) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })
    if (session.status === "done") return c.json({ error: "done" }, 410, { "cache-control": "no-store" })
    if (session.receivers.size >= getMaxReceivers())
      return c.json({ error: "too_many_receivers" }, 429, { "cache-control": "no-store" })

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    session.receivers.add(writer)
    notifyReceiverAvailable(session)

    let counted = false
    const count = () => {
      if (counted) return
      counted = true
      session.downloadCount++
      notifyLive(session)
    }

    const onAbort = () => {
      removeReceiver(session, writer)
      writer.abort().catch(() => {})
      count()
    }

    c.req.raw.signal.addEventListener("abort", onAbort, { once: true })

    const headers = new Headers()
    headers.set("content-type", "application/octet-stream")
    headers.set("cache-control", "no-store")
    headers.set("accept-ranges", "none")
    setAttachmentContentDisposition(headers, safeFileName(session.fileName) || "streamdrop.bin")

    return new Response(wrapReadableWithDone(readable, count), { status: 200, headers })
  })

  return app
}

function safeFileName(name?: string) {
  if (!name) return ""
  const base = name.split(/[\\/]/).pop() || ""
  const cleaned = base.replaceAll(/[\r\n"]/g, "").trim()
  if (!cleaned) return ""
  return cleaned.slice(0, 120)
}

function setAttachmentContentDisposition(headers: Headers, filename: string) {
  const cleaned = safeFileName(filename) || "file"
  const ascii = cleaned.replaceAll(/[^\x20-\x7E]/g, "_").replaceAll(/["\\]/g, "_").slice(0, 120) || "file"
  const utf8 = encodeRFC5987ValueChars(cleaned)
  headers.set("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`)
}

function encodeRFC5987ValueChars(str: string) {
  return encodeURIComponent(str)
    .replaceAll(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("*", "%2A")
}

function setSecurityHeaders(headers: Headers) {
  headers.set("x-content-type-options", "nosniff")
  headers.set("referrer-policy", "strict-origin-when-cross-origin")
  headers.set("permissions-policy", "geolocation=(), microphone=(), camera=()")
  headers.set("x-frame-options", "DENY")
  headers.set(
    "content-security-policy",
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data:",
      "font-src 'self' https://fonts.gstatic.com data:",
      "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
    ].join("; "),
  )
}

function notifyLive(session: Session) {
  const payload = JSON.stringify({ type: "stats", downloads: session.downloadCount })
  for (const sink of session.liveSinks) sink(payload)
}

function setHumanHeaders(headers: Headers, urls: { transferUrl: string; recvUrl: string }) {
  headers.set("human-transfer-url", urls.transferUrl)
  headers.set("human-recv-url", urls.recvUrl)
}

function humanBodyText(urls: { transferUrl: string; recvUrl: string }) {
  return `human-transfer-url: ${urls.transferUrl}\nhuman-recv-url: ${urls.recvUrl}\n`
}

async function humanBodyTextAsync(urls: { transferUrl: string; recvUrl: string }) {
  return humanBodyText(urls)
}

function notifyUploadDone(session: Session) {
  for (const w of session.uploadWaiters) w.resolve()
  session.uploadWaiters.clear()
}

async function waitForUploadWithTimeout(session: Session, timeoutMs: number, signal?: AbortSignal) {
  if (session.uploaded) return true
  const start = Date.now()
  while (!session.uploaded) {
    if (signal?.aborted) return false
    if (timeoutMs > 0 && Date.now() - start > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 150))
  }
  return true
}

function notifyDownloadDone(session: Session) {
  for (const w of session.downloadDoneWaiters) w.resolve()
  session.downloadDoneWaiters.clear()
}

async function waitForFirstDownloadDone(session: Session, signal?: AbortSignal) {
  if (signal?.aborted) return false
  return new Promise<boolean>((resolve) => {
    const waiter = {
      resolve: () => resolve(true),
      reject: () => resolve(false),
    }
    session.downloadDoneWaiters.add(waiter)
    signal?.addEventListener(
      "abort",
      () => {
        session.downloadDoneWaiters.delete(waiter)
        resolve(false)
      },
      { once: true },
    )
  })
}

function createFileStreamWithDone(session: Session) {
  const path = session.tempFilePath
  if (!path) return new ReadableStream<Uint8Array>()
  const reader = Bun.file(path).stream().getReader()
  let doneCalled = false
  const done = () => {
    if (doneCalled) return
    doneCalled = true
    notifyDownloadDone(session)
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done: isDone } = await reader.read()
      if (isDone) {
        done()
        controller.close()
        return
      }
      if (value) controller.enqueue(value)
    },
    async cancel() {
      done()
      await reader.cancel().catch(() => {})
    },
  })
}

function wrapReadableWithDone(readable: ReadableStream<Uint8Array>, done: () => void) {
  const reader = readable.getReader()
  let doneCalled = false
  const callDone = () => {
    if (doneCalled) return
    doneCalled = true
    done()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done: isDone } = await reader.read()
      if (isDone) {
        callDone()
        controller.close()
        return
      }
      if (value) controller.enqueue(value)
    },
    async cancel() {
      callDone()
      await reader.cancel().catch(() => {})
    },
  })
}

function cleanupSession(session: Session) {
  const p = session.tempFilePath
  if (!p) return
  session.tempFilePath = undefined
  unlink(p).catch(() => {})
}

async function waitForSenderWithTimeout(session: Session, timeoutMs: number, signal?: AbortSignal) {
  if (session.senderAttached) return true
  const start = Date.now()
  while (!session.senderAttached) {
    if (signal?.aborted) return false
    if (timeoutMs > 0 && Date.now() - start > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 150))
  }
  return true
}

async function fanout(session: Session, sender: ReadableStream<Uint8Array>) {
  const reader = sender.getReader()
  let started = false

  try {
    while (true) {
      if (session.status === "done") break

      if (session.receivers.size === 0) {
        if (started) throw new Error("receivers_lost")
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

      started = true
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
    await reader.cancel().catch(() => {})
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

async function writeBodyToTempFile(path: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const sink = Bun.file(path).writer()
  const reader = body.getReader()
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      const { value, done } = await reader.read()
      if (done) break
      if (value && value.byteLength) sink.write(value)
    }
  } finally {
    reader.cancel().catch(() => {})
    sink.end()
  }
}

function jsonResponse(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
}
