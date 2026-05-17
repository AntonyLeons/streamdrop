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
  deleteSession,
  waitForReceiverWithTimeout,
  getSessionCount,
  getActiveTransferCount,
} from "./sessions"
import { renderDownloadPage, renderNotFoundPage, renderUploadPage, renderServiceUnavailablePage, renderPrivacyPage, renderTermsPage } from "./pages"
import { getQRCodeVendorJS } from "./vendor/qrcode"
import { incrementBytes, incrementFiles, getStats } from "./stats"

type AppEnv = {
  Variables: {
    cspNonce: string
  }
}

export function createApp() {
  const app = new Hono<AppEnv>()

  app.use("*", async (c, next) => {
    const nonce = randomNonce()
    c.set("cspNonce", nonce)
    await next()
    setSecurityHeaders(c.res.headers, nonce)
    return c.res
  })

  function setSecurityHeaders(headers: Headers, nonce: string) {
    headers.set("X-Frame-Options", "DENY")
    headers.set("X-Content-Type-Options", "nosniff")
    headers.set("Referrer-Policy", "no-referrer")
    headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
    
    headers.set(
      "Content-Security-Policy",
      `default-src 'none'; ` +
        `script-src 'self' 'nonce-${nonce}'; ` +
        `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; ` +
        `font-src 'self' https://fonts.gstatic.com; ` +
        `img-src 'self' data:; ` +
        `connect-src 'self'; ` +
        `base-uri 'none'; ` +
        `form-action 'none'; ` +
        `frame-ancestors 'none'; ` +
        `object-src 'none'; ` +
        `manifest-src 'self';`,
    )
  }

  app.onError((err, c) => {
    console.error(`[Router Error] ${c.req.method} ${c.req.url}:`, err)
    return c.json({ error: "internal_server_error" }, 500)
  })

  app.get("/static/app.css", async () => {
    const file = Bun.file(new URL("../public/static/app.css", import.meta.url))
    return new Response(file, {
      headers: {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
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

  app.use("/static/*", serveStatic({
    root: "./public",
    onFound: (_path, c) => {
      c.header("cache-control", "public, max-age=31536000, immutable")
    }
  }))

  app.get("/health", (c) => c.json({ ok: true }))

  app.get("/stats", (c) => c.json(getStats(getSessionCount(), getActiveTransferCount()), 200, { "cache-control": "no-store" }))

  app.get("/", async (c) => {
    const session = createSession()
    const wantsJson = c.req.header("accept")?.includes("application/json")

    if (!session) {
      if (wantsJson) return c.json({ error: "at_capacity" }, 503, { "cache-control": "no-store" })
      return c.html(await renderServiceUnavailablePage(c.get("cspNonce")), 503, { "cache-control": "no-store" })
    }

    if (wantsJson) {
      return c.json(
        {
          id: session.id,
          uploadToken: session.uploadToken,
          downloadToken: session.downloadToken,
        },
        200,
        { "cache-control": "no-store" }
      )
    }

    return c.html(await renderUploadPage(session, c.get("cspNonce")), 200, { "cache-control": "no-store" })
  })

  app.get("/privacy", async (c) => {
    return c.html(await renderPrivacyPage(c.get("cspNonce")), 200, {
      "cache-control": "public, max-age=86400",
    })
  })

  app.get("/terms", async (c) => {
    return c.html(await renderTermsPage(c.get("cspNonce")), 200, {
      "cache-control": "public, max-age=86400",
    })
  })

  app.post("/session", (c) => {
    const originError = enforceSameOriginIfBrowser(c.req.raw)
    if (originError) return c.json({ error: originError }, 403, { "cache-control": "no-store" })
    const session = createSession()
    if (!session) return c.json({ error: "at_capacity" }, 503, { "cache-control": "no-store" })
    const name = c.req.query("name") || undefined
    if (name) session.fileName = safeFileName(name) || undefined
    const sizeStr = c.req.query("size")
    if (sizeStr) {
      const parsedSize = parseInt(sizeStr, 10)
      if (!isNaN(parsedSize) && parsedSize >= 0) session.fileSize = parsedSize
    }
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
    for (const ch of session.channels.values()) {
      try {
        ch.writable.abort(new Error("session_deleted")).catch(() => {})
      } catch {}
    }
    session.channels.clear()
    for (const w of session.receiverWaiters) w.reject(new Error("session_deleted"))
    deleteSession(session)
    return c.json({ ok: true }, 200, { "cache-control": "no-store" })
  })

  app.get("/wait-receiver/:id", async (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    if (!session) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })
    if (session.status === "done") return c.json({ error: "done" }, 410, { "cache-control": "no-store" })
    if (session.receivers.size > 0 || session.channels.size > 0)
      return c.json({ ok: true }, 200, { "cache-control": "no-store" })

    const ok = await waitForReceiverWithTimeout(session, 25_000, c.req.raw.signal)
    return c.json({ ok }, 200, { "cache-control": "no-store" })
  })

  app.post("/claim/:uploadToken", (c) => {
    const uploadToken = c.req.param("uploadToken")
    const session = getSessionByUploadToken(uploadToken)
    if (!session) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })

    for (const ch of session.channels.values()) {
      if (ch.claimed) continue
      ch.claimed = true
      return c.json({ channelId: ch.id }, 200, { "cache-control": "no-store" })
    }

    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
  })

  app.get("/:id", async (c) => {
    const id = c.req.param("id")
    const session = getSessionById(id)
    const wantsJson = c.req.header("accept")?.includes("application/json")

    if (!session) {
      if (wantsJson) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })
      return c.html(await renderNotFoundPage(c.get("cspNonce")), 404, { "cache-control": "no-store" })
    }

    if (wantsJson) {
      return c.json(
        {
          id: session.id,
          downloadToken: session.downloadToken,
          name: session.fileName,
          size: session.fileSize,
        },
        200,
        { "cache-control": "no-store" }
      )
    }

    return c.html(await renderDownloadPage(session, c.get("cspNonce")), 200, { "cache-control": "no-store" })
  })

  app.on(["PUT", "POST"], "/upload/:uploadToken/:channelId", async (c) => {
    const uploadToken = c.req.param("uploadToken")
    const session = getSessionByUploadToken(uploadToken)
    if (!session) return c.json({ error: "not_found" }, 404)
    const channelId = c.req.param("channelId")
    const ch = session.channels.get(channelId)
    if (!ch) return c.json({ error: "channel_not_found" }, 404, { "cache-control": "no-store" })
    if (ch.sending) return c.json({ error: "sender_exists" }, 409, { "cache-control": "no-store" })

    const body = c.req.raw.body
    if (!body) return c.json({ error: "missing_body" }, 400)

    ch.sending = true
    session.activeSenders++
    session.status = "active"

    try {
      await body.pipeTo(ch.writable, { signal: c.req.raw.signal })
      incrementFiles()
    } catch (e) {
      const isAbort =
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && /abort|cancel|closed/i.test(e.message))
      const isReceiverLost = e instanceof Error && /receivers_lost|pipe_failed/i.test(e.message)
      if (isReceiverLost) return c.json({ error: "receivers_lost" }, 409, { "cache-control": "no-store" })
      if (!isAbort) throw e
    } finally {
      session.activeSenders = Math.max(0, session.activeSenders - 1)
      session.status = session.activeSenders > 0 ? "active" : "waiting"
      ch.sending = false
    }

    return c.json({ ok: true }, 200, { "cache-control": "no-store" })
  })

  app.on(["PUT", "POST"], "/raw/upload/:uploadToken/:channelId", async (c) => {
    const uploadToken = c.req.param("uploadToken")
    const session = getSessionByUploadToken(uploadToken)
    if (!session) return c.json({ error: "not_found" }, 404)
    const channelId = c.req.param("channelId")
    const ch = session.channels.get(channelId)
    if (!ch) return c.json({ error: "channel_not_found" }, 404, { "cache-control": "no-store" })
    if (ch.sending) return c.json({ error: "sender_exists" }, 409, { "cache-control": "no-store" })

    const body = c.req.raw.body
    if (!body) return c.json({ error: "missing_body" }, 400)

    const name = c.req.query("name") || c.req.header("x-file-name") || undefined
    if (name) session.fileName = safeFileName(name) || undefined

    ch.sending = true
    session.activeSenders++
    session.status = "active"

    try {
      await body.pipeTo(ch.writable, { signal: c.req.raw.signal })
      incrementFiles()
    } catch (e) {
      const isAbort =
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && /abort|cancel|closed/i.test(e.message))
      const isReceiverLost = e instanceof Error && /receivers_lost|pipe_failed/i.test(e.message)
      if (isReceiverLost) return c.json({ error: "receivers_lost" }, 409, { "cache-control": "no-store" })
      if (!isAbort) throw e
    } finally {
      session.activeSenders = Math.max(0, session.activeSenders - 1)
      session.status = session.activeSenders > 0 ? "active" : "waiting"
      ch.sending = false
    }

    return c.json({ ok: true }, 200, { "cache-control": "no-store" })
  })

  app.get("/d/:downloadToken", async (c) => {
    const downloadToken = c.req.param("downloadToken")
    const session = getSessionByDownloadToken(downloadToken)
    if (!session) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })
    if (session.channels.size >= getMaxReceivers())
      return c.json({ error: "too_many_receivers" }, 429, { "cache-control": "no-store" })

    const channelId = randomChannelId()
    const { readable, writable } = new TransformStream({
      transform(chunk, controller) {
        incrementBytes(chunk.byteLength)
        controller.enqueue(chunk)
      }
    })
    session.channels.set(channelId, { id: channelId, writable, claimed: false, sending: false, createdAt: Date.now() })
    notifyReceiverAvailable(session)

    let counted = false
    const count = () => {
      if (counted) return
      counted = true
      session.channels.delete(channelId)
    }

    const onAbort = () => {
      session.channels.delete(channelId)
      try {
        writable.abort(new Error("aborted")).catch(() => {})
      } catch {}
      count()
    }

    c.req.raw.signal.addEventListener("abort", onAbort, { once: true })

    const headers = new Headers()
    headers.set("content-type", "application/octet-stream")
    headers.set("cache-control", "no-store")
    headers.set("accept-ranges", "none")
    headers.set("x-accel-buffering", "no")
    setAttachmentContentDisposition(headers, "streamdrop.enc")
    headers.set("x-streamdrop-channel", channelId)

    return new Response(wrapReadableWithDone(readable, count), { status: 200, headers })
  })

  app.get("/raw/d/:downloadToken", async (c) => {
    const downloadToken = c.req.param("downloadToken")
    const session = getSessionByDownloadToken(downloadToken)
    if (!session) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })
    if (session.channels.size >= getMaxReceivers())
      return c.json({ error: "too_many_receivers" }, 429, { "cache-control": "no-store" })

    const channelId = randomChannelId()
    const { readable, writable } = new TransformStream({
      transform(chunk, controller) {
        incrementBytes(chunk.byteLength)
        controller.enqueue(chunk)
      }
    })
    session.channels.set(channelId, { id: channelId, writable, claimed: false, sending: false, createdAt: Date.now() })
    notifyReceiverAvailable(session)

    let counted = false
    const count = () => {
      if (counted) return
      counted = true
      session.channels.delete(channelId)
    }

    const onAbort = () => {
      session.channels.delete(channelId)
      try {
        writable.abort(new Error("aborted")).catch(() => {})
      } catch {}
      count()
    }

    c.req.raw.signal.addEventListener("abort", onAbort, { once: true })

    const headers = new Headers()
    headers.set("content-type", "application/octet-stream")
    headers.set("cache-control", "no-store")
    headers.set("accept-ranges", "none")
    headers.set("x-accel-buffering", "no")
    setAttachmentContentDisposition(headers, safeFileName(session.fileName) || "streamdrop.bin")
    headers.set("x-streamdrop-channel", channelId)

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

function setSecurityHeaders(headers: Headers, nonce: string) {
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
      "style-src-elem 'self' https://fonts.googleapis.com",
      `script-src 'self' 'nonce-${nonce}'`,
      "connect-src 'self'",
    ].join("; "),
  )
}

function enforceSameOriginIfBrowser(req: Request) {
  const secFetchSite = req.headers.get("sec-fetch-site")
  const origin = req.headers.get("origin")
  if (!secFetchSite && !origin) return null
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") return "bad_origin"
  if (!origin) return null
  const allowed = getAllowedOrigin(req)
  return origin === allowed ? null : "bad_origin"
}

function getAllowedOrigin(req: Request) {
  const envOrigin = Bun.env.PUBLIC_ORIGIN?.trim()
  if (envOrigin) return envOrigin.replace(/\/+$/, "")

  const xfProto = (req.headers.get("x-forwarded-proto") || "").split(",")[0]?.trim()
  const xfHost = (req.headers.get("x-forwarded-host") || "").split(",")[0]?.trim()
  if (xfProto && xfHost) return `${xfProto}://${xfHost}`

  const host = req.headers.get("host")
  if (host) return `http://${host}`

  return new URL(req.url).origin
}

function randomNonce() {
  return base64url(crypto.getRandomValues(new Uint8Array(16)))
}

function base64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
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

function randomChannelId() {
  return base64url(crypto.getRandomValues(new Uint8Array(12))).slice(0, 16)
}



function jsonResponse(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
}
