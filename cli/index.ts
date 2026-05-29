import QRCode from "qrcode"
import { createDecryptTransform, createEncryptStream } from "../public/static/crypto.js"
import { basename, extname, dirname, join } from "node:path"
import { existsSync, readFileSync, createReadStream, createWriteStream } from "node:fs"
import { stat as statFs } from "node:fs/promises"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import pkg from "./package.json"

type SessionRes = { id: string; uploadToken: string; downloadToken: string }

const DEFAULT_SERVER = "https://streamdrop.app"

function getDefaultServer() {
  if (process.env.STREAMDROP_SERVER) return process.env.STREAMDROP_SERVER
  try {
    const rc = readFileSync(join(homedir(), ".streamdroprc"), "utf-8")
    const match = rc.match(/SERVER=(.*)/)
    if (match && match[1]) return match[1].trim()
  } catch {}
  return DEFAULT_SERVER
}

const argv = process.argv.slice(2)
const cmd = argv[0]
let startTime = 0

process.on("uncaughtException", (err) => {
  console.error(`\nError: ${err.message || err}`)
  process.exit(1)
})

process.on("unhandledRejection", (reason: any) => {
  console.error(`\nError: ${reason?.message || reason}`)
  process.exit(1)
})

if (cmd === "-v" || cmd === "--version") {
  console.log(pkg.version)
  process.exit(0)
}

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  printHelp()
  process.exit(0)
}

if (cmd !== "send" && cmd !== "receive" && cmd !== "recv") {
  printHelp()
  process.exit(1)
}

if (cmd === "send") {
  const filePath = argv[1]
  if (!filePath) {
    printHelp()
    process.exit(1)
  }
  const server = getFlagValue("--server") ?? getDefaultServer()
  try {
    await runSend(server, filePath)
  } catch (err: any) {
    console.error(`\nError: ${err.message}`)
    process.exit(1)
  }
} else {
  const input = argv[1]
  if (!input) {
    printHelp()
    process.exit(1)
  }
  const overrideServer = getFlagValue("--server") ?? getDefaultServer()
  try {
    await runReceive(input, overrideServer)
  } catch (err: any) {
    if (err.name === "AbortError") {
      console.error(`\nError: Aborted`)
    } else {
      console.error(`\nError: ${err.message}`)
    }
    process.exit(1)
  }
}

function printHelp() {
  console.log(`streamdrop

Usage:
  streamdrop send <file_or_folder> [--server <url>] [--qr]
  streamdrop receive <share-url> [--server <url>] [--out <file>] [--no-extract]

Environment:
  STREAMDROP_SERVER

Config File (~/.streamdroprc):
  SERVER=https://my-server.com

Default server:
  ${DEFAULT_SERVER}
`)
}

function getFlagValue(name: string) {
  const i = argv.indexOf(name)
  if (i === -1) return null
  const v = argv[i + 1]
  if (!v || v.startsWith("--")) return null
  return v
}

function normalizeServer(s: string) {
  try {
    const u = new URL(s)
    return u.origin
  } catch {
    return s.replace(/\/+$/, "")
  }
}

function randInt(n: number) {
  const x = crypto.getRandomValues(new Uint32Array(1))[0]!
  return x % n
}

function base64urlEncode(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function base64urlDecode(s: string) {
  const padded = s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4)
  return new Uint8Array(Buffer.from(padded, "base64"))
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}

function printProgress(action: string, current: number, total?: number) {
  if (!startTime) startTime = Date.now()
  const elapsed = (Date.now() - startTime) / 1000
  const speed = elapsed > 0 ? current / elapsed : 0
  const speedStr = `${formatBytes(speed)}/s`

  if (total) {
    const percent = ((current / total) * 100).toFixed(1)
    const eta = speed > 0 ? Math.round((total - current) / speed) : 0
    const etaStr = eta > 0 ? `${eta}s left` : ""
    process.stdout.write(`\r\x1b[K${action}: ${formatBytes(current)} / ${formatBytes(total)} (${percent}%) | ${speedStr} | ${etaStr}`)
  } else {
    process.stdout.write(`\r\x1b[K${action}: ${formatBytes(current)} | ${speedStr}`)
  }
}

async function runSend(serverRaw: string, filePath: string) {
  const server = normalizeServer(serverRaw)
  if (!existsSync(filePath)) throw new Error("file_not_found")
  
  const stat = await statFs(filePath)

  let fileName = basename(filePath)
  let totalSize: number | undefined
  if (stat.isDirectory()) {
    fileName = `${fileName}.sd-dir.tar`
    console.log(`Directory detected. Archiving on the fly...`)
  } else {
    totalSize = stat.size
  }

  const sess = (await fetchJson(`${server}/session?name=${encodeURIComponent(fileName)}&size=${totalSize || ""}`, { method: "POST" })) as SessionRes
  if (!sess?.id || !sess.uploadToken || !sess.downloadToken) throw new Error("session_failed")

  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const keyFrag = base64urlEncode(rawKey)
  const sizeSegment = totalSize ? `,${totalSize}` : ""
  const shareUrl = `${server}/${sess.id}#${keyFrag},${encodeURIComponent(fileName)}${sizeSegment}`
  const receiveCode = `${sess.id}:${keyFrag}:${encodeURIComponent(fileName)}`

  console.log(`\n  \x1b[1mShare URL:\x1b[0m \x1b[36m${shareUrl}\x1b[0m`)
  if (server === DEFAULT_SERVER) {
    console.log(`  \x1b[1mReceive:\x1b[0m   \x1b[33mstreamdrop receive ${receiveCode}\x1b[0m\n`)
  } else {
    console.log(`  \x1b[1mReceive:\x1b[0m   \x1b[33mstreamdrop receive ${receiveCode} --server ${server}\x1b[0m\n`)
  }
  if (argv.includes("--qr")) {
    try {
      const qr = await QRCode.toString(shareUrl, { type: "terminal", small: true })
      console.log(qr.trimEnd() + "\n")
    } catch {}
  }

  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"])

  while (true) {
    const ok = await waitForReceiver(server, sess.id)
    if (!ok) continue
    while (true) {
      const channelId = await claim(server, sess.uploadToken)
      if (!channelId) break
      
      console.log(`\x1b[32mReceiver connected. Starting upload...\x1b[0m`)
      startTime = 0 // reset progress timer
      
      let streamToRead: ReadableStream<Uint8Array>
      if (stat.isDirectory()) {
        const tar = spawn("tar", ["-cf", "-", basename(filePath)], {
          cwd: dirname(filePath),
          stdio: ["ignore", "pipe", "ignore"],
        })
        streamToRead = Readable.toWeb(tar.stdout) as ReadableStream<Uint8Array>
      } else {
        streamToRead = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>
      }

      const enc = createEncryptStream({ 
        stream: streamToRead, 
        size: totalSize,
        key, 
        sessionId: sess.id, 
        onProgress: (sent: number, total: number) => printProgress("Uploading", sent, total)
      })
      
      const res = await fetch(`${server}/upload/${sess.uploadToken}/${encodeURIComponent(channelId)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: enc,
        duplex: "half",
      } as any)
      
      console.log() // New line after progress
      if (!res.ok) {
        const t = await safeText(res)
        console.error(`\x1b[31mUpload failed: ${t || res.status}\x1b[0m\n`)
      } else {
        console.log(`\x1b[32mUpload complete.\x1b[0m\n`)
      }
    }
    await sleep(250)
  }
}

async function runReceive(input: string, overrideServer?: string | null) {
  const parsed = parseShareInput(input)
  const server = normalizeServer(overrideServer ?? parsed.server ?? DEFAULT_SERVER)

  const cfg = await fetchSessionCfg(server, parsed.id)
  const downloadToken = cfg?.downloadToken
  if (typeof downloadToken !== "string" || !downloadToken) throw new Error("missing_download_token")

  const keyBytes = base64urlDecode(parsed.keyFrag)
  if (keyBytes.byteLength !== 32) throw new Error("bad_key")
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"])

  const outFlag = getFlagValue("--out")
  const noExtract = argv.includes("--no-extract")

  let outName = safeOutName(parsed.fileName || cfg.fileName || "streamdrop.bin")
  
  const isAutoTar = outName.endsWith(".sd-dir.tar")
  const shouldExtract = isAutoTar && !outFlag && !noExtract

  if (isAutoTar && !shouldExtract && !outFlag) {
    outName = outName.replace(".sd-dir.tar", ".tar")
  }

  let outPath = outFlag ? outFlag : `./${outName}`

  if (!outFlag && existsSync(outPath)) {
    const ext = extname(outPath)
    const base = basename(outPath, ext)
    const dir = dirname(outPath)
    let counter = 1
    while (existsSync(outPath)) {
      outPath = join(dir, `${base} (${counter})${ext}`)
      counter++
    }
  }

  let attempt = 0
  while (true) {
    attempt++
    if (attempt > 1) {
      console.log(`\x1b[36mReconnecting... (${attempt})\x1b[0m`)
    } else {
      console.log(`\x1b[36mConnecting to ${server}...\x1b[0m`)
    }

    const { timeoutSignal, cleanup } = createFetchTimeout()
    let res: Response
    try {
      res = await fetch(`${server}/d/${downloadToken}`, {
        method: "GET",
        headers: { accept: "application/octet-stream" },
        signal: timeoutSignal,
      })
    } catch (err: any) {
      cleanup()
      if (isFatalNetworkError(err)) throw new Error(`Connection failed: ${err.message || err}`)
      await sleep(backoffMs(attempt))
      continue
    }

    if (!res.ok) {
      const errBody = await safeText(res)
      let err = ""
      try {
        const parsed = JSON.parse(errBody)
        if (parsed.error) err = parsed.error
      } catch {}
      if (!err) err = errBody

      cleanup()

      if (err === "done") {
        throw new Error("Transfer is finished. Ask the sender to start the transfer again.")
      }
      if (err === "not_found") {
        throw new Error("Session not found or has expired.")
      }
      if (err === "too_many_receivers" || isTransientHttpError(res.status)) {
        if (err === "too_many_receivers") {
          console.error(`\x1b[33mToo many receivers, waiting...\x1b[0m`)
        } else {
          console.error(`\x1b[33mServer ${res.status}, retrying...\x1b[0m`)
        }
        await sleep(backoffMs(attempt))
        continue
      }
      throw new Error(err || `download_failed_${res.status}`)
    }

    if (!res.body) {
      cleanup()
      await sleep(backoffMs(attempt))
      continue
    }

    console.log(`\x1b[36mDownloading to ${outPath}...\x1b[0m`)
    startTime = 0
    const decrypt = createDecryptTransform({
      key,
      sessionId: parsed.id,
      onProgress: (received: number) => printProgress("Downloading", received),
    })

    const plain = res.body.pipeThrough(decrypt)

    try {
      if (shouldExtract) {
        console.log(`Folder archive detected. Extracting on the fly...`)
        const tarProc = spawn("tar", ["-xf", "-"], {
          stdio: ["pipe", "inherit", "inherit"],
        })

        const writer = Writable.toWeb(tarProc.stdin)

        await plain.pipeTo(writer)
        await new Promise<void>((resolve, reject) => {
          tarProc.on("close", (code) => {
            if (code === 0) resolve()
            else reject(new Error(`tar exited with code ${code}`))
          })
          tarProc.on("error", reject)
        })

        console.log()
        console.log(`\x1b[32mExtracted successfully.\x1b[0m\n`)
      } else {
        await writeToFile(outPath, plain)

        console.log()
        console.log(`\x1b[32mSaved: ${outPath}\x1b[0m\n`)
      }
      cleanup()
      return
    } catch (e: any) {
      cleanup()
      const msg = String(e?.message ?? e ?? "")
      if (msg.includes("bad_magic") || msg.includes("bad_chunk_index") || msg.includes("OperationError")) {
        console.error(`\x1b[33mStream interrupted, reconnecting...\x1b[0m`)
        await sleep(backoffMs(attempt))
        continue
      }
      throw e
    }
  }
}

function parseShareInput(input: string): { server?: string; id: string; keyFrag: string; fileName?: string } {
  const s = input.trim()
  
  if (!s.startsWith("http://") && !s.startsWith("https://") && s.includes(":")) {
    const parts = s.split(":")
    const id = parts[0]
    const keyFrag = parts[1]
    let fileName: string | undefined
    if (parts.length > 2) {
      try {
        fileName = decodeURIComponent(parts.slice(2).join(":"))
      } catch {
        fileName = parts.slice(2).join(":")
      }
    }
    if (!id) throw new Error("missing_id")
    if (!keyFrag) throw new Error("missing_key")
    return { id, keyFrag, fileName }
  }

  let url: URL | null = null
  if (s.startsWith("http://") || s.startsWith("https://")) {
    url = new URL(s)
  } else if (s.includes("#")) {
    url = new URL(`http://placeholder${s.startsWith("/") ? "" : "/"}${s}`)
  } else {
    throw new Error("bad_share_url")
  }

  const id = url.pathname.split("/").filter(Boolean)[0] || ""
  if (!id) throw new Error("missing_id")

  const frag = url.hash.startsWith("#") ? url.hash.slice(1) : ""
  const fragParts = frag.split(",")
  const keyFrag = fragParts[0] ?? ""
  if (!keyFrag) throw new Error("missing_key")
  // Last segment may be a numeric byte-size appended by newer share links
  const lastPart = fragParts[fragParts.length - 1] ?? ""
  const hasSize = fragParts.length >= 3 && /^\d+$/.test(lastPart)
  const nameParts = hasSize ? fragParts.slice(1, -1) : fragParts.slice(1)

  let fileName: string | undefined
  if (nameParts.length > 0) {
    try {
      fileName = decodeURIComponent(nameParts.join(","))
    } catch {
      fileName = nameParts.join(",")
    }
  }

  const server = s.startsWith("http://") || s.startsWith("https://") ? url.origin : undefined
  return { server, id, keyFrag, fileName }
}

function safeOutName(name: string) {
  const base = name.split(/[\\/]/).pop() || "streamdrop.bin"
  const cleaned = base.replaceAll(/[\r\n"]/g, "").trim()
  return cleaned || "streamdrop.bin"
}

async function fetchSessionCfg(server: string, id: string) {
  const res = await fetch(`${server}/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } })
  if (!res.ok) {
    if (res.status === 404) throw new Error("File session not found or has expired.")
    throw new Error(`Failed to fetch session: HTTP ${res.status}`)
  }
  
  try {
    return (await res.json()) as any
  } catch {
    throw new Error("bad_cfg_json")
  }
}

async function fetchJson(url: string, init: RequestInit & { timeout?: number } = {}) {
  const userSignal = init.signal ?? undefined
  const { timeoutSignal, cleanup } = createFetchTimeout(userSignal)
  try {
    const res = await fetch(url, {
      ...init,
      signal: timeoutSignal,
      headers: { ...(init.headers || {}), accept: "application/json" },
    })
    if (!res.ok) {
      const t = await safeText(res)
      throw new Error(t || `http_${res.status}`)
    }
    return await res.json()
  } finally {
    cleanup()
  }
}

async function safeText(res: Response) {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

async function waitForReceiver(server: string, sessionId: string): Promise<boolean> {
  let attempt = 0
  while (true) {
    attempt++
    const { timeoutSignal, cleanup } = createFetchTimeout()
    try {
      const res = await fetch(`${server}/wait-receiver/${sessionId}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: timeoutSignal,
      })

      if (res.status === 404) throw new Error("Session not found.")
      if (res.status === 410) throw new Error("Session has expired.")
      if (isTransientHttpError(res.status) || !res.ok) {
        console.error(`\x1b[33mServer ${res.status}, retrying...\x1b[0m`)
        await sleep(backoffMs(attempt))
        continue
      }

      const body = (await res.json().catch(() => null)) as any
      return !!body?.ok
    } catch (err: any) {
      if (err.message === "Session not found." || err.message === "Session has expired.") throw err
      if (isFatalNetworkError(err)) {
        throw new Error(`Connection failed: ${err.message || err}`)
      }
      await sleep(backoffMs(attempt))
    } finally {
      cleanup()
    }
  }
}

async function claim(server: string, uploadToken: string): Promise<string | null> {
  let attempt = 0
  while (true) {
    attempt++
    const { timeoutSignal, cleanup } = createFetchTimeout()
    try {
      const res = await fetch(`${server}/claim/${uploadToken}`, {
        method: "POST",
        headers: { accept: "application/json" },
        signal: timeoutSignal,
      })

      if (res.status === 204) return null
      if (res.status === 404) throw new Error("Session not found.")
      if (isTransientHttpError(res.status) || !res.ok) {
        await sleep(backoffMs(attempt))
        continue
      }

      const body = (await res.json().catch(() => null)) as any
      return typeof body?.channelId === "string" ? body.channelId : null
    } catch (err: any) {
      if (err.message === "Session not found.") throw err
      if (isFatalNetworkError(err)) {
        throw new Error(`Connection failed: ${err.message || err}`)
      }
      await sleep(backoffMs(attempt))
    } finally {
      cleanup()
    }
  }
}

async function writeToFile(path: string, stream: ReadableStream<Uint8Array>) {
  const w = createWriteStream(path)
  await stream.pipeTo(Writable.toWeb(w))
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function backoffMs(attempt: number) {
  return Math.min(10000, 250 * Math.pow(1.6, Math.max(0, attempt - 1)))
}

function createFetchTimeout(signal?: AbortSignal): { timeoutSignal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000)

  const onParentAbort = () => {
    controller.abort()
    clearTimeout(timeoutId)
  }

  if (signal) {
    if (signal.aborted) {
      controller.abort()
      clearTimeout(timeoutId)
    } else {
      signal.addEventListener("abort", onParentAbort, { once: true })
    }
  }

  return {
    timeoutSignal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId)
      if (signal) signal.removeEventListener("abort", onParentAbort)
    },
  }
}

function isFatalNetworkError(err: unknown): boolean {
  const msg = String(err).toLowerCase()
  return (
    msg.includes("enotfound") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("dns") ||
    msg.includes("getaddrinfo") ||
    msg.includes("protocol_error") ||
    msg.includes("invalid url") ||
    (msg.includes("abort") && !msg.includes("aborterror"))
  )
}

function isTransientHttpError(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}
