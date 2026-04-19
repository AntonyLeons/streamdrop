import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import QRCode from "qrcode"
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

export function createApp() {
  const app = new Hono()

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

  app.post("/session", (c) => {
    const session = createSession()
    if (!session) return c.json({ error: "at_capacity" }, 503, { "cache-control": "no-store" })
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
    const origin = new URL(c.req.url).origin
    const transferUrl = `${origin}/xfr/${session.id}`
    const recvUrl = `${origin}/recv/${session.id}`
    const sendUrl = `${origin}/send/${session.id}`

    const headers = new Headers()
    headers.set("cache-control", "no-store")
    headers.set("content-type", "text/plain; charset=utf-8")
    headers.set("content-disposition", 'attachment; filename="xfr.txt"')
    setHumanHeaders(headers, { transferUrl, recvUrl, sendUrl })
    addHumanQrHeadersIndexed(headers, recvUrl)
    const bodyText = await humanBodyTextAsync({ transferUrl, recvUrl, sendUrl })
    return new Response(bodyText, { status: 200, headers })
  })

  app.get("/xfr/", (c) => c.redirect("/xfr"))

  app.get("/recv", (c) => {
    const session = createSession()
    return c.redirect(`/recv/${session.id}`)
  })

  app.on(["PUT", "POST"], "/xfr", (c) => {
    const session = createSession()
    const origin = new URL(c.req.url).origin
    const loc = `${origin}/xfr/${session.id}`
    const transferUrl = `${origin}/xfr/${session.id}`
    const recvUrl = `${origin}/recv/${session.id}`
    const sendUrl = `${origin}/send/${session.id}`

    const headers = new Headers()
    headers.set("cache-control", "no-store")
    headers.set("location", loc)
    headers.set("content-type", "text/plain; charset=utf-8")
    setHumanHeaders(headers, { transferUrl, recvUrl, sendUrl })
    addHumanQrHeadersIndexed(headers, recvUrl)
    return new Response(null, { status: 307, headers })
  })

  app.on(["PUT", "POST"], "/xfr/", (c) => c.redirect("/xfr"))

  app.on(["PUT", "POST"], "/xfr/:fileName", (c) => {
    const fileName = c.req.param("fileName")
    const session = createSession()
    if (fileName) session.fileName = safeFileName(fileName) || undefined
    const origin = new URL(c.req.url).origin
    const loc = session.fileName
      ? `${origin}/xfr/${session.id}/${encodeURIComponent(session.fileName)}`
      : `${origin}/xfr/${session.id}/`

    const headers = new Headers()
    headers.set("cache-control", "no-store")
    headers.set("location", loc)
    headers.set("content-type", "text/plain; charset=utf-8")
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
    const sendUrl = `${origin}/send/${session.id}`

    const headers = new Headers()
    headers.set("cache-control", "no-store")
    headers.set("content-type", "text/plain; charset=utf-8")
    setHumanHeaders(headers, { transferUrl, recvUrl, sendUrl })
    addHumanQrHeadersIndexed(headers, recvUrl)
    const { readable, writable } = new TransformStream<string, string>()
    const writer = writable.getWriter()

    const bodyHead = await humanBodyTextAsync({ transferUrl, recvUrl, sendUrl })
    await writer.write(bodyHead).catch(() => {})

    ;(async () => {
      try {
        await fanout(session, body)
      } catch (e) {
        const isAbort =
          (e instanceof DOMException && e.name === "AbortError") ||
          (e instanceof Error && /abort|cancel|closed/i.test(e.message))
        if (!isAbort) throw e
      } finally {
        session.status = "done"
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

    const origin = new URL(c.req.url).origin
    const transferUrl = session.fileName
      ? `${origin}/xfr/${session.id}/${encodeURIComponent(session.fileName)}`
      : `${origin}/xfr/${session.id}`
    const recvUrl = `${origin}/recv/${session.id}`
    const sendUrl = `${origin}/send/${session.id}`

    const headers = new Headers()
    headers.set("cache-control", "no-store")
    headers.set("content-type", "text/plain; charset=utf-8")
    setHumanHeaders(headers, { transferUrl, recvUrl, sendUrl })
    const qr = await QRCode.toString(recvUrl, { type: "utf8" })
    const bodyText = `${transferUrl}\n${sendUrl}\n${recvUrl}\n${qr}\n`
    return new Response(bodyText, { status: 200, headers })
  })

  app.get("/xfr/:id/:fileName", async (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.json({ error: "not_found" }, 404)
    if (session.status === "done") return c.json({ error: "done" }, 410)
    if (session.receivers.size >= getMaxReceivers()) return c.json({ error: "too_many_receivers" }, 429)

    const fileName = c.req.param("fileName")
    if (fileName && !session.fileName) session.fileName = safeFileName(fileName) || undefined

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
    headers.set("content-disposition", `attachment; filename="${filename}"`)
    return new Response(readable, { status: 200, headers })
  })

  app.get("/xfr/:id", async (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.json({ error: "not_found" }, 404)
    if (session.status === "done") return c.json({ error: "done" }, 410)
    if (session.receivers.size >= getMaxReceivers()) return c.json({ error: "too_many_receivers" }, 429)

    if (session.fileName) return c.redirect(`/xfr/${session.id}/${encodeURIComponent(session.fileName)}`)

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
    headers.set("content-disposition", `attachment; filename="${filename}"`)
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
      const isAbort =
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && /abort|cancel|closed/i.test(e.message))
      if (!isAbort) throw e
    } finally {
      session.status = "done"
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

    session.downloadCount++
    notifyLive(session)

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

  app.get("/raw/d/:downloadToken", async (c) => {
    const downloadToken = c.req.param("downloadToken")
    const session = getSessionByDownloadToken(downloadToken)
    if (!session) return c.json({ error: "not_found" }, 404)
    if (session.status === "done") return c.json({ error: "done" }, 410)
    if (session.receivers.size >= getMaxReceivers()) return c.json({ error: "too_many_receivers" }, 429)

    session.downloadCount++
    notifyLive(session)

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
    headers.set("content-disposition", 'attachment; filename="streamdrop.bin"')

    return new Response(readable, { status: 200, headers })
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

function notifyLive(session: Session) {
  const payload = JSON.stringify({ type: "stats", downloads: session.downloadCount })
  for (const sink of session.liveSinks) sink(payload)
}

function setHumanHeaders(headers: Headers, urls: { transferUrl: string; recvUrl: string; sendUrl: string }) {
  headers.set("human-transfer-url", urls.transferUrl)
  headers.set("human-recv-url", urls.recvUrl)
  headers.set("human-send-url", urls.sendUrl)
}

function addHumanQrHeadersIndexed(headers: Headers, url: string) {
  try {
    const qr = QRCode.create(url, { errorCorrectionLevel: "M" })
    const size = qr.modules.size
    const data = qr.modules.data as unknown as boolean[]
    const margin = 2
    const get = (x: number, y: number) => data[y * size + x]

    let i = 0
    for (let y = -margin; y < size + margin; y++) {
      let line = ""
      for (let x = -margin; x < size + margin; x++) {
        const on = x >= 0 && y >= 0 && x < size && y < size ? get(x, y) : false
        line += on ? "##" : "  "
      }
      headers.set(`human-qr-${String(i).padStart(2, "0")}`, line)
      i++
    }
  } catch {}
}

function humanBodyText(urls: { transferUrl: string; recvUrl: string; sendUrl: string }) {
  return `human-transfer-url: ${urls.transferUrl}\nhuman-send-url: ${urls.sendUrl}\nhuman-recv-url: ${urls.recvUrl}\n`
}

async function humanBodyTextAsync(urls: { transferUrl: string; recvUrl: string; sendUrl: string }) {
  const qr = await QRCode.toString(urls.recvUrl, { type: "utf8" })
  const qrLines = qr
    .split("\n")
    .filter(Boolean)
    .map((l) => `human-qr-code: ${l}`)
    .join("\n")
  return `${humanBodyText(urls)}${qrLines}\n`
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
