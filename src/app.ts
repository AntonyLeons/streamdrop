import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { streamSSE } from "hono/streaming"
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
  notifySessionEvent,
  notifyReceiverEvent,
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
    const start = performance.now()
    const method = c.req.method
    const url = c.req.url

    await next()

    const status = c.res.status
    const durationMs = performance.now() - start
    if (method !== "OPTIONS") {
      console.log(
        `[HTTP] ${method} ${new URL(url).pathname} - ${status} - ${durationMs.toFixed(1)}ms`,
      )
    }
    setSecurityHeaders(c.res.headers, nonce)
    return c.res
  })

  function setSecurityHeaders(headers: Headers, nonce: string) {
    headers.set("X-Frame-Options", "DENY")
    headers.set("X-Content-Type-Options", "nosniff")
    headers.set("Referrer-Policy", "no-referrer")
    headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
    headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")

    headers.set(
      "Content-Security-Policy",
      `default-src 'none'; ` +
        `script-src 'self' 'nonce-${nonce}'; ` +
        `worker-src 'self'; ` +
        `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; ` +
        `style-src-elem 'self' https://fonts.googleapis.com; ` +
        `font-src 'self' https://fonts.gstatic.com data:; ` +
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

  app.get("/static/download-worker.js", async () => {
    const file = Bun.file(new URL("../public/static/download-worker.js", import.meta.url))
    return new Response(file, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    })
  })


  app.get("/static/upload-worker.js", async () => {
    const file = Bun.file(new URL("../public/static/upload-worker.js", import.meta.url))
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

  app.get("/session/events/:token", async (c) => {
    const token = c.req.param("token")
    let session = getSessionByUploadToken(token)
    let isSender = true
    if (!session) {
      session = getSessionByDownloadToken(token)
      isSender = false
    }

    if (!session) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })

    return streamSSE(c, async (stream) => {
      const callback = (eventData: any) => {
        stream.writeSSE({
          event: eventData.event,
          data: JSON.stringify(eventData.data),
        }).catch(() => {})
      }

      if (isSender) {
        if (!session.sseCallbacks) {
          session.sseCallbacks = new Set()
        }
        session.sseCallbacks.add(callback)

        stream.onAbort(() => {
          session.sseCallbacks?.delete(callback)
        })

        await stream.writeSSE({ event: "connected", data: "ok" })

        for (const ch of session.channels.values()) {
          if (!ch.claimed) {
            await stream.writeSSE({
              event: "channel_created",
              data: JSON.stringify({ channelId: ch.id }),
            })
          }
        }
      } else {
        if (!session.receiverSseCallbacks) {
          session.receiverSseCallbacks = new Set()
        }
        session.receiverSseCallbacks.add(callback)

        stream.onAbort(() => {
          session.receiverSseCallbacks?.delete(callback)
        })

        await stream.writeSSE({ event: "connected", data: "ok" })

        // Notify the sender that the receiver is online and signaling can begin!
        notifySessionEvent(session, "receiver_online", { ok: true })
      }

      while (true) {
        await Bun.sleep(15000)
        try {
          await stream.writeSSE({ event: "ping", data: "heartbeat" })
        } catch {
          break
        }
      }
    })
  })

  app.post("/session/signal/:token", async (c) => {
    const token = c.req.param("token")
    const body = await c.req.json()

    let session = getSessionByUploadToken(token)
    let isSender = true
    if (!session) {
      session = getSessionByDownloadToken(token)
      isSender = false
    }

    if (!session) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })

    if (isSender) {
      notifyReceiverEvent(session, "signal", body)
    } else {
      notifySessionEvent(session, "signal", body)
    }

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

    const wantsChannelId = c.req.query("channelId")
    if (wantsChannelId) {
      const ch = session.channels.get(wantsChannelId)
      if (ch && !ch.claimed) {
        ch.claimed = true
        return c.json({ channelId: ch.id }, 200, { "cache-control": "no-store" })
      }
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
    }

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
      if (session.fileSize) incrementBytes(session.fileSize)
    } catch (e: any) {
      const isAbort =
        c.req.raw.signal.aborted ||
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && /abort|cancel|closed/i.test(e.message))
      if (isAbort) {
        return c.json({ error: "aborted" }, 200, { "cache-control": "no-store" })
      }
      return c.json({ error: "receivers_lost" }, 409, { "cache-control": "no-store" })
    } finally {
      session.activeSenders = Math.max(0, session.activeSenders - 1)
      session.status = session.activeSenders > 0 ? "active" : "waiting"
      ch.sending = false
      session.channels.delete(channelId)
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
      if (session.fileSize) incrementBytes(session.fileSize)
    } catch (e: any) {
      const isAbort =
        c.req.raw.signal.aborted ||
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && /abort|cancel|closed/i.test(e.message))
      if (isAbort) {
        return c.json({ error: "aborted" }, 200, { "cache-control": "no-store" })
      }
      return c.json({ error: "receivers_lost" }, 409, { "cache-control": "no-store" })
    } finally {
      session.activeSenders = Math.max(0, session.activeSenders - 1)
      session.status = session.activeSenders > 0 ? "active" : "waiting"
      ch.sending = false
      session.channels.delete(channelId)
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
    const { readable, writable } = new TransformStream()
    session.channels.set(channelId, { id: channelId, writable, claimed: false, sending: false, createdAt: Date.now() })
    notifyReceiverAvailable(session)
    notifySessionEvent(session, "channel_created", { channelId })

    const onAbort = () => {
      session.channels.delete(channelId)
      try {
        writable.abort(new Error("aborted")).catch(() => {})
      } catch {}
    }

    c.req.raw.signal.addEventListener("abort", onAbort, { once: true })

    const headers = new Headers()
    headers.set("content-type", "application/octet-stream")
    headers.set("cache-control", "no-store")
    headers.set("accept-ranges", "none")
    headers.set("x-accel-buffering", "no")
    setAttachmentContentDisposition(headers, "streamdrop.enc")
    headers.set("x-streamdrop-channel", channelId)

    return new Response(readable, { status: 200, headers })
  })

  app.get("/raw/d/:downloadToken", async (c) => {
    const downloadToken = c.req.param("downloadToken")
    const session = getSessionByDownloadToken(downloadToken)
    if (!session) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" })
    if (session.channels.size >= getMaxReceivers())
      return c.json({ error: "too_many_receivers" }, 429, { "cache-control": "no-store" })

    const channelId = randomChannelId()
    const { readable, writable } = new TransformStream()
    session.channels.set(channelId, { id: channelId, writable, claimed: false, sending: false, createdAt: Date.now() })
    notifyReceiverAvailable(session)
    notifySessionEvent(session, "channel_created", { channelId })

    const onAbort = () => {
      session.channels.delete(channelId)
      try {
        writable.abort(new Error("aborted")).catch(() => {})
      } catch {}
    }

    c.req.raw.signal.addEventListener("abort", onAbort, { once: true })

    const headers = new Headers()
    headers.set("content-type", "application/octet-stream")
    headers.set("cache-control", "no-store")
    headers.set("accept-ranges", "none")
    headers.set("x-accel-buffering", "no")
    setAttachmentContentDisposition(headers, safeFileName(session.fileName) || "streamdrop.bin")
    headers.set("x-streamdrop-channel", channelId)

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



function randomChannelId() {
  return base64url(crypto.getRandomValues(new Uint8Array(12))).slice(0, 16)
}
